// ArkNetzWebWeaver — 1:1 call sessions over the P2P data channel.
//
// A call is a media peer connection (media-connection.ts) whose
// SDP and ICE are exchanged as control JSON on the `arknetz/media`
// data channel of an EXISTING P2P data connection — the channel is
// already DTLS-encrypted, so call signaling needs no sealed Issues
// and no new crypto. A call can only start when the data connection
// is already up: if the peer is unreachable, there is no call.
//
// The caller sends `call-invite` and waits; the callee rings until
// the UI answers or declines (CallManager routes the invite to a
// ringing CallSession). On accept, the caller offers, the callee
// answers, ICE trickles both ways, and the call connects. Mute /
// video / screen / quality events are control messages both ways.
// Ending is `call-bye` either side; the media PC closes and the
// local tracks stop, but the data connection is untouched.
//
// Node has no WebRTC and no MediaStream, so every test runs against
// the fake media connection + fake devices; the real adapters are
// exercised by the state machine running against the same
// interfaces — exactly as phase 1 did for data.

import {
  CALL_CONNECT_TIMEOUT_MS,
  CALL_INVITE_TIMEOUT_MS,
  CALL_NO_RELAY_REASON,
  CALL_STATS_INTERVAL_MS,
  MEDIA_CHANNEL_LABEL,
  VIDEO_DEGRADE_DWELL_MS,
  VIDEO_DEGRADE_KBPS,
  VIDEO_RESTORE_DWELL_MS,
  VIDEO_RESTORE_KBPS,
  decodeMediaControl,
  encodeMediaControl,
  type CallKind,
  type CallQualityMode,
  type CallState,
  type MediaControlMessage,
} from "./media.js";
import { describeIcePath, type IceDiagnostics } from "./ice.js";
import type {
  MediaConnection,
  MediaConnectionFactory,
  MediaSenderLike,
} from "./media-connection.js";
import { summarizeMediaStats } from "./media-connection.js";
import type {
  MediaDevicesLike,
  MediaStreamLike,
  MediaTrackLike,
} from "./media-devices.js";
import { defaultAudioConstraints, defaultVideoConstraints } from "./media-devices.js";
import type { P2PConnection } from "./transport.js";

/** Thrown when a call cannot connect because no direct path and no
 *  relay exist. The UI shows CALL_NO_RELAY_NOTE for this reason —
 *  a call has no GitHub fallback (MEDIA-SPEC.md §9.1). */
export class CallConnectError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.name = "CallConnectError";
    this.reason = reason;
  }
}

export type CallEvent =
  | { type: "state"; state: CallState; reason?: string }
  | { type: "remote-track"; track: MediaTrackLike; kind: "audio" | "video" }
  | { type: "remote-muted"; audio: boolean }
  | { type: "remote-video"; video: boolean }
  | { type: "remote-screen"; sharing: boolean }
  | { type: "quality-mode"; mode: CallQualityMode }
  | { type: "relayed"; diagnostics: IceDiagnostics }
  | { type: "recording-consent"; peerId: string; recording: boolean }
  | { type: "recording-active"; peerId: string; active: boolean };

export interface CallSessionOptions {
  callId: string;
  kind: CallKind;
  selfPeerId: string;
  /** This device's own protocol address — sent in the call-invite
   *  so the callee's ringing UI can name the caller. */
  selfAddress: string;
  remotePeerId: string;
  remoteAddress: string;
  devices: MediaDevicesLike;
  mediaFactory: MediaConnectionFactory;
  iceServers: RTCIceServer[];
  /** Sends one control message toward the remote peer (over the
   *  data channel). Never throws for the caller — a failed send
   *  fails the call instead. */
  sendControl: (message: MediaControlMessage) => void;
  onEvent: (event: CallEvent) => void;
  /** Invite timeout (caller waiting for accept). Tests use a short one. */
  inviteTimeoutMs?: number;
  /** Offer → connected timeout. Tests use a short one. */
  connectTimeoutMs?: number;
  /** Stats poll cadence while connected. 0 = no polling (tests). */
  statsIntervalMs?: number;
  now?: () => number;
  randomHex?: (bytes: number) => string;
}

function newCallId(randomHex: (bytes: number) => string): string {
  return `call-${randomHex(16)}`;
}

export function makeCallId(randomHex?: (bytes: number) => string): string {
  const gen =
    randomHex ??
    ((bytes: number) => {
      const b = new Uint8Array(bytes);
      crypto.getRandomValues(b);
      return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    });
  return newCallId(gen);
}

