// Tests: sharded registry resolution, parsing, manifest fallback.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CachedFetcher,
  createMemoryCacheStore,
} from "../src/lib/cache.js";
import {
  RegistryResolver,
  defaultManifest,
  parseManifest,
  parseRegistryEntry,
  parseRegistryShard,
  parseSiteDocument,
  registryShardUrl,
  shardForDomain,
  siteRawUrl,
} from "../src/lib/registry.js";
import { MASTER_GITHUB_USER } from "../src/lib/config.js";
import { compressJson } from "../src/lib/zstd.js";

function mockFetch(map: Record<string, { status: number; body: string; etag?: string }>) {
  return async (url: string) => {
    const r = map[url];
    if (!r) return { status: 200, headers: { get: () => null }, text: async () => "{}" };
    return {
      status: r.status,
      headers: { get: (n: string) => (n.toLowerCase() === "etag" ? (r.etag ?? null) : null) },
      text: async () => r.body,
    };
  };
}

/** Bytes fetch for .json.zst URLs: serves real Zstd frames for mapped
 *  URLs, 404 elsewhere (so the reader falls back to plain .json). */
function mockFetchBytes(map: Record<string, Uint8Array>) {
  return async (url: string) => {
    const bytes = map[url];
    if (!bytes) {
      return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };
}

test("shardForDomain is deterministic, one hex digit, and distributes", async () => {
  const a = await shardForDomain("computers.edu");
  const b = await shardForDomain("computers.edu");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]$/);
  const shards = new Set<string>();
  for (const d of ["a.zine", "b.zine", "c.zine", "d.zine", "e.zine", "f.zine", "g.zine", "h.zine"]) {
    shards.add(await shardForDomain(d));
  }
  assert.ok(shards.size > 1, "shards should distribute across domains");
});

test("registryShardUrl points at raw.githubusercontent.com under the master account", async () => {
  const shard = await shardForDomain("computers.edu");
  const url = await registryShardUrl("computers.edu");
  assert.equal(
    url,
    `https://raw.githubusercontent.com/${MASTER_GITHUB_USER}/arknetz-registry-0${shard}/main/registry.json`,
  );
});

test("parseRegistryEntry accepts a good entry and rejects bad domain/backend/shard", () => {
  const good = { domain: "computers.edu", backend: "gh:alice/arknetz-site-computers-edu", shard: "a", owner: "alice" };
  assert.equal(parseRegistryEntry(good).domain, "computers.edu");
  assert.throws(() => parseRegistryEntry({ ...good, domain: "edu" }), /invalid domain/);
  assert.throws(() => parseRegistryEntry({ ...good, backend: "gl:alice/x" }), /invalid backend/);
  assert.throws(() => parseRegistryEntry({ ...good, shard: "zz" }), /invalid shard/);
  assert.throws(() => parseRegistryEntry({ ...good, owner: "" }), /no owner/);
});

test("parseRegistryShard accepts a map and an entries array", () => {
  const entry = { domain: "computers.edu", backend: "gh:alice/arknetz-site-computers-edu", shard: "a", owner: "alice" };
  assert.equal(parseRegistryShard({ "computers.edu": entry }).size, 1);
  assert.equal(parseRegistryShard({ entries: [entry] }).size, 1);
  assert.throws(() => parseRegistryShard({ "x": { domain: "bad" } }), /invalid/);
});

test("parseSiteDocument rejects missing title / blocks", () => {
  assert.throws(() => parseSiteDocument({ domain: "a.zine" }), /no title/);
  assert.throws(() => parseSiteDocument({ domain: "a.zine", title: "t" }), /no blocks/);
  assert.equal(parseSiteDocument({ domain: "a.zine", title: "t", blocks: [] }).title, "t");
});

test("defaultManifest lists 16 registry + 16 contacts shards, master is PropTheRtRevDrSirStanleyG05", () => {
  const m = defaultManifest();
  assert.equal(m.registryShards.length, 16);
  assert.equal(m.contactsShards.length, 16);
  assert.equal(m.masterGithubUser, "PropTheRtRevDrSirStanleyG05");
  assert.equal(m.registryShards[0], "arknetz-registry-00");
  assert.equal(m.registryShards[15], "arknetz-registry-0f");
});

test("parseManifest rejects a manifest with the wrong shard count", () => {
  const m = defaultManifest();
  assert.throws(() => parseManifest({ ...m, registryShards: ["one"] }), /16 registry shards/);
});

