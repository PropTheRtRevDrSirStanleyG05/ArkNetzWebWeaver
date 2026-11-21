// ArkNetzWebWeaver — native multi-account support (thread turn 45).
// One-click account switching across EVERY backend (gh:, gl:, cb:, ia:,
// hf:, wm:), because all tokens / S3 keys live encrypted locally in
// IndexedDB, not in one rigid server session. Personal, organisation /
// school, and side-project accounts stay signed in simultaneously; switching
// never logs anything out.
//
// Encryption: AES-256-GCM, key from the vault passphrase via PBKDF2
// (100,000 iterations, SHA-256) — the same construction as the IA keys in
// src/lib/ia-media.ts. A locked keyring holds ciphertext only; the
// passphrase is never stored. The store is injected (IndexedDB in the
// browser, memory in tests) so this module is testable in Node.
//
// Smart per-site auto-binding: each site remembers which backend accounts
// own it; opening a site auto-selects the matching accounts, so a
// commit / upload never goes to the wrong account. If the bound account
// is not signed in, opening the site fails loudly with the exact reason
// instead of silently using the wrong account.
//
// Master Admin Badge: Root Master controls appear only when the ACTIVE
// GitHub account is PropTheRtRevDrSirStanleyG05 (MASTER_GITHUB_USER).
// Enforcement is GitHub's 403 on protocol-root writes, never the UI.
//
// Licence: MIT. No new dependencies.

import { MASTER_GITHUB_USER } from "../config.js";

export type AccountProvider =
  | "github"
  | "gitlab"
  | "codeberg"
  | "internet_archive"
  | "huggingface"
  | "wikimedia";

/** Backend URI prefix served by each provider. */
export const PROVIDER_PREFIX: Record<AccountProvider, string> = {
  github: "gh:",
  gitlab: "gl:",
  codeberg: "cb:",
  internet_archive: "ia:",
  huggingface: "hf:",
  wikimedia: "wm:",
};

export const PROVIDER_LABEL: Record<AccountProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  codeberg: "Codeberg",
  internet_archive: "Internet Archive",
  huggingface: "Hugging Face",
  wikimedia: "Wikimedia Commons",
};

export const ACCOUNT_PROVIDERS: AccountProvider[] = [
  "github",
  "gitlab",
  "codeberg",
  "internet_archive",
  "huggingface",
  "wikimedia",
];

/** What a profile's encrypted secret holds. */
export type SecretKind = "token" | "s3keys" | "none";

export interface AccountProfile {
  /** Stable id within its provider, e.g. "stanbeyond" or "ia-edu". */
  id: string;
  provider: AccountProvider;
  /** Human label shown in the switcher, e.g. "STANBEYOND (Master)". */
  label: string;
  /** Login / username on the provider, when known. */
  username?: string;
  avatar?: string;
  secretKind: SecretKind;
  /** AES-256-GCM envelope (JSON string) of the token, or of the JSON
   *  {"accessKey","secretKey"} for internet_archive. Empty when "none". */
  encryptedSecret: string;
  createdAt: number;
}

/** Plaintext secret supplied at add-time. For internet_archive pass the
 *  JSON string {"accessKey":"…","secretKey":"…"}; for the rest, the token. */
export type NewAccountSecret =
  | { kind: "token"; token: string }
  | { kind: "s3keys"; accessKey: string; secretKey: string }
  | { kind: "none" };

export interface SiteBinding {
  /** Per-provider account id that owns this site, e.g.
   *  { github: "stanbeyond", internet_archive: "ia-edu" }. */
  accounts: Partial<Record<AccountProvider, string>>;
  updatedAt: number;
}

export interface KeyringData {
  version: 1;
  profiles: AccountProfile[];
  /** Active account id per provider. */
  active: Partial<Record<AccountProvider, string>>;
  /** Domain → binding. */
  bindings: Record<string, SiteBinding>;
}

export interface KeyringStore {
  load(): Promise<KeyringData | null>;
  save(data: KeyringData): Promise<void>;
}

export function createMemoryKeyringStore(): KeyringStore & {
  /** Test hook: read the raw persisted data (ciphertext only). */
  peek(): KeyringData | null;
} {
  let data: KeyringData | null = null;
  return {
    async load() {
      return data;
    },
    async save(next) {
      data = next;
    },
    peek() {
      return data;
    },
  };
}

const IDB_KEYRING_DB = "arknetz-keyring";
const IDB_KEYRING_STORE = "keyring";

/** Browser/IndexedDB store for the keyring. The passphrase is never
 *  persisted — only the encrypted profiles. */
