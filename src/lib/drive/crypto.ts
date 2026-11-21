// ArkNetzWebWeaver — ArkDrive crypto (thread turn 46).
// Zero-knowledge: everything is encrypted in-browser with Web Crypto
// before it ever touches a repo. The vault passphrase never leaves the
// client, and the derived key is never stored — only the passphrase
// holder can open the vault.
//
// KDF (fix round 3, item 2): **Argon2id** is now the default for new
// vaults, via @noble/hashes 2.4.0 (MIT, zero dependencies, pure JS —
// no Wasm build to vendor; the ESM files are vendored into
// dist/vendor/noble-hashes/ by scripts/copy-assets.mjs and loaded the
// same environment-aware way as the Zstd engine in ../zstd.ts).
// Parameters are OWASP's first-factor recommendation for Argon2id:
// m = 19 MiB (19456 KiB), t = 2 iterations, p = 1 lane, 32-byte output,
// version 0x13. Measured in Node: ~340 ms per derivation — slow enough
// to hurt offline guessing, fast enough for a vault unlock.
//   PBKDF2-SHA-256, 100,000 iterations is the LEGACY KDF: vaults
// created before this change still open (their envelope has no version
// magic — see below), and VaultManager.open() migrates them to
// Argon2id on first unlock by re-encrypting the manifest. The keyring
// (network/accounts.ts) and IA keys (ia-media.ts) still use PBKDF2 —
// this change covers ArkDrive vaults only.
// Cipher: AES-256-GCM, random 12-byte IV per encryption, 16-byte salt
// per vault (same salt length for both KDFs).
//
// Envelope layouts (the on-disk form of the encrypted manifest):
//   Legacy (PBKDF2, v1 vaults): salt(16) | iv(12) | ciphertext.
//     No magic, no version — it is just the concatenation, and any
//     envelope that does NOT start with the v2 magic below is read as
//     legacy. (A random 16-byte salt starts with the 4 magic bytes
//     with probability 2^-32; a legacy vault that unlucky would fail
//     loudly at the Argon2id step's GCM check, never silently open.)
//   v2 (Argon2id): magic "ARKV" (4) | version 0x02 (1) | salt(16) |
//     m_cost u32 LE (4) | t_cost u32 LE (4) | parallelism u8 (1) |
//     iv(12) | ciphertext. The parameters ride in the header so a
//     future parameter change stays readable, and tampering with them
//     changes the derived key, which fails AES-GCM authentication.
// Name envelope layout (base64url): iv(12) | ciphertext — unchanged
// by this change; names are encrypted with the vault key, whichever
// KDF derived it.

import type { argon2idAsync as argon2idAsyncFn } from "@noble/hashes/argon2.js";

export const PBKDF2_ITERATIONS = 100_000;
export const VAULT_SALT_BYTES = 16;
export const GCM_IV_BYTES = 12;

/** Which KDF derived a vault's key. */
export type VaultKdf = "pbkdf2" | "argon2id";

/** Argon2id parameters (OWASP first-factor recommendation). Memory is
 *  in KiB, as @noble/hashes expects. */
export interface Argon2idParams {
  /** Memory cost, KiB. */
  m: number;
  /** Time cost, iterations. */
  t: number;
  /** Parallelism, lanes. */
  p: number;
}

export const ARGON2ID_DEFAULT_PARAMS: Argon2idParams = { m: 19456, t: 2, p: 1 };
export const ARGON2ID_OUTPUT_BYTES = 32;
/** Argon2 version 0x13 (v19) — the only version @noble/hashes emits. */
export const ARGON2ID_VERSION = 0x13;

/** v2 envelope magic "ARKV" + version byte. */
export const VAULT_ENVELOPE_MAGIC = new Uint8Array([0x41, 0x52, 0x4b, 0x56]);
export const VAULT_ENVELOPE_VERSION_ARGON2ID = 2;

