// Tests: Phase 4b — pluggable backends, Wayback Machine, multi-account,
// ToS. ALL network is mocked here — no test ever hits real GitHub, GitLab,
// Codeberg, Hugging Face, Wikimedia, Internet Archive, Filebase, or the
// Wayback Machine.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKENDS,
  assertUploadAllowed,
  backendFor,
  parseBackendUri,
  readBackendUri,
  readRegistryEntry,
  readWithMirrors,
  uploadTargetsFor,
} from "../src/lib/network/backends.js";
import type { NetworkFetch } from "../src/lib/network/backends.js";
import {
  buildCdxUrl,
  buildSavePageNowRequest,
  fetchLatestSnapshot,
  fetchWithWaybackFailover,
  latestSnapshot,
  listSnapshots,
  parseCdxJson,
  snapshotDisplayDate,
  snapshotToWayback,
} from "../src/lib/network/wayback.js";
import {
  AccountKeyring,
  createMemoryKeyringStore,
  decryptSecret,
  encryptSecret,
} from "../src/lib/network/accounts.js";
import { MASTER_GITHUB_USER } from "../src/lib/config.js";
import {
  TOS_VERSION,
  createMemoryTosStore,
  gateFirstAction,
  guestAcceptableUseNotice,
  recordAcceptance,
} from "../src/lib/network/tos.js";
import {
  accountSwitcherPillView,
  rootRegistriesView,
  siteBindingView,
} from "../src/lib/network/accounts-ui.js";
import {
  backendPickerView,
  mirrorStatusView,
  timeMachineView,
} from "../src/lib/network/backends-ui.js";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function res(status: number, body: string) {
  return {
    status,
    headers: { get: (_name: string) => null as string | null },
    text: async () => body,
  };
}

function mockFetch(
  handler: (url: string) => { status: number; body: string } | Promise<{ status: number; body: string }>,
): { fetchFn: NetworkFetch; seen: string[] } {
  const seen: string[] = [];
  const fetchFn: NetworkFetch = async (url) => {
    seen.push(url);
    const r = await handler(url);
    return res(r.status, r.body);
  };
  return { fetchFn, seen };
}

// ---------------------------------------------------------------------------
// URI parsing — all 7 prefixes
// ---------------------------------------------------------------------------

test("parseBackendUri: gh: parses owner/repo/path", () => {
  const u = parseBackendUri("gh:alice/arknetz-site-computers-edu/site.json.zst");
  assert.equal(u.prefix, "gh");
  assert.equal(u.owner, "alice");
  assert.equal(u.repo, "arknetz-site-computers-edu");
  assert.equal(u.path, "site.json.zst");
});

test("parseBackendUri: gl: parses owner/repo/path", () => {
  const u = parseBackendUri("gl:alice/my-site/site.json.zst");
  assert.equal(u.prefix, "gl");
  assert.equal(u.owner, "alice");
  assert.equal(u.repo, "my-site");
  assert.equal(u.path, "site.json.zst");
});

test("parseBackendUri: cb: parses owner/repo/path", () => {
  const u = parseBackendUri("cb:alice/my-site/posts.json.zst");
  assert.equal(u.prefix, "cb");
  assert.equal(u.owner, "alice");
  assert.equal(u.path, "posts.json.zst");
});

test("parseBackendUri: ia: parses item/file", () => {
  const u = parseBackendUri("ia:arknetz-media-alice-2026-11/photo.webp");
  assert.equal(u.prefix, "ia");
  assert.equal(u.repo, "arknetz-media-alice-2026-11");
  assert.equal(u.path, "photo.webp");
});

test("parseBackendUri: hf: parses owner/repo/path", () => {
  const u = parseBackendUri("hf:alice/open-poems/data.json.zst");
  assert.equal(u.prefix, "hf");
  assert.equal(u.owner, "alice");
  assert.equal(u.repo, "open-poems");
  assert.equal(u.path, "data.json.zst");
});

test("parseBackendUri: wm: parses a single filename", () => {
  const u = parseBackendUri("wm:Sunset_over_the_sea.jpg");
  assert.equal(u.prefix, "wm");
  assert.equal(u.path, "Sunset_over_the_sea.jpg");
  assert.equal(u.owner, undefined);
});

test("parseBackendUri: ipfs: parses CID/path", () => {
  const u = parseBackendUri("ipfs:bafybeicid1234/site.json.zst");
  assert.equal(u.prefix, "ipfs");
  assert.equal(u.repo, "bafybeicid1234");
  assert.equal(u.path, "site.json.zst");
});

test("parseBackendUri: unknown prefix and missing repo throw", () => {
  assert.throws(() => parseBackendUri("xx:alice/repo/file"), /unknown backend prefix "xx"/);
  assert.throws(() => parseBackendUri("gh:alice"), /needs "<owner>\/<repo>"/);
  assert.throws(() => parseBackendUri("wm:a/b.jpg"), /single filename/);
  assert.throws(() => parseBackendUri("not-a-uri"), /expected "<prefix>:<rest>"/);
});

