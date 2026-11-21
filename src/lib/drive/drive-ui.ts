// ArkNetzWebWeaver — ArkDrive view models (no DOM edits).
// Pure functions returning view data + plain-English copy; the
// coordinator wires these into the shell UI later. Every limit in
// READINESS-PARITY §4 is stated here in the user's own language —
// nothing is hidden, nothing is oversold.

import type { DeleteConfirmation, PooledDriveView, VaultFile, VaultUsage } from "./types.js";
import { BACKEND_QUOTAS } from "./types.js";
import type { BackupRecord } from "./backup.js";
import { BACKUP_KIND_LABELS } from "./backup.js";
import type { DroppedUpload, UploadProgress, UploadStage } from "./drive.js";

/** Honest-limits copy (READINESS-PARITY §4). Shown in the Drive view,
 *  not buried in a settings page. */
export const HONEST_LIMITS_COPY = {
  title: "What ArkDrive is — and isn't",
  quota:
    "There is no single 15 GB free quota like Google Drive. Your space is pooled across your own private repos: GitHub ~1–5 GB, GitLab up to 10 GiB, Codeberg 750 MiB. Add another vault to add space.",
  sharing:
    "There are no public share links. A public link would break zero-knowledge — anyone with the link could read the blob. Sharing is via wrapped keys to named recipients, like protocol mail.",
  collaboration:
    "No real-time collaborative editing of documents or spreadsheets — that is STANBEYOND Writer and Sheet, separate apps, not ArkDrive.",
  sync: "Sync is in-app, on open and on demand. There is no background sync daemon yet — the app only talks to your vaults while it is running.",
  passphrase:
    "Your vault passphrase is the only key. There is no password reset: if you lose it, the vault cannot be opened by anyone — including us. Write it down somewhere safe.",
  encryption:
    "Zero-knowledge: files are compressed and AES-256-GCM encrypted in this app before upload, and so are the file and folder names. A repo inspector sees only an encrypted index and random-named chunks. The key is derived from your passphrase with Argon2id (19 MiB, 2 iterations — the OWASP recommendation); vaults created before the Argon2id upgrade still open, and are migrated to Argon2id automatically the first time you unlock them.",
} as const;

export const DRIVE_EMPTY_COPY = {
  heading: "Your vault is empty",
  body: "Drag files here, or use Upload. Everything is compressed and encrypted in this app before it leaves your device — your repo never sees a filename.",
} as const;

