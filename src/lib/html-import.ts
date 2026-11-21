// ArkNetzWebWeaver — HTML importer (Stanley, 2026-11-21).
// One-click import: an HTML file (or a fetched HTML page) becomes a
// SiteDocument of typed semantic blocks. Content carries over, code
// does not: NO raw HTML ever survives — every block is a whitelisted
// BlockNode, every URL is allow-listed the same way the renderer
// allow-lists it (inline.ts isSafeUrl), and anything dropped or unsafe
// is counted in the result (skipped / skippedByReason), never silently
// swallowed.
//
// Differences from the WordPress importer (wxr.ts), deliberately:
//   - wxr.ts wraps <script>/<iframe> into sandboxed "app" blocks so
//     nothing is lost. This importer STRIPS them (script, style,
//     iframe, object, embed, form controls, event handlers,
//     javascript: URLs) and counts each one as skipped: an imported
//     HTML page is a document, not an app bundle, and its scripts
//     must never be re-hosted, sandboxed or otherwise.
//   - wxr.ts flattens <ul>/<ol> into "• …" paragraphs. This importer
//     emits real "list" blocks (nested lists stay nested, via
//     ListItem.children) and real "table" blocks (thead/tbody/th
//     honoured, first row as header when it uses <th>).
//
// The list/table shape follows types.ts (ListItem / TableCell,
// BlockNode.listStyle / listItems / rows / headerRow), which the
// sibling list/table agent landed while this module was being
// written (2026-11-21 ~12:49 UTC): the importer emits the native
// shape, validateDocument() accepts it, and the shared renderer
// renders it — no cast, no pending dependency. One renderer
// limitation to know: nested list children render with the parent
// list's tag, so a nested <ol> inside a <ul> keeps its structure
// but renders bulleted.

import { MAX_LIST_DEPTH, MAX_LIST_ITEMS, MAX_TABLE_COLS, MAX_TABLE_ROWS, newBlockId } from "./blocks.js";
import { isSafeUrl, normalizeRuns, plainText } from "./inline.js";
import type { InlineFormat, InlineRun } from "./inline.js";
import type { BlockNode, ListItem, SiteDocument, TableCell } from "./types.js";

/** Default cap on blocks per import. Large pages stop here; the cap
 *  and the number of blocks left out are reported in plain language
 *  in the result notes, and the left-out blocks are counted as
 *  skipped. Override with opts.maxBlocks. */
export const DEFAULT_MAX_BLOCKS = 500;

/** Data: image URLs longer than this are treated as unsafe (a page
 *  should not smuggle megabytes of base64 into one block). */
export const MAX_DATA_URL_CHARS = 512_000;

export interface HtmlImportOptions {
  /** Domain for the new document. Default "imported.arknetz". */
  domain?: string;
  /** Fallback title when the page has no <title> and no <h1>. */
  title?: string;
  /** Base URL for resolving relative links/images (e.g. the fetched
   *  page's URL). Without one, relative URLs are unsafe and skipped. */
  baseUrl?: string;
  /** Maximum blocks in the document. Default DEFAULT_MAX_BLOCKS. */
  maxBlocks?: number;
  /** When true (default), the first <h1> becomes a "hero" block
   *  instead of a plain "h1" block. Set false to keep every <h1>. */
  hero?: boolean;
}

export interface HtmlImportResult {
  doc: SiteDocument;
  /** Blocks in doc.blocks. */
  imported: number;
  /** Dropped elements + unsafe URLs + blocks cut by the cap. */
  skipped: number;
  /** skipped broken down by reason, e.g. { script: 1, unsafeImageSrc: 2 }. */
  skippedByReason: Record<string, number>;
  /** Plain-language notes: empty input, the block cap, fetch failures. */
  notes: string[];
  /** Set by importHtmlFromUrl: the URL the HTML was fetched from. */
  sourceUrl?: string;
}

/** Minimal fetch result shape. Accepts the global fetch Response and
 *  the small stub objects tests inject; a plain string is also
 *  accepted (a fetch function that already returns the body). */
export type HtmlFetchFn = (
  url: string,
) => Promise<
  | string
  | { ok: boolean; status: number; text: () => Promise<string> }
  | { ok?: boolean; status?: number; text: () => Promise<string> }
>;

// ---------------------------------------------------------------------------
// Hand-rolled HTML parser (tolerant: never throws on malformed input)
// ---------------------------------------------------------------------------

