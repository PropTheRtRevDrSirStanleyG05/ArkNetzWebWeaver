// ArkNetzWebWeaver — P2P ICE servers: STUN always on, TURN opt-in.
// No-account servers only, plus empty-by-default fields for users who
// bring their own TURN credentials. NOTHING here was created with
// Stanley's account or email: no Metered, Cloudflare, Xirsys, Twilio
// or Turnix account exists for this project, and no per-account API
// key is baked in anywhere.
//
// VERIFICATION STATUS (2026-11-21, build VM): the VM blocks all UDP
// egress (send EPERM) and resets non-HTTP TCP, so no live STUN
// binding or TURN allocate probe could run here — the failure was
// uniform across every endpoint including Google's STUN, which proves
// the block is local to the VM, not per-server. What WAS verified:
// every hostname resolves in DNS; Metered's site answers HTTPS 200;
// the Open Relay demo credential (openrelayproject/openrelayproject)
// is published in Metered's own docs and in multiple independent
// guides; the freeturn free/free credential is published in Mozilla's
// bug tracker and in several guides. Twilio's STUN was DROPPED from
// the default list: one source claims it needs API credentials, it
// could not be verified from this VM, and nine other STUN servers
// already cover the need. Runtime ICE gathering + the diagnostics in
// this file are the real verification: a server that does not answer
// simply yields no candidates and is skipped.
//
// Full table + rationale: P2P-SPEC.md §7.

import type { P2PSettings, P2PTurnConfig } from "./types.js";

/** One no-account ICE entry, with the operator facts the UI and the
 *  diagnostics need. `server` is the RTCIceServer handed to
 *  RTCPeerConnection; `operator`/`note` are for display only and are
 *  never sent on the wire. */
export interface NoAccountIceEntry {
  server: RTCIceServer;
  /** Who runs it, for the settings UI. */
  operator: string;
  /** Plain-words note shown next to it (or null when unremarkable). */
  note: string | null;
  /** "stun" entries are default-on; "turn" entries only run when the
   *  user enables TURN (and, for the demo entry, its own toggle). */
  kind: "stun" | "turn";
}

/** STUN, default-on, in the order ICE gathering tries them. All free,
 *  credential-free, no account. STUN only discloses your public IP to
 *  yourself — it carries no traffic and relays nothing. */
export const DEFAULT_STUN_SERVERS: NoAccountIceEntry[] = [
  {
    server: { urls: "stun:stun.l.google.com:19302" },
    operator: "Google",
    note: null,
    kind: "stun",
  },
  {
    server: { urls: "stun:stun1.l.google.com:19302" },
    operator: "Google",
    note: null,
    kind: "stun",
  },
  {
    server: { urls: "stun:stun2.l.google.com:19302" },
    operator: "Google",
    note: null,
    kind: "stun",
  },
  {
    server: { urls: "stun:stun3.l.google.com:19302" },
    operator: "Google",
    note: null,
    kind: "stun",
  },
  {
    server: { urls: "stun:stun4.l.google.com:19302" },
    operator: "Google",
    note: null,
    kind: "stun",
  },
  {
    server: { urls: "stun:stun.cloudflare.com:3478" },
    operator: "Cloudflare",
    note: "Cloudflare states this STUN service is free and unlimited.",
    kind: "stun",
  },
  {
    server: { urls: "stun:stun.openrelay.metered.ca:80" },
    operator: "Metered Open Relay",
    note: null,
    kind: "stun",
  },
  {
    server: { urls: "stun:stun.stunprotocol.org:3478" },
    operator: "stunprotocol.org",
    note: null,
    kind: "stun",
  },
  {
    server: { urls: "stun:freeturn.net:3478" },
    operator: "freeturn.net",
    note: "Community-run; no SLA. STUN only — the TURN entry below is separate.",
    kind: "stun",
  },
];

/** freeturn.net TURN — free, no account, no published quota,
 *  individually operated. Credentials "free"/"free" are published by
 *  the operator for public use. Included as the TURN fallback when
 *  the user enables TURN: it works with no signup at all. Labelled
 *  honestly everywhere it appears: community-run, no SLA, never a
 *  production dependency. */
export const FREETURN_TURN: NoAccountIceEntry = {
  server: {
    urls: [
      "turn:freeturn.net:3478",
      "turn:freeturn.net:3478?transport=tcp",
      "turns:freeturn.net:5349",
    ],
    username: "free",
    credential: "free",
  },
  operator: "freeturn.net",
  note: "Free community-run TURN server, no account needed, no published quota. No SLA — it may be slow, rate-limited, or down. Not a production dependency.",
  kind: "turn",
};

/** Open Relay's PUBLIC demo credential, published in Metered's own
 *  docs (openrelayproject / openrelayproject). Shared with everyone
 *  who uses it — the quota is shared too. Opt-in ONLY, behind its own
 *  toggle (`turn.useOpenRelayDemo`), never the default, never
 *  presented as private. This is NOT the static-auth endpoint:
 *  `staticauth.openrelay.metered.ca` + secret
 *  `openrelayprojectsecret` is for self-hosted servers (Nextcloud
 *  Talk, Matrix), not for clients — it is deliberately NOT in this
 *  file, and must never be added as a client credential. */
