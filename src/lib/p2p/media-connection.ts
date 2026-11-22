// ArkNetzWebWeaver — Media connection: a track-based RTCPeerConnection
// wrapper for calls. The media analogue of P2PConnection (transport.ts),
// but for media tracks instead of data channels. A call uses its own
// RTCPeerConnection — separate from the data connection's PC, which
// exposes no track API — and its SDP/ICE are exchanged over the data
// channel (call-session.ts), which is already DTLS-encrypted.
//
// Node has no RTCPeerConnection and no MediaStream, so every test runs
// against the fake pair below; the real adapter is exercised by
// type-checking plus the call state machine running against the same
// interface — exactly as phase 1 did for data.

import type { MediaStreamLike, MediaTrackLike } from "./media-devices.js";

/** A stats report, read-only. The real RTCStatsReport satisfies this
 *  shape (forEach over entries); the fake returns injected entries. */
export interface MediaStatsReport {
  forEach(cb: (entry: MediaStatsEntry) => void): void;
}

export interface MediaStatsEntry {
  type: string;
  id: string;
  [key: string]: unknown;
}

/** A sender for one outgoing track. */
export interface MediaSenderLike {
  readonly track: MediaTrackLike | null;
  replaceTrack(track: MediaTrackLike | null): Promise<void>;
}

/** One media peer connection (one call leg). */
export interface MediaConnection {
  readonly peerId: string;
  readonly state: "new" | "connecting" | "connected" | "closed" | "failed";
  onstatechange: ((state: MediaConnection["state"]) => void) | null;
  /** A remote track arrived (audio, video, or screen). */
  ontrack: ((event: { track: MediaTrackLike; streams: MediaStreamLike[] }) => void) | null;
  /** A local ICE candidate was gathered (null = end of gathering). */
  onicecandidate: ((candidate: RTCIceCandidateInit | null) => void) | null;
  addTrack(track: MediaTrackLike, stream: MediaStreamLike): MediaSenderLike;
  removeTrack(sender: MediaSenderLike): void;
  getSenders(): MediaSenderLike[];
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  getStats(): Promise<MediaStatsReport>;
  close(): void;
}

export interface MediaConnectionFactory {
  createConnection(peerId: string, config: RTCConfiguration): MediaConnection;
}

// ---------------------------------------------------------------------------
// Real adapter (browser only).
// ---------------------------------------------------------------------------

class RealMediaSender implements MediaSenderLike {
  private readonly sender: RTCRtpSender;
  private current: MediaTrackLike | null;
  constructor(sender: RTCRtpSender, track: MediaTrackLike) {
    this.sender = sender;
    this.current = track;
  }
  get track(): MediaTrackLike | null {
    return this.current;
  }
  async replaceTrack(track: MediaTrackLike | null): Promise<void> {
    await this.sender.replaceTrack(track?.realTrack ?? null);
    this.current = track;
  }
}

export class WebRtcMediaConnection implements MediaConnection {
  readonly peerId: string;
  state: MediaConnection["state"] = "new";
  onstatechange: ((state: MediaConnection["state"]) => void) | null = null;
  ontrack: ((event: { track: MediaTrackLike; streams: MediaStreamLike[] }) => void) | null = null;
  onicecandidate: ((candidate: RTCIceCandidateInit | null) => void) | null = null;
  private readonly pc: RTCPeerConnection;
  private readonly senders = new Map<RTCRtpSender, RealMediaSender>();

