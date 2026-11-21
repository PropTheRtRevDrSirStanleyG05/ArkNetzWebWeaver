// ArkNetzWebWeaver — P2P shared types (arknetz-p2p/1).
// Optional WebRTC transport, OFF by default. See P2P-SPEC.md for the
// full spec; this file is only the shapes the modules share. No
// network, no storage, no DOM access here — pure types + defaults.

/** P2P protocol version string (carried in hello + ads). */
export const P2P_PROTOCOL_VERSION = "arknetz-p2p/1";
/** Peer-ad format version (the `v` field of peer-ad.json). */
export const PEER_AD_VERSION = 1;
/** Signal message format version. */
export const SIGNAL_VERSION = 1;

/** What a peer can do over P2P. A capability absent from an ad means
 *  "ask GitHub, not me" for that surface. */
export type P2PCapability = "site" | "collab" | "mail" | "drive";
export const P2P_CAPABILITIES: P2PCapability[] = ["site", "collab", "mail", "drive"];

/** TURN configuration. TURN is OFF by default; every TURN variant
 *  below is opt-in, and no credential of any kind is baked in.
 *  Per-user fields (apiKey / urls) are empty until the user fills
 *  them — see ice.ts for the no-account fallbacks that work without
 *  any signup. */
export interface P2PTurnConfig {
  /** Master TURN switch. False = no relay at all, direct only. */
  enabled: boolean;
  /** Which per-user TURN provider the user configured (if any). */
  provider: "metered-openrelay" | "cloudflare" | "custom" | "none";
  /** The USER's own API key / credential for their provider.
   *  Empty by default. Never a baked-in or shared key. */
  apiKey: string;
  /** Custom TURN server URLs (provider "custom" only). */
  urls: string[];
  /** Include the freeturn.net no-account TURN as a fallback when
   *  TURN is enabled. True by default — it needs no signup. */
  useFreeTurn: boolean;
  /** Include Open Relay's PUBLIC demo credential as a fallback when
   *  TURN is enabled. False by default — it is a shared community
   *  credential with a shared quota (see ice.ts). */
  useOpenRelayDemo: boolean;
}

export function defaultTurnConfig(): P2PTurnConfig {
  return {
    enabled: false,
    provider: "none",
    apiKey: "",
    urls: [],
    useFreeTurn: true,
    useOpenRelayDemo: false,
  };
}

/** P2P settings. Defaults: everything off. Enabling the master
 *  switch does NOT enable any feature — each surface is opted into
 *  separately, and each adapter refuses to run unless both the master
 *  switch and its own flag are on. Settings are per device. */
export interface P2PSettings {
  /** Master switch — false by default. */
  enabled: boolean;
  /** Serve/fetch site bundles over P2P. */
  sites: boolean;
  /** Live collab over P2P. */
  collab: boolean;
  /** Direct mail delivery over P2P. */
  mail: boolean;
  /** Direct chunk transfer over P2P. */
  drive: boolean;
  /** Allow OTHER peers to fetch bundles from me. */
  serveSites: boolean;
  /** Max concurrent peer connections. */
  maxPeers: number;
  /** Upload cap, KiB/s per peer. 0 = unlimited. */
  maxUploadKBps: number;
  turn: P2PTurnConfig;
}

export function defaultP2PSettings(): P2PSettings {
  return {
    enabled: false,
    sites: false,
    collab: false,
    mail: false,
    drive: false,
    serveSites: false,
    maxPeers: 8,
    maxUploadKBps: 512,
    turn: defaultTurnConfig(),
  };
}

/** A peer advertisement — the public JSON at peer-ad.json on main of
 *  the peer's site repo (see P2P-SPEC.md §2.2). Contains no secret,
 *  no key, no credential. */
export interface PeerAd {
  v: number;
  /** 32 hex chars, random per device. */
  peerId: string;
  /** The peer's protocol mail address (lowercase). */
  address: string;
  /** The domain whose site repo hosts this ad. */
  domain: string;
  /** GitHub login owning the site repo. */
  owner: string;
  capabilities: P2PCapability[];
  /** Domains this peer will serve bundles for. */
  serves: string[];
  /** TURN server URLs this peer can use — WITHOUT credentials. */
  turn?: { urls: string[] };
  /** Unix ms the ad was published. */
  updatedAt: number;
  /** Unix ms the ad stops being valid. */
  expiresAt: number;
}

/** One signaling message (before sealing). The sealed form is what
 *  travels in the GitHub Issue (P2P-SPEC.md §3). */
export type SignalKind = "offer" | "answer" | "ice" | "bye";
export const SIGNAL_KINDS: SignalKind[] = ["offer", "answer", "ice", "bye"];

export interface SignalMessage {
  v: number;
  kind: SignalKind;
  /** Unique per message (dedupe key). */
  signalId: string;
  /** Unique per handshake (all messages of one connection share it). */
  sessionId: string;
  fromPeerId: string;
  toPeerId: string;
  fromAddress: string;
  /** Present for offer/answer. */
  sdp?: RTCSessionDescriptionInit;
  /** Present for ice. */
  candidate?: RTCIceCandidateInit;
  sentAt: number;
}

/** JSON control messages on a data channel (frame type 0x01).
 *  `t` discriminates; unknown `t` values are ignored, never fatal. */
export type ControlMessage =
  | { t: "hello"; v: string; peerId: string; features: string[] }
  | { t: "transfer-begin"; id: string; kind: string; totalBytes: number; totalChunks: number; sha256: string }
  | { t: "transfer-missing"; id: string; indexes: number[] }
  | { t: "transfer-done"; id: string; ok: boolean; reason?: string }
  | { t: "op"; session: string; ops: unknown[] }
  | { t: "cursor"; session: string; login: string; cursor: unknown }
  | { t: "site-request"; domain: string }
  | { t: "site-error"; domain: string; reason: string }
  | { t: "bye"; reason?: string };

/** Data-channel labels, one per adapter. */
export const P2P_CHANNEL_LABELS = {
  site: "arknetz/site",
  collab: "arknetz/collab",
  mail: "arknetz/mail",
  drive: "arknetz/drive",
} as const;
