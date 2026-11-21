// Tests: ArkDrive — mocked transports only. No test ever hits real
// GitHub, GitLab, Codeberg, Hugging Face, IA or Wikimedia.
import test from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptName,
  decryptVaultEnvelope,
  deriveVaultKey,
  encryptName,
  encryptVaultEnvelope,
  randomBytes,
  sha256Hex,
} from "../src/lib/drive/crypto.js";
import {
  VAULT_CHUNK_SIZE,
  chunksNeedingUpload,
  decryptChunk,
  encryptChunk,
  packStoredChunk,
  reassembleChunks,
  splitBytes,
} from "../src/lib/drive/chunks.js";
import { createVaultBackendClient, parseVaultBackendUri } from "../src/lib/drive/backends.js";
import type { DriveHttpFetch, DriveHttpResponse, VaultBackendClient } from "../src/lib/drive/backends.js";
import { VaultManager } from "../src/lib/drive/drive.js";
import { normalizeDroppedPath, splitDroppedPath } from "../src/lib/drive/drive.js";
import type { DroppedUpload } from "../src/lib/drive/drive.js";
import { PooledDrive } from "../src/lib/drive/pooled.js";
import { backupManifestJson, createBackup, listBackups, restoreBackup } from "../src/lib/drive/backup.js";
import {
  bindDriveDropZone,
  collectDroppedFiles,
  DropUploadTracker,
  dropUploadProgressView,
  HONEST_LIMITS_COPY,
  deleteConfirmationView,
  fileListView,
  formatBytes,
  isFileDrag,
  pooledDriveView,
} from "../src/lib/drive/drive-ui.js";
import type { VaultBackend } from "../src/lib/drive/types.js";

// --- in-memory blob store (stands in for a provider repo) --------------
class MemoryClient implements VaultBackendClient {
  readonly kind: VaultBackend["kind"];
  readonly repo: string;
  readonly branch = "main";
  readonly store = new Map<string, Uint8Array>();
  blobPuts = 0;

  constructor(kind: VaultBackend["kind"] = "gh", repo = "alice/arknetz-vault") {
    this.kind = kind;
    this.repo = repo;
  }

  async putBlob(path: string, data: Uint8Array): Promise<void> {
    if (path.startsWith("blobs/")) this.blobPuts++;
    this.store.set(path, new Uint8Array(data));
  }

  async getBlob(path: string): Promise<Uint8Array | null> {
    const found = this.store.get(path);
    return found ? new Uint8Array(found) : null;
  }

  async deleteBlob(path: string): Promise<void> {
    this.store.delete(path);
  }

  async listBlobs(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

function backend(kind: VaultBackend["kind"], repo: string, accountId: string): VaultBackend {
  return { kind, uri: `${kind}:${repo}`, repo, accountId };
}

async function openVault(client: MemoryClient, kind: VaultBackend["kind"] = "gh"): Promise<VaultManager> {
  const manager = new VaultManager(backend(kind, client.repo, "acct-alice"), client);
  await manager.open("correct horse battery staple");
  return manager;
}

function mockResponse(status: number, body: unknown): DriveHttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    status,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

function rawResponse(status: number, bytes: Uint8Array): DriveHttpResponse {
  return {
    status,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  };
}

// --- crypto ------------------------------------------------------------

test("encrypt/decrypt round-trip incl. filename metadata (unicode name)", async () => {
  const key = await deriveVaultKey("vault pass", new TextEncoder().encode("0123456789abcdef"));
  const name = "Veridian Sight — Vol 1 📚.epub";
  const encrypted = await encryptName(key, name);
  assert.notEqual(encrypted, name);
  assert.equal(await decryptName(key, encrypted), name);
  // The encrypted name leaks nothing readable.
  assert.doesNotMatch(encrypted, /Veridian/);
});

test("PBKDF2 key derivation is deterministic for same passphrase+salt; wrong passphrase fails", async () => {
  const salt = new TextEncoder().encode("0123456789abcdef");
  const keyA = await deriveVaultKey("same passphrase", salt);
  const keyB = await deriveVaultKey("same passphrase", salt);
  const iv = new Uint8Array(12).fill(7);
  const cipherA = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, keyA, new TextEncoder().encode("secret"));
  const cipherB = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, keyB, new TextEncoder().encode("secret"));
  assert.deepEqual(new Uint8Array(cipherA), new Uint8Array(cipherB));

  const envelope = await encryptVaultEnvelope("right passphrase", new TextEncoder().encode("manifest"));
  const opened = await decryptVaultEnvelope("right passphrase", envelope);
  assert.equal(new TextDecoder().decode(opened.plaintext), "manifest");
  await assert.rejects(() => decryptVaultEnvelope("wrong passphrase", envelope), /decryption failed/);
});

test("base64url helpers round-trip binary data", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
  assert.deepEqual(base64UrlToBytes(bytesToBase64Url(bytes)), bytes);
  assert.doesNotMatch(bytesToBase64Url(bytes), /[+/=]/);
});

// --- chunking ----------------------------------------------------------

test("chunking boundaries: 0 bytes -> 0 chunks, 10 MB -> 1, 10 MB+1 -> 2, 25 MB -> 3", async () => {
  assert.equal((await splitBytes(new Uint8Array(0))).length, 0);
  assert.equal((await splitBytes(new Uint8Array(VAULT_CHUNK_SIZE).fill(65))).length, 1);
  assert.equal((await splitBytes(new Uint8Array(VAULT_CHUNK_SIZE + 1).fill(65))).length, 2);
  const big = randomBytes(25 * 1024 * 1024);
  const chunks = await splitBytes(big);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.plaintext.length, VAULT_CHUNK_SIZE);
  assert.equal(chunks[1]?.plaintext.length, VAULT_CHUNK_SIZE);
  assert.equal(chunks[2]?.plaintext.length, 5 * 1024 * 1024);
  // Every chunk hash is the SHA-256 of its plaintext.
  assert.equal(chunks[0]?.hash, await sha256Hex(big.slice(0, VAULT_CHUNK_SIZE)));
});

test("chunksNeedingUpload skips hashes already in the manifest", async () => {
  const chunks = await splitBytes(new TextEncoder().encode("hello world hello world"));
  const known = new Set([chunks[0]?.hash as string]);
  assert.equal(chunksNeedingUpload(chunks, known).length, 0);
  assert.equal(chunksNeedingUpload(chunks, new Set()).length, 1);
});

test("reassembly round-trips; a hash mismatch throws instead of returning corrupt bytes", async () => {
  const key = await deriveVaultKey("pass", new TextEncoder().encode("0123456789abcdef"));
  const data = new TextEncoder().encode("reassemble me, please");
  const chunks = await splitBytes(data);
  const enc = await encryptChunk(key, chunks[0] as { index: number; hash: string; plaintext: Uint8Array });
  const stored = [{ blobId: enc.blobId, bytes: packStoredChunk(enc.iv, enc.encrypted) }];
  const back = await reassembleChunks(key, stored, [enc.hash]);
  assert.deepEqual(back, data);
  // Tamper with the expected hash: decryption succeeds but verification fails.
  await assert.rejects(() => reassembleChunks(key, stored, ["0".repeat(64)]), /integrity check|SHA-256 mismatch/);
  // Tamper with the stored bytes: GCM authentication fails.
  const corrupted = new Uint8Array(stored[0]?.bytes as Uint8Array);
  corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] as number) ^ 0xff;
  await assert.rejects(
    () => reassembleChunks(key, [{ blobId: enc.blobId, bytes: corrupted }], [enc.hash]),
    /decryption failed|integrity check/,
  );
  // decryptChunk directly reports a hash mismatch.
  await assert.rejects(
    () => decryptChunk(key, { blobId: enc.blobId, hash: "f".repeat(64), encrypted: enc.encrypted }, enc.iv),
    /integrity check/,
  );
});