interface HtmlNode {
  tag: string; // lowercased element name, or "#text"
  attrs: Record<string, string>;
  children: HtmlNode[];
  text?: string; // text nodes only
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Phrasing (inline) elements: they may not contain block content,
 *  so opening a block element closes any open ones first. */
const PHRASING_TAGS = new Set([
  "a", "strong", "b", "em", "i", "u", "s", "strike", "del", "ins",
  "code", "span", "mark", "small", "abbr", "sub", "sup", "q", "cite",
  "time", "kbd", "samp", "var", "font",
]);

/** Elements whose content is raw text up to the matching close tag —
 *  tags inside them are NOT parsed (so "<script><p>" cannot leak a
 *  paragraph out of a script). */
const RAW_TEXT_TAGS = new Set(["script", "style", "title", "textarea"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—",
  ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", times: "×", divide: "÷", plusmn: "±",
  deg: "°", micro: "µ", para: "¶", middot: "·", bull: "•",
  dagger: "†", Dagger: "‡", permil: "‰", euro: "€", pound: "£",
  yen: "¥", cent: "¢", curren: "¤", sect: "§", uml: "¨",
  ordf: "ª", ordm: "º", iexcl: "¡", iquest: "¿", szlig: "ß",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä",
  aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é",
  ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î",
  iuml: "ï", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô",
  otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù", uacute: "ú",
  ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä",
  Aring: "Å", AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É",
  Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î",
  Iuml: "Ï", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô",
  Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú",
  Ucirc: "Û", Uuml: "Ü", Yacute: "Ý",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : whole;
    }
    if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function parseAttrs(inner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of inner.matchAll(re)) {
    const name = (m[1] as string).toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Parse HTML into a tiny tree. Unclosed tags auto-close at EOF,
 *  mismatched close tags are ignored, stray text is kept — the
 *  result is always a usable tree, never an exception. */
export function parseHtmlTree(source: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlNode[] = [root];
  const top = (): HtmlNode => stack[stack.length - 1] as HtmlNode;
  const len = source.length;
  let i = 0;

  const pushText = (raw: string): void => {
    if (!raw) return;
    top().children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(raw) });
  };

  while (i < len) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      pushText(source.slice(i));
      break;
    }
    if (lt > i) pushText(source.slice(i, lt));
    // Comments, doctype / declarations, processing instructions.
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const end = source.indexOf(">", lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }
    const next = source[lt + 1] ?? "";
    if (!/[a-zA-Z/]/.test(next)) {
      // A stray "<" that starts no tag is literal text.
      pushText("<");
      i = lt + 1;
      continue;
    }
    const gt = source.indexOf(">", lt + 1);
    if (gt === -1) {
      pushText(source.slice(lt));
      break;
    }
    const rawTag = source.slice(lt + 1, gt);
    const closing = rawTag.startsWith("/");
    const body = closing ? rawTag.slice(1) : rawTag;
    const nameMatch = body.match(/^\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!nameMatch) {
      i = gt + 1;
      continue;
    }
    const tag = (nameMatch[1] as string).toLowerCase();
    if (closing) {
      // Pop up to the matching open element; a close tag with no
      // open match is ignored (malformed HTML, not an error).
      for (let s = stack.length - 1; s > 0; s--) {
        if ((stack[s] as HtmlNode).tag === tag) {
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }
    const selfClosing = /\/\s*$/.test(rawTag) || VOID_TAGS.has(tag);
    const attrs = parseAttrs(body.slice((nameMatch[1] as string).length));
    // HTML's implicit closes: a block element (or a heading) closes
    // an open <p>, heading, or phrasing element (<b>, <a>, <span>,
    // …), a new <li> closes the previous one, and so on — without
    // this, "<ul><li>One<li>Two</ul>" nests every item inside the
    // first, "<h1>Title<p>Text" swallows the paragraph into the
    // heading, and "<p>Text <b>bold <p>More" swallows the second
    // paragraph (and everything after it) into the first. Only
    // phrasing / p / heading tops are popped: a nested <ul> inside
    // an <li> still stays inside that <li>.
    if (!selfClosing) {
      const popCloses = (tags: Set<string>): void => {
        while (
          stack.length > 1
          && (tags.has(top().tag) || PHRASING_TAGS.has(top().tag))
        ) stack.pop();
      };
      const BLOCK_CLOSES_P = new Set([
        "p", "div", "section", "article", "main", "header", "footer",
        "aside", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol",
        "table", "blockquote", "pre", "figure", "hr", "dl", "form",
        "fieldset", "address",
      ]);
      if (BLOCK_CLOSES_P.has(tag)) {
        popCloses(new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]));
      }
      if (tag === "li") popCloses(new Set(["li"]));
      // A new row also closes any open cell of the previous row:
      // "<tr><th>Name<th>Value<tr><td>Alpha" must not nest the
      // second row inside the last cell of the first.
      if (tag === "tr") popCloses(new Set(["tr", "td", "th"]));
      if (tag === "td" || tag === "th") popCloses(new Set(["td", "th"]));
      if (tag === "option") popCloses(new Set(["option"]));
    }
    const node: HtmlNode = { tag, attrs, children: [] };
    top().children.push(node);
    if (RAW_TEXT_TAGS.has(tag)) {
      // Raw text up to the matching close tag (case-insensitive).
      // With no close tag (malformed HTML), take text only up to the
      // next "<" and resume parsing there — otherwise an unclosed
      // <title> would swallow the whole rest of the document.
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = source.slice(gt + 1);
      const m = closeRe.exec(rest);
      let inner: string;
      if (m) {
        inner = rest.slice(0, m.index);
        i = gt + 1 + m.index + m[0].length;
      } else {
        const nextLt = rest.indexOf("<");
        inner = nextLt === -1 ? rest : rest.slice(0, nextLt);
        i = nextLt === -1 ? len : gt + 1 + nextLt;
      }
      if (inner) {
        node.children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(inner) });
      }
      continue;
    }
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

function textContent(node: HtmlNode): string {
  if (node.tag === "#text") return node.text ?? "";
  return node.children.map(textContent).join("");
}