/** Why a media connection failed, from its ICE config. `no-relay`
 *  only when the config has no TURN server at all — with a relay
 *  configured and failing, the reason is `ice-failed` (the relay
 *  itself is the problem, and the UI says so differently). Pure
 *  function — the session calls it from the failed-state handler. */
export function iceFailureReason(iceServers: RTCIceServer[]): string {
  const hasRelay = iceServers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  });
  return hasRelay ? "ice-failed" : CALL_NO_RELAY_REASON;
}

/** One 1:1 call. Created by the caller via `start()` or by the
 *  CallManager in `ringing` state on an incoming invite. */
export class CallSession {
  readonly callId: string;
  readonly kind: CallKind;
  readonly selfPeerId: string;
  private readonly selfAddress: string;
  readonly remotePeerId: string;
  readonly remoteAddress: string;

  private readonly devices: MediaDevicesLike;
  private readonly mediaFactory: MediaConnectionFactory;
  private readonly iceServers: RTCIceServer[];
  private readonly sendControlFn: (message: MediaControlMessage) => void;
  private readonly onEvent: (event: CallEvent) => void;
  private readonly inviteTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly statsIntervalMs: number;
  private readonly now: () => number;

  private _state: CallState = "idle";
  /** Internal state watchers (start() uses one to resolve its
   *  promise). Distinct from the UI's onEvent callback. */
  private readonly stateWatchers = new Set<(state: CallState, reason?: string) => void>();
  /** Local media (mic, camera). Null until start()/accept(). */
  localStream: MediaStreamLike | null = null;
  /** The media peer connection. Null until start()/accept(). */
  mediaConnection: MediaConnection | null = null;
  private videoSender: MediaSenderLike | null = null;
  private audioSender: MediaSenderLike | null = null;
  /** The camera track currently sent (null when video is off). */
  private cameraTrack: MediaTrackLike | null = null;
  /** The screen track currently sent instead of the camera (null otherwise). */
  private screenTrack: MediaTrackLike | null = null;

  private inviteTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  /** Outgoing-kbps samples below the degrade threshold, with the
   *  timestamp of the first one (hysteresis, §7.2). */
  private belowSince: number | null = null;
  private aboveSince: number | null = null;
  qualityMode: CallQualityMode = "full";
  /** Last ICE diagnostics (undefined until the first stats poll). */
  lastDiagnostics: IceDiagnostics | undefined;
  /** Bytes sent+received through a relay this call (from stats). */
  relayedBytes = 0;
  /** Consent to local recording, by peerId (self + remote). */
  readonly recordingConsent = new Map<string, boolean>();
  /** Remote mute/video/screen state as last reported. */
  remoteAudioOn = true;
  remoteVideoOn = true;
  remoteSharingScreen = false;

