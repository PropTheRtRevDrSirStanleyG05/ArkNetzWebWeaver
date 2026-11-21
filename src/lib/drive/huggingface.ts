// ArkNetzWebWeaver — Hugging Face vault client (hf:).
// OPEN-SCIENCE ONLY (thread turns 42 + 46): Hugging Face's terms say
// public repos must be useful to AI/ML/open-science — NOT arbitrary
// personal cloud drives. This client enforces that in code: unless the
// caller marks the vault open-science (ML datasets, model weights,
// research backups, open-source code), every upload is refused with a
// clear error. Personal files belong in gh:/gl:/cb: private repos.
//
// Storage: a Hugging Face dataset repo, via the Hub HTTP API.
// No network call happens here without the injected fetch.
//
// REQUEST SHAPE — verified 2026-11-20 against the official Hub clients
// (the Hub publishes no raw-HTTP reference; the SDKs ARE the contract):
//  - Upload: POST /api/datasets/{repo}/preupload/{branch} with JSON
//    {"files":[{"path","size","sample": base64(first 512 bytes)}]} — the
//    server answers {"files":[{"path","uploadMode":"regular"|"lfs",
//    "shouldIgnore","oid"}]} — then POST /api/datasets/{repo}/commit/
//    {branch} with Content-Type: application/x-ndjson, one JSON object
//    per line: {"key":"header","value":{"summary","description"}} then
//    {"key":"file","value":{"content": base64, "path", "encoding":
//    "base64"}} for regular files, or {"key":"lfsFile","value":{"path",
//    "algo":"sha256","oid": sha256hex, "size"}} for LFS files.
//    (huggingface_hub src/huggingface_hub/_commit_api.py:
//    _fetch_upload_modes, _prepare_commit_payload, _send_commit;
//    @huggingface/hub packages/hub/src/lib/commit.ts.)
//  - LFS upload (when preupload says "lfs"): POST
//    https://huggingface.co/datasets/{repo}.git/info/lfs/objects/batch
//    with Accept/Content-Type: application/vnd.git-lfs+json and JSON
//    {"operation":"upload","transfers":["basic","multipart"],"objects":
//    [{"oid": sha256hex, "size"}],"hash_algo":"sha256","ref":{"name":
//    branch}}; then a single PUT of the raw bytes to the returned
//    actions.upload.href (a presigned URL — NO auth header), then POST
//    the actions.verify.href with {"oid","size"} if the server sent one.
//    (huggingface_hub src/huggingface_hub/lfs.py: post_lfs_batch_info,
//    lfs_upload, _upload_single_part.)
//  - Delete: the same /commit endpoint with {"key":"deletedFile",
//    "value":{"path"}} — there is no DELETE /api/.../delete endpoint.
//  - Download: GET https://huggingface.co/datasets/{repo}/resolve/
//    {branch}/{path} — note: NO /api/ prefix.
//    (huggingface_hub src/huggingface_hub/file_download.py: hf_hub_url.)
//  - List: GET /api/datasets/{repo}/tree/{branch}/{path}?recursive=false
//    &expand=false, entries {type:"file"|"directory", path, ...}.
//    (@huggingface/hub packages/hub/src/lib/list-files.ts.)
//  - Auth on every Hub API call: Authorization: Bearer <token>.
//  - Docs: https://huggingface.co/docs/huggingface_hub/v2.4.0/guides/upload.md
//    ("upload_file() ... done through a HTTP post request", create_commit
//    under the hood) and https://huggingface.co/docs/huggingface.js/main/hub/README
//    (JS SDK uploadFiles/commit).
// NOT live-verified: no real upload/download has ever run against a
// live Hugging Face account with a real token, so server behaviour
// (exact error bodies, the preupload size threshold that flips a file
// to LFS, multipart-transfer responses for very large blobs) is still
// UNVERIFIED against a live account. This client only implements the
// basic single-part LFS transfer; if the batch endpoint ever answers
// with a multipart (chunk_size) transfer, putBlob fails loudly instead
// of silently corrupting the vault.

import { base64Encode, httpError, readErrorBody } from "./backends.js";
import type { DriveHttpFetch, DriveHttpResponse, VaultBackendClient } from "./backends.js";
import { DriveBackendError } from "./backends.js";
import { sha256Hex } from "./crypto.js";

