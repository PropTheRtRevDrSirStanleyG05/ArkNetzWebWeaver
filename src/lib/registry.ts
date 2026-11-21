// ArkNetzWebWeaver — sharded registry resolution.
// Thread turns 1-2, 27-29 + REPO-TOPOLOGY.md: the central registry is split
// into 16 hash shards (arknetz-registry-00..0f) by the first hex digit of
// SHA256(domain), expandable to 256 shards (00-ff) without moving domains.
// The protocol-root manifest is fetched first; if it is unreachable the
// client falls back to the IndexedDB-cached manifest (topology §3).

import {
  CONTACTS_SHARD_COUNT,
  DEFAULT_ROOT_REPO,
  MASTER_GITHUB_USER,
  RAW_GITHUB_BASE,
  REGISTRY_SHARD_COUNT,
  contactsShardRepo,
  protocolRootRawUrl,
  registryShardRepo,
} from "./config.js";
import { assertRawReadUrl, CachedFetcher } from "./cache.js";
import { decompressJson } from "./zstd.js";
import type { ProtocolManifest, RegistryEntry, SiteDocument } from "./types.js";
import {
  DEFAULT_DIRECTORY_CATEGORIES,
  isValidDirectoryCategory,
  isValidDomain,
} from "./types.js";

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** First hex digit of SHA256(domain). Pure function — the shard key. */
export async function shardForDomain(domain: string): Promise<string> {
  const hex = await sha256Hex(domain.toLowerCase());
  return hex[0] as string;
}

export async function registryShardUrl(domain: string): Promise<string> {
  const shard = await shardForDomain(domain);
  const repo = registryShardRepo(shard);
  return `${RAW_GITHUB_BASE}/${MASTER_GITHUB_USER}/${repo}/main/registry.json`;
}

/** The Zstd form of a shard: registry.json.zst. Readers try this
 *  first and fall back to plain registry.json on 404. */
export async function registryShardZstUrl(domain: string): Promise<string> {
  return (await registryShardUrl(domain)).replace(/\.json$/, ".json.zst");
}

export async function contactsShardUrl(address: string): Promise<string> {
  const hex = await sha256Hex(address.toLowerCase());
  const shard = hex[0] as string;
  const repo = contactsShardRepo(shard);
  return `${RAW_GITHUB_BASE}/${MASTER_GITHUB_USER}/${repo}/main/contacts.json`;
}

export function siteRawUrl(entry: RegistryEntry): string {
  // backend is "gh:<owner>/<repo>" — the site repo, e.g.
  // gh:alice/arknetz-site-computers-edu. Mirrors are tried by the caller.
  const m = /^gh:([^/]+)\/([^/]+)$/.exec(entry.backend);
  if (!m) throw new Error(`unsupported backend "${entry.backend}" — only gh: is wired in the shell`);
  return `${RAW_GITHUB_BASE}/${m[1]}/${m[2]}/main/site.json`;
}

/** The Zstd form of a site document: site.json.zst. Readers try this
 *  first and fall back to plain site.json on 404. */
export function siteZstUrl(entry: RegistryEntry): string {
  return siteRawUrl(entry).replace(/\.json$/, ".json.zst");
}

export function parseRegistryEntry(raw: unknown): RegistryEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("registry entry is not an object");
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.domain !== "string" || !isValidDomain(e.domain)) {
    throw new Error(`registry entry has an invalid domain: ${String(e.domain)}`);
  }
  if (typeof e.backend !== "string" || !e.backend.startsWith("gh:")) {
    throw new Error(`registry entry for ${e.domain} has an invalid backend: ${String(e.backend)}`);
  }
  if (typeof e.shard !== "string" || !/^[0-9a-f]$/.test(e.shard)) {
    throw new Error(`registry entry for ${e.domain} has an invalid shard: ${String(e.shard)}`);
  }
  if (typeof e.owner !== "string" || e.owner.length === 0) {
    throw new Error(`registry entry for ${e.domain} has no owner`);
  }
  return {
    domain: e.domain,
    backend: e.backend,
    mirrors: Array.isArray(e.mirrors) ? (e.mirrors as string[]) : undefined,
    shard: e.shard,
    owner: e.owner,
    updated: typeof e.updated === "number" ? e.updated : undefined,
  };
}

/** Parse a whole shard file: { "domain": RegistryEntry, ... } or
 *  { entries: RegistryEntry[] }. Unknown fields are ignored; a bad entry
 *  throws with the domain in the message so a corrupt shard is loud. */
export function parseRegistryShard(raw: unknown): Map<string, RegistryEntry> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("registry shard is not an object");
  }
  const out = new Map<string, RegistryEntry>();
  const obj = raw as Record<string, unknown>;
  const list: unknown[] = Array.isArray(obj.entries)
    ? obj.entries
    : Object.values(obj);
  for (const item of list) {
    const entry = parseRegistryEntry(item);
    out.set(entry.domain, entry);
  }
  return out;
}

export function parseSiteDocument(raw: unknown): SiteDocument {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("site document is not an object");
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.domain !== "string" || !isValidDomain(s.domain)) {
    throw new Error(`site document has an invalid domain: ${String(s.domain)}`);
  }
  if (typeof s.title !== "string" || s.title.length === 0) {
    throw new Error(`site document for ${s.domain} has no title`);
  }
  if (!Array.isArray(s.blocks)) {
    throw new Error(`site document for ${s.domain} has no blocks array`);
  }
  return s as unknown as SiteDocument;
}

