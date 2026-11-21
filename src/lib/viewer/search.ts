// ArkNetzWebWeaver — federated local search (Phase 3a).
// Thread turn 37 + READINESS-PARITY §2: on publish, the client pushes a
// ~150-byte metadata card [domain, title, tags, category,
// updated_timestamp] to a central directory shard
// (directory-<category>.json.zst). The app downloads the shards (a few
// hundred KB for tens of thousands of sites) into IndexedDB and searches
// locally — instant, private, zero trackers — plus Trending and Newly
// Updated feeds.
//
// There is NO MiniSearch dependency installed, so this module implements
// a small dependency-free inverted index in the MiniSearch style:
// tokenise, index, prefix-match, rank. No new dependency, no package.json
// change. All network goes through the injected CachedFetcher; all
// persistence goes through an injected store (memory in tests, IndexedDB
// in the browser, following the cache.ts store pattern).

import { assertRawReadUrl, CachedFetcher } from "../cache.js";
import { MASTER_GITHUB_USER, RAW_GITHUB_BASE } from "../config.js";
import { decompressJson } from "../zstd.js";
import {
  DEFAULT_DIRECTORY_CATEGORIES,
  isValidDirectoryCategory,
  isValidDomain,
} from "../types.js";
import type { ProtocolManifest } from "../types.js";

/** Re-exported for existing import sites (tests, panels). */
export { DEFAULT_DIRECTORY_CATEGORIES } from "../types.js";

// ---------------------------------------------------------------------------
// Metadata card — the ~150-byte unit of the directory.
// ---------------------------------------------------------------------------

export interface MetadataCard {
  domain: string;
  title: string;
  tags: string[];
  category: string;
  /** Unix seconds of the last publish/update. */
  updated_timestamp: number;
}

export function createMetadataCard(input: {
  domain: string;
  title: string;
  tags?: string[];
  category: string;
  updated_timestamp?: number;
}): MetadataCard {
  if (!isValidDomain(input.domain)) throw new Error(`invalid domain in metadata card: ${input.domain}`);
  if (!input.title || input.title.length === 0) throw new Error("metadata card needs a title");
  if (!input.category || input.category.length === 0) throw new Error("metadata card needs a category");
  return {
    domain: input.domain,
    title: input.title,
    tags: (input.tags ?? []).map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0),
    category: input.category.toLowerCase(),
    updated_timestamp: input.updated_timestamp ?? Math.floor(Date.now() / 1000),
  };
}

/** Exact byte size of the card as it ships (compact JSON, UTF-8).
 *  The thread's budget is ~150 bytes; a typical card lands just above
 *  or below it depending on title/tag length. */
export function metadataCardByteSize(card: MetadataCard): number {
  return new TextEncoder().encode(JSON.stringify(card)).length;
}

/** True when the card fits the directory budget: at most 200 bytes
 *  (the ~150-byte target plus headroom for a longer title). Oversized
 *  cards are rejected at publish time, never silently truncated. */
export function isCompactCard(card: MetadataCard): boolean {
  return metadataCardByteSize(card) <= 200;
}

export function parseMetadataCard(raw: unknown): MetadataCard {
  if (typeof raw !== "object" || raw === null) throw new Error("metadata card is not an object");
  const c = raw as Record<string, unknown>;
  if (typeof c.domain !== "string" || !isValidDomain(c.domain)) {
    throw new Error(`metadata card has an invalid domain: ${String(c.domain)}`);
  }
  if (typeof c.title !== "string" || c.title.length === 0) {
    throw new Error(`metadata card for ${c.domain} has no title`);
  }
  if (!Array.isArray(c.tags) || !c.tags.every((t) => typeof t === "string")) {
    throw new Error(`metadata card for ${c.domain} has invalid tags`);
  }
  if (typeof c.category !== "string" || c.category.length === 0) {
    throw new Error(`metadata card for ${c.domain} has no category`);
  }
  if (typeof c.updated_timestamp !== "number") {
    throw new Error(`metadata card for ${c.domain} has no updated_timestamp`);
  }
  return {
    domain: c.domain,
    title: c.title,
    tags: c.tags as string[],
    category: c.category,
    updated_timestamp: c.updated_timestamp,
  };
}