export const IA_WM_EXCLUDED_COPY =
  "Internet Archive and Wikimedia are not vault targets: both are for public cultural and educational material only, and uploading encrypted personal files would break their terms. ArkDrive uses private GitHub, GitLab and Codeberg repos (and Hugging Face for open-science only).";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] as string}`;
}

export function formatDate(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface FileRowView {
  id: string;
  name: string;
  kind: "file" | "folder";
  sizeLabel: string;
  updatedLabel: string;
  mime?: string;
  chunkCount?: number;
  isBackup: boolean;
  backupLabel?: string;
}

export function fileRowView(file: VaultFile): FileRowView {
  return {
    id: file.id,
    name: file.name,
    kind: file.kind,
    sizeLabel: file.kind === "folder" ? "—" : formatBytes(file.size ?? 0),
    updatedLabel: formatDate(file.updatedAt),
    mime: file.mime,
    chunkCount: file.chunkCount,
    isBackup: file.backupKind !== undefined,
    backupLabel: file.backupKind ? BACKUP_KIND_LABELS[file.backupKind] : undefined,
  };
}

export function fileListView(files: VaultFile[]): { rows: FileRowView[]; isEmpty: boolean; copy: typeof DRIVE_EMPTY_COPY } {
  return { rows: files.map(fileRowView), isEmpty: files.length === 0, copy: DRIVE_EMPTY_COPY };
}

export interface QuotaView {
  backendLabel: string;
  repo: string;
  usedLabel: string;
  quotaLabel: string;
  remainingLabel: string;
  percentUsed: number;
  overQuota: boolean;
  notes: string;
}

export function quotaView(usage: VaultUsage): QuotaView {
  const quota = BACKEND_QUOTAS[usage.backend.kind];
  return {
    backendLabel: quota.label,
    repo: usage.backend.repo,
    usedLabel: formatBytes(usage.usedBytes),
    quotaLabel: formatBytes(usage.quotaBytes),
    remainingLabel: formatBytes(Math.max(0, usage.quotaBytes - usage.usedBytes)),
    percentUsed: Math.round(usage.usedRatio * 100),
    overQuota: usage.usedRatio >= 1,
    notes: quota.notes,
  };
}

export interface PooledDriveViewModel {
  totalUsedLabel: string;
  totalQuotaLabel: string;
  totalFiles: number;
  vaultCount: number;
  quotas: QuotaView[];
  byAccount: Array<{ accountId: string; accountLabel: string; vaultLabels: string[] }>;
}

export function pooledDriveView(view: PooledDriveView): PooledDriveViewModel {
  return {
    totalUsedLabel: formatBytes(view.totalUsedBytes),
    totalQuotaLabel: formatBytes(view.totalQuotaBytes),
    totalFiles: view.totalFiles,
    vaultCount: view.vaults.length,
    quotas: view.vaults.map(quotaView),
    byAccount: view.byAccount.map((group) => ({
      accountId: group.accountId,
      accountLabel: group.accountLabel,
      vaultLabels: group.vaults.map((u) => `${BACKEND_QUOTAS[u.backend.kind].label} — ${u.backend.repo}`),
    })),
  };
}

export interface DeleteConfirmationView {
  heading: string;
  body: string;
  detailLines: string[];
  confirmLabel: string;
  cancelLabel: string;
}

export function deleteConfirmationView(confirmation: DeleteConfirmation): DeleteConfirmationView {
  const what = confirmation.kind === "folder" ? `folder "${confirmation.name}"` : `file "${confirmation.name}"`;
  const lines = [
    `${formatBytes(confirmation.bytesFreed)} will be freed.`,
    confirmation.descendantCount > 0
      ? `${confirmation.descendantCount} item${confirmation.descendantCount === 1 ? "" : "s"} inside the folder will be deleted too.`
      : "Only this file will be deleted.",
    `${confirmation.orphanedChunks} stored chunk${confirmation.orphanedChunks === 1 ? "" : "s"} will be removed from the repo.`,
  ];
  return {
    heading: `Delete ${what}?`,
    body: "There is no trash in ArkDrive v1.0 — this is permanent and cannot be undone. Trash with restore comes in v1.1.",
    detailLines: lines,
    confirmLabel: "Delete permanently",
    cancelLabel: "Keep it",
  };
}

export interface BackupRowView {
  id: string;
  kindLabel: string;
  label: string;
  sourceName: string;
  createdLabel: string;
  sizeLabel: string;
  chunkCount: number;
}

export function backupListView(backups: BackupRecord[]): BackupRowView[] {
  return backups.map((b) => ({
    id: b.id,
    kindLabel: BACKUP_KIND_LABELS[b.kind],
    label: b.label,
    sourceName: b.sourceName,
    createdLabel: formatDate(b.createdAt),
    sizeLabel: formatBytes(b.size),
    chunkCount: b.chunkHashes.length,
  }));
}

/** Upload progress, as plain data for the UI to render. */
export function uploadProgressView(
  fileName: string,
  bytesDone: number,
  bytesTotal: number,
  chunksUploaded: number,
  chunksTotal: number,
): { fileName: string; percent: number; detail: string } {
  const percent = bytesTotal > 0 ? Math.round((bytesDone / bytesTotal) * 100) : 100;
  return {
    fileName,
    percent,
    detail: `${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)} — chunk ${chunksUploaded} of ${chunksTotal} encrypted and stored`,
  };
}

// --- drag-and-drop upload ----------------------------------------------
// The drive panel's file-list surface is a drop target. The DOM wiring
// lives in bindDriveDropZone() below; everything else here is pure data
// so it is testable without a browser. The actual upload runs through
// VaultManager.uploadDroppedFiles() (drive.ts) — the one chunk ->
// encrypt -> backend path — never a second upload path.

export const DROP_ZONE_COPY = {
  dragOver: "Drop to upload — files are compressed and encrypted in this app before they leave your device.",
  hint: "Drag files or folders here. Folder structure is kept; identical content is stored once.",
} as const;

export const DROP_UPLOAD_STAGE_LABELS: Record<UploadStage, string> = {
  queued: "Queued",
  chunking: "Compressing & chunking",
  encrypting: "Encrypting",
  uploading: "Uploading",
  done: "Done",
  error: "Failed",
};

export interface DropUploadProgressView {
  fileName: string;
  relativePath: string;
  stage: UploadStage;
  stageLabel: string;
  percent: number;
  detail: string;
  isDone: boolean;
  isError: boolean;
  error?: string;
}

/** One dropped file's progress, as plain data for the UI to render.
 *  Errors are carried in the row itself — a failed file is shown as
 *  failed, never silently dropped from the list. */
export function dropUploadProgressView(progress: UploadProgress): DropUploadProgressView {
  const percent =
    progress.stage === "done"
      ? 100
      : progress.bytesTotal > 0
        ? Math.round((progress.bytesDone / progress.bytesTotal) * 100)
        : 0;
  let detail: string;
  switch (progress.stage) {
    case "queued":
      detail = `Waiting to upload ${formatBytes(progress.bytesTotal)}…`;
      break;
    case "chunking":
      detail = `Compressing ${formatBytes(progress.bytesTotal)}…`;
      break;
    case "encrypting":
      detail = `Encrypting ${progress.chunksTotal} chunk${progress.chunksTotal === 1 ? "" : "s"}…`;
      break;
    case "uploading":
      detail = `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)} — chunk ${progress.chunksDone} of ${progress.chunksTotal} encrypted and stored`;
      break;
    case "done":
      detail = `${formatBytes(progress.bytesTotal)} — ${progress.chunksTotal} chunk${progress.chunksTotal === 1 ? "" : "s"} encrypted and stored${progress.chunksDeduped > 0 ? `, ${progress.chunksDeduped} already stored (deduped)` : ""}`;
      break;
    case "error":
      detail = progress.error ?? "Upload failed.";
      break;
  }
  return {
    fileName: progress.fileName,
    relativePath: progress.relativePath,
    stage: progress.stage,
    stageLabel: DROP_UPLOAD_STAGE_LABELS[progress.stage],
    percent,
    detail,
    isDone: progress.stage === "done",
    isError: progress.stage === "error",
    error: progress.error,
  };
}

/** Tracks every file in one drop, keyed by dropped relative path.
 *  Pure data — the shell feeds it VaultManager progress callbacks and
 *  renders dropUploadListView(). A failed file stays in the list with
 *  its error; it is never removed. */
export class DropUploadTracker {
  private readonly items = new Map<string, UploadProgress>();

  start(relativePath: string, bytesTotal: number): void {
    const name = relativePath.split("/").filter(Boolean).pop() ?? relativePath;
    this.items.set(relativePath, {
      fileName: name,
      relativePath,
      stage: "queued",
      bytesDone: 0,
      bytesTotal,
      chunksDone: 0,
      chunksTotal: 0,
      chunksDeduped: 0,
    });
  }

  /** Feed a VaultManager progress callback straight into the tracker. */
  progressCallback(): (progress: UploadProgress) => void {
    return (progress) => {
      this.items.set(progress.relativePath, { ...progress });
    };
  }

  update(progress: UploadProgress): void {
    this.items.set(progress.relativePath, { ...progress });
  }

  fail(relativePath: string, error: string, bytesTotal = 0): void {
    const existing = this.items.get(relativePath);
    const name = existing?.fileName ?? relativePath.split("/").filter(Boolean).pop() ?? relativePath;
    this.items.set(relativePath, {
      fileName: name,
      relativePath,
      stage: "error",
      bytesDone: existing?.bytesDone ?? 0,
      bytesTotal: existing?.bytesTotal ?? bytesTotal,
      chunksDone: existing?.chunksDone ?? 0,
      chunksTotal: existing?.chunksTotal ?? 0,
      chunksDeduped: existing?.chunksDeduped ?? 0,
      error,
    });
  }

  get(relativePath: string): UploadProgress | undefined {
    const found = this.items.get(relativePath);
    return found ? { ...found } : undefined;
  }

  view(): {
    items: DropUploadProgressView[];
    total: number;
    doneCount: number;
    failedCount: number;
    activeCount: number;
    allDone: boolean;
  } {
    const items = [...this.items.values()].map(dropUploadProgressView);
    const doneCount = items.filter((i) => i.isDone).length;
    const failedCount = items.filter((i) => i.isError).length;
    return {
      items,
      total: items.length,
      doneCount,
      failedCount,
      activeCount: items.length - doneCount - failedCount,
      allDone: items.length > 0 && doneCount + failedCount === items.length,
    };
  }
}

// --- reading a DataTransfer (files + dropped folders) -------------------

/** Minimal structural shape of a browser File / Blob for drop reading.
 *  Structural on purpose: tests pass fakes, the shell passes real Files. */
export interface DroppedFileLike {
  name: string;
  type?: string;
  webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileSystemFileEntryLike {
  isFile: true;
  isDirectory: false;
  name: string;
  fullPath: string;
  file(success: (file: DroppedFileLike) => void, error?: (err: unknown) => void): void;
}

export interface FileSystemDirectoryEntryLike {
  isFile: false;
  isDirectory: true;
  name: string;
  fullPath: string;
  createReader(): {
    readEntries(success: (entries: FileSystemEntryLike[]) => void, error?: (err: unknown) => void): void;
  };
}

export type FileSystemEntryLike = FileSystemFileEntryLike | FileSystemDirectoryEntryLike;

export interface DataTransferItemLike {
  kind: string;
  type?: string;
  getAsFile?: () => DroppedFileLike | null;
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
}

export interface DataTransferLike {
  files?: ArrayLike<DroppedFileLike>;
  items?: ArrayLike<DataTransferItemLike>;
  types?: ArrayLike<string>;
}

/** True when a drag carries files (not just text / a link). The drop
 *  zone only lights up for file drags. */
export function isFileDrag(dataTransfer: Pick<DataTransferLike, "types"> | null | undefined): boolean {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).some((t) => t === "Files");
}

async function readEntryFile(entry: FileSystemFileEntryLike): Promise<DroppedFileLike> {
  return new Promise<DroppedFileLike>((resolve, reject) => {
    entry.file(
      (file) => resolve(file),
      (err) => reject(new Error(`could not read dropped file "${entry.fullPath}": ${String(err)}`)),
    );
  });
}

async function readDirectoryEntries(entry: FileSystemDirectoryEntryLike): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader();
  const all: FileSystemEntryLike[] = [];
  // readEntries() returns batches; keep reading until an empty batch.
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(
        (entries) => resolve(entries),
        (err) => reject(new Error(`could not list dropped folder "${entry.fullPath}": ${String(err)}`)),
      );
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function collectEntry(entry: FileSystemEntryLike, out: DroppedUpload[]): Promise<void> {
  if (entry.isFile) {
    const file = await readEntryFile(entry);
    const bytes = new Uint8Array(await file.arrayBuffer());
    out.push({
      path: entry.fullPath.replace(/^\//, ""),
      data: bytes,
      mime: file.type || undefined,
    });
    return;
  }
  const children = await readDirectoryEntries(entry);
  if (children.length === 0) {
    // An empty dropped folder: keep it as a folder-only entry so the
    // vault creates the folder instead of silently losing it.
    out.push({ path: `${entry.fullPath.replace(/^\//, "")}/`, data: new Uint8Array(0) });
    return;
  }
  for (const child of children) await collectEntry(child, out);
}

