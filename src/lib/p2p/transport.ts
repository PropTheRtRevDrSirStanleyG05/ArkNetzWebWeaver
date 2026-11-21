// ArkNetzWebWeaver — P2P transport: connection interface, WebRTC
// adapter, and the in-memory loopback pair for tests.
//
// Node has no WebRTC (verified on Node v24.22.1: RTCPeerConnection is
// undefined, and --experimental-webrtc is not a valid flag), so every
// test in this repo runs against the loopback transport, and the
// WebRTC adapter is exercised by the handshake state machine running
// against the same interface — plus manual verification on a real
// device in phase 2. The WebRTC adapter is constructed only in the
// browser; constructing it in Node throws a plain error.

import { describeIcePath, loopbackDiagnostics, type IceDiagnostics } from "./ice.js";

/** One data channel. `send` throws when the channel is not open. */
export interface P2PChannel {
  readonly label: string;
  send(data: Uint8Array): void;
  onmessage: ((data: Uint8Array) => void) | null;
  onclose: (() => void) | null;
  readonly readyState: "connecting" | "open" | "closed";
  close(): void;
}

/** Connection states. `failed` is terminal (handshake or ICE
 *  failure) — the peer manager falls back to GitHub. */
export type P2PConnectionState = "new" | "connecting" | "connected" | "closed" | "failed";

export interface P2PConnection {
  readonly peerId: string;
  readonly state: P2PConnectionState;
  onstatechange: ((state: P2PConnectionState) => void) | null;
  /** Incoming channel (created by the remote peer). */
  onchannel: ((channel: P2PChannel) => void) | null;
  /** A remote ICE candidate arrived (fired by the peer manager via
   *  addIceCandidate — the factory itself never sees signaling). */
  onLocalCandidate: ((candidate: RTCIceCandidateInit | null) => void) | null;
  createChannel(label: string): P2PChannel;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  /** Which ICE path this connection actually used (P2P-SPEC.md §7
   *  diagnostics — host / srflx / relay + which server). */
  diagnostics(): Promise<IceDiagnostics>;
  close(): void;
}

export interface P2PConnectionFactory {
  createConnection(peerId: string, config: RTCConfiguration): P2PConnection;
}

// ---------------------------------------------------------------------------
// Loopback transport (tests only): two connections wired together in
// memory, same ordering and close semantics as a real channel.
// ---------------------------------------------------------------------------

class LoopbackChannel implements P2PChannel {
  readonly label: string;
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState: "connecting" | "open" | "closed" = "connecting";
  /** The channel on the other connection. */
  twin: LoopbackChannel | null = null;

  constructor(label: string) {
    this.label = label;
  }

  open(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
  }

  send(data: Uint8Array): void {
    if (this.readyState !== "open") {
      throw new Error(`cannot send on ${this.label}: channel is ${this.readyState}`);
    }
    const twin = this.twin;
    if (!twin || twin.readyState !== "open") {
      throw new Error(`cannot send on ${this.label}: remote channel is not open`);
    }
    const copy = data.slice();
    queueMicrotask(() => {
      if (twin.readyState === "open") twin.onmessage?.(copy);
    });
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    queueMicrotask(() => this.onclose?.());
    const twin = this.twin;
    if (twin && twin.readyState !== "closed") {
      twin.readyState = "closed";
      queueMicrotask(() => twin.onclose?.());
    }
  }
}

export class LoopbackConnection implements P2PConnection {
  readonly peerId: string;
  state: P2PConnectionState = "new";
  onstatechange: ((state: P2PConnectionState) => void) | null = null;
  onchannel: ((channel: P2PChannel) => void) | null = null;
  onLocalCandidate: ((candidate: RTCIceCandidateInit | null) => void) | null = null;
  private readonly channels = new Map<string, LoopbackChannel>();
  /** The paired connection (set by the factory). */
  twin: LoopbackConnection | null = null;

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  private setState(state: P2PConnectionState): void {
    this.state = state;
    this.onstatechange?.(state);
  }