test("resolver.resolve fetches the right shard and verifies the entry's shard matches SHA256", async () => {
  const shard = await shardForDomain("computers.edu");
  const url = await registryShardUrl("computers.edu");
  const entry = { domain: "computers.edu", backend: "gh:alice/arknetz-site-computers-edu", shard, owner: "alice" };
  const zstUrl = url.replace(/\.json$/, ".json.zst");
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    mockFetch({ [url]: { status: 200, body: JSON.stringify({ "computers.edu": entry }) } }),
    mockFetchBytes({ [zstUrl]: await compressJson({ "computers.edu": entry }) }),
  );
  const resolver = new RegistryResolver(fetcher);
  assert.equal((await resolver.resolve("computers.edu")).owner, "alice");
  await assert.rejects(() => resolver.resolve("missing.edu"), /not registered/);
});

test("resolver rejects an entry whose shard field disagrees with SHA256", async () => {
  const url = await registryShardUrl("computers.edu");
  const wrongShard = (await shardForDomain("computers.edu")) === "a" ? "b" : "a";
  const entry = { domain: "computers.edu", backend: "gh:alice/arknetz-site-computers-edu", shard: wrongShard, owner: "alice" };
  const zstUrl = url.replace(/\.json$/, ".json.zst");
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    mockFetch({ [url]: { status: 200, body: JSON.stringify({ "computers.edu": entry }) } }),
    mockFetchBytes({ [zstUrl]: await compressJson({ "computers.edu": entry }) }),
  );
  await assert.rejects(() => new RegistryResolver(fetcher).resolve("computers.edu"), /wrong shard/);
});

test("resolver.loadSite tries mirrors in order after the primary fails", async () => {
  const shard = await shardForDomain("computers.edu");
  const shardUrl = await registryShardUrl("computers.edu");
  const entry = {
    domain: "computers.edu",
    backend: "gh:alice/arknetz-site-computers-edu",
    mirrors: ["gh:alice/arknetz-site-computers-edu-mirror"],
    shard,
    owner: "alice",
  };
  const primary = siteRawUrl(entry);
  const mirror = siteRawUrl({ ...entry, backend: entry.mirrors[0] as string });
  const site = { domain: "computers.edu", title: "Computers", blocks: [{ type: "p", text: "hi" }] };
  const shardZstUrl = shardUrl.replace(/\.json$/, ".json.zst");
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    mockFetch({
      [shardUrl]: { status: 200, body: JSON.stringify({ "computers.edu": entry }) },
      [primary]: { status: 404, body: "gone" },
      [mirror]: { status: 200, body: JSON.stringify(site) },
    }),
    mockFetchBytes({ [shardZstUrl]: await compressJson({ "computers.edu": entry }) }),
  );
  const loaded = await new RegistryResolver(fetcher).loadSite("computers.edu");
  assert.equal(loaded.title, "Computers");
});

test("manifest() falls back to the default when protocol-root is unreachable", async () => {
  const fetcher = new CachedFetcher(createMemoryCacheStore(), mockFetch({}));
  const { manifest, fromManifest } = await new RegistryResolver(fetcher).manifest();
  assert.equal(fromManifest, false);
  assert.equal(manifest.masterGithubUser, "PropTheRtRevDrSirStanleyG05");
});

test("defaultManifest publishes the directory category list; parseManifest keeps and validates it", () => {
  const m = defaultManifest();
  assert.deepEqual(m.directoryCategories, ["tech", "cinema", "games"]);
  // A manifest that names a new category parses through unchanged.
  const withMusic = parseManifest({ ...m, directoryCategories: ["tech", "cinema", "games", "music"] });
  assert.deepEqual(withMusic.directoryCategories, ["tech", "cinema", "games", "music"]);
  // An old manifest without the field still parses (fallback in search).
  const { directoryCategories: _dropped, ...old } = m;
  assert.equal(parseManifest(old).directoryCategories, undefined);
  // A bad list fails loudly at parse time, never silently shrinks search.
  assert.throws(() => parseManifest({ ...m, directoryCategories: [] }), /directoryCategories/);
  assert.throws(() => parseManifest({ ...m, directoryCategories: ["Tech News"] }), /directoryCategories/);
  assert.throws(() => parseManifest({ ...m, directoryCategories: "tech" }), /directoryCategories/);
});