/** Turn a drop event's DataTransfer into DroppedUploads. Folder drops
 *  are traversed via webkitGetAsEntry (FileSystemEntry) so relative
 *  paths survive ("Photos/2026/sunset.jpg"); plain file drops fall
 *  back to the files list with webkitRelativePath. The returned bytes
 *  are the raw file bytes — chunking / encryption happen later, in
 *  VaultManager.uploadDroppedFiles(). A file that cannot be read
 *  throws with its name; the caller surfaces it as a failed entry. */
export async function collectDroppedFiles(dataTransfer: DataTransferLike): Promise<DroppedUpload[]> {
  const out: DroppedUpload[] = [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (entry) {
      await collectEntry(entry, out);
      continue;
    }
    const file = item.getAsFile?.() ?? null;
    if (file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      out.push({ path: file.webkitRelativePath || file.name, data: bytes, mime: file.type || undefined });
    }
  }
  if (out.length === 0 && dataTransfer.files) {
    for (const file of Array.from(dataTransfer.files)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      out.push({ path: file.webkitRelativePath || file.name, data: bytes, mime: file.type || undefined });
    }
  }
  return out;
}

export interface DriveDropZoneOptions {
  /** Called with the collected files, in drop order. The caller runs
   *  vault.uploadDroppedFiles(files, parentId, tracker.progressCallback())
   *  and refreshes the file list afterwards. */
  onFiles: (files: DroppedUpload[]) => Promise<void> | void;
  /** A file that could not even be read from the drop, or onFiles
   *  itself, threw. Defaults to a console error — never silent. */
  onError?: (error: Error) => void;
  /** Fired when the drag-over highlight turns on / off. */
  onDragStateChange?: (dragging: boolean) => void;
  /** CSS class added while a file drag hovers the surface. */
  activeClass?: string;
}

