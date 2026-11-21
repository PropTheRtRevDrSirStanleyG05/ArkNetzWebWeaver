// ArkNetzWebWeaver — P2P identity: peer IDs and advertisements.
// A peer ID identifies a DEVICE, not an account: it is random, never
// derived from the GitHub login or the mail address. The ad binds
// peer ID -> address by living in the address owner's own site repo
// (see P2P-SPEC.md §2). No secret lives in an ad.

import { RAW_GITHUB_BASE } from "../config.js";
import { siteRepoName } from "../publish.js";
import { isValidDomain } from "../types.js";
import { PEER_AD_VERSION, type P2PCapability, type PeerAd } from "./types.js";

/** How long a published ad stays valid (1 hour). Readers ignore
 *  expired ads; the client republishes while P2P is enabled. */
export const PEER_AD_TTL_MS = 3_600_000;
/** Clock-skew guard: an ad dated more than this far in the future is
 *  rejected rather than trusted. */
export const PEER_AD_MAX_FUTURE_SKEW_MS = 86_400_000;

export function generatePeerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isValidPeerId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/** Raw URL of a peer's advertisement: peer-ad.json on main of their
 *  site repo (same raw-read path as site documents). */
export function peerAdUrl(owner: string, domain: string): string {
  return `${RAW_GITHUB_BASE}/${owner}/${siteRepoName(domain)}/main/peer-ad.json`;
}

export interface BuildPeerAdInput {
  peerId: string;
  address: string;
  domain: string;
  owner: string;
  capabilities: P2PCapability[];
  serves: string[];
  turnUrls?: string[];
  now?: number;
}

/** Build a fresh ad for publication. `turnUrls` carries TURN server
 *  URLs WITHOUT credentials — credentials are never published. */
export function buildPeerAd(input: BuildPeerAdInput): PeerAd {
  const now = input.now ?? Date.now();
  if (!isValidPeerId(input.peerId)) {
    throw new Error("cannot build a peer ad: peerId must be 32 hex chars");
  }
  if (!input.address.includes("@")) {
    throw new Error(`cannot build a peer ad: address has no @: ${input.address}`);
  }
  if (!isValidDomain(input.domain)) {
    throw new Error(`cannot build a peer ad: invalid domain: ${input.domain}`);
  }
  if (!input.owner) throw new Error("cannot build a peer ad: owner is empty");
  const ad: PeerAd = {
    v: PEER_AD_VERSION,
    peerId: input.peerId,
    address: input.address.toLowerCase(),
    domain: input.domain.toLowerCase(),
    owner: input.owner,
    capabilities: [...input.capabilities],
    serves: [...input.serves.map((d) => d.toLowerCase())],
    updatedAt: now,
    expiresAt: now + PEER_AD_TTL_MS,
  };
  if (input.turnUrls && input.turnUrls.length > 0) {
    ad.turn = { urls: [...input.turnUrls] };
  }
  return ad;
}

const KNOWN_CAPABILITIES = new Set(["site", "collab", "mail", "drive"]);

/** Validate a fetched ad. Throws with the exact problem — a corrupt
 *  or stale ad is never trusted silently. `expected` pins the domain
 *  and owner to the repo the ad was fetched from: an ad that claims a
 *  different domain or owner than its repo is rejected, because the
 *  repo is the only thing authenticating it (P2P-SPEC.md §2.4). */
export function parsePeerAd(
  raw: unknown,
  expected?: { domain?: string; owner?: string },
  now: number = Date.now(),
): PeerAd {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("peer ad is not an object");
  }
  const a = raw as Record<string, unknown>;
  if (a.v !== PEER_AD_VERSION) {
    throw new Error(
      `peer ad has unsupported version ${String(a.v)} (this client knows v${PEER_AD_VERSION})`,
    );
  }
  if (!isValidPeerId(a.peerId)) {
    throw new Error("peer ad has an invalid peerId (expected 32 hex chars)");
  }
  if (typeof a.address !== "string" || !a.address.includes("@")) {
    throw new Error("peer ad has an invalid address");
  }
  if (typeof a.domain !== "string" || !isValidDomain(a.domain)) {
    throw new Error("peer ad has an invalid domain");
  }
  if (typeof a.owner !== "string" || !a.owner) {
    throw new Error("peer ad has no owner");
  }
  if (expected?.domain && a.domain !== expected.domain.toLowerCase()) {
    throw new Error(
      `peer ad domain ${a.domain} does not match the repo it was fetched from (${expected.domain}) — refusing it`,
    );
  }
  if (expected?.owner && a.owner !== expected.owner) {
    throw new Error(
      `peer ad owner ${a.owner} does not match the repo it was fetched from (${expected.owner}) — refusing it`,
    );
  }
  if (!Array.isArray(a.capabilities)) {
    throw new Error("peer ad has no capabilities array");
  }
  for (const c of a.capabilities as unknown[]) {
    if (typeof c !== "string" || !KNOWN_CAPABILITIES.has(c)) {
      throw new Error(`peer ad lists an unknown capability: ${String(c)}`);
    }
  }
  if (!Array.isArray(a.serves)) {
    throw new Error("peer ad has no serves array");
  }
  for (const d of a.serves as unknown[]) {
    if (typeof d !== "string" || !isValidDomain(d)) {
      throw new Error(`peer ad serves an invalid domain: ${String(d)}`);
    }
  }
  if (a.turn !== undefined) {
    const turn = a.turn as Record<string, unknown>;
    if (
      typeof turn !== "object" ||
      turn === null ||
      !Array.isArray(turn.urls) ||
      !(turn.urls as unknown[]).every((u) => typeof u === "string" && u.length > 0)
    ) {
      throw new Error("peer ad has a malformed turn field (expected { urls: string[] })");
    }
  }
  if (typeof a.updatedAt !== "number" || typeof a.expiresAt !== "number") {
    throw new Error("peer ad has no updatedAt/expiresAt");
  }
  if (a.expiresAt <= now) {
    throw new Error("peer ad is expired — ignoring it");
  }
  if (a.updatedAt > now + PEER_AD_MAX_FUTURE_SKEW_MS) {
    throw new Error("peer ad is dated more than 24 h in the future — ignoring it");
  }
  return raw as PeerAd;
}

/** True when the ad is still usable at `now` (same checks as parse,
 *  without throwing). */
export function isPeerAdFresh(ad: PeerAd, now: number = Date.now()): boolean {
  try {
    parsePeerAd(ad, undefined, now);
    return true;
  } catch {
    return false;
  }
}