/** Collapse whitespace runs to one space and trim — for titles,
 *  headings, table cells and other plain-text fields. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** Elements dropped whole (subtree included, counted once each).
 *  Scripts, styles, embeds and form controls are content-free for a
 *  document import: their text is UI/code, not article content. */
const DROPPED_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input",
  "select", "textarea", "button", "noscript", "svg", "canvas",
  "template", "link", "meta", "base", "title", "head",
]);

const INLINE_TAGS = new Set([
  "a", "strong", "b", "em", "i", "u", "s", "strike", "del", "ins",
  "code", "span", "mark", "small", "abbr", "sub", "sup", "br", "q",
  "cite", "time", "kbd", "samp", "var", "font",
]);

const BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table", "pre",
  "code", "blockquote", "figure", "img", "video", "audio", "a", "nav",
  "aside", "div", "section", "article", "main", "header", "footer",
  "dl", "dt", "dd", "address", "figcaption", "hr", "details",
  "summary",
]);

interface ImportCtx {
  baseUrl?: string;
  heroEnabled: boolean;
  heroUsed: boolean;
  heroTitle?: string;
  /** Text of the first heading of any level, for the doc title when
   *  there is no <title> and no hero (e.g. hero:false). */
  firstHeading?: string;
  titleTag?: string;
  ogTitle?: string;
  metaDescription?: string;
  docNav?: { label: string; href: string }[];
  navConsumed: boolean;
  skippedByReason: Record<string, number>;
  notes: string[];
}

function countSkipped(ctx: ImportCtx, reason: string, n = 1): void {
  ctx.skippedByReason[reason] = (ctx.skippedByReason[reason] ?? 0) + n;
}

/** Count dropped elements inside <head> (a <style> or <script> there
 *  is dropped just like one in the body, so it counts too).
 *  <title> and <meta> are NOT counted: they are consumed as the
 *  document title / description / og:title. */
function countHeadDropped(root: HtmlNode, ctx: ImportCtx): void {
  const findHead = (node: HtmlNode): HtmlNode | null => {
    if (node.tag === "head") return node;
    for (const child of node.children) {
      const found = findHead(child);
      if (found) return found;
    }
    return null;
  };
  const head = findHead(root);
  if (!head) return;
  const walk = (node: HtmlNode): void => {
    if (node.tag === "#text") return;
    if (node.tag === "title" || node.tag === "meta") return;
    if (DROPPED_TAGS.has(node.tag)) {
      countSkipped(ctx, node.tag);
      return;
    }
    for (const name of Object.keys(node.attrs)) {
      if (name.startsWith("on")) countSkipped(ctx, "eventHandlerAttribute");
    }
    for (const child of node.children) walk(child);
  };
  for (const child of head.children) walk(child);
}

/** Images nested directly inside a heading / quote are not inline
 *  content — emit them as image blocks after the text block, so a
 *  safe one survives and an unsafe one is counted, never silently
 *  dropped. (runsFromInline skips <img>; without this they would
 *  vanish without a count.) */
function pushChildImages(node: HtmlNode, out: BlockNode[], ctx: ImportCtx): void {
  for (const img of node.children.filter((c) => c.tag === "img")) {
    const b = convertImg(img, ctx);
    if (b) out.push(b);
  }
}
/** Count everything the conversion will strip before it runs, so the
 *  count is complete even for elements the converter never visits:
 *  one count per dropped element (its subtree is not descended into,
 *  so inner controls are not double-counted) and one count per
 *  event-handler attribute (on*) on a kept element. Style attributes
 *  are also stripped by construction (no attribute except src/alt/
 *  href/class is ever copied) but are not counted: they carry no
 *  behaviour once the tag is gone. */
function countDroppedAndHandlers(nodes: HtmlNode[], ctx: ImportCtx): void {
  for (const node of nodes) {
    if (node.tag === "#text") continue;
    if (DROPPED_TAGS.has(node.tag)) {
      countSkipped(ctx, node.tag);
      continue;
    }
    for (const name of Object.keys(node.attrs)) {
      if (name.startsWith("on")) countSkipped(ctx, "eventHandlerAttribute");
    }
    countDroppedAndHandlers(node.children, ctx);
  }
}

/** Resolve a URL against the base URL (when one was given). Returns
 *  null for relative URLs with no base, fragments and unparseable
 *  values — the caller counts those as unsafe. */
function resolveUrl(raw: string, ctx: ImportCtx): string | null {
  const href = raw.trim();
  if (!href) return null;
  if (/^(javascript|vbscript|data):/i.test(href)) return null;
  try {
    const u = ctx.baseUrl ? new URL(href, ctx.baseUrl) : new URL(href);
    return u.href;
  } catch {
    return null;
  }
}

/** A link href is safe exactly when the renderer would render it:
 *  isSafeUrl (https: to archive.org / raw.githubusercontent.com /
 *  github.com, or arknetz:). */
function safeHref(raw: string | undefined, ctx: ImportCtx): string | null {
  if (raw === undefined) return null;
  const resolved = resolveUrl(raw, ctx);
  if (!resolved) return null;
  return isSafeUrl(resolved) ? resolved : null;
}