// ---------------------------------------------------------------------------
// Directory shard — directory-<category>.json.zst in its own per-category
// repo, arknetz-directory-<category> (REPO-TOPOLOGY.md §8, approved by
// Stanley 2026-11-20; thread turn 37 names tech / cinema / games).
//
// MANIFEST-DISCOVERABLE CATEGORIES (fix round 3, item 4): the category
// list now comes from the protocol-root manifest's
// `directoryCategories` field (ProtocolManifest in ../types.ts) via
// directoryCategoriesFromManifest() below. The documented default
// DEFAULT_DIRECTORY_CATEGORIES is ONLY the fallback when a manifest
// has no field (old manifest, or the built-in default before the
// field existed) — callers must not hardcode the list anymore.
// Load with loadDirectoryShardsFromManifest(manifest, fetcher); the
// plain loadDirectoryShards(categories, fetcher) stays for callers
// that already know their categories.
// ---------------------------------------------------------------------------

export interface DirectoryShard {
  category: string;
  version: number;
  updated: number; // unix seconds the shard was last rebuilt
  cards: MetadataCard[];
}

/** Repo holding one category's directory shard, e.g.
 *  `arknetz-directory-tech`. Throws on an invalid category slug so a
 *  typo'd category fails loudly instead of fetching a nonsense URL
 *  that 404s and gets silently skipped. */
export function directoryShardRepoName(category: string): string {
  const slug = category.toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(
      `invalid directory category "${category}" — use a lowercase slug like "tech"`,
    );
  }
  return `arknetz-directory-${slug}`;
}

export function directoryShardUrl(category: string): string {
  return `${RAW_GITHUB_BASE}/${MASTER_GITHUB_USER}/${directoryShardRepoName(category)}/main/directory-${category.toLowerCase()}.json`;
}

export function directoryShardZstUrl(category: string): string {
  return directoryShardUrl(category).replace(/\.json$/, ".json.zst");
}

export function parseDirectoryShard(raw: unknown): DirectoryShard {
  if (typeof raw !== "object" || raw === null) throw new Error("directory shard is not an object");
  const s = raw as Record<string, unknown>;
  if (typeof s.category !== "string" || s.category.length === 0) {
    throw new Error("directory shard has no category");
  }
  if (!Array.isArray(s.cards)) throw new Error(`directory shard ${s.category} has no cards array`);
  return {
    category: s.category,
    version: typeof s.version === "number" ? s.version : 1,
    updated: typeof s.updated === "number" ? s.updated : 0,
    cards: s.cards.map((c) => parseMetadataCard(c)),
  };
}

/** Load one directory shard: `.json.zst` first, plain `.json` on 404 —
 *  the same pattern as registry shards. A .zst that downloads but fails
 *  to decompress is corrupt and throws; it does NOT silently fall back.
 *  A shard whose `category` field does not match the requested category
 *  is the wrong shard (e.g. a mis-published file) and throws loudly
 *  instead of indexing another category's cards under this one. */
export async function loadDirectoryShard(category: string, fetcher: CachedFetcher): Promise<DirectoryShard> {
  const wanted = category.toLowerCase();
  const zstUrl = directoryShardZstUrl(category);
  assertRawReadUrl(zstUrl);
  const zst = await fetcher.fetchBytes(zstUrl);
  const parsed = zst.bytes
    ? parseDirectoryShard(await decompressJson(zst.bytes))
    : await (async () => {
        const url = directoryShardUrl(category);
        assertRawReadUrl(url);
        const res = await fetcher.fetch(url);
        return parseDirectoryShard(JSON.parse(res.body));
      })();
  if (parsed.category.toLowerCase() !== wanted) {
    throw new Error(
      `directory shard for "${wanted}" has category "${parsed.category}" — wrong shard, refusing to index it`,
    );
  }
  return parsed;
}