// --- vault manager -----------------------------------------------------

test("manifest round-trip: upload, reopen with the same passphrase, file is listed; wrong passphrase fails", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  await vault.uploadFile("notes.txt", new TextEncoder().encode("hello vault"), null, "text/plain");
  const stored = await vault.storedManifestBytes();
  assert.ok(stored && stored.length > 0);
  // The stored manifest leaks no filenames.
  assert.doesNotMatch(new TextDecoder().decode(stored as Uint8Array), /notes/);

  const reopened = new VaultManager(backend("gh", client.repo, "acct-alice"), client);
  await reopened.open("correct horse battery staple");
  const files = await reopened.listFolder(null);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.name, "notes.txt");
  assert.equal(files[0]?.size, 11);

  const wrong = new VaultManager(backend("gh", client.repo, "acct-alice"), client);
  await assert.rejects(() => wrong.open("wrong passphrase"), /decryption failed/);
});

test("upload/download round-trip incl. empty file and a 25 MB multi-chunk file", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const empty = await vault.uploadFile("empty.bin", new Uint8Array(0));
  assert.equal(empty.file.size, 0);
  assert.equal(empty.chunksUploaded, 0);
  assert.deepEqual(await vault.downloadFile(empty.file.id), new Uint8Array(0));

  const big = randomBytes(25 * 1024 * 1024);
  const result = await vault.uploadFile("big.bin", big, null, "application/octet-stream");
  assert.equal(result.file.chunkCount, 3);
  assert.equal(result.chunksUploaded, 3);
  assert.deepEqual(await vault.downloadFile(result.file.id), big);
});

test("SHA-256 dedup: uploading identical content twice stores each chunk once", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const data = randomBytes(11 * 1024 * 1024); // 2 chunks
  const first = await vault.uploadFile("copy-a.bin", data);
  assert.equal(first.chunksUploaded, 2);
  const putsAfterFirst = client.blobPuts;
  const second = await vault.uploadFile("copy-b.bin", data);
  assert.equal(second.chunksUploaded, 0);
  assert.equal(second.chunksDeduped, 2);
  assert.equal(client.blobPuts, putsAfterFirst, "no chunk was re-uploaded");
  // Both files still download correctly.
  assert.deepEqual(await vault.downloadFile(second.file.id), data);
  // Deleting one copy keeps the shared chunks for the other.
  const confirmation = await vault.prepareDelete(first.file.id);
  await vault.confirmDelete({ ...confirmation, confirmed: true });
  assert.deepEqual(await vault.downloadFile(second.file.id), data);
});

test("corrupt stored chunk: download throws, never returns bad bytes", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const result = await vault.uploadFile("precious.txt", new TextEncoder().encode("do not corrupt me"));
  const blobPaths = await vault.listStoredBlobs();
  assert.equal(blobPaths.length, 1);
  const blobPath = blobPaths[0] as string;
  const stored = client.store.get(blobPath) as Uint8Array;
  const corrupted = new Uint8Array(stored);
  corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] as number) ^ 0x01;
  client.store.set(blobPath, corrupted);
  await assert.rejects(() => vault.downloadFile(result.file.id), /decryption failed|integrity check|corrupt/);
});

test("folders: create/rename/move; folder cannot move into itself; delete is two-step and permanent", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const folder = await vault.createFolder("Photos");
  const sub = await vault.createFolder("2026", folder.id);
  const file = await vault.uploadFile("sunset.webp", new TextEncoder().encode("fake-image"), sub.id, "image/webp");
  assert.equal((await vault.listFolder(folder.id)).length, 1);

  const renamed = await vault.renameEntry(folder.id, "Pictures");
  assert.equal(renamed.name, "Pictures");
  const moved = await vault.moveEntry(file.file.id, null);
  assert.equal(moved.parentId, null);
  await assert.rejects(() => vault.moveEntry(folder.id, sub.id), /cannot move a folder into itself/);

  // Unconfirmed delete refuses.
  const confirmation = await vault.prepareDelete(folder.id);
  assert.equal(confirmation.descendantCount, 1); // the "2026" subfolder
  await assert.rejects(() => vault.confirmDelete(confirmation), /not confirmed/);
  // Confirmed delete removes folder + descendant.
  await vault.confirmDelete({ ...confirmation, confirmed: true });
  assert.equal((await vault.listFolder(null)).length, 1); // only the moved file remains
  assert.equal((await vault.listAllFolders()).length, 0);
});

test("search matches decrypted names only, client-side", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  await vault.uploadFile("Veridian Sight Vol 1.epub", new TextEncoder().encode("book"));
  await vault.uploadFile("shopping-list.txt", new TextEncoder().encode("milk"));
  await vault.createFolder("Tax Returns 2026");
  const hits = await vault.search("veridian");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.name, "Veridian Sight Vol 1.epub");
  assert.equal((await vault.search("tax")).length, 1);
  assert.equal((await vault.search("blob_")).length, 0, "encrypted blob names are not searchable");
  assert.equal((await vault.search("")).length, 0);
});

test("duplicate names in one folder are refused; usage counts blobs + manifest", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  await vault.uploadFile("dup.txt", new TextEncoder().encode("one"));
  await assert.rejects(() => vault.uploadFile("dup.txt", new TextEncoder().encode("two")), /already exists/);
  const usage = await vault.usage();
  assert.equal(usage.fileCount, 1);
  assert.equal(usage.blobCount, 1);
  assert.ok(usage.usedBytes > 0);
  assert.equal(usage.quotaBytes, 5 * 1024 ** 3); // GitHub soft quota
  assert.ok(usage.usedRatio > 0 && usage.usedRatio < 0.01);
});

// --- backend refusals --------------------------------------------------

test("ia:/wm: backends are refused at parse time and at client construction", () => {
  for (const uri of ["ia:alice/vault", "wm:alice/vault"]) {
    assert.throws(() => parseVaultBackendUri(uri), /cannot use ".*" as a vault backend/);
  }
  const fetchFn: DriveHttpFetch = async () => mockResponse(200, {});
  for (const kind of ["ia", "wm"] as const) {
    assert.throws(
      () =>
        createVaultBackendClient(
          { kind: kind as "gh", uri: `${kind}:alice/vault`, repo: "alice/vault", accountId: "a" },
          { fetchFn },
        ),
      /cannot use/,
    );
  }
  assert.throws(() => parseVaultBackendUri("xx:alice/vault"), /unknown vault backend prefix/);
  assert.throws(() => parseVaultBackendUri("gh:alice"), /expected "<owner>\/<repo>"/);
  assert.deepEqual(parseVaultBackendUri("gh:alice/arknetz-vault"), { kind: "gh", repo: "alice/arknetz-vault" });
});

// --- provider clients against mock fetch -------------------------------

function githubMockFetch() {
  const store = new Map<string, { content: string; sha: string }>();
  let counter = 0;
  const fetchFn: DriveHttpFetch = async (url, init) => {
    const parsed = new URL(url);
    const match = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(parsed.pathname);
    if (!match) return mockResponse(404, { message: "not found" });
    const path = decodeURIComponent(match[2] as string);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const entry = store.get(path);
      if (entry) return mockResponse(200, { sha: entry.sha, content: entry.content });
      const children = [...store.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/"));
      if (children.length > 0) {
        return mockResponse(200, children.map((k) => ({ name: k.slice(path.length + 1), type: "file" })));
      }
      return mockResponse(404, { message: "not found" });
    }
    if (method === "PUT") {
      const body = JSON.parse(init?.body as string) as { content: string };
      const sha = `sha${++counter}`;
      store.set(path, { content: body.content, sha });
      return mockResponse(200, { content: { sha } });
    }
    if (method === "DELETE") {
      store.delete(path);
      return mockResponse(200, {});
    }
    return mockResponse(405, {});
  };
  return { fetchFn, store };
}