// ---------------------------------------------------------------------------
// Read URL shapes — one per backend
// ---------------------------------------------------------------------------

test("readUrl shapes match each backend's public CDN/API", () => {
  assert.equal(
    BACKENDS.gh.readUrl("gh:alice/site/site.json.zst"),
    "https://raw.githubusercontent.com/alice/site/main/site.json.zst",
  );
  assert.equal(
    BACKENDS.gl.readUrl("gl:alice/site/site.json.zst"),
    "https://gitlab.com/alice/site/-/raw/main/site.json.zst",
  );
  assert.equal(
    BACKENDS.cb.readUrl("cb:alice/site/site.json.zst"),
    "https://codeberg.org/alice/site/raw/branch/main/site.json.zst",
  );
  assert.equal(
    BACKENDS.ia.readUrl("ia:my-item/photo.webp"),
    "https://archive.org/download/my-item/photo.webp",
  );
  assert.equal(
    BACKENDS.hf.readUrl("hf:alice/data/data.json.zst"),
    "https://huggingface.co/datasets/alice/data/resolve/main/data.json.zst",
  );
  assert.equal(
    BACKENDS.wm.readUrl("wm:Sunset.jpg"),
    "https://commons.wikimedia.org/wiki/Special:FilePath/Sunset.jpg",
  );
  assert.equal(
    BACKENDS.ipfs.readUrl("ipfs:bafy123/site.json.zst"),
    "https://ipfs.filebase.io/ipfs/bafy123/site.json.zst",
  );
  assert.equal(backendFor("gh:alice/site/site.json.zst").prefix, "gh");
});

// ---------------------------------------------------------------------------
// gh: + ia: end to end against mocks
// ---------------------------------------------------------------------------

test("gh: read works end to end against a mock raw CDN", async () => {
  const { fetchFn, seen } = mockFetch((url) => {
    assert.equal(url, "https://raw.githubusercontent.com/alice/site/main/site.json.zst");
    return { status: 200, body: '{"domain":"computers.edu"}' };
  });
  const r = await readBackendUri("gh:alice/site/site.json.zst", fetchFn);
  assert.equal(r.body, '{"domain":"computers.edu"}');
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
});

test("ia: read works end to end against a mock archive.org", async () => {
  const { fetchFn, seen } = mockFetch((url) => {
    assert.equal(url, "https://archive.org/download/my-item/photo.webp");
    return { status: 200, body: "WEBP-BYTES" };
  });
  const r = await readBackendUri("ia:my-item/photo.webp", fetchFn);
  assert.equal(r.body, "WEBP-BYTES");
  assert.equal(seen.length, 1);
});

test("backend read throws on a non-200 status", async () => {
  const { fetchFn } = mockFetch(() => ({ status: 404, body: "not found" }));
  await assert.rejects(
    () => readBackendUri("gh:alice/site/site.json.zst", fetchFn),
    /failed with HTTP 404/,
  );
});

test("gh: list parses the GitHub contents API shape", async () => {
  const { fetchFn, seen } = mockFetch((url) => {
    assert.equal(url, "https://api.github.com/repos/alice/site/contents/");
    return { status: 200, body: '[{"name":"site.json.zst"},{"name":"posts.json.zst"}]' };
  });
  const names = await BACKENDS.gh.list("gh:alice/site/", fetchFn);
  assert.deepEqual(names, ["site.json.zst", "posts.json.zst"]);
  assert.equal(seen.length, 1);
});

test("gh: write sends a PUT with a Bearer token and base64 content", async () => {
  let capturedUrl = "";
  let capturedInit: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
  const fetchFn: NetworkFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return res(201, "{}");
  };
  const r = await BACKENDS.gh.write("gh:alice/site/site.json.zst", '{"a":1}', fetchFn, {
    token: "ghp_test",
    message: "publish",
  });
  assert.equal(r.status, 201);
  assert.equal(
    capturedUrl,
    "https://api.github.com/repos/alice/site/contents/site.json.zst",
  );
  const init = capturedInit as { method: string; headers: Record<string, string>; body: string };
  assert.equal(init.method, "PUT");
  assert.equal(init.headers.Authorization, "Bearer ghp_test");
  const payload = JSON.parse(init.body) as { content: string; message: string };
  assert.equal(payload.message, "publish");
  assert.equal(Buffer.from(payload.content, "base64").toString(), '{"a":1}');
});

test("ia:/wm:/ipfs: writes refuse loudly instead of guessing a shape", async () => {
  const { fetchFn } = mockFetch(() => ({ status: 200, body: "ok" }));
  await assert.rejects(
    () => BACKENDS.ia.write("ia:item/file", "x", fetchFn, {}),
    /IA S3 API/,
  );
  await assert.rejects(
    () => BACKENDS.wm.write("wm:File.jpg", "x", fetchFn, {}),
    /MediaWiki upload API/,
  );
  await assert.rejects(
    () => BACKENDS.ipfs.write("ipfs:bafy123/file", "x", fetchFn, {}),
    /Filebase.*S3-compatible API/,
  );
});

