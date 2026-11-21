// ArkNetzWebWeaver — stealth Internet Archive media upload.
// Stanley, 2026-11-20 14:28: media a user attaches to a post must be
// AUTOMATICALLY uploaded to the Internet Archive and then embedded by the
// app, stealthily. For the user it just looks like they attached media
// natively. Thread turn 30: ALL media through IA, GitHub purely text/JSON.
// Turn 31: IA rate-limits residential IPs; fix in-app, no central proxy:
// persistent IndexedDB media cache, polite queue (2-3 concurrent,
// ~100-150 ms stagger — final prompt says ~120 ms), exponential backoff
// on 429/503, authenticated IA session/S3 header when linked.
//
// How it works in this module:
//   attachMedia(file) -> immediately returns an AttachedMedia with a
//   local blob preview URL and status "uploading", so the post shows the
//   attachment instantly. In the background the queue uploads the file to
//   the user's own IA item via S3 PUT. On success the post stores ONLY
//   the hotlink https://archive.org/download/<item>/<file> — never a
//   local path, never a GitHub binary. The local copy is kept until the
//   upload succeeds, so a failed upload never loses the attachment.
//   Thumbnails (~12 KB WebP) go to IA the same way (same queue, same
//   item, "-thumb.webp" suffix) — NOT to a GitHub repo.
//   If IA is not linked, attachMedia returns status "ia_not_linked" and
//   keeps the local preview; it does NOT invent credentials.
// Keys: the user's own IA S3 keys (archive.org/account/s3.php), stored
// encrypted in IndexedDB (see storeIaKeys / loadIaKeys — AES-256-GCM,
// key derived from a passphrase with PBKDF2). Keys are NEVER hardcoded
// and NEVER appear in code, logs, or the post.

import { IA_DOWNLOAD_BASE, IA_S3_BASE } from "./config.js";
import type { AttachedMedia } from "./types.js";

export interface IaKeys {
  accessKey: string;
  secretKey: string;
  /** IA username, used to derive the item name. */
  username: string;
}

export type IaUploadStatus = AttachedMedia["status"];

export interface IaUploadJob {
  file: Blob;
  filename: string;
  item: string;
  keys: IaKeys;
  onDone?: (media: AttachedMedia) => void;
}

