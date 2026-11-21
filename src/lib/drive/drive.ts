// ArkNetzWebWeaver — ArkDrive file manager (thread turn 46).
// Folders + files over an encrypted vault: names are AES-256-GCM
// encrypted per entry, file bytes are Zstd-compressed, split into
// 10 MB chunks, SHA-256 hashed, deduped, and each chunk AES-256-GCM
// encrypted before upload. The repo holds only vault-index.enc.zst +
// blob_*.enc — zero filenames, zero previews, zero metadata.
//
// Delete is trash-free in v1.0 (trash-with-restore is v1.1): every
// delete is two-step — prepareDelete() returns a DeleteConfirmation
// the UI must show, and only confirmDelete({confirmed: true}) executes.

import { compressBytes, decompressBytes } from "../zstd.js";
import {
  ARGON2ID_DEFAULT_PARAMS,
  decryptBytes,
  decryptName,
  decryptVaultEnvelope,
  deriveVaultKeyArgon2id,
  encryptBytes,
  encryptName,
  packVaultEnvelopeForKdf,
  packVaultEnvelopeV2,
  randomBytes,
  randomId,
  sha256Hex,
} from "./crypto.js";
import type { Argon2idParams, VaultKdf } from "./crypto.js";
import { chunksNeedingUpload, encryptChunk, packStoredChunk, reassembleChunks, splitBytes } from "./chunks.js";
import type { VaultBackendClient } from "./backends.js";
import type {
  DeleteConfirmation,
  VaultBackend,
  VaultEntry,
  VaultFile,
  VaultManifest,
  VaultUsage,
} from "./types.js";
import {
  BACKEND_QUOTAS,
  VAULT_BLOB_PREFIX,
  VAULT_CHUNK_SIZE,
  VAULT_MANIFEST_PATH,
  blobPath,
} from "./types.js";

export { VAULT_CHUNK_SIZE };

export class VaultNotOpenError extends Error {
  constructor() {
    super("vault is not open — call open(passphrase) first");
    this.name = "VaultNotOpenError";
  }
}

/** Optional hooks the app shell wires (phase 2 P2P). All no-ops when
 *  absent — the vault works exactly as before. */
export interface VaultManagerHooks {
  /** A NEW chunk blob was just uploaded (deduped chunks do not
   *  fire — the peer already has those bytes, or the repo does).
   *  `storedBytes` are the exact packed bytes (`iv | ciphertext`)
   *  that went into the repo blob, ready for DriveP2P.sendChunk.
   *  The hook must never throw into the upload path. */
  onChunkUploaded?: (vaultId: string, blobId: string, storedBytes: Uint8Array) => void;
}

export interface UploadResult {
  file: VaultFile;
  /** Chunks actually uploaded (deduped ones are not counted). */
  chunksUploaded: number;
  /** Chunks skipped because their SHA-256 already existed. */
  chunksDeduped: number;
}

/** Per-file progress stages for a drag-and-drop upload. "queued" is
 *  emitted by the drop flow before uploadFile runs; "error" is emitted
 *  by the drop flow when a file fails (its error is surfaced per file,
 *  never silently dropped); the rest are emitted by uploadFile itself. */
export type UploadStage = "queued" | "chunking" | "encrypting" | "uploading" | "done" | "error";

export interface UploadProgress {
  /** Plain file name (no folders). */
  fileName: string;
  /** Path as dropped, e.g. "Photos/2026/sunset.jpg" — same as fileName
   *  for a root-level drop. */
  relativePath: string;
  stage: UploadStage;
  bytesDone: number;
  bytesTotal: number;
  chunksDone: number;
  chunksTotal: number;
  chunksDeduped: number;
  /** Set only when stage is "error". */
  error?: string;
}

export type UploadProgressCallback = (progress: UploadProgress) => void;

/** One file (or empty folder) as collected from a drop event — see
 *  collectDroppedFiles() in drive-ui.ts. `path` is the relative path
 *  as dropped ("Photos/2026/sunset.jpg" or "notes.txt"); a trailing
 *  "/" marks a folder-only entry (an empty dropped folder). */
export interface DroppedUpload {
  path: string;
  data: Uint8Array;
  mime?: string;
}