/** An image src is safe when the renderer would render it, plus
 *  data:image/* (png/jpeg/gif/webp, base64) — the import allow-list
 *  in the brief. NOTE: the renderer itself (isSafeUrl) does not
 *  accept data: URLs yet, so a data: image block renders as
 *  "[image blocked: unsafe source]" until the renderer allows it;
 *  the block is still emitted, with its real bytes, rather than
 *  dropping the image. SVG data: URLs are never allowed (they can
 *  carry scripts). */
function safeImageSrc(raw: string | undefined, ctx: ImportCtx): string | null {
  if (raw === undefined) return null;
  const src = raw.trim();
  if (!src) return null;
  if (src.startsWith("data:")) {
    if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src)
      && src.length <= MAX_DATA_URL_CHARS) {
      return src;
    }
    return null;
  }
  const resolved = resolveUrl(src, ctx);
  if (!resolved) return null;
  return isSafeUrl(resolved) ? resolved : null;
}

function safeMediaSrc(raw: string | undefined, ctx: ImportCtx): string | null {
  if (raw === undefined) return null;
  const resolved = resolveUrl(raw, ctx);
  if (!resolved) return null;
  return isSafeUrl(resolved) ? resolved : null;
}

function makeListItem(runs: InlineRun[]): ListItem {
  const text = plainText(runs);
  const hasFormat = runs.some((r) => r.format !== undefined);
  return hasFormat ? { text, runs } : { text };
}

function countListItemsDeep(items: ListItem[]): number {
  let n = 0;
  for (const item of items) {
    n += 1;
    if (item.children) n += countListItemsDeep(item.children);
  }
  return n;
}

/** Items of one <ul>/<ol>, at the given nesting depth (top level =
 *  1). A nested list becomes the parent item's `children`, so
 *  nesting survives in the native ListItem shape. */
function convertListItems(node: HtmlNode, ctx: ImportCtx, depth: number): ListItem[] {
  const items: ListItem[] = [];
  for (const li of node.children.filter((c) => c.tag === "li")) {
    const nested = li.children.filter((c) => c.tag === "ul" || c.tag === "ol");
    const inlineKids = li.children.filter((c) => c.tag !== "ul" && c.tag !== "ol" && c.tag !== "img");
    const runs = finishRuns(collectRuns(inlineKids, ctx));
    const text = plainText(runs);
    // A ListItem cannot hold an image: counted, never silently dropped.
    const imgCount = li.children.filter((c) => c.tag === "img").length;
    if (imgCount > 0) countSkipped(ctx, "imageInListItem", imgCount);
    if (!text && nested.length === 0) continue;
    const item = makeListItem(runs);
    if (nested.length > 0) {
      if (depth >= MAX_LIST_DEPTH) {
        // Deeper than the block allows (validateBlock): count the
        // items instead of emitting an invalid list.
        let dropped = 0;
        for (const sub of nested) dropped += sub.children.filter((c) => c.tag === "li").length;
        if (dropped > 0) countSkipped(ctx, "listTooDeep", dropped);
      } else {
        const children: ListItem[] = [];
        for (const sub of nested) children.push(...convertListItems(sub, ctx, depth + 1));
        if (children.length > 0) item.children = children;
      }
    }
    items.push(item);
  }
  return items;
}

function convertList(node: HtmlNode, ctx: ImportCtx): BlockNode | null {
  const listItems = convertListItems(node, ctx, 1);
  if (listItems.length === 0) return null;
  // Total-item cap (validateBlock): drop whole trailing top-level
  // items until the list fits, counting what was left out.
  while (countListItemsDeep(listItems) > MAX_LIST_ITEMS && listItems.length > 0) {
    const dropped = listItems.pop() as ListItem;
    countSkipped(ctx, "listTruncated", countListItemsDeep([dropped]));
  }
  if (listItems.length === 0) return null;
  return {
    type: "list",
    listStyle: node.tag === "ol" ? "ol" : "ul",
    listItems,
    id: newBlockId(),
  };
}

function makeTableCell(node: HtmlNode, ctx: ImportCtx): TableCell {
  // Images cannot live in a cell: counted, never silently dropped.
  const imgCount = findDescendants(node, "img").length;
  if (imgCount > 0) countSkipped(ctx, "imageInTableCell", imgCount);
  const runs = finishRuns(collectRuns(node.children, ctx));
  const text = plainText(runs);
  const hasFormat = runs.some((r) => r.format !== undefined);
  return hasFormat ? { text, runs } : { text };
}

