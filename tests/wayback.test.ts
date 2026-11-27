// Tests: Wayback fetch adapter — Rust `wayback_fetch` command in Tauri,
// plain fetch outside it (hunt 5, P1).
import test from "node:test";
import assert from "node:assert/strict";
import { listSnapshots, waybackFetch } from "../src/lib/network/wayback.js";

const scope = globalThis as unknown as {
  __TAURI__?: { core: { invoke(cmd: string, args?: unknown): Promise<unknown> } };
  fetch?: typeof fetch;
};

function installMockTauri(
  handler: (cmd: string, args?: unknown) => Promise<unknown>,
): () => void {
  const prevTauri = scope.__TAURI__;
  const prevFetch = scope.fetch;
  scope.__TAURI__ = { core: { invoke: handler } };
  // A fetch that FAILS LOUDLY if touched — proves the invoke path never
  // falls back to window.fetch when Tauri is present.
  scope.fetch = (() => {
    throw new Error("fetch must not be used when __TAURI__ is present");
  }) as unknown as typeof fetch;
  return () => {
    if (prevTauri === undefined) delete scope.__TAURI__;
    else scope.__TAURI__ = prevTauri;
    if (prevFetch === undefined) delete scope.fetch;
    else scope.fetch = prevFetch;
  };
}

const CDX_BODY = JSON.stringify([
  ["timestamp", "original", "statuscode", "mimetype", "digest"],
  ["20261120120000", "https://example.com/site.json.zst", "200", "application/zstd", "abc123"],
]);

test("hunt 5 (P1): waybackFetch uses wayback_fetch (invoke) when __TAURI__ is present — fetch never called", async () => {
  const seen: Array<{ cmd: string; args?: unknown }> = [];
  const restore = installMockTauri(async (cmd, args) => {
    seen.push({ cmd, args });
    return { status: 200, body: CDX_BODY, error: null };
  });
  try {
    const res = await waybackFetch("https://web.archive.org/cdx/search/cdx?url=example.com");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.cmd, "wayback_fetch");
    assert.equal((seen[0]?.args as { url: string }).url, "https://web.archive.org/cdx/search/cdx?url=example.com");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), CDX_BODY);
    assert.equal(res.headers.get("Content-Type"), null);
  } finally {
    restore();
  }
});

test("hunt 5 (P1): listSnapshots parses CDX through the invoke path", async () => {
  const restore = installMockTauri(async () => ({ status: 200, body: CDX_BODY, error: null }));
  try {
    const snaps = await listSnapshots("https://example.com/site.json.zst", waybackFetch);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]?.timestamp, "20261120120000");
    assert.equal(snaps[0]?.digest, "abc123");
  } finally {
    restore();
  }
});

test("hunt 5 (P1): a Rust-side error becomes a thrown Error, not a silent empty result", async () => {
  const restore = installMockTauri(async () => ({
    status: 0,
    body: null,
    error: "Wayback fetch only allows https://web.archive.org URLs",
  }));
  try {
    await assert.rejects(
      () => waybackFetch("https://example.com/"),
      /only allows https:\/\/web\.archive\.org/,
    );
  } finally {
    restore();
  }
});

test("hunt 5 (P1): a non-200 CDX status still throws with the status", async () => {
  const restore = installMockTauri(async () => ({ status: 429, body: "", error: null }));
  try {
    await assert.rejects(
      () => listSnapshots("https://example.com/site.json.zst", waybackFetch),
      /HTTP 429/,
    );
  } finally {
    restore();
  }
});

test("hunt 5 (P1): without __TAURI__, waybackFetch is the plain global fetch", async () => {
  const prevTauri = scope.__TAURI__;
  const prevFetch = scope.fetch;
  delete scope.__TAURI__;
  let fetchedUrl = "";
  scope.fetch = (async (url: unknown) => {
    fetchedUrl = String(url);
    return { status: 200, headers: new Headers(), text: async () => CDX_BODY };
  }) as unknown as typeof fetch;
  try {
    const res = await waybackFetch("https://web.archive.org/cdx/search/cdx?url=example.com");
    assert.equal(fetchedUrl, "https://web.archive.org/cdx/search/cdx?url=example.com");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), CDX_BODY);
  } finally {
    if (prevTauri === undefined) delete scope.__TAURI__;
    else scope.__TAURI__ = prevTauri;
    if (prevFetch === undefined) delete scope.fetch;
    else scope.fetch = prevFetch;
  }
});
