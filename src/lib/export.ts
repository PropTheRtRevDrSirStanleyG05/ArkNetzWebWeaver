// ArkNetzWebWeaver — static HTML export (builder phase).
// One-click export: a site document becomes a portable static site —
// index.html (+ one page per nav entry), style.css, and assets — with
// IA hotlinks preserved, so the export can be dropped on Cloudflare
// Pages, Neocities, Netlify, Apache or Nginx with zero lock-in.
// The .zip is a real ZIP (STORE method, no compression), written by a
// small CRC32 + local-file-header implementation in this file — no new
// dependency, no fake "zip" that is really a folder. A plain folder
// export is also available (exportStaticFiles) for environments where a
// zip download is not wanted.

import { READER_CSS, renderSiteDocument } from "./renderer.js";
import type { SiteDocument } from "./types.js";

export interface ExportFile {
  path: string;
  content: string | Uint8Array;
}

/** All files of the static export. index.html is the document rendered
 *  by the SHARED renderer — the export is exactly what the reader
 *  shows, not a second rendering. */
export function exportStaticFiles(doc: SiteDocument): ExportFile[] {
  const files: ExportFile[] = [];
  const css = `:root{--an-accent:${doc.theme?.accent ?? "#2563eb"};--an-font:${doc.theme?.font ?? "system-ui, sans-serif"}}\n${READER_CSS}`;
  files.push({ path: "style.css", content: css });
  // A real favicon file: without one every browser requests /favicon.ico
  // and logs a 404 console error (Lighthouse best-practices audit).
  files.push({ path: "favicon.svg", content: FAVICON_SVG });
  const page = (title: string, bodyHtml: string, description: string) =>
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="description" content="${escapeXml(description)}">\n<link rel="icon" type="image/svg+xml" href="/favicon.svg">\n<title>${escapeXml(title)}</title>\n<link rel="stylesheet" href="/style.css">\n</head>\n<body>\n<main>\n${bodyHtml}\n</main>\n</body>\n</html>\n`;
  files.push({ path: "index.html", content: page(doc.title, renderSiteDocument(doc), docDescription(doc)) });
  // One static page per extra nav entry (about, blog, …). Each reuses
  // the same header/footer/nav, so the export is a real multi-page site.
  for (const entry of doc.nav ?? []) {
    const slug = entry.href.replace(/^arknetz:\/\/[^/]+\/?/, "").replace(/\/$/, "");
    if (!slug || slug === "index") continue;
    const sub: SiteDocument = { ...doc, title: entry.label, blocks: [{ type: "h1", text: entry.label }] };
    files.push({ path: `${slug}/index.html`, content: page(entry.label, renderSiteDocument(sub), entry.label) });
  }
  return files;
}

/** Meta description for a page, derived from the document's own text:
 *  hero subtitle first, then the first paragraph, then the first
 *  heading — truncated to 160 characters. SiteDocument carries no
 *  description field, so the export derives one rather than emitting
 *  an empty or invented one. */
export function docDescription(doc: SiteDocument): string {
  const candidates: (string | undefined)[] = [];
  for (const b of doc.blocks) {
    if (b.type === "hero") candidates.push(b.subtitle);
    else if (b.type === "p" || b.type === "quote") candidates.push(b.text);
    else if (b.type === "h1" || b.type === "h2" || b.type === "h3") candidates.push(b.text);
  }
  const text = candidates.find((c) => c && c.trim().length > 0)?.trim() ?? doc.title;
  return text.length > 160 ? text.slice(0, 157).trimEnd() + "…" : text;
}

/** Tiny inline SVG favicon (blue rounded square, white "A"). */
export const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2563eb"/><text x="32" y="44" font-family="system-ui,sans-serif" font-size="36" font-weight="bold" fill="#ffffff" text-anchor="middle">A</text></svg>\n`;

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Minimal ZIP writer (STORE, no compression) ---------------------------
// Written here so the export needs no dependency. CRC32 (IEEE) table,
// local file headers, central directory, end-of-central-directory.

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

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export function buildZip(files: ExportFile[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.path);
    const data = toBytes(file.content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filenames
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size = stored size
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(name, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
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

/** The full .zip export for a document. */
export function exportStaticZip(doc: SiteDocument): { filename: string; bytes: Uint8Array; files: string[] } {
  const files = exportStaticFiles(doc);
  return {
    filename: `${doc.domain}.zip`,
    bytes: buildZip(files),
    files: files.map((f) => f.path),
  };
}
