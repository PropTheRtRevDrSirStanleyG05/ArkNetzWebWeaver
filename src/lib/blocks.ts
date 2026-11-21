// ArkNetzWebWeaver — block registry for the visual builder.
// The whitelist is the single source of truth for which block types a
// document may contain. Anything not on it is rejected at validation
// time and rendered as a visible placeholder by the renderer — never
// silently dropped, never executed as raw HTML/JS.

import type { BlockNode, BlockType, ListItem, SiteDocument, TableCell } from "./types.js";
import {
  applyFormat,
  clearLink,
  isSafeUrl,
  plainText,
  runsFromText,
  setLink,
  syncRunsFromText,
} from "./inline.js";
import type { FormatPatch, InlineRun } from "./inline.js";

export const BLOCK_TYPES: BlockType[] = [
  "hero", "nav", "h1", "h2", "h3", "p", "cols", "cards",
  "series-grid", "img", "video", "audio", "code", "quote", "link",
  "docs-sidebar", "gallery", "app", "list", "table",
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
  list: "List",
  table: "Table",
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
  { keyword: "ul", type: "list", label: "Bulleted list", hint: "Bulleted list — /ol for numbered" },
  { keyword: "ol", type: "list", label: "Numbered list", hint: "Numbered list — /ul for bulleted" },
  { keyword: "list", type: "list", label: "List", hint: "Bulleted or numbered list" },
  { keyword: "table", type: "table", label: "Table", hint: "Table with rows and columns — /table 2x4 for size" },
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
    case "list":
      return { ...base, listStyle: "ul", listItems: makeListItems(["First item", "Second item"]) };
    case "table":
      return { ...base, headerRow: true, rows: makeTableRows(DEFAULT_TABLE_ROWS, DEFAULT_TABLE_COLS, true) };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// List + table helpers (pure, in-place on the block; the caller marks the
// document dirty and re-renders). The editor UI calls these — EditorState
// (editor.ts) only knows insert/move/delete/update, so structure edits
// for lists and tables live here instead of forking the editor.
// ---------------------------------------------------------------------------

/** Deepest nesting a list may have (top-level items are depth 1). */
export const MAX_LIST_DEPTH = 5;
/** Total items (all levels) a list may hold. */
export const MAX_LIST_ITEMS = 1000;
export const MAX_TABLE_ROWS = 20;
export const MAX_TABLE_COLS = 20;
export const DEFAULT_TABLE_ROWS = 3;
export const DEFAULT_TABLE_COLS = 3;

/** List items from plain texts. */
export function makeListItems(texts: string[]): ListItem[] {
  return texts.map((text) => ({ text }));
}

/** A rows×cols table: the first row holds "Header 1..N" when headerRow,
 *  every other cell starts empty. */
export function makeTableRows(rows: number, cols: number, headerRow = true): TableCell[][] {
  const out: TableCell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TableCell[] = [];
    for (let c = 0; c < cols; c++) {
      row.push({ text: r === 0 && headerRow ? `Header ${c + 1}` : "" });
    }
    out.push(row);
  }
  return out;
}

/** Parse a table size from slash-command text: "2x4" -> { rows: 2, cols: 4 }.
 *  Anything else (or out of range) returns null — the caller keeps the
 *  3x3 default. */
export function parseTableSize(text: string): { rows: number; cols: number } | null {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(text.trim());
  if (!m) return null;
  const rows = Number(m[1]);
  const cols = Number(m[2]);
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return null;
  if (rows < 1 || rows > MAX_TABLE_ROWS || cols < 1 || cols > MAX_TABLE_COLS) return null;
  return { rows, cols };
}

/** { rows, cols } of a table block, or null when it has no usable rows. */
export function tableSize(block: BlockNode): { rows: number; cols: number } | null {
  if (!Array.isArray(block.rows) || block.rows.length === 0) return null;
  const first = block.rows[0];
  if (!first || !Array.isArray(first)) return null;
  return { rows: block.rows.length, cols: first.length };
}

/** The list item at an index path, e.g. [1, 0] = the second top-level
 *  item's first child. Undefined when the path does not exist. */
export function getListItem(block: BlockNode, path: number[]): ListItem | undefined {
  let items = block.listItems;
  let item: ListItem | undefined;
  for (const i of path) {
    if (!items) return undefined;
    item = items[i];
    if (!item) return undefined;
    items = item.children;
  }
  return item;
}

/** The array holding the item at `path`, plus its index in it — the
 *  parent array for indent/outdent/insert/remove. */