  constructor(options: CallSessionOptions) {
    this.callId = options.callId;
    this.kind = options.kind;
    this.selfPeerId = options.selfPeerId;
    this.selfAddress = options.selfAddress;
    this.remotePeerId = options.remotePeerId;
    this.remoteAddress = options.remoteAddress;
    this.devices = options.devices;
    this.mediaFactory = options.mediaFactory;
    this.iceServers = options.iceServers;
    this.sendControlFn = options.sendControl;
    this.onEvent = options.onEvent;
    this.inviteTimeoutMs = options.inviteTimeoutMs ?? CALL_INVITE_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CALL_CONNECT_TIMEOUT_MS;
    this.statsIntervalMs = options.statsIntervalMs ?? CALL_STATS_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get state(): CallState {
    return this._state;
  }

  private setState(state: CallState, reason?: string): void {
    if (this._state === state) return;
    this._state = state;
    this.onEvent({ type: "state", state, reason });
    for (const watcher of [...this.stateWatchers]) watcher(state, reason);
  }

  /** Watch state changes. Returns an unsubscribe function. */
  onStateChange(watcher: (state: CallState, reason?: string) => void): () => void {
    this.stateWatchers.add(watcher);
    return () => {
      this.stateWatchers.delete(watcher);
    };
  }

  private send(message: MediaControlMessage): void {
    try {
      this.sendControlFn(message);
    } catch {
      // A failed control send fails the call — the channel is gone.
      this.fail("control-send-failed");
    }
  }

  private clearTimers(): void {
    if (this.inviteTimer) clearTimeout(this.inviteTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.inviteTimer = null;
    this.connectTimer = null;
    this.statsTimer = null;
  }

  private armInviteTimeout(): void {
    this.inviteTimer = setTimeout(() => {
      this.send({ t: "call-bye", callId: this.callId, reason: "no answer" });
      this.fail("no-answer");
    }, this.inviteTimeoutMs);
  }

  private armConnectTimeout(): void {
    this.connectTimer = setTimeout(() => {
      this.fail("media-timeout");
    }, this.connectTimeoutMs);
  }

  private fail(reason: string): void {
    if (this._state === "ended" || this._state === "failed" || this._state === "declined") return;
    this.teardown();
    this.setState("failed", reason);
  }

  private teardown(): void {
    this.clearTimers();
    try {
      this.mediaConnection?.close();
    } catch {
      // Already closed.
    }
    this.mediaConnection = null;
    this.videoSender = null;
    this.audioSender = null;
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already stopped.
        }
      }
    }
    this.localStream = null;
    this.cameraTrack = null;
    this.screenTrack = null;
  }

  // ------------------------------------------------------------------
  // Caller side.
  // ------------------------------------------------------------------

  /** Start an outgoing call: acquire local media, then send the
   *  invite and wait for accept. Resolves when the call connects,
   *  rejects with CallConnectError when it fails. Never leaves a
   *  half-started call behind: any failure tears down. */
  async start(): Promise<void> {
    if (this._state !== "idle") throw new Error(`cannot start a call in state ${this._state}`);
    const done = new Promise<void>((resolve, reject) => {
      const off = this.onStateChange((state, reason) => {
        if (state === "connected") {
          off();
          resolve();
        } else if (state === "failed" || state === "ended" || state === "declined") {
          off();
          reject(
            new CallConnectError(
              reason ?? "call-failed",
              reason === CALL_NO_RELAY_REASON
                ? "Could not connect directly and no relay is available."
                : `Call failed: ${reason ?? "unknown"}.`,
            ),
          );
        }
      });
    });
    this.setState("inviting");
    try {
      this.localStream = await this.acquireLocalMedia();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "media-unavailable");
      await done.catch(() => undefined);
      throw new CallConnectError(
        "media-unavailable",
        "Could not access the microphone/camera on this device.",
      );
    }
    this.send({
      t: "call-invite",
      v: "arknetz-media/1",
      callId: this.callId,
      fromPeerId: this.selfPeerId,
      fromAddress: this.selfAddress,
      kind: this.kind,
      at: this.now(),
    });
    this.armInviteTimeout();
    return done;
  }

  private async acquireLocalMedia(): Promise<MediaStreamLike> {
    const constraints: MediaStreamConstraints = { ...defaultAudioConstraints() };
    if (this.kind === "video") {
      Object.assign(constraints, defaultVideoConstraints());
    }
    return this.devices.getUserMedia(constraints);
  }

  /** Create the media PC, attach local tracks, and wire its events.
   *  Shared by caller (after accept) and callee (on accept). */
  private createMediaConnection(): MediaConnection {
    const conn = this.mediaFactory.createConnection(this.remotePeerId, {
      iceServers: this.iceServers,
    });
    this.mediaConnection = conn;
    const stream = this.localStream;
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        this.audioSender = conn.addTrack(track, stream);
      }
      for (const track of stream.getVideoTracks()) {
        this.cameraTrack = track;
        this.videoSender = conn.addTrack(track, stream);
      }
    }
    conn.ontrack = (event) => {
      this.onEvent({ type: "remote-track", track: event.track, kind: event.track.kind });
    };
    conn.onicecandidate = (candidate) => {
      if (!candidate) return;
      this.send({ t: "call-ice", callId: this.callId, candidate });
    };
    conn.onstatechange = (state) => {
      if (state === "connected") {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this.setState("connected");
        this.startStatsPolling();
      } else if (state === "failed") {
        // Distinguish "no relay" from other ICE failures (see
        // iceFailureReason): the call fails as "no-relay" only
        // when no TURN server was configured at all.
        this.fail(iceFailureReason(this.iceServers));
      } else if (state === "closed") {
        if (this._state === "connected" || this._state === "connecting") {
          this.fail("connection-closed");
        }
      }
    };
    return conn;
  }

  /** Why a media connection failed. `no-relay` only when the ICE
   *  config has no TURN server at all — with a relay configured
   *  and failing, the reason is `ice-failed` (the relay itself is
   *  the problem, and the UI says so differently). Pure function —
   *  the session calls it from the failed-state handler. */
  private connectFailureReason(): string {
    return iceFailureReason(this.iceServers);
  }

  // ------------------------------------------------------------------
  // Callee side (CallManager creates the session in `ringing`).
  // ------------------------------------------------------------------

  /** Mark this session as ringing (called by CallManager on invite). */
  markRinging(): void {
    if (this._state !== "idle") return;
    this.setState("ringing");
    this.armInviteTimeout();
  }

  /** Accept an incoming call: acquire local media, send accept, and
   *  wait for the caller's offer. */
  async accept(): Promise<void> {
    if (this._state !== "ringing") throw new Error(`cannot accept a call in state ${this._state}`);
    if (this.inviteTimer) {
      clearTimeout(this.inviteTimer);
      this.inviteTimer = null;
    }
    this.setState("connecting");
    try {
      this.localStream = await this.acquireLocalMedia();
    } catch (err) {
      this.send({ t: "call-decline", callId: this.callId, reason: "media-unavailable" });
      this.fail(err instanceof Error ? err.message : "media-unavailable");
      throw new CallConnectError("media-unavailable", "Could not access the microphone/camera on this device.");
    }
    this.createMediaConnection();
    this.send({ t: "call-accept", callId: this.callId });
    this.armConnectTimeout();
  }

  /** Decline an incoming call. */
  decline(reason = "declined"): void {
    if (this._state !== "ringing") return;
    this.send({ t: "call-decline", callId: this.callId, reason });
    this.clearTimers();
    this.setState("declined", reason);
  }

  /** End the call from either side. */
  end(reason = "ended"): void {
    if (this._state === "ended" || this._state === "failed" || this._state === "declined") return;
    this.send({ t: "call-bye", callId: this.callId, reason });
    this.teardown();
    this.setState("ended", reason);
  }

  // ------------------------------------------------------------------
  // In-call controls.
  // ------------------------------------------------------------------

  /** Mute / unmute the local mic. The track stays attached, so
   *  unmuting is instant and the remote side gets silence, not a
   *  renegotiation. */
  setMuted(muted: boolean): void {
    const stream = this.localStream;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) track.enabled = !muted;
    this.send({ t: "call-mute", callId: this.callId, fromPeerId: this.selfPeerId, audio: !muted });
  }

  /** Camera on / off. Same pattern as mute: the track stays
   *  attached, disabled in place. */
  setVideoEnabled(enabled: boolean): void {
    if (this.cameraTrack) this.cameraTrack.enabled = enabled;
    if (this.screenTrack) this.screenTrack.enabled = enabled;
    this.send({ t: "call-video", callId: this.callId, fromPeerId: this.selfPeerId, video: enabled });
  }

  /** Switch camera (front/back on mobile, or between webcams):
   *  stop the old track, get the new one, replaceTrack — no
   *  renegotiation. Returns false when there is no video sender
   *  (voice call) or the new track could not be acquired. */
  async switchCamera(deviceId?: string): Promise<boolean> {
    if (!this.videoSender || !this.cameraTrack) return false;
    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: "environment" },
    };
    let stream: MediaStreamLike;
    try {
      stream = await this.devices.getUserMedia(constraints);
    } catch {
      return false;
    }
    const videoTracks = stream.getVideoTracks();
    const next = videoTracks[0];
    if (!next) return false;
    const old = this.cameraTrack;
    await this.videoSender.replaceTrack(next);
    this.cameraTrack = next;
    try {
      old.stop();
    } catch {
      // Already stopped.
    }
    return true;
  }

  /** Replace the sent video track (screen share). Called by
   *  screen-share.ts; the camera track is kept so it can be
   *  restored. Returns false when there is no video sender. The
   *  remote side is told via call-screen, or its UI would never
   *  know the stream is a screen (MEDIA-SPEC.md §5.1). */
  async replaceVideoTrack(track: MediaTrackLike | null): Promise<boolean> {
    if (!this.videoSender) return false;
    await this.videoSender.replaceTrack(track);
    if (track) this.screenTrack = track;
    this.send({
      t: "call-screen",
      callId: this.callId,
      fromPeerId: this.selfPeerId,
      sharing: track !== null,
    });
    return true;
  }

  /** Restore the camera track after screen sharing stops. */
  async restoreVideoTrack(): Promise<boolean> {
    if (!this.videoSender || !this.cameraTrack) return false;
    await this.videoSender.replaceTrack(this.cameraTrack);
    this.screenTrack = null;
    this.send({
      t: "call-screen",
      callId: this.callId,
      fromPeerId: this.selfPeerId,
      sharing: false,
    });
    return true;
  }

  /** Is a screen currently being shared instead of the camera? */
  get sharingScreen(): boolean {
    return this.screenTrack !== null;
  }

  /** Is the local mic muted? */
  get muted(): boolean {
    const audio = this.localStream?.getAudioTracks()[0];
    return audio ? !audio.enabled : false;
  }

  // ------------------------------------------------------------------
  // Incoming control messages (routed by CallManager).
  // ------------------------------------------------------------------

  /** Route one decoded control message for this call. Unknown or
   *  mismatched messages are ignored — never fatal. */
  async handleControl(message: MediaControlMessage): Promise<void> {
    if ("callId" in message && message.callId !== this.callId) return;
    switch (message.t) {
      case "call-accept": {
        if (this._state !== "inviting") return;
        if (this.inviteTimer) {
          clearTimeout(this.inviteTimer);
          this.inviteTimer = null;
        }
        this.setState("connecting");
        if (!this.mediaConnection) {
          try {
            this.createMediaConnection();
          } catch {
            this.fail("media-connection-failed");
            return;
          }
        }
        const mediaConn = this.mediaConnection;
        if (!mediaConn) {
          this.fail("media-connection-failed");
          return;
        }
        try {
          const offer = await mediaConn.createOffer();
          await mediaConn.setLocalDescription(offer);
          this.send({ t: "call-offer", callId: this.callId, sdp: offer });
          this.armConnectTimeout();
        } catch {
          this.fail("offer-failed");
        }
        return;
      }
      case "call-decline": {
        if (this._state === "inviting" || this._state === "ringing") {
          this.clearTimers();
          this.setState("declined", message.reason ?? "declined");
        }
        return;
      }
      case "call-offer": {
        if (this._state !== "connecting" || !this.mediaConnection) return;
        try {
          await this.mediaConnection.setRemoteDescription(message.sdp);
          const answer = await this.mediaConnection.createAnswer();
          await this.mediaConnection.setLocalDescription(answer);
          this.send({ t: "call-answer", callId: this.callId, sdp: answer });
          this.armConnectTimeout();
        } catch {
          this.fail("answer-failed");
        }
        return;
      }
      case "call-answer": {
        if (this._state !== "connecting" || !this.mediaConnection) return;
        try {
          await this.mediaConnection.setRemoteDescription(message.sdp);
        } catch {
          this.fail("answer-failed");
        }
        return;
      }
      case "call-ice": {
        if (!this.mediaConnection) return;
        try {
          await this.mediaConnection.addIceCandidate(message.candidate);
        } catch {
          // A bad candidate is not fatal — ICE keeps gathering.
        }
        return;
      }
      case "call-bye": {
        if (this._state === "ended" || this._state === "failed" || this._state === "declined") return;
        this.teardown();
        this.setState("ended", message.reason ?? "peer left");
        return;
      }
      case "call-mute": {
        this.remoteAudioOn = message.audio;
        this.onEvent({ type: "remote-muted", audio: message.audio });
        return;
      }
      case "call-video": {
        this.remoteVideoOn = message.video;
        this.onEvent({ type: "remote-video", video: message.video });
        return;
      }
      case "call-screen": {
        this.remoteSharingScreen = message.sharing;
        this.onEvent({ type: "remote-screen", sharing: message.sharing });
        return;
      }
      case "call-quality": {
        // The remote side degraded: show it, don't mirror it.
        this.onEvent({ type: "quality-mode", mode: message.mode });
        return;
      }
      case "record-consent": {
        this.recordingConsent.set(message.fromPeerId, message.recording);
        this.onEvent({ type: "recording-consent", peerId: message.fromPeerId, recording: message.recording });
        return;
      }
      case "recording-active": {
        // The remote side started/stopped local recording (MEDIA-SPEC.md §8):
        // every participant must be able to see that recording is active.
        this.onEvent({ type: "recording-active", peerId: message.fromPeerId, active: message.active });
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------
  // Quality monitor (MEDIA-SPEC.md §7).
  // ------------------------------------------------------------------

  private startStatsPolling(): void {
    if (this.statsIntervalMs <= 0) return;
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      void this.pollStatsOnce();
    }, this.statsIntervalMs);
  }

  /** One stats sample. Public so tests can drive it without timers. */
  async pollStatsOnce(): Promise<void> {
    const conn = this.mediaConnection;
    if (!conn || this._state !== "connected") return;
    let summary;
    try {
      summary = summarizeMediaStats(await conn.getStats());
    } catch {
      return;
    }
    // ICE path + relay warning.
    const diagnostics = describeIcePath({
      localCandidateType: summary.localCandidateType,
      remoteCandidateType: summary.remoteCandidateType,
      relayUrl: summary.relayUrl,
    });
    const wasRelayed = this.lastDiagnostics?.path === "relayed";
    this.lastDiagnostics = diagnostics;
    if (diagnostics.path === "relayed" && !wasRelayed) {
      this.onEvent({ type: "relayed", diagnostics });
    }
    // Degradation: only the outgoing bitrate drives it, and only
    // when the browser actually reports it. Unknown = no change.
    const kbps = summary.outgoingKbps;
    if (kbps === undefined || this.kind !== "video") return;
    const now = this.now();
    if (this.qualityMode === "full" && kbps < VIDEO_DEGRADE_KBPS) {
      if (this.belowSince === null) this.belowSince = now;
      if (now - this.belowSince >= VIDEO_DEGRADE_DWELL_MS) {
        this.applyQualityMode("audio-only");
        this.belowSince = null;
      }
    } else if (this.qualityMode === "full") {
      this.belowSince = null;
    }
    if (this.qualityMode === "audio-only" && kbps >= VIDEO_RESTORE_KBPS) {
      if (this.aboveSince === null) this.aboveSince = now;
      if (now - this.aboveSince >= VIDEO_RESTORE_DWELL_MS) {
        this.applyQualityMode("full");
        this.aboveSince = null;
      }
    } else if (this.qualityMode === "audio-only") {
      this.aboveSince = null;
    }
  }

  private applyQualityMode(mode: CallQualityMode): void {
    if (this.qualityMode === mode) return;
    this.qualityMode = mode;
    if (mode === "audio-only") {
      if (this.cameraTrack) this.cameraTrack.enabled = false;
      if (this.screenTrack) this.screenTrack.enabled = false;
    } else {
      if (this.cameraTrack) this.cameraTrack.enabled = true;
      if (this.screenTrack) this.screenTrack.enabled = true;
    }
    this.send({ t: "call-quality", callId: this.callId, fromPeerId: this.selfPeerId, mode });
    this.onEvent({ type: "quality-mode", mode });
  }

  // ------------------------------------------------------------------
  // Recording consent (MEDIA-SPEC.md §8).
  // ------------------------------------------------------------------

  /** I consent (or withdraw consent) to local recording. Consent is
   *  broadcast so every participant's recorder sees it. */
  setRecordingConsent(recording: boolean): void {
    this.recordingConsent.set(this.selfPeerId, recording);
    this.send({ t: "record-consent", callId: this.callId, fromPeerId: this.selfPeerId, recording });
    this.onEvent({ type: "recording-consent", peerId: this.selfPeerId, recording });
  }

  /** May this peer record? Only when EVERY participant in the call
   *  (self + remote for a 1:1 call) has consented. Silence is never
   *  consent: a missing entry is a no. */
  canRecord(): boolean {
    return (
      this.recordingConsent.get(this.selfPeerId) === true &&
      this.recordingConsent.get(this.remotePeerId) === true
    );
  }

  /** Tell the remote side that local recording started or stopped
   *  (MEDIA-SPEC.md §8): every participant must be able to see that
   *  recording is active. Consent and activity are separate messages
   *  — consent is permission, this is the fact. */
  setRecordingActive(active: boolean): void {
    this.send({ t: "recording-active", callId: this.callId, fromPeerId: this.selfPeerId, active });
  }
}

