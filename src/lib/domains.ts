// ArkNetzWebWeaver — custom domains (Phase 4a).
// Thread: custom domains are exact full strings only (e.g.
// `computers.edu`, `edu.orion.stanbeyond`, `alex.zine`) — never whole
// TLDs, no TLD monopolies. The app is its own root registry
// (`registry.json.zst` = root nameserver), split into 16 hash shards
// (REPO-TOPOLOGY.md). Sub-delegation by owners via
// `delegations.json.zst` in the site repo.
// Registration is completely open: NO minimum account age, NO
// per-user domain-claim limit (Stanley rejected both). Claims arrive
// as a GitHub Issue titled `REGISTER: <domain>`; the free
// `register.yml` Action (protocol/register.yml) checks availability +
// banned words, commits the registry shard and closes the issue
// (~5-10 s). The Root Master writes direct to main (<1 s).
// This module is pure TypeScript with an injected fetch function —
// it makes NO real network calls and never touches GitHub directly.

import type { RegistryEntry } from "./types.js";
import { decompressJson } from "./zstd.js";

/** Starter banned-word list. A word is banned when it appears as a
 *  whole label of the domain (so `admin.edu` is refused but
 *  `myadmin.edu` is fine). The same list lives in
 *  protocol/register.yml — keep the two in sync. This is a starter
 *  list for the protocol repo; the Root Master can extend it there. */
export const DEFAULT_BANNED_WORDS: string[] = [
  "admin",
  "root",
  "support",
  "abuse",
  "security",
  "postmaster",
  "webmaster",
  "arknetz",
  "protocol",
  "github",
  "archive",
  "localhost",
  "malware",
  "phishing",
  "scam",
  "spam",
  "example",
  "invalid",
  "test",
];

/** Normalise a user-typed domain: trim whitespace, lowercase, drop
 *  one trailing dot (`computers.edu.` means `computers.edu`). */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  if (d.endsWith(".")) d = d.slice(0, -1);
  return d;
}

export type DomainValidationCode =
  | "empty"
  | "too_long"
  | "tld_only"
  | "bad_label"
  | "label_too_long"
  | "banned_word";