/** Per-file outcome of uploadDroppedFiles(). A failed file has
 *  file === null and error set; the other files still upload, and the
 *  manifest is unchanged for the failed file. */
export interface DroppedUploadResult {
  path: string;
  file: VaultFile | null;
  chunksUploaded: number;
  chunksDeduped: number;
  error?: string;
}

/** Normalise a dropped path: backslashes become "/", duplicate "/"
 *  collapse, a leading "/" is stripped. Returns "" for an empty path. */
export function normalizeDroppedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "").trim();
}

/** Split a normalised dropped path into its folder segments + file
 *  name. "Photos/2026/sunset.jpg" -> { folders: ["Photos", "2026"],
 *  name: "sunset.jpg" }. */
export function splitDroppedPath(path: string): { folders: string[]; name: string } {
  const clean = normalizeDroppedPath(path).replace(/\/$/, "");
  const parts = clean.split("/").filter((p) => p !== "" && p !== ".");
  const name = parts.pop() ?? "";
  return { folders: parts, name };
}

export class VaultManager {
  readonly backend: VaultBackend;
  private readonly client: VaultBackendClient;
  private readonly hooks?: VaultManagerHooks;
  private key: CryptoKey | null = null;
  private salt: Uint8Array | null = null;
  private manifest: VaultManifest | null = null;
  /** KDF that derived the open vault's key. New vaults are Argon2id;
   *  a legacy PBKDF2 vault is migrated to Argon2id on open (see
   *  open()). */
  private kdf: VaultKdf = "argon2id";
  /** Argon2id parameters from the opened envelope (defaults for a
   *  fresh vault); saveManifest reuses them so a re-save never
   *  silently changes the parameters. */
  private argonParams: Argon2idParams = ARGON2ID_DEFAULT_PARAMS;

  constructor(backend: VaultBackend, client: VaultBackendClient, hooks?: VaultManagerHooks) {
    this.backend = backend;
    this.client = client;
    this.hooks = hooks;
  }

  get isOpen(): boolean {
    return this.key !== null && this.manifest !== null;
  }

  /** Id of the open vault (the DriveP2P known-vaults check). Null
   *  when closed. */
  get vaultId(): string | null {
    return this.manifest?.vaultId ?? null;
  }

  /** KDF of the currently open vault ("argon2id" for every vault
   *  created or migrated by this client). */
  get vaultKdf(): VaultKdf {
    return this.kdf;
  }