// ---------------------------------------------------------------------------
// CallManager — routes incoming invites to ringing sessions.
// ---------------------------------------------------------------------------

export interface CallManagerOptions {
  selfPeerId: string;
  selfAddress: string;
  devices: MediaDevicesLike;
  mediaFactory: MediaConnectionFactory;
  iceServers: RTCIceServer[];
  /** Sends one control message toward a peer (over the data channel). */
  sendControl: (peerId: string, message: MediaControlMessage) => void;
  /** A ringing call arrived — the UI answers or declines it. */
  onIncomingCall: (session: CallSession) => void;
  onEvent?: (event: CallEvent) => void;
  /** A media control message no session owns (group/mixer control,
   *  or call signaling for a group media leg): the media UI's group
   *  negotiator handles it. Absent = ignored, as before. */
  onUnhandledControl?: (fromPeerId: string, message: MediaControlMessage) => void;
  /** Every event of every session, with the session attached — the
   *  media UI subscribes here (the session's own onEvent is fixed
   *  at construction inside the manager). */
  onSessionEvent?: (session: CallSession, event: CallEvent) => void;
  randomHex?: (bytes: number) => string;
}

/** Owns all call sessions for one device. Attach it to each P2P
 *  data connection; it opens the `arknetz/media` channel and routes
 *  control messages to the right session by callId.
 *
 *  NOTE (phase 2): several adapters share one connection's
 *  `onchannel` callback. This manager chains onto any previously
 *  set handler for non-media labels instead of clobbering it — but
 *  a proper per-connection channel router is still the right fix
 *  when the UI wiring lands. */