test("GitHub client: put/get/list/delete over the Contents API, 404 get returns null, token is sent", async () => {
  const { fetchFn, store } = githubMockFetch();
  const seenAuth: string[] = [];
  const wrapped: DriveHttpFetch = async (url, init) => {
    if (init?.headers?.Authorization) seenAuth.push(init.headers.Authorization);
    return fetchFn(url, init);
  };
  const client = createVaultBackendClient(
    { kind: "gh", uri: "gh:alice/vault", repo: "alice/vault", accountId: "a" },
    { fetchFn: wrapped, token: "ghp_test" },
  );
  assert.equal(await client.getBlob("blobs/missing.enc"), null);
  await client.putBlob("blobs/blob_aaa.enc", new TextEncoder().encode("chunk-bytes"));
  assert.equal(store.size, 1);
  assert.deepEqual(await client.getBlob("blobs/blob_aaa.enc"), new TextEncoder().encode("chunk-bytes"));
  assert.deepEqual(await client.listBlobs("blobs"), ["blobs/blob_aaa.enc"]);
  // Overwrite works (SHA round-trip).
  await client.putBlob("blobs/blob_aaa.enc", new TextEncoder().encode("v2"));
  assert.deepEqual(await client.getBlob("blobs/blob_aaa.enc"), new TextEncoder().encode("v2"));
  await client.deleteBlob("blobs/blob_aaa.enc");
  assert.equal(await client.getBlob("blobs/blob_aaa.enc"), null);
  assert.ok(seenAuth.every((h) => h === "Bearer ghp_test"));
});

test("GitLab client: put/get/delete over the Repository Files API", async () => {
  const store = new Map<string, string>();
  const fetchFn: DriveHttpFetch = async (url, init) => {
    const parsed = new URL(url);
    const fileMatch = /^\/api\/v4\/projects\/[^/]+\/repository\/files\/(.+)$/.exec(parsed.pathname);
    if (fileMatch) {
      const path = decodeURIComponent(fileMatch[1] as string);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        const content = store.get(path);
        return content === undefined ? mockResponse(404, {}) : mockResponse(200, { content, encoding: "base64" });
      }
      if (method === "POST" || method === "PUT") {
        const body = JSON.parse(init?.body as string) as { content: string };
        store.set(path, body.content);
        return mockResponse(200, {});
      }
      if (method === "DELETE") {
        store.delete(path);
        return mockResponse(200, {});
      }
    }
    if (parsed.pathname.endsWith("/repository/tree")) {
      const prefix = parsed.searchParams.get("path") ?? "";
      const names = [...store.keys()]
        .filter((k) => k.startsWith(`${prefix}/`))
        .map((k) => ({ name: k.slice(prefix.length + 1), type: "blob", path: k }));
      return mockResponse(200, names);
    }
    return mockResponse(404, {});
  };
  const client = createVaultBackendClient(
    { kind: "gl", uri: "gl:alice/vault", repo: "alice/vault", accountId: "a" },
    { fetchFn, token: "glpat-test" },
  );
  await client.putBlob("blobs/blob_b.enc", new TextEncoder().encode("gitlab-chunk"));
  assert.deepEqual(await client.getBlob("blobs/blob_b.enc"), new TextEncoder().encode("gitlab-chunk"));
  assert.deepEqual(await client.listBlobs("blobs"), ["blobs/blob_b.enc"]);
  await client.deleteBlob("blobs/blob_b.enc");
  assert.equal(await client.getBlob("blobs/blob_b.enc"), null);
});

test("Codeberg client talks to codeberg.org, not api.github.com", async () => {
  const seen: string[] = [];
  const fetchFn: DriveHttpFetch = async (url, init) => {
    seen.push(url);
    return mockResponse(404, { message: "not found" });
  };
  const client = createVaultBackendClient(
    { kind: "cb", uri: "cb:alice/vault", repo: "alice/vault", accountId: "a" },
    { fetchFn, token: "cb-test" },
  );
  await client.getBlob("vault-index.enc.zst");
  assert.ok(seen[0]?.startsWith("https://codeberg.org/api/v1/repos/alice/vault/contents/"));
});