/** Wire drag-and-drop upload onto the drive panel's file-list surface.
 *  dragover is prevented (otherwise the browser would navigate to the
 *  dropped file), the surface highlights only for file drags, and drop
 *  collects files/folders and hands them to onFiles. Returns an unbind
 *  function that removes every listener. The coordinator calls this
 *  once per panel mount with the open vault's uploadDroppedFiles. */
export function bindDriveDropZone(element: HTMLElement, options: DriveDropZoneOptions): () => void {
  const activeClass = options.activeClass ?? "drive-drop-active";
  let dragDepth = 0;
  const setDragging = (dragging: boolean): void => {
    if (dragging) {
      element.classList.add(activeClass);
      element.setAttribute("data-drag-over", "true");
    } else {
      element.classList.remove(activeClass);
      element.removeAttribute("data-drag-over");
    }
    options.onDragStateChange?.(dragging);
  };
  const onDragEnter = (event: DragEvent): void => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth++;
    if (dragDepth === 1) setDragging(true);
  };
  const onDragOver = (event: DragEvent): void => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: DragEvent): void => {
    if (dragDepth === 0) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    const transfer = event.dataTransfer;
    if (!transfer) return;
    void (async () => {
      try {
        const files = await collectDroppedFiles(transfer as unknown as DataTransferLike);
        await options.onFiles(files);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (options.onError) options.onError(err);
        else console.error("[ArkDrive] drop upload failed:", err);
      }
    })();
  };
  element.addEventListener("dragenter", onDragEnter);
  element.addEventListener("dragover", onDragOver);
  element.addEventListener("dragleave", onDragLeave);
  element.addEventListener("drop", onDrop);
  return () => {
    element.removeEventListener("dragenter", onDragEnter);
    element.removeEventListener("dragover", onDragOver);
    element.removeEventListener("dragleave", onDragLeave);
    element.removeEventListener("drop", onDrop);
  };
}