test("hf: write runs preupload then an NDJSON commit (regular mode)", async () => {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetchFn: NetworkFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/preupload/main")) {
      return res(200, JSON.stringify({ files: [{ path: "data.json", uploadMode: "regular" }] }));
    }
    if (url.endsWith("/commit/main")) return res(200, "{}");
    return res(404, "not found");
  };
  const r = await BACKENDS.hf.write("hf:alice/open-poems/data.json", '{"a":1}', fetchFn, {
    token: "hf_test"
  });
  assert.equal(r.status, 200);
  assert.equal(r.url, "https://huggingface.co/api/datasets/alice/open-poems/commit/main");
  assert.equal(calls.length, 2);
  const pre = calls[0] as { url: string; init: { method: string; headers: Record<string, string>; body: string } };
  assert.equal(pre.url, "https://huggingface.co/api/datasets/alice/open-poems/preupload/main");
  assert.equal(pre.init.method, "POST");
  assert.equal(pre.init.headers.Authorization, "Bearer hf_test");
  assert.equal(pre.init.headers["Content-Type"], "application/json");
  const preBody = JSON.parse(pre.init.body) as { files: Array<{ path: string; size: number; sample: string }> };
  assert.equal(preBody.files[0]?.path, "data.json");
  assert.equal(preBody.files[0]?.size, 7);
  assert.equal(Buffer.from(preBody.files[0]?.sample ?? "", "base64").toString(), '{"a":1}');
  const commit = calls[1] as { url: string; init: { method: string; headers: Record<string, string>; body: string } };
  assert.equal(commit.init.method, "POST");
  assert.equal(commit.init.headers["Content-Type"], "application/x-ndjson");
  const lines = commit.init.body.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.key, "header");
  assert.equal(lines[1]?.key, "file");
  const value = lines[1]?.value as { content: string; path: string; encoding: string };
  assert.equal(value.path, "data.json");
  assert.equal(value.encoding, "base64");
  assert.equal(Buffer.from(value.content, "base64").toString(), '{"a":1}');
});

test("hf: write maps a 401 preupload to an auth error and refuses LFS loudly", async () => {
  const denied: NetworkFetch = async () => res(401, "unauthorized");
  await assert.rejects(
    () => BACKENDS.hf.write("hf:alice/open-poems/data.json", "x", denied, { token: "hf_test" }),
    /token is missing, expired/,
  );
  const lfs: NetworkFetch = async (url) =>
    url.endsWith("/preupload/main")
      ? res(200, JSON.stringify({ files: [{ path: "data.json", uploadMode: "lfs" }] }))
      : res(200, "{}");
  await assert.rejects(
    () => BACKENDS.hf.write("hf:alice/open-poems/data.json", "x", lfs, { token: "hf_test" }),
    /LFS upload.*ArkDrive Hugging Face vault client/,
  );
  await assert.rejects(
    () => BACKENDS.hf.write("hf:alice/open-poems/data.json", "x", denied, {}),
    /needs a Hub token/,
  );
});

// ---------------------------------------------------------------------------
// Mirror failover
// ---------------------------------------------------------------------------

test("readWithMirrors tries mirrors in order and reports every attempt", async () => {
  const { fetchFn, seen } = mockFetch((url) => {
    if (url.includes("raw.githubusercontent.com")) return { status: 500, body: "down" };
    if (url.includes("codeberg.org")) return { status: 200, body: '{"from":"cb"}' };
    return { status: 404, body: "?" };
  });
  const { result, uri, attempts } = await readWithMirrors(
    ["gh:alice/site/site.json.zst", "cb:alice/site/site.json.zst"],
    fetchFn,
  );
  assert.equal(result.body, '{"from":"cb"}');
  assert.equal(uri, "cb:alice/site/site.json.zst");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.error, "read https://raw.githubusercontent.com/alice/site/main/site.json.zst failed with HTTP 500");
  assert.equal(attempts[1]?.status, 200);
  assert.equal(seen.length, 2);
});

test("readWithMirrors fails only when every mirror fails, naming the last error", async () => {
  const { fetchFn } = mockFetch(() => ({ status: 503, body: "down" }));
  await assert.rejects(
    () =>
      readWithMirrors(
        ["gh:alice/site/site.json.zst", "gl:alice/site/site.json.zst"],
        fetchFn,
      ),
    /all 2 mirror\(s\) failed.*HTTP 503/,
  );
});

test("readWithMirrors per-mirror timeout moves to the next mirror", async () => {
  let calls = 0;
  const fetchFn: NetworkFetch = async (url) => {
    calls++;
    if (url.includes("raw.githubusercontent.com")) {
      return new Promise(() => {
        // Never resolves — the timeout must rescue this mirror.
      });
    }
    return res(200, '{"from":"cb"}');
  };
  const { result, attempts } = await readWithMirrors(
    ["gh:alice/site/site.json.zst", "cb:alice/site/site.json.zst"],
    fetchFn,
    { perMirrorTimeoutMs: 25 },
  );
  assert.equal(result.body, '{"from":"cb"}');
  assert.equal(attempts.length, 2);
  assert.match(attempts[0]?.error ?? "", /timed out after 25 ms/);
  assert.equal(calls, 2);
});

