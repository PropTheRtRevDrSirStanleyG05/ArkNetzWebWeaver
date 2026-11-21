// ArkNetzWebWeaver — .arknetz offline site bundles (Phase 3b).
// Thread turn 37: one-click "Save Site Offline" — a single portable
// archive, shareable over USB / Bluetooth / Discord, that opens with
// ZERO internet. Good for airplanes, rural areas, and backups.
//
// Format: a real ZIP container (STORE method, no compression — the same
// hand-written CRC32 + local-file-header approach as export.ts, no new
// dependency), containing:
//   arknetz-manifest.json  — format/version, domain, media cache manifest
//   site.json              — the SiteDocument, verbatim
//   assets/<n>.<ext>       — media bytes cached at pack time
//
// Media that was NOT cached locally at pack time is listed in the
// manifest as "missing" with a plain-English reason — never a silent
// blank. Cached media is referenced inside the rendered page as
// arknetz://offline/<domain>/assets/<file> links: the arknetz: scheme
// already passes the shared renderer's URL allow-list, and the shell
// resolves those links to the bundle's embedded bytes (blob: URLs) at
// open time. Nothing in this module touches the network: opening a
// bundle is pure local parsing.
//
// Validation: magic bytes (PK\x03\x04), manifest presence + version,
// per-file CRC32 hash check against the manifest, site.json parse.
// Every failure throws ArknetzBundleError with a machine-readable code
// and a plain-English message — never a silent blank page.

import { renderSiteDocument } from "../renderer.js";
import type { BlockNode, SiteDocument } from "../types.js";

export const BUNDLE_FORMAT = "arknetz-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_MANIFEST_PATH = "arknetz-manifest.json";
export const BUNDLE_SITE_PATH = "site.json";
export const BUNDLE_EXTENSION = ".arknetz";
/** Media embedded in a bundle is referenced with this scheme so the
 *  shared renderer accepts it (arknetz: passes isSafeUrl). */
export const BUNDLE_MEDIA_SCHEME = "arknetz://offline";

export type BundleErrorCode =
  | "not_a_zip"
  | "not_an_arknetz_bundle"
  | "unsupported_manifest_version"
  | "manifest_corrupt"
  | "site_json_missing"
  | "site_json_corrupt"
  | "crc_mismatch"
  | "compressed_entry_unsupported"
  | "truncated_zip";

export class ArknetzBundleError extends Error {
  readonly code: BundleErrorCode;
  constructor(code: BundleErrorCode, message: string) {
    super(message);
    this.name = "ArknetzBundleError";
    this.code = code;
  }
}

export type BundleMediaStatus = "cached" | "missing";

export interface BundleMediaEntry {
  /** The IA hotlink the site references, e.g. https://archive.org/download/<item>/<file>. */
  hotlink: string;
  /** Path inside the bundle, e.g. "assets/0.webp". Null when missing. */
  path: string | null;
  bytes: number;
  mime: string;
  status: BundleMediaStatus;
  /** Plain-English reason when status is "missing". */
  reason?: string;
  /** CRC32 of the embedded bytes, for the hash check on open. */
  crc32?: number;
}

export interface BundleManifestFile {
  path: string;
  bytes: number;
  crc32: number;
}

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  domain: string;
  title: string;
  createdAt: number; // unix ms
  siteFile: string; // always "site.json"
  media: BundleMediaEntry[];
  files: BundleManifestFile[];
}

export interface OfflineMediaInput {
  hotlink: string;
  /** Bytes when the media was already cached locally; omit when it was
   *  not — the entry is then recorded as missing, with a reason. */
  bytes?: Uint8Array;
  mime: string;
}

export interface PackedBundle {
  filename: string;
  bytes: Uint8Array;
  manifest: BundleManifest;
  cachedCount: number;
  missingCount: number;
  totalBytes: number;
}