export interface DomainValidationResult {
  valid: boolean;
  /** Normalised domain when valid, otherwise the normalised input. */
  domain: string;
  code?: DomainValidationCode;
  /** Plain-English reason, shown in the UI when invalid. */
  reason?: string;
  /** The banned label, when code is "banned_word". */
  bannedWord?: string;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Validate an exact-string domain claim. Rejects TLD-only claims
 *  (`edu`) and anything that would monopolise a TLD, rejects bad
 *  labels, and rejects banned words. Case and surrounding whitespace
 *  are normalised, never rejected. */
export function validateDomain(
  input: string,
  bannedWords: string[] = DEFAULT_BANNED_WORDS,
): DomainValidationResult {
  const domain = normalizeDomain(input);
  if (!domain) {
    return { valid: false, domain, code: "empty", reason: "Enter a domain to claim, for example computers.edu." };
  }
  if (domain.length > 253) {
    return { valid: false, domain, code: "too_long", reason: `"${domain}" is too long — a domain can be at most 253 characters.` };
  }
  const labels = domain.split(".");
  if (labels.length < 2) {
    return {
      valid: false,
      domain,
      code: "tld_only",
      reason:
        `"${domain}" is a top-level domain on its own. ArkNetzWebWeaver only registers exact full domain strings ` +
        `(for example computers.edu or alex.zine) — whole TLDs are never claimed, so no one can monopolise one.`,
    };
  }
  for (const label of labels) {
    if (label.length === 0) {
      return { valid: false, domain, code: "bad_label", reason: `"${domain}" has an empty label — check for a double dot or a leading or trailing dot.` };
    }
    if (label.length > 63) {
      return { valid: false, domain, code: "label_too_long", reason: `The label "${label}" is longer than 63 characters.` };
    }
    if (!LABEL_RE.test(label)) {
      return {
        valid: false,
        domain,
        code: "bad_label",
        reason:
          `"${domain}" is not a valid domain. Use lowercase letters, numbers and hyphens only, ` +
          `with no label starting or ending in a hyphen.`,
      };
    }
  }
  const banned = new Set(bannedWords.map((w) => w.toLowerCase()));
  for (const label of labels) {
    if (banned.has(label)) {
      return {
        valid: false,
        domain,
        code: "banned_word",
        bannedWord: label,
        reason: `"${domain}" cannot be registered — the word "${label}" is reserved. Pick a different domain.`,
      };
    }
  }
  return { valid: true, domain };
}

// ---------------------------------------------------------------------------
// REGISTER Issue shape
// ---------------------------------------------------------------------------

export interface RegisterIssue {
  /** Always `REGISTER: <domain>`. */
  title: string;
  body: string;
  domain: string;
  claimant: string;
}

/** Build the GitHub Issue a claim opens. The title is the machine
 *  contract (`REGISTER: <domain>`); the body carries the claimant, the
 *  shard, and the Terms acceptance the thread requires before a first
 *  claim or publish (turn 33). */
export function buildRegisterIssue(
  domainInput: string,
  claimant: string,
  opts: { acceptedTerms?: boolean; requestedAt?: number } = {},
): RegisterIssue {
  const v = validateDomain(domainInput);
  if (!v.valid) throw new Error(`cannot build a REGISTER issue: ${v.reason ?? "invalid domain"}`);
  const domain = v.domain;
  const who = claimant.trim();
  if (!who) throw new Error("cannot build a REGISTER issue: no claimant GitHub login given");
  const requestedAt = opts.requestedAt ?? Date.now();
  const body = [
    `Domain: ${domain}`,
    `Claimed by: @${who}`,
    `Requested at: ${new Date(requestedAt).toISOString()}`,
    `Terms accepted: ${opts.acceptedTerms ? "yes" : "no"}`,
    ``,
    `I agree to the ArkNetzWebWeaver Terms, the GitHub Terms of Service, and the Internet Archive Terms of Use.`,
  ].join("\n");
  return { title: `REGISTER: ${domain}`, body, domain, claimant: who };
}

/** Parse a `REGISTER: <domain>` issue title. Returns the normalised
 *  domain, or null when the title is not a REGISTER claim. */
export function parseRegisterIssueTitle(title: string): string | null {
  const m = /^REGISTER:\s*(.+?)\s*$/.exec(title.trim());
  if (!m) return null;
  const domain = normalizeDomain(m[1] as string);
  return domain.length > 0 ? domain : null;
}

/** Parse a REGISTER issue body back into its domain + claimant.
 *  Returns null when the body does not carry both fields. */
export function parseRegisterIssueBody(body: string): { domain: string; claimant: string } | null {
  const domainMatch = /^Domain:\s*(.+?)\s*$/m.exec(body);
  const claimantMatch = /^Claimed by:\s*@?(.+?)\s*$/m.exec(body);
  if (!domainMatch || !claimantMatch) return null;
  const domain = normalizeDomain(domainMatch[1] as string);
  const claimant = (claimantMatch[1] as string).trim().replace(/^@/, "");
  if (!domain || !claimant) return null;
  return { domain, claimant };
}

// ---------------------------------------------------------------------------
// Registry shards + availability
// ---------------------------------------------------------------------------

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** First hex digit of SHA256(domain) — the shard key (same rule as
 *  registry.ts; duplicated here as a pure function so this module
 *  stays usable without the cache/zstd stack). */
export async function shardForDomain(domain: string): Promise<string> {
  const hex = await sha256Hex(normalizeDomain(domain));
  return hex[0] as string;
}

export const MASTER_GITHUB_USER_FOR_SHARDS = "PropTheRtRevDrSirStanleyG05";

export function registryShardRepoName(shardHex: string): string {
  return `arknetz-registry-${shardHex.padStart(2, "0")}`;
}

/** DECISION (fix round 2, item 8): the availability check reads the
 *  CANONICAL shard file, `registry.json.zst`, first and decompresses it
 *  via zstd.ts — the same .zst-first, plain-on-404 pattern as
 *  RegistryResolver.resolve() in registry.ts. The old code fetched only
 *  the plain `registry.json` mirror, which is a secondary artifact:
 *  register.yml commits both files on a claim, but a Root Master direct
 *  write (or any shard published with only the .zst) leaves no plain
 *  mirror, and a 404 on the mirror then read as “available” for
 *  a domain that is actually taken — the dangerous direction for a
 *  claim check. Plain `registry.json` is now only the fallback when the
 *  .zst 404s (a shard that predates .zst publishing). A .zst that
 *  downloads but fails to decompress is corrupt and throws; it does NOT
 *  silently fall back to the plain file. No register.yml change was
 *  needed: the template already commits both files on every claim, so
 *  the plain fallback exists wherever the .zst does. */
export async function registryShardUrl(domain: string): Promise<string> {
  const shard = await shardForDomain(domain);
  return `https://raw.githubusercontent.com/${MASTER_GITHUB_USER_FOR_SHARDS}/${registryShardRepoName(shard)}/main/registry.json`;
}

/** Canonical shard URL: `registry.json.zst` in the domain's hash-shard
 *  repo. This is what checkDomainAvailability fetches first. */
export async function registryShardZstUrl(domain: string): Promise<string> {
  return (await registryShardUrl(domain)).replace(/\.json$/, ".json.zst");
}

export interface AvailabilityResult {
  domain: string;
  available: boolean;
  shard: string;
  /** Set when not available (or when the check could not run). */
  reason?: string;
  entry?: RegistryEntry;
}

export type ShardEntries =
  | Map<string, RegistryEntry>
  | Record<string, RegistryEntry>
  | RegistryEntry[];

/** Synchronous availability check against an already-parsed shard
 *  (map, record, or entries array — the same shapes
 *  parseRegistryShard accepts). */
export function checkAvailabilityAgainstShard(
  domainInput: string,
  shard: ShardEntries,
): AvailabilityResult {
  const v = validateDomain(domainInput);
  if (!v.valid) {
    return { domain: normalizeDomain(domainInput), available: false, shard: "", reason: v.reason };
  }
  const domain = v.domain;
  let entry: RegistryEntry | undefined;
  if (shard instanceof Map) {
    entry = shard.get(domain);
  } else if (Array.isArray(shard)) {
    entry = shard.find((e) => e.domain === domain);
  } else {
    entry = shard[domain];
  }
  if (entry) {
    return {
      domain,
      available: false,
      shard: entry.shard,
      reason: `"${domain}" is already registered to @${entry.owner}. Pick a different domain.`,
      entry,
    };
  }
  return { domain, available: true, shard: "" };
}

/** Minimal fetch shape for availability checks (compatible with the
 *  FetchFn in cache.ts). Injected in tests — never a real network
 *  call from this module on its own. `arrayBuffer` is required for
 *  the canonical `.zst` shard read: a fetch that cannot supply bytes
 *  cannot check a `.zst` shard, and checkDomainAvailability says so
 *  loudly instead of silently reading the plain mirror. */
export type DomainFetchFn = (url: string) => Promise<{
  status: number;
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}>;

/** Parse a shard body in either accepted shape: a domain-keyed map
 *  or `{ entries: [...] }`. Throws on a malformed shard so a corrupt
 *  shard is loud instead of reading as "available". */
export function parseShardBody(body: string): Map<string, RegistryEntry> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error("registry shard is not valid JSON");
  }
  return parseShardEntries(raw);
}

