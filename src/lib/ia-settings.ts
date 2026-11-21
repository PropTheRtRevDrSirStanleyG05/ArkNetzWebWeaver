// ArkNetzWebWeaver — Internet Archive account linking (Settings).
// The stealth IA upload needs the user's own IA S3 keys
// (archive.org/account/s3.php). This module is the ONLY place that
// stores them: encrypted with AES-256-GCM (key from a passphrase via
// PBKDF2, 100k iterations — see encryptIaKeys / decryptIaKeys in
// ia-media.ts), in IndexedDB. The passphrase never leaves memory and
// is never stored. The SECRET KEY is never displayed, never logged,
// and never appears in any status object — status carries only the
// username and the last 4 characters of the access key.
// States: unlinked -> linked-locked (keys stored, passphrase needed)
// -> linked-unlocked (keys decrypted, held in memory only).
// Unlink deletes the stored blob. Test connection does a HEAD on the
// user's IA item with LOW auth: 200/404 means the keys were accepted
// (404 = item not created yet, auth still fine), 403 means bad keys.

import { IA_S3_BASE } from "./config.js";
import type { IaKeys } from "./ia-media.js";
import { decryptIaKeys, encryptIaKeys, iaItemNameForUser } from "./ia-media.js";

export interface StoredIaAccount {
  username: string;
  /** Last 4 chars of the access key, for display only. */
  accessKeyLast4: string;
  ciphertext: string;
  salt: string;
  iv: string;
  linkedAt: number;
}

export interface IaAccountStore {
  get(): Promise<StoredIaAccount | undefined>;
  put(account: StoredIaAccount): Promise<void>;
  delete(): Promise<void>;
}

export function createMemoryIaAccountStore(): IaAccountStore {
  let stored: StoredIaAccount | undefined;
  return {
    async get() {
      return stored;
    },
    async put(account) {
      stored = account;
    },
    async delete() {
      stored = undefined;
    },
  };
}

const IA_DB = "arknetz-ia";
const IA_STORE = "account";

export function createIndexedDBIaAccountStore(): IaAccountStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(IA_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IA_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const withStore = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const r = fn(db.transaction(IA_STORE, mode).objectStore(IA_STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: () => withStore("readonly", (s) => s.get("ia-account")),
    put: async (account) => {
      await withStore("readwrite", (s) => s.put(account, "ia-account"));
    },
    delete: async () => {
      await withStore("readwrite", (s) => s.delete("ia-account"));
    },
  };
}

export type IaAccountStatus =
  | { linked: false }
  | { linked: true; locked: true; username: string; accessKeyLast4: string; linkedAt: number }
  | { linked: true; locked: false; username: string; accessKeyLast4: string; linkedAt: number };

export function maskAccessKey(accessKey: string): string {
  return accessKey.slice(-4);
}

export function validateIaCredentials(input: {
  username: string;
  accessKey: string;
  secretKey: string;
  passphrase: string;
}): string[] {
  const problems: string[] = [];
  if (!input.username.trim()) problems.push("IA username is required");
  if (!input.accessKey.trim()) problems.push("IA S3 access key is required");
  if (!input.secretKey.trim()) problems.push("IA S3 secret key is required");
  if (input.passphrase.length < 8) problems.push("passphrase must be at least 8 characters — it protects your IA keys on this device");
  return problems;
}

/** Link (or re-link) an IA account: validate, encrypt the keys under
 *  the passphrase, store only the ciphertext + metadata. The returned
 *  status never contains the secret key. */
export async function linkIaAccount(
  store: IaAccountStore,
  input: { username: string; accessKey: string; secretKey: string; passphrase: string },
): Promise<IaAccountStatus> {
  const problems = validateIaCredentials(input);
  if (problems.length > 0) throw new Error(`Cannot link Internet Archive account: ${problems.join("; ")}`);
  const keys: IaKeys = {
    username: input.username.trim(),
    accessKey: input.accessKey.trim(),
    secretKey: input.secretKey.trim(),
  };
  const encrypted = await encryptIaKeys(keys, input.passphrase);
  const account: StoredIaAccount = {
    username: keys.username,
    accessKeyLast4: maskAccessKey(keys.accessKey),
    ...encrypted,
    linkedAt: Date.now(),
  };
  await store.put(account);
  return {
    linked: true,
    locked: true,
    username: account.username,
    accessKeyLast4: account.accessKeyLast4,
    linkedAt: account.linkedAt,
  };
}

export async function getIaAccountStatus(store: IaAccountStore): Promise<IaAccountStatus> {
  const stored = await store.get();
  if (!stored) return { linked: false };
  return {
    linked: true,
    locked: true,
    username: stored.username,
    accessKeyLast4: stored.accessKeyLast4,
    linkedAt: stored.linkedAt,
  };
}

/** Unlock with the passphrase: decrypts the keys into memory only.
 *  A wrong passphrase throws — the stored blob is untouched, so the
 *  user can retry. */
export async function unlockIaAccount(store: IaAccountStore, passphrase: string): Promise<IaKeys> {
  const stored = await store.get();
  if (!stored) throw new Error("No Internet Archive account is linked — link one in Settings first");
  try {
    return await decryptIaKeys(
      { ciphertext: stored.ciphertext, salt: stored.salt, iv: stored.iv },
      passphrase,
    );
  } catch {
    throw new Error("Wrong passphrase — the stored IA keys were not decrypted. Try again.");
  }
}

export async function unlinkIaAccount(store: IaAccountStore): Promise<void> {
  await store.delete();
}

export type IaTestFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Test the keys against IA S3: HEAD the user's monthly media item
 *  with LOW auth. 200 (item exists) or 404 (item not created yet) both
 *  mean the keys were accepted; 403 means IA rejected them.
 *  Per-user key rule (fix round 3): blank keys return not-ok WITHOUT
 *  any network call — testing an empty `LOW :` header proves nothing
 *  and must never look like a real check. */
export async function testIaConnection(
  keys: IaKeys,
  fetchFn: IaTestFetchFn,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!keys || !keys.accessKey?.trim() || !keys.secretKey?.trim() || !keys.username?.trim()) {
    return {
      ok: false,
      reason:
        "No Internet Archive keys to test — link your own Internet Archive account in Settings first (archive.org/account/s3.php). There is no shared IA key.",
    };
  }
  const item = iaItemNameForUser(keys.username);
  const url = `${IA_S3_BASE}/${encodeURIComponent(item)}/`;
  let res;
  try {
    res = await fetchFn(url, {
      method: "HEAD",
      headers: { Authorization: `LOW ${keys.accessKey}:${keys.secretKey}` },
    });
  } catch (err) {
    return { ok: false, reason: `Could not reach the Internet Archive: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 200 || res.status === 404) return { ok: true };
  if (res.status === 403) {
    return { ok: false, reason: "Internet Archive rejected these keys (HTTP 403) — check the S3 access key and secret key at archive.org/account/s3.php" };
  }
  return { ok: false, reason: `Internet Archive returned HTTP ${res.status} — keys could not be verified` };
}