  constructor(peerId: string, config: RTCConfiguration) {
    this.peerId = peerId;
    this.pc = new RTCPeerConnection(config);
    this.pc.onicecandidate = (ev) => {
      this.onicecandidate?.(ev.candidate ? ev.candidate.toJSON() : null);
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "connected") this.setState("connected");
      else if (s === "failed") this.setState("failed");
      else if (s === "closed") this.setState("closed");
      else if (s === "connecting") this.setState("connecting");
    };
    this.pc.ontrack = (ev) => {
      // Wrap the real track/stream in the structural interfaces.
      // The stream wrapper is built from the real stream's tracks.
      const track = ev.track;
      const trackLike: MediaTrackLike = {
        id: track.id,
        kind: track.kind === "video" ? "video" : "audio",
        get enabled() {
          return track.enabled;
        },
        set enabled(v: boolean) {
          track.enabled = v;
        },
        stop() {
          track.stop();
        },
        realTrack: track,
      };
      const streams: MediaStreamLike[] = ev.streams.map((s) => ({
        id: s.id,
        getTracks: () =>
          s.getTracks().map((t) => (t === track ? trackLike : wrapRealTrack(t))),
        getAudioTracks: () => s.getAudioTracks().map((t) => wrapRealTrack(t)),
        getVideoTracks: () => s.getVideoTracks().map((t) => wrapRealTrack(t)),
        addTrack: (t: MediaTrackLike) => {
          if (t.realTrack) s.addTrack(t.realTrack);
        },
        removeTrack: (t: MediaTrackLike) => {
          if (t.realTrack) s.removeTrack(t.realTrack);
        },
      }));
      this.ontrack?.({ track: trackLike, streams });
    };
  }

  private setState(state: MediaConnection["state"]): void {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.(state);
  }

  addTrack(track: MediaTrackLike, stream: MediaStreamLike): MediaSenderLike {
    if (!track.realTrack) {
      throw new Error("addTrack: track is not a real browser track");
    }
    // Find the real stream backing this stream-like: the caller
    // passes the stream the track came from; the real track is what
    // the PC needs. The stream argument is kept for the interface
    // only — RTCPeerConnection.addTrack takes (track, ...streams)
    // and we pass none, which is valid: the track is sent without
    // an associated stream id.
    const sender = this.pc.addTrack(track.realTrack);
    // Prefer low latency over resolution when bandwidth falls.
    try {
      const params = sender.getParameters();
      void sender.setParameters({ ...params, degradationPreference: "maintain-framerate" }).catch(() => undefined);
    } catch {
      // Not fatal — the track still sends.
    }
    void stream;
    const wrapped = new RealMediaSender(sender, track);
    this.senders.set(sender, wrapped);
    return wrapped;
  }

  removeTrack(sender: MediaSenderLike): void {
    for (const [real, wrapped] of this.senders) {
      if (wrapped === sender) {
        this.pc.removeTrack(real);
        this.senders.delete(real);
        return;
      }
    }
  }

  getSenders(): MediaSenderLike[] {
    return [...this.senders.values()];
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return this.pc.createOffer();
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return this.pc.createAnswer();
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.state === "new") this.setState("connecting");
    await this.pc.setLocalDescription(desc);
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(desc);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  async getStats(): Promise<MediaStatsReport> {
    const report = await this.pc.getStats();
    return {
      forEach(cb: (entry: MediaStatsEntry) => void): void {
        report.forEach((value: unknown) => {
          const v = value as MediaStatsEntry;
          cb(v);
        });
      },
    };
  }

  close(): void {
    this.pc.close();
    this.setState("closed");
  }
}

function wrapRealTrack(track: MediaStreamTrack): MediaTrackLike {
  return {
    id: track.id,
    kind: track.kind === "video" ? "video" : "audio",
    get enabled() {
      return track.enabled;
    },
    set enabled(v: boolean) {
      track.enabled = v;
    },
    stop() {
      track.stop();
    },
    realTrack: track,
  };
}

export class WebRtcMediaConnectionFactory implements MediaConnectionFactory {
  createConnection(peerId: string, config: RTCConfiguration): MediaConnection {
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error(
        "WebRTC is not available in this environment (RTCPeerConnection is undefined) — calls cannot connect here. " +
          "This device's WebView may not support WebRTC; the GitHub paths still work.",
      );
    }
    return new WebRtcMediaConnection(peerId, config);
  }
}

// ---------------------------------------------------------------------------
// Fake (tests only): paired connections in memory.
// ---------------------------------------------------------------------------