// --- Hugging Face: mock implementing the REAL Hub HTTP shape --------
// Verified against huggingface_hub (_commit_api.py, lfs.py,
// file_download.py) and @huggingface/hub (commit.ts, list-files.ts):
//   preupload: POST /api/datasets/{repo}/preupload/{branch}
//     {"files":[{"path","size","sample": base64(first 512 bytes)}]}
//     -> {"files":[{"path","uploadMode":"regular"|"lfs","shouldIgnore"}]}
//   commit: POST /api/datasets/{repo}/commit/{branch}
//     Content-Type: application/x-ndjson, NDJSON lines:
//     {"key":"header","value":{"summary","description":""}} then
//     {"key":"file","value":{"content": base64, "path", "encoding":"base64"}}
//     | {"key":"lfsFile","value":{"path","algo":"sha256","oid","size"}}
//     | {"key":"deletedFile","value":{"path"}}
//   LFS batch: POST /datasets/{repo}.git/info/lfs/objects/batch
//     {"operation":"upload","transfers":["basic","multipart"],
//      "objects":[{"oid": sha256hex, "size"}],"hash_algo":"sha256",
//      "ref":{"name": branch}}
//     -> {"objects":[{"oid","size","actions":{"upload":{"href"},
//        "verify":{"href"}}}]}; PUT raw bytes to upload.href (presigned,
//     NO auth header); POST verify.href {"oid","size"} when present.
//     No `actions` means the object is already present upstream.
//   download: GET /datasets/{repo}/resolve/{branch}/{path} (no /api/)
//   list: GET /api/datasets/{repo}/tree/{branch}/{path}?recursive=false&expand=false
// `lfsPaths` marks which repo paths the mock answers "lfs" for at
// preupload; `fail` injects one failure per endpoint key ("preupload",
// "commit", "batch", "put", "verify", "resolve", "tree") as an HTTP
// status, consumed on first use.
function huggingFaceMockFetch(opts: { lfsPaths?: Set<string> } = {}) {
  const store = new Map<string, Uint8Array>();
  const lfsObjects = new Map<string, Uint8Array>();
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string | Uint8Array }> = [];
  const fail: Record<string, number> = {};
  const failOnce = (key: string): number | undefined => {
    const status = fail[key];
    if (status !== undefined) delete fail[key];
    return status;
  };
  const fetchFn: DriveHttpFetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers ?? {}) };
    calls.push({ url, method, headers, body: init?.body });
    const parsed = new URL(url);
    // Presigned LFS upload / verify URLs (different host, no Hub auth).
    if (parsed.hostname === "hf-lfs.test") {
      if (parsed.pathname.startsWith("/upload/")) {
        const status = failOnce("put") ?? 200;
        if (status === 200) lfsObjects.set(parsed.pathname.slice("/upload/".length), init?.body as Uint8Array);
        return mockResponse(status, {});
      }
      if (parsed.pathname.startsWith("/verify")) {
        return mockResponse(failOnce("verify") ?? 200, {});
      }
      return mockResponse(404, {});
    }
    const preupload = /^\/api\/datasets\/([^/]+\/[^/]+)\/preupload\/[^/]+$/.exec(parsed.pathname);
    if (preupload && method === "POST") {
      const status = failOnce("preupload");
      if (status !== undefined) return mockResponse(status, { error: "injected preupload failure" });
      const payload = JSON.parse(init?.body as string) as { files: Array<{ path: string; size: number; sample: string }> };
      const files = payload.files.map((f) => ({
        path: f.path,
        uploadMode: opts.lfsPaths?.has(f.path) ? "lfs" : "regular",
        shouldIgnore: false,
        oid: null,
      }));
      return mockResponse(200, { files });
    }
    const commit = /^\/api\/datasets\/([^/]+\/[^/]+)\/commit\/[^/]+$/.exec(parsed.pathname);
    if (commit && method === "POST") {
      const status = failOnce("commit");
      if (status !== undefined) return mockResponse(status, { error: "injected commit failure" });
      const lines = (init?.body as string).trim().split("\n").map((l) => JSON.parse(l)) as Array<{
        key: string;
        value: { path?: string; content?: string; oid?: string };
      }>;
      for (const line of lines) {
        if (line.key === "file" && line.value.path) {
          store.set(line.value.path, new TextEncoder().encode(atob(line.value.content ?? "")));
        } else if (line.key === "lfsFile" && line.value.path && line.value.oid) {
          const bytes = lfsObjects.get(line.value.oid);
          if (bytes) store.set(line.value.path, bytes);
        } else if (line.key === "deletedFile" && line.value.path) {
          store.delete(line.value.path);
        }
      }
      return mockResponse(200, { commitUrl: "https://huggingface.co/commit/test", commitOid: "abc123" });
    }
    const batch = /^\/datasets\/([^/]+\/[^/]+)\.git\/info\/lfs\/objects\/batch$/.exec(parsed.pathname);
    if (batch && method === "POST") {
      const status = failOnce("batch");
      if (status !== undefined) return mockResponse(status, { error: "injected batch failure" });
      const payload = JSON.parse(init?.body as string) as { objects: Array<{ oid: string; size: number }> };
      const objects = payload.objects.map((o) => ({
        oid: o.oid,
        size: o.size,
        actions: {
          upload: { href: `https://hf-lfs.test/upload/${o.oid}` },
          verify: { href: "https://hf-lfs.test/verify" },
        },
      }));
      return mockResponse(200, { objects, transfer: "basic" });
    }
    const resolve = /^\/datasets\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(parsed.pathname);
    if (resolve) {
      const status = failOnce("resolve");
      if (status !== undefined) return mockResponse(status, { error: "injected resolve failure" });
      const bytes = store.get(decodeURIComponent(resolve[2] as string));
      return bytes === undefined ? mockResponse(404, {}) : rawResponse(200, bytes);
    }
    const tree = /^\/api\/datasets\/([^/]+\/[^/]+)\/tree\/[^/]+\/(.+)$/.exec(parsed.pathname);
    if (tree) {
      const status = failOnce("tree");
      if (status !== undefined) return mockResponse(status, { error: "injected tree failure" });
      const prefix = decodeURIComponent(tree[2] as string);
      const entries = [...store.keys()]
        .filter((k) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes("/"))
        .map((k) => ({ type: "file", path: k, size: store.get(k)?.length ?? 0 }));
      return mockResponse(200, entries);
    }
    return mockResponse(404, { error: `no mock route for ${method} ${url}` });
  };
  return { fetchFn, store, calls, fail };
}

test("Hugging Face client refuses personal files; open-science uploads use the real Hub shape (preupload -> NDJSON commit -> resolve)", async () => {
  const { fetchFn, store, calls } = huggingFaceMockFetch();
  const personal = createVaultBackendClient(
    { kind: "hf", uri: "hf:alice/vault", repo: "alice/vault", accountId: "a" },
    { fetchFn, openScience: false },
  );
  await assert.rejects(
    () => personal.putBlob("blobs/blob_x.enc", new TextEncoder().encode("my diary")),
    /open-science.*only|refused to store/,
  );
  // Refusal happens before any network call: nothing was stored.
  assert.equal(store.size, 0);
  assert.equal(calls.length, 0);
  const science = createVaultBackendClient(
    { kind: "hf", uri: "hf:alice/open-data", repo: "alice/open-data", accountId: "a" },
    { fetchFn, token: "hf_test", openScience: true },
  );
  const data = new TextEncoder().encode("dataset chunk");
  await science.putBlob("blobs/blob_y.enc", data);
  // 1. preupload: exact URL, POST, Bearer auth, JSON body with the
  //    first-512-bytes sample.
  const preupload = calls.find((c) => c.url.includes("/preupload/"));
  assert.ok(preupload, "preupload call happened");
  assert.equal(preupload.url, "https://huggingface.co/api/datasets/alice/open-data/preupload/main");
  assert.equal(preupload.method, "POST");
  assert.equal(preupload.headers.Authorization, "Bearer hf_test");
  assert.equal(preupload.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(preupload.body as string), {
    files: [{ path: "blobs/blob_y.enc", size: data.length, sample: Buffer.from(data).toString("base64") }],
  });
  // 2. commit: exact URL, POST, NDJSON content type, header + file lines.
  const commit = calls.find((c) => c.url.includes("/commit/"));
  assert.ok(commit, "commit call happened");
  assert.equal(commit.url, "https://huggingface.co/api/datasets/alice/open-data/commit/main");
  assert.equal(commit.method, "POST");
  assert.equal(commit.headers.Authorization, "Bearer hf_test");
  assert.equal(commit.headers["Content-Type"], "application/x-ndjson");
  const lines = (commit.body as string).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { key: "header", value: { summary: "ArkDrive: store blobs/blob_y.enc", description: "" } });
  assert.deepEqual(lines[1], {
    key: "file",
    value: { content: Buffer.from(data).toString("base64"), path: "blobs/blob_y.enc", encoding: "base64" },
  });
  // 3. download uses the resolve URL with NO /api/ prefix.
  assert.deepEqual(await science.getBlob("blobs/blob_y.enc"), data);
  const resolve = calls.find((c) => c.url.includes("/resolve/"));
  assert.ok(resolve);
  assert.equal(resolve.url, "https://huggingface.co/datasets/alice/open-data/resolve/main/blobs/blob_y.enc");
  assert.equal(await science.getBlob("blobs/missing.enc"), null);
});

test("Hugging Face client: large blobs go through LFS batch -> presigned PUT -> commit with lfsFile; the PUT carries no auth header", async () => {
  const { fetchFn, calls } = huggingFaceMockFetch({ lfsPaths: new Set(["blobs/blob_big.enc"]) });
  const client = createVaultBackendClient(
    { kind: "hf", uri: "hf:alice/open-data", repo: "alice/open-data", accountId: "a" },
    { fetchFn, token: "hf_test", openScience: true },
  );
  const data = new TextEncoder().encode("a big encrypted chunk");
  const shaHex = await sha256Hex(data);
  await client.putBlob("blobs/blob_big.enc", data);
  const batch = calls.find((c) => c.url.includes("/info/lfs/objects/batch"));
  assert.ok(batch, "LFS batch call happened");
  assert.equal(batch.url, "https://huggingface.co/datasets/alice/open-data.git/info/lfs/objects/batch");
  assert.equal(batch.method, "POST");
  assert.equal(batch.headers.Authorization, "Bearer hf_test");
  assert.equal(batch.headers.Accept, "application/vnd.git-lfs+json");
  assert.equal(batch.headers["Content-Type"], "application/vnd.git-lfs+json");
  assert.deepEqual(JSON.parse(batch.body as string), {
    operation: "upload",
    transfers: ["basic", "multipart"],
    objects: [{ oid: shaHex, size: data.length }],
    hash_algo: "sha256",
    ref: { name: "main" },
  });
  const put = calls.find((c) => c.url === `https://hf-lfs.test/upload/${shaHex}`);
  assert.ok(put, "presigned PUT happened");
  assert.equal(put.method, "PUT");
  assert.equal(put.headers.Authorization, undefined);
  assert.deepEqual(put.body, data);
  const verify = calls.find((c) => c.url === "https://hf-lfs.test/verify");
  assert.ok(verify, "verify POST happened");
  assert.equal(verify.method, "POST");
  assert.deepEqual(JSON.parse(verify.body as string), { oid: shaHex, size: data.length });
  const commit = calls.find((c) => c.url.includes("/commit/"));
  assert.ok(commit);
  const lines = (commit.body as string).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[1], {
    key: "lfsFile",
    value: { path: "blobs/blob_big.enc", algo: "sha256", oid: shaHex, size: data.length },
  });
  assert.deepEqual(await client.getBlob("blobs/blob_big.enc"), data);
});