/** Entries of an already-parsed shard document (the decompressed
 *  `.zst` payload, or the JSON.parse result of the plain mirror).
 *  Same shapes as parseShardBody; entries without a domain string are
 *  skipped, a non-object document throws. */
export function parseShardEntries(raw: unknown): Map<string, RegistryEntry> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("registry shard is not an object");
  }
  const out = new Map<string, RegistryEntry>();
  const obj = raw as Record<string, unknown>;
  const list: unknown[] = Array.isArray(obj.entries)
    ? obj.entries
    : Object.values(obj);
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.domain !== "string") continue;
    out.set(e.domain, e as unknown as RegistryEntry);
  }
  return out;
}

/** Availability verdict from a shard's entries. An entry whose `shard`
 *  disagrees with the shard the domain hashes to is in the wrong shard
 *  and throws loudly — a mis-filed entry must never read as a free
 *  domain or as someone else's registration. */
function availabilityFromEntries(
  domain: string,
  shard: string,
  entries: Map<string, RegistryEntry>,
): AvailabilityResult {
  const entry = entries.get(domain);
  if (entry) {
    if (typeof entry.shard === "string" && entry.shard !== shard) {
      throw new Error(
        `registry entry for "${domain}" is in the wrong shard: entry says ${entry.shard}, SHA256 says ${shard}`,
      );
    }
    return {
      domain,
      available: false,
      shard,
      reason: `"${domain}" is already registered to @${entry.owner}. Pick a different domain.`,
      entry,
    };
  }
  return { domain, available: true, shard };
}