test("readRegistryEntry reads backend then mirrors", async () => {
  const { fetchFn } = mockFetch((url) => {
    if (url.includes("raw.githubusercontent.com")) return { status: 404, body: "gone" };
    return { status: 200, body: '{"mirror":true}' };
  });
  const { result } = await readRegistryEntry(
    { backend: "gh:alice/site/site.json.zst", mirrors: ["gl:alice/site/site.json.zst"] },
    fetchFn,
  );
  assert.equal(result.body, '{"mirror":true}');
});

// ---------------------------------------------------------------------------
// ToS-aware routing
// ---------------------------------------------------------------------------

test("ToS routing: hf: refused without the open-dataset flag, allowed with it", () => {
  assert.throws(() => assertUploadAllowed("hf", {}), /Hugging Face Hub public repos must be useful to AI\/ML or open science/);
  assert.throws(() => assertUploadAllowed("hf", { isEducational: true }), /Hugging Face Hub/);
  assert.doesNotThrow(() => assertUploadAllowed("hf", { isOpenDataset: true }));
});

test("ToS routing: wm: refused without an educational/Creative Commons flag", () => {
  assert.throws(() => assertUploadAllowed("wm", {}), /Wikimedia Commons accepts only freely licensed/);
  assert.throws(() => assertUploadAllowed("wm", { isOpenDataset: true }), /Wikimedia Commons/);
  assert.doesNotThrow(() => assertUploadAllowed("wm", { isEducational: true }));
  assert.doesNotThrow(() => assertUploadAllowed("wm", { isCreativeCommons: true }));
});

test("ToS routing: gh:/gl:/cb:/ia:/ipfs: are never gated; picker reflects the flags", () => {
  for (const p of ["gh", "gl", "cb", "ia", "ipfs"] as const) {
    assert.doesNotThrow(() => assertUploadAllowed(p, {}));
  }
  const plain = uploadTargetsFor({});
  assert.equal(plain.find((t) => t.prefix === "hf")?.offered, false);
  assert.equal(plain.find((t) => t.prefix === "wm")?.offered, false);
  assert.equal(plain.find((t) => t.prefix === "gh")?.offered, true);
  const open = uploadTargetsFor({ isOpenDataset: true, isEducational: true });
  assert.equal(open.find((t) => t.prefix === "hf")?.offered, true);
  assert.equal(open.find((t) => t.prefix === "wm")?.offered, true);
});

// ---------------------------------------------------------------------------
// Wayback Machine
// ---------------------------------------------------------------------------

const RAW_URL = "https://raw.githubusercontent.com/alice/site/main/site.json.zst";
const CDX_BODY = JSON.stringify([
  ["timestamp", "original", "statuscode", "mimetype", "digest"],
  ["20261120120000", RAW_URL, "200", "application/octet-stream", "AAA"],
  ["20261101090000", RAW_URL, "200", "application/octet-stream", "BBB"],
  ["bad-row"],
]);

test("Save Page Now request shape: POST to web.archive.org/save/<public URL>", () => {
  const req = buildSavePageNowRequest(RAW_URL);
  assert.equal(req.method, "POST");
  assert.equal(req.url, `https://web.archive.org/save/${RAW_URL}`);
  assert.equal(req.headers.Accept, "application/json");
});

test("Save Page Now refuses arknetz:// and non-https URLs", () => {
  assert.throws(
    () => buildSavePageNowRequest("arknetz://computers.edu"),
    /never arknetz:\/\/ directly/,
  );
  assert.throws(
    () => buildSavePageNowRequest("http://example.com/site.json"),
    /public https:\/\/ URLs only/,
  );
});

test("snapshotToWayback POSTs the Save Page Now URL and reports the status", async () => {
  const { fetchFn, seen } = mockFetch((url) => {
    assert.equal(url, `https://web.archive.org/save/${RAW_URL}`);
    return { status: 200, body: "{}" };
  });
  let capturedMethod = "";
  const wrapped: NetworkFetch = async (url, init) => {
    capturedMethod = init?.method ?? "";
    return fetchFn(url, init);
  };
  const { status } = await snapshotToWayback(RAW_URL, wrapped);
  assert.equal(status, 200);
  assert.equal(capturedMethod, "POST");
  assert.equal(seen.length, 1);
});

test("CDX URL asks for JSON, 200-only, digest-collapsed rows", () => {
  const url = new URL(buildCdxUrl(RAW_URL));
  assert.equal(url.origin + url.pathname, "https://web.archive.org/cdx/search/cdx");
  assert.equal(url.searchParams.get("url"), RAW_URL);
  assert.equal(url.searchParams.get("output"), "json");
  assert.equal(url.searchParams.get("filter"), "statuscode:200");
  assert.equal(url.searchParams.get("collapse"), "digest");
});