  createChannel(label: string): P2PChannel {
    const existing = this.channels.get(label);
    if (existing) return existing;
    const channel = new LoopbackChannel(label);
    this.channels.set(label, channel);
    const twin = this.twin;
    if (twin) {
      const twinChannel = new LoopbackChannel(label);
      twin.channels.set(label, twinChannel);
      channel.twin = twinChannel;
      twinChannel.twin = channel;
      queueMicrotask(() => {
        channel.open();
        twinChannel.open();
        twin.onchannel?.(twinChannel);
      });
    } else {
      queueMicrotask(() => channel.open());
    }
    return channel;
  }

  /** Called by the factory when this connection is paired: open any
   *  channels the twin already created, and vice versa. */
  pairWith(twin: LoopbackConnection): void {
    this.twin = twin;
    for (const [label, channel] of this.channels) {
      if (!twin.channels.has(label)) {
        const twinChannel = new LoopbackChannel(label);
        twin.channels.set(label, twinChannel);
        channel.twin = twinChannel;
        twinChannel.twin = channel;
        queueMicrotask(() => {
          channel.open();
          twinChannel.open();
          twin.onchannel?.(twinChannel);
        });
      }
    }
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "loopback-offer" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "loopback-answer" };
  }

  async setLocalDescription(_desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.state === "new") this.setState("connecting");
    // End of (fake) gathering: no candidates on loopback.
    queueMicrotask(() => this.onLocalCandidate?.(null));
  }

  async setRemoteDescription(_desc: RTCSessionDescriptionInit): Promise<void> {
    if (this.state === "new") this.setState("connecting");
    // Both sides described: the pair is connected once both have set
    // a remote description. The factory pairs eagerly, so mark
    // connected here — the peer manager's hello exchange is the real
    // readiness gate, not this flag.
    this.setState("connected");
  }

  async addIceCandidate(_candidate: RTCIceCandidateInit): Promise<void> {
    // No candidates on loopback.
  }

  async diagnostics(): Promise<IceDiagnostics> {
    return loopbackDiagnostics();
  }

  close(): void {
    if (this.state === "closed") return;
    this.setState("closed");
    for (const channel of this.channels.values()) channel.close();
  }
}

/** Test factory: `createPair` wires two connections together so
 *  their channels deliver to each other. `createConnection` alone
 *  makes an unpaired connection (useful for timeout tests). */
export class LoopbackConnectionFactory implements P2PConnectionFactory {
  createConnection(peerId: string, _config: RTCConfiguration): P2PConnection {
    return new LoopbackConnection(peerId);
  }

  createPair(peerIdA: string, peerIdB: string): [LoopbackConnection, LoopbackConnection] {
    const a = new LoopbackConnection(peerIdA);
    const b = new LoopbackConnection(peerIdB);
    a.pairWith(b);
    b.pairWith(a);
    return [a, b];
  }
}

// ---------------------------------------------------------------------------
// WebRTC adapter (browser only).
// ---------------------------------------------------------------------------

class WebRtcChannel implements P2PChannel {
  readonly label: string;
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly dc: RTCDataChannel;

  constructor(dc: RTCDataChannel) {
    this.label = dc.label;
    this.dc = dc;
    this.dc.binaryType = "arraybuffer";
    this.dc.onmessage = (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        this.onmessage?.(new Uint8Array(data));
      } else if (typeof data === "string") {
        this.onmessage?.(new TextEncoder().encode(data));
      }
    };
    this.dc.onclose = () => this.onclose?.();
  }

  get readyState(): "connecting" | "open" | "closed" {
    if (this.dc.readyState === "open") return "open";
    if (this.dc.readyState === "closed" || this.dc.readyState === "closing") return "closed";
    return "connecting";
  }

  send(data: Uint8Array): void {
    if (this.dc.readyState !== "open") {
      throw new Error(`cannot send on ${this.label}: data channel is ${this.dc.readyState}`);
    }
    // Copy into a fresh ArrayBuffer-backed view: lib.dom's send()
    // wants ArrayBufferView<ArrayBuffer>, and a Uint8Array over a
    // SharedArrayBuffer would not qualify. The copy costs nothing
    // the channel was not going to copy anyway.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.dc.send(copy);
  }

  close(): void {
    this.dc.close();
  }
}

