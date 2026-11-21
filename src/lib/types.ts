// ArkNetzWebWeaver — protocol types (thread turns 19, 39, 42, 45).
// These are the wire formats. They are versioned by PROTOCOL_VERSION in
// config.ts and documented in PROTOCOL.md (to be published with the
// arknetz-protocol repo). Zstd compression (.json.zst) happens at the
// transport layer; these types describe the decompressed JSON.
// Minimal in this shell: only what the reader + registry resolution need.
// Mail / teams / ArkDrive types follow in later phases — do NOT add them
// here until their phase lands.

/** One entry in a registry shard. `shard` is the first hex digit of
 *  SHA256(domain) — clients compute it, never trust a server to. */
export interface RegistryEntry {
  domain: string;
  /** e.g. "gh:alice/arknetz-site-computers-edu" */
  backend: string;
  /** Mirror backends, tried in order after `backend`. */
  mirrors?: string[];
  shard: string; // "0".."f" (16 shards) — "00".."ff" when expanded to 256
  owner: string; // GitHub login that owns the site repo
  updated?: number; // unix seconds
  /** Delegated subdomains live in the site repo, not here. */
  delegations?: Record<string, string>;
}

export type BlockType =
  | "hero"
  | "nav"
  | "h1"
  | "h2"
  | "h3"
  | "p"
  | "cols"
  | "cards"
  | "series-grid"
  | "img"
  | "video"
  | "audio"
  | "code"
  | "quote"
  | "link"
  | "docs-sidebar"
  | "gallery"
  | "app"
  | "list"
  | "table";

import type { InlineRun } from "./inline.js";

/** One item of a "list" block. Items carry typed inline runs (same
 *  formatting as text blocks: bold/italic/links) and nest via
 *  `children` — a list is at least 2 levels deep. `text` is always kept
 *  in sync with plainText(runs), exactly like BlockNode text/runs. */
export interface ListItem {
  text?: string;
  runs?: InlineRun[];
  children?: ListItem[];
}

/** One cell of a "table" block. Typed inline runs, like a list item —
 *  never raw HTML. `text` is always kept in sync with
 *  plainText(runs). */
export interface TableCell {
  text?: string;
  runs?: InlineRun[];
}

/** A semantic block. No raw HTML/JS is ever allowed in a block — the
 *  renderer whitelists these types and escapes all text. `["app", ...]`
 *  blocks are rendered only as a sandboxed iframe (see renderer.ts). */
export interface BlockNode {
  type: BlockType;
  text?: string;
  /** Inline rich-text runs (bold/italic/underline/strike/code/links).
   *  Present on text blocks (h1-h3, p, quote, link text) when the user
   *  formatted part of the text. `text` is always kept in sync with
   *  plainText(runs); when runs are absent the block is plain text. */
  runs?: InlineRun[];
  src?: string; // IA hotlink, e.g. https://archive.org/download/<item>/<file>
  alt?: string;
  href?: string;
  title?: string;
  subtitle?: string;
  language?: string;
  items?: BlockNode[];
  columns?: BlockNode[][];
  /** For "app": the sandboxed bundle URL or inline srcdoc, max ~150 KB. */
  appSrc?: string;
  appSrcdoc?: string;
  /** Per-block responsive visibility (Gutenberg-style). Absent = visible
   *  everywhere. A block listed only on "desktop" is hidden on tablet
   *  and mobile, and vice versa. */
  visibleOn?: Array<"desktop" | "tablet" | "mobile">;
  /** "list": "ul" (bulleted) or "ol" (numbered). Absent = "ul". */
  listStyle?: "ul" | "ol";
  /** "list": the items, nested via ListItem.children. */
  listItems?: ListItem[];
  /** "table": rows of cells; every row has the same length. */
  rows?: TableCell[][];
  /** "table": the first row renders as <th scope="col">. Absent = true. */
  headerRow?: boolean;
  /** Image focal point, 0-100 on each axis (percent). */
  focalPoint?: { x: number; y: number };
  /** "Mark as decorative" (Gutenberg): alt is empty, screen readers skip it. */
  decorative?: boolean;
  /** Figcaption text (defaults to alt when absent). */
  caption?: string;
  /** Video poster hotlink. */
  poster?: string;
  /** Unique id, assigned by the editor. Absent in hand-written docs. */
  id?: string;
}

