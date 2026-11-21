// Tests: ArkDrive Argon2id upgrade (fix round 3, item 2).
// New vaults use Argon2id (OWASP params, @noble/hashes 2.4.0 MIT);
// legacy PBKDF2 vaults still open and are migrated to Argon2id on
// unlock. All network is mocked (in-memory blob store) — no test hits
// a real provider.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ARGON2ID_DEFAULT_PARAMS,
  VAULT_ENVELOPE_MAGIC,
  argon2idKeyBytes,
  decryptVaultEnvelope,
  deriveVaultKeyArgon2id,
  encryptVaultEnvelope,
  encryptVaultEnvelopePbkdf2,
  isArgon2idVaultEnvelope,
  packVaultEnvelopeV2,
  unpackVaultEnvelope,
} from "../src/lib/drive/crypto.js";
import { compressBytes } from "../src/lib/zstd.js";
import { VaultManager } from "../src/lib/drive/drive.js";
import type { VaultBackendClient } from "../src/lib/drive/backends.js";
import type { VaultBackend } from "../src/lib/drive/types.js";
import { VAULT_MANIFEST_PATH } from "../src/lib/drive/types.js";

const PASS = "correct horse battery staple";

class MemoryClient implements VaultBackendClient {
  readonly kind: VaultBackend["kind"] = "gh";
  readonly repo = "alice/arknetz-vault";
  readonly branch = "main";
  readonly store = new Map<string, Uint8Array>();

  async putBlob(path: string, data: Uint8Array): Promise<void> {
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

function backend(): VaultBackend {
  return { kind: "gh", uri: "gh:alice/arknetz-vault", repo: "alice/arknetz-vault", accountId: "acct-alice" };
}

function emptyManifestJson(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      vaultId: "vault_test",
      createdAt: 1794000000000,
      updatedAt: 1794000000000,
      entries: [],
      chunks: {},
    }),
  );
}

/** Seed a client with a manifest encrypted the LEGACY (PBKDF2) way,
 *  exactly as vaults created before the Argon2id upgrade are stored. */
async function seedLegacyVault(client: MemoryClient, passphrase = PASS): Promise<void> {
  const compressed = await compressBytes(emptyManifestJson());
  await client.putBlob(VAULT_MANIFEST_PATH, await encryptVaultEnvelopePbkdf2(passphrase, compressed));
}

test("Argon2id derivation is deterministic and salt/passphrase-sensitive", async () => {
  const salt = new TextEncoder().encode("0123456789abcdef");
  const a = await argon2idKeyBytes("same passphrase", salt);
  const b = await argon2idKeyBytes("same passphrase", salt);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  const otherSalt = await argon2idKeyBytes("same passphrase", new TextEncoder().encode("fedcba9876543210"));
  assert.notDeepEqual(a, otherSalt);
  const otherPass = await argon2idKeyBytes("different passphrase", salt);
  assert.notDeepEqual(a, otherPass);
  // Default params are the OWASP first-factor recommendation.
  assert.deepEqual(ARGON2ID_DEFAULT_PARAMS, { m: 19456, t: 2, p: 1 });
  // A key derived with Argon2id round-trips through AES-GCM.
  const key = await deriveVaultKeyArgon2id("pass", salt);
  assert.ok(key instanceof CryptoKey);
});

test("new envelopes are Argon2id v2 (ARKV magic) and round-trip; legacy envelopes stay PBKDF2", async () => {
  const data = new TextEncoder().encode("manifest-bytes");
  const v2 = await encryptVaultEnvelope(PASS, data);
  assert.ok(isArgon2idVaultEnvelope(v2), "new envelope must start with the ARKV magic");
  assert.deepEqual([...v2.slice(0, 4)], [...VAULT_ENVELOPE_MAGIC]);
  assert.equal(v2[4], 2);
  const openedV2 = await decryptVaultEnvelope(PASS, v2);
  assert.equal(openedV2.kdf, "argon2id");
  assert.deepEqual(openedV2.argonParams, ARGON2ID_DEFAULT_PARAMS);
  assert.deepEqual(openedV2.plaintext, data);

  const legacy = await encryptVaultEnvelopePbkdf2(PASS, data);
  assert.ok(!isArgon2idVaultEnvelope(legacy), "legacy envelope must not carry the ARKV magic");
  assert.equal(unpackVaultEnvelope(legacy).kdf, "pbkdf2");
  const openedLegacy = await decryptVaultEnvelope(PASS, legacy);
  assert.equal(openedLegacy.kdf, "pbkdf2");
  assert.deepEqual(openedLegacy.plaintext, data);
});

