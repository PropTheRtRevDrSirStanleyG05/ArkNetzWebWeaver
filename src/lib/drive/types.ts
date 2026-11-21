// ArkNetzWebWeaver — ArkDrive types (thread turn 46, READINESS-PARITY §4).
// Zero-knowledge encrypted cloud drive: private Git repos (gh:/gl:/cb:)
// and open-science Hugging Face (hf:) become personal cloud storage.
// Internet Archive (ia:) and Wikimedia (wm:) are EXCLUDED from ArkDrive
// by ToS — opaque encrypted personal blobs violate their terms; the drive
// refuses them outright (see backends.ts) and never offers them as targets.
//
// A repo inspector sees only `vault-index.enc.zst` and random-named
// `blob_*.enc` chunks: zero filenames, zero previews, zero metadata.
// File contents AND filename/folder metadata are AES-256-GCM encrypted
// in-browser; the vault key never leaves the client.

/** Backends ArkDrive may use. ia:/wm: are deliberately NOT in this union. */
export type DriveBackendKind = "gh" | "gl" | "cb" | "hf";

/** Backends the drive refuses (ToS: public cultural/educational only). */
export type ExcludedDriveBackendKind = "ia" | "wm";

export const DRIVE_BACKEND_KINDS: DriveBackendKind[] = ["gh", "gl", "cb", "hf"];
export const EXCLUDED_DRIVE_BACKEND_KINDS: ExcludedDriveBackendKind[] = ["ia", "wm"];

/** One vault: a single private repo (or HF dataset repo) holding a drive. */
export interface VaultBackend {
  kind: DriveBackendKind;
  /** e.g. "gh:alice/arknetz-vault", "gl:alice/vault", "hf:alice/open-data" */
  uri: string;
  /** "owner/repo" — the repo that stores this vault's blobs + manifest. */
  repo: string;
  /** Branch the vault lives on. Defaults to "main". */
  branch?: string;
  /** Keyring account id that owns this vault (turn 45 per-account binding).
   *  A backup/upload must name this account, or it is refused — a file
   *  must never land in the wrong account's vault. */
  accountId: string;
  /** Human label shown in the Pooled Drive view, e.g. "Personal vault". */
  label?: string;
}

/** Quota for one backend kind (thread turn 46; thread numbers, not
 *  live-verified against provider docs — see honest gaps in drive-ui.ts). */
export interface BackendQuota {
  kind: DriveBackendKind;
  label: string;
  /** Bytes the user can safely use for vault storage. */
  softLimitBytes: number;
  notes: string;
}

export const BACKEND_QUOTAS: Record<DriveBackendKind, BackendQuota> = {
  gh: {
    kind: "gh",
    label: "GitHub (private repo)",
    softLimitBytes: 5 * 1024 ** 3,
    notes: "GitHub discourages repos as binary storage; ~1 GB is the soft per-repo guidance, up to ~5 GB is workable. Chunks stay under 25 MB so Git never chokes.",
  },
  gl: {
    kind: "gl",
    label: "GitLab (private project)",
    softLimitBytes: 10 * 1024 ** 3,
    notes: "Up to 10 GiB per project — the ideal primary vault / backup mirror.",
  },
  cb: {
    kind: "cb",
    label: "Codeberg (private repo)",
    softLimitBytes: 750 * 1024 ** 2,
    notes: "750 MiB Git storage per free account (+ 1.5 GiB attachments, which the vault does not use). Smallest vault; good as a mirror.",
  },
  hf: {
    kind: "hf",
    label: "Hugging Face (open-science only)",
    softLimitBytes: 5 * 1024 ** 4,
    notes: "Up to ~5 TB free, but ONLY for open-science / AI / code — ML datasets, model weights, research backups. Arbitrary personal files are refused by the HF client (ToS).",
  },
};

/** Minimal AccountKeyring shape the drive depends on. The accounts phase
 *  (thread turn 45) owns the real keyring; the drive only needs to know
 *  which account a vault belongs to, so a backup never lands in the
 *  wrong account's vault. */
export interface KeyringAccount {
  id: string;
  kind: DriveBackendKind;
  label: string;
}

export interface AccountKeyring {
  accounts: KeyringAccount[];
  accountLabel(accountId: string): string | null;
  owns(accountId: string, kind: DriveBackendKind): boolean;
}

export function makeAccountKeyring(accounts: KeyringAccount[]): AccountKeyring {
  return {
    accounts,
    accountLabel(accountId: string): string | null {
      return accounts.find((a) => a.id === accountId)?.label ?? null;
    },
    owns(accountId: string, kind: DriveBackendKind): boolean {
      return accounts.some((a) => a.id === accountId && a.kind === kind);
    },
  };
}