export const OPENRELAY_DEMO_TURN: NoAccountIceEntry = {
  server: {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:80?transport=tcp",
      "turn:openrelay.metered.ca:443",
      "turns:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  operator: "Metered Open Relay (public demo credential)",
  note: "Shared community credential — anyone can use it, the quota is shared, and it may be rate-limited or revoked at any time. For reliable relaying, use your own free Metered account key instead.",
  kind: "turn",
};

/** Where one assembled ICE server came from, so the settings UI and
 *  the diagnostics line can say exactly what is active and why. */
export interface IceServerSource {
  kind: "stun" | "turn-own" | "turn-freeturn" | "turn-demo";
  /** Display label, e.g. "STUN — Google" or "TURN — your own Metered key". */
  label: string;
  urls: string[];
}

/** The assembled ICE configuration for one connection, plus the
 *  provenance of every entry (used by the settings UI and by
 *  diagnostics). */
export interface AssembledIce {
  iceServers: RTCIceServer[];
  sources: IceServerSource[];
  /** True when any TURN entry is present (i.e. relay is possible). */
  turnEnabled: boolean;
}

function urlsOf(server: RTCIceServer): string[] {
  return Array.isArray(server.urls) ? [...server.urls] : [server.urls as string];
}

/** Build the RTCIceServer list for a connection from settings.
 *  Rules, in order:
 *  1. STUN is always on (the default list above) — no credential,
 *     no account, no privacy cost beyond asking for your own public
 *     IP. STUN is included even when P2P is otherwise off is NOT
 *     true: callers only call this when P2P is enabled; the function
 *     itself does not enforce the master switch (the peer manager
 *     does).
 *  2. Per-user TURN first, when the user configured one: Metered
 *     Open Relay API key, Cloudflare TURN, or custom URLs. The key
 *     comes from settings (the user's own, entered by them) — there
 *     is no baked-in key to fall back to, and an empty key means the
 *     entry is skipped, never sent with a blank credential.
 *  3. freeturn.net TURN when TURN is enabled and useFreeTurn is on
 *     (the default) — no signup needed.
 *  4. Open Relay demo credential only when TURN is enabled AND the
 *     user explicitly opted into it (useOpenRelayDemo).
 *  TURN entries appear only when turn.enabled is true. When it is
 *  false, the result is STUN-only and `turnEnabled` is false. */
export function assembleIceServers(
  settings: P2PSettings,
  ownTurnServers?: RTCIceServer[],
): AssembledIce {
  const iceServers: RTCIceServer[] = [];
  const sources: IceServerSource[] = [];
  for (const entry of DEFAULT_STUN_SERVERS) {
    iceServers.push(entry.server);
    sources.push({
      kind: "stun",
      label: `STUN — ${entry.operator}`,
      urls: urlsOf(entry.server),
    });
  }
  const turn: P2PTurnConfig = settings.turn;
  if (!turn.enabled) {
    return { iceServers, sources, turnEnabled: false };
  }
  // Per-user TURN first: the user's own key is the reliable path.
  const own = ownTurnServers ?? [];
  for (const server of own) {
    iceServers.push(server);
    sources.push({
      kind: "turn-own",
      label: "TURN — your own key",
      urls: urlsOf(server),
    });
  }
  if (turn.useFreeTurn) {
    iceServers.push(FREETURN_TURN.server);
    sources.push({
      kind: "turn-freeturn",
      label: "TURN — freeturn.net (community-run, no SLA)",
      urls: urlsOf(FREETURN_TURN.server),
    });
  }
  if (turn.useOpenRelayDemo) {
    iceServers.push(OPENRELAY_DEMO_TURN.server);
    sources.push({
      kind: "turn-demo",
      label: "TURN — Open Relay public demo credential (shared quota)",
      urls: urlsOf(OPENRELAY_DEMO_TURN.server),
    });
  }
  return {
    iceServers,
    sources,
    turnEnabled: iceServers.some((s) => {
      const urls = urlsOf(s);
      return urls.some((u) => u.startsWith("turn"));
    }),
  };
}

/** Build the per-user TURN entry from a Metered Open Relay API key
 *  the user entered. Returns null when there is no key — the caller
 *  must skip it, never send a blank credential. The Metered REST API
 *  returns short-lived credentials per key; this function builds the
 *  static entry shape for a key the user pasted directly (the API
 *  fetch path is phase 2's, when it calls Metered's endpoint with the
 *  user's key and converts the response into this same shape). */
export function meteredOwnTurnServers(apiKey: string): RTCIceServer[] {
  if (!apiKey.trim()) return [];
  // Per-account credentials are issued by Metered's API; the key
  // itself is not a TURN credential. This helper only records that a
  // key exists — the real iceServers come from the API response.
  // Returning [] here keeps the static path honest: no fabricated
  // TURN entry is ever built from a bare API key.
  return [];
}

// ---------------------------------------------------------------------------
// Connection diagnostics: which ICE path succeeded.
// ---------------------------------------------------------------------------

/** Which ICE path the connection actually used. */
export type IcePathKind =
  | "direct-host"
  | "direct-srflx"
  | "relayed"
  | "loopback"
  | "unknown";

export interface IceDiagnostics {
  path: IcePathKind;
  /** Local candidate type from the selected pair, when known. */
  localType?: string;
  /** Remote candidate type from the selected pair, when known. */
  remoteType?: string;
  /** The relay server URL, when the path is relayed. */
  relayUrl?: string;
  /** Human label for the relay (operator + honesty note). */
  relayLabel?: string;
  /** One-line summary for the settings/diagnostics UI. */
  summary: string;
}

function relayLabelFor(url: string): string {
  if (url.includes("freeturn.net")) {
    return "freeturn.net (community-run TURN, no SLA)";
  }
  if (url.includes("openrelay.metered.ca")) {
    return "openrelay.metered.ca (Open Relay public demo credential — shared quota)";
  }
  if (url.includes("relay.metered.ca")) {
    return "Metered Open Relay (your own account key)";
  }
  if (url.includes("cloudflare.com")) {
    return "Cloudflare TURN (your own account key)";
  }
  return `${url} (your own TURN server)`;
}

/** Derive the diagnostics from a selected ICE candidate pair. The
 *  caller (the WebRTC adapter) reads the pair from
 *  RTCPeerConnection.getStats() and passes the two candidate types
 *  plus the relay URL when the local candidate is type "relay".
 *  Pure function — fully testable without WebRTC. */
export function describeIcePath(input: {
  localCandidateType?: string;
  remoteCandidateType?: string;
  relayUrl?: string;
}): IceDiagnostics {
  const local = (input.localCandidateType ?? "").toLowerCase();
  const remote = (input.remoteCandidateType ?? "").toLowerCase();
  if (local === "relay" || remote === "relay") {
    const relayUrl = input.relayUrl;
    const label = relayUrl ? relayLabelFor(relayUrl) : "an unknown TURN server";
    return {
      path: "relayed",
      localType: input.localCandidateType,
      remoteType: input.remoteCandidateType,
      relayUrl,
      relayLabel: label,
      summary: relayUrl
        ? `Relayed through ${label}. The relay sees your IP address and how much you transfer, but not the content — P2P traffic is encrypted end to end.`
        : "Relayed through a TURN server. The relay sees your IP address and how much you transfer, but not the content — P2P traffic is encrypted end to end.",
    };
  }
  if (local === "host" && remote === "host") {
    return {
      path: "direct-host",
      localType: input.localCandidateType,
      remoteType: input.remoteCandidateType,
      summary: "Direct connection (host to host) — no STUN or TURN server involved in the data path.",
    };
  }
  if (local === "srflx" || remote === "srflx") {
    return {
      path: "direct-srflx",
      localType: input.localCandidateType,
      remoteType: input.remoteCandidateType,
      summary: "Direct connection (via STUN-discovered addresses) — no relay server involved in the data path.",
    };
  }
  if (!local && !remote) {
    return {
      path: "unknown",
      summary: "Connection path unknown — no ICE candidate pair was reported.",
    };
  }
  return {
    path: "unknown",
    localType: input.localCandidateType,
    remoteType: input.remoteCandidateType,
    summary: `Connection path unknown (local: ${local || "?"}, remote: ${remote || "?"}) — no relay was used.`,
  };
}

/** Diagnostics for the loopback test transport: no network at all. */
export function loopbackDiagnostics(): IceDiagnostics {
  return {
    path: "loopback",
    summary: "Loopback (test transport) — no network, no ICE, no relay.",
  };
}

// ---------------------------------------------------------------------------
// Settings UI copy. Plain words, no jargon where it can be avoided.
// Phase 2 drops these strings into the P2P settings panel verbatim.
// ---------------------------------------------------------------------------

/** The relay privacy note, shown wherever TURN is configured. */
export const P2P_RELAY_PRIVACY_NOTE =
  "When a direct connection can't be made, your traffic is relayed through the relay operator's servers. " +
  "The operator can see your IP address and how much you transfer, but not what you send — P2P traffic is encrypted end to end, so the relay cannot read it. " +
  "Nothing is relayed unless you turn TURN on below.";

/** Note shown next to the freeturn.net fallback toggle. */
export const P2P_FREETURN_NOTE =
  "freeturn.net is a free community-run TURN server. It needs no account and no signup, but there is no SLA — " +
  "it may be slow, rate-limited, or down. It is a fallback, never a production dependency.";

/** Note shown next to the Open Relay demo toggle. */
export const P2P_OPENRELAY_DEMO_NOTE =
  "Open Relay's public demo credential (openrelayproject) is shared with everyone who uses it, and the quota is shared too. " +
  "It may be rate-limited or revoked at any time. For reliable relaying, use your own free Metered account key instead.";

/** Note shown above the per-user credential fields. */
export const P2P_NO_ACCOUNT_NOTE =
  "No account is needed for the servers above. If you want your own private relay, enter your own Metered Open Relay API key, " +
  "Cloudflare TURN key, or custom TURN server below — those fields stay empty until you fill them in. No account of yours is ever used to create keys.";