test("wrong passphrase fails for both Argon2id and PBKDF2 envelopes", async () => {
  const data = new TextEncoder().encode("secret");
  const v2 = await encryptVaultEnvelope(PASS, data);
  const legacy = await encryptVaultEnvelopePbkdf2(PASS, data);
  await assert.rejects(() => decryptVaultEnvelope("wrong passphrase", v2), /decryption failed/);
  await assert.rejects(() => decryptVaultEnvelope("wrong passphrase", legacy), /decryption failed/);
});

test("tampering with the Argon2id header parameters fails decryption (params are bound to the key)", async () => {
  const data = new TextEncoder().encode("secret");
  const v2 = await encryptVaultEnvelope(PASS, data);
  const tampered = new Uint8Array(v2);
  // m_cost lives at offset 5 + 16 = 21 (u32 LE); flip it.
  tampered[21] = (tampered[21] as number) ^ 0xff;
  await assert.rejects(() => decryptVaultEnvelope(PASS, tampered), /decryption failed/);
  // Unknown envelope version is loud, not silently PBKDF2.
  const badVersion = new Uint8Array(v2);
  badVersion[4] = 9;
  assert.throws(() => unpackVaultEnvelope(badVersion), /unknown Argon2id version/);
  // Truncated envelopes are loud.
  assert.throws(() => unpackVaultEnvelope(new Uint8Array(10)), /too short/);
  assert.throws(() => unpackVaultEnvelope(packVaultEnvelopeV2(new Uint8Array(16), ARGON2ID_DEFAULT_PARAMS, new Uint8Array(12), new Uint8Array(0)).slice(0, 20)), /too short/);
});

test("a fresh VaultManager vault is Argon2id and reopens", async () => {
  const client = new MemoryClient();
  const manager = new VaultManager(backend(), client);
  await manager.open(PASS);
  assert.equal(manager.vaultKdf, "argon2id");
  const stored = await client.getBlob(VAULT_MANIFEST_PATH);
  assert.ok(stored && isArgon2idVaultEnvelope(stored), "fresh vault must be stored as an Argon2id envelope");
  const reopened = new VaultManager(backend(), client);
  await reopened.open(PASS);
  assert.equal(reopened.vaultKdf, "argon2id");
  assert.deepEqual(await reopened.listFolder(), []);
});

test("a legacy PBKDF2 vault opens, migrates to Argon2id on unlock, and keeps working", async () => {
  const client = new MemoryClient();
  await seedLegacyVault(client);
  const before = await client.getBlob(VAULT_MANIFEST_PATH);
  assert.ok(before && !isArgon2idVaultEnvelope(before), "seeded vault must be legacy PBKDF2");

  const manager = new VaultManager(backend(), client);
  await manager.open(PASS);
  assert.equal(manager.vaultKdf, "argon2id");
  const after = await client.getBlob(VAULT_MANIFEST_PATH);
  assert.ok(after && isArgon2idVaultEnvelope(after), "stored manifest must be Argon2id after unlock");
  assert.notDeepEqual(after, before);

  // The migrated vault is fully usable: upload + download round-trip.
  const data = new TextEncoder().encode("hello migrated vault");
  const uploaded = await manager.uploadFile("notes.txt", data);
  assert.equal(uploaded.file.name, "notes.txt");
  assert.deepEqual(await manager.downloadFile(uploaded.file.id), data);

  // And it reopens as Argon2id afterwards.
  const reopened = new VaultManager(backend(), client);
  await reopened.open(PASS);
  assert.equal(reopened.vaultKdf, "argon2id");
  assert.equal((await reopened.listAllFiles()).length, 1);
  assert.deepEqual(await reopened.downloadFile(uploaded.file.id), data);
});

test("a legacy PBKDF2 vault with the wrong passphrase fails before any migration", async () => {
  const client = new MemoryClient();
  await seedLegacyVault(client);
  const before = await client.getBlob(VAULT_MANIFEST_PATH);
  const manager = new VaultManager(backend(), client);
  await assert.rejects(() => manager.open("wrong passphrase"), /decryption failed/);
  // Nothing was migrated: the stored envelope is byte-identical.
  assert.deepEqual(await client.getBlob(VAULT_MANIFEST_PATH), before);
});
