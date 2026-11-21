// Tests: IndexedDB ETag cache (memory store + mock fetch in Node;
// the IndexedDB store itself is exercised in the browser).
import test from "node:test";
import assert from "node:assert/strict";
import {
  CachedFetcher,
  assertRawReadUrl,
  createMemoryCacheStore,
} from "../src/lib/cache.js";

function mockFetch(
  handler: (url: string, headers?: Record<string, string>) => Promise<{ status: number; etag?: string | null; body: string }>,
) {
  return async (url: string, init?: { headers?: Record<string, string> }) => {
    const r = await handler(url, init?.headers);
    return {
      status: r.status,
      headers: { get: (n: string) => (n.toLowerCase() === "etag" ? (r.etag ?? null) : null) },
      text: async () => r.body,
    };
  };
}

const URL = "https://raw.githubusercontent.com/x/y/main/site.json";

test("200 stores body + ETag, second fetch sends If-None-Match and 304 returns cached with 0 bytes", async () => {
  const store = createMemoryCacheStore();
  let seenIfNoneMatch: string | undefined;
  let calls = 0;
  const fetcher = new CachedFetcher(
    store,
    mockFetch(async (_u, headers) => {
      calls++;
      seenIfNoneMatch = headers?.["If-None-Match"];
      if (seenIfNoneMatch === '"abc"') return { status: 304, body: "" };
      return { status: 200, etag: '"abc"', body: '{"title":"hi"}' };
    }),
  );
  const first = await fetcher.fetch(URL);
  assert.equal(first.fromCache, false);
  assert.equal(first.body, '{"title":"hi"}');
  assert.equal(first.bytes, 14);
  const second = await fetcher.fetch(URL);
  assert.equal(second.fromCache, true);
  assert.equal(second.status, 304);
  assert.equal(second.bytes, 0);
  assert.equal(second.body, '{"title":"hi"}');
  assert.equal(calls, 2);
});

test("network error with a cached entry returns the stale cached body", async () => {
  const store = createMemoryCacheStore();
  await store.put({ url: URL, etag: '"e1"', body: "cached", fetchedAt: Date.now() });
  const fetcher = new CachedFetcher(store, async () => {
    throw new Error("offline");
  });
  const r = await fetcher.fetch(URL);
  assert.equal(r.fromCache, true);
  assert.equal(r.body, "cached");
});

test("network error with no cache throws", async () => {
  const fetcher = new CachedFetcher(createMemoryCacheStore(), async () => {
    throw new Error("offline");
  });
  await assert.rejects(() => fetcher.fetch(URL), /offline/);
});

test("HTTP 404 with no cache throws with the status", async () => {
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    mockFetch(async () => ({ status: 404, body: "nope" })),
  );
  await assert.rejects(() => fetcher.fetch(URL), /404/);
});

test("assertRawReadUrl refuses api.github.com and non-raw URLs", () => {
  assert.throws(() => assertRawReadUrl("https://api.github.com/user"), /raw\.githubusercontent/);
  assert.throws(() => assertRawReadUrl("https://example.com/x"), /raw\.githubusercontent/);
  assert.doesNotThrow(() => assertRawReadUrl(URL));
});