/** One 10 MB chunk of a (Zstd-compressed) file, before encryption. */
export interface Chunk {
  index: number;
  /** SHA-256 hex of the chunk's (compressed) plaintext — the dedup key. */
  hash: string;
  plaintext: Uint8Array;
}

/** One chunk after AES-256-GCM encryption, as stored in the repo. */
export interface EncryptedChunk {
  /** e.g. "blob_8f9a2c41d7e0.enc" — content-addressed, random-looking. */
  blobId: string;
  /** SHA-256 hex of the chunk's plaintext (pre-encryption). */
  hash: string;
  encrypted: Uint8Array;
}

/** One entry in the vault manifest. The manifest itself is encrypted
 *  (vault-index.enc.zst), and names are ALSO individually encrypted, so
 *  even a leaked manifest plaintext reveals no filenames. */
export interface VaultEntry {
  id: string;
  kind: "file" | "folder";
  /** AES-256-GCM envelope (base64url) of the plain name. Never plaintext. */
  encryptedName: string;
  /** Parent folder id, or null for the vault root. */
  parentId: string | null;
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
  // --- file-only fields ---
  /** Original (uncompressed) size in bytes. */
  size?: number;
  /** Zstd-compressed size in bytes. */
  compressedSize?: number;
  mime?: string;
  /** Blob ids in order; reassembled in-browser on Download. */
  chunkIds?: string[];
  /** SHA-256 hex of each chunk's plaintext, same order as chunkIds. */
  chunkHashes?: string[];
  /** SHA-256 hex of the original (uncompressed) file, for restore checks. */
  fileHash?: string;
  /** Set for one-click backups (see backup.ts). */
  backupKind?: BackupKind;
  /** Backup record id, when backupKind is set. */
  backupId?: string;
}

export type BackupKind = "site" | "bundle" | "mail" | "game";

/** The vault manifest — the decrypted shape of vault-index.enc.zst.
 *  Stored form: JSON -> Zstd -> AES-256-GCM envelope (see drive.ts). */
export interface VaultManifest {
  version: 1;
  vaultId: string;
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
  entries: VaultEntry[];
  /** Dedup index: chunk plaintext SHA-256 -> stored blob. */
  chunks: Record<string, VaultChunkRecord>;
}

export interface VaultChunkRecord {
  blobId: string;
  /** Compressed chunk size in bytes. */
  size: number;
  /** Encrypted blob size in bytes. */
  encryptedSize: number;
  /** How many files reference this chunk (0 = orphan, safe to delete). */
  refCount: number;
}

/** A decrypted file/folder as the file manager shows it. */
export interface VaultFile {
  id: string;
  kind: "file" | "folder";
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  size?: number;
  compressedSize?: number;
  mime?: string;
  chunkCount?: number;
  backupKind?: BackupKind;
  backupId?: string;
}

/** Two-step delete: v1.0 has NO trash (trash-with-restore is v1.1).
 *  prepareDelete() returns this; the UI shows it and only confirmDelete()
 *  with { confirmed: true } actually deletes. */
export interface DeleteConfirmation {
  entryId: string;
  name: string;
  kind: "file" | "folder";
  /** Folders: how many entries inside are deleted too. */
  descendantCount: number;
  /** Bytes freed (files only; folders sum their files). */
  bytesFreed: number;
  /** Chunks that become orphans and are removed. */
  orphanedChunks: number;
  confirmed: boolean;
}

/** One vault's usage, for the Pooled Drive space accounting. */
export interface VaultUsage {
  backend: VaultBackend;
  fileCount: number;
  folderCount: number;
  blobCount: number;
  usedBytes: number;
  quotaBytes: number;
  /** usedBytes / quotaBytes, 0..1 (may exceed 1 if over quota). */
  usedRatio: number;
}

/** Unified multi-account "Pooled Drive" view (turn 46). */
export interface PooledDriveView {
  vaults: VaultUsage[];
  totalUsedBytes: number;
  totalQuotaBytes: number;
  totalFiles: number;
  /** Vaults grouped by owning account, for the per-account binding. */
  byAccount: Array<{ accountId: string; accountLabel: string; vaults: VaultUsage[] }>;
}

/** A file/folder row in the pooled tree, with its home vault attached. */
export interface PooledEntry {
  file: VaultFile;
  vault: VaultBackend;
  accountId: string;
}

/** Where the vault lives inside a repo. */
export const VAULT_MANIFEST_PATH = "vault-index.enc.zst";
export const VAULT_BLOB_PREFIX = "blobs/";
export const VAULT_BACKUP_FOLDER_NAME = "ArkNetz Backups";

export function blobPath(blobId: string): string {
  return `${VAULT_BLOB_PREFIX}${blobId}`;
}

/** 10 MB chunks (thread turn 46). Chunks stay well under Git's 25 MB
 *  choke point and under the 100 MB per-file hard limit. */
export const VAULT_CHUNK_SIZE = 10 * 1024 * 1024;