export function parseManifest(raw: unknown): ProtocolManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("protocol manifest is not an object");
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.protocolVersion !== "string") throw new Error("manifest has no protocolVersion");
  if (typeof m.masterGithubUser !== "string") throw new Error("manifest has no masterGithubUser");
  if (!Array.isArray(m.registryShards) || m.registryShards.length !== REGISTRY_SHARD_COUNT) {
    throw new Error(`manifest must list ${REGISTRY_SHARD_COUNT} registry shards`);
  }
  if (!Array.isArray(m.contactsShards) || m.contactsShards.length !== CONTACTS_SHARD_COUNT) {
    throw new Error(`manifest must list ${CONTACTS_SHARD_COUNT} contacts shards`);
  }
  // directoryCategories (fix round 3, item 4): optional — an old
  // manifest without the field falls back to the documented default
  // in search. When present it must be a non-empty array of valid
  // slugs, so a half-published category list fails loudly at parse
  // time instead of silently shrinking search.
  let directoryCategories: string[] | undefined;
  if (m.directoryCategories !== undefined) {
    if (
      !Array.isArray(m.directoryCategories) ||
      m.directoryCategories.length === 0 ||
      !m.directoryCategories.every(
        (c) => typeof c === "string" && isValidDirectoryCategory(c),
      )
    ) {
      throw new Error(
        "manifest has an invalid directoryCategories field — it must be a non-empty array of lowercase category slugs",
      );
    }
    directoryCategories = [...(m.directoryCategories as string[])];
  }
  return {
    protocolVersion: m.protocolVersion,
    defaultRootRepo:
      typeof m.defaultRootRepo === "string" ? m.defaultRootRepo : DEFAULT_ROOT_REPO,
    masterGithubUser: m.masterGithubUser,
    registryShards: m.registryShards as string[],
    contactsShards: m.contactsShards as string[],
    mirrors: Array.isArray(m.mirrors) ? (m.mirrors as string[]) : undefined,
    directoryCategories,
  };
}

export function defaultManifest(): ProtocolManifest {
  const shards = Array.from({ length: REGISTRY_SHARD_COUNT }, (_, i) =>
    registryShardRepo(i.toString(16)),
  );
  return {
    protocolVersion: "0.1.0",
    defaultRootRepo: DEFAULT_ROOT_REPO,
    masterGithubUser: MASTER_GITHUB_USER,
    registryShards: shards,
    contactsShards: Array.from({ length: CONTACTS_SHARD_COUNT }, (_, i) =>
      contactsShardRepo(i.toString(16)),
    ),
    // The protocol root publishes the category list: a new category
    // appears in search as soon as the manifest names it. This
    // built-in default publishes the documented default list.
    directoryCategories: [...DEFAULT_DIRECTORY_CATEGORIES],
  };
}

export class RegistryResolver {
  constructor(private readonly fetcher: CachedFetcher) {}

  /** Fetch the protocol-root manifest; on any failure fall back to the
   *  built-in default (same shard list, same master) so resolution still
   *  works offline. The caller can tell it is a fallback because
   *  `fromManifest` is false. */
  async manifest(): Promise<{ manifest: ProtocolManifest; fromManifest: boolean }> {
    const url = protocolRootRawUrl();
    try {
      assertRawReadUrl(url);
      const res = await this.fetcher.fetch(url);
      return { manifest: parseManifest(JSON.parse(res.body)), fromManifest: true };
    } catch {
      return { manifest: defaultManifest(), fromManifest: false };
    }
  }

  /** Resolve a domain to its RegistryEntry via its hash shard.
   *  Tries registry.json.zst first, plain registry.json on 404. A
   *  .zst that downloads but fails to decompress is a corrupt shard
   *  and throws — it does NOT silently fall back to the plain file. */
  async resolve(domain: string): Promise<RegistryEntry> {
    if (!isValidDomain(domain)) throw new Error(`invalid domain: ${domain}`);
    const zstUrl = await registryShardZstUrl(domain);
    assertRawReadUrl(zstUrl);
    const zst = await this.fetcher.fetchBytes(zstUrl);
    let shard: Map<string, RegistryEntry>;
    if (zst.bytes) {
      shard = parseRegistryShard(await decompressJson(zst.bytes));
    } else {
      const url = await registryShardUrl(domain);
      assertRawReadUrl(url);
      const res = await this.fetcher.fetch(url);
      shard = parseRegistryShard(JSON.parse(res.body));
    }
    const entry = shard.get(domain.toLowerCase());
    if (!entry) throw new Error(`domain not registered: ${domain}`);
    const shardHex = await shardForDomain(domain);
    if (entry.shard !== shardHex) {
      throw new Error(
        `registry entry for ${domain} is in the wrong shard: entry says ${entry.shard}, SHA256 says ${shardHex}`,
      );
    }
    return entry;
  }

  /** Resolve + fetch the site document, trying mirrors in order.
   *  Tries site.json.zst first, plain site.json on 404, per backend. */
  async loadSite(domain: string): Promise<SiteDocument> {
    const entry = await this.resolve(domain);
    const backends = [entry.backend, ...(entry.mirrors ?? [])];
    let lastError: unknown = null;
    for (const backend of backends) {
      try {
        const zstUrl = siteZstUrl({ ...entry, backend });
        assertRawReadUrl(zstUrl);
        const zst = await this.fetcher.fetchBytes(zstUrl);
        if (zst.bytes) return parseSiteDocument(await decompressJson(zst.bytes));
        const url = siteRawUrl({ ...entry, backend });
        assertRawReadUrl(url);
        const res = await this.fetcher.fetch(url);
        return parseSiteDocument(JSON.parse(res.body));
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `could not load site ${domain} from any backend: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}