test("Hugging Face client: LFS object already present upstream skips the PUT but still commits the lfsFile reference", async () => {
  // The mock answers "no actions" for the batch object when the batch
  // response is stripped of actions — the client must then skip the
  // presigned PUT entirely and still commit the lfsFile reference.
  const { fetchFn, calls } = huggingFaceMockFetch({ lfsPaths: new Set(["blobs/blob_dup.enc"]) });
  const strippingFetch: DriveHttpFetch = async (url, init) => {
    const res = await fetchFn(url, init);
    if (url.includes("/info/lfs/objects/batch")) {
      const body = (await res.json()) as { objects: Array<Record<string, unknown>> };
      const stripped = { objects: body.objects.map((o) => ({ oid: o.oid, size: o.size })) };
      return mockResponse(200, stripped);
    }
    return res;
  };
  const client = createVaultBackendClient(
    { kind: "hf", uri: "hf:alice/open-data", repo: "alice/open-data", accountId: "a" },
    { fetchFn: strippingFetch, token: "hf_test", openScience: true },
  );
  const data = new TextEncoder().encode("already upstream");
  await client.putBlob("blobs/blob_dup.enc", data);
  assert.equal(calls.filter((c) => c.url.startsWith("https://hf-lfs.test/upload/")).length, 0);
  assert.ok(calls.some((c) => c.url.includes("/commit/")), "commit still happened");
});

test("Hugging Face client: error mapping — 401 preupload -> auth_failed, 404 commit -> not_found, 409 commit -> provider_error (conflict), 429 -> rate_limited", async () => {
  const data = new TextEncoder().encode("chunk");
  const makeClient = (mock: ReturnType<typeof huggingFaceMockFetch>) =>
    createVaultBackendClient(
      { kind: "hf", uri: "hf:alice/open-data", repo: "alice/open-data", accountId: "a" },
      { fetchFn: mock.fetchFn, token: "hf_test", openScience: true },
    );
  const m401 = huggingFaceMockFetch();
  m401.fail.preupload = 401;
  await assert.rejects(() => makeClient(m401).putBlob("blobs/a.enc", data), (e: Error & { code?: string }) => {
    assert.equal(e.code, "auth_failed");
    return true;
  });
  const m404 = huggingFaceMockFetch();
  m404.fail.commit = 404;
  await assert.rejects(() => makeClient(m404).putBlob("blobs/a.enc", data), (e: Error & { code?: string }) => {
    assert.equal(e.code, "not_found");
    return true;
  });
  const m409 = huggingFaceMockFetch();
  m409.fail.commit = 409;
  await assert.rejects(() => makeClient(m409).putBlob("blobs/a.enc", data), (e: Error & { code?: string }) => {
    assert.equal(e.code, "provider_error");
    assert.match(e.message, /409|conflict/);
    return true;
  });
  const m429 = huggingFaceMockFetch();
  m429.fail.preupload = 429;
  await assert.rejects(() => makeClient(m429).putBlob("blobs/a.enc", data), (e: Error & { code?: string }) => {
    assert.equal(e.code, "rate_limited");
    return true;
  });
  const mBatch = huggingFaceMockFetch({ lfsPaths: new Set(["blobs/big.enc"]) });
  mBatch.fail.batch = 403;
  await assert.rejects(() => makeClient(mBatch).putBlob("blobs/big.enc", data), (e: Error & { code?: string }) => {
    assert.equal(e.code, "auth_failed");
    return true;
  });
});

test("Hugging Face client: delete goes through a commit with deletedFile; deleting a missing file is a no-op; list uses the tree endpoint", async () => {
  const { fetchFn, calls } = huggingFaceMockFetch();
  const client = createVaultBackendClient(
    { kind: "hf", uri: "hf:alice/open-data", repo: "alice/open-data", accountId: "a" },
    { fetchFn, token: "hf_test", openScience: true },
  );
  await client.putBlob("blobs/blob_z.enc", new TextEncoder().encode("to delete"));
  await client.putBlob("blobs/blob_keep.enc", new TextEncoder().encode("keep me"));
  assert.deepEqual(await client.listBlobs("blobs"), ["blobs/blob_z.enc", "blobs/blob_keep.enc"]);
  const tree = calls.find((c) => c.url.includes("/tree/"));
  assert.ok(tree);
  assert.equal(tree.url, "https://huggingface.co/api/datasets/alice/open-data/tree/main/blobs?recursive=false&expand=false");
  const commitsBefore = calls.filter((c) => c.url.includes("/commit/")).length;
  await client.deleteBlob("blobs/blob_z.enc");
  const deleteCommit = calls.filter((c) => c.url.includes("/commit/")).at(-1);
  assert.ok(deleteCommit);
  const lines = (deleteCommit.body as string).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[1], { key: "deletedFile", value: { path: "blobs/blob_z.enc" } });
  assert.equal(await client.getBlob("blobs/blob_z.enc"), null);
  assert.deepEqual(await client.listBlobs("blobs"), ["blobs/blob_keep.enc"]);
  // Deleting a file that is already gone sends no commit at all.
  await client.deleteBlob("blobs/blob_z.enc");
  assert.equal(calls.filter((c) => c.url.includes("/commit/")).length, commitsBefore + 1);
});


// --- per-user keys (fix round 3, 2026-11-20) -------------------------------
// Stanley's correction: every user uploads with their OWN keys — there
// is no master/shared token anywhere. A vault client without its
// owner's own token must refuse loudly BEFORE any network call, never
// send an unauthenticated request to a private vault.

test("per-user keys: vault clients refuse every operation without the owner's own token, and make no network call", async () => {
  let calls = 0;
  const fetchFn: DriveHttpFetch = async () => {
    calls++;
    return mockResponse(200, {});
  };
  const data = new TextEncoder().encode("chunk");
  for (const kind of ["gh", "gl", "cb"] as const) {
    const client = createVaultBackendClient(
      { kind, uri: `${kind}:alice/vault`, repo: "alice/vault", accountId: "a" },
      { fetchFn },
    );
    await assert.rejects(() => client.getBlob("vault-index.enc.zst"), /own .* token|sign in/i);
    await assert.rejects(() => client.putBlob("blobs/b.enc", data), /own .* token|sign in/i);
    await assert.rejects(() => client.listBlobs("blobs"), /own .* token|sign in/i);
    await assert.rejects(() => client.deleteBlob("blobs/b.enc"), /own .* token|sign in/i);
  }
  assert.equal(calls, 0, "no request may leave the client without a per-user token");
  // A whitespace-only token is no token at all.
  const blank = createVaultBackendClient(
    { kind: "gh", uri: "gh:alice/vault", repo: "alice/vault", accountId: "a" },
    { fetchFn, token: "   " },
  );
  await assert.rejects(() => blank.getBlob("vault-index.enc.zst"), /own .* token|sign in/i);
  assert.equal(calls, 0);
});