export interface OpenedBundle {
  manifest: BundleManifest;
  doc: SiteDocument;
  /** Every file in the bundle by path (manifest, site.json, assets). */
  files: Map<string, Uint8Array>;
  /** Hotlink -> bundle media URL (arknetz://offline/...) for cached media. */
  mediaUrls: Map<string, string>;
  /** Media the bundle does NOT contain, with the reason why. */
  unavailable: Array<{ hotlink: string; reason: string }>;
}

export function bundleMediaUrl(domain: string, assetPath: string): string {
  return `${BUNDLE_MEDIA_SCHEME}/${domain}/${assetPath}`;
}

// --- CRC32 (IEEE) — same table algorithm as export.ts ----------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- Minimal ZIP writer (STORE) + reader ----------------------------------

interface ZipEntry {
  path: string;
  data: Uint8Array;
  crc: number;
}

/** Exported for tests (and for other phases that pack STORE zips). */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 filenames
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Parse a STORE-method ZIP by walking its local file headers. Throws
 *  ArknetzBundleError on anything that is not a readable ZIP. */
export function parseZip(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new ArknetzBundleError(
      "not_a_zip",
      "This file is not a ZIP archive (missing PK\\x03\\x04 magic bytes) — it is not an .arknetz bundle.",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 30 <= bytes.length) {
    const sig = view.getUint32(at, true);
    if (sig === 0x06054b50) break; // end of central directory
    if (sig === 0x02014b50) break; // central directory — local entries done
    if (sig !== 0x04034b50) {
      throw new ArknetzBundleError(
        "truncated_zip",
        `ZIP is truncated or corrupt: expected a local file header at byte ${at}, found something else.`,
      );
    }
    const method = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 14, true);
    const compSize = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const dataStart = at + 30 + nameLen + extraLen;
    if (dataStart + compSize > bytes.length) {
      throw new ArknetzBundleError(
        "truncated_zip",
        "ZIP is truncated: a file's data runs past the end of the archive.",
      );
    }
    if (method !== 0) {
      throw new ArknetzBundleError(
        "compressed_entry_unsupported",
        "This ZIP uses compression (method " + method + "); .arknetz bundles are STORE-only. Re-pack the bundle to open it.",
      );
    }
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.slice(dataStart, dataStart + compSize);
    if (crc32(data) !== crc) {
      throw new ArknetzBundleError(
        "crc_mismatch",
        `File "${name}" inside the archive failed its CRC32 check — the bundle is corrupt.`,
      );
    }
    files.set(name, data);
    at = dataStart + compSize;
  }
  if (files.size === 0) {
    throw new ArknetzBundleError("truncated_zip", "ZIP archive contains no files.");
  }
  return files;
}

// --- Media discovery -------------------------------------------------------

function extensionForMime(mime: string, hotlink: string): string {
  const fromLink = hotlink.split("?")[0]!.split(".").pop() ?? "";
  if (/^[a-z0-9]{2,5}$/i.test(fromLink)) return fromLink.toLowerCase();
  if (mime.includes("webp")) return "webp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("opus")) return "opus";
  if (mime.includes("webm")) return "webm";
  return "bin";
}

/** Every IA hotlink a document references (img/video/audio src + poster),
 *  walked recursively through cols/cards/gallery/items. */
export function collectMediaRefs(doc: SiteDocument): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const visit = (block: BlockNode): void => {
    for (const field of [block.src, block.poster]) {
      if (field && !seen.has(field)) {
        seen.add(field);
        refs.push(field);
      }
    }
    for (const child of block.items ?? []) visit(child);
    for (const col of block.columns ?? []) for (const child of col) visit(child);
  };
  for (const b of [...(doc.header ?? []), ...doc.blocks, ...(doc.footer ?? [])]) visit(b);
  return refs;
}

// --- Pack ------------------------------------------------------------------

/** One-click "Save Site Offline": pack a SiteDocument + its media into a
 *  single portable .arknetz archive. `media` supplies the locally cached
 *  bytes for each hotlink the document references; any hotlink without
 *  bytes is recorded as missing with a reason instead of being dropped
 *  silently. No network is touched here — callers fetch/cache media
 *  beforehand (e.g. via the IndexedDB media cache). */