/** Load several category shards, skipping any category that 404s (a
 *  category with no sites yet simply has no shard). Any other failure
 *  throws — a corrupt shard must be loud, not silently skipped. */
export async function loadDirectoryShards(
  categories: string[],
  fetcher: CachedFetcher,
): Promise<DirectoryShard[]> {
  const out: DirectoryShard[] = [];
  for (const category of categories) {
    try {
      out.push(await loadDirectoryShard(category, fetcher));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP 404|failed with HTTP 404/.test(msg)) continue;
      throw err;
    }
  }
  return out;
}

/** Categories to search, from a protocol-root manifest. The manifest
 *  wins when it carries a `directoryCategories` field; otherwise the
 *  documented default stands (old manifests, offline fallback). A
 *  manifest field that is present but not a non-empty array of valid
 *  slugs is a corrupt manifest and throws — a half-published category
 *  list must never silently shrink search to nothing. `null` /
 *  `undefined` (no manifest fetched yet) also falls back to the
 *  default. */
export function directoryCategoriesFromManifest(
  manifest: ProtocolManifest | null | undefined,
): string[] {
  const field = manifest?.directoryCategories;
  if (field === undefined) return [...DEFAULT_DIRECTORY_CATEGORIES];
  if (!Array.isArray(field) || field.length === 0) {
    throw new Error(
      "protocol manifest has an invalid directoryCategories field — it must be a non-empty array of category slugs",
    );
  }
  for (const category of field) {
    if (typeof category !== "string" || !isValidDirectoryCategory(category)) {
      throw new Error(
        `protocol manifest lists an invalid directory category: ${JSON.stringify(category)} — use a lowercase slug like "tech"`,
      );
    }
  }
  return [...field];
}

/** Load the directory shards named by a manifest (or the default list
 *  when the manifest has no field) — the call the shell makes after
 *  fetching the protocol-root manifest. Same 404-skip / corrupt-throw
 *  contract as loadDirectoryShards. */
export async function loadDirectoryShardsFromManifest(
  manifest: ProtocolManifest | null | undefined,
  fetcher: CachedFetcher,
): Promise<DirectoryShard[]> {
  return loadDirectoryShards(directoryCategoriesFromManifest(manifest), fetcher);
}

// ---------------------------------------------------------------------------
// Tokenisation + dependency-free inverted index (MiniSearch style).
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "by", "at", "from", "as", "it", "its", "this", "that",
]);

/** Lowercase, split on anything that is not a letter/digit, drop
 *  stopwords and 1-character tokens. Domain dots and hyphens split too,
 *  so "computers.edu" indexes as ["computers", "edu"]. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Field weights for ranking: a title hit beats a tag hit, which beats
 *  a domain hit. */
export const FIELD_WEIGHTS = { title: 3, tags: 2, domain: 1 } as const;

export interface SearchHit {
  card: MetadataCard;
  /** Higher is a better match. */
  score: number;
  /** Query terms that matched, after prefix expansion. */
  matchedTerms: string[];
}

export interface SearchOptions {
  /** Maximum hits to return (default 20). */
  limit?: number;
  /** Only cards in this category (exact match, lowercase). */
  category?: string;
}

/** Inverted index over metadata cards. Prefix matching: a query term
 *  matches any indexed term that STARTS WITH it ("comp" matches
 *  "computers"), so search works as the user types. Exact-term matches
 *  score double a prefix match. */
export class LocalSearchIndex {
  private cards = new Map<string, MetadataCard>();
  /** term -> domain -> accumulated weight (title 3 / tags 2 / domain 1). */
  private postings = new Map<string, Map<string, number>>();

  get size(): number {
    return this.cards.size;
  }

  get termCount(): number {
    return this.postings.size;
  }