function convertTable(node: HtmlNode, ctx: ImportCtx): BlockNode | null {
  let caption: string | undefined;
  const trs: { tr: HtmlNode; inThead: boolean }[] = [];
  const collectRows = (n: HtmlNode, inThead: boolean): void => {
    for (const child of n.children) {
      if (child.tag === "tr") trs.push({ tr: child, inThead });
      else if (child.tag === "thead") collectRows(child, true);
      else if (child.tag === "tbody" || child.tag === "tfoot") collectRows(child, false);
      else if (child.tag === "caption") caption = collapse(textContent(child)) || undefined;
    }
  };
  collectRows(node, false);
  let rows: TableCell[][] = [];
  let headerRow = false;
  let emitted = 0;
  for (const { tr, inThead } of trs) {
    const cells = tr.children.filter((c) => c.tag === "td" || c.tag === "th");
    if (cells.length === 0) continue;
    const hasTh = cells.some((c) => c.tag === "th");
    if (emitted === 0 && (hasTh || inThead)) headerRow = true;
    emitted += 1;
    rows.push(cells.map((c) => makeTableCell(c, ctx)));
  }
  if (rows.length === 0) return null;
  // Rectangular, within the caps (validateBlock): pad short rows,
  // drop rows past MAX_TABLE_ROWS and cells past MAX_TABLE_COLS,
  // counting what was left out.
  let width = Math.max(...rows.map((r) => r.length));
  if (width > MAX_TABLE_COLS) {
    let droppedCells = 0;
    rows = rows.map((r) => {
      if (r.length > MAX_TABLE_COLS) {
        droppedCells += r.length - MAX_TABLE_COLS;
        return r.slice(0, MAX_TABLE_COLS);
      }
      return r;
    });
    width = MAX_TABLE_COLS;
    if (droppedCells > 0) countSkipped(ctx, "truncatedTableCells", droppedCells);
  }
  rows = rows.map((r) => {
    while (r.length < width) r.push({ text: "" });
    return r;
  });
  if (rows.length > MAX_TABLE_ROWS) {
    countSkipped(ctx, "truncatedTableRows", rows.length - MAX_TABLE_ROWS);
    rows = rows.slice(0, MAX_TABLE_ROWS);
  }
  const block: BlockNode = { type: "table", rows, headerRow, id: newBlockId() };
  if (caption) block.caption = caption;
  return block;
}

function makeTextBlock(type: BlockType, runs: InlineRun[], text: string): BlockNode {
  const hasFormat = runs.some((r) => r.format !== undefined);
  const block: BlockNode = { type, text, id: newBlockId() };
  if (hasFormat) block.runs = runs;
  return block;
}

type BlockType = BlockNode["type"];

/** Build runs for an inline node (text or an inline element),
 *  carrying the surrounding format. Unknown inline tags are
 *  transparent — their text survives, the tag does not. */
function runsFromInline(node: HtmlNode, fmt: InlineFormat, ctx: ImportCtx): InlineRun[] {
  if (node.tag === "#text") {
    const text = (node.text ?? "").replace(/\s+/g, " ");
    return text ? [{ text, format: { ...fmt } }] : [];
  }
  if (DROPPED_TAGS.has(node.tag)) return [];
  if (node.tag === "br") return [{ text: "\n", format: { ...fmt } }];
  if (node.tag === "img") return []; // handled at block level, not inline
  const next: InlineFormat = { ...fmt };
  switch (node.tag) {
    case "strong":
    case "b":
      next.bold = true;
      break;
    case "em":
    case "i":
      next.italic = true;
      break;
    case "u":
    case "ins":
      next.underline = true;
      break;
    case "s":
    case "strike":
    case "del":
      next.strike = true;
      break;
    case "code":
      next.code = true;
      break;
    case "a": {
      const href = safeHref(node.attrs["href"], ctx);
      if (href) {
        next.href = href;
      } else if (node.attrs["href"] !== undefined) {
        countSkipped(ctx, "unsafeLinkHref");
      }
      break;
    }
    default:
      break; // any other tag: transparent, format unchanged
  }
  const out: InlineRun[] = [];
  for (const child of node.children) out.push(...runsFromInline(child, next, ctx));
  return out;
}

function collectRuns(nodes: HtmlNode[], ctx: ImportCtx): InlineRun[] {
  const out: InlineRun[] = [];
  for (const node of nodes) out.push(...runsFromInline(node, {}, ctx));
  return out;
}

/** Normalise runs, then trim the leading space of the first run and
 *  the trailing space of the last, so plainText(runs) equals the
 *  block's text exactly (validateBlock requires this). */
function finishRuns(runs: InlineRun[]): InlineRun[] {
  const norm = normalizeRuns(runs);
  if (norm.length === 0) return norm;
  const first = norm[0] as InlineRun;
  first.text = first.text.replace(/^\s+/, "");
  const last = norm[norm.length - 1] as InlineRun;
  last.text = last.text.replace(/\s+$/, "");
  return normalizeRuns(norm.filter((r) => r.text.length > 0));
}

function containsBlock(node: HtmlNode): boolean {
  for (const child of node.children) {
    if (BLOCK_TAGS.has(child.tag)) return true;
    if (containsBlock(child)) return true;
  }
  return false;
}

function findDescendants(node: HtmlNode, tag: string, out: HtmlNode[] = []): HtmlNode[] {
  for (const child of node.children) {
    if (child.tag === tag) out.push(child);
    else findDescendants(child, tag, out);
  }
  return out;
}

function convertImg(node: HtmlNode, ctx: ImportCtx): BlockNode | null {
  const raw = node.attrs["src"];
  if (raw === undefined || !raw.trim()) {
    countSkipped(ctx, "missingImageSrc");
    return null;
  }
  const src = safeImageSrc(raw, ctx);
  if (!src) {
    countSkipped(ctx, "unsafeImageSrc");
    return null;
  }
  const block: BlockNode = { type: "img", src, alt: node.attrs["alt"] ?? "", id: newBlockId() };
  return block;
}