export class CallManager {
  private readonly selfPeerId: string;
  private readonly selfAddress: string;
  private readonly devices: MediaDevicesLike;
  private readonly mediaFactory: MediaConnectionFactory;
  private readonly iceServers: RTCIceServer[];
  private readonly sendControlFn: (peerId: string, message: MediaControlMessage) => void;
  private readonly onIncomingCall: (session: CallSession) => void;
  private readonly onEvent: (event: CallEvent) => void;
  private readonly onUnhandledControl?: (fromPeerId: string, message: MediaControlMessage) => void;
  private readonly onSessionEvent?: (session: CallSession, event: CallEvent) => void;
  private readonly randomHex: (bytes: number) => string;

  /** callId -> session. */
  readonly sessions = new Map<string, CallSession>();
  /** peerId -> data connection (for sending control messages). */
  private readonly connections = new Map<string, P2PConnection>();

  constructor(options: CallManagerOptions) {
    this.selfPeerId = options.selfPeerId;
    this.selfAddress = options.selfAddress;
    this.devices = options.devices;
    this.mediaFactory = options.mediaFactory;
    this.iceServers = options.iceServers;
    this.sendControlFn = options.sendControl;
    this.onIncomingCall = options.onIncomingCall;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onUnhandledControl = options.onUnhandledControl;
    this.onSessionEvent = options.onSessionEvent;
    this.randomHex =
      options.randomHex ??
      ((bytes: number) => {
        const b = new Uint8Array(bytes);
        crypto.getRandomValues(b);
        return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      });
  }

