// ArkNetzWebWeaver — Calls panel: the media UI (phase 2 of the
// media program, MEDIA-SPEC.md §11).
//
// The media core (call-session.ts, mixer.ts, screen-share.ts) owns
// the state machines; this module is the one place that turns them
// into a panel: the Calls view-model, the controller that drives
// 1:1 + group calls through the P2P host, the pure HTML renderer,
// and the mount that binds buttons and attaches real video tracks
// to <video> elements.
//
// Honesty rules, enforced here, not just in the spec:
// - The mixer is NEVER presented as blind: a selective-forwarding
//   mixer terminates DTLS-SRTP per leg and CAN access the media it
//   forwards (MEDIA-SPEC.md §6.4). The mixer identity is always
//   visible in a mixer-routed call, with the trust note next to it.
// - Recording needs every participant's consent, and every
//   participant sees when recording is active (recording-active).
//   Silence is never consent.
// - Android screen sharing is disabled with the stub reason in
//   plain words — never a spinner, never a fake.
// - A call has no GitHub fallback: when it cannot connect, the
//   panel says exactly that and points at BYO TURN (MEDIA-SPEC.md §9.1).
// - No quota budgeting or relay rationing anywhere in this module.
//
// No DOM access in the controller or the renderer (renderCallsPanelHtml
// is pure); mountCallsPanel is the only DOM-touching function, and it
// guards every browser-only API so the module loads in Node tests.
//
// Licence: MIT. No new dependencies.

import { CallManager } from "./call-session.js";
import type { CallEvent, CallSession } from "./call-session.js";
import {
  CallConnectError,
  LocalCallRecorder,
  browserRecorderFactory,
  type RecorderFactory,
} from "./call-session.js";
import { GroupCall } from "./mixer.js";
import type { GroupEvent } from "./mixer.js";
import { ScreenShareSession } from "./screen-share.js";
import type { MediaDevicesLike, MediaStreamLike, MediaTrackLike } from "./media-devices.js";
import type { MediaConnection, MediaConnectionFactory } from "./media-connection.js";
import {
  CALL_NO_RELAY_NOTE,
  CALL_NO_RELAY_REASON,
  CALL_RELAYED_NOTE,
  MIXER_VOLUNTEER_NOTE,
  SCREEN_SHARE_ANDROID_NOTE,
  mixerRoutedNote,
  type CallKind,
  type MediaControlMessage,
} from "./media.js";
import type { P2PSettings } from "./types.js";
import { defaultP2PSettings } from "./types.js";
import type { P2PConnection } from "./transport.js";
import type { P2PPeerInfo } from "./host.js";
import type { MailAddress } from "../mail/types.js";

/** What the calls controller needs from the P2P host. P2PHost
 *  satisfies this structurally (checked where the controller is
 *  constructed in app.ts); tests pass a fake host. */
export interface CallsHost {
  getCallManager(): CallManager | null;
  getSettings(): P2PSettings;
  getPeerId(): string;
  /** This device's own protocol address, or null before sign-in. */
  readonly selfAddress: string | null;
  mediaAvailable(): boolean;
  mediaIceServers(): RTCIceServer[];
  connectedPeers(): Promise<P2PPeerInfo[]>;
  connectToAddress(address: MailAddress): Promise<P2PConnection | null>;
  startCallSession(peerId: string, address: string, kind: CallKind): CallSession | null;
  sendMediaControlTo(peerId: string, message: MediaControlMessage): boolean;
  broadcastMediaControl(message: MediaControlMessage): number;
  setIncomingCallHandler(fn: ((session: CallSession) => void) | null): void;
  setUnhandledMediaHandler(
    fn: ((fromPeerId: string, message: MediaControlMessage) => void) | null,
  ): void;
  setSessionEventHandler(
    fn: ((session: CallSession, event: CallEvent) => void) | null,
  ): void;
}

export const CALLS_PANEL_ID = "calls";
export const CALLS_PANEL_TITLE = "Calls";
export const CALLS_PANEL_DESCRIPTION =
  "Encrypted voice, video, screensharing, and group calls over P2P. Off by default; calls have no GitHub fallback.";

/** Plain words for the panel's states. */
export const CALLS_OFF_COPY =
  "Calls are off. Turn on peer-to-peer and media in Settings → P2P → Calls first.";
export const CALLS_NO_WEBRTC_COPY =
  "Calls need a browser with WebRTC — this build cannot place calls. Sites, mail, and drive still work over GitHub.";
export const CALLS_NO_IDENTITY_COPY =
  "Sign in with GitHub and create a mail keypair to call peers — calls are addressed to protocol addresses (you@domain).";
export const CALLS_NO_PEERS_COPY =
  "No P2P peers connected yet. Calls go to peers you are already connected to — load a friend's site, or share a team, and they appear here. Or call by address below.";
export const CALLS_ONE_AT_A_TIME_COPY =
  "Already in a call — one call at a time in this version. Leave the current call first.";
export const CALLS_MIXER_TRUST_COPY =
  "The mixer can technically access the media it forwards — it terminates the encrypted media session on each leg. The group always sees who the mixer is, and the mixer role is opt-in and revocable.";
export const CALLS_NO_VOLUNTEER_COPY =
  "No volunteer mixer — this group is in mesh mode past 5 people, so quality may suffer. Volunteer in Settings → P2P → Calls to let the group elect a mixer.";
export const CALLS_RECORDING_NOTE =
  "Recording is local only — it never leaves this device — and it needs everyone's consent. Silence is never consent: recording stays off until every participant has consented.";

export interface CallPeerRow {
  peerId: string;
  address: string;
}

export interface GroupParticipantRow {
  peerId: string;
  address: string;
  volunteer: boolean;
  isSelf: boolean;
  isMixer: boolean;
  hasVideo: boolean;
}

export interface ActiveCallView {
  callId: string;
  kind: CallKind;
  peerAddress: string;
  state: string;
  muted: boolean;
  videoEnabled: boolean;
  sharingScreen: boolean;
  remoteMuted: boolean;
  remoteVideoOn: boolean;
  remoteSharingScreen: boolean;
  qualityMode: string;
  diagnostics: string | null;
  relayed: boolean;
  hasRemoteVideo: boolean;
  hasRemoteAudio: boolean;
  hasLocalVideo: boolean;
  myConsent: boolean;
  remoteConsent: boolean;
  canRecord: boolean;
  recording: boolean;
  remoteRecording: boolean;
}

export interface GroupCallView {
  groupId: string;
  mode: string;
  mixerPeerId: string | null;
  isMixer: boolean;
  participants: GroupParticipantRow[];
  noVolunteer: boolean;
  mixerLost: string | null;
}

export interface CallsViewModel {
  /** A CallManager exists (WebRTC present + identity configured). */
  available: boolean;
  mediaOn: boolean;
  groupsOn: boolean;
  voiceOn: boolean;
  videoOn: boolean;
  screenShareOn: boolean;
  selfAddress: string | null;
  peers: CallPeerRow[];
  callAddressDraft: string;
  incoming: { callId: string; kind: CallKind; fromAddress: string } | null;
  active: ActiveCallView | null;
  group: GroupCallView | null;
  /** An unanswered group-call invite, if one is ringing. */
  groupInvite: { groupId: string; fromPeerId: string; fromAddress: string } | null;
  screenShareSupported: boolean;
  screenShareNote: string | null;
  lastError: string | null;
}

export interface CallsControllerOptions {
  host: CallsHost;
  devices: MediaDevicesLike;
  mediaFactory: MediaConnectionFactory;
  userAgent: string;
  /** Called on every state change (the panel re-renders). */
  onChange?: () => void;
  /** Download a finished recording. Defaults to an anchor download. */
  download?: (blob: Blob, filename: string) => void;
  /** Recorder factory override (tests). Defaults to the browser's MediaRecorder. */
  recorderFactory?: RecorderFactory | null;
  now?: () => number;
  randomHex?: (bytes: number) => string;
}