function navLinkItems(node: HtmlNode, ctx: ImportCtx): BlockNode[] {
  const items: BlockNode[] = [];
  for (const a of findDescendants(node, "a")) {
    const text = collapse(textContent(a));
    if (!text) continue;
    const href = safeHref(a.attrs["href"], ctx);
    if (!href) {
      if (a.attrs["href"] !== undefined) countSkipped(ctx, "unsafeLinkHref");
      continue;
    }
    items.push({ type: "link", text, href, id: newBlockId() });
  }
  return items;
}

function isDocsNav(node: HtmlNode): boolean {
  const hay = `${node.attrs["class"] ?? ""} ${node.attrs["id"] ?? ""} ${node.attrs["aria-label"] ?? ""}`;
  return /sidebar|docs|toc|contents/i.test(hay);
}

function convertBlock(node: HtmlNode, out: BlockNode[], ctx: ImportCtx): void {
  switch (node.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const runs = finishRuns(collectRuns(node.children, ctx));
      const text = plainText(runs);
      if (!text) return;
      if (ctx.firstHeading === undefined) ctx.firstHeading = text;
      if (node.tag === "h1" && ctx.heroEnabled && !ctx.heroUsed) {
        ctx.heroUsed = true;
        ctx.heroTitle = text;
        const hero: BlockNode = { type: "hero", title: text, id: newBlockId() };
        if (ctx.metaDescription) hero.subtitle = ctx.metaDescription;
        out.push(hero);
        pushChildImages(node, out, ctx);
        return;
      }
      const type: BlockType = node.tag === "h1" ? "h1" : node.tag === "h2" ? "h2" : "h3";
      out.push(makeTextBlock(type, runs, text));
      pushChildImages(node, out, ctx);
      return;
    }
    case "p":
    case "dt":
    case "dd":
    case "address":
    case "figcaption": {
      const elementKids = node.children.filter((c) => c.tag !== "#text");
      const hasText = node.children.some(
        (c) => c.tag === "#text" && (c.text ?? "").trim().length > 0,
      );
      // Images inside the paragraph are image blocks, not inline
      // content: text first (if any), then each image, so a safe one
      // survives and an unsafe one is counted.
      const imgKids = elementKids.filter((c) => c.tag === "img");
      if (imgKids.length > 0) {
        const runs = finishRuns(collectRuns(node.children, ctx));
        const text = plainText(runs);
        if (text) out.push(makeTextBlock("p", runs, text));
        for (const img of imgKids) {
          const b = convertImg(img, ctx);
          if (b) out.push(b);
        }
        return;
      }
      // A paragraph that is just one link is a link block. When the
      // href is unsafe, fall through to the plain-paragraph path
      // below — it counts the unsafe href exactly once (via
      // runsFromInline), so do NOT count it here as well.
      if (!hasText && elementKids.length === 1 && (elementKids[0] as HtmlNode).tag === "a") {
        const a = elementKids[0] as HtmlNode;
        const text = collapse(textContent(a));
        const href = safeHref(a.attrs["href"], ctx);
        if (text && href) {
          out.push({ type: "link", text, href, id: newBlockId() });
          return;
        }
      }
      const runs = finishRuns(collectRuns(node.children, ctx));
      const text = plainText(runs);
      if (!text) return;
      const type: BlockType = node.tag === "dt" ? "p" : "p";
      const block = makeTextBlock(type, runs, text);
      if (node.tag === "dt" && !block.runs) {
        block.runs = [{ text, format: { bold: true } }];
      }
      out.push(block);
      return;
    }
    case "ul":
    case "ol": {
      const list = convertList(node, ctx);
      if (list) out.push(list);
      return;
    }
    case "table": {
      const table = convertTable(node, ctx);
      if (table) out.push(table);
      return;
    }
    case "pre":
    case "code": {
      const cls = node.attrs["class"] ?? findDescendants(node, "code")[0]?.attrs["class"] ?? "";
      const lang = cls.match(/(?:language|lang)-([a-z0-9]+)/i)?.[1] ?? "text";
      const text = textContent(node).replace(/^\n/, "").replace(/\n+$/, "");
      if (!text.trim()) return;
      out.push({ type: "code", language: lang, text, id: newBlockId() });
      return;
    }
    case "blockquote": {
      const cite = findDescendants(node, "cite")[0];
      const kids = node.children.filter((c) => c.tag !== "cite");
      const runs = finishRuns(collectRuns(kids, ctx));
      if (cite) {
        const citeText = collapse(textContent(cite));
        if (citeText) runs.push({ text: ` — ${citeText}` });
      }
      const text = plainText(runs);
      if (!text) return;
      out.push(makeTextBlock("quote", runs, text));
      pushChildImages(node, out, ctx);
      return;
    }
    case "figure": {
      const imgs = findDescendants(node, "img");
      if (imgs.length === 0) {
        convertFlow(node.children, out, ctx);
        return;
      }
      const caption = findDescendants(node, "figcaption")[0];
      const captionText = caption ? collapse(textContent(caption)) : undefined;
      for (const [idx, img] of imgs.entries()) {
        const b = convertImg(img, ctx);
        if (!b) continue;
        if (idx === 0 && captionText) b.caption = captionText;
        out.push(b);
      }
      return;
    }
    case "img": {
      const b = convertImg(node, ctx);
      if (b) out.push(b);
      return;
    }
    case "video":
    case "audio": {
      const raw = node.attrs["src"]
        ?? findDescendants(node, "source")[0]?.attrs["src"];
      if (raw === undefined || !raw.trim()) {
        countSkipped(ctx, "missingMediaSrc");
        return;
      }
      const src = safeMediaSrc(raw, ctx);
      if (!src) {
        countSkipped(ctx, "unsafeMediaSrc");
        return;
      }
      const block: BlockNode = { type: node.tag, src, id: newBlockId() };
      if (node.tag === "video") {
        const poster = safeMediaSrc(node.attrs["poster"], ctx);
        if (poster) block.poster = poster;
      }
      out.push(block);
      return;
    }
    case "a": {
      const text = collapse(textContent(node));
      if (!text) return;
      const href = safeHref(node.attrs["href"], ctx);
      if (href) {
        out.push({ type: "link", text, href, id: newBlockId() });
      } else {
        if (node.attrs["href"] !== undefined) countSkipped(ctx, "unsafeLinkHref");
        const runs = finishRuns(collectRuns(node.children, ctx));
        const plain = plainText(runs);
        if (plain) out.push(makeTextBlock("p", runs, plain));
      }
      return;
    }
    case "nav":
    case "aside": {
      const items = navLinkItems(node, ctx);
      if (items.length === 0) {
        if (node.tag === "aside") convertFlow(node.children, out, ctx);
        return;
      }
      if (isDocsNav(node)) {
        out.push({ type: "docs-sidebar", items, id: newBlockId() });
        return;
      }
      if (node.tag === "nav" && !ctx.navConsumed) {
        ctx.navConsumed = true;
        ctx.docNav = items.map((i) => ({ label: i.text ?? "", href: i.href ?? "" }));
        return;
      }
      if (node.tag === "aside") {
        out.push({ type: "docs-sidebar", items, id: newBlockId() });
        return;
      }
      out.push({ type: "nav", items, id: newBlockId() });
      return;
    }
    case "div":
    case "section": {
      const cls = node.attrs["class"] ?? "";
      if (/gallery/i.test(cls)) {
        const items: BlockNode[] = [];
        for (const img of findDescendants(node, "img")) {
          const b = convertImg(img, ctx);
          if (b) items.push(b);
        }
        if (items.length > 0) {
          out.push({ type: "gallery", items, id: newBlockId() });
          return;
        }
        return;
      }
      convertFlow(node.children, out, ctx);
      return;
    }
    case "article":
    case "main":
    case "header":
    case "footer":
    case "details":
    case "dl": {
      convertFlow(node.children, out, ctx);
      return;
    }
    case "summary": {
      const runs = finishRuns(collectRuns(node.children, ctx));
      const text = plainText(runs);
      if (text) out.push(makeTextBlock("h3", runs, text));
      return;
    }
    case "hr":
      return;
    default:
      convertFlow(node.children, out, ctx);
      return;
  }
}