/** Availability check over the wire (injected fetch). Reads the
 *  canonical `registry.json.zst` first (see the note on
 *  registryShardUrl); a 404 there falls back to plain `registry.json`.
 *  A missing shard (404 on both) means the shard has no entries yet,
 *  so the domain is available. Any other non-200 status throws — it
 *  must not read as "available". A corrupt `.zst` throws and is never
 *  papered over by the plain mirror. */
export async function checkDomainAvailability(
  domainInput: string,
  fetchFn: DomainFetchFn,
): Promise<AvailabilityResult> {
  const v = validateDomain(domainInput);
  if (!v.valid) {
    return { domain: normalizeDomain(domainInput), available: false, shard: "", reason: v.reason };
  }
  const domain = v.domain;
  const shard = await shardForDomain(domain);
  const zstUrl = await registryShardZstUrl(domain);
  const zstRes = await fetchFn(zstUrl);
  if (zstRes.status !== 404) {
    if (zstRes.status !== 200) {
      throw new Error(`could not check availability for "${domain}": shard fetch failed with HTTP ${zstRes.status}`);
    }
    if (typeof zstRes.arrayBuffer !== "function") {
      throw new Error(
        `could not check availability for "${domain}": ${zstUrl} needs arrayBuffer() to decompress the .zst shard — the injected fetch supplies text only`,
      );
    }
    const entries = parseShardEntries(
      await decompressJson(new Uint8Array(await zstRes.arrayBuffer())),
    );
    return availabilityFromEntries(domain, shard, entries);
  }
  const url = await registryShardUrl(domain);
  const res = await fetchFn(url);
  if (res.status === 404) return { domain, available: true, shard };
  if (res.status !== 200) {
    throw new Error(`could not check availability for "${domain}": shard fetch failed with HTTP ${res.status}`);
  }
  return availabilityFromEntries(domain, shard, parseShardBody(await res.text()));
}

// ---------------------------------------------------------------------------
// Sub-delegation (delegations.json.zst in the site repo)
// ---------------------------------------------------------------------------

export type DelegationsMap = Record<string, string>;

export interface DelegationsFile {
  version: string;
  /** The parent domain these delegations belong to. */
  domain: string;
  owner: string;
  delegations: DelegationsMap;
}

const BACKEND_RE = /^(gh|gl|cb):[^/\s]+\/[^/\s]+$/;

/** Is this a well-formed pluggable-backend target, e.g.
 *  `gh:sarah/ai-blog`, `gl:sarah/ai-blog`, `cb:sarah/ai-blog`? */
export function isValidBackendTarget(target: string): boolean {
  return BACKEND_RE.test(target.trim());
}