function listItemParent(block: BlockNode, path: number[]): { items: ListItem[]; index: number } | null {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1] as number;
  if (parentPath.length === 0) {
    if (!Array.isArray(block.listItems)) return null;
    return { items: block.listItems, index };
  }
  const parent = getListItem(block, parentPath);
  if (!parent || !Array.isArray(parent.children)) return null;
  return { items: parent.children, index };
}

function countListItems(items: ListItem[]): number {
  let n = 0;
  for (const item of items) {
    n += 1;
    if (item.children) n += countListItems(item.children);
  }
  return n;
}

/** Inline runs of a list item, deriving them from `text` when the item
 *  has never been formatted — the same derivation EditorState uses for
 *  text blocks. */
function itemRuns(item: ListItem): InlineRun[] {
  if (item.runs && item.runs.length > 0) return item.runs;
  return runsFromText(item.text ?? "");
}

function setItemRuns(item: ListItem, runs: InlineRun[]): void {
  item.text = plainText(runs);
  item.runs = runs.length > 0 && runs.some((r) => r.format !== undefined) ? runs : undefined;
}

function cellRuns(cell: TableCell): InlineRun[] {
  if (cell.runs && cell.runs.length > 0) return cell.runs;
  return runsFromText(cell.text ?? "");
}

function setCellRuns(cell: TableCell, runs: InlineRun[]): void {
  cell.text = plainText(runs);
  cell.runs = runs.length > 0 && runs.some((r) => r.format !== undefined) ? runs : undefined;
}

/** Retype a list item's text, keeping its inline formatting per
 *  character position (same rule as typing in a text block). */
export function setListItemText(block: BlockNode, path: number[], text: string): boolean {
  const item = getListItem(block, path);
  if (!item) return false;
  setItemRuns(item, syncRunsFromText(itemRuns(item), text));
  return true;
}

/** Format the character range [start, end) of a list item — bold,
 *  italic, underline, strikethrough, inline code, or a link via
 *  patch.href. Toggle flips a mark when the whole range has it. False
 *  when the item does not exist or has no text to format. */
export function formatListItem(
  block: BlockNode,
  path: number[],
  start: number,
  end: number,
  patch: FormatPatch,
  mode: "set" | "toggle" = "set",
): boolean {
  const item = getListItem(block, path);
  if (!item) return false;
  if (!item.text && !(item.runs && item.runs.length > 0)) return false;
  const runs = applyFormat(itemRuns(item), start, end, patch, mode);
  if (plainText(runs) !== (item.text ?? "")) return false;
  setItemRuns(item, runs);
  return true;
}

/** Link the character range [start, end) of a list item. Unsafe hrefs
 *  are refused (isSafeUrl) and the item is left unchanged. */
export function setListItemLink(block: BlockNode, path: number[], start: number, end: number, href: string): boolean {
  if (!isSafeUrl(href)) return false;
  const item = getListItem(block, path);
  if (!item) return false;
  const runs = setLink(itemRuns(item), start, end, href);
  if (plainText(runs) !== (item.text ?? "")) return false;
  setItemRuns(item, runs);
  return true;
}

export function clearListItemLink(block: BlockNode, path: number[], start: number, end: number): boolean {
  const item = getListItem(block, path);
  if (!item) return false;
  setItemRuns(item, clearLink(itemRuns(item), start, end));
  return true;
}

/** Indent: the item becomes the last child of its previous sibling.
 *  False at the first item of a level, or at the depth cap. */
export function indentListItem(block: BlockNode, path: number[]): boolean {
  if (path.length >= MAX_LIST_DEPTH) return false;
  const slot = listItemParent(block, path);
  if (!slot || slot.index <= 0) return false;
  const item = slot.items[slot.index];
  const prev = slot.items[slot.index - 1];
  if (!item || !prev) return false;
  slot.items.splice(slot.index, 1);
  prev.children = [...(prev.children ?? []), item];
  return true;
}

/** Outdent: the item moves up one level, right after its parent.
 *  False for top-level items. Children move with the item. */
export function outdentListItem(block: BlockNode, path: number[]): boolean {
  if (path.length < 2) return false;
  const slot = listItemParent(block, path);
  if (!slot) return false;
  const item = slot.items[slot.index];
  if (!item) return false;
  const parentPath = path.slice(0, -1);
  const parentIndex = parentPath[parentPath.length - 1] as number;
  const grand = listItemParent(block, parentPath);
  if (!grand) return false;
  slot.items.splice(slot.index, 1);
  grand.items.splice(parentIndex + 1, 0, item);
  return true;
}

/** Append an item at the end of the top level. */
export function appendListItem(block: BlockNode, text = "New item"): boolean {
  if (block.type !== "list" || !Array.isArray(block.listItems)) return false;
  if (countListItems(block.listItems) >= MAX_LIST_ITEMS) return false;
  block.listItems.push({ text });
  return true;
}