export class WebRtcConnection implements P2PConnection {
  readonly peerId: string;
  state: P2PConnectionState = "new";
  onstatechange: ((state: P2PConnectionState) => void) | null = null;
  onchannel: ((channel: P2PChannel) => void) | null = null;
  onLocalCandidate: ((candidate: RTCIceCandidateInit | null) => void) | null = null;
  private readonly pc: RTCPeerConnection;
  private readonly channels = new Map<string, WebRtcChannel>();

  constructor(peerId: string, config: RTCConfiguration) {
    this.peerId = peerId;
    this.pc = new RTCPeerConnection(config);
    this.pc.onicecandidate = (ev) => {
      this.onLocalCandidate?.(ev.candidate ? ev.candidate.toJSON() : null);
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "connected") this.setState("connected");
      else if (s === "failed") this.setState("failed");
      else if (s === "closed") this.setState("closed");
      else if (s === "connecting") this.setState("connecting");
    };
    this.pc.ondatachannel = (ev) => {
      const channel = new WebRtcChannel(ev.channel);
      this.channels.set(ev.channel.label, channel);
      this.onchannel?.(channel);
    };
  }

  private setState(state: P2PConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.(state);
  }

  createChannel(label: string): P2PChannel {
    const existing = this.channels.get(label);
    if (existing) return existing;
    const dc = this.pc.createDataChannel(label, { ordered: true });
    const channel = new WebRtcChannel(dc);
    this.channels.set(label, channel);
    return channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    return offer;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const answer = await this.pc.createAnswer();
    return answer;
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

  /** Which ICE path succeeded, from the selected candidate pair in
   *  getStats(). Falls back to "unknown" when no pair is reported —
   *  a connection can be up before stats settle. */
  async diagnostics(): Promise<IceDiagnostics> {
    try {
      const stats = await this.pc.getStats();
      let localType: string | undefined;
      let remoteType: string | undefined;
      let relayUrl: string | undefined;
      let selectedPair: {
        localCandidateId?: string;
        remoteCandidateId?: string;
      } | null = null;
      const candidates = new Map<string, { candidateType?: string; url?: string }>();
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && (report as { state?: string }).state === "succeeded") {
          selectedPair = report as { localCandidateId?: string; remoteCandidateId?: string };
        }
        if (report.type === "local-candidate" || report.type === "remote-candidate") {
          candidates.set(report.id, report as { candidateType?: string; url?: string });
        }
      });
      if (selectedPair) {
        const pair = selectedPair as { localCandidateId?: string; remoteCandidateId?: string };
        const local = pair.localCandidateId ? candidates.get(pair.localCandidateId) : undefined;
        const remote = pair.remoteCandidateId ? candidates.get(pair.remoteCandidateId) : undefined;
        localType = local?.candidateType;
        remoteType = remote?.candidateType;
        if (local?.candidateType === "relay" && typeof local.url === "string") {
          relayUrl = local.url;
        }
      }
      return describeIcePath({ localCandidateType: localType, remoteCandidateType: remoteType, relayUrl });
    } catch {
      return describeIcePath({});
    }
  }

  close(): void {
    this.pc.close();
    this.setState("closed");
  }
}

export class WebRtcConnectionFactory implements P2PConnectionFactory {
  createConnection(peerId: string, config: RTCConfiguration): P2PConnection {
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error(
        "WebRTC is not available in this environment (RTCPeerConnection is undefined) — P2P cannot connect here. This device's WebView may not support WebRTC; the GitHub path still works.",
      );
    }
    return new WebRtcConnection(peerId, config);
  }
}