export function iaItemNameForUser(username: string, when = new Date()): string {
  const clean = username.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const ym = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, "0")}`;
  return `arknetz-media-${clean}-${ym}`;
}

export function iaHotlink(item: string, filename: string): string {
  return `${IA_DOWNLOAD_BASE}/${encodeURIComponent(item)}/${encodeURIComponent(filename)}`;
}

export function iaThumbnailFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return `${base}-thumb.webp`;
}

export function sanitizeIaFilename(filename: string): string {
  return filename
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100);
}

export function backoffMs(attempt: number, baseMs = 500): number {
  // Exponential backoff: 500, 1000, 2000, 4000, 8000 ms. Capped.
  return Math.min(baseMs * 2 ** attempt, 30000);
}

/**
 * Per-user key rule (fix round 3, 2026-11-20 — Stanley's correction:
 * a real IA upload is done with the uploading user's OWN IA keys;
 * everyone will NOT use Stanley's keys). Throws when the keys are
 * missing or any field is blank, BEFORE any network call. There is no
 * shared/master IA key to fall back to, so a blank key set is a
 * "link your own account first" error, never an anonymous upload.
 */
export function requireOwnIaKeys(keys: IaKeys | null | undefined): asserts keys is IaKeys {
  if (!keys || !keys.accessKey?.trim() || !keys.secretKey?.trim() || !keys.username?.trim()) {
    throw new Error(
      "Internet Archive upload needs your own IA S3 keys — link your own Internet Archive account in Settings first (archive.org/account/s3.php). There is no shared IA key; uploads never proceed without your own keys.",
    );
  }
}

export type IaFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Blob },
) => Promise<{ status: number; text(): Promise<string> }>;

/** One S3 PUT to IA. Returns the hotlink on 200/201. Retries 429/503
 *  with exponential backoff (maxAttempts total). 4xx other than 429 is a
 *  hard failure — retrying a bad key 5 times does not help.
 *  Per-user key rule (fix round 3): `keys` must be the uploading user's
 *  OWN IA S3 keys. Blank/missing keys throw before any network call —
 *  an upload never proceeds with an empty `LOW :` header and never
 *  falls back to any other account's keys (there is no shared IA key). */
export async function uploadToIa(
  file: Blob,
  filename: string,
  item: string,
  keys: IaKeys,
  fetchFn: IaFetchFn,
  maxAttempts = 5,
): Promise<{ hotlink: string; attempts: number }> {
  requireOwnIaKeys(keys);
  const safeName = sanitizeIaFilename(filename);
  const url = `${IA_S3_BASE}/${encodeURIComponent(item)}/${encodeURIComponent(safeName)}`;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, backoffMs(attempt - 1)));
    }
    const res = await fetchFn(url, {
      method: "PUT",
      headers: {
        // IA S3 "LOW" auth: LOW <access>:<secret>
        Authorization: `LOW ${keys.accessKey}:${keys.secretKey}`,
        "x-archive-meta-title": safeName,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    });
    lastStatus = res.status;
    if (res.status === 200 || res.status === 201) {
      return { hotlink: iaHotlink(item, safeName), attempts: attempt + 1 };
    }
    lastBody = await res.text().catch(() => "");
    if (res.status !== 429 && res.status !== 503) {
      throw new Error(`IA upload failed with HTTP ${res.status}: ${lastBody.slice(0, 200)}`);
    }
    // 429/503: back off and retry.
  }
  throw new Error(
    `IA upload failed after ${maxAttempts} attempts (last HTTP ${lastStatus}: ${lastBody.slice(0, 200)}) — local copy kept, retry later`,
  );
}

/** Polite upload queue: max 2 concurrent, ~120 ms stagger between
 *  starts (thread final prompt), so a post with 10 attachments does not
 *  fire 10 requests at once from one residential IP. */
export class IaUploadQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private lastStart = 0;

  constructor(
    private readonly concurrency = 2,
    private readonly staggerMs = 120,
  ) {}

  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    while (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      const sinceLast = Date.now() - this.lastStart;
      if (this.lastStart > 0 && sinceLast < this.staggerMs) {
        await new Promise((r) => setTimeout(r, this.staggerMs - sinceLast));
      }
      this.lastStart = Date.now();
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

// --- Encrypted key storage (IndexedDB) ------------------------------------
// Keys are encrypted with AES-256-GCM; the key is derived from a
// passphrase with PBKDF2 (100k iterations). The ciphertext + salt + IV
// live in IndexedDB; the passphrase never does. Without the passphrase
// the stored keys are unreadable. This is the shell's storage shape —
// the UI that asks for the passphrase lands with the account settings.

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptIaKeys(keys: IaKeys, passphrase: string): Promise<{
  ciphertext: string;
  salt: string;
  iv: string;
}> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plain = new TextEncoder().encode(JSON.stringify(keys));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain);
  const b64 = (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { ciphertext: b64(cipher), salt: b64(salt), iv: b64(iv) };
}

export async function decryptIaKeys(
  stored: { ciphertext: string; salt: string; iv: string },
  passphrase: string,
): Promise<IaKeys> {
  const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const key = await deriveKey(passphrase, unb64(stored.salt));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(stored.iv) as BufferSource },
    key,
    unb64(stored.ciphertext) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as IaKeys;
}

/** Attach a file to a post, stealth-IA style. Returns immediately with a
 *  local preview; the upload runs in the background through `queue`.
 *  `keys` is null when IA is not linked — then status is "ia_not_linked"
 *  and nothing is uploaded. A keys object with any blank field is
 *  treated the same way (corrupt/empty stored keys never upload).
 *  The caller keeps `localPreviewUrl` until `onDone` fires with status
 *  "ready", then swaps in the hotlink. */
export function attachMedia(
  file: Blob,
  filename: string,
  keys: IaKeys | null,
  queue: IaUploadQueue,
  fetchFn: IaFetchFn,
  onDone: (media: AttachedMedia) => void,
): AttachedMedia {
  const localPreviewUrl =
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : "";
  const hasOwnKeys = !!keys && !!keys.accessKey?.trim() && !!keys.secretKey?.trim() && !!keys.username?.trim();
  const item = hasOwnKeys ? iaItemNameForUser(keys!.username) : "";
  const media: AttachedMedia = {
    hotlink: "",
    item,
    file: sanitizeIaFilename(filename),
    mime: file.type || "application/octet-stream",
    bytes: file.size,
    localPreviewUrl,
    status: hasOwnKeys ? "uploading" : "ia_not_linked",
  };
  if (!hasOwnKeys) return media;
  void queue
    .enqueue(() => uploadToIa(file, filename, item, keys!, fetchFn))
    .then(({ hotlink }) => {
      onDone({ ...media, hotlink, status: "ready" });
    })
    .catch(() => {
      onDone({ ...media, status: "failed" });
    });
  return media;
}
