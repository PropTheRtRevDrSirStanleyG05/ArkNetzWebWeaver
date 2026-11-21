// ArkNetzWebWeaver — P2P peer manager: settings, known peers, and
// the offer/answer handshake over sealed signals.
//
// The manager never touches the DOM, IndexedDB, the UI, or the real
// GitHub API: signaling goes out through an injected `sendSignal`
// callback and comes in through `handleSignal` (phase 2 wires both to
// the SignalingClient). Connections come from an injected factory
// (WebRTC in the browser, loopback in tests). Every failure is a
// fallback trigger, never a user-facing error: the manager reports
// `peer-unreachable` / `handshake-failed` and the feature uses its
// GitHub path.

import { assembleIceServers } from "./ice.js";
import type { P2PConnection, P2PConnectionFactory } from "./transport.js";
import type {
  P2PSettings,
  PeerAd,
  SignalMessage,
} from "./types.js";
import { P2P_PROTOCOL_VERSION } from "./types.js";

/** How long an offer → connected handshake may take. */
export const P2P_HANDSHAKE_TIMEOUT_MS = 30_000;
/** How long a peer may be silent on every channel before it is
 *  marked away (connection kept, adapters fall back). */
export const P2P_PEER_SILENCE_MS = 60_000;
/** How long a silent connection is kept before it is closed. */
export const P2P_PEER_KEEP_MS = 300_000;

export type PeerManagerEvent =
  | { type: "peer-connected"; peerId: string; sessionId: string }
  | { type: "peer-disconnected"; peerId: string; reason: string }
  | { type: "peer-unreachable"; peerId: string; reason: string }
  | { type: "handshake-failed"; peerId: string; reason: string };

export interface KnownPeer {
  ad: PeerAd;
  /** Unix ms the ad was last fetched. */
  lastSeen: number;
  connection: P2PConnection | null;
  sessionId: string | null;
  /** Unix ms of the last frame on any channel (for silence). */
  lastActivity: number;
}

export interface PeerManagerOptions {
  settings: P2PSettings;
  /** The local peer ID (this device). */
  selfPeerId: string;
  /** The local mail address (sender of signals). */
  selfAddress: string;
  factory: P2PConnectionFactory;
  /** Sends one sealed signal toward a peer. The manager never sees
   *  GitHub directly — the caller seals + posts it. */
  sendSignal: (message: SignalMessage) => Promise<void>;
  /** Per-user TURN servers assembled by the caller (from the user's
   *  own Metered/Cloudflare/custom credentials). Empty = none. */
  ownTurnServers?: RTCIceServer[];
  now?: () => number;
  onEvent?: (event: PeerManagerEvent) => void;
  /** Handshake timeout override (tests use a short one). */
  handshakeTimeoutMs?: number;
  /** Random ID helper (injected in tests for determinism). */
  randomHex?: (bytes: number) => string;
}

interface PendingHandshake {
  sessionId: string;
  peerId: string;
  connection: P2PConnection;
  /** Resolves true on connect, false on failure/timeout. */
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Candidates gathered while the answer was in flight. */
  queuedCandidates: RTCIceCandidateInit[];
  /** True once setRemoteDescription has succeeded on this side. */
  remoteDescriptionSet: boolean;
}

/** Glare rule: when both peers open a session to each other at the
 *  same time, the peer with the lexicographically smaller peerId
 *  keeps the connection IT initiated; the other closes its duplicate.
 *  Deterministic, so both sides agree without negotiating. */
export function glareWinner(peerIdA: string, peerIdB: string): string {
  return peerIdA < peerIdB ? peerIdA : peerIdB;
}

export class PeerManager {
  private readonly factory: P2PConnectionFactory;
  private readonly sendSignalFn: (message: SignalMessage) => Promise<void>;
  private readonly now: () => number;
  private readonly onEvent?: (event: PeerManagerEvent) => void;
  private readonly handshakeTimeoutMs: number;
  private readonly randomHex: (bytes: number) => string;
  private readonly ownTurnServers: RTCIceServer[];

  settings: P2PSettings;
  readonly selfPeerId: string;
  readonly selfAddress: string;

  /** peerId -> known peer. */
  readonly peers = new Map<string, KnownPeer>();
  /** sessionId -> handshake in flight. */
  private readonly pending = new Map<string, PendingHandshake>();
  /** peerIds disconnected for misbehaviour this session (in-memory
   *  only — a restart re-evaluates the peer from its fresh ad). */
  private readonly blocklist = new Set<string>();
  private signalCounter = 0;