test("parseCdxJson skips the header and bad rows and builds id_ URLs", () => {
  const snaps = parseCdxJson(JSON.parse(CDX_BODY) as unknown);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0]?.timestamp, "20261120120000");
  assert.equal(snaps[0]?.original, RAW_URL);
  assert.equal(snaps[0]?.statuscode, 200);
  assert.equal(
    snaps[0]?.waybackUrl,
    `https://web.archive.org/web/20261120120000/${RAW_URL}`,
  );
  assert.equal(
    snaps[0]?.idUrl,
    `https://web.archive.org/web/20261120120000id_/${RAW_URL}`,
  );
  assert.equal(snapshotDisplayDate(snaps[0] as never), "2026-11-20 12:00 UTC");
  assert.throws(() => parseCdxJson({}), /not a JSON array/);
});

test("latestSnapshot picks the newest capture", () => {
  const snaps = parseCdxJson(JSON.parse(CDX_BODY) as unknown);
  assert.equal(latestSnapshot(snaps)?.timestamp, "20261120120000");
  assert.equal(latestSnapshot([]), null);
});

test("listSnapshots + fetchLatestSnapshot work end to end against mocks", async () => {
  const { fetchFn, seen } = mockFetch((url) => {
    if (url.includes("/cdx/search/cdx")) return { status: 200, body: CDX_BODY };
    if (url.includes("20261120120000id_/")) return { status: 200, body: '{"restored":true}' };
    return { status: 404, body: "?" };
  });
  const listed = await listSnapshots(RAW_URL, fetchFn);
  assert.equal(listed.length, 2);
  const { snapshot, body } = await fetchLatestSnapshot(RAW_URL, fetchFn);
  assert.equal(snapshot.timestamp, "20261120120000");
  assert.equal(body, '{"restored":true}');
  assert.ok(seen.some((u) => u.includes("id_/")));
});

test("fetchWithWaybackFailover: primary 404 falls back to the latest snapshot", async () => {
  const { fetchFn } = mockFetch((url) => {
    if (url === RAW_URL) return { status: 404, body: "repo deleted" };
    if (url.includes("/cdx/search/cdx")) return { status: 200, body: CDX_BODY };
    if (url.includes("id_/")) return { status: 200, body: '{"from":"wayback"}' };
    return { status: 404, body: "?" };
  });
  const r = await fetchWithWaybackFailover(RAW_URL, fetchFn);
  assert.equal(r.fromWayback, true);
  assert.equal(r.body, '{"from":"wayback"}');
  assert.equal(r.snapshot?.timestamp, "20261120120000");
});

test("fetchWithWaybackFailover: primary success never touches the CDX API", async () => {
  const { fetchFn, seen } = mockFetch((url) => {
    assert.equal(url, RAW_URL);
    return { status: 200, body: '{"live":true}' };
  });
  const r = await fetchWithWaybackFailover(RAW_URL, fetchFn);
  assert.equal(r.fromWayback, false);
  assert.equal(r.body, '{"live":true}');
  assert.equal(seen.length, 1);
});

test("fetchWithWaybackFailover: both failing reports both reasons", async () => {
  const { fetchFn } = mockFetch((url) => {
    if (url === RAW_URL) return { status: 500, body: "down" };
    if (url.includes("/cdx/search/cdx")) return { status: 200, body: "[]" };
    return { status: 404, body: "?" };
  });
  await assert.rejects(
    () => fetchWithWaybackFailover(RAW_URL, fetchFn),
    /primary fetch failed.*Wayback failover failed.*no Wayback Machine snapshot exists/,
  );
});

// ---------------------------------------------------------------------------
// Account keyring
// ---------------------------------------------------------------------------

async function unlockedKeyring(passphrase = "correct horse battery staple") {
  const store = createMemoryKeyringStore();
  const keyring = new AccountKeyring(store);
  await keyring.unlock(passphrase);
  return { store, keyring };
}

test("keyring encrypt/decrypt round-trips; wrong passphrase fails", async () => {
  const enc = await encryptSecret("passphrase-one", "ghp_secret_token");
  assert.equal(await decryptSecret("passphrase-one", enc), "ghp_secret_token");
  await assert.rejects(() => decryptSecret("wrong-passphrase", enc), /wrong passphrase/);
});

test("keyring: locked keyring refuses to add or reveal accounts", async () => {
  const store = createMemoryKeyringStore();
  const keyring = new AccountKeyring(store);
  assert.equal(keyring.isUnlocked, false);
  await assert.rejects(
    () =>
      keyring.addAccount(
        "github",
        { id: "a", label: "A" },
        { kind: "token", token: "t" },
      ),
    /keyring is locked/,
  );
  await assert.rejects(() => keyring.revealSecret("github", "a"), /keyring is locked/);
});