test("per-user keys: Hugging Face writes refuse without the owner's own Hub token; reads of a public open-science dataset stay token-free", async () => {
  let calls = 0;
  const fetchFn: DriveHttpFetch = async (url) => {
    calls++;
    if (url.includes("/resolve/")) return rawResponse(200, new TextEncoder().encode("public-data"));
    return mockResponse(200, { files: [{ path: "blobs/b.enc", uploadMode: "regular" }] });
  };
  const data = new TextEncoder().encode("chunk");
  const noToken = createVaultBackendClient(
    { kind: "hf", uri: "hf:alice/open-data", repo: "alice/open-data", accountId: "a" },
    { fetchFn, openScience: true },
  );
  await assert.rejects(() => noToken.putBlob("blobs/b.enc", data), /own .* Hub token|sign in/i);
  await assert.rejects(() => noToken.deleteBlob("blobs/b.enc"), /own .* Hub token|sign in/i);
  assert.equal(calls, 0, "no Hub call may happen for a write without the owner's own token");
  // Documented exception: open-science datasets are public on the Hub,
  // so reading one needs no token — only writes do.
  assert.deepEqual(await noToken.getBlob("blobs/b.enc"), new TextEncoder().encode("public-data"));
  assert.ok(calls > 0, "the public read did run");
});

// --- pooled drive ------------------------------------------------------

test("pooled view aggregates vaults + space; per-account binding is enforced", async () => {
  const ghClient = new MemoryClient("gh", "alice/gh-vault");
  const glClient = new MemoryClient("gl", "alice/gl-vault");
  const ghVault = await openVault(ghClient, "gh");
  const glVault = await openVault(glClient, "gl");
  await ghVault.uploadFile("a.txt", new TextEncoder().encode("aaa"));
  await glVault.uploadFile("b.txt", new TextEncoder().encode("bbbb"));
  await glVault.uploadFile("c.txt", new TextEncoder().encode("ccccc"));

  const pooled = new PooledDrive([
    { manager: ghVault, backend: backend("gh", ghClient.repo, "acct-alice"), accountId: "acct-alice" },
    { manager: glVault, backend: backend("gl", glClient.repo, "acct-alice"), accountId: "acct-alice" },
  ]);
  const view = await pooled.view();
  assert.equal(view.totalFiles, 3);
  assert.equal(view.vaults.length, 2);
  assert.equal(view.totalQuotaBytes, 5 * 1024 ** 3 + 10 * 1024 ** 3);
  assert.ok(view.totalUsedBytes > 0);
  assert.equal(view.byAccount.length, 1);
  assert.equal(view.byAccount[0]?.accountId, "acct-alice");

  const hits = await pooled.searchAll("b.txt");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.vault.kind, "gl");

  // Uploading to an account with no vault refuses — never falls back.
  await assert.rejects(
    () => pooled.uploadToAccount("acct-bob", "x.txt", new TextEncoder().encode("x")),
    /no vault is bound to account "acct-bob"/,
  );
  const uploaded = await pooled.uploadToAccount("acct-alice", "via-pooled.txt", new TextEncoder().encode("pooled"));
  assert.equal(uploaded.vault.kind, "gh", "first matching vault wins for the account");
  assert.equal(uploaded.file.name, "via-pooled.txt");

  const model = pooledDriveView(view);
  assert.equal(model.vaultCount, 2);
  assert.equal(model.quotas.length, 2);
  assert.ok(model.totalUsedLabel.endsWith("B") || model.totalUsedLabel.includes("KB"));
});

// --- backups -----------------------------------------------------------

test("backup/restore round-trip for a site and a bundle, with manifest", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const siteBytes = new TextEncoder().encode(JSON.stringify({ domain: "edu.orion", title: "Test" }));
  const bundleBytes = crypto.getRandomValues(new Uint8Array(1024));
  const siteBackup = await createBackup(vault, "site", "edu.orion", "edu.orion", siteBytes);
  const bundleBackup = await createBackup(vault, "bundle", "edu.orion offline", "edu.orion", bundleBytes);
  assert.equal(siteBackup.kind, "site");
  assert.equal(siteBackup.size, siteBytes.length);

  const listed = await listBackups(vault);
  assert.equal(listed.length, 2);
  assert.ok(listed.some((b) => b.id === bundleBackup.id));

  const manifest = JSON.parse(backupManifestJson(siteBackup)) as { fileHashSha256: string; kind: string };
  assert.equal(manifest.kind, "site");
  assert.equal(manifest.fileHashSha256, await sha256Hex(siteBytes));

  assert.deepEqual(await restoreBackup(vault, siteBackup.id), siteBytes);
  assert.deepEqual(await restoreBackup(vault, bundleBackup.id), bundleBytes);
  await assert.rejects(() => restoreBackup(vault, "no-such-backup"), /no backup with id/);

  // Backups live under the reserved folder, encrypted like everything else.
  const folders = await vault.listAllFolders();
  assert.equal(folders.length, 1);
  assert.equal(folders[0]?.name, "ArkNetz Backups");
});

// --- view models -------------------------------------------------------

test("drive-ui: formatBytes, file list view, honest-limits copy, delete copy", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 ** 3), "5.0 GB");
  const view = fileListView([
    { id: "1", kind: "folder", name: "Photos", parentId: null, createdAt: 0, updatedAt: 0 },
    { id: "2", kind: "file", name: "a.txt", parentId: null, createdAt: 0, updatedAt: 0, size: 2048 },
  ]);
  assert.equal(view.rows[1]?.sizeLabel, "2.0 KB");
  assert.equal(view.isEmpty, false);
  assert.equal(fileListView([]).isEmpty, true);
  assert.match(HONEST_LIMITS_COPY.sharing, /no public share links/);
  assert.match(HONEST_LIMITS_COPY.sync, /no background sync daemon/);
  assert.match(HONEST_LIMITS_COPY.collaboration, /No real-time collaborative editing/);
  assert.match(HONEST_LIMITS_COPY.passphrase, /no password reset/);
  const del = deleteConfirmationView({
    entryId: "1",
    name: "Photos",
    kind: "folder",
    descendantCount: 3,
    bytesFreed: 4096,
    orphanedChunks: 2,
    confirmed: false,
  });
  assert.match(del.body, /no trash in ArkDrive v1\.0/);
  assert.equal(del.confirmLabel, "Delete permanently");
});

// --- drag-and-drop upload ------------------------------------------------

