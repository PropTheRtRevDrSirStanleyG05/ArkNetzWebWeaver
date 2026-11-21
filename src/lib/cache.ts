// ArkNetzWebWeaver — IndexedDB ETag cache + raw.githubusercontent.com reads.
// Thread turn 11: reads hit raw.githubusercontent.com ONLY (not
// api.github.com — 60/hr unauthenticated). ETag / If-None-Match in
// IndexedDB; a 304 means 0 bytes and ~20 ms. First visit ~12 KB, repeat
// ~0.3 KB. This module is fetch/store injected so it is testable in Node
// without a browser: the browser wires the real IndexedDB store (see
// createIndexedDBStore), tests wire the memory store.

export interface CacheEntry {
  url: string;
  etag: string | null;
  body: string;
  fetchedAt: number;
  /** "utf8" (default) for text bodies, "base64" for binary (.zst) bodies. */
  encoding?: "utf8" | "base64";
}

export interface CacheStore {
  get(url: string): Promise<CacheEntry | undefined>;
  put(entry: CacheEntry): Promise<void>;
  delete(url: string): Promise<void>;
}

export function createMemoryCacheStore(): CacheStore {
  const map = new Map<string, CacheEntry>();
  return {
    async get(url) {
      return map.get(url);
    },
    async put(entry) {
      map.set(entry.url, entry);
    },
    async delete(url) {
      map.delete(url);
    },
  };
}

const IDB_DB = "arknetz-cache";
const IDB_STORE = "responses";

export function createIndexedDBStore(): CacheStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE, { keyPath: "url" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const tx = async (mode: IDBTransactionMode) => {
    const db = await open();
    return { db, store: db.transaction(IDB_STORE, mode).objectStore(IDB_STORE) };
  };
  return {
    async get(url) {
      const { db, store } = await tx("readonly");
      try {
        return await new Promise<CacheEntry | undefined>((resolve, reject) => {
          const r = store.get(url);
          r.onsuccess = () => resolve(r.result as CacheEntry | undefined);
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
    async put(entry) {
      const { db, store } = await tx("readwrite");
      try {
        await new Promise<void>((resolve, reject) => {
          const r = store.put(entry);
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
    async delete(url) {
      const { db, store } = await tx("readwrite");
      try {
        await new Promise<void>((resolve, reject) => {
          const r = store.delete(url);
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface CachedFetchResult {
  body: string;
  fromCache: boolean;
  status: number;
  bytes: number;
}

export type FetchBytesFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface CachedFetchBytesResult {
  /** Null on HTTP 404 with no cached copy (caller falls back). */
  bytes: Uint8Array | null;
  fromCache: boolean;
  status: number;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Fetch with ETag revalidation. On 304 the cached body is returned and
 *  bytes = 0 (only headers crossed the wire). On a network error with a
 *  cached entry, the stale entry is returned with fromCache=true so the
 *  reader keeps working offline — the caller must surface that it is stale
 *  if it matters (the shell does, via `stale` on the result in future work;
 *  for now fromCache + a fresh fetch failure is the signal). */
export class CachedFetcher {
  constructor(
    private readonly store: CacheStore,
    private readonly fetchFn: FetchFn,
    private readonly fetchBytesFn?: FetchBytesFn,
  ) {}

  /** Fetch a binary file (.json.zst) with the same ETag cache. Bytes
   *  are stored base64 in the cache entry. 404 with no cached copy
   *  returns bytes: null so the caller can fall back to plain JSON.
   *  When no bytes fetch is wired, bytes are derived from the text
   *  fetch (correct for plain JSON, never for .zst — the browser wires
   *  a real arrayBuffer fetch in main.ts). */
  async fetchBytes(url: string): Promise<CachedFetchBytesResult> {
    const cached = await this.store.get(url);
    const cachedBytes = cached
      ? cached.encoding === "base64"
        ? b64ToBytes(cached.body)
        : new TextEncoder().encode(cached.body)
      : null;
    const headers: Record<string, string> = { "User-Agent": "ArkNetzWebWeaver/1.0" };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    let status: number;
    let bytes: Uint8Array | null = null;
    let etag: string | null = null;
    try {
      if (this.fetchBytesFn) {
        const res = await this.fetchBytesFn(url, { headers });
        status = res.status;
        etag = res.headers.get("etag");
        if (status === 200) bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        const res = await this.fetchFn(url, { headers });
        status = res.status;
        etag = res.headers.get("etag");
        if (status === 200) bytes = new TextEncoder().encode(await res.text());
      }
    } catch (err) {
      if (cachedBytes) return { bytes: cachedBytes, fromCache: true, status: 304 };
      throw err;
    }
    if (status === 304 && cachedBytes) {
      return { bytes: cachedBytes, fromCache: true, status: 304 };
    }
    if (status === 200 && bytes) {
      await this.store.put({ url, etag, body: bytesToB64(bytes), fetchedAt: Date.now(), encoding: "base64" });
      return { bytes, fromCache: false, status: 200 };
    }
    if (status === 404) {
      if (cachedBytes) return { bytes: cachedBytes, fromCache: true, status: 404 };
      return { bytes: null, fromCache: false, status: 404 };
    }
    if (cachedBytes) return { bytes: cachedBytes, fromCache: true, status };
    throw new Error(`fetch ${url} failed with HTTP ${status}`);
  }

  async fetch(url: string): Promise<CachedFetchResult> {
    const cached = await this.store.get(url);
    const headers: Record<string, string> = {
      "User-Agent": "ArkNetzWebWeaver/1.0",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    let res;
    try {
      res = await this.fetchFn(url, { headers });
    } catch (err) {
      if (cached) {
        return { body: cached.body, fromCache: true, status: 304, bytes: 0 };
      }
      throw err;
    }
    if (res.status === 304 && cached) {
      return { body: cached.body, fromCache: true, status: 304, bytes: 0 };
    }
    if (res.status === 200) {
      const body = await res.text();
      const etag = res.headers.get("etag");
      await this.store.put({ url, etag, body, fetchedAt: Date.now() });
      return { body, fromCache: false, status: 200, bytes: body.length };
    }
    // Any other status: do not cache, do not pretend. If we have a cached
    // copy, hand it back rather than a blank page, and let the caller know
    // via fromCache.
    if (cached) {
      return { body: cached.body, fromCache: true, status: res.status, bytes: 0 };
    }
    throw new Error(`fetch ${url} failed with HTTP ${res.status}`);
  }
}

/** Guard: routine reads must never go to api.github.com. */
export function assertRawReadUrl(url: string): void {
  if (url.includes("api.github.com")) {
    throw new Error(
      `refusing to read ${url} via api.github.com — reads must use raw.githubusercontent.com`,
    );
  }
  if (!url.startsWith("https://raw.githubusercontent.com/")) {
    throw new Error(`refusing to read ${url} — not a raw.githubusercontent.com URL`);
  }
}