/** Insert an item right after the item at `path`, on the same level. */
export function insertListItem(block: BlockNode, path: number[], text = "New item"): boolean {
  const slot = listItemParent(block, path);
  if (!slot) return false;
  if (!Array.isArray(block.listItems)) return false;
  if (countListItems(block.listItems) >= MAX_LIST_ITEMS) return false;
  slot.items.splice(slot.index + 1, 0, { text });
  return true;
}

/** Remove the item at `path`. The last item of the whole list is kept —
 *  a list never becomes empty through the UI. */
export function removeListItem(block: BlockNode, path: number[]): boolean {
  const slot = listItemParent(block, path);
  if (!slot) return false;
  if (!slot.items[slot.index]) return false;
  if (path.length === 1 && slot.items.length <= 1) return false;
  slot.items.splice(slot.index, 1);
  return true;
}

/** The cell at (row, col), or undefined when out of range. */
export function getTableCell(block: BlockNode, row: number, col: number): TableCell | undefined {
  return block.rows?.[row]?.[col];
}

/** Retype a table cell, keeping its inline formatting per character
 *  position. */
export function setTableCellText(block: BlockNode, row: number, col: number, text: string): boolean {
  const cell = getTableCell(block, row, col);
  if (!cell) return false;
  setCellRuns(cell, syncRunsFromText(cellRuns(cell), text));
  return true;
}

/** Format the character range [start, end) of a table cell. */
export function formatTableCell(
  block: BlockNode,
  row: number,
  col: number,
  start: number,
  end: number,
  patch: FormatPatch,
  mode: "set" | "toggle" = "set",
): boolean {
  const cell = getTableCell(block, row, col);
  if (!cell) return false;
  if (!cell.text && !(cell.runs && cell.runs.length > 0)) return false;
  const runs = applyFormat(cellRuns(cell), start, end, patch, mode);
  if (plainText(runs) !== (cell.text ?? "")) return false;
  setCellRuns(cell, runs);
  return true;
}

/** Link the character range [start, end) of a table cell. Unsafe hrefs
 *  are refused (isSafeUrl) and the cell is left unchanged. */
export function setTableCellLink(block: BlockNode, row: number, col: number, start: number, end: number, href: string): boolean {
  if (!isSafeUrl(href)) return false;
  const cell = getTableCell(block, row, col);
  if (!cell) return false;
  const runs = setLink(cellRuns(cell), start, end, href);
  if (plainText(runs) !== (cell.text ?? "")) return false;
  setCellRuns(cell, runs);
  return true;
}

export function clearTableCellLink(block: BlockNode, row: number, col: number, start: number, end: number): boolean {
  const cell = getTableCell(block, row, col);
  if (!cell) return false;
  setCellRuns(cell, clearLink(cellRuns(cell), start, end));
  return true;
}

/** Append an empty row at the bottom. False at the row cap. */
export function addTableRow(block: BlockNode): boolean {
  const size = tableSize(block);
  if (!size || !block.rows) return false;
  if (size.rows >= MAX_TABLE_ROWS) return false;
  block.rows.push(Array.from({ length: size.cols }, () => ({ text: "" }) as TableCell));
  return true;
}

/** Remove the last row. The last row is kept — a table never becomes
 *  rowless through the UI. */
export function removeTableRow(block: BlockNode): boolean {
  const size = tableSize(block);
  if (!size || !block.rows || size.rows <= 1) return false;
  block.rows.pop();
  return true;
}

/** Append an empty column at the right. A new header cell is labelled
 *  "Header N" when the table has a header row. False at the column cap. */
export function addTableColumn(block: BlockNode): boolean {
  const size = tableSize(block);
  if (!size || !block.rows) return false;
  if (size.cols >= MAX_TABLE_COLS) return false;
  const header = block.headerRow !== false;
  for (const [r, row] of block.rows.entries()) {
    row.push({ text: r === 0 && header ? `Header ${size.cols + 1}` : "" });
  }
  return true;
}

/** Remove the last column. The last column is kept. */
export function removeTableColumn(block: BlockNode): boolean {
  const size = tableSize(block);
  if (!size || !block.rows || size.cols <= 1) return false;
  for (const row of block.rows) row.pop();
  return true;
}

/** Flip the header row on/off. Absent headerRow counts as on, so the
 *  first toggle turns it off. */