  /** Attach to a P2P data connection: open the media channel and
   *  route incoming media channels to it. */
  attachConnection(connection: P2PConnection): void {
    this.connections.set(connection.peerId, connection);
    const previousOnChannel = connection.onchannel;
    connection.onchannel = (channel) => {
      if (channel.label === MEDIA_CHANNEL_LABEL) {
        channel.onmessage = (data) => {
          const msg = decodeMediaControl(data);
          if (msg) void this.routeControl(connection.peerId, msg);
        };
      } else if (previousOnChannel) {
        previousOnChannel(channel);
      }
    };
    // Open our side of the channel eagerly so the remote side gets
    // onchannel as soon as the data connection is up.
    try {
      const channel = connection.createChannel(MEDIA_CHANNEL_LABEL);
      channel.onmessage = (data) => {
        const msg = decodeMediaControl(data);
        if (msg) void this.routeControl(connection.peerId, msg);
      };
    } catch {
      // Channel not open yet — the remote side's onchannel will
      // fire when it opens, and our handler above routes it.
    }
  }

  detachConnection(peerId: string): void {
    this.connections.delete(peerId);
  }

  /** Start an outgoing 1:1 call. The caller must already have a
   *  data connection to this peer (attachConnection). Returns the
   *  session; the caller awaits `session.start()`. */
  startCall(remotePeerId: string, remoteAddress: string, kind: CallKind): CallSession {
    const session = new CallSession({
      callId: makeCallId(this.randomHex),
      kind,
      selfPeerId: this.selfPeerId,
      selfAddress: this.selfAddress,
      remotePeerId,
      remoteAddress,
      devices: this.devices,
      mediaFactory: this.mediaFactory,
      iceServers: this.iceServers,
      sendControl: (message) => this.sendTo(remotePeerId, message),
      onEvent: (event) => {
        this.onEvent(event);
        this.onSessionEvent?.(session, event);
        if (event.type === "state" && (event.state === "ended" || event.state === "failed" || event.state === "declined")) {
          this.sessions.delete(session.callId);
        }
      },
    });
    this.sessions.set(session.callId, session);
    return session;
  }