/** Base64url (URL-safe, no padding) — safe inside JSON and filenames. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return base64ToBytes(padded + "=".repeat(pad));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Random bytes of any length. WebCrypto's getRandomValues refuses a
 *  single call over 65,536 bytes (QuotaExceededError), so large
 *  requests are filled in 64 KiB chunks. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const CHUNK = 65536;
  for (let offset = 0; offset < length; offset += CHUNK) {
    crypto.getRandomValues(out.subarray(offset, Math.min(length, offset + CHUNK)));
  }
  return out;
}

export function randomId(prefix = "v"): string {
  return `${prefix}_${bytesToBase64Url(randomBytes(12))}`;
}

/** SHA-256 hex digest. Used for chunk dedup and integrity checks. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Argon2id loader — environment-aware, same pattern as the Zstd engine:
// Node (tests, tooling) imports the npm package; the browser / Tauri
// webview imports the vendored copy (scripts/copy-assets.mjs copies
// node_modules/@noble/hashes/*.js to dist/vendor/noble-hashes/).
// ---------------------------------------------------------------------------

type Argon2idAsync = typeof argon2idAsyncFn;

let argon2Promise: Promise<Argon2idAsync> | null = null;

async function loadArgon2id(): Promise<Argon2idAsync> {
  const isNode =
    typeof window === "undefined" &&
    typeof process !== "undefined" &&
    typeof process.versions?.node === "string";
  if (isNode) {
    const mod = (await import("@noble/hashes/argon2.js")) as { argon2idAsync: Argon2idAsync };
    return mod.argon2idAsync;
  }
  const url = new URL("../../vendor/noble-hashes/argon2.js", import.meta.url).href;
  const mod = (await import(url)) as { argon2idAsync: Argon2idAsync };
  return mod.argon2idAsync;
}

function getArgon2id(): Promise<Argon2idAsync> {
  if (!argon2Promise) {
    argon2Promise = loadArgon2id().catch((err) => {
      argon2Promise = null;
      throw new Error(
        `Argon2id engine failed to load: ${err instanceof Error ? err.message : String(err)} — new vaults cannot be created and Argon2id vaults cannot be opened until this is fixed`,
      );
    });
  }
  return argon2Promise;
}

/** For tests: forget the cached loader so a fresh load can be observed. */
export function resetArgon2idForTests(): void {
  argon2Promise = null;
}

/** Raw Argon2id output (32 bytes) for a passphrase + salt. Exported so
 *  tests can compare derivations byte-for-byte without going through
 *  Web Crypto keys. */
export async function argon2idKeyBytes(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2idParams = ARGON2ID_DEFAULT_PARAMS,
): Promise<Uint8Array> {
  const argon2idAsync = await getArgon2id();
  return argon2idAsync(new TextEncoder().encode(passphrase), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: ARGON2ID_OUTPUT_BYTES,
    version: ARGON2ID_VERSION,
  });
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Derive the vault AES-256-GCM key from a passphrase + salt.
 *  Deterministic: same passphrase + same salt always yields the same
 *  key, which is what makes a vault re-openable. */
export async function deriveVaultKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Derive the vault key with Argon2id (the current default). Same
 *  determinism contract as deriveVaultKey. */
export async function deriveVaultKeyArgon2id(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2idParams = ARGON2ID_DEFAULT_PARAMS,
): Promise<CryptoKey> {
  return importAesKey(await argon2idKeyBytes(passphrase, salt, params));
}

/** Derive with whichever KDF a vault uses. */
export async function deriveVaultKeyFor(
  kdf: VaultKdf,
  passphrase: string,
  salt: Uint8Array,
  argonParams: Argon2idParams = ARGON2ID_DEFAULT_PARAMS,
): Promise<CryptoKey> {
  return kdf === "argon2id"
    ? deriveVaultKeyArgon2id(passphrase, salt, argonParams)
    : deriveVaultKey(passphrase, salt);
}

export interface EncryptedBytes {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<EncryptedBytes> {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data as BufferSource);
  return { iv, ciphertext: new Uint8Array(cipher) };
}

