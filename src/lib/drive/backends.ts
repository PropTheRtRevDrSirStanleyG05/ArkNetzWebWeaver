// ArkNetzWebWeaver — ArkDrive backend clients (thread turns 42 + 46).
// Four real clients (github.ts, gitlab.ts, codeberg.ts, huggingface.ts)
// implement put/get/list/delete against an injected fetch — no network
// calls to real providers happen in this module or its tests; the fetch
// is always supplied by the caller (mocked in tests, the app's
// authenticated fetch in production).
//
// REFUSALS (enforced in code, not just documented):
// - ia:/wm: — Internet Archive and Wikimedia are EXCLUDED from ArkDrive
//   by ToS (public cultural/educational preservation only; opaque
//   encrypted personal blobs violate it). Constructing a drive backend
//   for either throws. There are no IA/WM drive clients in this tree.
// - hf: personal files — Hugging Face is open-science/AI/code only.
//   The HF client refuses any upload the caller has not marked
//   open-science, with a clear error.

import type { DriveBackendKind, ExcludedDriveBackendKind, VaultBackend } from "./types.js";
import { DRIVE_BACKEND_KINDS, EXCLUDED_DRIVE_BACKEND_KINDS } from "./types.js";
import { GithubVaultClient } from "./github.js";
import { GitlabVaultClient } from "./gitlab.js";
import { CodebergVaultClient } from "./codeberg.js";
import { HuggingFaceVaultClient } from "./huggingface.js";

export class DriveBackendError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unsupported_backend"
      | "hf_personal_files_refused"
      | "not_found"
      | "auth_failed"
      | "rate_limited"
      | "provider_error",
  ) {
    super(message);
    this.name = "DriveBackendError";
  }
}

/** Minimal fetch surface the clients need. The app injects the real
 *  fetch (with auth headers per provider); tests inject a mock. */
export interface DriveHttpResponse {
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type DriveHttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array },
) => Promise<DriveHttpResponse>;

/** A vault's blob store: the manifest + encrypted chunks, addressed by
 *  repo-relative path (e.g. "vault-index.enc.zst", "blobs/blob_….enc").
 *  All four provider clients implement this; the drive logic above it
 *  never sees provider differences. */
export interface VaultBackendClient {
  readonly kind: DriveBackendKind;
  readonly repo: string;
  readonly branch: string;
  putBlob(path: string, data: Uint8Array): Promise<void>;
  getBlob(path: string): Promise<Uint8Array | null>;
  deleteBlob(path: string): Promise<void>;
  /** Blob paths directly under `prefix` (non-recursive; the vault
   *  layout is flat: manifest at root, chunks under "blobs/"). */
  listBlobs(prefix: string): Promise<string[]>;
}

/** Parse a backend URI like "gh:alice/arknetz-vault".
 *  Throws DriveBackendError("unsupported_backend") for ia:/wm: and for
 *  any unknown prefix. */
export function parseVaultBackendUri(uri: string): { kind: DriveBackendKind; repo: string } {
  const match = /^([a-z]+):(.+)$/.exec(uri.trim());
  if (!match) {
    throw new DriveBackendError(
      `invalid vault backend URI "${uri}" — expected "<prefix>:<owner>/<repo>", e.g. "gh:alice/arknetz-vault"`,
      "unsupported_backend",
    );
  }
  const prefix = match[1] as string;
  const repo = match[2] as string;
  if ((EXCLUDED_DRIVE_BACKEND_KINDS as string[]).includes(prefix)) {
    const kind = prefix as ExcludedDriveBackendKind;
    const reason =
      kind === "ia"
        ? "the Internet Archive is for public cultural/educational preservation — uploading opaque encrypted personal blobs violates its Terms of Use. Keep IA strictly for public site media."
        : "Wikimedia Commons is strictly for freely licensed, educational/encyclopedic media — uploading opaque encrypted personal blobs violates its scope. Keep Wikimedia strictly for public site media.";
    throw new DriveBackendError(
      `ArkDrive cannot use "${prefix}:" as a vault backend. ${reason}`,
      "unsupported_backend",
    );
  }
  if (!(DRIVE_BACKEND_KINDS as string[]).includes(prefix)) {
    throw new DriveBackendError(
      `unknown vault backend prefix "${prefix}:" — ArkDrive supports gh:, gl:, cb: and hf: only (ia: and wm: are excluded by ToS)`,
      "unsupported_backend",
    );
  }
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new DriveBackendError(
      `invalid vault repo "${repo}" — expected "<owner>/<repo>", e.g. "alice/arknetz-vault"`,
      "unsupported_backend",
    );
  }
  return { kind: prefix as DriveBackendKind, repo };
}

export interface CreateVaultClientOptions {
  /** The caller's fetch. Required — clients never call global fetch
   *  themselves, so tests can mock every byte. */
  fetchFn: DriveHttpFetch;
  /** Provider token (OAuth / personal access token) for the vault
   *  OWNER's own account. Per-user key rule (fix round 3): there is no
   *  shared or master vault token. The token is checked at first use —
   *  every client method refuses loudly without the owner's own token
   *  (HF reads are the one exception: open-science datasets are public
   *  on the Hub, so get/list need no token; HF writes still do). */
  token?: string;
  /** Hugging Face only: the caller must mark the vault open-science
   *  (ML datasets, model weights, research backups, open-source code).
   *  Without it the HF client refuses every upload. */
  openScience?: boolean;
}

/** Build the right client for a vault backend. Throws for ia:/wm: and
 *  for unknown prefixes (see parseVaultBackendUri), and for an HF vault
 *  without openScience. */
export function createVaultBackendClient(backend: VaultBackend, opts: CreateVaultClientOptions): VaultBackendClient {
  const { kind, repo } = parseVaultBackendUri(backend.uri);
  const branch = backend.branch ?? "main";
  const base = { repo, branch, token: opts.token, fetchFn: opts.fetchFn };
  switch (kind) {
    case "gh":
      return new GithubVaultClient(base);
    case "gl":
      return new GitlabVaultClient(base);
    case "cb":
      return new CodebergVaultClient(base);
    case "hf":
      return new HuggingFaceVaultClient({ ...base, openScience: opts.openScience ?? false });
  }
}

/** Shared helpers for the provider clients. */

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
  const cleaned = text.replace(/\s/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/** Map an HTTP status to a DriveBackendError, with a plain-English
 *  message. 401/403 = bad token, 404 = missing file, 429 = slow down. */
export function httpError(status: number, what: string): DriveBackendError {
  if (status === 401 || status === 403) {
    return new DriveBackendError(
      `${what} failed: HTTP ${status} — the account token is missing, expired, or lacks access to this repo. Re-link the account and try again.`,
      "auth_failed",
    );
  }
  if (status === 429) {
    return new DriveBackendError(
      `${what} failed: HTTP 429 — the provider is rate-limiting this account. Wait a few minutes and try again; the local copy is kept.`,
      "rate_limited",
    );
  }
  return new DriveBackendError(`${what} failed: HTTP ${status}`, "provider_error");
}

export async function readErrorBody(res: DriveHttpResponse): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}