  private sendTo(peerId: string, message: MediaControlMessage): void {
    const connection = this.connections.get(peerId);
    if (!connection) return;
    try {
      const channel = connection.createChannel(MEDIA_CHANNEL_LABEL);
      channel.send(encodeMediaControl(message));
    } catch {
      // Channel gone — the session fails on its own timeout.
    }
  }

  /** Route one decoded control message from a peer. */
  async routeControl(fromPeerId: string, message: MediaControlMessage): Promise<void> {
    if (message.t === "call-invite") {
      // A new call: only accept invites addressed to us, for a
      // call we do not already have, while we are not already in
      // a call with this peer.
      if (message.fromPeerId !== fromPeerId) return;
      if (this.sessions.has(message.callId)) return;
      for (const existing of this.sessions.values()) {
        if (
          existing.state === "ringing" ||
          existing.state === "connecting" ||
          existing.state === "connected" ||
          existing.state === "inviting"
        ) {
          // Busy: this device handles one call at a time in v1,
          // whoever the second caller is. Decline politely
          // instead of ringing over a live call.
          this.sendTo(fromPeerId, { t: "call-decline", callId: message.callId, reason: "busy" });
          return;
        }
      }
      const session = new CallSession({
        callId: message.callId,
        kind: message.kind,
        selfPeerId: this.selfPeerId,
        selfAddress: this.selfAddress,
        remotePeerId: fromPeerId,
        remoteAddress: message.fromAddress,
        devices: this.devices,
        mediaFactory: this.mediaFactory,
        iceServers: this.iceServers,
        sendControl: (msg) => this.sendTo(fromPeerId, msg),
        onEvent: (event) => {
          this.onEvent(event);
          this.onSessionEvent?.(session, event);
          if (event.type === "state" && (event.state === "ended" || event.state === "failed" || event.state === "declined")) {
            this.sessions.delete(session.callId);
          }
        },
      });
      this.sessions.set(session.callId, session);
      session.markRinging();
      this.onIncomingCall(session);
      return;
    }
    // Every other message needs an existing session.
    if (!("callId" in message)) {
      // Group / mixer control has a groupId, not a callId — the
      // media UI's group negotiator owns it, not the 1:1 router.
      this.onUnhandledControl?.(fromPeerId, message);
      return;
    }
    const session = this.sessions.get(message.callId);
    if (!session) {
      // No 1:1 session owns this callId — it may be a group media
      // leg (callId `group-…`). Hand it to the group negotiator;
      // anything else is ignored there, never fatal.
      this.onUnhandledControl?.(fromPeerId, message);
      return;
    }
    if (session.remotePeerId !== fromPeerId) return;
    await session.handleControl(message);
  }

