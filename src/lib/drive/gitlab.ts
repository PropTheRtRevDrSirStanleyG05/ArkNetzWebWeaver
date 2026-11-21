// ArkNetzWebWeaver — GitLab vault client (gl:).
// Private project as an encrypted blob store, via the GitLab Repository
// Files API. Up to 10 GiB per project — the ideal primary vault /
// backup mirror (thread turn 46). No network call without injected fetch.

import { base64Decode, base64Encode, httpError, readErrorBody } from "./backends.js";
import type { DriveHttpFetch, VaultBackendClient } from "./backends.js";
import { DriveBackendError } from "./backends.js";

export interface GitlabVaultClientOptions {
  repo: string; // "owner/project" (URL-encoded for the API)
  branch: string;
  token?: string;
  fetchFn: DriveHttpFetch;
}

export class GitlabVaultClient implements VaultBackendClient {
  readonly kind = "gl" as const;
  readonly repo: string;
  readonly branch: string;
  private readonly token?: string;
  private readonly fetchFn: DriveHttpFetch;
  private static readonly API_BASE = "https://gitlab.com/api/v4";

  constructor(opts: GitlabVaultClientOptions) {
    this.repo = opts.repo;
    this.branch = opts.branch;
    this.token = opts.token;
    this.fetchFn = opts.fetchFn;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    // Token is guaranteed present by requireOwnToken() (called at the
    // top of every public method): vault projects are private.
    if (this.token) headers["PRIVATE-TOKEN"] = this.token;
    return headers;
  }

  /**
   * Per-user key rule (fix round 3, 2026-11-20): vault projects are
   * private, so every operation needs the vault owner's own GitLab
   * token. Refuse loudly BEFORE any network call when it is missing —
   * never send an unauthenticated request, never fall back to another
   * account's token; there is no shared or master vault token.
   */
  private requireOwnToken(): void {
    if (!this.token?.trim()) {
      throw new DriveBackendError(
        `ArkDrive GitLab vault "${this.repo}" needs your own GitLab token — sign in / link your own GitLab account first. There is no shared or master vault token; ArkDrive never reads or writes a private vault without the owner's own credential.`,
        "auth_failed",
      );
    }
  }

  private projectId(): string {
    return encodeURIComponent(this.repo);
  }

  private fileUrl(path: string): string {
    return `${GitlabVaultClient.API_BASE}/projects/${this.projectId()}/repository/files/${encodeURIComponent(path)}`;
  }

  async getBlob(path: string): Promise<Uint8Array | null> {
    this.requireOwnToken();
    const res = await this.fetchFn(`${this.fileUrl(path)}?ref=${encodeURIComponent(this.branch)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (res.status >= 400) throw httpError(res.status, `reading ${path} from ${this.repo}`);
    const body = (await res.json()) as { content?: string; encoding?: string };
    if (typeof body.content !== "string" || body.encoding !== "base64") {
      throw new DriveBackendError(`unexpected response reading ${path} from ${this.repo}`, "provider_error");
    }
    return base64Decode(body.content);
  }

  async putBlob(path: string, data: Uint8Array): Promise<void> {
    this.requireOwnToken();
    const exists = (await this.getBlob(path)) !== null;
    const method = exists ? "PUT" : "POST";
    const res = await this.fetchFn(this.fileUrl(path), {
      method,
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        branch: this.branch,
        content: base64Encode(data),
        encoding: "base64",
        commit_message: `ArkDrive: store ${path}`,
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
    this.requireOwnToken();
    const res = await this.fetchFn(this.fileUrl(path), {
      method: "DELETE",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ branch: this.branch, commit_message: `ArkDrive: delete ${path}` }),
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
    const url =
      `${GitlabVaultClient.API_BASE}/projects/${this.projectId()}/repository/tree` +
      `?path=${encodeURIComponent(prefix)}&ref=${encodeURIComponent(this.branch)}&per_page=100`;
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers() });
    if (res.status === 404) return [];
    if (res.status >= 400) throw httpError(res.status, `listing ${prefix} in ${this.repo}`);
    const body = (await res.json()) as Array<{ name?: string; type?: string; path?: string }>;
    if (!Array.isArray(body)) return [];
    return body
      .filter((e) => e.type === "blob" && typeof e.path === "string")
      .map((e) => e.path as string);
  }
}