test("drag-and-drop: dropped file is chunked, encrypted, written to the mocked backend, manifest updated", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const data = new TextEncoder().encode("dropped hello");
  const stages: string[] = [];
  const results = await vault.uploadDroppedFiles(
    [{ path: "notes.txt", data, mime: "text/plain" }],
    null,
    (p) => stages.push(p.stage),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]?.error, undefined);
  assert.equal(results[0]?.file?.name, "notes.txt");
  assert.equal(results[0]?.chunksUploaded, 1);
  assert.equal(results[0]?.chunksDeduped, 0);
  // Progress walks queued -> chunking -> encrypting -> uploading -> done.
  for (const stage of ["queued", "chunking", "encrypting", "uploading", "done"]) {
    assert.ok(stages.includes(stage), `stage ${stage} was reported (got ${stages.join(",")})`);
  }
  assert.deepEqual(stages, [...new Set(stages)].sort((a, b) => stages.indexOf(a) - stages.indexOf(b)));
  // The chunk blob is really stored, the manifest really updated.
  assert.equal(client.blobPuts, 1);
  const files = await vault.listFolder(null);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.name, "notes.txt");
  assert.deepEqual(await vault.downloadFile(files[0]?.id as string), data);
  // Reopening from the stored manifest sees the file; the stored
  // manifest leaks no plaintext filename.
  const stored = await vault.storedManifestBytes();
  assert.ok(stored && stored.length > 0);
  assert.doesNotMatch(new TextDecoder().decode(stored as Uint8Array), /notes/);
  const reopened = new VaultManager(backend("gh", client.repo, "acct-alice"), client);
  await reopened.open("correct horse battery staple");
  assert.equal((await reopened.listFolder(null))[0]?.name, "notes.txt");
});

test("drag-and-drop: dropped folder preserves relative paths", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const sunset = new TextEncoder().encode("fake-sunset-bytes");
  const results = await vault.uploadDroppedFiles([
    { path: "Photos/2026/sunset.jpg", data: sunset, mime: "image/jpeg" },
    { path: "Photos/readme.txt", data: new TextEncoder().encode("my photos"), mime: "text/plain" },
    { path: "top.txt", data: new TextEncoder().encode("root file"), mime: "text/plain" },
  ]);
  assert.equal(results.filter((r) => !r.error).length, 3);
  const folders = await vault.listAllFolders();
  assert.deepEqual(
    folders.map((f) => f.name).sort(),
    ["2026", "Photos"],
  );
  const photos = folders.find((f) => f.name === "Photos") as { id: string };
  const y2026 = folders.find((f) => f.name === "2026") as { id: string };
  assert.equal((await vault.listFolder(photos.id)).map((f) => f.name).sort().join(","), "2026,readme.txt");
  const in2026 = await vault.listFolder(y2026.id);
  assert.equal(in2026.length, 1);
  assert.equal(in2026[0]?.name, "sunset.jpg");
  assert.deepEqual(await vault.downloadFile(in2026[0]?.id as string), sunset);
  assert.equal((await vault.listFolder(null)).map((f) => f.name).sort().join(","), "Photos,top.txt");
  // Dropping the same folder again reuses it — no duplicate folder.
  await vault.uploadDroppedFiles([{ path: "Photos/2026/second.jpg", data: new TextEncoder().encode("two") }]);
  assert.equal((await vault.listAllFolders()).length, 2);
  assert.equal((await vault.listFolder(y2026.id)).length, 2);
});

test("drag-and-drop: duplicate content is deduped — no new chunk written", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const data = new TextEncoder().encode("same bytes, twice");
  const first = await vault.uploadDroppedFiles([{ path: "copy-a.txt", data }]);
  assert.equal(first[0]?.chunksUploaded, 1);
  const putsAfterFirst = client.blobPuts;
  const second = await vault.uploadDroppedFiles([{ path: "copy-b.txt", data }]);
  assert.equal(second[0]?.error, undefined);
  assert.equal(second[0]?.chunksUploaded, 0, "no chunk was re-uploaded");
  assert.equal(second[0]?.chunksDeduped, 1);
  assert.equal(client.blobPuts, putsAfterFirst);
  assert.deepEqual(await vault.downloadFile(second[0]?.file?.id as string), data);
  assert.deepEqual(await vault.downloadFile(first[0]?.file?.id as string), data);
});

test("drag-and-drop: failed backend write surfaces an error and leaves the manifest unchanged", async () => {
  // Fails blob writes once, then behaves: proves the failed upload did
  // not leave a phantom chunk record behind (without the rollback the
  // retry would report the chunk as deduped and the download would fail).
  class FailOnceClient extends MemoryClient {
    failBlobsOnce = true;
    override async putBlob(path: string, data: Uint8Array): Promise<void> {
      if (path.startsWith("blobs/") && this.failBlobsOnce) {
        this.failBlobsOnce = false;
        throw new Error("simulated provider failure writing blob");
      }
      return super.putBlob(path, data);
    }
  }
  const client = new FailOnceClient();
  const vault = await openVault(client);
  const before = await vault.storedManifestBytes();
  const beforeBytes = before ? new Uint8Array(before) : null;
  const data = new TextEncoder().encode("this write will fail");
  const stages: string[] = [];
  const failed = await vault.uploadDroppedFiles([{ path: "unlucky.txt", data }], null, (p) => stages.push(p.stage));
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.file, null);
  assert.match(failed[0]?.error ?? "", /simulated provider failure/);
  assert.ok(stages.includes("error"), "the error stage was reported, not swallowed");
  // Stored manifest byte-identical; no file listed.
  assert.deepEqual(await vault.storedManifestBytes(), beforeBytes);
  assert.equal((await vault.listFolder(null)).length, 0);
  // Retry now succeeds and really stores the chunk.
  const retried = await vault.uploadDroppedFiles([{ path: "unlucky.txt", data }]);
  assert.equal(retried[0]?.error, undefined);
  assert.equal(retried[0]?.chunksUploaded, 1);
  assert.deepEqual(await vault.downloadFile(retried[0]?.file?.id as string), data);
});

test("drag-and-drop: one bad file does not stop the rest; '..' paths are refused per file", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  const results = await vault.uploadDroppedFiles([
    { path: "../escape.txt", data: new TextEncoder().encode("evil") },
    { path: "good.txt", data: new TextEncoder().encode("fine") },
    { path: "", data: new TextEncoder().encode("nameless") },
  ]);
  assert.equal(results.length, 3);
  assert.match(results[0]?.error ?? "", /\.\./);
  assert.equal(results[0]?.file, null);
  assert.equal(results[1]?.error, undefined);
  assert.equal(results[1]?.file?.name, "good.txt");
  assert.match(results[2]?.error ?? "", /no name/);
  assert.equal((await vault.listFolder(null)).length, 1);
});

test("drag-and-drop: duplicate names are a per-file error, not a batch abort", async () => {
  const client = new MemoryClient();
  const vault = await openVault(client);
  await vault.uploadFile("dup.txt", new TextEncoder().encode("one"));
  const results = await vault.uploadDroppedFiles([
    { path: "dup.txt", data: new TextEncoder().encode("two") },
    { path: "other.txt", data: new TextEncoder().encode("three") },
  ]);
  assert.match(results[0]?.error ?? "", /already exists/);
  assert.equal(results[1]?.error, undefined);
  assert.equal((await vault.listFolder(null)).length, 2);
});

test("drag-and-drop: path helpers normalise and split dropped paths", () => {
  assert.equal(normalizeDroppedPath("/Photos//2026/sunset.jpg"), "Photos/2026/sunset.jpg");
  assert.equal(normalizeDroppedPath("Photos\\2026\\a.txt"), "Photos/2026/a.txt");
  assert.deepEqual(splitDroppedPath("Photos/2026/sunset.jpg"), { folders: ["Photos", "2026"], name: "sunset.jpg" });
  assert.deepEqual(splitDroppedPath("notes.txt"), { folders: [], name: "notes.txt" });
});

// --- drive-ui: drop progress, tracker, DataTransfer, binder -----------