  /** End every live session (media switched off, peer ID rotated,
   *  P2P reset). Each side gets a `call-bye` when the channel is
   *  still up; a dead channel just ends locally. */
  closeAll(reason = "ended"): void {
    for (const session of [...this.sessions.values()]) {
      if (
        session.state === "ringing" ||
        session.state === "connecting" ||
        session.state === "connected" ||
        session.state === "inviting"
      ) {
        session.end(reason);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Local recording (MEDIA-SPEC.md §8) — consent-gated, local only.
// ---------------------------------------------------------------------------

export interface RecorderLike {
  start(): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  readonly state: "inactive" | "recording" | "paused";
}

export type RecorderFactory = (stream: MediaStream) => RecorderLike;

/** Local-only call recorder. It records the LOCAL composite stream
 *  the UI hands it (mic + remote audio mixed by the UI, and video
 *  if present). It never uploads anything, and it refuses to start
 *  unless `canRecord()` is true on the session — consent is checked
 *  at start and on every consent change, not just once. In Node,
 *  MediaRecorder does not exist: the default factory throws a
 *  plain error, and recording is simply unavailable. */
export class LocalCallRecorder {
  private recorder: RecorderLike | null = null;
  private readonly chunks: Blob[] = [];
  recording = false;

  constructor(
    private readonly session: CallSession,
    private readonly factory: RecorderFactory | null,
  ) {}

  /** Start recording. Returns false when consent is missing or no
   *  recorder is available here. */
  start(stream: MediaStream): boolean {
    if (this.recording) return true;
    if (!this.session.canRecord()) return false;
    if (!this.factory) return false;
    try {
      const recorder = this.factory(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onstop = () => {
        this.recording = false;
      };
      recorder.start();
      this.recorder = recorder;
      this.recording = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Stop recording. Returns the recorded blobs (empty when nothing
   *  was recorded). Consent withdrawal mid-recording must call
   *  this — the session's consent handler in phase 2 wires it. */
  stop(): Blob[] {
    if (!this.recorder) return [...this.chunks];
    try {
      this.recorder.stop();
    } catch {
      // Already stopped.
    }
    this.recorder = null;
    this.recording = false;
    const out = [...this.chunks];
    this.chunks.length = 0;
    return out;
  }
}

/** Default recorder factory for the browser. Returns null in Node
 *  (no MediaRecorder) so the recorder reports unavailable instead
 *  of crashing. */
export function browserRecorderFactory(): RecorderFactory | null {
  if (typeof MediaRecorder === "undefined") return null;
  return (stream: MediaStream) => new MediaRecorder(stream) as unknown as RecorderLike;
}
