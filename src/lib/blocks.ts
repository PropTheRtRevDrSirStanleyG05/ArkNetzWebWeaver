// ArkNetzWebWeaver — block registry for the visual builder.
// The whitelist is the single source of truth for which block types a
// document may contain. Anything not on it is rejected at validation
// time and rendered as a visible placeholder by the renderer — never
// silently dropped, never executed as raw HTML/JS.

import type { BlockNode, BlockType, SiteDocument } from "./types.js";
import { isSafeUrl, plainText } from "./inline.js";

export const BLOCK_TYPES: BlockType[] = [
  "hero", "nav", "h1", "h2", "h3", "p", "cols", "cards",
  "series-grid", "img", "video", "audio", "code", "quote", "link",
  "docs-sidebar", "gallery", "app",
];

const BLOCK_LABELS: Record<BlockType, string> = {
  hero: "Hero",
  nav: "Navigation",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  p: "Paragraph",
  cols: "Columns",
  cards: "Cards",
  "series-grid": "Series grid",
  img: "Image",
  video: "Video",
  audio: "Audio",
  code: "Code",
  quote: "Quote",
  link: "Link",
  "docs-sidebar": "Docs sidebar",
  gallery: "Gallery",
  app: "HTML app / game (sandboxed)",
};

export function blockLabel(type: BlockType): string {
  return BLOCK_LABELS[type] ?? type;
}

export function isBlockType(s: string): s is BlockType {
  return (BLOCK_TYPES as string[]).includes(s);
}

/** Slash-command catalogue: what "/" offers, in order. */
export interface SlashCommand {
  keyword: string;
  type: BlockType;
  label: string;
  hint: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { keyword: "h1", type: "h1", label: "Heading 1", hint: "Large section heading" },
  { keyword: "h2", type: "h2", label: "Heading 2", hint: "Section heading" },
  { keyword: "h3", type: "h3", label: "Heading 3", hint: "Sub-heading" },
  { keyword: "p", type: "p", label: "Paragraph", hint: "Plain text" },
  { keyword: "text", type: "p", label: "Paragraph", hint: "Plain text" },
  { keyword: "hero", type: "hero", label: "Hero", hint: "Title + subtitle banner" },
  { keyword: "quote", type: "quote", label: "Quote", hint: "Block quote" },
  { keyword: "code", type: "code", label: "Code", hint: "Preformatted code block" },
  { keyword: "image", type: "img", label: "Image", hint: "Image from the Internet Archive" },
  { keyword: "img", type: "img", label: "Image", hint: "Image from the Internet Archive" },
  { keyword: "video", type: "video", label: "Video", hint: "Video from the Internet Archive" },
  { keyword: "audio", type: "audio", label: "Audio", hint: "Audio from the Internet Archive" },
  { keyword: "cols", type: "cols", label: "Columns", hint: "Two-column layout" },
  { keyword: "columns", type: "cols", label: "Columns", hint: "Two-column layout" },
  { keyword: "cards", type: "cards", label: "Cards", hint: "Grid of cards" },
  { keyword: "gallery", type: "gallery", label: "Gallery", hint: "Grid of images" },
  { keyword: "series", type: "series-grid", label: "Series grid", hint: "Streaming series grid" },
  { keyword: "link", type: "link", label: "Link", hint: "Link to a site or page" },
  { keyword: "nav", type: "nav", label: "Navigation", hint: "Navigation menu" },
  { keyword: "app", type: "app", label: "HTML app / game", hint: "Sandboxed iframe, max ~150 KB" },
  { keyword: "docs", type: "docs-sidebar", label: "Docs sidebar", hint: "Documentation sidebar" },
];

/** Parse a "/" command line: "/h2 My title" -> { type: "h2", text: "My title" }.
 *  Returns null when the text is not a slash command. */
export function parseSlashCommand(line: string): { type: BlockType; text: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const space = rest.search(/\s/);
  const keyword = (space === -1 ? rest : rest.slice(0, space)).toLowerCase();
  const text = space === -1 ? "" : rest.slice(space + 1).trim();
  const cmd = SLASH_COMMANDS.find((c) => c.keyword === keyword);
  if (!cmd) return null;
  return { type: cmd.type, text };
}

/** Commands matching a partial query (for the slash menu). Empty query
 *  returns the whole catalogue. One entry per block type: "/p" and
 *  "/text" are both Paragraph, "/image" and "/img" both Image — the
 *  menu must never list the same block twice (P1). The extra keywords
 *  stay valid for parsing (parseSlashCommand still accepts "/text"),
 *  they just do not get a second menu row. */
