// ArkNetzWebWeaver — ArkDrive one-click encrypted backups (turn 46).
// Back up a site (site.json.zst), a .arknetz offline bundle, archived
// protocol-mail, or an HTML5 game project into the vault. Every backup
// is a normal vault file under the reserved "ArkNetz Backups" folder,
// tagged with its backup kind, plus a backup manifest (what was backed
// up, when, chunk hashes) the caller can export. Restore re-downloads,
// re-verifies the SHA-256 of the original bytes, and only then hands
// the bytes back.

import { sha256Hex } from "./crypto.js";
import type { VaultManager } from "./drive.js";
import type { BackupKind, VaultEntry } from "./types.js";
import { VAULT_BACKUP_FOLDER_NAME } from "./types.js";

export interface BackupRecord {
  id: string;
  kind: BackupKind;
  label: string;
  /** What was backed up, e.g. the domain, bundle name, or game title. */
  sourceName: string;
  createdAt: number; // unix ms
  /** Vault file entry id holding the backup bytes. */
  fileId: string;
  /** Original (uncompressed) size in bytes. */
  size: number;
  /** SHA-256 hex of the original bytes — verified on restore. */
  fileHash: string;
  /** SHA-256 hex of each stored chunk, in order. */
  chunkHashes: string[];
}

export const BACKUP_KIND_LABELS: Record<BackupKind, string> = {
  site: "Site backup (site.json.zst)",
  bundle: ".arknetz offline bundle",
  mail: "Archived protocol-mail",
  game: "HTML5 game project",
};

/** The backup manifest, as JSON — what was backed up, when, and the
 *  chunk hashes needed to prove the restore is intact. */
export function backupManifestJson(record: BackupRecord): string {
  return JSON.stringify(
    {
      arknetzBackup: 1,
      id: record.id,
      kind: record.kind,
      kindLabel: BACKUP_KIND_LABELS[record.kind],
      label: record.label,
      sourceName: record.sourceName,
      createdAt: record.createdAt,
      createdAtIso: new Date(record.createdAt).toISOString(),
      fileId: record.fileId,
      size: record.size,
      fileHashSha256: record.fileHash,
      chunkHashesSha256: record.chunkHashes,
    },
    null,
    2,
  );
}

async function backupFolderId(manager: VaultManager): Promise<string> {
  const folders = await manager.listAllFolders();
  const existing = folders.find((f) => f.parentId === null && f.name === VAULT_BACKUP_FOLDER_NAME);
  if (existing) return existing.id;
  const created = await manager.createFolder(VAULT_BACKUP_FOLDER_NAME, null);
  return created.id;
}

function backupFileName(kind: BackupKind, label: string, createdAt: number): string {
  const safe = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = new Date(createdAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${kind}-${safe || "backup"}-${stamp}.arkbak`;
}

function recordFromEntry(entry: VaultEntry, label: string): BackupRecord {
  return {
    id: entry.id,
    kind: entry.backupKind as BackupKind,
    label,
    sourceName: label,
    createdAt: entry.createdAt,
    fileId: entry.id,
    size: entry.size ?? 0,
    fileHash: entry.fileHash ?? "",
    chunkHashes: entry.chunkHashes ?? [],
  };
}

/**
 * One-click backup: store `data` in the vault under "ArkNetz Backups"
 * and return the record. The bytes go through the normal encrypted
 * upload path (Zstd + 10 MB chunks + dedup + AES-256-GCM), so backing
 * up a site you already backed up mostly dedups to zero new chunks.
 */
export async function createBackup(
  manager: VaultManager,
  kind: BackupKind,
  label: string,
  sourceName: string,
  data: Uint8Array,
): Promise<BackupRecord> {
  const folderId = await backupFolderId(manager);
  const createdAt = Date.now();
  const fileName = backupFileName(kind, label, createdAt);
  const fileHash = await sha256Hex(data);
  const result = await manager.uploadFile(fileName, data, folderId, "application/x-arknetz-backup");
  await manager.tagBackup(result.file.id, kind);
  const entries = await manager.manifestEntries();
  const entry = entries.find((e) => e.id === result.file.id) as VaultEntry | undefined;
  return {
    id: result.file.id,
    kind,
    label,
    sourceName,
    createdAt,
    fileId: result.file.id,
    size: data.length,
    fileHash,
    chunkHashes: entry?.chunkHashes ?? [],
  };
}

/** All backups in the vault, newest first. */
export async function listBackups(manager: VaultManager): Promise<BackupRecord[]> {
  const entries = await manager.manifestEntries();
  const files = await manager.listAllFiles();
  const nameById = new Map(files.map((f) => [f.id, f.name]));
  const out: BackupRecord[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.backupKind) continue;
    out.push(recordFromEntry(entry, nameById.get(entry.id) ?? entry.id));
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * Restore a backup: download + verify the SHA-256 of the original
 * bytes. A mismatch throws — a corrupt restore is never returned.
 * Returns the original bytes (e.g. a site.json.zst or .arknetz bundle).
 */
export async function restoreBackup(manager: VaultManager, backupId: string): Promise<Uint8Array> {
  const entries = await manager.manifestEntries();
  const entry = entries.find((e) => e.id === backupId && e.kind === "file");
  if (!entry) throw new Error(`no backup with id "${backupId}" in this vault`);
  const bytes = await manager.downloadFile(backupId);
  if (entry.fileHash) {
    const actual = await sha256Hex(bytes);
    if (actual !== entry.fileHash) {
      throw new Error(
        `backup restore failed its integrity check (SHA-256 mismatch) — the stored backup is corrupt, nothing was restored`,
      );
    }
  }
  return bytes;
}