  constructor(options: PeerManagerOptions) {
    this.settings = options.settings;
    this.selfPeerId = options.selfPeerId;
    this.selfAddress = options.selfAddress;
    this.factory = options.factory;
    this.sendSignalFn = options.sendSignal;
    this.now = options.now ?? (() => Date.now());
    this.onEvent = options.onEvent;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? P2P_HANDSHAKE_TIMEOUT_MS;
    this.randomHex =
      options.randomHex ??
      ((bytes: number) => {
        const b = new Uint8Array(bytes);
        crypto.getRandomValues(b);
        return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      });
    this.ownTurnServers = options.ownTurnServers ?? [];
  }

  /** Replace settings (phase 2 calls this when the user toggles P2P
   *  in settings). Turning the master switch off closes every
   *  connection at once. */
  setSettings(settings: P2PSettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = settings;
    if (wasEnabled && !settings.enabled) {
      for (const peerId of [...this.peers.keys()]) {
        this.disconnect(peerId, "p2p disabled");
      }
    }
  }

  /** True when P2P may run at all (master switch on). Adapters check
   *  their own flag too. */
  get enabled(): boolean {
    return this.settings.enabled;
  }

  /** Record (or refresh) a peer from its fetched ad. Returns false
   *  when the peer is block-listed this session. */
  notePeer(ad: PeerAd): boolean {
    if (this.blocklist.has(ad.peerId)) return false;
    const existing = this.peers.get(ad.peerId);
    this.peers.set(ad.peerId, {
      ad,
      lastSeen: this.now(),
      connection: existing?.connection ?? null,
      sessionId: existing?.sessionId ?? null,
      lastActivity: existing?.lastActivity ?? this.now(),
    });
    return true;
  }

  /** Disconnect a peer for misbehaviour and ignore it for the rest
   *  of this session. */
  blockPeer(peerId: string, reason: string): void {
    this.blocklist.add(peerId);
    this.disconnect(peerId, reason);
  }

  isBlocked(peerId: string): boolean {
    return this.blocklist.has(peerId);
  }

  /** Is this peer connected right now (handshake complete, channel
   *  usable)? */
  isConnected(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    return peer?.connection?.state === "connected";
  }

  /** The live connection for a peer, or null. */
  connectionFor(peerId: string): P2PConnection | null {
    return this.peers.get(peerId)?.connection ?? null;
  }

  /** ICE configuration for a new connection, from settings. */
  iceConfig(): RTCConfiguration {
    return { iceServers: assembleIceServers(this.settings, this.ownTurnServers).iceServers };
  }

  private newSignalId(): string {
    this.signalCounter += 1;
    return `sig-${this.randomHex(16)}`;
  }

  private newSessionId(): string {
    return `p2p-${this.randomHex(16)}`;
  }