test("keyring: add/list/switch accounts; stored secret is ciphertext only", async () => {
  const { store, keyring } = await unlockedKeyring();
  await keyring.addAccount(
    "github",
    { id: "stanbeyond", label: "STANBEYOND (Master)", username: MASTER_GITHUB_USER },
    { kind: "token", token: "ghp_master_token" },
  );
  await keyring.addAccount(
    "github",
    { id: "personal-alt", label: "Personal Alt", username: "someone-else" },
    { kind: "token", token: "ghp_alt_token" },
  );
  await keyring.addAccount(
    "internet_archive",
    { id: "ia-edu", label: "University Media Vault" },
    { kind: "s3keys", accessKey: "AK", secretKey: "SK" },
  );
  assert.equal(keyring.listAccounts("github").length, 2);
  assert.equal(keyring.getActive("github")?.id, "stanbeyond");
  assert.equal(keyring.getActive("internet_archive")?.id, "ia-edu");
  // Ciphertext at rest: the persisted store must not contain any plaintext secret.
  const persisted = JSON.stringify(store.peek());
  assert.ok(!persisted.includes("ghp_master_token"));
  assert.ok(!persisted.includes("ghp_alt_token"));
  assert.ok(!persisted.includes('"SK"'));
  // …but the owner can still read them back with the passphrase.
  assert.equal(
    await keyring.revealSecret("internet_archive", "ia-edu"),
    JSON.stringify({ accessKey: "AK", secretKey: "SK" }),
  );
});

test("keyring: wrong passphrase on a fresh instance fails to unlock", async () => {
  const { store, keyring } = await unlockedKeyring();
  await keyring.addAccount("github", { id: "stanbeyond", label: "Master", username: MASTER_GITHUB_USER }, { kind: "token", token: "t1" });
  const second = new AccountKeyring(store);
  await second.load();
  await assert.rejects(() => second.unlock("not-the-passphrase"), /wrong passphrase/);
  const third = new AccountKeyring(store);
  await third.load();
  await third.unlock("correct horse battery staple");
  assert.equal(third.isUnlocked, true);
});

test("keyring: one-click switch across all backends simultaneously", async () => {
  const { keyring } = await unlockedKeyring();
  await keyring.addAccount("github", { id: "stanbeyond", label: "Master", username: MASTER_GITHUB_USER }, { kind: "token", token: "t1" });
  await keyring.addAccount("github", { id: "personal-alt", label: "Alt", username: "someone-else" }, { kind: "token", token: "t2" });
  await keyring.addAccount("internet_archive", { id: "ia-edu", label: "Edu" }, { kind: "s3keys", accessKey: "A", secretKey: "S" });
  await keyring.addAccount("internet_archive", { id: "ia-cinema", label: "Cinema" }, { kind: "s3keys", accessKey: "B", secretKey: "S" });
  const switched = await keyring.switchAll({ github: "personal-alt", internet_archive: "ia-cinema" });
  assert.equal(switched.github?.id, "personal-alt");
  assert.equal(switched.internet_archive?.id, "ia-cinema");
  assert.equal(keyring.getActive("github")?.id, "personal-alt");
  assert.equal(keyring.getActive("internet_archive")?.id, "ia-cinema");
});

test("keyring: switchAll with an unknown id switches nothing", async () => {
  const { keyring } = await unlockedKeyring();
  await keyring.addAccount("github", { id: "stanbeyond", label: "Master", username: MASTER_GITHUB_USER }, { kind: "token", token: "t1" });
  await assert.rejects(
    () => keyring.switchAll({ github: "ghost-account" }),
    /not signed in/,
  );
  assert.equal(keyring.getActive("github")?.id, "stanbeyond");
});

test("keyring: removeAccount clears the active slot and blocks re-switch", async () => {
  const { keyring } = await unlockedKeyring();
  await keyring.addAccount("github", { id: "a", label: "A", username: "a-user" }, { kind: "token", token: "t" });
  await keyring.removeAccount("github", "a");
  assert.equal(keyring.getActive("github"), undefined);
  assert.throws(() => keyring.setActive("github", "a"), /not signed in/);
  await assert.rejects(() => keyring.removeAccount("github", "a"), /no GitHub account "a" to remove/);
});

