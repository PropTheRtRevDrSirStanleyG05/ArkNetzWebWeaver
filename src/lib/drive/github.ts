// ArkNetzWebWeaver — GitHub vault client (gh:).
// Private repo as an encrypted blob store, via the GitHub Contents API.
// Reads use the Contents API (not raw.githubusercontent.com) because
// vault repos are private — raw URLs need auth too, and the Contents
// API gives us the blob SHA needed for safe overwrite/delete.
// No network call happens here without the injected fetchFn.

import {
  base64Decode,
  base64Encode,
  encodePathSegment,
  httpError,
  readErrorBody,
} from "./backends.js";
import type { DriveHttpFetch, VaultBackendClient } from "./backends.js";
import { DriveBackendError } from "./backends.js";
import type { DriveBackendKind } from "./types.js";

export interface GitContentsClientOptions {
  repo: string; // "owner/repo"
  branch: string;
  token?: string;
  fetchFn: DriveHttpFetch;
  /** e.g. "https://api.github.com" or "https://codeberg.org/api/v1". */
  apiBase: string;
}

/**
 * GitHub-compatible Contents API client (GitHub + Codeberg/Forgejo).
 * Vault layout is flat — manifest at the repo root, chunks under
 * "blobs/" — so directory listing is one level, non-recursive.
 */
export class GitContentsClient implements VaultBackendClient {
  readonly kind: DriveBackendKind = "gh";
  readonly repo: string;
  readonly branch: string;
  protected readonly token?: string;
  protected readonly fetchFn: DriveHttpFetch;
  protected readonly apiBase: string;

  constructor(opts: GitContentsClientOptions) {
    this.repo = opts.repo;
    this.branch = opts.branch;
    this.token = opts.token;
    this.fetchFn = opts.fetchFn;
    this.apiBase = opts.apiBase.replace(/\/$/, "");
  }

  protected authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    // Token is guaranteed present by requireOwnToken() (called at the
    // top of every public method): vault repos are private, so an
    // unauthenticated request must never be sent.
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /**
   * Per-user key rule (fix round 3, 2026-11-20 — Stanley's correction:
   * every user uploads with their OWN keys; there is no master/shared
   * token anywhere). Vault repos are private, so every operation needs
   * the vault owner's own token. Refuse loudly BEFORE any network call
   * when it is missing — never send an unauthenticated request and let
   * the provider's ambiguous 401/404 be the error, and never fall back
   * to another account's token.
   */
  protected requireOwnToken(): void {
    if (!this.token?.trim()) {
      const label = this.kind === "cb" ? "Codeberg" : "GitHub";
      throw new DriveBackendError(
        `ArkDrive ${label} vault "${this.repo}" needs your own ${label} token — sign in / link your own ${label} account first. There is no shared or master vault token; ArkDrive never reads or writes a private vault without the owner's own credential.`,
        "auth_failed",
      );
    }
  }

  protected contentsUrl(path: string): string {
    const encoded = path.split("/").map(encodePathSegment).join("/");
    return `${this.apiBase}/repos/${this.repo}/contents/${encoded}`;
  }

  /** GET the contents entry for a path: null on 404, else {sha, content?}. */
  protected async getEntry(path: string): Promise<{ sha: string; content?: string } | null> {
    this.requireOwnToken();
    const url = `${this.contentsUrl(path)}?ref=${encodePathSegment(this.branch)}`;
    const res = await this.fetchFn(url, { method: "GET", headers: this.authHeaders() });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 400) {
      throw httpError(res.status, `reading ${path} from ${this.repo}`);
    }
    const body = (await res.json()) as { sha?: string; content?: string };
    if (typeof body.sha !== "string") {
      throw new DriveBackendError(`unexpected response reading ${path} from ${this.repo}`, "provider_error");
    }
    return { sha: body.sha, content: body.content };
  }

  async getBlob(path: string): Promise<Uint8Array | null> {
    const entry = await this.getEntry(path);
    if (!entry || typeof entry.content !== "string") return null;
    return base64Decode(entry.content);
  }

  async putBlob(path: string, data: Uint8Array): Promise<void> {
    // Fetch the existing SHA first: without it the API refuses to
    // overwrite, and with a stale SHA it refuses too (safe update).
    const existing = await this.getEntry(path);
    const res = await this.fetchFn(this.contentsUrl(path), {
      method: "PUT",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `ArkDrive: store ${path}`,
        content: base64Encode(data),
        branch: this.branch,
        ...(existing ? { sha: existing.sha } : {}),
      }),
    });
    if (res.status >= 400) {
      const detail = await readErrorBody(res);
      throw new DriveBackendError(
        `storing ${path} in ${this.repo} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        res.status === 401 || res.status === 403 ? "auth_failed" : res.status === 429 ? "rate_limited" : "provider_error",
      );
    }
  }

  async deleteBlob(path: string): Promise<void> {
    const existing = await this.getEntry(path);
    if (!existing) return; // already gone — delete is idempotent
    const res = await this.fetchFn(this.contentsUrl(path), {
      method: "DELETE",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ message: `ArkDrive: delete ${path}`, sha: existing.sha, branch: this.branch }),
    });
    if (res.status >= 400 && res.status !== 404) {
      const detail = await readErrorBody(res);
      throw new DriveBackendError(
        `deleting ${path} from ${this.repo} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
        res.status === 401 || res.status === 403 ? "auth_failed" : res.status === 429 ? "rate_limited" : "provider_error",
      );
    }
  }

  async listBlobs(prefix: string): Promise<string[]> {
    this.requireOwnToken();
    const url = `${this.contentsUrl(prefix)}?ref=${encodePathSegment(this.branch)}`;
    const res = await this.fetchFn(url, { method: "GET", headers: this.authHeaders() });
    if (res.status === 404) return [];
    if (res.status >= 400) throw httpError(res.status, `listing ${prefix} in ${this.repo}`);
    const body = (await res.json()) as Array<{ name?: string; type?: string }>;
    if (!Array.isArray(body)) return [];
    return body
      .filter((e) => e.type === "file" && typeof e.name === "string")
      .map((e) => `${prefix.replace(/\/$/, "")}/${e.name as string}`);
  }
}

export class GithubVaultClient extends GitContentsClient {
  override readonly kind = "gh" as const;

  constructor(opts: Omit<GitContentsClientOptions, "apiBase">) {
    super({ ...opts, apiBase: "https://api.github.com" });
  }
}
