// ArkNetzWebWeaver — ArkDrive chunking + dedup (thread turn 46).
// Files over 10 MB split into 10 MB encrypted chunks, each SHA-256
// hashed; a chunk whose hash already exists in the manifest is never
// re-uploaded. Reassembly verifies every chunk hash on Download — a
// mismatch is an error, never silent corruption. Chunks are 10 MB, well
// under Git's 25 MB choke point and 100 MB per-file limit.

import { decryptBytes, encryptBytes, sha256Hex } from "./crypto.js";
import type { Chunk, EncryptedChunk } from "./types.js";
import { VAULT_CHUNK_SIZE } from "./types.js";

export { VAULT_CHUNK_SIZE };

/** Split bytes into 10 MB chunks. 0 bytes -> 0 chunks; exactly 10 MB ->
 *  1 chunk; 10 MB + 1 byte -> 2 chunks. */
export async function splitBytes(data: Uint8Array, chunkSize: number = VAULT_CHUNK_SIZE): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for (let offset = 0, index = 0; offset < data.length; offset += chunkSize, index++) {
    const plaintext = data.slice(offset, Math.min(offset + chunkSize, data.length));
    chunks.push({ index, hash: await sha256Hex(plaintext), plaintext });
  }
  return chunks;
}

/** Encrypt one chunk. The blob id is content-addressed from the
 *  ciphertext hash, so the stored name looks random
 *  (blob_8f9a2c41d7e0.enc) and reveals nothing about the content. */
export async function encryptChunk(
  key: CryptoKey,
  chunk: Chunk,
): Promise<EncryptedChunk & { iv: Uint8Array }> {
  const { iv, ciphertext } = await encryptBytes(key, chunk.plaintext);
  const blobHash = await sha256Hex(ciphertext);
  return { blobId: `blob_${blobHash.slice(0, 16)}.enc`, hash: chunk.hash, encrypted: ciphertext, iv };
}

/** Decrypt one chunk and verify its SHA-256 against the recorded hash.
 *  A hash mismatch — or a GCM authentication failure — throws; the
 *  caller must surface it as a corrupt download, never return bad bytes. */
export async function decryptChunk(
  key: CryptoKey,
  encrypted: EncryptedChunk,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const plain = await decryptBytes(key, iv, encrypted.encrypted);
  const actual = await sha256Hex(plain);
  if (actual !== encrypted.hash) {
    throw new Error(
      `chunk ${encrypted.blobId} failed its integrity check (SHA-256 mismatch: expected ${encrypted.hash.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — the stored chunk is corrupt, download aborted`,
    );
  }
  return plain;
}

/**
 * Reassemble a file from its stored chunks.
 *
 * The backend client stores each chunk as iv(12) | ciphertext, so the
 * caller passes the raw stored bytes per blob id. Each chunk is
 * decrypted, hash-verified against `expectedHashes` (in order), and
 * concatenated. Any failure throws — never returns partial/corrupt data.
 */
export async function reassembleChunks(
  key: CryptoKey,
  storedBlobs: Array<{ blobId: string; bytes: Uint8Array }>,
  expectedHashes: string[],
): Promise<Uint8Array> {
  if (storedBlobs.length !== expectedHashes.length) {
    throw new Error(
      `cannot reassemble: ${expectedHashes.length} chunks expected but ${storedBlobs.length} found — the file is incomplete`,
    );
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < storedBlobs.length; i++) {
    const stored = storedBlobs[i] as { blobId: string; bytes: Uint8Array };
    const expectedHash = expectedHashes[i] as string;
    if (stored.bytes.length < 12) {
      throw new Error(`chunk ${stored.blobId} is too short to hold an IV — the stored chunk is corrupt`);
    }
    const plain = await decryptChunk(
      key,
      { blobId: stored.blobId, hash: expectedHash, encrypted: stored.bytes.slice(12) },
      stored.bytes.slice(0, 12),
    );
    parts.push(plain);
    total += plain.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Which of these chunk hashes are NOT already in the manifest's dedup
 *  index — i.e. which chunks actually need uploading. */
export function chunksNeedingUpload(chunks: Chunk[], knownHashes: ReadonlySet<string>): Chunk[] {
  return chunks.filter((c) => !knownHashes.has(c.hash));
}

/** Serialise one encrypted chunk for storage: iv(12) | ciphertext. */
export function packStoredChunk(iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}