export function toggleTableHeader(block: BlockNode): boolean {
  if (block.type !== "table") return false;
  block.headerRow = block.headerRow === false ? true : false;
  return true;
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
    problems.push(...validateRuns(block.runs, block.text, path));
  }
  if (block.type === "list") problems.push(...validateList(block, path));
  if (block.type === "table") problems.push(...validateTable(block, path));
  for (const child of block.items ?? []) problems.push(...validateBlock(child, `${path}.items`));
  for (const col of block.columns ?? []) {
    for (const child of col) problems.push(...validateBlock(child, `${path}.columns`));
  }
  return problems;
}

/** Shared inline-runs validation, for a block's own runs and for list
 *  items / table cells. `path` is the owning block/item/cell path; run
 *  problems are reported under `${path}.runs[i]`, exactly as before. */
function validateRuns(runs: unknown, text: string | undefined, path: string): string[] {
  const problems: string[] = [];
  if (!Array.isArray(runs)) {
    problems.push(`${path}: runs is not an array`);
    return problems;
  }
  for (const [i, run] of (runs as InlineRun[]).entries()) {
    if (!run || typeof run !== "object") {
      problems.push(`${path}.runs[${i}]: not an object`);
      continue;
    }
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
  if (text !== undefined && plainText(runs as InlineRun[]) !== text) {
    problems.push(`${path}: runs and text disagree — text must equal plainText(runs)`);
  }
  return problems;
}

function validateList(block: BlockNode, path: string): string[] {
  const problems: string[] = [];
  if (block.listStyle !== undefined && block.listStyle !== "ul" && block.listStyle !== "ol") {
    problems.push(`${path}: listStyle must be "ul" or "ol", got ${JSON.stringify(block.listStyle)}`);
  }
  if (!Array.isArray(block.listItems)) {
    problems.push(`${path}: list block has no listItems array`);
    return problems;
  }
  if (countListItems(block.listItems) > MAX_LIST_ITEMS) {
    problems.push(`${path}: list has more than ${MAX_LIST_ITEMS} items`);
  }
  problems.push(...validateListItems(block.listItems, path, 1));
  return problems;
}

function validateListItems(items: ListItem[], path: string, depth: number): string[] {
  const problems: string[] = [];
  if (depth > MAX_LIST_DEPTH) {
    problems.push(`${path}: list nesting exceeds ${MAX_LIST_DEPTH} levels`);
    return problems;
  }
  for (const [i, item] of items.entries()) {
    const p = `${path}.listItems[${i}]`;
    if (!item || typeof item !== "object") {
      problems.push(`${p}: not an object`);
      continue;
    }
    if (item.text !== undefined && typeof item.text !== "string") problems.push(`${p}: text is not a string`);
    if (item.runs !== undefined) problems.push(...validateRuns(item.runs, item.text, p));
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) {
        problems.push(`${p}: children is not an array`);
      } else {
        problems.push(...validateListItems(item.children, p, depth + 1));
      }
    }
  }
  return problems;
}

function validateTable(block: BlockNode, path: string): string[] {
  const problems: string[] = [];
  if (block.headerRow !== undefined && typeof block.headerRow !== "boolean") {
    problems.push(`${path}: headerRow is not a boolean`);
  }
  if (block.caption !== undefined && typeof block.caption !== "string") {
    problems.push(`${path}: caption is not a string`);
  }
  if (!Array.isArray(block.rows)) {
    problems.push(`${path}: table block has no rows array`);
    return problems;
  }
  if (block.rows.length === 0) problems.push(`${path}: table has no rows`);
  if (block.rows.length > MAX_TABLE_ROWS) {
    problems.push(`${path}: table has more than ${MAX_TABLE_ROWS} rows`);
  }
  let width: number | null = null;
  for (const [r, row] of (block.rows as TableCell[][]).entries()) {
    const rp = `${path}.rows[${r}]`;
    if (!Array.isArray(row)) {
      problems.push(`${rp}: not an array`);
      continue;
    }
    if (row.length === 0) problems.push(`${rp}: row has no cells`);
    if (row.length > MAX_TABLE_COLS) {
      problems.push(`${rp}: row has more than ${MAX_TABLE_COLS} cells`);
    }
    if (width === null) width = row.length;
    else if (row.length !== width) {
      problems.push(`${rp}: row has ${row.length} cells, expected ${width} — rows must be rectangular`);
    }
    for (const [c, cell] of row.entries()) {
      const cp = `${rp}[${c}]`;
      if (!cell || typeof cell !== "object") {
        problems.push(`${cp}: not an object`);
        continue;
      }
      if (cell.text !== undefined && typeof cell.text !== "string") {
        problems.push(`${cp}: text is not a string`);
      }
      if (cell.runs !== undefined) problems.push(...validateRuns(cell.runs, cell.text, cp));
    }
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