export function packSiteOffline(doc: SiteDocument, media: OfflineMediaInput[]): PackedBundle {
  const refs = collectMediaRefs(doc);
  const byHotlink = new Map(media.map((m) => [m.hotlink, m]));
  const manifestMedia: BundleMediaEntry[] = [];
  const entries: ZipEntry[] = [];
  let assetIndex = 0;

  for (const hotlink of refs) {
    const input = byHotlink.get(hotlink);
    if (input?.bytes) {
      const path = `assets/${assetIndex}.${extensionForMime(input.mime, hotlink)}`;
      assetIndex++;
      const crc = crc32(input.bytes);
      manifestMedia.push({ hotlink, path, bytes: input.bytes.length, mime: input.mime, status: "cached", crc32: crc });
      entries.push({ path, data: input.bytes, crc });
    } else {
      manifestMedia.push({
        hotlink,
        path: null,
        bytes: 0,
        mime: input?.mime ?? "",
        status: "missing",
        reason: "Not downloaded yet — open the site online once so the media is cached, then save it offline again.",
      });
    }
  }

  const siteJson = new TextEncoder().encode(JSON.stringify(doc));
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    domain: doc.domain,
    title: doc.title,
    createdAt: Date.now(),
    siteFile: BUNDLE_SITE_PATH,
    media: manifestMedia,
    files: [],
  };
  // Manifest lists every file with its CRC32 so openBundle can hash-check.
  const manifestFiles: BundleManifestFile[] = [
    { path: BUNDLE_SITE_PATH, bytes: siteJson.length, crc32: crc32(siteJson) },
    ...entries.map((e) => ({ path: e.path, bytes: e.data.length, crc32: e.crc })),
  ];
  manifest.files = manifestFiles;
  const manifestJson = new TextEncoder().encode(JSON.stringify(manifest));
  const allEntries: ZipEntry[] = [
    { path: BUNDLE_MANIFEST_PATH, data: manifestJson, crc: crc32(manifestJson) },
    { path: BUNDLE_SITE_PATH, data: siteJson, crc: crc32(siteJson) },
    ...entries,
  ];
  const bytes = buildZip(allEntries);
  const cachedCount = manifestMedia.filter((m) => m.status === "cached").length;
  return {
    filename: `${doc.domain}${BUNDLE_EXTENSION}`,
    bytes,
    manifest,
    cachedCount,
    missingCount: manifestMedia.length - cachedCount,
    totalBytes: bytes.length,
  };
}

// --- Open (zero network) ---------------------------------------------------

/** Open a bundle with zero internet: parse + validate locally, return the
 *  document, the embedded media map, and the list of media that is
 *  unavailable (with reasons). Throws ArknetzBundleError on any problem. */