const GROUP_INVITE_KIND: CallKind = "video";

function defaultRandomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Drives 1:1 + group calls through the P2P host and exposes the
 *  plain view-model the renderer reads. No DOM here. */
export class MediaCallController {
  private readonly host: CallsHost;
  private readonly devices: MediaDevicesLike;
  private readonly mediaFactory: MediaConnectionFactory;
  private readonly userAgent: string;
  private onChange: (() => void) | null;
  private readonly downloadFn: (blob: Blob, filename: string) => void;
  private readonly recorderFactoryOverride: RecorderFactory | null | undefined;
  private readonly now: () => number;
  private readonly randomHex: (bytes: number) => string;
  private readonly screenShare: ScreenShareSession;

  private activeSession: CallSession | null = null;
  private incomingSession: CallSession | null = null;
  private peers: P2PPeerInfo[] = [];
  /** The call-by-address draft (kept here so panel re-renders do
   *  not wipe what the user typed). */
  callAddressDraft = "";
  private remoteAudioTrack: MediaTrackLike | null = null;
  private remoteVideoTrack: MediaTrackLike | null = null;
  private recording = false;
  private remoteRecording = false;
  private recorder: LocalCallRecorder | null = null;
  private lastError: string | null = null;
  private disposed = false;

  // Group call state.
  private groupCall: GroupCall | null = null;
  /** True while I created this group (I am its first member). */
  private groupCreatedByMe = false;
  private groupLocalStream: MediaStreamLike | null = null;
  private readonly groupConnections = new Map<string, MediaConnection>();
  /** peerId -> remote tracks on the mesh leg (or the mixer leg). */
  private readonly groupRemoteTracks = new Map<
    string,
    { audio: MediaTrackLike | null; video: MediaTrackLike | null }
  >();
  /** peerId -> whether local tracks were already added to the leg. */
  private readonly groupLegHasLocalTracks = new Set<string>();
  /** peerId -> whether the leg's remote description is set. */
  private readonly groupLegRemoteDescSet = new Set<string>();
  /** peerId -> ICE candidates that arrived before the remote
   *  description (flushed once it is set). */
  private readonly groupPendingIce = new Map<string, RTCIceCandidateInit[]>();
  /** Legs I have offered on (glare guard: only the lower peerId
   *  offers, and only once per leg). */
  private readonly groupOffersSent = new Set<string>();
  /** Legs I have received an offer on (never offer back on these). */
  private readonly groupOffersReceived = new Set<string>();
  private groupNoVolunteer = false;
  private groupMixerLost: string | null = null;
  private groupInvite: {
    groupId: string;
    fromPeerId: string;
    fromAddress: string;
    volunteerMixer: boolean;
  } | null = null;