export function slashSuggestions(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  return SLASH_COMMANDS.filter((c) => {
    if (q && !c.keyword.includes(q) && !c.label.toLowerCase().includes(q)) return false;
    if (seen.has(c.type)) return false;
    seen.add(c.type);
    return true;
  });
}

let blockCounter = 0;
export function newBlockId(): string {
  blockCounter += 1;
  return `b-${Date.now().toString(36)}-${blockCounter}`;
}

/** A fresh block of a type, with editor-friendly defaults. */
export function defaultBlock(type: BlockType): BlockNode {
  const base: BlockNode = { type, id: newBlockId() };
  switch (type) {
    case "hero":
      return { ...base, title: "New section", subtitle: "A subtitle for this section." };
    case "h1":
      return { ...base, text: "Heading 1" };
    case "h2":
      return { ...base, text: "Heading 2" };
    case "h3":
      return { ...base, text: "Heading 3" };
    case "p":
      return { ...base, text: "Start writing…" };
    case "quote":
      return { ...base, text: "A quote." };
    case "code":
      return { ...base, language: "text", text: "// code" };
    case "link":
      return { ...base, text: "Link text", href: "arknetz://welcome.arknetz" };
    case "nav":
      return { ...base, items: [{ type: "link", text: "Home", href: "arknetz://welcome.arknetz" }] };
    case "cols":
      return { ...base, columns: [[{ type: "p", text: "Left column" }], [{ type: "p", text: "Right column" }]] };
    case "cards":
      return { ...base, items: [{ type: "h3", text: "Card one" }, { type: "p", text: "Card text." }] };
    case "series-grid":
      return { ...base, title: "Series", items: [] };
    case "img":
      return { ...base, src: "", alt: "" };
    case "video":
      return { ...base, src: "" };
    case "audio":
      return { ...base, src: "" };
    case "docs-sidebar":
      return { ...base, items: [{ type: "link", text: "Getting started", href: "arknetz://welcome.arknetz" }] };
    case "gallery":
      return { ...base, items: [] };
    case "app":
      return { ...base, appSrcdoc: "<!doctype html><p>Hello from a sandboxed app.</p>" };
    default:
      return base;
  }
}

/** Validate a block tree against the whitelist. Returns the list of
 *  problems; an empty list means the block is safe to store/render. */
export function validateBlock(block: BlockNode, path = "blocks[0]"): string[] {
  const problems: string[] = [];
  if (!block || typeof block !== "object") return [`${path}: not an object`];
  if (!isBlockType(block.type)) {
    problems.push(`${path}: unknown block type ${JSON.stringify((block as BlockNode).type)}`);
    return problems;
  }
  if (block.appSrcdoc && block.appSrcdoc.length > 150 * 1024) {
    problems.push(`${path}: app block exceeds the ~150 KB cap (${block.appSrcdoc.length} bytes)`);
  }
  if (block.appSrc && block.appSrcdoc) {
    problems.push(`${path}: app block must have appSrc or appSrcdoc, not both`);
  }
  if (block.runs !== undefined) {
    if (!Array.isArray(block.runs)) {
      problems.push(`${path}: runs is not an array`);
    } else {
      for (const [i, run] of block.runs.entries()) {
        if (typeof run.text !== "string") problems.push(`${path}.runs[${i}]: text is not a string`);
        if (run.format !== undefined) {
          for (const key of ["bold", "italic", "underline", "strike", "code"] as const) {
            if (run.format[key] !== undefined && typeof run.format[key] !== "boolean") {
              problems.push(`${path}.runs[${i}]: format.${key} is not a boolean`);
            }
          }
          if (run.format.href !== undefined && !isSafeUrl(run.format.href)) {
            problems.push(`${path}.runs[${i}]: unsafe link href ${JSON.stringify(run.format.href)}`);
          }
        }
      }
      if (block.text !== undefined && plainText(block.runs) !== block.text) {
        problems.push(`${path}: runs and text disagree — text must equal plainText(runs)`);
      }
    }
  }
  for (const child of block.items ?? []) problems.push(...validateBlock(child, `${path}.items`));
  for (const col of block.columns ?? []) {
    for (const child of col) problems.push(...validateBlock(child, `${path}.columns`));
  }
  return problems;
}

export function validateDocument(doc: SiteDocument): string[] {
  const problems: string[] = [];
  if (!doc || typeof doc !== "object") return ["document: not an object"];
  if (!doc.domain) problems.push("document: missing domain");
  if (!doc.title) problems.push("document: missing title");
  for (const section of [doc.header ?? [], doc.blocks, doc.footer ?? []]) {
    section.forEach((b, i) => problems.push(...validateBlock(b, `blocks[${i}]`)));
  }
  return problems;
}