/** Convert a run of sibling nodes. Inline content accumulates into
 *  one paragraph; a block element flushes it first. */
function convertFlow(nodes: HtmlNode[], out: BlockNode[], ctx: ImportCtx): void {
  let pending: InlineRun[] = [];
  const flush = (): void => {
    const runs = finishRuns(pending);
    pending = [];
    const text = plainText(runs);
    if (text) out.push(makeTextBlock("p", runs, text));
  };
  for (const node of nodes) {
    if (node.tag === "#text") {
      pending.push(...runsFromInline(node, {}, ctx));
      continue;
    }
    if (DROPPED_TAGS.has(node.tag)) continue; // already counted
    if (node.tag === "img") {
      flush();
      const b = convertImg(node, ctx);
      if (b) out.push(b);
      continue;
    }
    if (INLINE_TAGS.has(node.tag)) {
      pending.push(...runsFromInline(node, {}, ctx));
      continue;
    }
    if (BLOCK_TAGS.has(node.tag)) {
      flush();
      convertBlock(node, out, ctx);
      continue;
    }
    // Unknown tag: keep its content, drop the tag itself. Blockish
    // content flows as blocks, inline content joins the paragraph.
    if (containsBlock(node)) {
      flush();
      convertFlow(node.children, out, ctx);
    } else {
      pending.push(...runsFromInline(node, {}, ctx));
    }
  }
  flush();
}

/** <title>, <meta name="description"> and og:title, wherever they
 *  sit in the (possibly malformed) tree. */
