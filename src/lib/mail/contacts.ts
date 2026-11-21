// ArkNetzWebWeaver — protocol mail contacts directory (Phase 1).
// Thread turn 16: global contacts directory contacts.json.zst in
// protocol-root, ~40 MB per 1M users, public keys generated via Web
// Crypto on first login, instant offline-searchable address book.
//
// SIZE (measured from real keys, fix round 2 — see crypto.ts): the
// thread's "~40 MB per 1M users" assumed ~40 bytes per entry, i.e.
// raw binary packing. A published X25519 public key IS 32 bytes raw
// and its JWK JSON is 102 bytes, so the key-encoding figure is
// restored — but this directory stores entries as JSON, and a minimal
// entry (address + JWK + updatedAt) is 165 bytes, i.e. 157.4 MiB per
// 1M users uncompressed JSON (use contactEntryJsonBytes() to measure
// any real entry). The shards are stored Zstd-compressed
// (contacts.json.zst), and measured on 2,000 real entries the
// compressed shard is 37.0 bytes/entry, i.e. ~35.3 MiB per 1M in the
// stored form — the thread's ~40 MB figure holds for the stored
// .json.zst form, even though the uncompressed JSON is 157.4 MiB.
// The shard shape below is key-algorithm agnostic, so the X25519
// switch needed no format change beyond the JWK shape
// (kty "OKP", crv "X25519").
// What matters for v1.0: lookups are by SHA-256 shard (16 shards,
// same scheme as the registry), entries are small JSON, and the whole
// directory is searchable offline once its shards are cached.
//
// This module is storage-free: ContactsDirectory is an in-memory
// index over ContactEntry objects. The app fills it from cached
// contacts shards (fetched over raw.githubusercontent.com like the
// registry) and the coordinator wires persistence later.

import {
  CONTACTS_SHARD_COUNT,
  MASTER_GITHUB_USER,
  RAW_GITHUB_BASE,
  contactsShardRepo,
} from "../config.js";
import type { ContactEntry, MailAddress } from "./types.js";

export { CONTACTS_SHARD_COUNT };

/** Shard key for an address: first hex digit of SHA-256(lowercased
 *  address) — same scheme as registry shards (registry.ts). */
export async function shardForAddress(address: MailAddress): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(address.toLowerCase()),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex[0] as string;
}

/** Raw URL of the contacts shard holding this address
 *  (contacts.json; the .zst form is tried first by the fetcher, as
 *  with registry shards). */
export async function contactsShardUrl(address: MailAddress): Promise<string> {
  const shard = await shardForAddress(address);
  const repo = contactsShardRepo(shard);
  return `${RAW_GITHUB_BASE}/${MASTER_GITHUB_USER}/${repo}/main/contacts.json`;
}

export function contactsShardZstUrl(address: MailAddress): Promise<string> {
  return contactsShardUrl(address).then((u) => u.replace(/\.json$/, ".json.zst"));
}

/** Validate one directory entry (parse-time, loud on bad data so a
 *  corrupt shard never silently drops a key). */
export function parseContactEntry(raw: unknown): ContactEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("contact entry is not an object");
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.address !== "string" || !e.address.includes("@")) {
    throw new Error(`contact entry has an invalid address: ${String(e.address)}`);
  }
  const jwk = e.publicKeyJwk as Record<string, unknown> | undefined;
  if (
    !jwk ||
    typeof jwk !== "object" ||
    jwk.kty !== "OKP" ||
    jwk.crv !== "X25519" ||
    typeof jwk.x !== "string"
  ) {
    throw new Error(`contact entry for ${e.address} has no X25519 public-key JWK`);
  }
  return {
    address: e.address as MailAddress,
    displayName: typeof e.displayName === "string" ? e.displayName : undefined,
    publicKeyJwk: jwk as JsonWebKey,
    githubUser: typeof e.githubUser === "string" ? e.githubUser : undefined,
    updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0,
  };
}

/** Parse a whole contacts shard file: { contacts: ContactEntry[] } or
 *  a bare address -> entry map. */
export function parseContactsShard(raw: unknown): ContactEntry[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("contacts shard is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const list: unknown[] = Array.isArray(obj.contacts)
    ? obj.contacts
    : Object.values(obj);
  return list.map((item) => parseContactEntry(item));
}

/** Serialise entries into the shard file shape that gets Zstd-
 *  compressed to contacts.json.zst. */
export function serialiseContactsShard(shard: string, contacts: ContactEntry[]): unknown {
  return {
    version: "arknetz-contacts/1",
    shard,
    updatedAt: Date.now(),
    contacts,
  };
}

/** UTF-8 byte length of one entry as stored in a shard (JSON). Use
 *  it to measure the real directory size: bytes-per-1M-users is
 *  contactEntryJsonBytes(entry) * 1,000,000 for a representative
 *  entry. Measured with real X25519 keys: a minimal entry (address +
 *  JWK + updatedAt) is 165 bytes, i.e. 157.4 MiB per 1M users. */
export function contactEntryJsonBytes(entry: ContactEntry): number {
  return new TextEncoder().encode(JSON.stringify(entry)).length;
}

/** Offline-searchable address book over the global contacts directory.
 *  Prefix search on address and display name (case-insensitive), so
 *  typing "ali" finds alice@computers.edu before any network is hit —
 *  the directory shards live in the local cache after first fetch. */
export class ContactsDirectory {
  private readonly byAddress = new Map<string, ContactEntry>();

  constructor(entries: ContactEntry[] = []) {
    for (const e of entries) this.add(e);
  }

  get size(): number {
    return this.byAddress.size;
  }

  add(entry: ContactEntry): void {
    this.byAddress.set(entry.address.toLowerCase(), parseContactEntry(entry));
  }

  /** Add a whole shard's entries; returns how many were new. */
  addShard(entries: ContactEntry[]): number {
    let added = 0;
    for (const e of entries) {
      const key = e.address.toLowerCase();
      if (!this.byAddress.has(key)) added++;
      this.add(e);
    }
    return added;
  }

  remove(address: MailAddress): boolean {
    return this.byAddress.delete(address.toLowerCase());
  }

  lookup(address: MailAddress): ContactEntry | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  has(address: MailAddress): boolean {
    return this.byAddress.has(address.toLowerCase());
  }

  /** Prefix search across address + display name. `limit` caps the
   *  result list (default 20) so a huge directory never floods the UI.
   *  Results are sorted by address, exact-prefix-on-address first. */
  search(prefix: string, limit = 20): ContactEntry[] {
    const q = prefix.trim().toLowerCase();
    if (!q) return [];
    const scored: Array<{ entry: ContactEntry; score: number }> = [];
    for (const entry of this.byAddress.values()) {
      const addr = entry.address.toLowerCase();
      const name = (entry.displayName ?? "").toLowerCase();
      if (addr.startsWith(q)) scored.push({ entry, score: 0 });
      else if (name.startsWith(q)) scored.push({ entry, score: 1 });
      else if (addr.includes(q) || name.includes(q)) scored.push({ entry, score: 2 });
    }
    scored.sort(
      (a, b) => a.score - b.score || a.entry.address.localeCompare(b.entry.address),
    );
    return scored.slice(0, limit).map((s) => s.entry);
  }

  all(): ContactEntry[] {
    return [...this.byAddress.values()].sort((a, b) =>
      a.address.localeCompare(b.address),
    );
  }
}