  /** Open the vault: load + decrypt the manifest, or create a fresh
   *  vault when the repo has no manifest yet. A wrong passphrase fails
   *  here (AES-GCM authentication) — never later, mid-download.
   *  Migration: a legacy PBKDF2 vault opens with its old key, then
   *  the manifest is re-encrypted under a fresh Argon2id key and
   *  stored before open() returns — the stored envelope is Argon2id
   *  from then on. The migration write happens BEFORE any in-memory
   *  state is assigned, so if it fails the old envelope is untouched
   *  and open() throws with nothing half-migrated. */
  async open(passphrase: string): Promise<void> {
    const stored = await this.client.getBlob(VAULT_MANIFEST_PATH);
    if (stored === null) {
      const salt = randomBytes(16);
      const key = await deriveVaultKeyArgon2id(passphrase, salt);
      const now = Date.now();
      this.manifest = {
        version: 1,
        vaultId: randomId("vault"),
        createdAt: now,
        updatedAt: now,
        entries: [],
        chunks: {},
      };
      this.key = key;
      this.salt = salt;
      this.kdf = "argon2id";
      this.argonParams = ARGON2ID_DEFAULT_PARAMS;
      await this.saveManifest();
      return;
    }
    const { plaintext, key, salt, kdf, argonParams } = await decryptVaultEnvelope(passphrase, stored);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await decompressBytes(plaintext)));
    } catch {
      throw new Error("vault manifest decrypted but is not valid Zstd JSON — the vault is corrupt");
    }
    const manifest = parsed as VaultManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.entries) || typeof manifest.chunks !== "object") {
      throw new Error("vault manifest has an unknown shape — this client cannot open it");
    }
    if (kdf === "pbkdf2") {
      // Migrate: re-encrypt the exact compressed manifest bytes we
      // just decrypted (`plaintext`) under a fresh Argon2id key — the
      // manifest stays byte-identical, only its KDF changes.
      const newSalt = randomBytes(16);
      const newKey = await deriveVaultKeyArgon2id(passphrase, newSalt);
      const { iv, ciphertext } = await encryptBytes(newKey, plaintext);
      await this.client.putBlob(
        VAULT_MANIFEST_PATH,
        packVaultEnvelopeV2(newSalt, ARGON2ID_DEFAULT_PARAMS, iv, ciphertext),
      );
      this.key = newKey;
      this.salt = newSalt;
      this.kdf = "argon2id";
      this.argonParams = ARGON2ID_DEFAULT_PARAMS;
    } else {
      this.key = key;
      this.salt = salt;
      this.kdf = kdf;
      this.argonParams = argonParams ?? ARGON2ID_DEFAULT_PARAMS;
    }
    this.manifest = manifest;
  }

  private requireOpen(): { key: CryptoKey; salt: Uint8Array; manifest: VaultManifest } {
    if (!this.key || !this.salt || !this.manifest) throw new VaultNotOpenError();
    return { key: this.key, salt: this.salt, manifest: this.manifest };
  }

  /** Serialise + compress + encrypt the manifest and store it.
   *  The envelope is packed for this vault's KDF (Argon2id for every
   *  vault created or migrated by this client, PBKDF2 only for a
   *  vault that was opened legacy and not yet migrated — which open()
   *  never leaves standing). Exposed for tests/backups; normal callers
   *  never need it. */
  async saveManifest(): Promise<void> {
    const { key, salt, manifest } = this.requireOpen();
    manifest.updatedAt = Date.now();
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const compressed = await compressBytes(json);
    const { iv, ciphertext } = await encryptBytes(key, compressed);
    await this.client.putBlob(
      VAULT_MANIFEST_PATH,
      packVaultEnvelopeForKdf(this.kdf, salt, iv, ciphertext, this.argonParams),
    );
  }

  /** For tests: the raw encrypted manifest bytes, exactly as stored. */
  async storedManifestBytes(): Promise<Uint8Array | null> {
    return this.client.getBlob(VAULT_MANIFEST_PATH);
  }

  // --- entries ---------------------------------------------------------

  private async toFile(entry: VaultEntry): Promise<VaultFile> {
    const { key } = this.requireOpen();
    const file: VaultFile = {
      id: entry.id,
      kind: entry.kind,
      name: await decryptName(key, entry.encryptedName),
      parentId: entry.parentId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    if (entry.kind === "file") {
      file.size = entry.size;
      file.compressedSize = entry.compressedSize;
      file.mime = entry.mime;
      file.chunkCount = entry.chunkIds?.length ?? 0;
      file.backupKind = entry.backupKind;
      file.backupId = entry.backupId;
    }
    return file;
  }

  private findEntry(id: string): VaultEntry {
    const { manifest } = this.requireOpen();
    const entry = manifest.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`no vault entry with id "${id}"`);
    return entry;
  }

  private async siblingNameTaken(parentId: string | null, name: string, exceptId?: string): Promise<boolean> {
    const { manifest } = this.requireOpen();
    for (const entry of manifest.entries) {
      if (entry.parentId !== parentId || entry.id === exceptId) continue;
      if ((await this.toFile(entry)).name === name) return true;
    }
    return false;
  }

  /** List one folder's contents, folders first, then files, by name. */
  async listFolder(parentId: string | null = null): Promise<VaultFile[]> {
    const { manifest } = this.requireOpen();
    const rows: VaultFile[] = [];
    for (const entry of manifest.entries) {
      if (entry.parentId === parentId) rows.push(await this.toFile(entry));
    }
    rows.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    return rows;
  }

  /** All files (not folders) in the vault, flat. */
  async listAllFiles(): Promise<VaultFile[]> {
    const { manifest } = this.requireOpen();
    const rows: VaultFile[] = [];
    for (const entry of manifest.entries) {
      if (entry.kind === "file") rows.push(await this.toFile(entry));
    }
    return rows;
  }

  /** Search by name — decrypted names only, client-side. The provider
   *  can never search your vault because it cannot see any names. */
  async search(query: string): Promise<VaultFile[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const files = await this.listAllFiles();
    const folders = await this.listAllFolders();
    return [...folders, ...files].filter((f) => f.name.toLowerCase().includes(needle));
  }

  async listAllFolders(): Promise<VaultFile[]> {
    const { manifest } = this.requireOpen();
    const rows: VaultFile[] = [];
    for (const entry of manifest.entries) {
      if (entry.kind === "folder") rows.push(await this.toFile(entry));
    }
    return rows;
  }

  async createFolder(name: string, parentId: string | null = null): Promise<VaultFile> {
    const { key, manifest } = this.requireOpen();
    const clean = name.trim();
    if (!clean) throw new Error("folder name cannot be empty");
    if (parentId !== null) {
      const parent = this.findEntry(parentId);
      if (parent.kind !== "folder") throw new Error("a file cannot contain a folder");
    }
    if (await this.siblingNameTaken(parentId, clean)) {
      throw new Error(`a folder or file named "${clean}" already exists here — pick a different name`);
    }
    const now = Date.now();
    const entry: VaultEntry = {
      id: randomId("fld"),
      kind: "folder",
      encryptedName: await encryptName(key, clean),
      parentId,
      createdAt: now,
      updatedAt: now,
    };
    manifest.entries.push(entry);
    await this.saveManifest();
    return this.toFile(entry);
  }

  async renameEntry(id: string, newName: string): Promise<VaultFile> {
    const { key } = this.requireOpen();
    const entry = this.findEntry(id);
    const clean = newName.trim();
    if (!clean) throw new Error("name cannot be empty");
    if (await this.siblingNameTaken(entry.parentId, clean, id)) {
      throw new Error(`a file or folder named "${clean}" already exists here — pick a different name`);
    }
    entry.encryptedName = await encryptName(key, clean);
    entry.updatedAt = Date.now();
    await this.saveManifest();
    return this.toFile(entry);
  }

  async moveEntry(id: string, newParentId: string | null): Promise<VaultFile> {
    const entry = this.findEntry(id);
    if (newParentId !== null) {
      const parent = this.findEntry(newParentId);
      if (parent.kind !== "folder") throw new Error("a file cannot contain files or folders");
      if (entry.kind === "folder") {
        // Never move a folder into itself or one of its descendants.
        let cursor: string | null = newParentId;
        while (cursor !== null) {
          if (cursor === id) throw new Error("cannot move a folder into itself or one of its own subfolders");
          cursor = this.findEntry(cursor).parentId;
        }
      }
    }
    const name = (await this.toFile(entry)).name;
    if (await this.siblingNameTaken(newParentId, name, id)) {
      throw new Error(`"${name}" already exists in the destination folder — rename it first`);
    }
    entry.parentId = newParentId;
    entry.updatedAt = Date.now();
    await this.saveManifest();
    return this.toFile(entry);
  }

  // --- files -----------------------------------------------------------

  /** Upload a file: Zstd-compress, split into 10 MB chunks, SHA-256
   *  dedup, AES-256-GCM encrypt each new chunk, store blobs, record the
   *  entry. `openScience` is passed through for HF vaults (their client
   *  refuses personal files). `onProgress` (optional) reports the
   *  chunking -> encrypting -> uploading -> done stages; it is how the
   *  drag-and-drop flow shows per-file progress without a second
   *  upload path.
   *
   *  Atomicity: if any chunk write or the manifest save fails, the
   *  in-memory manifest is rolled back to its pre-upload state and
   *  the error rethrown — the stored manifest is left exactly as it
   *  was, and a later upload does not believe a chunk exists that
   *  was never stored. */
  async uploadFile(
    name: string,
    data: Uint8Array,
    parentId: string | null = null,
    mime = "application/octet-stream",
    onProgress?: UploadProgressCallback,
  ): Promise<UploadResult> {
    const { key, manifest } = this.requireOpen();
    const clean = name.trim();
    if (!clean) throw new Error("file name cannot be empty");
    if (parentId !== null) {
      const parent = this.findEntry(parentId);
      if (parent.kind !== "folder") throw new Error("a file cannot contain files");
    }
    if (await this.siblingNameTaken(parentId, clean)) {
      throw new Error(`a file or folder named "${clean}" already exists here — rename it first`);
    }
    const emit = (stage: UploadStage, bytesDone: number, chunksDone: number, chunksTotal: number, chunksDeduped: number): void => {
      onProgress?.({
        fileName: clean,
        relativePath: clean,
        stage,
        bytesDone,
        bytesTotal: data.length,
        chunksDone,
        chunksTotal,
        chunksDeduped,
      });
    };
    // Snapshot for rollback (see doc comment above).
    const entriesLength = manifest.entries.length;
    const chunkSnapshot = new Map(
      Object.entries(manifest.chunks).map(([hash, record]) => [hash, { ...record }]),
    );
    try {
      emit("chunking", 0, 0, 0, 0);
      const fileHash = await sha256Hex(data);
      // An empty file stores zero chunks: compressing empty input would
      // still produce a 9-byte Zstd frame and claim one chunk uploaded,
      // contradicting the 0-chunk contract (and the download path below
      // must not try to decompress zero bytes).
      const compressed = data.length === 0 ? new Uint8Array(0) : await compressBytes(data);
      const chunks = data.length === 0 ? [] : await splitBytes(compressed);
      const knownHashes = new Set(Object.keys(manifest.chunks));
      const toUpload = chunksNeedingUpload(chunks, knownHashes);
      emit("encrypting", 0, 0, chunks.length, chunks.length - toUpload.length);
      const chunkIds: string[] = [];
      const chunkHashes: string[] = [];
      let chunksUploaded = 0;
      let chunksDone = 0;
      for (const chunk of chunks) {
        chunkHashes.push(chunk.hash);
        const existing = manifest.chunks[chunk.hash];
        if (existing) {
          chunkIds.push(existing.blobId);
          existing.refCount++;
          chunksDone++;
          emit("uploading", data.length, chunksDone, chunks.length, chunks.length - toUpload.length);
          continue;
        }
        const encrypted = await encryptChunk(key, chunk);
        const stored = packStoredChunk(encrypted.iv, encrypted.encrypted);
        await this.client.putBlob(blobPath(encrypted.blobId), stored);
        // Phase 2 P2P: offer the fresh chunk to own online devices.
        // A hook failure must never fail the upload — the repo blob
        // is the durable copy and the transfer is best-effort.
        try {
          this.hooks?.onChunkUploaded?.(manifest.vaultId, encrypted.blobId, stored);
        } catch {
          // Best-effort only.
        }
        manifest.chunks[chunk.hash] = {
          blobId: encrypted.blobId,
          size: chunk.plaintext.length,
          encryptedSize: encrypted.encrypted.length + 12,
          refCount: 1,
        };
        chunkIds.push(encrypted.blobId);
        chunksUploaded++;
        chunksDone++;
        emit("uploading", data.length, chunksDone, chunks.length, chunks.length - toUpload.length);
      }
      const now = Date.now();
      const entry: VaultEntry = {
        id: randomId("fil"),
        kind: "file",
        encryptedName: await encryptName(key, clean),
        parentId,
        createdAt: now,
        updatedAt: now,
        size: data.length,
        compressedSize: compressed.length,
        mime,
        chunkIds,
        chunkHashes,
        fileHash,
      };
      manifest.entries.push(entry);
      await this.saveManifest();
      const result: UploadResult = {
        file: await this.toFile(entry),
        chunksUploaded,
        chunksDeduped: chunks.length - toUpload.length,
      };
      emit("done", data.length, chunks.length, chunks.length, result.chunksDeduped);
      return result;
    } catch (error) {
      // Roll the in-memory manifest back: no half-uploaded entry, no
      // chunk records for blobs that may never have been stored.
      manifest.entries.length = entriesLength;
      manifest.chunks = Object.fromEntries(chunkSnapshot);
      throw error;
    }
  }

  /** Find (or create) the folder chain for a dropped relative path.
   *  Returns the final folder's VaultFile, or null for the vault root.
   *  Existing folders are reused by decrypted name — dropping the same
   *  folder twice never creates a duplicate. A ".." segment is refused:
   *  a drop must never escape the vault (or the target folder). */
  async ensureFolderPath(relativeDir: string, parentId: string | null = null): Promise<VaultFile | null> {
    this.requireOpen();
    const segments = normalizeDroppedPath(relativeDir)
      .split("/")
      .filter((p) => p !== "" && p !== ".");
    if (segments.includes("..")) {
      throw new Error(`folder path "${relativeDir}" contains ".." — a dropped folder cannot escape the vault`);
    }
    let currentParent: string | null = parentId;
    let current: VaultFile | null = null;
    for (const segment of segments) {
      const siblings = await this.listFolder(currentParent);
      const existing = siblings.find((f) => f.kind === "folder" && f.name === segment);
      if (existing) {
        current = existing;
      } else {
        current = await this.createFolder(segment, currentParent);
      }
      currentParent = current.id;
    }
    return current;
  }

  /** Drag-and-drop upload: the whole drop, file by file, through the
   *  one upload path (uploadFile — chunk -> encrypt -> backend write).
   *  Dropped folders keep their relative paths: "Photos/2026/a.jpg"
   *  creates/reuses Photos/2026 and stores the file there. Duplicate
   *  content is deduped by SHA-256 inside uploadFile (no new chunk is
   *  written); duplicate *names* in one folder are a per-file error.
   *  A failed file is reported in its result (and via onProgress with
   *  stage "error") and the manifest is left unchanged for it — the
   *  remaining files still upload. Files are processed in drop order. */
  async uploadDroppedFiles(
    files: DroppedUpload[],
    parentId: string | null = null,
    onProgress?: UploadProgressCallback,
  ): Promise<DroppedUploadResult[]> {
    this.requireOpen();
    const results: DroppedUploadResult[] = [];
    for (const dropped of files) {
      const path = normalizeDroppedPath(dropped.path);
      const reportError = (message: string): DroppedUploadResult => {
        onProgress?.({
          fileName: splitDroppedPath(path).name || path,
          relativePath: path,
          stage: "error",
          bytesDone: 0,
          bytesTotal: dropped.data.length,
          chunksDone: 0,
          chunksTotal: 0,
          chunksDeduped: 0,
          error: message,
        });
        return { path, file: null, chunksUploaded: 0, chunksDeduped: 0, error: message };
      };
      if (!path) {
        results.push(reportError("dropped entry has no name — skipped"));
        continue;
      }
      const isFolderOnly = dropped.path.trim().endsWith("/");
      const { folders, name } = splitDroppedPath(path);
      if (folders.includes("..")) {
        results.push(reportError(`"${path}" contains ".." — a dropped path cannot escape the vault`));
        continue;
      }
      try {
        if (isFolderOnly) {
          // An empty dropped folder: create the chain, no file.
          const folder = await this.ensureFolderPath(path, parentId);
          onProgress?.({
            fileName: name,
            relativePath: path,
            stage: "done",
            bytesDone: 0,
            bytesTotal: 0,
            chunksDone: 0,
            chunksTotal: 0,
            chunksDeduped: 0,
          });
          results.push({ path, file: folder, chunksUploaded: 0, chunksDeduped: 0 });
          continue;
        }
        if (!name) {
          results.push(reportError(`"${path}" has no file name — skipped`));
          continue;
        }
        onProgress?.({
          fileName: name,
          relativePath: path,
          stage: "queued",
          bytesDone: 0,
          bytesTotal: dropped.data.length,
          chunksDone: 0,
          chunksTotal: 0,
          chunksDeduped: 0,
        });
        const folder = folders.length > 0 ? await this.ensureFolderPath(folders.join("/"), parentId) : null;
        const targetParent = folder ? folder.id : parentId;
        const result = await this.uploadFile(name, dropped.data, targetParent, dropped.mime, (progress) => {
          // uploadFile reports relativePath === file name; re-root it
          // under the dropped path so the UI tracks the right row.
          onProgress?.({ ...progress, relativePath: path });
        });
        results.push({ path, file: result.file, chunksUploaded: result.chunksUploaded, chunksDeduped: result.chunksDeduped });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push(reportError(message));
      }
    }
    return results;
  }

  /** Import one chunk that arrived over P2P (phase 2). The bytes are
   *  the packed stored form (`iv | ciphertext`) from
   *  `packStoredChunk`, already SHA-256-verified on the wire by
   *  DriveP2P. This method verifies them again locally: the vault
   *  id must match the open vault, the bytes must decrypt under
   *  this vault's key (AES-GCM authentication — a chunk for another
   *  vault, or a tampered one, fails here), and the plaintext hash
   *  becomes the manifest key. The blob is written to the repo
   *  (skipped when already there) and recorded in the in-memory
   *  manifest so a later upload of the same file dedups instead of
   *  re-uploading; the manifest itself is NOT saved here — it stays
   *  the repo's durable copy and syncs through the normal path.
   *  Returns the chunk hash and whether the blob was new. */
  async importStoredChunk(
    vaultId: string,
    blobId: string,
    storedBytes: Uint8Array,
  ): Promise<{ hash: string; stored: boolean }> {
    const { key, manifest } = this.requireOpen();
    if (vaultId !== manifest.vaultId) {
      throw new Error("chunk is for a different vault — refused");
    }
    if (storedBytes.length < 12) {
      throw new Error("chunk is too short to hold an AES-GCM iv — refused");
    }
    const iv = storedBytes.slice(0, 12);
    const ciphertext = storedBytes.slice(12);
    // AES-GCM authentication fails here for a wrong key or tampered
    // bytes — the chunk never reaches the repo unverified.
    const plain = await decryptBytes(key, iv, ciphertext);
    const hash = await sha256Hex(plain);
    const existing = manifest.chunks[hash];
    if (existing) {
      // Already have these bytes (same hash): the blob is a dup.
      return { hash, stored: false };
    }
    const alreadyInRepo = await this.client.getBlob(blobPath(blobId));
    if (alreadyInRepo === null) {
      await this.client.putBlob(blobPath(blobId), storedBytes);
    }
    manifest.chunks[hash] = {
      blobId,
      size: plain.length,
      encryptedSize: ciphertext.length + 12,
      refCount: 0,
    };
    return { hash, stored: true };
  }

  /** Download a file: fetch + decrypt + hash-verify every chunk,
   *  reassemble, Zstd-decompress. Any integrity failure throws. */
  async downloadFile(id: string): Promise<Uint8Array> {
    const { key } = this.requireOpen();
    const entry = this.findEntry(id);
    if (entry.kind !== "file") throw new Error("cannot download a folder — download the files inside it");
    const chunkIds = entry.chunkIds ?? [];
    const chunkHashes = entry.chunkHashes ?? [];
    const stored: Array<{ blobId: string; bytes: Uint8Array }> = [];
    for (const blobId of chunkIds) {
      const bytes = await this.client.getBlob(blobPath(blobId));
      if (bytes === null) {
        throw new Error(`chunk ${blobId} is missing from the vault — the file is incomplete and cannot be downloaded`);
      }
      stored.push({ blobId, bytes });
    }
    const compressed = await reassembleChunks(key, stored, chunkHashes);
    let plain: Uint8Array;
    if (chunkIds.length === 0) {
      // Empty file: zero chunks, zero bytes — no Zstd frame to decompress.
      plain = new Uint8Array(0);
    } else {
      try {
        plain = await decompressBytes(compressed);
      } catch {
        throw new Error("downloaded file decompressed to invalid data — the stored chunks are corrupt");
      }
    }
    if (entry.fileHash) {
      const actual = await sha256Hex(plain);
      if (actual !== entry.fileHash) {
        throw new Error(
          `downloaded file failed its integrity check (SHA-256 mismatch) — the stored chunks are corrupt, download aborted`,
        );
      }
    }
    return plain;
  }

  // --- delete (two-step, no trash in v1.0) ------------------------------

  private descendantsOf(id: string): VaultEntry[] {
    const { manifest } = this.requireOpen();
    const out: VaultEntry[] = [];
    const walk = (parentId: string): void => {
      for (const entry of manifest.entries) {
        if (entry.parentId === parentId) {
          out.push(entry);
          if (entry.kind === "folder") walk(entry.id);
        }
      }
    };
    walk(id);
    return out;
  }

  async prepareDelete(id: string): Promise<DeleteConfirmation> {
    const entry = this.findEntry(id);
    const { manifest } = this.requireOpen();
    const targets = entry.kind === "folder" ? [entry, ...this.descendantsOf(id)] : [entry];
    let bytesFreed = 0;
    const chunkUse = new Map<string, number>();
    for (const target of targets) {
      if (target.kind === "file") {
        bytesFreed += target.size ?? 0;
        for (const hash of target.chunkHashes ?? []) {
          chunkUse.set(hash, (chunkUse.get(hash) ?? 0) + 1);
        }
      }
    }
    let orphanedChunks = 0;
    for (const [hash, uses] of chunkUse) {
      const record = manifest.chunks[hash];
      if (record && record.refCount - uses <= 0) orphanedChunks++;
    }
    return {
      entryId: id,
      name: (await this.toFile(entry)).name,
      kind: entry.kind,
      descendantCount: targets.length - 1,
      bytesFreed,
      orphanedChunks,
      confirmed: false,
    };
  }

  /** Execute a prepared delete. Refuses unless confirmation.confirmed
   *  is true — the UI must show the confirmation first. There is no
   *  trash in v1.0: this is permanent. */
  async confirmDelete(confirmation: DeleteConfirmation): Promise<void> {
    if (!confirmation.confirmed) {
      throw new Error("delete was not confirmed — pass a confirmation with confirmed: true");
    }
    const { manifest } = this.requireOpen();
    const entry = this.findEntry(confirmation.entryId);
    const targets = entry.kind === "folder" ? [entry, ...this.descendantsOf(entry.id)] : [entry];
    const targetIds = new Set(targets.map((t) => t.id));
    // Decrement chunk refCounts; delete blobs that hit zero.
    const orphanHashes: string[] = [];
    for (const target of targets) {
      if (target.kind !== "file") continue;
      for (const hash of target.chunkHashes ?? []) {
        const record = manifest.chunks[hash];
        if (!record) continue;
        record.refCount--;
        if (record.refCount <= 0) orphanHashes.push(hash);
      }
    }
    for (const hash of orphanHashes) {
      const record = manifest.chunks[hash];
      if (!record) continue;
      await this.client.deleteBlob(blobPath(record.blobId));
      delete manifest.chunks[hash];
    }
    manifest.entries = manifest.entries.filter((e) => !targetIds.has(e.id));
    await this.saveManifest();
  }

  // --- usage ------------------------------------------------------------

  async usage(): Promise<VaultUsage> {
    const { manifest } = this.requireOpen();
    let fileCount = 0;
    let folderCount = 0;
    for (const entry of manifest.entries) {
      if (entry.kind === "file") fileCount++;
      else folderCount++;
    }
    let usedBytes = 0;
    for (const record of Object.values(manifest.chunks)) usedBytes += record.encryptedSize;
    // The manifest itself also occupies repo space; count it.
    const manifestBytes = await this.client.getBlob(VAULT_MANIFEST_PATH);
    if (manifestBytes) usedBytes += manifestBytes.length;
    const quotaBytes = BACKEND_QUOTAS[this.backend.kind].softLimitBytes;
    return {
      backend: this.backend,
      fileCount,
      folderCount,
      blobCount: Object.keys(manifest.chunks).length,
      usedBytes,
      quotaBytes,
      usedRatio: quotaBytes > 0 ? usedBytes / quotaBytes : 0,
    };
  }

  /** Raw manifest access for backups (backup.ts) — entries only, the
   *  caller must not mutate the returned object. */
  async manifestEntries(): Promise<VaultEntry[]> {
    const { manifest } = this.requireOpen();
    return [...manifest.entries];
  }

  /** Tag an uploaded file as a backup (backup.ts). Sets the backup
   *  kind + record id on the entry and re-saves the manifest. */
  async tagBackup(fileId: string, kind: NonNullable<VaultEntry["backupKind"]>): Promise<void> {
    const entry = this.findEntry(fileId);
    if (entry.kind !== "file") throw new Error("only files can be tagged as backups");
    entry.backupKind = kind;
    entry.backupId = fileId;
    entry.updatedAt = Date.now();
    await this.saveManifest();
  }

  /** List stored blob paths (debug / integrity audit). */
  async listStoredBlobs(): Promise<string[]> {
    return this.client.listBlobs(VAULT_BLOB_PREFIX);
  }
}