export interface HuggingFaceVaultClientOptions {
  repo: string; // "owner/dataset-repo"
  branch: string;
  token?: string;
  fetchFn: DriveHttpFetch;
  /** Required true: the caller asserts this vault holds open-science /
   *  AI / code content only. False (default) refuses all uploads. */
  openScience: boolean;
}

type UploadMode = "regular" | "lfs";

interface PreuploadFile {
  path?: string;
  uploadMode?: string;
  shouldIgnore?: boolean;
  oid?: string | null;
}

interface LfsBatchObject {
  oid?: string;
  size?: number;
  actions?: {
    upload?: { href?: string; header?: Record<string, unknown> };
    verify?: { href?: string; header?: Record<string, unknown> };
  };
  error?: { message?: string; code?: number };
}

export class HuggingFaceVaultClient implements VaultBackendClient {
  readonly kind = "hf" as const;
  readonly repo: string;
  readonly branch: string;
  private readonly token?: string;
  private readonly fetchFn: DriveHttpFetch;
  private readonly openScience: boolean;
  private static readonly HUB_BASE = "https://huggingface.co";
  /** First bytes sent to /preupload so the Hub can pick regular vs LFS. */
  private static readonly PREUPLOAD_SAMPLE_BYTES = 512;

  constructor(opts: HuggingFaceVaultClientOptions) {
    this.repo = opts.repo;
    this.branch = opts.branch;
    this.token = opts.token;
    this.fetchFn = opts.fetchFn;
    this.openScience = opts.openScience;
  }

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    // Token is guaranteed present for writes by requireOwnToken()
    // (put/delete). Reads stay unauthenticated on purpose: an
    // open-science Hub dataset is public by the Hub's own rules, so a
    // guest may read it; only WRITES need the owner's own Hub token.
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (contentType) headers["Content-Type"] = contentType;
    return headers;
  }

  /**
   * Per-user key rule (fix round 3, 2026-11-20): every Hub write needs
   * the dataset owner's own Hub token. Refuse loudly BEFORE any network
   * call when it is missing — never send an unauthenticated write, never
   * fall back to another account's token; there is no shared Hub token.
   * (Reads are the deliberate exception: open-science datasets are
   * public on the Hub, so getBlob/listBlobs need no token.)
   */
  private requireOwnToken(): void {
    if (!this.token?.trim()) {
      throw new DriveBackendError(
        `ArkDrive Hugging Face dataset "${this.repo}" needs your own Hugging Face Hub token — sign in / link your own Hugging Face account first. There is no shared or master Hub token; ArkDrive never writes without the owner's own credential.`,
        "auth_failed",
      );
    }
  }

  /** ToS gate: refuse the upload before any bytes move. */
  private requireOpenScience(path: string): void {
    if (!this.openScience) {
      throw new DriveBackendError(
        `refused to store "${path}" in Hugging Face repo ${this.repo}: Hugging Face is open-science/AI/code only — ` +
          `public repos must be useful to AI/ML/open-science, not arbitrary personal files. ` +
          `Use a private GitHub, GitLab or Codeberg vault for personal files, or mark this vault open-science (ML datasets, model weights, research backups, open-source code) if it really is.`,
        "hf_personal_files_refused",
      );
    }
  }

  private encodeRepoPath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  private apiUrl(suffix: string): string {
    return `${HuggingFaceVaultClient.HUB_BASE}/api/datasets/${this.repo}/${suffix}`;
  }

  /** Map a Hub HTTP status to a DriveBackendError. 401/403 = bad token,
   *  404 = repo/branch/file missing, 409 = commit conflict (the repo
   *  moved under this commit — retry the operation), 429 = slow down. */
  private errorFor(status: number, what: string, detail = ""): DriveBackendError {
    if (status === 401 || status === 403) {
      return new DriveBackendError(
        `${what} failed: HTTP ${status} — the Hugging Face token is missing, expired, or lacks write access to ${this.repo}. Re-link the account and try again.${detail ? ` ${detail}` : ""}`,
        "auth_failed",
      );
    }
    if (status === 404) {
      return new DriveBackendError(
        `${what} failed: HTTP 404 — repo ${this.repo} or branch ${this.branch} was not found on Hugging Face. Check the vault URI and that the repo exists.${detail ? ` ${detail}` : ""}`,
        "not_found",
      );
    }
    if (status === 409) {
      return new DriveBackendError(
        `${what} failed: HTTP 409 — the repo changed while this commit was being made (conflicting commit). Retry the operation; the local copy is kept.${detail ? ` ${detail}` : ""}`,
        "provider_error",
      );
    }
    if (status === 429) {
      return new DriveBackendError(
        `${what} failed: HTTP 429 — Hugging Face is rate-limiting this account. Wait a few minutes and try again; the local copy is kept.`,
        "rate_limited",
      );
    }
    return new DriveBackendError(
      `${what} failed: HTTP ${status}${detail ? ` — ${detail}` : ""}`,
      "provider_error",
    );
  }

  private async throwIfError(
    status: number,
    what: string,
    res: DriveHttpResponse,
  ): Promise<void> {
    if (status < 400) return;
    throw this.errorFor(status, what, await readErrorBody(res));
  }

  private resolveUrl(path: string): string {
    // Download URL has NO /api/ prefix (hf_hub_url).
    return `${HuggingFaceVaultClient.HUB_BASE}/datasets/${this.repo}/resolve/${encodeURIComponent(this.branch)}/${this.encodeRepoPath(path)}`;
  }

  async getBlob(path: string): Promise<Uint8Array | null> {
    const res = await this.fetchFn(this.resolveUrl(path), { method: "GET", headers: this.headers() });
    if (res.status === 404) return null;
    if (res.status >= 400) throw httpError(res.status, `reading ${path} from ${this.repo}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Ask the Hub whether this blob goes in as a regular git blob or an
   *  LFS object. The server decides (size/content); the client obeys. */
  private async fetchUploadMode(path: string, data: Uint8Array): Promise<UploadMode> {
    const url = this.apiUrl(`preupload/${encodeURIComponent(this.branch)}`);
    const sample = base64Encode(data.subarray(0, HuggingFaceVaultClient.PREUPLOAD_SAMPLE_BYTES));
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({ files: [{ path, size: data.length, sample }] }),
    });
    if (res.status >= 400) {
      throw this.errorFor(res.status, `preparing upload of ${path} to ${this.repo}`, await readErrorBody(res));
    }
    const body = (await res.json()) as { files?: PreuploadFile[] };
    const file = Array.isArray(body?.files)
      ? body.files.find((f) => f.path === path)
      : undefined;
    if (!file || typeof file.uploadMode !== "string") {
      throw new DriveBackendError(
        `preparing upload of ${path} to ${this.repo} failed: the Hub preupload response did not name an upload mode for this file`,
        "provider_error",
      );
    }
    if (file.shouldIgnore) {
      throw new DriveBackendError(
        `refused to store "${path}" in Hugging Face repo ${this.repo}: the repo's .gitignore excludes this vault path, so the Hub would silently drop it. Remove the ignore rule or pick another repo.`,
        "provider_error",
      );
    }
    if (file.uploadMode !== "regular" && file.uploadMode !== "lfs") {
      throw new DriveBackendError(
        `preparing upload of ${path} to ${this.repo} failed: the Hub asked for unknown upload mode "${file.uploadMode}"`,
        "provider_error",
      );
    }
    return file.uploadMode;
  }

  /** POST one NDJSON commit to the Hub: a header line plus the given
   *  operation lines. Returns nothing; throws a mapped error on 4xx/5xx. */
  private async sendCommit(operationLines: Array<Record<string, unknown>>, summary: string): Promise<void> {
    const url = this.apiUrl(`commit/${encodeURIComponent(this.branch)}`);
    const lines = [
      { key: "header", value: { summary, description: "" } },
      ...operationLines,
    ];
    const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers("application/x-ndjson"),
      body,
    });
    await this.throwIfError(res.status, `committing ${summary} in ${this.repo}`, res);
  }

  /** LFS path: batch endpoint -> single PUT to the presigned URL ->
   *  optional verify POST. No-ops the PUT when the server says the
   *  object is already present (no `actions` in the batch answer). */
  private async uploadLfsObject(path: string, data: Uint8Array, shaHex: string): Promise<void> {
    const batchUrl = `${HuggingFaceVaultClient.HUB_BASE}/datasets/${this.repo}.git/info/lfs/objects/batch`;
    const batchRes = await this.fetchFn(batchUrl, {
      method: "POST",
      headers: {
        ...this.headers(),
        Accept: "application/vnd.git-lfs+json",
        "Content-Type": "application/vnd.git-lfs+json",
      },
      body: JSON.stringify({
        operation: "upload",
        transfers: ["basic", "multipart"],
        objects: [{ oid: shaHex, size: data.length }],
        hash_algo: "sha256",
        ref: { name: this.branch },
      }),
    });
    if (batchRes.status >= 400) {
      throw this.errorFor(batchRes.status, `requesting LFS upload for ${path} in ${this.repo}`, await readErrorBody(batchRes));
    }
    const batchBody = (await batchRes.json()) as { objects?: LfsBatchObject[] };
    const object = Array.isArray(batchBody?.objects) ? batchBody.objects[0] : undefined;
    if (!object || typeof object.oid !== "string" || typeof object.size !== "number") {
      throw new DriveBackendError(
        `requesting LFS upload for ${path} in ${this.repo} failed: the Hub LFS batch response did not describe this object`,
        "provider_error",
      );
    }
    if (object.error) {
      throw new DriveBackendError(
        `requesting LFS upload for ${path} in ${this.repo} failed: ${object.error.message ?? "the Hub refused this object"} (code ${object.error.code ?? "?"})`,
        "provider_error",
      );
    }
    const upload = object.actions?.upload;
    if (!upload) return; // Object already present upstream — nothing to PUT.
    if (typeof upload.href !== "string") {
      throw new DriveBackendError(
        `requesting LFS upload for ${path} in ${this.repo} failed: the Hub LFS batch response had no upload URL`,
        "provider_error",
      );
    }
    if (upload.header && typeof upload.header === "object" && "chunk_size" in upload.header) {
      // Multipart transfer (very large objects): not implemented in this
      // client. Fail loudly rather than half-uploading a vault blob.
      throw new DriveBackendError(
        `storing ${path} in ${this.repo} failed: the Hub asked for a multipart LFS upload, which this client does not implement (single-part only). Split the file into smaller vault chunks or use a gh:/gl:/cb: vault.`,
        "provider_error",
      );
    }
    // Presigned URL — no Authorization header (the URL carries the auth).
    const putRes = await this.fetchFn(upload.href, { method: "PUT", headers: {}, body: data });
    if (putRes.status >= 400) {
      throw this.errorFor(putRes.status, `uploading LFS bytes for ${path} to ${this.repo}`, await readErrorBody(putRes));
    }
    const verify = object.actions?.verify;
    if (verify && typeof verify.href === "string") {
      const verifyRes = await this.fetchFn(verify.href, {
        method: "POST",
        headers: this.headers("application/json"),
        body: JSON.stringify({ oid: shaHex, size: data.length }),
      });
      if (verifyRes.status >= 400) {
        throw this.errorFor(verifyRes.status, `verifying LFS upload of ${path} in ${this.repo}`, await readErrorBody(verifyRes));
      }
    }
  }

  async putBlob(path: string, data: Uint8Array): Promise<void> {
    this.requireOpenScience(path);
    this.requireOwnToken();
    const mode = await this.fetchUploadMode(path, data);
    if (mode === "regular") {
      await this.sendCommit(
        [{ key: "file", value: { content: base64Encode(data), path, encoding: "base64" } }],
        `ArkDrive: store ${path}`,
      );
      return;
    }
    const shaHex = await sha256Hex(data);
    await this.uploadLfsObject(path, data, shaHex);
    await this.sendCommit(
      [{ key: "lfsFile", value: { path, algo: "sha256", oid: shaHex, size: data.length } }],
      `ArkDrive: store ${path}`,
    );
  }

  async deleteBlob(path: string): Promise<void> {
    this.requireOwnToken();
    // Delete is idempotent, like the GitHub client: a missing file is
    // already gone, and an empty delete commit would be rejected.
    if ((await this.getBlob(path)) === null) return;
    await this.sendCommit(
      [{ key: "deletedFile", value: { path } }],
      `ArkDrive: delete ${path}`,
    );
  }

  async listBlobs(prefix: string): Promise<string[]> {
    const url = this.apiUrl(
      `tree/${encodeURIComponent(this.branch)}/${this.encodeRepoPath(prefix)}?recursive=false&expand=false`,
    );
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers() });
    if (res.status === 404) return [];
    if (res.status >= 400) throw httpError(res.status, `listing ${prefix} in ${this.repo}`);
    const body = (await res.json()) as Array<{ path?: string; type?: string }>;
    if (!Array.isArray(body)) return [];
    return body
      .filter((e) => e.type === "file" && typeof e.path === "string")
      .map((e) => e.path as string);
  }
}