function extractHead(root: HtmlNode, ctx: ImportCtx): void {
  const walk = (node: HtmlNode): void => {
    if (node.tag === "title" && ctx.titleTag === undefined) {
      ctx.titleTag = collapse(textContent(node)) || undefined;
    }
    if (node.tag === "meta") {
      const name = (node.attrs["name"] ?? "").toLowerCase();
      const prop = (node.attrs["property"] ?? "").toLowerCase();
      if (name === "description" && ctx.metaDescription === undefined) {
        ctx.metaDescription = collapse(node.attrs["content"] ?? "").slice(0, 200) || undefined;
      }
      if (prop === "og:title" && ctx.ogTitle === undefined) {
        ctx.ogTitle = collapse(node.attrs["content"] ?? "") || undefined;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
}

function findBody(node: HtmlNode): HtmlNode | null {
  if (node.tag === "body") return node;
  for (const child of node.children) {
    const found = findBody(child);
    if (found) return found;
  }
  return null;
}

function bodyChildren(root: HtmlNode): HtmlNode[] {
  const body = findBody(root);
  if (body) return body.children;
  // No <body>: the document is a fragment — use everything except
  // the head (and unwrap a lone <html> the same way).
  const out: HtmlNode[] = [];
  for (const child of root.children) {
    if (child.tag === "head") continue;
    if (child.tag === "html") {
      out.push(...child.children.filter((c) => c.tag !== "head"));
    } else {
      out.push(child);
    }
  }
  return out;
}

function emptyDocument(domain: string, title: string): SiteDocument {
  return {
    domain,
    title,
    theme: { layout: "blog", accent: "#2563eb", font: "system-ui" },
    nav: [{ label: "Home", href: `arknetz://${domain}` }],
    blocks: [],
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Import an HTML string (file contents) into a SiteDocument.
 * Never throws for string input: malformed HTML degrades gracefully,
 * and an unexpected failure degrades to an empty document with a
 * note (skipped counts the failure). Never touches the network —
 * use importHtmlFromUrl for a fetched page.
 */
export function importHtml(source: string, opts: HtmlImportOptions = {}): HtmlImportResult {
  const domain = opts.domain ?? "imported.arknetz";
  const fallbackTitle = opts.title ?? "Imported HTML";
  try {
    const html = typeof source === "string" ? source : "";
    const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
    const ctx: ImportCtx = {
      baseUrl: opts.baseUrl,
      heroEnabled: opts.hero !== false,
      heroUsed: false,
      navConsumed: false,
      skippedByReason: {},
      notes: [],
    };
    const root = parseHtmlTree(html);
    extractHead(root, ctx);
    countHeadDropped(root, ctx);
    const nodes = bodyChildren(root);
    countDroppedAndHandlers(nodes, ctx);
    const blocks: BlockNode[] = [];
    convertFlow(nodes, blocks, ctx);

    if (blocks.length > maxBlocks) {
      const leftOut = blocks.length - maxBlocks;
      blocks.length = maxBlocks;
      countSkipped(ctx, "truncatedBlocks", leftOut);
      ctx.notes.push(
        `Stopped after ${maxBlocks} blocks — the page had more content than the ${maxBlocks}-block import limit, so ${leftOut} block${leftOut === 1 ? " was" : "s were"} left out. Raise maxBlocks to import more.`,
      );
    }

    const skipped = Object.values(ctx.skippedByReason).reduce((a, b) => a + b, 0);
    const title = ctx.titleTag ?? ctx.heroTitle ?? ctx.firstHeading ?? ctx.ogTitle ?? fallbackTitle;
    const hasDocsSidebar = blocks.some((b) => b.type === "docs-sidebar");
    const doc: SiteDocument = {
      domain,
      title,
      theme: { layout: hasDocsSidebar ? "docs" : "blog", accent: "#2563eb", font: "system-ui" },
      nav: ctx.docNav ?? [{ label: "Home", href: `arknetz://${domain}` }],
      blocks,
    };
    const notes = [...ctx.notes];
    if (!html.trim()) {
      notes.unshift("The HTML was empty, so the document has no blocks yet.");
    } else if (blocks.length === 0) {
      notes.push("No importable content was found in the HTML, so the document has no blocks yet.");
    }
    return { doc, imported: blocks.length, skipped, skippedByReason: { ...ctx.skippedByReason }, notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      doc: emptyDocument(domain, fallbackTitle),
      imported: 0,
      skipped: 1,
      skippedByReason: { importError: 1 },
      notes: [`Import failed (${message}) — returned an empty document instead of throwing.`],
    };
  }
}

/**
 * Import a fetched HTML page. The caller injects the fetch function —
 * this module never calls the network itself, so tests stay offline.
 * Without a fetch function (or on a fetch / HTTP failure) it returns
 * an empty document with a plain-language note, never a throw.
 * Relative URLs in the page resolve against the page URL itself.
 */
export async function importHtmlFromUrl(
  url: string,
  opts: HtmlImportOptions & { fetchFn?: HtmlFetchFn } = {},
): Promise<HtmlImportResult> {
  const domain = opts.domain ?? "imported.arknetz";
  const fallbackTitle = opts.title ?? "Imported HTML";
  const empty = (note: string, skipped = 0, byReason: Record<string, number> = {}): HtmlImportResult => ({
    doc: emptyDocument(domain, fallbackTitle),
    imported: 0,
    skipped,
    skippedByReason: byReason,
    notes: [note],
    sourceUrl: url,
  });
  try {
    if (!opts.fetchFn) {
      return empty(
        "No fetch function was provided, so the page could not be fetched. Pass fetchFn to importHtmlFromUrl — this module never fetches on its own.",
      );
    }
    const res = await opts.fetchFn(url);
    let text: string | null = null;
    if (typeof res === "string") {
      text = res;
    } else if (res && typeof res.text === "function") {
      if (res.ok === false) {
        return empty(
          `Fetching ${url} failed (HTTP ${res.status ?? "unknown"}), so the document is empty.`,
        );
      }
      text = await res.text();
    } else {
      return empty("The fetch function returned an unexpected response shape, so the document is empty.");
    }
    const result = importHtml(text, { ...opts, baseUrl: opts.baseUrl ?? url });
    return { ...result, sourceUrl: url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return empty(`Fetching ${url} failed (${message}), so the document is empty.`);
  }
}