  addCard(card: MetadataCard): void {
    this.removeCard(card.domain);
    this.cards.set(card.domain, card);
    const add = (term: string, weight: number) => {
      let entry = this.postings.get(term);
      if (!entry) {
        entry = new Map<string, number>();
        this.postings.set(term, entry);
      }
      entry.set(card.domain, (entry.get(card.domain) ?? 0) + weight);
    };
    for (const t of tokenize(card.title)) add(t, FIELD_WEIGHTS.title);
    for (const tag of card.tags) {
      for (const t of tokenize(tag)) add(t, FIELD_WEIGHTS.tags);
    }
    for (const t of tokenize(card.domain)) add(t, FIELD_WEIGHTS.domain);
  }

  addCards(cards: MetadataCard[]): void {
    for (const c of cards) this.addCard(c);
  }

  removeCard(domain: string): void {
    if (!this.cards.has(domain)) return;
    this.cards.delete(domain);
    for (const [term, entry] of this.postings) {
      entry.delete(domain);
      if (entry.size === 0) this.postings.delete(term);
    }
  }

  getCard(domain: string): MetadataCard | undefined {
    return this.cards.get(domain);
  }

  allCards(): MetadataCard[] {
    return [...this.cards.values()];
  }

  search(query: string, opts?: SearchOptions): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const scores = new Map<string, { score: number; matched: Set<string> }>();
    for (const q of terms) {
      for (const [term, entry] of this.postings) {
        if (!term.startsWith(q)) continue;
        const exact = term === q;
        for (const [domain, weight] of entry) {
          const hit = scores.get(domain) ?? { score: 0, matched: new Set<string>() };
          hit.score += weight * (exact ? 2 : 1);
          hit.matched.add(term);
          scores.set(domain, hit);
        }
      }
    }
    const limit = opts?.limit ?? 20;
    return [...scores.entries()]
      .map(([domain, hit]) => ({ card: this.cards.get(domain) as MetadataCard, score: hit.score, matchedTerms: [...hit.matched].sort() }))
      .filter((h) => h.card !== undefined)
      .filter((h) => !opts?.category || h.card.category === opts.category.toLowerCase())
      .sort((a, b) => b.score - a.score || b.card.updated_timestamp - a.card.updated_timestamp)
      .slice(0, limit);
  }

  /** Serialise the whole index (cards only — the postings rebuild on
   *  load) for the IndexedDB store. */
  serialize(): { version: 1; cards: MetadataCard[] } {
    return { version: 1, cards: this.allCards() };
  }

  static deserialize(raw: unknown): LocalSearchIndex {
    const index = new LocalSearchIndex();
    if (typeof raw !== "object" || raw === null) throw new Error("search index snapshot is not an object");
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.cards)) throw new Error("search index snapshot has no cards array");
    index.addCards(obj.cards.map((c) => parseMetadataCard(c)));
    return index;
  }
}

// ---------------------------------------------------------------------------
// Index persistence: in-memory store interface + IndexedDB store,
// following the cache.ts store pattern (keyPath "key").
// ---------------------------------------------------------------------------

export interface SearchIndexStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createMemorySearchStore(): SearchIndexStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const IDB_DB = "arknetz-search";
const IDB_STORE = "index";
const INDEX_KEY = "directory-index";