export async function decryptBytes(key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error(
      "decryption failed — wrong vault passphrase, or the data was tampered with (AES-GCM authentication failed)",
    );
  }
}

export interface UnpackedVaultEnvelope {
  kdf: VaultKdf;
  salt: Uint8Array;
  /** Only set for Argon2id envelopes — the parameters from the header. */
  argonParams?: Argon2idParams;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** True when the bytes start with the v2 "ARKV" magic. */
export function isArgon2idVaultEnvelope(envelope: Uint8Array): boolean {
  return (
    envelope.length >= VAULT_ENVELOPE_MAGIC.length &&
    VAULT_ENVELOPE_MAGIC.every((b, i) => envelope[i] === b)
  );
}

/** Pack a legacy (PBKDF2) vault envelope: salt(16) | iv(12) |
 *  ciphertext. This is the on-disk form of pre-Argon2id manifests. */
export function packVaultEnvelope(salt: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(salt.length + iv.length + ciphertext.length);
  out.set(salt, 0);
  out.set(iv, salt.length);
  out.set(ciphertext, salt.length + iv.length);
  return out;
}

/** Pack a v2 (Argon2id) vault envelope: magic "ARKV" | version 0x02 |
 *  salt(16) | m_cost u32 LE | t_cost u32 LE | parallelism u8 |
 *  iv(12) | ciphertext. */
export function packVaultEnvelopeV2(
  salt: Uint8Array,
  params: Argon2idParams,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(4 + 1 + VAULT_SALT_BYTES + 4 + 4 + 1);
  header.set(VAULT_ENVELOPE_MAGIC, 0);
  header[4] = VAULT_ENVELOPE_VERSION_ARGON2ID;
  header.set(salt, 5);
  const view = new DataView(header.buffer);
  view.setUint32(5 + VAULT_SALT_BYTES, params.m, true);
  view.setUint32(5 + VAULT_SALT_BYTES + 4, params.t, true);
  header[5 + VAULT_SALT_BYTES + 8] = params.p;
  const out = new Uint8Array(header.length + iv.length + ciphertext.length);
  out.set(header, 0);
  out.set(iv, header.length);
  out.set(ciphertext, header.length + iv.length);
  return out;
}

/** Pack an envelope for whichever KDF the vault uses. */
export function packVaultEnvelopeForKdf(
  kdf: VaultKdf,
  salt: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  argonParams: Argon2idParams = ARGON2ID_DEFAULT_PARAMS,
): Uint8Array {
  return kdf === "argon2id"
    ? packVaultEnvelopeV2(salt, argonParams, iv, ciphertext)
    : packVaultEnvelope(salt, iv, ciphertext);
}

export function unpackVaultEnvelope(envelope: Uint8Array): UnpackedVaultEnvelope {
  if (isArgon2idVaultEnvelope(envelope)) {
    const headerLen = 4 + 1 + VAULT_SALT_BYTES + 4 + 4 + 1;
    if (envelope.length < headerLen + GCM_IV_BYTES + 1) {
      throw new Error("vault envelope is too short to be a valid Argon2id manifest — the vault is corrupt");
    }
    if (envelope[4] !== VAULT_ENVELOPE_VERSION_ARGON2ID) {
      throw new Error(
        `vault envelope has an unknown Argon2id version: ${envelope[4]} — this client only knows version ${VAULT_ENVELOPE_VERSION_ARGON2ID}`,
      );
    }
    const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
    const m = view.getUint32(5 + VAULT_SALT_BYTES, true);
    const t = view.getUint32(5 + VAULT_SALT_BYTES + 4, true);
    const p = envelope[5 + VAULT_SALT_BYTES + 8] as number;
    if (m === 0 || t === 0 || p === 0) {
      throw new Error("vault envelope has invalid Argon2id parameters (zero memory, time, or parallelism) — the vault is corrupt");
    }
    return {
      kdf: "argon2id",
      salt: envelope.slice(5, 5 + VAULT_SALT_BYTES),
      argonParams: { m, t, p },
      iv: envelope.slice(headerLen, headerLen + GCM_IV_BYTES),
      ciphertext: envelope.slice(headerLen + GCM_IV_BYTES),
    };
  }
  if (envelope.length < VAULT_SALT_BYTES + GCM_IV_BYTES + 1) {
    throw new Error("vault envelope is too short to be a valid encrypted manifest — the vault is corrupt");
  }
  return {
    kdf: "pbkdf2",
    salt: envelope.slice(0, VAULT_SALT_BYTES),
    iv: envelope.slice(VAULT_SALT_BYTES, VAULT_SALT_BYTES + GCM_IV_BYTES),
    ciphertext: envelope.slice(VAULT_SALT_BYTES + GCM_IV_BYTES),
  };
}

/** Encrypt manifest bytes with a fresh salt under the CURRENT default
 *  KDF (Argon2id); returns the v2 envelope bytes stored as
 *  vault-index.enc.zst. */
export async function encryptVaultEnvelope(passphrase: string, data: Uint8Array): Promise<Uint8Array> {
  const salt = randomBytes(VAULT_SALT_BYTES);
  const key = await deriveVaultKeyArgon2id(passphrase, salt);
  const { iv, ciphertext } = await encryptBytes(key, data);
  return packVaultEnvelopeV2(salt, ARGON2ID_DEFAULT_PARAMS, iv, ciphertext);
}

/** Encrypt manifest bytes the LEGACY way (PBKDF2, no version magic).
 *  Only for creating pre-migration vaults in tests and for tooling
 *  that must reproduce the old format — new vaults must use
 *  encryptVaultEnvelope. */
export async function encryptVaultEnvelopePbkdf2(passphrase: string, data: Uint8Array): Promise<Uint8Array> {
  const salt = randomBytes(VAULT_SALT_BYTES);
  const key = await deriveVaultKey(passphrase, salt);
  const { iv, ciphertext } = await encryptBytes(key, data);
  return packVaultEnvelope(salt, iv, ciphertext);
}

/** Decrypt a vault envelope, detecting the KDF from the envelope
 *  itself (v2 magic → Argon2id, anything else → legacy PBKDF2).
 *  Returns the plaintext bytes AND the derived key, so the caller can
 *  keep using the key for names/chunks without re-deriving it, plus
 *  the detected KDF so the caller can migrate a legacy vault. */
export async function decryptVaultEnvelope(
  passphrase: string,
  envelope: Uint8Array,
): Promise<{ plaintext: Uint8Array; key: CryptoKey; salt: Uint8Array; kdf: VaultKdf; argonParams?: Argon2idParams }> {
  const { kdf, salt, argonParams, iv, ciphertext } = unpackVaultEnvelope(envelope);
  const key = await deriveVaultKeyFor(kdf, passphrase, salt, argonParams);
  const plaintext = await decryptBytes(key, iv, ciphertext);
  return { plaintext, key, salt, kdf, argonParams };
}

/** Encrypt a filename / folder name. The envelope is iv(12) |
 *  ciphertext, base64url-encoded, so it is safe as a JSON string and
 *  never leaks the name — not even its length class beyond a few bytes. */
export async function encryptName(key: CryptoKey, name: string): Promise<string> {
  const { iv, ciphertext } = await encryptBytes(key, new TextEncoder().encode(name));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return bytesToBase64Url(packed);
}

export async function decryptName(key: CryptoKey, envelope: string): Promise<string> {
  let packed: Uint8Array;
  try {
    packed = base64UrlToBytes(envelope);
  } catch {
    throw new Error("encrypted filename is not valid base64url — the manifest is corrupt");
  }
  if (packed.length < GCM_IV_BYTES + 1) {
    throw new Error("encrypted filename is too short — the manifest is corrupt");
  }
  const plain = await decryptBytes(key, packed.slice(0, GCM_IV_BYTES), packed.slice(GCM_IV_BYTES));
  return new TextDecoder().decode(plain);
}