export function openBundle(bytes: Uint8Array): OpenedBundle {
  const files = parseZip(bytes);
  const manifestBytes = files.get(BUNDLE_MANIFEST_PATH);
  if (!manifestBytes) {
    throw new ArknetzBundleError(
      "not_an_arknetz_bundle",
      "This ZIP has no arknetz-manifest.json — it is a plain ZIP, not an .arknetz offline bundle.",
    );
  }
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest;
  } catch {
    throw new ArknetzBundleError("manifest_corrupt", "arknetz-manifest.json is not valid JSON — the bundle is corrupt.");
  }
  if (manifest.format !== BUNDLE_FORMAT) {
    throw new ArknetzBundleError(
      "not_an_arknetz_bundle",
      `Manifest format is "${String((manifest as { format?: unknown }).format ?? "missing")}", not "${BUNDLE_FORMAT}".`,
    );
  }
  if (manifest.version !== BUNDLE_VERSION) {
    throw new ArknetzBundleError(
      "unsupported_manifest_version",
      `Bundle manifest version ${manifest.version} is not supported by this app (supports version ${BUNDLE_VERSION}). Update the app, or re-save the site offline.`,
    );
  }
  // Hash check: every file the manifest lists must be present and match.
  for (const f of manifest.files ?? []) {
    const data = files.get(f.path);
    if (!data) {
      throw new ArknetzBundleError("crc_mismatch", `Bundle is incomplete: manifest lists "${f.path}" but it is missing from the archive.`);
    }
    if (data.length !== f.bytes || crc32(data) !== f.crc32) {
      throw new ArknetzBundleError(
        "crc_mismatch",
        `File "${f.path}" failed its hash check — the bundle is corrupt or was edited after packing.`,
      );
    }
  }
  const siteBytes = files.get(manifest.siteFile ?? BUNDLE_SITE_PATH);
  if (!siteBytes) {
    throw new ArknetzBundleError("site_json_missing", "Bundle has no site.json — the site content is missing.");
  }
  let doc: SiteDocument;
  try {
    doc = JSON.parse(new TextDecoder().decode(siteBytes)) as SiteDocument;
  } catch {
    throw new ArknetzBundleError("site_json_corrupt", "site.json is not valid JSON — the bundle is corrupt.");
  }
  if (!doc || typeof doc.domain !== "string" || !Array.isArray(doc.blocks)) {
    throw new ArknetzBundleError("site_json_corrupt", "site.json is not a valid site document (missing domain or blocks).");
  }

  const mediaUrls = new Map<string, string>();
  const unavailable: Array<{ hotlink: string; reason: string }> = [];
  for (const m of manifest.media ?? []) {
    if (m.status === "cached" && m.path && files.has(m.path)) {
      mediaUrls.set(m.hotlink, bundleMediaUrl(doc.domain, m.path));
    } else {
      unavailable.push({
        hotlink: m.hotlink,
        reason: m.reason ?? "This media was not included in the offline bundle.",
      });
    }
  }
  return { manifest, doc, files, mediaUrls, unavailable };
}

/** Render an opened bundle through the SHARED renderer. Cached media
 *  srcs are swapped to their arknetz://offline/ URLs (the shell resolves
 *  those to the bundle's embedded bytes); media the bundle lacks keeps
 *  its original hotlink, and is listed in `unavailable` with its reason
 *  so the reader sees why it is offline instead of a silent blank. */
export function renderOfflineSite(bundle: OpenedBundle): { html: string; unavailable: Array<{ hotlink: string; reason: string }> } {
  const rewrite = (block: BlockNode): BlockNode => {
    const out: BlockNode = { ...block };
    if (out.src && bundle.mediaUrls.has(out.src)) out.src = bundle.mediaUrls.get(out.src)!;
    if (out.poster && bundle.mediaUrls.has(out.poster)) out.poster = bundle.mediaUrls.get(out.poster)!;
    if (out.items) out.items = out.items.map(rewrite);
    if (out.columns) out.columns = out.columns.map((col) => col.map(rewrite));
    return out;
  };
  const doc: SiteDocument = {
    ...bundle.doc,
    header: (bundle.doc.header ?? []).map(rewrite),
    blocks: bundle.doc.blocks.map(rewrite),
    footer: (bundle.doc.footer ?? []).map(rewrite),
  };
  return { html: renderSiteDocument(doc), unavailable: bundle.unavailable };
}

/** One-line human summary of a bundle, for the Save/Open UI. */
export function bundleSummary(bundle: PackedBundle | OpenedBundle): string {
  const manifest = bundle.manifest;
  const cached = manifest.media.filter((m) => m.status === "cached").length;
  const missing = manifest.media.length - cached;
  const bytes = "totalBytes" in bundle ? bundle.totalBytes : 0;
  return `${manifest.title} (${manifest.domain}) — ${manifest.media.length} media file${manifest.media.length === 1 ? "" : "s"}, ${cached} saved offline${missing > 0 ? `, ${missing} not included (needs internet)` : ""}${bytes ? `, ${(bytes / 1024).toFixed(1)} KB total` : ""}.`;
}