export function createIndexedDBKeyringStore(): KeyringStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_KEYRING_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_KEYRING_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  return {
    async load() {
      const db = await open();
      try {
        return await new Promise<KeyringData | null>((resolve, reject) => {
          const r = db
            .transaction(IDB_KEYRING_STORE, "readonly")
            .objectStore(IDB_KEYRING_STORE)
            .get("v1");
          r.onsuccess = () => resolve((r.result as KeyringData | undefined) ?? null);
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
    async save(data) {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const r = db
            .transaction(IDB_KEYRING_STORE, "readwrite")
            .objectStore(IDB_KEYRING_STORE)
            .put(data, "v1");
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Encryption: AES-256-GCM, PBKDF2 passphrase key (same as ia-media.ts)
// ---------------------------------------------------------------------------

export interface EncryptedEnvelope {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

export function b64encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function b64decodeBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function deriveKeyringKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(
  passphrase: string,
  plaintext: string,
): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await deriveKeyringKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  const envelope: EncryptedEnvelope = {
    v: 1,
    salt: b64encodeBytes(salt),
    iv: b64encodeBytes(iv),
    data: b64encodeBytes(new Uint8Array(cipher)),
  };
  return JSON.stringify(envelope);
}

export async function decryptSecret(
  passphrase: string,
  envelopeJson: string,
): Promise<string> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(envelopeJson) as EncryptedEnvelope;
  } catch {
    throw new Error("keyring secret is not a valid encrypted envelope");
  }
  if (envelope.v !== 1 || !envelope.salt || !envelope.iv || !envelope.data) {
    throw new Error("keyring secret envelope is malformed (expected v1 with salt/iv/data)");
  }
  const key = await deriveKeyringKey(passphrase, b64decodeBytes(envelope.salt));
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decodeBytes(envelope.iv) as BufferSource },
      key,
      b64decodeBytes(envelope.data) as BufferSource,
    );
  } catch {
    throw new Error(
      "wrong passphrase — the keyring could not be decrypted. Your accounts are still stored (encrypted); try the passphrase again.",
    );
  }
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------------------
// Keyring
// ---------------------------------------------------------------------------

function emptyKeyring(): KeyringData {
  return { version: 1, profiles: [], active: {}, bindings: {} };
}

export class AccountKeyring {
  private data: KeyringData = emptyKeyring();
  private passphrase: string | null = null;
  private loaded = false;

  constructor(
    private readonly store: KeyringStore,
    private readonly masterGithubUser: string = MASTER_GITHUB_USER,
  ) {}

  get isUnlocked(): boolean {
    return this.passphrase !== null;
  }

  /** Read-only snapshot of the (decrypted-label) profile list, for the
   *  account-switcher UI. Secrets stay inside the keyring. */
  snapshot(): KeyringData {
    return this.data;
  }

  /** Load persisted profiles from the store. Does not unlock: secrets
   *  stay ciphertext until unlock() with the right passphrase. */
  async load(): Promise<void> {
    const saved = await this.store.load();
    if (saved) this.data = saved;
    this.loaded = true;
  }

  /**
   * Unlock with the vault passphrase. Verifies the passphrase against
   * the first encrypted profile (if any); a wrong passphrase fails here
   * instead of failing later mid-publish. With no profiles yet, any
   * passphrase unlocks (it becomes the vault passphrase).
   */
  async unlock(passphrase: string): Promise<void> {
    if (!this.loaded) await this.load();
    if (!passphrase) throw new Error("a passphrase is required to unlock the keyring");
    const first = this.data.profiles.find((p) => p.encryptedSecret);
    if (first) {
      await decryptSecret(passphrase, first.encryptedSecret);
    }
    this.passphrase = passphrase;
  }

  lock(): void {
    this.passphrase = null;
  }

  private requireUnlocked(): string {
    if (!this.passphrase) {
      throw new Error("keyring is locked — unlock it with your passphrase first");
    }
    return this.passphrase;
  }

  private async persist(): Promise<void> {
    await this.store.save(this.data);
  }

  listAccounts(provider?: AccountProvider): AccountProfile[] {
    return this.data.profiles.filter((p) => !provider || p.provider === provider);
  }

  getAccount(provider: AccountProvider, id: string): AccountProfile | undefined {
    return this.data.profiles.find((p) => p.provider === provider && p.id === id);
  }

  /** Add an account. The secret is encrypted immediately and the
   *  plaintext is never stored. If it is the first account for its
   *  provider it becomes the active one. */
  async addAccount(
    provider: AccountProvider,
    profile: { id: string; label: string; username?: string; avatar?: string },
    secret: NewAccountSecret,
  ): Promise<AccountProfile> {
    const passphrase = this.requireUnlocked();
    if (!profile.id) throw new Error("account id is required");
    if (this.getAccount(provider, profile.id)) {
      throw new Error(`account "${profile.id}" already exists for ${PROVIDER_LABEL[provider]}`);
    }
    let encryptedSecret = "";
    let secretKind: SecretKind = "none";
    if (secret.kind === "token") {
      if (!secret.token) throw new Error("a token is required for this account");
      encryptedSecret = await encryptSecret(passphrase, secret.token);
      secretKind = "token";
    } else if (secret.kind === "s3keys") {
      if (!secret.accessKey || !secret.secretKey) {
        throw new Error("both an IA access key and secret key are required");
      }
      encryptedSecret = await encryptSecret(
        passphrase,
        JSON.stringify({ accessKey: secret.accessKey, secretKey: secret.secretKey }),
      );
      secretKind = "s3keys";
    }
    const account: AccountProfile = {
      id: profile.id,
      provider,
      label: profile.label,
      username: profile.username,
      avatar: profile.avatar,
      secretKind,
      encryptedSecret,
      createdAt: Date.now(),
    };
    this.data.profiles.push(account);
    if (!this.data.active[provider]) this.data.active[provider] = account.id;
    await this.persist();
    return account;
  }

  /** Remove an account. If it was active, the provider has no active
   *  account until another is selected. Bindings pointing at it are
   *  left in place so auto-binding can report the exact missing account. */
  async removeAccount(provider: AccountProvider, id: string): Promise<void> {
    const before = this.data.profiles.length;
    this.data.profiles = this.data.profiles.filter(
      (p) => !(p.provider === provider && p.id === id),
    );
    if (this.data.profiles.length === before) {
      throw new Error(`no ${PROVIDER_LABEL[provider]} account "${id}" to remove`);
    }
    if (this.data.active[provider] === id) delete this.data.active[provider];
    await this.persist();
  }

  setActive(provider: AccountProvider, id: string): void {
    if (!this.getAccount(provider, id)) {
      throw new Error(
        `cannot switch to ${PROVIDER_LABEL[provider]} account "${id}" — it is not signed in`,
      );
    }
    this.data.active[provider] = id;
  }

  getActive(provider: AccountProvider): AccountProfile | undefined {
    const id = this.data.active[provider];
    return id ? this.getAccount(provider, id) : undefined;
  }

  /** One-click switch across ALL backends simultaneously: pass the
   *  account id to activate per provider. Every id is validated first,
   *  so a bad id switches nothing. Persists once. */
  async switchAll(
    selection: Partial<Record<AccountProvider, string>>,
  ): Promise<Partial<Record<AccountProvider, AccountProfile>>> {
    for (const [provider, id] of Object.entries(selection) as [
      AccountProvider,
      string,
    ][]) {
      if (id && !this.getAccount(provider, id)) {
        throw new Error(
          `cannot switch to ${PROVIDER_LABEL[provider]} account "${id}" — it is not signed in`,
        );
      }
    }
    for (const [provider, id] of Object.entries(selection) as [
      AccountProvider,
      string,
    ][]) {
      if (id) this.data.active[provider] = id;
      else delete this.data.active[provider];
    }
    await this.persist();
    const out: Partial<Record<AccountProvider, AccountProfile>> = {};
    for (const provider of Object.keys(selection) as AccountProvider[]) {
      const active = this.getActive(provider);
      if (active) out[provider] = active;
    }
    return out;
  }

  /** Decrypt one account's secret. Throws when locked or wrong passphrase. */
  async revealSecret(provider: AccountProvider, id: string): Promise<string> {
    const passphrase = this.requireUnlocked();
    const account = this.getAccount(provider, id);
    if (!account) throw new Error(`no ${PROVIDER_LABEL[provider]} account "${id}"`);
    if (account.secretKind === "none" || !account.encryptedSecret) return "";
    return decryptSecret(passphrase, account.encryptedSecret);
  }

  // --- Per-site auto-binding ----------------------------------------------

  bindSite(
    domain: string,
    accounts: Partial<Record<AccountProvider, string>>,
  ): void {
    this.data.bindings[domain.toLowerCase()] = {
      accounts: { ...accounts },
      updatedAt: Date.now(),
    };
  }

  getSiteBinding(domain: string): SiteBinding | undefined {
    return this.data.bindings[domain.toLowerCase()];
  }

  /**
   * Opening a site auto-selects the accounts it is bound to. Returns the
   * selected profiles; also makes them the active accounts, so the next
   * commit / upload uses them. Throws a precise error when the bound
   * account is not signed in — the site must never silently fall back
   * to whatever account happens to be active.
   */
  async autoSelectForSite(
    domain: string,
  ): Promise<Partial<Record<AccountProvider, AccountProfile>>> {
    const binding = this.getSiteBinding(domain);
    if (!binding) return {};
    const selected: Partial<Record<AccountProvider, AccountProfile>> = {};
    for (const [provider, id] of Object.entries(binding.accounts) as [
      AccountProvider,
      string,
    ][]) {
      const account = this.getAccount(provider, id);
      if (!account) {
        throw new Error(
          `site ${domain} is bound to ${PROVIDER_LABEL[provider]} account "${id}", which is not signed in — add that account, or rebind the site to a signed-in account`,
        );
      }
      selected[provider] = account;
    }
    await this.switchAll(
      Object.fromEntries(
        Object.entries(binding.accounts).map(([p, id]) => [p, id]),
      ) as Partial<Record<AccountProvider, string>>,
    );
    return selected;
  }

  // --- Master Admin Badge ---------------------------------------------------

  /** Root Master controls appear only when the ACTIVE GitHub account is
   *  the master user. Switching to a regular alt account hides them. */
  isMasterAdmin(): boolean {
    const active = this.getActive("github");
    return !!active?.username && active.username === this.masterGithubUser;
  }

  /** The master account id, for UI copy ("signed in as the Root Master"). */
  get masterUser(): string {
    return this.masterGithubUser;
  }
}