  /** Connect to a peer (caller side). Resolves true when the data
   *  channel handshake completes (hello exchanged is the adapters'
   *  job — this resolves on connection state "connected"), false on
   *  any failure or timeout. Never throws for a handshake failure. */
  async connectToPeer(ad: PeerAd): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.blocklist.has(ad.peerId)) return false;
    if (ad.peerId === this.selfPeerId) return false;
    const existing = this.peers.get(ad.peerId);
    if (existing?.connection?.state === "connected") return true;
    if (this.peers.size >= this.settings.maxPeers && !existing) {
      this.onEvent?.({
        type: "peer-unreachable",
        peerId: ad.peerId,
        reason: "too many peers",
      });
      return false;
    }
    this.notePeer(ad);
    const sessionId = this.newSessionId();
    const connection = this.factory.createConnection(ad.peerId, this.iceConfig());
    const pending: PendingHandshake = {
      sessionId,
      peerId: ad.peerId,
      connection,
      resolve: () => undefined,
      timer: null,
      queuedCandidates: [],
      remoteDescriptionSet: false,
    };
    const done = new Promise<boolean>((resolve) => {
      pending.resolve = resolve;
    });
    this.pending.set(sessionId, pending);
    const peer = this.peers.get(ad.peerId) as KnownPeer;
    peer.connection = connection;
    peer.sessionId = sessionId;

    connection.onLocalCandidate = (candidate) => {
      if (!candidate) return;
      void this.sendSignalFn({
        v: 1,
        kind: "ice",
        signalId: this.newSignalId(),
        sessionId,
        fromPeerId: this.selfPeerId,
        toPeerId: ad.peerId,
        fromAddress: this.selfAddress,
        candidate,
        sentAt: this.now(),
      }).catch(() => {
        // A failed candidate signal is not fatal — ICE keeps
        // gathering, and the connection may still complete.
      });
    };
    connection.onstatechange = (state) => {
      if (state === "connected") {
        this.finishHandshake(sessionId, true);
      } else if (state === "failed" || state === "closed") {
        this.finishHandshake(sessionId, false);
      }
    };

    pending.timer = setTimeout(() => {
      this.finishHandshake(sessionId, false, "handshake timed out");
    }, this.handshakeTimeoutMs);

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await this.sendSignalFn({
        v: 1,
        kind: "offer",
        signalId: this.newSignalId(),
        sessionId,
        fromPeerId: this.selfPeerId,
        toPeerId: ad.peerId,
        fromAddress: this.selfAddress,
        sdp: offer,
        sentAt: this.now(),
      });
    } catch (err) {
      this.finishHandshake(
        sessionId,
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
    return done;
  }

  private finishHandshake(sessionId: string, ok: boolean, reason?: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.pending.delete(sessionId);
    if (pending.timer) clearTimeout(pending.timer);
    const peer = this.peers.get(pending.peerId);
    if (!ok) {
      pending.connection.close();
      if (peer && peer.sessionId === sessionId) {
        peer.connection = null;
        peer.sessionId = null;
      }
      this.onEvent?.({
        type: "handshake-failed",
        peerId: pending.peerId,
        reason: reason ?? "connection failed",
      });
    } else {
      if (peer) peer.lastActivity = this.now();
      this.onEvent?.({
        type: "peer-connected",
        peerId: pending.peerId,
        sessionId,
      });
    }
    pending.resolve(ok);
  }

  /** Route one incoming (decrypted, validated) signal message. Never
   *  throws — a bad signal is reported as an event, never a crash. */
  async handleSignal(message: SignalMessage): Promise<void> {
    if (message.toPeerId !== this.selfPeerId) return;
    if (this.blocklist.has(message.fromPeerId)) return;
    if (message.fromPeerId === this.selfPeerId) return;
    try {
      if (message.kind === "offer") {
        await this.handleOffer(message);
      } else if (message.kind === "answer") {
        await this.handleAnswer(message);
      } else if (message.kind === "ice") {
        await this.handleIce(message);
      } else if (message.kind === "bye") {
        this.disconnect(message.fromPeerId, "peer said bye", false);
      }
    } catch (err) {
      this.onEvent?.({
        type: "handshake-failed",
        peerId: message.fromPeerId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleOffer(message: SignalMessage): Promise<void> {
    if (!this.enabled) return;
    if (!message.sdp) return;
    // Glare: both sides offered at once. The peer with the smaller
    // peerId keeps the connection IT initiated; the other side drops
    // its own pending handshake and answers this offer instead.
    const existing = this.peers.get(message.fromPeerId);
    if (existing?.connection?.state === "connected") {
      // Already connected to this peer: ignore the duplicate offer.
      return;
    }
    const myPending = existing?.sessionId
      ? this.pending.get(existing.sessionId)
      : undefined;
    if (myPending && glareWinner(this.selfPeerId, message.fromPeerId) === this.selfPeerId) {
      // I win the glare: ignore their offer, my handshake continues.
      return;
    }
    if (myPending) {
      // They win: drop my pending handshake, answer theirs.
      this.pending.delete(myPending.sessionId);
      if (myPending.timer) clearTimeout(myPending.timer);
      myPending.connection.close();
      myPending.resolve(false);
    }
    const sessionId = message.sessionId;
    const connection = this.factory.createConnection(message.fromPeerId, this.iceConfig());
    const pending: PendingHandshake = {
      sessionId,
      peerId: message.fromPeerId,
      connection,
      resolve: () => undefined,
      timer: null,
      queuedCandidates: [],
      remoteDescriptionSet: false,
    };
    const done = new Promise<boolean>((resolve) => {
      pending.resolve = resolve;
    });
    void done;
    this.pending.set(sessionId, pending);
    const peer = this.peers.get(message.fromPeerId);
    if (peer) {
      peer.connection = connection;
      peer.sessionId = sessionId;
    } else {
      // Offer from a peer whose ad we never fetched: accept the
      // handshake (the ad check happens at the adapter layer, where
      // capabilities are enforced), but record the peer as unknown.
      this.peers.set(message.fromPeerId, {
        ad: {
          v: 1,
          peerId: message.fromPeerId,
          address: message.fromAddress,
          domain: "",
          owner: "",
          capabilities: [],
          serves: [],
          updatedAt: this.now(),
          expiresAt: this.now(),
        },
        lastSeen: this.now(),
        connection,
        sessionId,
        lastActivity: this.now(),
      });
    }
    connection.onLocalCandidate = (candidate) => {
      if (!candidate) return;
      void this.sendSignalFn({
        v: 1,
        kind: "ice",
        signalId: this.newSignalId(),
        sessionId,
        fromPeerId: this.selfPeerId,
        toPeerId: message.fromPeerId,
        fromAddress: this.selfAddress,
        candidate,
        sentAt: this.now(),
      }).catch(() => undefined);
    };
    connection.onstatechange = (state) => {
      if (state === "connected") {
        this.finishHandshake(sessionId, true);
      } else if (state === "failed" || state === "closed") {
        this.finishHandshake(sessionId, false);
      }
    };
    pending.timer = setTimeout(() => {
      this.finishHandshake(sessionId, false, "handshake timed out");
    }, this.handshakeTimeoutMs);
    await connection.setRemoteDescription(message.sdp);
    pending.remoteDescriptionSet = true;
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await this.sendSignalFn({
      v: 1,
      kind: "answer",
      signalId: this.newSignalId(),
      sessionId,
      fromPeerId: this.selfPeerId,
      toPeerId: message.fromPeerId,
      fromAddress: this.selfAddress,
      sdp: answer,
      sentAt: this.now(),
    });
  }

  private async handleAnswer(message: SignalMessage): Promise<void> {
    const pending = this.pending.get(message.sessionId);
    if (!pending || !message.sdp) return;
    await pending.connection.setRemoteDescription(message.sdp);
    pending.remoteDescriptionSet = true;
    for (const candidate of pending.queuedCandidates) {
      await pending.connection.addIceCandidate(candidate).catch(() => undefined);
    }
    pending.queuedCandidates = [];
  }

  private async handleIce(message: SignalMessage): Promise<void> {
    if (!message.candidate) return;
    const pending = this.pending.get(message.sessionId);
    if (pending && !pending.remoteDescriptionSet) {
      // The remote description is not set yet on this side (caller
      // waiting for the answer): queue until handleAnswer drains.
      pending.queuedCandidates.push(message.candidate);
      return;
    }
    if (pending) {
      await pending.connection.addIceCandidate(message.candidate).catch(() => undefined);
      return;
    }
    const peer = this.peers.get(message.fromPeerId);
    if (peer?.connection) {
      await peer.connection.addIceCandidate(message.candidate).catch(() => undefined);
    }
  }

  /** Close a peer's connection (and its pending handshake, if any).
   *  The peer stays known — a later ad fetch can reconnect it.
   *  `sendBye` is false when this disconnect is itself answering a
   *  peer's bye (no bye-bye loop). */
  disconnect(peerId: string, reason: string, sendBye = true): void {
    const peer = this.peers.get(peerId);
    const sessionId = peer?.sessionId ?? `p2p-${this.randomHex(8)}`;
    if (peer?.sessionId) {
      const pending = this.pending.get(peer.sessionId);
      if (pending) {
        this.pending.delete(peer.sessionId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(false);
      }
    }
    if (peer?.connection) {
      peer.connection.close();
      peer.connection = null;
      peer.sessionId = null;
    }
    this.onEvent?.({ type: "peer-disconnected", peerId, reason });
    if (!sendBye) return;
    void this.sendSignalFn({
      v: 1,
      kind: "bye",
      signalId: this.newSignalId(),
      sessionId,
      fromPeerId: this.selfPeerId,
      toPeerId: peerId,
      fromAddress: this.selfAddress,
      sentAt: this.now(),
    }).catch(() => undefined);
  }

  /** Mark activity on a peer (called by adapters on any frame). Used
   *  by the silence check below. */
  noteActivity(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) peer.lastActivity = this.now();
  }

  /** Peers silent for longer than P2P_PEER_SILENCE_MS — adapters
   *  should fall back for these, while the connection is kept for
   *  P2P_PEER_KEEP_MS before it is closed. Returns the silent peer
   *  ids; closes the ones past the keep window. */
  checkSilence(): string[] {
    const now = this.now();
    const silent: string[] = [];
    for (const [peerId, peer] of this.peers) {
      if (!peer.connection || peer.connection.state !== "connected") continue;
      const quietFor = now - peer.lastActivity;
      if (quietFor > P2P_PEER_SILENCE_MS) silent.push(peerId);
      if (quietFor > P2P_PEER_KEEP_MS) {
        this.disconnect(peerId, "silent for too long");
      }
    }
    return silent;
  }
}