export function parseDelegations(raw: unknown): DelegationsFile {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("delegations file is not an object");
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.domain !== "string" || !validateDomain(d.domain).valid) {
    throw new Error(`delegations file has an invalid domain: ${String(d.domain)}`);
  }
  if (typeof d.delegations !== "object" || d.delegations === null || Array.isArray(d.delegations)) {
    throw new Error(`delegations file for ${d.domain} has no delegations map`);
  }
  const delegations: DelegationsMap = {};
  for (const [sub, target] of Object.entries(d.delegations as Record<string, unknown>)) {
    if (typeof target !== "string" || !isValidBackendTarget(target)) {
      throw new Error(`delegation "${sub}" has an invalid backend target: ${String(target)}`);
    }
    const v = validateDomain(sub);
    if (!v.valid) throw new Error(`delegation "${sub}" is not a valid domain: ${v.reason ?? ""}`);
    delegations[v.domain] = target;
  }
  return {
    version: typeof d.version === "string" ? d.version : "0.1.0",
    domain: normalizeDomain(d.domain),
    owner: typeof d.owner === "string" ? d.owner : "",
    delegations,
  };
}

/** Raw URL of a site repo's delegations file, from its backend
 *  string (`gh:owner/repo`). Plain JSON mirror of
 *  delegations.json.zst; see the note on registryShardUrl. */
export function delegationsRawUrl(backend: string): string {
  const m = /^(gh|gl|cb):([^/]+)\/([^/]+)$/.exec(backend.trim());
  if (!m) throw new Error(`unsupported backend "${backend}" — expected gh:|gl:|cb: owner/repo`);
  if (m[1] !== "gh") {
    throw new Error(`delegations fetch is only wired for gh: backends in this shell (got ${m[1]}:)`);
  }
  return `https://raw.githubusercontent.com/${m[2]}/${m[3]}/main/delegations.json`;
}

/** Fetch + parse a parent site's delegations file (injected fetch).
 *  A 404 means the owner has delegated nothing — an empty map, not
 *  an error. */
export async function fetchDelegations(
  backend: string,
  fetchFn: DomainFetchFn,
): Promise<DelegationsFile> {
  const url = delegationsRawUrl(backend);
  const res = await fetchFn(url);
  if (res.status === 404) {
    return { version: "0.1.0", domain: "", owner: "", delegations: {} };
  }
  if (res.status !== 200) {
    throw new Error(`could not fetch delegations from ${backend}: HTTP ${res.status}`);
  }
  return parseDelegations(JSON.parse(await res.text()));
}

/** Is `subdomain` a proper subdomain of `parent` (strictly below
 *  it, not the parent itself)? */
export function isSubdomainOf(subdomainInput: string, parentInput: string): boolean {
  const sub = normalizeDomain(subdomainInput);
  const parent = normalizeDomain(parentInput);
  return sub.length > parent.length + 1 && sub.endsWith(`.${parent}`);
}

/** Add a sub-delegation. Returns a NEW map (the input is untouched).
 *  Throws when the subdomain is not below the parent, is invalid, or
 *  the target backend is malformed. Overwriting an existing delegation
 *  for the same subdomain is allowed — the owner is re-pointing it —
 *  and is reported via `overwrote`. */
export function addDelegation(
  delegations: DelegationsMap,
  parentDomain: string,
  subdomainInput: string,
  target: string,
): { delegations: DelegationsMap; overwrote: boolean } {
  const v = validateDomain(subdomainInput);
  if (!v.valid) throw new Error(`cannot delegate: ${v.reason ?? "invalid subdomain"}`);
  if (!isSubdomainOf(v.domain, parentDomain)) {
    throw new Error(
      `cannot delegate "${v.domain}": it is not a subdomain of "${normalizeDomain(parentDomain)}" — only the owner of a domain can delegate beneath it.`,
    );
  }
  if (!isValidBackendTarget(target)) {
    throw new Error(`cannot delegate "${v.domain}": "${target}" is not a backend target like gh:owner/repo`);
  }
  const next = { ...delegations };
  const overwrote = Object.prototype.hasOwnProperty.call(next, v.domain);
  next[v.domain] = target.trim();
  return { delegations: next, overwrote };
}

/** Remove a sub-delegation. Returns a NEW map; removing a subdomain
 *  that was never delegated is a no-op reported via `removed: false`. */