export interface SiteTheme {
  layout?: "docs" | "blog" | "magazine" | "portfolio" | string;
  accent?: string;
  font?: string;
}

export interface SiteDocument {
  domain: string;
  title: string;
  theme?: SiteTheme;
  nav?: { label: string; href: string }[];
  header?: BlockNode[];
  footer?: BlockNode[];
  blocks: BlockNode[];
  /** Sub-pages, keyed by path slug ("about" for
   *  arknetz://domain/about). A nav entry points at a sub-page; the
   *  reader renders pages[slug] when it exists and falls back to the
   *  root document when it does not. The static export emits one file
   *  per nav entry from the same map. Absent = a single-page site
   *  (the pre-0.4.1 shape) — old documents load unchanged. Sub-pages
   *  are read-only in the editor for now: editing one could publish
   *  it as the site root, so the Edit toggle is disabled on them. */
  pages?: Record<string, SiteDocument>;
  version?: string;
  updated?: number;
}

export interface ProtocolManifest {
  protocolVersion: string;
  defaultRootRepo: string;
  masterGithubUser: string;
  registryShards: string[]; // repo names, e.g. arknetz-registry-00..0f
  contactsShards: string[];
  mirrors?: string[];
  /** Directory categories published by the protocol root (fix round 3,
   *  item 4): each name is a per-category directory repo
   *  `arknetz-directory-<name>` holding `directory-<name>.json.zst`.
   *  Absent = the documented default (see
   *  DEFAULT_DIRECTORY_CATEGORIES). Clients must read this field
   *  instead of hardcoding the list, so a new category appears in
   *  search as soon as the Root Master publishes it. */
  directoryCategories?: string[];
}

/** Documented default category list (thread turn 37 + REPO-TOPOLOGY.md
 *  §8 examples). Used ONLY as a fallback when a manifest carries no
 *  `directoryCategories` field. New categories get their own
 *  arknetz-directory-<name> repo; the Root Master adds the name to the
 *  protocol-root manifest instead of changing this list. */
export const DEFAULT_DIRECTORY_CATEGORIES: string[] = ["tech", "cinema", "games"];

/** True for a valid directory category slug: lowercase, segments of
 *  letters/digits separated by single hyphens. */
export function isValidDirectoryCategory(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/** Stealth IA media: what the post stores after an upload. The post
 *  NEVER stores a local path or a GitHub binary — only this hotlink. */
export interface AttachedMedia {
  /** https://archive.org/download/<item>/<file> */
  hotlink: string;
  item: string;
  file: string;
  mime: string;
  bytes: number;
  /** Local blob: URL while uploading; cleared once the hotlink lands. */
  localPreviewUrl?: string;
  status: "uploading" | "ready" | "failed" | "ia_not_linked";
  thumbnailHotlink?: string;
}

export function isValidDomain(domain: string): boolean {
  // Exact full strings only (thread: never whole TLDs). Lowercase,
  // dot-separated labels, no leading/trailing dot or hyphen.
  if (!domain || domain.length > 253) return false;
  if (domain !== domain.toLowerCase()) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  return labels.every(
    (l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l) && l.length <= 63,
  );
}

/** Theme preset (builder phase). Values become CSS Custom Properties. */
export interface ThemePreset {
  id: string;
  name: string;
  accent: string;
  font: string;
  background: string;
  foreground: string;
  muted: string;
}

/** Granular team role flags (thread turn 39, final list). */
export type RoleFlag =
  | "pages.draft"
  | "pages.publish"
  | "allowed_paths"
  | "apps.embed"
  | "media.upload"
  | "subdomains.manage"
  | "moderation.sub"
  | "comments.moderate"
  | "mail.read"
  | "mail.send"
  | "stats.view"
  | "team.manage";

export interface TeamRole {
  name: string;
  flags: RoleFlag[];
  /** Path globs the role may edit, e.g. ["blog/*"]. Absent = all paths. */
  allowedPaths?: string[];
}

/** One saved revision of a document. */
export interface Revision {
  id: string;
  label: string;
  createdAt: number;
  document: SiteDocument;
}