test("keyring: per-site auto-binding selects the bound accounts", async () => {
  const { keyring } = await unlockedKeyring();
  await keyring.addAccount("github", { id: "stanbeyond", label: "Master", username: MASTER_GITHUB_USER }, { kind: "token", token: "t1" });
  await keyring.addAccount("github", { id: "personal-alt", label: "Alt", username: "someone-else" }, { kind: "token", token: "t2" });
  await keyring.addAccount("internet_archive", { id: "ia-edu", label: "Edu" }, { kind: "s3keys", accessKey: "A", secretKey: "S" });
  await keyring.addAccount("internet_archive", { id: "ia-cinema", label: "Cinema" }, { kind: "s3keys", accessKey: "B", secretKey: "S" });
  keyring.bindSite("edu.orion.stanbeyond", { github: "stanbeyond", internet_archive: "ia-edu" });
  keyring.bindSite("indie.films", { github: "personal-alt", internet_archive: "ia-cinema" });
  // Deliberately switch to the WRONG accounts first…
  await keyring.switchAll({ github: "personal-alt", internet_archive: "ia-cinema" });
  // …opening the edu site must auto-select the bound ones.
  const selected = await keyring.autoSelectForSite("edu.orion.stanbeyond");
  assert.equal(selected.github?.id, "stanbeyond");
  assert.equal(selected.internet_archive?.id, "ia-edu");
  assert.equal(keyring.getActive("github")?.id, "stanbeyond");
  assert.equal(keyring.getActive("internet_archive")?.id, "ia-edu");
  // The other site binds the other pair.
  const selected2 = await keyring.autoSelectForSite("indie.films");
  assert.equal(selected2.github?.id, "personal-alt");
  assert.equal(selected2.internet_archive?.id, "ia-cinema");
  // An unbound site selects nothing and throws nothing.
  assert.deepEqual(await keyring.autoSelectForSite("unbound.example"), {});
});

test("keyring: auto-binding to a missing account fails with the exact reason", async () => {
  const { keyring } = await unlockedKeyring();
  await keyring.addAccount("github", { id: "stanbeyond", label: "Master", username: MASTER_GITHUB_USER }, { kind: "token", token: "t1" });
  keyring.bindSite("indie.films", { github: "ghost-account" });
  await assert.rejects(
    () => keyring.autoSelectForSite("indie.films"),
    /site indie\.films is bound to GitHub account "ghost-account", which is not signed in/,
  );
});

test("keyring: Master Admin Badge only for the master account", async () => {
  const { keyring } = await unlockedKeyring();
  assert.equal(keyring.masterUser, MASTER_GITHUB_USER);
  assert.equal(keyring.isMasterAdmin(), false);
  await keyring.addAccount("github", { id: "stanbeyond", label: "Master", username: MASTER_GITHUB_USER }, { kind: "token", token: "t1" });
  assert.equal(keyring.isMasterAdmin(), true);
  await keyring.addAccount("github", { id: "personal-alt", label: "Alt", username: "someone-else" }, { kind: "token", token: "t2" });
  await keyring.switchAll({ github: "personal-alt" });
  assert.equal(keyring.isMasterAdmin(), false);
  await keyring.switchAll({ github: "stanbeyond" });
  assert.equal(keyring.isMasterAdmin(), true);
});

// ---------------------------------------------------------------------------
// ToS
// ---------------------------------------------------------------------------

test("ToS: gate blocks a first publish before acceptance, with the exact reason", async () => {
  const store = createMemoryTosStore();
  const gate = await gateFirstAction(store, "acct-1", "publish");
  assert.equal(gate.allowed, false);
  if (!gate.allowed) {
    assert.equal(gate.reason, "tos_acceptance_missing");
    assert.match(gate.message, /ToS acceptance required before your first publish/);
    assert.match(gate.message, /I agree to the ArkNetzWebWeaver Terms/);
  }
});

test("ToS: one-click acceptance stores a timestamped flag and unblocks the gate", async () => {
  const store = createMemoryTosStore();
  const acceptance = await recordAcceptance(
    store,
    "acct-1",
    "publish",
    new Date("2026-11-20T15:00:00.000Z"),
  );
  assert.equal(acceptance.acceptedAt, "2026-11-20T15:00:00.000Z");
  assert.equal(acceptance.tosVersion, TOS_VERSION);
  assert.equal(acceptance.accountId, "acct-1");
  const gate = await gateFirstAction(store, "acct-1", "publish");
  assert.equal(gate.allowed, true);
  if (gate.allowed) assert.equal(gate.acceptance.acceptedAt, "2026-11-20T15:00:00.000Z");
  // A different account is still gated.
  const other = await gateFirstAction(store, "acct-2", "domain-claim");
  assert.equal(other.allowed, false);
});

test("ToS: guest notice names both pass-through documents", () => {
  const notice = guestAcceptableUseNotice();
  assert.match(notice, /GitHub Terms of Service/);
  assert.match(notice, /Internet Archive Terms of Use/);
  assert.match(notice, /docs\.github\.com/);
  assert.match(notice, /archive\.org\/about\/terms\.php/);
});

// ---------------------------------------------------------------------------
// UI view models (pure functions, no DOM)
// ---------------------------------------------------------------------------