class FakeMediaSender implements MediaSenderLike {
  track: MediaTrackLike | null;
  readonly stream: MediaStreamLike;
  constructor(track: MediaTrackLike, stream: MediaStreamLike) {
    this.track = track;
    this.stream = stream;
  }
  async replaceTrack(track: MediaTrackLike | null): Promise<void> {
    const old = this.track;
    this.track = track;
    // Tell the twin side the track changed: the fake connection
    // routes this through its twin's track-replaced hook.
    this.onReplace?.(old, track);
  }
  /** Set by the owning fake connection. */
  onReplace: ((oldTrack: MediaTrackLike | null, newTrack: MediaTrackLike | null) => void) | null = null;
}

export class FakeMediaConnection implements MediaConnection {
  readonly peerId: string;
  state: MediaConnection["state"] = "new";
  onstatechange: ((state: MediaConnection["state"]) => void) | null = null;
  ontrack: ((event: { track: MediaTrackLike; streams: MediaStreamLike[] }) => void) | null = null;
  onicecandidate: ((candidate: RTCIceCandidateInit | null) => void) | null = null;
  /** The paired connection (set by the factory). */
  twin: FakeMediaConnection | null = null;
  /** Stats the next getStats() returns (tests inject these). */
  fakeStats: MediaStatsReport | null = null;
  private readonly senders: FakeMediaSender[] = [];
  /** Tracks this side received, for assertions. */
  readonly receivedTracks: MediaTrackLike[] = [];

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  private setState(state: MediaConnection["state"]): void {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.(state);
  }

  addTrack(track: MediaTrackLike, stream: MediaStreamLike): MediaSenderLike {
    const sender = new FakeMediaSender(track, stream);
    this.senders.push(sender);
    sender.onReplace = (_old, newTrack) => {
      // Replacing a track delivers the new track to the twin and
      // retires the old one from the twin's received list.
      const twin = this.twin;
      if (!twin) return;
      if (_old) {
        const i = twin.receivedTracks.indexOf(_old);
        if (i >= 0) twin.receivedTracks.splice(i, 1);
      }
      if (newTrack) {
        twin.receivedTracks.push(newTrack);
        queueMicrotask(() => {
          twin.ontrack?.({ track: newTrack, streams: [stream] });
        });
      }
    };
    this.deliverToTwin(sender);
    return sender;
  }

  /** Deliver one sender's track to the twin (when paired). */
  private deliverToTwin(sender: FakeMediaSender): void {
    const twin = this.twin;
    if (!twin || !sender.track) return;
    const track = sender.track;
    if (twin.receivedTracks.includes(track)) return;
    twin.receivedTracks.push(track);
    queueMicrotask(() => {
      twin.ontrack?.({ track, streams: [sender.stream] });
    });
  }

  /** Pair this connection with its twin. Tracks added before
   *  pairing are delivered now, both directions — a call adds its
   *  local tracks before the remote side has created its media
   *  connection, so pairing must not lose them. */
  pairWith(twin: FakeMediaConnection): void {
    this.twin = twin;
    twin.twin = this;
    for (const sender of this.senders) this.deliverToTwin(sender);
    for (const sender of twin.senders) twin.deliverToTwin(sender);
  }

  removeTrack(sender: MediaSenderLike): void {
    const i = this.senders.indexOf(sender as FakeMediaSender);
    if (i < 0) return;
    const [removed] = this.senders.splice(i, 1);
    const twin = this.twin;
    if (twin && removed?.track) {
      const j = twin.receivedTracks.indexOf(removed.track);
      if (j >= 0) twin.receivedTracks.splice(j, 1);
    }
  }