  constructor(options: CallsControllerOptions) {
    this.host = options.host;
    this.devices = options.devices;
    this.mediaFactory = options.mediaFactory;
    this.userAgent = options.userAgent;
    this.onChange = options.onChange ?? null;
    this.downloadFn =
      options.download ??
      ((blob: Blob, filename: string) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      });
    this.recorderFactoryOverride = options.recorderFactory;
    this.now = options.now ?? (() => Date.now());
    this.randomHex = options.randomHex ?? defaultRandomHex;
    this.screenShare = new ScreenShareSession(this.devices, this.userAgent);
    this.host.setIncomingCallHandler((session) => this.onIncomingSession(session));
    this.host.setUnhandledMediaHandler((peerId, message) => this.onUnhandledMedia(peerId, message));
    this.host.setSessionEventHandler((session, event) => this.onSessionEvent(session, event));
  }

  setOnChange(fn: (() => void) | null): void {
    this.onChange = fn;
  }

  private emit(): void {
    if (!this.disposed) this.onChange?.();
  }

  private settings(): P2PSettings {
    return this.host.getSettings();
  }

  private mediaOn(): boolean {
    const s = this.settings();
    return s.enabled && s.media.enabled;
  }

  /** Screen-share support on this device (Android = stub). */
  screenSupport(): { supported: boolean; detail: string | null } {
    const support = this.screenShare.support();
    return support.supported
      ? { supported: true, detail: null }
      : { supported: false, detail: support.detail };
  }

  /** The local video track of the active call or group, for the
   *  preview element. */
  localVideoTrack(): MediaTrackLike | null {
    const fromCall = this.activeSession?.localStream?.getVideoTracks()[0];
    if (fromCall) return fromCall;
    return this.groupLocalStream?.getVideoTracks()[0] ?? null;
  }

  /** The remote video track of the active 1:1 call. */
  get remoteVideo(): MediaTrackLike | null {
    return this.remoteVideoTrack;
  }

  /** The remote audio track of the active 1:1 call. */
  get remoteAudio(): MediaTrackLike | null {
    return this.remoteAudioTrack;
  }

  /** One group participant's remote video track (their tile). */
  groupVideoTrack(peerId: string): MediaTrackLike | null {
    return this.groupRemoteTracks.get(peerId)?.video ?? null;
  }

  /** One group participant's remote audio track (their tile). */
  groupAudioTrack(peerId: string): MediaTrackLike | null {
    return this.groupRemoteTracks.get(peerId)?.audio ?? null;
  }

  /** Refresh the connected-peer list (only re-renders when it
   *  actually changed — the panel calls this on every render). */
  async refreshPeers(): Promise<void> {
    let peers: P2PPeerInfo[];
    try {
      peers = await this.host.connectedPeers();
    } catch {
      return;
    }
    const key = JSON.stringify(peers.map((p) => [p.peerId, p.address]));
    const oldKey = JSON.stringify(this.peers.map((p) => [p.peerId, p.address]));
    if (key === oldKey) return;
    this.peers = peers;
    this.emit();
  }

  viewModel(): CallsViewModel {
    const settings = this.settings();
    const session = this.activeSession;
    const incoming = this.incomingSession;
    const screen = this.screenShare.support();
    return {
      available: this.host.getCallManager() !== null,
      mediaOn: this.mediaOn(),
      groupsOn: settings.media.groups,
      voiceOn: settings.media.voice,
      videoOn: settings.media.video,
      screenShareOn: settings.media.screenShare,
      selfAddress: this.host.selfAddress,
      peers: this.peers.map((p) => ({ peerId: p.peerId, address: p.address })),
      callAddressDraft: this.callAddressDraft,
      incoming: incoming
        ? { callId: incoming.callId, kind: incoming.kind, fromAddress: incoming.remoteAddress }
        : null,
      active: session
        ? {
            callId: session.callId,
            kind: session.kind,
            peerAddress: session.remoteAddress,
            state: session.state,
            muted: session.muted,
            videoEnabled: this.localVideoEnabled(session),
            sharingScreen: session.sharingScreen,
            remoteMuted: !session.remoteAudioOn,
            remoteVideoOn: session.remoteVideoOn,
            remoteSharingScreen: session.remoteSharingScreen,
            qualityMode: session.qualityMode,
            diagnostics: session.lastDiagnostics?.summary ?? null,
            relayed: session.lastDiagnostics?.path === "relayed",
            hasRemoteVideo: this.remoteVideoTrack !== null,
            hasRemoteAudio: this.remoteAudioTrack !== null,
            hasLocalVideo: (session.localStream?.getVideoTracks().length ?? 0) > 0,
            myConsent:
              session.recordingConsent.get(this.host.getPeerId()) === true,
            remoteConsent:
              session.recordingConsent.get(session.remotePeerId) === true,
            canRecord: session.canRecord(),
            recording: this.recording,
            remoteRecording: this.remoteRecording,
          }
        : null,
      group: this.groupCall
        ? {
            groupId: this.groupCall.groupId,
            mode: this.groupCall.mode,
            mixerPeerId: this.groupCall.mixerPeerId,
            isMixer: this.groupCall.isMixer,
            participants: [...this.groupCall.participants.values()].map((p) => ({
              peerId: p.peerId,
              address: p.address,
              volunteer: p.volunteerMixer,
              isSelf: p.peerId === this.host.getPeerId(),
              isMixer: this.groupCall?.mixerPeerId === p.peerId,
              hasVideo: (this.groupRemoteTracks.get(p.peerId)?.video ?? null) !== null,
            })),
            noVolunteer: this.groupNoVolunteer,
            mixerLost: this.groupMixerLost,
          }
        : null,
      groupInvite: this.groupInvite
        ? {
            groupId: this.groupInvite.groupId,
            fromPeerId: this.groupInvite.fromPeerId,
            fromAddress: this.groupInvite.fromAddress,
          }
        : null,
      screenShareSupported: screen.supported,
      screenShareNote: screen.supported ? null : screen.detail,
      lastError: this.lastError,
    };
  }

  private localVideoEnabled(session: CallSession): boolean {
    const track = session.localStream?.getVideoTracks()[0];
    return track ? track.enabled : false;
  }

  /** End everything this controller owns (panel teardown). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeSession) {
      try {
        this.activeSession.end();
      } catch {
        // Already gone.
      }
      this.activeSession = null;
    }
    this.leaveGroupCall();
    this.host.setIncomingCallHandler(null);
    this.host.setUnhandledMediaHandler(null);
    this.host.setSessionEventHandler(null);
  }

  // ------------------------------------------------------------------
  // 1:1 calls.
  // ------------------------------------------------------------------

  /** Start an outgoing call to a connected peer. Returns false when
   *  the call could not start (lastError says why, in plain words). */
  async startCall(peerId: string, address: string, kind: CallKind): Promise<boolean> {
    this.lastError = null;
    const settings = this.settings();
    if (!this.host.mediaAvailable()) {
      this.lastError = CALLS_OFF_COPY;
      this.emit();
      return false;
    }
    if (kind === "voice" && !settings.media.voice) {
      this.lastError = "Voice calls are off in Settings → P2P → Calls.";
      this.emit();
      return false;
    }
    if (kind === "video" && !settings.media.video) {
      this.lastError = "Video calls are off in Settings → P2P → Calls.";
      this.emit();
      return false;
    }
    if (this.activeSession || this.incomingSession) {
      this.lastError = CALLS_ONE_AT_A_TIME_COPY;
      this.emit();
      return false;
    }
    const session = this.host.startCallSession(peerId, address, kind);
    if (!session) {
      this.lastError =
        "That peer is not connected right now — calls need a live P2P connection, and both peers online at the same time.";
      this.emit();
      return false;
    }
    this.activeSession = session;
    this.emit();
    try {
      await session.start();
    } catch (e) {
      const reason = e instanceof CallConnectError ? e.reason : "call-failed";
      this.lastError =
        reason === CALL_NO_RELAY_REASON
          ? CALL_NO_RELAY_NOTE
          : e instanceof Error
            ? e.message
            : "The call failed.";
      if (this.activeSession === session) this.activeSession = null;
      this.emit();
      return false;
    }
    this.emit();
    return true;
  }

  /** Call a peer by protocol address: connect first (ad discovery
   *  + handshake), then start the call. False when the peer cannot
   *  be reached — an offline peer is unreachable, not a missed call. */
  async callAddress(address: string, kind: CallKind): Promise<boolean> {
    this.lastError = null;
    const trimmed = address.trim().toLowerCase();
    if (!trimmed.includes("@")) {
      this.lastError = "Enter a protocol address like friend@computers.edu.";
      this.emit();
      return false;
    }
    if (!this.host.mediaAvailable()) {
      this.lastError = CALLS_OFF_COPY;
      this.emit();
      return false;
    }
    let connection: P2PConnection | null;
    try {
      connection = await this.host.connectToAddress(trimmed as MailAddress);
    } catch {
      connection = null;
    }
    if (!connection) {
      this.lastError = `Could not reach ${trimmed} — no peer ad, or the peer is offline. Calls need both peers online at the same time.`;
      this.emit();
      return false;
    }
    return this.startCall(connection.peerId, trimmed, kind);
  }

  private onIncomingSession(session: CallSession): void {
    if (this.disposed) return;
    // The CallManager already declines while busy; this is the first ring.
    this.incomingSession = session;
    this.emit();
  }

  async acceptIncoming(): Promise<boolean> {
    const session = this.incomingSession;
    if (!session) return false;
    this.incomingSession = null;
    this.activeSession = session;
    this.emit();
    try {
      await session.accept();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : "Could not answer the call.";
      if (this.activeSession === session) this.activeSession = null;
      this.emit();
      return false;
    }
    this.emit();
    return true;
  }

  declineIncoming(reason = "declined"): void {
    const session = this.incomingSession;
    if (!session) return;
    this.incomingSession = null;
    session.decline(reason);
    this.emit();
  }

  endCall(): void {
    const session = this.activeSession;
    if (!session) return;
    this.stopRecordingInternal(false);
    void this.screenShare.stop(session).catch(() => undefined);
    session.end();
    if (this.activeSession === session) this.activeSession = null;
    this.remoteAudioTrack = null;
    this.remoteVideoTrack = null;
    this.remoteRecording = false;
    this.emit();
  }

  toggleMute(): void {
    const session = this.activeSession;
    if (!session) return;
    session.setMuted(!session.muted);
    this.emit();
  }

  toggleVideo(): void {
    const session = this.activeSession;
    if (!session) return;
    session.setVideoEnabled(!this.localVideoEnabled(session));
    this.emit();
  }

  async switchCamera(): Promise<boolean> {
    const session = this.activeSession;
    if (!session) return false;
    const ok = await session.switchCamera();
    if (!ok) this.lastError = "Could not switch camera on this device.";
    this.emit();
    return ok;
  }

  async startScreenShare(): Promise<boolean> {
    const session = this.activeSession;
    if (!session) return false;
    this.lastError = null;
    try {
      await this.screenShare.start(session);
      this.emit();
      return true;
    } catch (e) {
      // ScreenShareUnavailableError carries the plain-words detail
      // (Android stub included) — show it, never a raw reason code.
      this.lastError = e instanceof Error ? e.message : "Screen sharing failed.";
      this.emit();
      return false;
    }
  }

  async stopScreenShare(): Promise<void> {
    const session = this.activeSession;
    if (!session) return;
    await this.screenShare.stop(session).catch(() => undefined);
    this.emit();
  }

  private onSessionEvent(session: CallSession, event: CallEvent): void {
    if (this.disposed) return;
    const mine = session === this.activeSession || session === this.incomingSession;
    if (!mine) return;
    switch (event.type) {
      case "state": {
        if (
          event.state === "ended" ||
          event.state === "failed" ||
          event.state === "declined"
        ) {
          if (session === this.activeSession) {
            this.stopRecordingInternal(false);
            this.activeSession = null;
            this.remoteAudioTrack = null;
            this.remoteVideoTrack = null;
            this.remoteRecording = false;
            if (event.state === "failed" && event.reason) {
              this.lastError =
                event.reason === CALL_NO_RELAY_REASON
                  ? CALL_NO_RELAY_NOTE
                  : `The call failed (${event.reason}).`;
            }
          }
          if (session === this.incomingSession) this.incomingSession = null;
        }
        break;
      }
      case "remote-track": {
        if (session !== this.activeSession) break;
        if (event.kind === "audio") this.remoteAudioTrack = event.track;
        else this.remoteVideoTrack = event.track;
        break;
      }
      case "recording-consent": {
        // Consent withdrawn mid-recording: stop immediately (§8).
        if (
          this.recording &&
          session === this.activeSession &&
          !session.canRecord()
        ) {
          this.stopRecordingInternal(true);
        }
        break;
      }
      case "recording-active": {
        this.remoteRecording = event.active;
        break;
      }
      default:
        break;
    }
    this.emit();
  }

  // ------------------------------------------------------------------
  // Recording (MEDIA-SPEC.md §8) — local only, all-party consent.
  // ------------------------------------------------------------------

  toggleRecordingConsent(): void {
    const session = this.activeSession;
    if (!session) return;
    const current = session.recordingConsent.get(this.host.getPeerId()) === true;
    session.setRecordingConsent(!current);
    this.emit();
  }

  startRecording(): boolean {
    const session = this.activeSession;
    if (!session || !session.canRecord() || this.recording) return false;
    const stream = this.buildRecordingStream(session);
    if (!stream) {
      this.lastError = "Recording is not available on this device.";
      this.emit();
      return false;
    }
    const factory = this.recorderFactoryOverride ?? browserRecorderFactory();
    if (!factory) {
      this.lastError = "Recording is not available on this device (no MediaRecorder).";
      this.emit();
      return false;
    }
    this.recorder = new LocalCallRecorder(session, factory);
    if (!this.recorder.start(stream)) {
      this.recorder = null;
      this.lastError = "Recording could not start.";
      this.emit();
      return false;
    }
    this.recording = true;
    session.setRecordingActive(true);
    this.emit();
    return true;
  }

  stopRecording(): void {
    this.stopRecordingInternal(true);
    this.emit();
  }

  private stopRecordingInternal(downloadIt: boolean): void {
    if (!this.recorder) return;
    const blobs = this.recorder.stop();
    this.recorder = null;
    const wasRecording = this.recording;
    this.recording = false;
    const session = this.activeSession;
    if (wasRecording && session && session.state === "connected") {
      try {
        session.setRecordingActive(false);
      } catch {
        // The session is gone — the recording already stopped.
      }
    }
    if (downloadIt && blobs.length > 0) {
      const blob = new Blob(blobs, { type: "video/webm" });
      this.downloadFn(blob, `arknetz-call-${session?.callId ?? "recording"}.webm`);
    }
  }

  /** The recording stream: local mic + remote audio mixed, plus the
   *  local video track when the call has one. Browser path mixes
   *  through an AudioContext; the fallback (tests, or a browser
   *  without AudioContext) hands the raw tracks to the recorder. */
  private buildRecordingStream(session: CallSession): MediaStream | null {
    const local = session.localStream;
    if (!local) return null;
    const audioTracks = [...local.getAudioTracks()];
    if (this.remoteAudioTrack) audioTracks.push(this.remoteAudioTrack);
    const videoTrack = local.getVideoTracks()[0] ?? this.remoteVideoTrack ?? null;
    const realAudio = audioTracks
      .map((t) => t.realTrack)
      .filter((t): t is MediaStreamTrack => !!t);
    if (
      typeof AudioContext !== "undefined" &&
      realAudio.length > 0 &&
      realAudio.length === audioTracks.length
    ) {
      try {
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        for (const track of realAudio) {
          ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
        }
        const out = dest.stream;
        if (videoTrack?.realTrack) out.addTrack(videoTrack.realTrack);
        return out;
      } catch {
        // Fall through to the raw-track stream.
      }
    }
    const realTracks = [
      ...audioTracks.map((t) => t.realTrack).filter((t): t is MediaStreamTrack => !!t),
      ...(videoTrack?.realTrack ? [videoTrack.realTrack] : []),
    ];
    if (typeof MediaStream !== "undefined" && realTracks.length > 0) {
      return new MediaStream(realTracks);
    }
    return {
      getTracks: () => [...audioTracks, ...(videoTrack ? [videoTrack] : [])],
      getAudioTracks: () => [...audioTracks],
      getVideoTracks: () => (videoTrack ? [videoTrack] : []),
      addTrack: () => undefined,
      removeTrack: () => undefined,
      id: "recording",
    } as unknown as MediaStream;
  }


  // ------------------------------------------------------------------
  // Group calls (MEDIA-SPEC.md §6) — mesh up to 5, then the
  // elected volunteer mixer. Membership and mesh legs are
  // negotiated over the arknetz/media data channel with group-*
  // control messages; the coordinator (longest-joined member)
  // relays group-join so a member that only knows the coordinator
  // still learns the whole group.
  // ------------------------------------------------------------------

  private async acquireGroupLocalStream(): Promise<MediaStreamLike | null> {
    const settings = this.settings();
    try {
      return await this.devices.getUserMedia({
        audio: true,
        video: settings.media.video,
      });
    } catch {
      this.lastError =
        "Could not start the group call — no microphone or camera on this device.";
      this.emit();
      return null;
    }
  }

  private makeGroupCall(groupId: string): GroupCall | null {
    const selfAddress = this.host.selfAddress;
    if (!selfAddress) {
      this.lastError = CALLS_NO_IDENTITY_COPY;
      this.emit();
      return null;
    }
    const settings = this.settings();
    return new GroupCall({
      groupId,
      selfPeerId: this.host.getPeerId(),
      selfAddress,
      volunteerMixer: settings.media.volunteerMixer,
      mediaConnector: (peerId: string) => {
        let conn = this.groupConnections.get(peerId);
        if (!conn || conn.state === "closed") {
          conn = this.mediaFactory.createConnection(peerId, {
            iceServers: this.host.mediaIceServers(),
          });
          conn.onicecandidate = (candidate) => {
            if (!candidate) return;
            this.host.sendMediaControlTo(peerId, {
              t: "group-ice",
              groupId,
              fromPeerId: this.host.getPeerId(),
              candidate,
            });
          };
          this.groupConnections.set(peerId, conn);
        }
        return conn;
      },
      sendControl: (message) => {
        const g = this.groupCall;
        if (!g) return;
        for (const peerId of g.participants.keys()) {
          if (peerId === this.host.getPeerId()) continue;
          this.host.sendMediaControlTo(peerId, message);
        }
      },
      onEvent: (event) => this.onGroupEvent(event),
    });
  }

  /** Start a group call and invite the listed connected peers.
   *  Each peer joins through their own accept — nobody is pulled
   *  into a call silently. */
  async startGroupCall(peerIds: string[]): Promise<boolean> {
    this.lastError = null;
    if (!this.host.mediaAvailable()) {
      this.lastError = CALLS_OFF_COPY;
      this.emit();
      return false;
    }
    const settings = this.settings();
    if (!settings.media.groups) {
      this.lastError = "Group calls are off in Settings → P2P → Calls.";
      this.emit();
      return false;
    }
    if (this.groupCall || this.activeSession || this.incomingSession) {
      this.lastError = CALLS_ONE_AT_A_TIME_COPY;
      this.emit();
      return false;
    }
    if (!this.host.selfAddress) {
      this.lastError = CALLS_NO_IDENTITY_COPY;
      this.emit();
      return false;
    }
    const stream = await this.acquireGroupLocalStream();
    if (!stream) return false;
    const group = this.makeGroupCall(this.randomHex(16));
    if (!group) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    this.groupCall = group;
    this.groupCreatedByMe = true;
    this.groupLocalStream = stream;
    this.groupNoVolunteer = false;
    this.groupMixerLost = null;
    group.join(0, 1);
    this.emit();
    for (const peerId of peerIds) {
      this.host.sendMediaControlTo(peerId, {
        t: "group-invite",
        groupId: group.groupId,
        fromPeerId: this.host.getPeerId(),
        fromAddress: this.host.selfAddress,
        volunteerMixer: settings.media.volunteerMixer,
        kind: GROUP_INVITE_KIND,
      });
    }
    return true;
  }

  /** Join a group call after an incoming invite. */
  async joinGroupCall(): Promise<boolean> {
    const invite = this.groupInvite;
    if (!invite) return false;
    this.lastError = null;
    if (!this.host.mediaAvailable()) {
      this.lastError = CALLS_OFF_COPY;
      this.emit();
      return false;
    }
    if (this.groupCall || this.activeSession || this.incomingSession) {
      this.lastError = CALLS_ONE_AT_A_TIME_COPY;
      this.emit();
      return false;
    }
    const stream = await this.acquireGroupLocalStream();
    if (!stream) return false;
    const group = this.makeGroupCall(invite.groupId);
    if (!group) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    this.groupCall = group;
    this.groupCreatedByMe = false;
    this.groupLocalStream = stream;
    this.groupInvite = null;
    group.addParticipant(invite.fromPeerId, invite.fromAddress, invite.volunteerMixer);
    group.join(0, 1);
    this.emit();
    return true;
  }

  leaveGroupCall(): void {
    const group = this.groupCall;
    if (!group) return;
    try {
      group.leave();
    } catch {
      // Already gone.
    }
    for (const conn of [...this.groupConnections.values()]) {
      try {
        conn.close();
      } catch {
        // Already closed.
      }
    }
    this.groupConnections.clear();
    this.groupLegHasLocalTracks.clear();
    this.groupLegRemoteDescSet.clear();
    this.groupPendingIce.clear();
    this.groupOffersSent.clear();
    this.groupOffersReceived.clear();
    this.groupRemoteTracks.clear();
    if (this.groupLocalStream) {
      for (const track of this.groupLocalStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already stopped.
        }
      }
      this.groupLocalStream = null;
    }
    this.groupCall = null;
    this.groupCreatedByMe = false;
    this.groupNoVolunteer = false;
    this.groupMixerLost = null;
    this.emit();
  }

  declineGroupInvite(): void {
    const invite = this.groupInvite;
    if (!invite) return;
    this.groupInvite = null;
    this.host.sendMediaControlTo(invite.fromPeerId, {
      t: "group-decline",
      groupId: invite.groupId,
      fromPeerId: this.host.getPeerId(),
    });
    this.emit();
  }

  /** Invite one more connected peer into the live group call.
   *  Any member can invite: the invitee's group-join reaches the
   *  coordinator (directly, or forwarded by the inviter) and the
   *  coordinator relays it to the whole group. */
  invitePeerToGroup(peerId: string): boolean {
    const group = this.groupCall;
    if (!group || !this.host.selfAddress) return false;
    return this.host.sendMediaControlTo(peerId, {
      t: "group-invite",
      groupId: group.groupId,
      fromPeerId: this.host.getPeerId(),
      fromAddress: this.host.selfAddress,
      volunteerMixer: this.settings().media.volunteerMixer,
      kind: GROUP_INVITE_KIND,
    });
  }

  /** Open (or reuse) the mesh leg to a participant, add local
   *  tracks once, and offer when the deterministic glare rule
   *  says I offer (lower peerId offers — both sides agree without
   *  negotiating). Skipped in mixer mode for non-mixer peers: my
   *  only leg is to the mixer. */
  private async openLeg(peerId: string): Promise<void> {
    const group = this.groupCall;
    if (!group || peerId === this.host.getPeerId()) return;
    if (!group.participants.has(peerId)) return;
    if (
      group.mode === "mixer" &&
      !group.isMixer &&
      group.mixerPeerId !== peerId
    ) {
      return;
    }
    let conn: MediaConnection;
    try {
      conn = group.connectionTo(peerId);
    } catch {
      return;
    }
    const stream = this.groupLocalStream;
    if (stream && !this.groupLegHasLocalTracks.has(peerId)) {
      try {
        for (const track of stream.getTracks()) conn.addTrack(track, stream);
        this.groupLegHasLocalTracks.add(peerId);
      } catch {
        // The leg is unusable; the next join/offer retries.
        return;
      }
    }
    if (
      this.host.getPeerId() < peerId &&
      !this.groupOffersSent.has(peerId) &&
      !this.groupOffersReceived.has(peerId)
    ) {
      try {
        const offer = await conn.createOffer();
        await conn.setLocalDescription(offer);
        this.groupOffersSent.add(peerId);
        this.host.sendMediaControlTo(peerId, {
          t: "group-offer",
          groupId: group.groupId,
          fromPeerId: this.host.getPeerId(),
          fromAddress: this.host.selfAddress ?? "",
          sdp: offer,
        });
      } catch {
        // Offer failed — the peer's offer (if it comes) is answered.
      }
    }
  }

  private closeGroupLeg(peerId: string): void {
    const group = this.groupCall;
    const conn = this.groupConnections.get(peerId);
    if (conn) {
      try {
        conn.close();
      } catch {
        // Already closed.
      }
      this.groupConnections.delete(peerId);
    }
    // Drop GroupCall's cached connection so a later connectionTo
    // builds a fresh PC instead of reusing the closed one.
    const participant = group?.participants.get(peerId);
    if (participant) participant.connection = null;
    this.groupLegHasLocalTracks.delete(peerId);
    this.groupLegRemoteDescSet.delete(peerId);
    this.groupPendingIce.delete(peerId);
    this.groupOffersSent.delete(peerId);
    this.groupOffersReceived.delete(peerId);
    this.groupRemoteTracks.delete(peerId);
  }

  private async onGroupOffer(
    fromPeerId: string,
    message: Extract<MediaControlMessage, { t: "group-offer" }>,
  ): Promise<void> {
    const group = this.groupCall;
    if (!group || message.groupId !== group.groupId) return;
    // Glare guard: I already offered on this leg; the other side
    // answers mine. (The deterministic rule should prevent this,
    // but a late duplicate must never start a second negotiation.)
    if (this.groupOffersSent.has(fromPeerId)) return;
    this.groupOffersReceived.add(fromPeerId);
    if (!group.participants.has(fromPeerId)) {
      group.addParticipant(fromPeerId, message.fromAddress, false);
    }
    let conn: MediaConnection;
    try {
      conn = group.connectionTo(fromPeerId);
    } catch {
      return;
    }
    const stream = this.groupLocalStream;
    if (stream && !this.groupLegHasLocalTracks.has(fromPeerId)) {
      try {
        for (const track of stream.getTracks()) conn.addTrack(track, stream);
        this.groupLegHasLocalTracks.add(fromPeerId);
      } catch {
        return;
      }
    }
    try {
      await conn.setRemoteDescription(message.sdp);
    } catch {
      return;
    }
    this.groupLegRemoteDescSet.add(fromPeerId);
    this.flushGroupIce(fromPeerId);
    try {
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);
      this.host.sendMediaControlTo(fromPeerId, {
        t: "group-answer",
        groupId: group.groupId,
        fromPeerId: this.host.getPeerId(),
        sdp: answer,
      });
    } catch {
      // The offerer retries on the next join event.
    }
  }

  private async onGroupAnswer(
    fromPeerId: string,
    message: Extract<MediaControlMessage, { t: "group-answer" }>,
  ): Promise<void> {
    const group = this.groupCall;
    if (!group || message.groupId !== group.groupId) return;
    const conn = this.groupConnections.get(fromPeerId);
    if (!conn) return;
    try {
      await conn.setRemoteDescription(message.sdp);
    } catch {
      return;
    }
    this.groupLegRemoteDescSet.add(fromPeerId);
    this.flushGroupIce(fromPeerId);
  }

  private onGroupIce(
    fromPeerId: string,
    message: Extract<MediaControlMessage, { t: "group-ice" }>,
  ): void {
    const group = this.groupCall;
    if (!group || message.groupId !== group.groupId) return;
    if (this.groupLegRemoteDescSet.has(fromPeerId)) {
      const conn = this.groupConnections.get(fromPeerId);
      if (conn) void conn.addIceCandidate(message.candidate).catch(() => undefined);
      return;
    }
    // Candidates that arrive before the remote description are
    // buffered and flushed once it is set — never dropped, never
    // fed to a PC that cannot use them yet.
    const pending = this.groupPendingIce.get(fromPeerId) ?? [];
    pending.push(message.candidate);
    this.groupPendingIce.set(fromPeerId, pending);
  }

  private flushGroupIce(peerId: string): void {
    const pending = this.groupPendingIce.get(peerId);
    if (!pending || pending.length === 0) return;
    this.groupPendingIce.delete(peerId);
    const conn = this.groupConnections.get(peerId);
    if (!conn) return;
    for (const candidate of pending) {
      void conn.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private onUnhandledMedia(fromPeerId: string, message: MediaControlMessage): void {
    if (this.disposed) return;
    const group = this.groupCall;
    switch (message.t) {
      case "group-invite": {
        if (this.groupCall || this.activeSession || this.incomingSession) {
          this.host.sendMediaControlTo(fromPeerId, {
            t: "group-decline",
            groupId: message.groupId,
            fromPeerId: this.host.getPeerId(),
          });
          return;
        }
        if (!this.settings().media.groups) {
          this.host.sendMediaControlTo(fromPeerId, {
            t: "group-decline",
            groupId: message.groupId,
            fromPeerId: this.host.getPeerId(),
          });
          return;
        }
        this.groupInvite = {
          groupId: message.groupId,
          fromPeerId,
          fromAddress: message.fromAddress,
          volunteerMixer: message.volunteerMixer,
        };
        this.emit();
        return;
      }
      case "group-decline":
        // The invited peer said no (or is busy/off). They simply
        // never join; nothing to clean up.
        return;
      case "group-offer":
        void this.onGroupOffer(fromPeerId, message);
        return;
      case "group-answer":
        void this.onGroupAnswer(fromPeerId, message);
        return;
      case "group-ice":
        this.onGroupIce(fromPeerId, message);
        return;
      case "group-join":
      case "group-leave":
      case "mixer-announce":
      case "mixer-elect":
      case "mixer-ready":
      case "mixer-lost":
      case "no-volunteer": {
        if (!group || message.groupId !== group.groupId) return;
        const wasNew =
          message.t === "group-join" && !group.participants.has(message.peerId);
        group.handleControl(message);
        if (message.t !== "group-join" || !wasNew) return;
        if (group.isCoordinator) {
          // The coordinator relays a new member's join to the rest
          // of the group and tells the joiner who is already here,
          // so a member that only knows the coordinator still learns
          // the whole group.
          const joiner = message.peerId;
          for (const member of [...group.participants.values()]) {
            if (
              member.peerId === joiner ||
              member.peerId === this.host.getPeerId()
            ) {
              continue;
            }
            this.host.sendMediaControlTo(joiner, {
              t: "group-join",
              groupId: group.groupId,
              peerId: member.peerId,
              address: member.address,
              volunteerMixer: member.volunteerMixer,
              uplinkKbps: member.uplinkKbps,
              cpuHeadroom: member.cpuHeadroom,
            });
            this.host.sendMediaControlTo(member.peerId, message);
          }
          // A member that joins AFTER the election never saw
          // mixer-elect (the election broadcast went out on the
          // join that pushed the group past 5). Tell the joiner
          // who is mixing now, or it sits in mesh while the rest
          // of the group is mixer-routed.
          if (group.mode === "mixer" && group.mixerPeerId) {
            this.host.sendMediaControlTo(joiner, {
              t: "mixer-elect",
              groupId: group.groupId,
              mixerPeerId: group.mixerPeerId,
              electedBy: this.host.getPeerId(),
            });
          }
        } else {
          // Not the coordinator: forward the join to the
          // coordinator (longest-joined member) so it can relay.
          // The coordinator's relay is the only copy the group
          // sees, so there is no loop.
          const coordinator = [...group.participants.values()].sort(
            (a, b) =>
              a.joinedAt - b.joinedAt || (a.peerId < b.peerId ? -1 : 1),
          )[0];
          if (
            coordinator &&
            coordinator.peerId !== fromPeerId &&
            coordinator.peerId !== this.host.getPeerId()
          ) {
            this.host.sendMediaControlTo(coordinator.peerId, message);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private onGroupEvent(event: GroupEvent): void {
    if (this.disposed) return;
    const group = this.groupCall;
    if (!group) return;
    switch (event.type) {
      case "participant-joined":
        void this.openLeg(event.peerId);
        break;
      case "participant-left":
        this.closeGroupLeg(event.peerId);
        break;
      case "mode":
        if (event.mode === "mesh") {
          this.groupMixerLost = null;
          this.groupNoVolunteer = false;
          for (const peerId of [...group.participants.keys()]) {
            if (peerId !== this.host.getPeerId()) void this.openLeg(peerId);
          }
        } else if (!group.isMixer && group.mixerPeerId) {
          // Mixer mode: drop every leg except the one to the mixer.
          for (const peerId of [...group.participants.keys()]) {
            if (
              peerId !== this.host.getPeerId() &&
              peerId !== group.mixerPeerId
            ) {
              this.closeGroupLeg(peerId);
            }
          }
          void this.openLeg(group.mixerPeerId);
        }
        break;
      case "mixer-elected":
        this.groupNoVolunteer = false;
        if (!group.isMixer && event.mixerPeerId) {
          for (const peerId of [...group.participants.keys()]) {
            if (
              peerId !== this.host.getPeerId() &&
              peerId !== event.mixerPeerId
            ) {
              this.closeGroupLeg(peerId);
            }
          }
          void this.openLeg(event.mixerPeerId);
        } else if (group.isMixer) {
          for (const peerId of [...group.participants.keys()]) {
            if (peerId !== this.host.getPeerId()) void this.openLeg(peerId);
          }
        }
        break;
      case "mixer-lost":
        this.groupMixerLost = event.reason;
        break;
      case "no-volunteer":
        this.groupNoVolunteer = true;
        break;
      case "remote-track": {
        const entry = this.groupRemoteTracks.get(event.peerId) ?? {
          audio: null,
          video: null,
        };
        if (event.kind === "audio") entry.audio = event.track;
        else entry.video = event.track;
        this.groupRemoteTracks.set(event.peerId, entry);
        break;
      }
    }
    this.emit();
  }
}

// ---------------------------------------------------------------------------
// Renderer (pure) + mount (DOM). The renderer never touches the
// DOM; the mount re-renders on every controller change and
// re-attaches video/audio tracks after each render.
// ---------------------------------------------------------------------------

/** Pure HTML for the Calls panel from the view-model. */
export function renderCallsPanelHtml(vm: CallsViewModel): string {
  const parts: string[] = [];
  parts.push(`<h2>Calls</h2>`);
  parts.push(`<p>${esc(CALLS_PANEL_DESCRIPTION)}</p>`);
  if (!vm.available) {
    // A controller exists only where WebRTC exists (the panel
    // returns CALLS_NO_WEBRTC_COPY outright when there is no
    // controller), so "not available" here means one thing: no
    // CallManager, i.e. no P2P identity configured yet. Say that,
    // not "no WebRTC" — the browser has WebRTC; the user is a
    // guest. (Caught by the media-UI screenshot pass: headless
    // Chrome HAS WebRTC and still showed the no-WebRTC line.)
    parts.push(`<p class="calls-note">${esc(CALLS_NO_IDENTITY_COPY)}</p>`);
    return wrapCallsPanel(parts);
  }
  if (!vm.mediaOn) {
    parts.push(`<p class="calls-note">${esc(CALLS_OFF_COPY)}</p>`);
    return wrapCallsPanel(parts);
  }
  if (!vm.selfAddress) {
    parts.push(`<p class="calls-note">${esc(CALLS_NO_IDENTITY_COPY)}</p>`);
    return wrapCallsPanel(parts);
  }
  if (vm.lastError) {
    parts.push(`<p class="calls-error" role="alert">${esc(vm.lastError)}</p>`);
  }

  // Incoming 1:1 call — ringing.
  if (vm.incoming) {
    parts.push(`<section class="calls-incoming" aria-label="Incoming call">
      <p><strong>Incoming ${esc(vm.incoming.kind)} call</strong> from ${esc(vm.incoming.fromAddress)}</p>
      <p class="calls-note">Answering starts an encrypted P2P call — no server, no recording unless everyone consents.</p>
      <button type="button" data-action="accept-call">Answer</button>
      <button type="button" data-action="decline-call">Decline</button>
    </section>`);
  }

  // Group invite — ringing.
  if (vm.groupInvite) {
    parts.push(`<section class="calls-incoming" aria-label="Group call invite">
      <p><strong>Group call invite</strong> from ${esc(vm.groupInvite.fromAddress)}</p>
      <p class="calls-note">Joining connects you to the whole group over P2P. The group may elect a volunteer mixer past 5 people — the mixer is always named in the call view.</p>
      <button type="button" data-action="join-group">Join group call</button>
      <button type="button" data-action="decline-group">Decline</button>
    </section>`);
  }

  // Active 1:1 call.
  if (vm.active) {
    const a = vm.active;
    parts.push(`<section class="calls-active" aria-label="Active call">
      <p><strong>${esc(a.kind === "video" ? "Video call" : "Voice call")}</strong> with ${esc(a.peerAddress)} — ${esc(a.state)}</p>
      <div class="calls-videos">
        <div class="calls-video-tile">
          <video data-video="remote" autoplay playsinline ${a.hasRemoteVideo ? "" : ""}></video>
          <audio data-audio="remote" autoplay></audio>
          <p>${a.hasRemoteVideo ? "Remote video" : a.hasRemoteAudio ? "Remote audio only" : "Waiting for remote media…"}</p>
          ${a.remoteSharingScreen ? `<p>They are sharing their screen.</p>` : ""}
          ${a.remoteMuted ? `<p>They are muted.</p>` : ""}
          ${!a.remoteVideoOn && a.kind === "video" ? `<p>Their video is off.</p>` : ""}
        </div>
        <div class="calls-video-tile calls-local">
          <video data-video="local" autoplay playsinline muted></video>
          <p>Your preview${a.hasLocalVideo ? "" : " (camera off)"}</p>
        </div>
      </div>
      <div class="calls-controls">
        <button type="button" data-action="toggle-mute">${a.muted ? "Unmute" : "Mute"}</button>
        ${a.kind === "video" ? `<button type="button" data-action="toggle-video">${a.videoEnabled ? "Video off" : "Video on"}</button>
        <button type="button" data-action="switch-camera">Switch camera</button>` : ""}
        ${a.sharingScreen
          ? `<button type="button" data-action="stop-screen">Stop sharing</button>`
          : `<button type="button" data-action="start-screen" ${vm.screenShareSupported ? "" : "disabled"}>Share screen</button>`}
        ${!vm.screenShareSupported && vm.screenShareNote ? `<p class="calls-note">${esc(vm.screenShareNote)}</p>` : ""}
        ${a.hasRemoteVideo ? `<button type="button" data-action="pip">Picture-in-picture</button>` : ""}
        <button type="button" data-action="leave-call">Leave</button>
      </div>
      ${a.diagnostics ? `<p class="calls-diagnostics">Connection: ${esc(a.diagnostics)}</p>` : ""}
      ${a.relayed ? `<p class="calls-note">${esc(CALL_RELAYED_NOTE)}</p>` : ""}
      <div class="calls-recording">
        <p class="calls-note">${esc(CALLS_RECORDING_NOTE)}</p>
        <label><input type="checkbox" data-action="toggle-consent" ${a.myConsent ? "checked" : ""}> I consent to this call being recorded</label>
        <p>${a.remoteConsent ? "The other side has consented." : "The other side has not consented yet."}</p>
        ${a.recording || a.remoteRecording ? `<p class="calls-recording-on" role="alert">● Recording — this call is being recorded locally on a participant's device.</p>` : ""}
        ${a.recording
          ? `<button type="button" data-action="stop-recording">Stop recording</button>`
          : `<button type="button" data-action="start-recording" ${a.canRecord ? "" : "disabled"}>Record this call</button>`}
      </div>
      <p class="calls-note">Quality: ${esc(a.qualityMode)}. Calls have no GitHub fallback — if the connection drops, the call ends; re-dial when both sides are online again.</p>
    </section>`);
  }

  // Active group call.
  if (vm.group) {
    const g = vm.group;
    parts.push(`<section class="calls-group" aria-label="Group call">
      <p><strong>Group call</strong> — ${g.participants.length} participant${g.participants.length === 1 ? "" : "s"} — ${esc(g.mode)} mode</p>
      ${g.mode === "mixer" && g.mixerPeerId
        ? `<p class="calls-mixer" role="status">${esc(mixerRoutedNote(g.mixerPeerId))}</p>
           <p class="calls-note">${esc(CALLS_MIXER_TRUST_COPY)}</p>
           ${g.isMixer ? `<p class="calls-note">You are the mixer for this call. You forward everyone's media — the group can see that it is you, and anyone can leave at any time.</p>` : ""}`
        : `<p class="calls-note">Mesh mode — every participant connects directly to every other. Past 5 people the group elects a volunteer mixer instead.</p>`}
      ${g.noVolunteer ? `<p class="calls-note" role="status">${esc(CALLS_NO_VOLUNTEER_COPY)}</p>` : ""}
      ${g.mixerLost ? `<p class="calls-note" role="status">The mixer left (${esc(g.mixerLost)}). The group is re-electing or falling back to mesh.</p>` : ""}
      <div class="calls-tiles">
        <div class="calls-video-tile calls-local">
          <video data-video="local" autoplay playsinline muted></video>
          <p>Your preview</p>
        </div>
        ${g.participants
          .filter((p) => !p.isSelf)
          .map(
            (p) => `<div class="calls-video-tile">
            <video data-group-video="${esc(p.peerId)}" autoplay playsinline></video>
            <audio data-group-audio="${esc(p.peerId)}" autoplay></audio>
            <p>${esc(p.address)}${p.isMixer ? ` — <strong>mixer</strong>` : ""}${p.volunteer ? " (volunteers as mixer)" : ""}${p.hasVideo ? "" : " (no video yet)"}</p>
          </div>`,
          )
          .join("")}
      </div>
      <div class="calls-controls">
        <button type="button" data-action="leave-group">Leave group call</button>
      </div>
      ${renderGroupInviteRow(vm)}
    </section>`);
  }

  // Idle: start a call.
  if (!vm.active && !vm.group) {
    parts.push(`<section class="calls-start" aria-label="Start a call">
      <h3>Call a connected peer</h3>
      ${vm.peers.length === 0
        ? `<p class="calls-note">${esc(CALLS_NO_PEERS_COPY)}</p>`
        : `<ul class="calls-peers">
          ${vm.peers
            .map(
              (p) => `<li>
              <span>${esc(p.address)}</span>
              ${vm.voiceOn ? `<button type="button" data-action="call-voice" data-peer-id="${esc(p.peerId)}" data-address="${esc(p.address)}">Voice</button>` : ""}
              ${vm.videoOn ? `<button type="button" data-action="call-video" data-peer-id="${esc(p.peerId)}" data-address="${esc(p.address)}">Video</button>` : ""}
              ${vm.groupsOn ? `<label><input type="checkbox" name="group-peer" value="${esc(p.peerId)}"> Group</label>` : ""}
            </li>`,
            )
            .join("")}
        </ul>`}
      <div class="calls-by-address">
        <label>Call by address <input type="text" data-input="call-address" value="${esc(vm.callAddressDraft)}" placeholder="friend@computers.edu" autocomplete="off"></label>
        ${vm.voiceOn ? `<button type="button" data-action="call-address-voice">Voice</button>` : ""}
        ${vm.videoOn ? `<button type="button" data-action="call-address-video">Video</button>` : ""}
        <p class="calls-note">Calling by address connects first, then calls. An offline peer is unreachable — calls need both peers online at the same time, and there is no GitHub fallback for live calls.</p>
      </div>
      ${vm.groupsOn && vm.peers.length > 0
        ? `<div class="calls-group-start">
          <button type="button" data-action="start-group">Start group call with checked peers</button>
          <p class="calls-note" id="calls-group-hint">Tick the Group box next to one or more peers, then start. Mesh up to 5 people; past that the group elects a volunteer mixer.</p>
        </div>`
        : ""}
    </section>`);
  }

  return wrapCallsPanel(parts);
}

function renderGroupInviteRow(vm: CallsViewModel): string {
  const inGroup = new Set(vm.group?.participants.map((p) => p.peerId) ?? []);
  const others = vm.peers.filter((p) => !inGroup.has(p.peerId));
  if (others.length === 0) return "";
  return `<div class="calls-invite-more">
    <h3>Invite more</h3>
    <ul>${others
      .map(
        (p) => `<li><span>${esc(p.address)}</span>
        <button type="button" data-action="invite-peer" data-peer-id="${esc(p.peerId)}">Invite</button></li>`,
      )
      .join("")}</ul>
  </div>`;
}

function wrapCallsPanel(parts: string[]): string {
  return `<section class="calls-panel">${parts.join("\n")}</section>`;
}

/** Attach one media track to a <video>/<audio> element (real
 *  browser tracks only — fake tracks in tests have no realTrack
 *  and the element is left empty, never faked). */
function attachTrack(
  el: HTMLMediaElement,
  track: MediaTrackLike | null,
): void {
  const real = track?.realTrack ?? null;
  if (!real || typeof MediaStream === "undefined") return;
  try {
    el.srcObject = new MediaStream([real]);
    // play() exists on real media elements; the fake DOM in Node
    // tests has none, and a missing play must not throw.
    if (typeof el.play === "function") void el.play().catch(() => undefined);
  } catch {
    // Leave the tile empty rather than crashing the panel.
  }
}

/** Tag-name check instead of instanceof: the mount also runs in
 *  Node tests against a fake DOM that has no HTML* constructors. */
function isTag(el: unknown, tag: string): el is HTMLMediaElement {
  return (
    typeof el === "object" &&
    el !== null &&
    (el as { tagName?: unknown }).tagName === tag
  );
}

/** Mount the Calls panel into a container. Re-renders on every
 *  controller change and re-attaches tracks after each render.
 *  Returns a teardown (stops re-rendering; does not end calls). */
export function mountCallsPanel(
  root: HTMLElement,
  controller: MediaCallController,
): () => void {
  let disposed = false;

  const render = (): void => {
    if (disposed) return;
    const vm = controller.viewModel();
    root.innerHTML = renderCallsPanelHtml(vm);
    bind(root);
    attachAll(root);
    // The nav button reads "Calls • ringing" while a 1:1 call or a
    // group invite is ringing — the only incoming-call signal the
    // nav has. It only updates while this panel is mounted: a call
    // that arrives while another panel is showing has no global
    // ringer yet (known gap — INTEGRATION.md). Guarded for tests,
    // where there is no document.
    if (typeof document !== "undefined") {
      const navBtn = document.querySelector('button[data-panel="calls"]');
      if (navBtn) {
        navBtn.textContent =
          vm.incoming || vm.groupInvite ? "Calls • ringing" : "Calls";
      }
    }
  };

  const attachAll = (scope: HTMLElement): void => {
    const remote = scope.querySelector('[data-video="remote"]');
    if (isTag(remote, "VIDEO")) attachTrack(remote, controller.remoteVideo);
    const remoteAudio = scope.querySelector('[data-audio="remote"]');
    if (isTag(remoteAudio, "AUDIO")) attachTrack(remoteAudio, controller.remoteAudio);
    const local = scope.querySelector('[data-video="local"]');
    if (isTag(local, "VIDEO")) attachTrack(local, controller.localVideoTrack());
    for (const el of scope.querySelectorAll("[data-group-video]")) {
      if (!isTag(el, "VIDEO")) continue;
      const peerId = el.getAttribute("data-group-video") ?? "";
      attachTrack(el, controller.groupVideoTrack(peerId));
    }
    for (const el of scope.querySelectorAll("[data-group-audio]")) {
      if (!isTag(el, "AUDIO")) continue;
      const peerId = el.getAttribute("data-group-audio") ?? "";
      attachTrack(el, controller.groupAudioTrack(peerId));
    }
  };

  const bind = (scope: HTMLElement): void => {
    const addressInput = scope.querySelector('[data-input="call-address"]');
    if (isTag(addressInput, "INPUT")) {
      addressInput.addEventListener("input", () => {
        controller.callAddressDraft = (addressInput as unknown as HTMLInputElement).value;
      });
    }
    const consent = scope.querySelector('[data-action="toggle-consent"]');
    if (isTag(consent, "INPUT")) {
      consent.addEventListener("change", () => controller.toggleRecordingConsent());
    }
    for (const el of scope.querySelectorAll("[data-action]")) {
      if (typeof el !== "object" || el === null) continue;
      const tag = (el as { tagName?: unknown }).tagName;
      if (typeof tag !== "string") continue;
      if (tag === "INPUT" && el.getAttribute("data-action") === "toggle-consent") continue;
      el.addEventListener("click", () => void onAction(el as HTMLElement));
    }
  };

  const onAction = async (el: HTMLElement): Promise<void> => {
    const action = el.getAttribute("data-action") ?? "";
    const peerId = el.getAttribute("data-peer-id") ?? "";
    const address = el.getAttribute("data-address") ?? "";
    switch (action) {
      case "accept-call":
        await controller.acceptIncoming();
        return;
      case "decline-call":
        controller.declineIncoming();
        return;
      case "join-group":
        await controller.joinGroupCall();
        return;
      case "decline-group":
        controller.declineGroupInvite();
        return;
      case "leave-call":
        controller.endCall();
        return;
      case "leave-group":
        controller.leaveGroupCall();
        return;
      case "toggle-mute":
        controller.toggleMute();
        return;
      case "toggle-video":
        controller.toggleVideo();
        return;
      case "switch-camera":
        await controller.switchCamera();
        return;
      case "start-screen":
        await controller.startScreenShare();
        return;
      case "stop-screen":
        await controller.stopScreenShare();
        return;
      case "pip": {
        const video = root.querySelector('[data-video="remote"]');
        if (
          isTag(video, "VIDEO") &&
          typeof (video as HTMLVideoElement).requestPictureInPicture === "function"
        ) {
          try {
            await (video as HTMLVideoElement).requestPictureInPicture();
          } catch {
            // PiP denied — the call continues in the panel.
          }
        }
        return;
      }
      case "toggle-consent":
        // Handled by the change listener above.
        return;
      case "start-recording":
        controller.startRecording();
        return;
      case "stop-recording":
        controller.stopRecording();
        return;
      case "call-voice":
        await controller.startCall(peerId, address, "voice");
        return;
      case "call-video":
        await controller.startCall(peerId, address, "video");
        return;
      case "call-address-voice":
        await controller.callAddress(controller.callAddressDraft, "voice");
        return;
      case "call-address-video":
        await controller.callAddress(controller.callAddressDraft, "video");
        return;
      case "start-group": {
        const checked = [...root.querySelectorAll('input[name="group-peer"]:checked')].map(
          (input) => (input as HTMLInputElement).value,
        );
        const hint = root.querySelector("#calls-group-hint");
        if (checked.length === 0) {
          if (hint) hint.textContent = "Tick the Group box next to at least one peer first.";
          return;
        }
        await controller.startGroupCall(checked);
        return;
      }
      case "invite-peer":
        controller.invitePeerToGroup(peerId);
        return;
      default:
        return;
    }
  };

  controller.setOnChange(render);
  void controller.refreshPeers().catch(() => undefined);
  render();
  return () => {
    disposed = true;
    controller.setOnChange(null);
  };
}