export function createIndexedDBSearchStore(): SearchIndexStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const tx = async (mode: IDBTransactionMode) => {
    const db = await open();
    return { db, store: db.transaction(IDB_STORE, mode).objectStore(IDB_STORE) };
  };
  return {
    async get(key) {
      const { db, store } = await tx("readonly");
      try {
        const row = await new Promise<{ key: string; value: unknown } | undefined>((resolve, reject) => {
          const r = store.get(key);
          r.onsuccess = () => resolve(r.result as { key: string; value: unknown } | undefined);
          r.onerror = () => reject(r.error);
        });
        return row?.value;
      } finally {
        db.close();
      }
    },
    async put(key, value) {
      const { db, store } = await tx("readwrite");
      try {
        await new Promise<void>((resolve, reject) => {
          const r = store.put({ key, value });
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
    async delete(key) {
      const { db, store } = await tx("readwrite");
      try {
        await new Promise<void>((resolve, reject) => {
          const r = store.delete(key);
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

/** Save the index snapshot; load it back (empty index when nothing was
 *  saved yet). The coordinator calls save after loading shards and load
 *  on startup, so search works offline from the last downloaded shards. */
export async function saveSearchIndex(index: LocalSearchIndex, store: SearchIndexStore): Promise<void> {
  await store.put(INDEX_KEY, index.serialize());
}

export async function loadSearchIndex(store: SearchIndexStore): Promise<LocalSearchIndex> {
  const raw = await store.get(INDEX_KEY);
  if (raw === undefined) return new LocalSearchIndex();
  return LocalSearchIndex.deserialize(raw);
}

// ---------------------------------------------------------------------------
// Feeds: Trending (most commented/reacted in the last 7 days) and
// Newly Updated (by updated_timestamp).
// ---------------------------------------------------------------------------

export const TRENDING_WINDOW_SECONDS = 7 * 24 * 3600;

export interface SiteActivity {
  domain: string;
  /** Visible comments in the window. */
  comments: number;
  /** Reactions in the window. */
  reactions: number;
  /** Unix seconds of the most recent comment/reaction, 0 if none. */
  lastActivityAt: number;
}

export interface TrendingEntry {
  card: MetadataCard;
  comments: number;
  reactions: number;
  /** comments + reactions, the ranking score. */
  activityScore: number;
}

/** Trending: sites with the most comment/reaction activity in the last
 *  7 days. Activity older than the window does not count, and a site
 *  with no activity in the window does not appear at all. Ties break by
 *  most recent activity, then by most recent update. */
export function buildTrendingFeed(
  cards: MetadataCard[],
  activity: SiteActivity[],
  now?: number,
): TrendingEntry[] {
  const at = now ?? Math.floor(Date.now() / 1000);
  const windowStart = at - TRENDING_WINDOW_SECONDS;
  const byDomain = new Map(cards.map((c) => [c.domain, c]));
  return activity
    .filter((a) => a.lastActivityAt >= windowStart && a.comments + a.reactions > 0)
    .map((a) => {
      const card = byDomain.get(a.domain);
      if (!card) return null;
      return {
        card,
        comments: a.comments,
        reactions: a.reactions,
        activityScore: a.comments + a.reactions,
      };
    })
    .filter((e): e is TrendingEntry => e !== null)
    .sort(
      (a, b) =>
        b.activityScore - a.activityScore ||
        (activity.find((x) => x.domain === b.card.domain)?.lastActivityAt ?? 0) -
          (activity.find((x) => x.domain === a.card.domain)?.lastActivityAt ?? 0) ||
        b.card.updated_timestamp - a.card.updated_timestamp,
    );
}

/** Newly Updated: every known site, newest publish first. */
export function buildNewlyUpdatedFeed(cards: MetadataCard[], limit = 20): MetadataCard[] {
  return [...cards]
    .sort((a, b) => b.updated_timestamp - a.updated_timestamp || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Search history — stored locally only, never sent anywhere.
// ---------------------------------------------------------------------------

export const MAX_SEARCH_HISTORY = 20;

export class SearchHistory {
  constructor(private readonly store: SearchIndexStore) {}

  private static readonly KEY = "search-history";

  async record(query: string): Promise<void> {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return;
    const history = await this.list();
    const next = [q, ...history.filter((h) => h !== q)].slice(0, MAX_SEARCH_HISTORY);
    await this.store.put(SearchHistory.KEY, next);
  }

  async list(): Promise<string[]> {
    const raw = await this.store.get(SearchHistory.KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === "string");
  }

  async clear(): Promise<void> {
    await this.store.delete(SearchHistory.KEY);
  }
}