test("account switcher pill: Guest when signed out, Master badge for the master", async () => {
  const { keyring } = await unlockedKeyring();
  let view = accountSwitcherPillView(
    { profiles: keyring.listAccounts(), active: {} },
    keyring.isMasterAdmin(),
  );
  assert.equal(view.pillLabel, "Guest");
  assert.equal(view.masterBadgeVisible, false);
  assert.equal(view.signedInCount, 0);
  assert.match(view.emptyNote, /No accounts signed in/);

  await keyring.addAccount("github", { id: "stanbeyond", label: "STANBEYOND (Master)", username: MASTER_GITHUB_USER }, { kind: "token", token: "t1" });
  await keyring.addAccount("internet_archive", { id: "ia-edu", label: "University Media Vault" }, { kind: "s3keys", accessKey: "A", secretKey: "S" });
  view = accountSwitcherPillView(
    {
      profiles: keyring.listAccounts(),
      active: { github: "stanbeyond", internet_archive: "ia-edu" },
    },
    keyring.isMasterAdmin(),
  );
  assert.equal(view.pillLabel, MASTER_GITHUB_USER);
  assert.equal(view.masterBadgeVisible, true);
  assert.equal(view.masterBadgeLabel, "Root Master");
  assert.equal(view.addAccountLabel, "+ Add Another Account");
  const gh = view.sections.find((s) => s.provider === "github");
  assert.equal(gh?.accounts[0]?.isActive, true);
  assert.equal(gh?.accounts[0]?.label, "STANBEYOND (Master)");
});

test("root registries view: one primary plus secondaries", () => {
  const view = rootRegistriesView("PropTheRtRevDrSirStanleyG05/arknetz-protocol-root", [
    "community/alt-root",
  ]);
  assert.equal(view.primary.isPrimary, true);
  assert.equal(view.primary.repo, "PropTheRtRevDrSirStanleyG05/arknetz-protocol-root");
  assert.equal(view.secondaries.length, 1);
  assert.equal(view.secondaries[0]?.isPrimary, false);
  assert.match(view.note, /still add this one as a secondary/);
});

test("site binding view: bound, unbound, and missing accounts are labelled", async () => {
  const { keyring } = await unlockedKeyring();
  await keyring.addAccount("github", { id: "stanbeyond", label: "Master", username: MASTER_GITHUB_USER }, { kind: "token", token: "t1" });
  keyring.bindSite("edu.orion.stanbeyond", { github: "stanbeyond", internet_archive: "ia-edu" });
  const view = siteBindingView(
    "edu.orion.stanbeyond",
    keyring.getSiteBinding("edu.orion.stanbeyond"),
    keyring.listAccounts(),
  );
  assert.equal(view.bound, true);
  const gh = view.rows.find((r) => r.provider === "github");
  assert.equal(gh?.boundAccountLabel, "Master");
  assert.equal(gh?.missing, false);
  const ia = view.rows.find((r) => r.provider === "internet_archive");
  assert.equal(ia?.missing, true);
  assert.match(ia?.hint ?? "", /not signed in/);
  const unbound = siteBindingView("plain.example", undefined, keyring.listAccounts());
  assert.equal(unbound.bound, false);
});

test("backend picker view: hf:/wm: hidden without the open/educational flags", () => {
  const plain = backendPickerView({});
  assert.equal(plain.targets.find((t) => t.prefix === "hf")?.offered, false);
  assert.match(plain.targets.find((t) => t.prefix === "hf")?.reason ?? "", /open science/);
  assert.equal(plain.targets.find((t) => t.prefix === "wm")?.offered, false);
  assert.equal(plain.targets.find((t) => t.prefix === "gh")?.offered, true);
  const open = backendPickerView({ isOpenDataset: true, isCreativeCommons: true });
  assert.equal(open.targets.find((t) => t.prefix === "hf")?.offered, true);
  assert.equal(open.targets.find((t) => t.prefix === "wm")?.offered, true);
});

test("mirror status view: names the mirror that answered and the ones that failed", () => {
  const view = mirrorStatusView([
    { uri: "gh:alice/site/site.json.zst", url: "https://raw.githubusercontent.com/x", status: null, error: "read failed with HTTP 500", ms: 12 },
    { uri: "cb:alice/site/site.json.zst", url: "https://codeberg.org/x", status: 200, ms: 40 },
  ]);
  assert.equal(view.tried, 2);
  assert.equal(view.succeededFrom, "cb:alice/site/site.json.zst");
  assert.equal(view.failed.length, 1);
  assert.match(view.summary, /after 1 mirror\(s\) failed/);
  const allFailed = mirrorStatusView([
    { uri: "gh:a/b/c", url: "u", status: null, error: "boom", ms: 1 },
  ]);
  assert.equal(allFailed.succeededFrom, null);
  assert.match(allFailed.summary, /Wayback Machine next/);
});

test("time machine view: newest first, with an empty note when there are no snapshots", () => {
  const snaps = parseCdxJson(JSON.parse(CDX_BODY) as unknown);
  const view = timeMachineView(RAW_URL, snaps);
  assert.equal(view.count, 2);
  assert.equal(view.latest?.timestamp, "20261120120000");
  assert.equal(view.entries[0]?.displayDate, "2026-11-20 12:00 UTC");
  assert.match(view.entries[0]?.idUrl ?? "", /20261120120000id_/);
  const empty = timeMachineView(RAW_URL, []);
  assert.equal(empty.count, 0);
  assert.equal(empty.latest, null);
  assert.match(empty.emptyNote, /No Wayback Machine snapshots exist/);
});
