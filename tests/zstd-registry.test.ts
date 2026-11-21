// Tests: registry + site reads go through real Zstd (.json.zst first,
// plain .json on 404, corrupt .zst throws instead of silently falling
// back), and CachedFetcher.fetchBytes caches bytes with ETags.
import test from "node:test";
import assert from "node:assert/strict";
import { CachedFetcher, createMemoryCacheStore } from "../src/lib/cache.js";
import { RegistryResolver, shardForDomain } from "../src/lib/registry.js";
import {
  buildFormattedZstdDictionary,
  compressBytesWithDictionary,
  compressJson,
  decompressBytes,
  decompressBytesWithDictionary,
  getZstdDictionaryContent,
  getZstdDictionaryV2,
} from "../src/lib/zstd.js";

const DOMAIN = "computers.edu";
const SITE = {
  domain: DOMAIN,
  title: "Computers",
  blocks: [
    { type: "h1", text: "Hello" },
    { type: "p", text: "A paragraph." },
  ],
};

async function shardDoc() {
  const shard = await shardForDomain(DOMAIN);
  return {
    [DOMAIN]: {
      domain: DOMAIN,
      backend: "gh:alice/arknetz-site-computers-edu",
      shard,
      owner: "alice",
    },
  };
}

/** A fetcher whose bytes endpoint serves the Zstd shard/site and whose
 *  text endpoint serves the plain fallbacks. Served .zst bytes are
 *  recorded so tests can prove they are dictionary frames. */
function mockFetcher(opts: { zstShard?: boolean; zstSite?: boolean; corruptShard?: boolean }) {
  const bytesHits: string[] = [];
  const textHits: string[] = [];
  const servedZst: Uint8Array[] = [];
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    async (url) => {
      textHits.push(url);
      if (url.endsWith("registry.json")) {
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(await shardDoc()) };
      }
      if (url.endsWith("site.json")) {
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(SITE) };
      }
      return { status: 404, headers: { get: () => null }, text: async () => "" };
    },
    async (url) => {
      bytesHits.push(url);
      const buf = async (bytes: Uint8Array) => {
        servedZst.push(bytes);
        return {
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
      };
      if (url.endsWith("registry.json.zst")) {
        if (opts.corruptShard) return buf(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 9, 9, 9]));
        if (opts.zstShard) return buf(await compressJson(await shardDoc()));
        return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (url.endsWith("site.json.zst")) {
        if (opts.zstSite) return buf(await compressJson(SITE));
        return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  );
  return { fetcher, bytesHits, textHits, servedZst };
}

test("resolve reads registry.json.zst and loadSite reads site.json.zst", async () => {
  const { fetcher, bytesHits, textHits } = mockFetcher({ zstShard: true, zstSite: true });
  const resolver = new RegistryResolver(fetcher);
  const entry = await resolver.resolve(DOMAIN);
  assert.equal(entry.domain, DOMAIN);
  assert.equal(entry.backend, "gh:alice/arknetz-site-computers-edu");
  const site = await resolver.loadSite(DOMAIN);
  assert.deepEqual(site, SITE);
  assert.ok(bytesHits.some((u) => u.endsWith("registry.json.zst")));
  assert.ok(bytesHits.some((u) => u.endsWith("site.json.zst")));
  assert.equal(textHits.length, 0, "no plain-JSON fetch should happen when .zst exists");
});

test("404 on .zst falls back to plain .json for both shard and site", async () => {
  const { fetcher, bytesHits, textHits } = mockFetcher({ zstShard: false, zstSite: false });
  const resolver = new RegistryResolver(fetcher);
  assert.equal((await resolver.resolve(DOMAIN)).domain, DOMAIN);
  assert.deepEqual(await resolver.loadSite(DOMAIN), SITE);
  assert.ok(textHits.some((u) => u.endsWith("registry.json")));
  assert.ok(textHits.some((u) => u.endsWith("site.json")));
  assert.ok(bytesHits.length >= 2, "the .zst was tried first");
});

test("a corrupt .zst shard throws — it does not silently fall back", async () => {
  const { fetcher } = mockFetcher({ zstShard: true, corruptShard: true });
  const resolver = new RegistryResolver(fetcher);
  await assert.rejects(() => resolver.resolve(DOMAIN), /zstd|decompress/i);
});

test("registry/site .zst bytes are plain zstd frames (no dictionary ID) since 2026-11-21", async () => {
  const { fetcher, servedZst } = mockFetcher({ zstShard: true, zstSite: true });
  const resolver = new RegistryResolver(fetcher);
  await resolver.resolve(DOMAIN);
  await resolver.loadSite(DOMAIN);
  // Served frames: the shard (resolve runs once per call, and loadSite
  // resolves again) plus the site — at least two, each a PLAIN zstd
  // frame: DID flag 0 (no dictionary ID) at byte 4. The dictionary
  // was dropped 2026-11-21 (benchmark: zero bytes saved).
  assert.ok(servedZst.length >= 2, `expected shard + site frames, got ${servedZst.length}`);
  for (const frame of servedZst) {
    assert.equal((frame[4] as number) & 3, 0, "frame must carry no dictionary ID (plain zstd)");
  }
  // ...and an OLD v2 dictionary frame still decodes through the same
  // built-in path, while a wrong dictionary refuses it loudly.
  // (0x41524B09: an ID no shipped dictionary uses — NOT v1+1, which
  // is the real v2 ID 0x41524B02 and would match the frame's ID.)
  const input = new TextEncoder().encode(JSON.stringify(await shardDoc()));
  const v2Frame = await compressBytesWithDictionary(input, getZstdDictionaryV2());
  assert.deepEqual(await decompressBytes(v2Frame), input);
  const wrong = buildFormattedZstdDictionary(0x41524b09, getZstdDictionaryContent());
  await assert.rejects(() => decompressBytesWithDictionary(v2Frame, wrong), /decompress/i);
});

test("fetchBytes caches: a 304 returns the cached bytes with fromCache", async () => {
  let calls = 0;
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    async () => ({ status: 404, headers: { get: () => null }, text: async () => "" }),
    async () => {
      calls++;
      if (calls === 1) {
        const bytes = await compressJson({ a: 1 });
        return {
          status: 200,
          headers: { get: (n: string) => (n === "etag" ? '"v1"' : null) },
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
      }
      return { status: 304, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  );
  const first = await fetcher.fetchBytes("https://raw.githubusercontent.com/x/y/main/site.json.zst");
  assert.equal(first.fromCache, false);
  assert.ok(first.bytes && first.bytes.length > 0);
  const second = await fetcher.fetchBytes("https://raw.githubusercontent.com/x/y/main/site.json.zst");
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(calls, 2);
});