export function removeDelegation(
  delegations: DelegationsMap,
  subdomainInput: string,
): { delegations: DelegationsMap; removed: boolean } {
  const domain = normalizeDomain(subdomainInput);
  if (!Object.prototype.hasOwnProperty.call(delegations, domain)) {
    return { delegations: { ...delegations }, removed: false };
  }
  const next = { ...delegations };
  delete next[domain];
  return { delegations: next, removed: true };
}

/** Longest known domain that is a proper parent of `domain`, or null. */
export function findParentDomain(domainInput: string, knownDomains: string[]): string | null {
  const domain = normalizeDomain(domainInput);
  let best: string | null = null;
  for (const candidate of knownDomains) {
    const parent = normalizeDomain(candidate);
    if (isSubdomainOf(domain, parent) && (best === null || parent.length > best.length)) {
      best = parent;
    }
  }
  return best;
}

export type ResolutionVia = "registry" | "delegation" | "parent-delegation" | "unresolved";

export interface DomainResolution {
  domain: string;
  /** Backend target (`gh:owner/repo`), or null when unresolved. */
  backend: string | null;
  via: ResolutionVia;
  /** The registered parent domain, when resolved via a delegation. */
  parentDomain?: string;
  owner?: string;
}

/** Resolution chain: registry → parent domain → delegations →
 *  site.json.zst (the caller fetches site.json.zst from `backend`).
 *  - The domain itself in the registry resolves via "registry".
 *  - An exact hit in the parent's delegations resolves via
 *    "delegation" (delegations passed on their own) or
 *    "parent-delegation" (when the parent registry entry is also
 *    given, so the parent is proven registered).
 *  - Anything else is "unresolved" with backend null. */
export function resolveDomainTarget(
  domainInput: string,
  opts: {
    registryEntry?: RegistryEntry | null;
    parentEntry?: RegistryEntry | null;
    delegations?: DelegationsMap;
  } = {},
): DomainResolution {
  const domain = normalizeDomain(domainInput);
  const { registryEntry, parentEntry, delegations = {} } = opts;
  if (registryEntry && registryEntry.domain === domain) {
    return { domain, backend: registryEntry.backend, via: "registry", owner: registryEntry.owner };
  }
  const delegated = delegations[domain];
  if (delegated) {
    const via: ResolutionVia =
      parentEntry && isSubdomainOf(domain, parentEntry.domain) ? "parent-delegation" : "delegation";
    return {
      domain,
      backend: delegated,
      via,
      parentDomain: parentEntry?.domain,
      owner: parentEntry?.owner,
    };
  }
  return { domain, backend: null, via: "unresolved" };
}

// ---------------------------------------------------------------------------
// Claim state machine: unclaimed → pending → registered / rejected
// ---------------------------------------------------------------------------

export type ClaimStatus = "unclaimed" | "pending" | "registered" | "rejected";

export type RejectionReasonCode =
  | "already_registered"
  | "banned_word"
  | "invalid_domain"
  | "tld_only"
  | "duplicate_pending"
  | "terms_not_accepted";

/** Plain-English reason for each rejection code. */
export const REJECTION_REASONS: Record<RejectionReasonCode, string> = {
  already_registered: "That domain is already registered to someone else.",
  banned_word: "That domain contains a reserved word.",
  invalid_domain: "That domain is not a valid domain string.",
  tld_only: "Whole top-level domains are never registered — only exact full domain strings.",
  duplicate_pending: "A claim for that domain is already waiting to be processed.",
  terms_not_accepted: "The ArkNetzWebWeaver Terms, GitHub ToS and Internet Archive Terms must be accepted before claiming.",
};

export interface DomainClaim {
  domain: string;
  claimant: string;
  status: ClaimStatus;
  /** Present when rejected: the code plus human detail. */
  reasonCode?: RejectionReasonCode;
  reason?: string;
  /** GitHub Issue number / URL, once the claim is filed. */
  issueNumber?: number;
  issueUrl?: string;
  /** Registry backend + owner, once registered. */
  backend?: string;
  owner?: string;
  createdAt: number;
  updatedAt: number;
}