  getSenders(): MediaSenderLike[] {
    return [...this.senders];
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: `fake-offer-${this.peerId}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `fake-answer-${this.peerId}` };
  }

  async setLocalDescription(_desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.state === "new") this.setState("connecting");
    queueMicrotask(() => this.onicecandidate?.(null));
  }

  async setRemoteDescription(_desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.state === "new") this.setState("connecting");
    // Both sides described: connected. The call session's
    // connect-timeout is the real readiness gate, not this flag.
    this.setState("connected");
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {
    // No candidates on the fake.
  }

  async getStats(): Promise<MediaStatsReport> {
    if (this.fakeStats) return this.fakeStats;
    return {
      forEach(_cb: (entry: MediaStatsEntry) => void): void {
        // No entries: the quality monitor reports "unknown" and
        // never degrades on a guess.
      },
    };
  }

  close(): void {
    if (this.state === "closed") return;
    this.setState("closed");
    for (const sender of [...this.senders]) {
      this.removeTrack(sender);
    }
  }
}

export class FakeMediaConnectionFactory implements MediaConnectionFactory {
  createConnection(peerId: string, _config: RTCConfiguration): MediaConnection {
    return new FakeMediaConnection(peerId);
  }

  createPair(peerIdA: string, peerIdB: string): [FakeMediaConnection, FakeMediaConnection] {
    const a = new FakeMediaConnection(peerIdA);
    const b = new FakeMediaConnection(peerIdB);
    a.pairWith(b);
    return [a, b];
  }
}

// ---------------------------------------------------------------------------
// Stats summarisation (pure — fully testable without WebRTC).
// ---------------------------------------------------------------------------

export interface MediaStatsSummary {
  /** Estimated available outgoing bitrate, kbps (undefined = unknown). */
  outgoingKbps?: number;
  /** Round-trip time, ms (undefined = unknown). */
  rttMs?: number;
  /** Inbound packet-loss fraction 0..1 (undefined = unknown). */
  lossFraction?: number;
  /** Local candidate type of the selected pair. */
  localCandidateType?: string;
  /** Remote candidate type of the selected pair. */
  remoteCandidateType?: string;
  /** Relay URL when the local candidate is type "relay". */
  relayUrl?: string;
}

/** Read a getStats() report into the numbers the quality monitor
 *  needs. Prefers the candidate-pair's availableOutgoingBitrate;
 *  falls back to nothing (unknown) rather than guessing from
 *  bytesSent deltas without a previous sample. Unknown fields stay
 *  undefined — the monitor never degrades on a guess. */
export function summarizeMediaStats(report: MediaStatsReport): MediaStatsSummary {
  const out: MediaStatsSummary = {};
  const candidates = new Map<string, MediaStatsEntry>();
  let selectedPair: MediaStatsEntry | null = null;
  let inboundLost: number | undefined;
  let inboundReceived: number | undefined;
  report.forEach((entry) => {
    if (entry.type === "candidate-pair" && entry.state === "succeeded") {
      selectedPair = entry;
    }
    if (entry.type === "local-candidate" || entry.type === "remote-candidate") {
      candidates.set(entry.id, entry);
    }
    if (entry.type === "inbound-rtp") {
      if (typeof entry.packetsLost === "number") inboundLost = entry.packetsLost;
      if (typeof entry.packetsReceived === "number") inboundReceived = entry.packetsReceived;
    }
  });
  if (selectedPair) {
    const pair = selectedPair as MediaStatsEntry;
    if (typeof pair.availableOutgoingBitrate === "number") {
      out.outgoingKbps = pair.availableOutgoingBitrate / 1000;
    }
    if (typeof pair.currentRoundTripTime === "number") {
      out.rttMs = pair.currentRoundTripTime * 1000;
    }
    const local = typeof pair.localCandidateId === "string" ? candidates.get(pair.localCandidateId) : undefined;
    const remote = typeof pair.remoteCandidateId === "string" ? candidates.get(pair.remoteCandidateId) : undefined;
    if (local && typeof local.candidateType === "string") {
      out.localCandidateType = local.candidateType;
      if (local.candidateType === "relay" && typeof local.url === "string") {
        out.relayUrl = local.url;
      }
    }
    if (remote && typeof remote.candidateType === "string") {
      out.remoteCandidateType = remote.candidateType;
    }
  }
  if (
    inboundLost !== undefined &&
    inboundReceived !== undefined &&
    inboundReceived + inboundLost > 0
  ) {
    out.lossFraction = inboundLost / (inboundReceived + inboundLost);
  }
  return out;
}