test("drive-ui: dropUploadProgressView labels every stage; errors stay in the row", () => {
  const done = dropUploadProgressView({
    fileName: "a.txt",
    relativePath: "Photos/a.txt",
    stage: "done",
    bytesDone: 12,
    bytesTotal: 12,
    chunksDone: 1,
    chunksTotal: 1,
    chunksDeduped: 1,
  });
  assert.equal(done.percent, 100);
  assert.equal(done.stageLabel, "Done");
  assert.match(done.detail, /deduped/);
  const failed = dropUploadProgressView({
    fileName: "b.txt",
    relativePath: "b.txt",
    stage: "error",
    bytesDone: 0,
    bytesTotal: 9,
    chunksDone: 0,
    chunksTotal: 0,
    chunksDeduped: 0,
    error: "simulated provider failure writing blob",
  });
  assert.equal(failed.isError, true);
  assert.match(failed.detail, /simulated provider failure/);
  assert.equal(failed.stageLabel, "Failed");
});

test("drive-ui: DropUploadTracker tracks queued -> done and keeps failed rows with their error", () => {
  const tracker = new DropUploadTracker();
  tracker.start("Photos/a.txt", 12);
  tracker.start("b.txt", 9);
  tracker.update({
    fileName: "a.txt",
    relativePath: "Photos/a.txt",
    stage: "done",
    bytesDone: 12,
    bytesTotal: 12,
    chunksDone: 1,
    chunksTotal: 1,
    chunksDeduped: 0,
  });
  tracker.fail("b.txt", "provider refused the write");
  const view = tracker.view();
  assert.equal(view.total, 2);
  assert.equal(view.doneCount, 1);
  assert.equal(view.failedCount, 1);
  assert.equal(view.activeCount, 0);
  assert.equal(view.allDone, true);
  assert.equal(view.items.find((i) => i.relativePath === "b.txt")?.detail, "provider refused the write");
  // The progress callback feeds straight into the tracker.
  const cb = tracker.progressCallback();
  cb({
    fileName: "c.txt",
    relativePath: "c.txt",
    stage: "uploading",
    bytesDone: 5,
    bytesTotal: 10,
    chunksDone: 0,
    chunksTotal: 1,
    chunksDeduped: 0,
  });
  assert.equal(tracker.view().activeCount, 1);
  assert.equal(tracker.get("c.txt")?.stage, "uploading");
});

function fakeDroppedFile(name: string, text: string, relativePath = "") {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    type: "text/plain",
    webkitRelativePath: relativePath,
    arrayBuffer: async (): Promise<ArrayBuffer> =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

test("drive-ui: collectDroppedFiles traverses a dropped folder and falls back to the files list", async () => {
  const fileEntry = (fullPath: string, text: string) => ({
    isFile: true as const,
    isDirectory: false as const,
    name: fullPath.split("/").pop() as string,
    fullPath,
    file: (ok: (f: ReturnType<typeof fakeDroppedFile>) => void) => {
      ok(fakeDroppedFile(fullPath.split("/").pop() as string, text));
    },
  });
  let readCalls = 0;
  const dirEntry = {
    isFile: false as const,
    isDirectory: true as const,
    name: "Photos",
    fullPath: "/Photos",
    createReader: () => ({
      readEntries: (ok: (entries: unknown[]) => void) => {
        ok(readCalls++ === 0 ? [fileEntry("/Photos/a.txt", "aaa"), fileEntry("/Photos/b.txt", "bbb")] : []);
      },
    }),
  };
  const viaItems = await collectDroppedFiles({
    items: [{ kind: "file", webkitGetAsEntry: () => dirEntry as never }],
  } as never);
  assert.deepEqual(
    viaItems.map((f) => f.path),
    ["Photos/a.txt", "Photos/b.txt"],
  );
  assert.equal(new TextDecoder().decode(viaItems[0]?.data as Uint8Array), "aaa");

  // Empty dropped folder is kept as a folder-only entry.
  const emptyDir = {
    isFile: false as const,
    isDirectory: true as const,
    name: "Empty",
    fullPath: "/Empty",
    createReader: () => ({ readEntries: (ok: (entries: unknown[]) => void) => ok([]) }),
  };
  const empty = await collectDroppedFiles({
    items: [{ kind: "file", webkitGetAsEntry: () => emptyDir as never }],
  } as never);
  assert.deepEqual(empty.map((f) => f.path), ["Empty/"]);

  // No items: fall back to the files list, keeping webkitRelativePath.
  const viaFiles = await collectDroppedFiles({
    files: [fakeDroppedFile("x.txt", "xxx", "Docs/x.txt")],
  } as never);
  assert.deepEqual(viaFiles.map((f) => f.path), ["Docs/x.txt"]);
  assert.equal(new TextDecoder().decode(viaFiles[0]?.data as Uint8Array), "xxx");
});

test("drive-ui: isFileDrag only lights up for file drags", () => {
  assert.equal(isFileDrag({ types: ["Files"] }), true);
  assert.equal(isFileDrag({ types: ["text/plain"] }), false);
  assert.equal(isFileDrag(null), false);
  assert.equal(isFileDrag(undefined), false);
});

class FakeDropElement {
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly classes = new Set<string>();
  readonly attrs = new Map<string, string>();
  readonly classList = {
    add: (c: string) => {
      this.classes.add(c);
    },
    remove: (c: string) => {
      this.classes.delete(c);
    },
    contains: (c: string) => this.classes.has(c),
  };
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  setAttribute(key: string, value: string): void {
    this.attrs.set(key, value);
  }
  removeAttribute(key: string): void {
    this.attrs.delete(key);
  }
  dispatch(type: string, event: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

function dragEvent(dataTransfer: unknown) {
  let prevented = false;
  return {
    dataTransfer: dataTransfer as never,
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  };
}

test("drive-ui: bindDriveDropZone highlights on file dragover, collects on drop, unbind removes listeners", async () => {
  const element = new FakeDropElement();
  const received: DroppedUpload[] = [];
  const dragStates: boolean[] = [];
  const unbind = bindDriveDropZone(element as unknown as HTMLElement, {
    onFiles: (files) => {
      received.push(...files);
    },
    onDragStateChange: (dragging) => dragStates.push(dragging),
  });
  // A text drag does not light the zone up.
  element.dispatch("dragenter", dragEvent({ types: ["text/plain"] }));
  assert.equal(element.classes.has("drive-drop-active"), false);
  // A file drag does.
  const enter = dragEvent({ types: ["Files"] });
  element.dispatch("dragenter", enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(element.classes.has("drive-drop-active"), true);
  assert.equal(element.attrs.get("data-drag-over"), "true");
  const over = dragEvent({ types: ["Files"], dropEffect: "" });
  element.dispatch("dragover", over);
  assert.equal(over.defaultPrevented, true);
  assert.equal((over.dataTransfer as { dropEffect: string }).dropEffect, "copy");
  // Drop collects the files and hands them over.
  element.dispatch("drop", dragEvent({ types: ["Files"], files: [fakeDroppedFile("d.txt", "dropped")] }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.path, "d.txt");
  assert.equal(new TextDecoder().decode(received[0]?.data as Uint8Array), "dropped");
  assert.equal(element.classes.has("drive-drop-active"), false);
  assert.deepEqual(dragStates, [true, false]);
  // Unbind removes every listener.
  unbind();
  assert.equal([...element.listeners.values()].every((list) => list.length === 0), true);
});

test("drive-ui: bindDriveDropZone reports an unreadable drop via onError, never silently", async () => {
  const element = new FakeDropElement();
  const errors: Error[] = [];
  bindDriveDropZone(element as unknown as HTMLElement, {
    onFiles: () => {
      throw new Error("uploader exploded");
    },
    onError: (error) => errors.push(error),
  });
  element.dispatch("drop", dragEvent({ types: ["Files"], files: [fakeDroppedFile("d.txt", "dropped")] }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /uploader exploded/);
});