/** A fresh claim, still unclaimed — nothing has been filed yet. */
export function createClaim(domainInput: string, claimant: string, now = Date.now()): DomainClaim {
  const v = validateDomain(domainInput);
  if (!v.valid) throw new Error(`cannot create a claim: ${v.reason ?? "invalid domain"}`);
  const who = claimant.trim();
  if (!who) throw new Error("cannot create a claim: no claimant GitHub login given");
  return { domain: v.domain, claimant: who, status: "unclaimed", createdAt: now, updatedAt: now };
}

/** File the claim (open the REGISTER Issue). Requires Terms
 *  acceptance — the thread's one-click checkbox before a first claim
 *  (turn 33). Returns a NEW claim in "pending". */
export function submitClaim(
  claim: DomainClaim,
  opts: { acceptedTerms: boolean; issueNumber?: number; issueUrl?: string; now?: number },
): DomainClaim {
  if (claim.status !== "unclaimed") {
    throw new Error(`cannot submit a claim in status "${claim.status}" — only an unclaimed domain can be filed`);
  }
  if (!opts.acceptedTerms) {
    throw new Error(REJECTION_REASONS.terms_not_accepted);
  }
  const now = opts.now ?? Date.now();
  return {
    ...claim,
    status: "pending",
    issueNumber: opts.issueNumber,
    issueUrl: opts.issueUrl,
    updatedAt: now,
  };
}

/** The register.yml Action accepted the claim: the registry shard now
 *  holds the entry. Returns a NEW claim in "registered". */
export function approveClaim(
  claim: DomainClaim,
  entry: RegistryEntry,
  now = Date.now(),
): DomainClaim {
  if (claim.status !== "pending") {
    throw new Error(`cannot approve a claim in status "${claim.status}" — only a pending claim can be registered`);
  }
  if (entry.domain !== claim.domain) {
    throw new Error(`cannot approve claim for "${claim.domain}" with a registry entry for "${entry.domain}"`);
  }
  return { ...claim, status: "registered", backend: entry.backend, owner: entry.owner, updatedAt: now };
}

/** The claim was refused. Returns a NEW claim in "rejected" with the
 *  plain-English reason attached. */
export function rejectClaim(
  claim: DomainClaim,
  code: RejectionReasonCode,
  detail?: string,
  now = Date.now(),
): DomainClaim {
  if (claim.status !== "pending" && claim.status !== "unclaimed") {
    throw new Error(`cannot reject a claim in status "${claim.status}" — only an unclaimed or pending claim can be rejected`);
  }
  const base = REJECTION_REASONS[code];
  return {
    ...claim,
    status: "rejected",
    reasonCode: code,
    reason: detail ? `${base} ${detail}` : base,
    updatedAt: now,
  };
}

export type ClaimEvent =
  | { type: "submit"; acceptedTerms: boolean; issueNumber?: number; issueUrl?: string }
  | { type: "approve"; entry: RegistryEntry }
  | { type: "reject"; code: RejectionReasonCode; detail?: string };

/** Drive the claim through one transition, enforcing the legal
 *  moves (unclaimed → pending → registered/rejected). Any other
 *  move throws naming both states — a claim can never go backwards
 *  or skip a step. */
export function advanceClaim(claim: DomainClaim, event: ClaimEvent, now = Date.now()): DomainClaim {
  switch (event.type) {
    case "submit":
      return submitClaim(claim, { ...event, now });
    case "approve":
      return approveClaim(claim, event.entry, now);
    case "reject":
      return rejectClaim(claim, event.code, event.detail, now);
  }
}

/** Current status of a domain from the facts on hand: registered if
 *  it is in a registry shard, pending if a claim is waiting, otherwise
 *  unclaimed. */
export function claimStatusFor(
  domainInput: string,
  shard: ShardEntries,
  pendingClaims: DomainClaim[] = [],
): ClaimStatus {
  const domain = normalizeDomain(domainInput);
  const availability = checkAvailabilityAgainstShard(domain, shard);
  if (!availability.available) return "registered";
  if (pendingClaims.some((c) => c.domain === domain && c.status === "pending")) return "pending";
  return "unclaimed";
}
