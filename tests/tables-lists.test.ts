// Tests: in-editor rich-text toolbar for tables and lists.
// Pure battery (blocks / validation / renderer / EditorState) plus a
// minimal fake DOM battery for the EditorUI toolbar controls — the
// suite runs in plain node:test with no jsdom, so the DOM half drives
// EditorUI through the fake DOM below.
import test from "node:test";
import assert from "node:assert/strict";
import {
  addTableColumn,
  addTableRow,
  appendListItem,
  BLOCK_TYPES,
  blockLabel,
  clearListItemLink,
  clearTableCellLink,
  defaultBlock,
  formatListItem,
  formatTableCell,
  getListItem,
  getTableCell,
  indentListItem,
  insertListItem,
  isBlockType,
  makeTableRows,
  outdentListItem,
  parseSlashCommand,
  parseTableSize,
  removeListItem,
  removeTableColumn,
  removeTableRow,
  setListItemLink,
  setListItemText,
  setTableCellLink,
  setTableCellText,
  slashSuggestions,
  tableSize,
  toggleTableHeader,
  validateBlock,
  validateDocument,
} from "../src/lib/blocks.js";
import { EditorState } from "../src/lib/editor.js";
import { READER_CSS, renderBlock } from "../src/lib/renderer.js";
import type { BlockNode, SiteDocument } from "../src/lib/types.js";

function listDoc(blocks: BlockNode[]): SiteDocument {
  return { domain: "test.zine", title: "Test", blocks };
}

// ---------------------------------------------------------------------------
// Registration + defaults
// ---------------------------------------------------------------------------

test("list and table are registered block types", () => {
  assert.ok(isBlockType("list"));
  assert.ok(isBlockType("table"));
  assert.ok((BLOCK_TYPES as string[]).includes("list"));
  assert.ok((BLOCK_TYPES as string[]).includes("table"));
  assert.equal(blockLabel("list"), "List");
  assert.equal(blockLabel("table"), "Table");
  assert.deepEqual(validateBlock(defaultBlock("list")), []);
  assert.deepEqual(validateBlock(defaultBlock("table")), []);
});

test("defaultBlock list is bulleted with two items; table is 3x3 with a header row", () => {
  const list = defaultBlock("list");
  assert.equal(list.listStyle, "ul");
  assert.deepEqual(
    (list.listItems ?? []).map((i) => i.text),
    ["First item", "Second item"],
  );
  const table = defaultBlock("table");
  assert.equal(table.headerRow, true);
  assert.equal(tableSize(table)?.rows, 3);
  assert.equal(tableSize(table)?.cols, 3);
  assert.deepEqual(
    (table.rows ?? [])[0]?.map((c) => c.text),
    ["Header 1", "Header 2", "Header 3"],
  );
  assert.deepEqual(
    (table.rows ?? [])[1]?.map((c) => c.text),
    ["", "", ""],
  );
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

test("slash commands parse: /ul /ol /list /table", () => {
  assert.deepEqual(parseSlashCommand("/ul"), { type: "list", text: "" });
  assert.deepEqual(parseSlashCommand("/ol Buy milk"), { type: "list", text: "Buy milk" });
  assert.deepEqual(parseSlashCommand("/list"), { type: "list", text: "" });
  assert.deepEqual(parseSlashCommand("/table"), { type: "table", text: "" });
  assert.deepEqual(parseSlashCommand("/table 2x4"), { type: "table", text: "2x4" });
  assert.equal(parseSlashCommand("/bogus"), null);
  assert.equal(parseSlashCommand("plain text"), null);
  // Existing commands are untouched.
  assert.deepEqual(parseSlashCommand("/h2 Title"), { type: "h2", text: "Title" });
});

test("slash menu lists list and table once each (P1 dedupe)", () => {
  const all = slashSuggestions("");
  assert.equal(all.filter((c) => c.type === "list").length, 1);
  assert.equal(all.filter((c) => c.type === "table").length, 1);
  // A query still finds the numbered variant. ("cols" also matches
  // "ol" as a substring — suggestions match substrings, as before.)
  assert.deepEqual(
    slashSuggestions("ol").map((c) => c.keyword),
    ["cols", "ol"],
  );
  assert.deepEqual(
    slashSuggestions("table").map((c) => c.keyword),
    ["table"],
  );
});

test("parseTableSize accepts RxC inside the caps, rejects the rest", () => {
  assert.deepEqual(parseTableSize("2x4"), { rows: 2, cols: 4 });
  assert.deepEqual(parseTableSize("3X3"), { rows: 3, cols: 3 });
  assert.deepEqual(parseTableSize(" 10 x 20 "), { rows: 10, cols: 20 });
  assert.equal(parseTableSize("Sales"), null);
  assert.equal(parseTableSize("0x3"), null);
  assert.equal(parseTableSize("21x3"), null);
  assert.equal(parseTableSize("3x21"), null);
  assert.equal(parseTableSize(""), null);
});

// ---------------------------------------------------------------------------
// List structure edits
// ---------------------------------------------------------------------------

function threeItemList(): BlockNode {
  return {
    type: "list",
    listStyle: "ul",
    listItems: [{ text: "Alpha" }, { text: "Beta" }, { text: "Gamma" }],
  };
}

test("indent nests under the previous sibling; outdent restores the level", () => {
  const block = threeItemList();
  assert.equal(indentListItem(block, [1]), true);
  assert.deepEqual(
    (block.listItems ?? []).map((i) => i.text),
    ["Alpha", "Gamma"],
  );
  assert.deepEqual(
    (block.listItems?.[0]?.children ?? []).map((i) => i.text),
    ["Beta"],
  );
  // Nested item can indent no further than the depth cap, and outdent
  // puts it back right after its parent.
  assert.equal(outdentListItem(block, [0, 0]), true);
  assert.deepEqual(
    (block.listItems ?? []).map((i) => i.text),
    ["Alpha", "Beta", "Gamma"],
  );
  // First item of a level cannot indent; top-level items cannot outdent.
  assert.equal(indentListItem(block, [0]), false);
  assert.equal(outdentListItem(block, [0]), false);
  assert.equal(indentListItem(block, [9]), false);
  assert.equal(outdentListItem(block, [9]), false);
});

test("indent stops at the depth cap (5 levels)", () => {
  const block: BlockNode = {
    type: "list",
    listItems: [
      {
        text: "L1",
        children: [
          {
            text: "L2",
            children: [
              {
                text: "L3",
                children: [
                  {
                    text: "L4",
                    children: [{ text: "L5" }, { text: "L5-sibling" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { text: "second" },
    ],
  };
  // L5-sibling sits at depth 5; indenting it would make depth 6.
  assert.equal(indentListItem(block, [0, 0, 0, 0, 1]), false);
  // Outdenting it to depth 4 works — it lands after its parent L4.
  assert.equal(outdentListItem(block, [0, 0, 0, 0, 1]), true);
  assert.deepEqual(
    (block.listItems?.[0]?.children?.[0]?.children?.[0]?.children ?? []).map((i) => i.text),
    ["L4", "L5-sibling"],
  );
});

test("list items: append, insert after, remove — last item is kept", () => {
  const block = threeItemList();
  assert.equal(appendListItem(block, "Delta"), true);
  assert.deepEqual(
    (block.listItems ?? []).map((i) => i.text),
    ["Alpha", "Beta", "Gamma", "Delta"],
  );
  assert.equal(insertListItem(block, [1], "Inserted"), true);
  assert.deepEqual(
    (block.listItems ?? []).map((i) => i.text),
    ["Alpha", "Beta", "Inserted", "Gamma", "Delta"],
  );
  assert.equal(removeListItem(block, [2]), true);
  assert.deepEqual(
    (block.listItems ?? []).map((i) => i.text),
    ["Alpha", "Beta", "Gamma", "Delta"],
  );
  assert.equal(removeListItem(block, [0]), true);
  assert.equal(removeListItem(block, [0]), true);
  assert.equal(removeListItem(block, [0]), true);
  assert.equal((block.listItems ?? []).length, 1);
  assert.equal(removeListItem(block, [0]), false);
  assert.equal((block.listItems ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// List item text + inline formatting
// ---------------------------------------------------------------------------

test("setListItemText keeps formatting per character position", () => {
  const block: BlockNode = {
    type: "list",
    listItems: [{ runs: [{ text: "Hello", format: { bold: true } }, { text: " world" }] }],
  };
  // text is derived from the runs by the setter's sync, like typing.
  // "Hello!" keeps "Hello" bold; the typed "!" takes the format of the
  // character it replaces (the plain space), so it stays plain.
  assert.equal(setListItemText(block, [0], "Hello!"), true);
  const item = getListItem(block, [0]);
  assert.equal(item?.text, "Hello!");
  assert.deepEqual(item?.runs, [{ text: "Hello", format: { bold: true } }, { text: "!" }]);
  assert.equal(setListItemText(block, [5], "nope"), false);
});

test("formatListItem bolds / italicises / links inside items", () => {
  const block = threeItemList();
  assert.equal(formatListItem(block, [0], 0, 5, { bold: true }, "toggle"), true);
  assert.deepEqual(getListItem(block, [0])?.runs, [{ text: "Alpha", format: { bold: true } }]);
  // Toggle removes it again.
  assert.equal(formatListItem(block, [0], 0, 5, { bold: true }, "toggle"), true);
  assert.equal(getListItem(block, [0])?.runs, undefined);
  assert.equal(getListItem(block, [0])?.text, "Alpha");
  // Italic + link on part of an item.
  assert.equal(formatListItem(block, [1], 0, 4, { italic: true }, "set"), true);
  assert.equal(
    setListItemLink(block, [1], 0, 4, "https://archive.org/download/item/x"),
    true,
  );
  assert.deepEqual(getListItem(block, [1])?.runs, [
    { text: "Beta", format: { italic: true, href: "https://archive.org/download/item/x" } },
  ]);
  assert.equal(clearListItemLink(block, [1], 0, 4), true);
  assert.deepEqual(getListItem(block, [1])?.runs, [{ text: "Beta", format: { italic: true } }]);
  // Unsafe hrefs are refused and the item is left unchanged.
  assert.equal(setListItemLink(block, [1], 0, 4, "javascript:alert(1)"), false);
  assert.deepEqual(getListItem(block, [1])?.runs, [{ text: "Beta", format: { italic: true } }]);
  assert.equal(formatListItem(block, [9], 0, 1, { bold: true }), false);
});

// ---------------------------------------------------------------------------
// Table structure edits
// ---------------------------------------------------------------------------

test("table add/remove row and column, with last row/column kept", () => {
  const block = defaultBlock("table");
  assert.equal(addTableRow(block), true);
  assert.equal(tableSize(block)?.rows, 4);
  assert.equal(tableSize(block)?.cols, 3);
  assert.equal(removeTableRow(block), true);
  assert.equal(tableSize(block)?.rows, 3);
  assert.equal(addTableColumn(block), true);
  assert.equal(tableSize(block)?.cols, 4);
  assert.equal((block.rows?.[0] as { text?: string }[])[3]?.text, "Header 4");
  assert.equal(removeTableColumn(block), true);
  assert.equal(tableSize(block)?.cols, 3);
  // Down to 1x1, then both removals refuse.
  assert.equal(removeTableRow(block), true);
  assert.equal(removeTableRow(block), true);
  assert.equal(removeTableRow(block), false);
  assert.equal(removeTableColumn(block), true);
  assert.equal(removeTableColumn(block), true);
  assert.equal(removeTableColumn(block), false);
  assert.deepEqual(tableSize(block), { rows: 1, cols: 1 });
});

test("toggleTableHeader flips the header row", () => {
  const block = defaultBlock("table");
  assert.equal(block.headerRow, true);
  assert.equal(toggleTableHeader(block), true);
  assert.equal(block.headerRow, false);
  assert.equal(toggleTableHeader(block), true);
  assert.equal(block.headerRow, true);
  assert.equal(toggleTableHeader({ type: "p", text: "x" }), false);
});

test("makeTableRows builds any size with labelled headers", () => {
  const rows = makeTableRows(2, 4, true);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows[0]?.map((c) => c.text),
    ["Header 1", "Header 2", "Header 3", "Header 4"],
  );
  assert.deepEqual(
    rows[1]?.map((c) => c.text),
    ["", "", "", ""],
  );
  assert.deepEqual(
    makeTableRows(1, 1, false)[0]?.map((c) => c.text),
    [""],
  );
});

// ---------------------------------------------------------------------------
// Table cell text + inline formatting
// ---------------------------------------------------------------------------

test("setTableCellText and formatTableCell work inside cells", () => {
  const block = defaultBlock("table");
  assert.equal(setTableCellText(block, 1, 1, "Hello"), true);
  assert.equal(getTableCell(block, 1, 1)?.text, "Hello");
  assert.equal(formatTableCell(block, 1, 1, 0, 5, { bold: true }, "toggle"), true);
  assert.deepEqual(getTableCell(block, 1, 1)?.runs, [{ text: "Hello", format: { bold: true } }]);
  assert.equal(
    setTableCellLink(block, 1, 1, 0, 5, "https://archive.org/download/item/x"),
    true,
  );
  assert.deepEqual(getTableCell(block, 1, 1)?.runs, [
    { text: "Hello", format: { bold: true, href: "https://archive.org/download/item/x" } },
  ]);
  assert.equal(clearTableCellLink(block, 1, 1, 0, 5), true);
  assert.deepEqual(getTableCell(block, 1, 1)?.runs, [{ text: "Hello", format: { bold: true } }]);
  // Unsafe hrefs are refused; out-of-range cells refuse.
  assert.equal(setTableCellLink(block, 1, 1, 0, 5, "https://evil.example/x"), false);
  assert.equal(setTableCellText(block, 9, 9, "nope"), false);
  assert.equal(formatTableCell(block, 9, 9, 0, 1, { bold: true }), false);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validation accepts valid lists and tables", () => {
  const nested: BlockNode = {
    type: "list",
    listStyle: "ol",
    listItems: [
      { text: "One", runs: [{ text: "One", format: { bold: true } }] },
      { text: "Two", children: [{ text: "Two-point-one" }] },
    ],
  };
  assert.deepEqual(validateBlock(nested), []);
  const table: BlockNode = {
    type: "table",
    headerRow: true,
    caption: "Sales",
    rows: [
      [{ text: "A" }, { text: "B" }],
      [{ text: "1", runs: [{ text: "1", format: { italic: true } }] }, { text: "2" }],
    ],
  };
  assert.deepEqual(validateBlock(table), []);
});

test("validation rejects malformed lists", () => {
  assert.ok(validateBlock({ type: "list" }).some((p) => p.includes("no listItems")));
  assert.ok(
    validateBlock({ type: "list", listStyle: "circle" as never, listItems: [] }).some((p) =>
      p.includes("listStyle"),
    ),
  );
  assert.ok(
    validateBlock({ type: "list", listItems: "nope" as never }).some((p) => p.includes("no listItems")),
  );
  // Runs/text disagreement inside an item.
  assert.ok(
    validateBlock({
      type: "list",
      listItems: [{ text: "One", runs: [{ text: "Two" }] }],
    }).some((p) => p.includes("runs and text disagree")),
  );
  // Unsafe link inside an item.
  assert.ok(
    validateBlock({
      type: "list",
      listItems: [{ text: "x", runs: [{ text: "x", format: { href: "javascript:alert(1)" } }] }],
    }).some((p) => p.includes("unsafe link href")),
  );
  // Nesting past the depth cap.
  let deep: { text: string; children?: { text: string; children?: unknown }[] } = { text: "L1" };
  let cursor = deep;
  for (let i = 2; i <= 7; i++) {
    const next = { text: `L${i}` };
    cursor.children = [next];
    cursor = next as typeof deep;
  }
  assert.ok(
    validateBlock({ type: "list", listItems: [deep as never] }).some((p) => p.includes("exceeds")),
  );
  // children must be an array.
  assert.ok(
    validateBlock({
      type: "list",
      listItems: [{ text: "x", children: "nope" as never }],
    }).some((p) => p.includes("children is not an array")),
  );
});

test("validation rejects malformed tables", () => {
  assert.ok(validateBlock({ type: "table" }).some((p) => p.includes("no rows array")));
  assert.ok(
    validateBlock({ type: "table", rows: "nope" as never }).some((p) => p.includes("no rows array")),
  );
  assert.ok(validateBlock({ type: "table", rows: [] }).some((p) => p.includes("no rows")));
  // Ragged rows.
  assert.ok(
    validateBlock({
      type: "table",
      rows: [
        [{ text: "a" }, { text: "b" }],
        [{ text: "c" }],
      ],
    }).some((p) => p.includes("rectangular")),
  );
  // headerRow must be a boolean; caption must be a string.
  assert.ok(
    validateBlock({ type: "table", headerRow: "yes" as never, rows: [[{ text: "a" }]] }).some((p) =>
      p.includes("headerRow"),
    ),
  );
  assert.ok(
    validateBlock({ type: "table", caption: 42 as never, rows: [[{ text: "a" }]] }).some((p) =>
      p.includes("caption"),
    ),
  );
  // Over the size caps.
  assert.ok(
    validateBlock({
      type: "table",
      rows: Array.from({ length: 21 }, () => [{ text: "x" }]),
    }).some((p) => p.includes("more than 20 rows")),
  );
  // Runs/text disagreement inside a cell.
  assert.ok(
    validateBlock({
      type: "table",
      rows: [[{ text: "a", runs: [{ text: "b" }] }]],
    }).some((p) => p.includes("runs and text disagree")),
  );
});

test("validateDocument catches a bad list/table anywhere in the document", () => {
  const doc = listDoc([
    { type: "p", text: "ok" },
    { type: "table", rows: [[{ text: "a" }], [{ text: "b" }, { text: "c" }]] },
  ]);
  assert.ok(validateDocument(doc).some((p) => p.includes("rectangular")));
  assert.deepEqual(validateDocument(listDoc([defaultBlock("list"), defaultBlock("table")])), []);
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

test("renderer renders nested lists with inline formatting, escaped", () => {
  const block: BlockNode = {
    type: "list",
    listStyle: "ul",
    listItems: [
      { text: "Plain" },
      {
        text: "Bold item",
        runs: [{ text: "Bold", format: { bold: true } }, { text: " item" }],
        children: [{ text: "Nested <script>alert(1)</script>" }],
      },
      {
        text: "Linked",
        runs: [{ text: "Linked", format: { href: "https://archive.org/download/item/x" } }],
      },
    ],
  };
  const html = renderBlock(block);
  assert.match(html, /^<ul class="an-list">/);
  assert.match(html, /<li>Plain<\/li>/);
  assert.match(html, /<li><strong>Bold<\/strong> item<ul>/);
  assert.match(html, /<li>Nested &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li>/);
  assert.match(html, /<a href="https:\/\/archive\.org\/download\/item\/x" rel="noopener">Linked<\/a>/);
  assert.doesNotMatch(html, /<script>alert/);
  // Numbered lists render as <ol>.
  assert.match(renderBlock({ ...block, listStyle: "ol" }), /^<ol class="an-list">/);
});

test("renderer renders accessible tables: th scope, caption, tbody", () => {
  const block: BlockNode = {
    type: "table",
    headerRow: true,
    caption: "Sales",
    rows: [
      [{ text: "Item" }, { text: "Price" }],
      [{ text: "Apple", runs: [{ text: "Apple", format: { bold: true } }] }, { text: "£1" }],
      [{ text: "<b>nope</b>" }, { text: "£2" }],
    ],
  };
  const html = renderBlock(block);
  assert.match(html, /^<div class="an-table-wrap"><table class="an-table">/);
  assert.match(html, /<caption>Sales<\/caption>/);
  assert.match(html, /<thead><tr><th scope="col">Item<\/th><th scope="col">Price<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td><strong>Apple<\/strong><\/td><td>£1<\/td><\/tr>/);
  assert.match(html, /<td>&lt;b&gt;nope&lt;\/b&gt;<\/td>/);
  assert.doesNotMatch(html, /<b>nope<\/b>/);
  // Without a header row there is no thead/th at all.
  const noHead = renderBlock({ ...block, headerRow: false });
  assert.doesNotMatch(noHead, /<th/);
  assert.doesNotMatch(noHead, /<thead>/);
  assert.match(noHead, /<tbody><tr><td>Item<\/td>/);
});

test("renderer renders malformed list/table as a visible placeholder, never raw", () => {
  const badList = renderBlock({ type: "list", listItems: "x" } as unknown as BlockNode);
  assert.match(badList, /\[invalid list block\]/);
  assert.doesNotMatch(badList, />x</);
  const badTable = renderBlock({ type: "table", rows: "x" } as unknown as BlockNode);
  assert.match(badTable, /\[invalid table block\]/);
  const emptyTable = renderBlock({ type: "table", rows: [] });
  assert.match(emptyTable, /\[invalid table block\]/);
});

test("390px: a table render cannot overflow — scroll wrapper + break rules", () => {
  const long = "averyveryverylongunbrokenword".repeat(8);
  const html = renderBlock({
    type: "table",
    headerRow: true,
    rows: [
      [{ text: "Header" }],
      [{ text: long }],
    ],
  });
  assert.match(html, /<div class="an-table-wrap">/);
  assert.match(html, new RegExp(long));
  // The reader CSS carries the containment: horizontal scroll on the
  // wrapper, word-breaking inside cells.
  assert.match(READER_CSS, /\.an-table-wrap\{overflow-x:auto;max-width:100%\}/);
  assert.match(READER_CSS, /\.an-table th,.an-table td\{[^}]*overflow-wrap:break-word/);
  assert.match(READER_CSS, /\.an-list\{overflow-wrap:break-word\}/);
});

// ---------------------------------------------------------------------------
// EditorState round-trip
// ---------------------------------------------------------------------------

test("EditorState insert/edit/render round-trip for list and table", () => {
  const ed = new EditorState({ domain: "test.zine", title: "T", blocks: [] });
  const list = ed.insertBlock("list");
  assert.equal(list.type, "list");
  const table = ed.insertBlock("table");
  assert.equal(table.type, "table");
  assert.deepEqual(ed.validate(), []);
  assert.match(renderBlock(list), /<ul class="an-list">/);
  assert.match(renderBlock(table), /<table class="an-table">/);
  // typeLine still inserts a list/table for the slash commands.
  const viaSlash = ed.typeLine("/table");
  assert.equal(viaSlash.type, "table");
  // Move / delete / update go through the existing EditorState ops.
  assert.equal(ed.moveBlock(table.id ?? "", -1), true);
  assert.equal(ed.blocks[0]?.type, "table");
  assert.equal(ed.updateBlock(list.id ?? "", { listStyle: "ol" }), true);
  assert.match(renderBlock(ed.blocks.find((b) => b.id === list.id) as BlockNode), /^<ol/);
  assert.equal(ed.deleteBlock(list.id ?? ""), true);
  assert.deepEqual(ed.validate(), []);
});

// ---------------------------------------------------------------------------
// EditorUI battery — minimal fake DOM (same approach as
// editor-ui.test.ts: plain node:test, no jsdom)
// ---------------------------------------------------------------------------

import { EditorUI } from "../src/lib/editor-ui.js";
import type { EditorUiOptions } from "../src/lib/editor-ui.js";
import type { IaFetchFn, IaUploadQueue } from "../src/lib/ia-media.js";
import type { GithubFetchFn } from "../src/lib/publish.js";

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: FakeElement | null = null;
  key = "";
  constructor(
    public type: string,
    props?: Record<string, unknown>,
  ) {
    if (props) Object.assign(this, props);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

type Handler = (e: FakeEvent) => void;

class FakeElement {
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  hidden = false;
  value = "";
  checked = false;
  disabled = false;
  contentEditable = "false";
  draggable = false;
  type = "";
  placeholder = "";
  min = "";
  max = "";
  rows = 0;
  onclick: Handler | null = null;
  onchange: Handler | null = null;
  oninput: Handler | null = null;
  onkeydown: Handler | null = null;
  ondragstart: Handler | null = null;
  ondragover: Handler | null = null;
  ondrop: Handler | null = null;
  private _text = "";
  private classes = new Set<string>();
  private listeners = new Map<string, Handler[]>();
  private rawHtml = "";

  constructor(
    public tagName: string,
    public ownerDocument: FakeDocument,
  ) {}

  get textContent(): string {
    if (this.children.length > 0) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v: string) {
    this._text = v;
    this.children = [];
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }
  set id(v: string) {
    this.attributes.set("id", v);
  }

  get className(): string {
    return [...this.classes].join(" ");
  }
  set className(v: string) {
    this.classes = new Set(v.split(/\s+/).filter(Boolean));
  }

  get classList(): {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => boolean;
    contains: (name: string) => boolean;
  } {
    const classes = this.classes;
    return {
      add: (...names: string[]) => {
        for (const n of names) classes.add(n);
      },
      remove: (...names: string[]) => {
        for (const n of names) classes.delete(n);
      },
      toggle: (name: string, force?: boolean) => {
        const next = force !== undefined ? force : !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains: (name: string) => classes.has(name),
    };
  }

  get innerHTML(): string {
    return this.rawHtml;
  }
  set innerHTML(v: string) {
    this.rawHtml = v;
    this.children = [];
  }

  setAttribute(k: string, v: string): void {
    this.attributes.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const n of nodes) {
      this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n);
    }
  }

  after(...nodes: Array<FakeElement | string>): void {
    const parent = this.parentNode;
    if (!parent) return;
    const idx = parent.children.indexOf(this);
    if (idx === -1) return;
    const els = nodes.map((n) => (typeof n === "string" ? this.ownerDocument.createTextNode(n) : n));
    for (const el of els) el.parentNode = parent;
    parent.children.splice(idx + 1, 0, ...els);
  }

  remove(): void {
    const parent = this.parentNode;
    if (!parent) return;
    const idx = parent.children.indexOf(this);
    if (idx !== -1) parent.children.splice(idx, 1);
    this.parentNode = null;
  }

  addEventListener(type: string, fn: Handler): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  fire(type: string, props?: Record<string, unknown>): FakeEvent {
    const e = new FakeEvent(type, props);
    e.target = this;
    for (const fn of this.listeners.get(type) ?? []) fn(e);
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === "function") (handler as Handler)(e);
    return e;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const tags = selector.split(",").map((s) => s.trim().toLowerCase());
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const c of el.children) {
        if (tags.includes(c.tagName.toLowerCase())) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  contains(node: FakeElement | null): boolean {
    let cur: FakeElement | null = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
}

class FakeText extends FakeElement {
  constructor(text: string, doc: FakeDocument) {
    super("#text", doc);
    this.textContent = text;
  }
}

class FakeDocument {
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  private listeners = new Map<string, Handler[]>();

  constructor() {
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text, this);
  }

  getElementById(id: string): FakeElement | null {
    const walk = (el: FakeElement): FakeElement | null => {
      if (el.id === id) return el;
      for (const c of el.children) {
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    return walk(this.documentElement);
  }

  addEventListener(type: string, fn: Handler): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatchEvent(_e: FakeEvent): boolean {
    return true;
  }
}

/** A Range over a plain string — enough for selectionOffsetsIn's
 *  clone/selectNodeContents/setEnd/toString dance. */
class FakeRange {
  startContainer: FakeElement;
  startOffset: number;
  endContainer: FakeElement;
  endOffset: number;
  commonAncestorContainer: FakeElement;
  private start: number;
  private end: number;

  constructor(
    private text: string,
    start: number,
    end: number,
    public editable: FakeElement,
  ) {
    this.start = start;
    this.end = end;
    this.startContainer = editable;
    this.startOffset = start;
    this.endContainer = editable;
    this.endOffset = end;
    this.commonAncestorContainer = editable;
  }

  cloneRange(): FakeRange {
    return new FakeRange(this.text, this.start, this.end, this.editable);
  }

  selectNodeContents(_node: FakeElement): void {
    this.start = 0;
    this.end = this.text.length;
  }

  setEnd(_node: FakeElement, offset: number): void {
    this.end = offset;
  }

  toString(): string {
    return this.text.slice(this.start, this.end);
  }
}

class FakeSelection {
  constructor(private ranges: FakeRange[]) {}
  get rangeCount(): number {
    return this.ranges.length;
  }
  getRangeAt(i: number): FakeRange {
    return this.ranges[i] as FakeRange;
  }
}

const fakeWindow = {
  selection: null as FakeSelection | null,
  getSelection: (): FakeSelection | null => fakeWindow.selection,
  // Timers never fire in tests: preview refresh / autosave are async
  // side effects the assertions do not need.
  setTimeout: (): number => 0,
  clearTimeout: (): void => {},
};

/** The static editor ids from src/index.html, as bare elements. */
function buildStaticDom(doc: FakeDocument): FakeElement {
  const section = doc.createElement("section");
  section.id = "editor";
  const ids: Array<[string, string]> = [
    ["edit-view-btn", "button"],
    ["editor-status", "span"],
    ["role-select", "select"],
    ["theme-select", "select"],
    ["mode-btn", "button"],
    ["revision-btn", "button"],
    ["diff-btn", "button"],
    ["publish-btn", "button"],
    ["export-btn", "button"],
    ["wxr-input", "input"],
    ["html-import-input", "input"],
    ["html-import-url", "input"],
    ["html-import-url-btn", "button"],
    ["diff-output", "div"],
    ["editor-canvas", "div"],
    ["slash-input", "input"],
    ["slash-add-btn", "button"],
    ["inserter-select", "select"],
    ["inserter-btn", "button"],
    ["editor-preview", "div"],
    ["editor-sidebar", "aside"],
  ];
  for (const [id, tag] of ids) {
    const el = doc.createElement(tag);
    el.id = id;
    section.appendChild(el);
  }
  doc.body.appendChild(section);
  return section;
}

function setup(): { ui: EditorUI; fakeDoc: FakeDocument; root: FakeElement } {
  const fakeDoc = new FakeDocument();
  (globalThis as unknown as { document: FakeDocument }).document = fakeDoc;
  (globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;
  fakeWindow.selection = null;
  const root = buildStaticDom(fakeDoc);
  const opts: EditorUiOptions = {
    getIaKeys: () => null,
    iaQueue: {} as unknown as IaUploadQueue,
    iaFetch: (async () => {
      throw new Error("no IA in tests");
    }) as unknown as IaFetchFn,
    getGithubToken: () => null,
    getGithubLogin: () => null,
    getSiteRepo: () => null,
    githubFetch: (async () => {
      throw new Error("no GitHub in tests");
    }) as unknown as GithubFetchFn,
  };
  const ui = new EditorUI(root as unknown as HTMLElement, opts);
  return { ui, fakeDoc, root };
}

function findAll(root: FakeElement, pred: (el: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement): void => {
    if (pred(el)) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
}

function canvasOf(fakeDoc: FakeDocument): FakeElement {
  return fakeDoc.getElementById("editor-canvas") as FakeElement;
}

function buttons(root: FakeElement, label: string): FakeElement[] {
  return findAll(root, (el) => el.tagName === "button" && el.textContent === label);
}

function clickButton(root: FakeElement, label: string, index = 0): void {
  const found = buttons(root, label);
  assert.ok(found.length > index, `expected a button labelled ${label} (#${index})`);
  (found[index] as FakeElement).fire("click");
}

test("inserter offers List and Table", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([]));
  const inserter = fakeDoc.getElementById("inserter-select") as FakeElement;
  const values = inserter.children.map((o) => o.value);
  assert.ok(values.includes("list"), `inserter lacks list: ${values.join(",")}`);
  assert.ok(values.includes("table"), `inserter lacks table: ${values.join(",")}`);
});

test("list toolbar toggles bulleted / numbered", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([defaultBlock("list")]));
  const canvas = canvasOf(fakeDoc);
  assert.equal((ui.doc?.blocks[0] as BlockNode).listStyle, "ul");
  clickButton(canvas, "1. Numbered");
  assert.equal((ui.doc?.blocks[0] as BlockNode).listStyle, "ol");
  assert.match(renderBlock(ui.doc?.blocks[0] as BlockNode), /^<ol/);
  // The canvas rebuilt — re-find the button in the fresh tree.
  clickButton(canvasOf(fakeDoc), "• Bulleted");
  assert.equal((ui.doc?.blocks[0] as BlockNode).listStyle, "ul");
});

test("list item indent / outdent buttons nest and un-nest", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([defaultBlock("list")]));
  // Default list is [First item, Second item]: indent the second.
  clickButton(canvasOf(fakeDoc), "→", 1);
  const afterIndent = ui.doc?.blocks[0] as BlockNode;
  assert.deepEqual(
    (afterIndent.listItems ?? []).map((i) => i.text),
    ["First item"],
  );
  assert.deepEqual(
    (afterIndent.listItems?.[0]?.children ?? []).map((i) => i.text),
    ["Second item"],
  );
  // The nested item's outdent is the second "←" in tree order.
  clickButton(canvasOf(fakeDoc), "←", 1);
  assert.deepEqual(
    (ui.doc?.blocks[0]?.listItems ?? []).map((i) => i.text),
    ["First item", "Second item"],
  );
});

test("table toolbar adds/removes rows and columns and toggles the header", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([defaultBlock("table")]));
  const size = (): { rows: number; cols: number } =>
    tableSize(ui.doc?.blocks[0] as BlockNode) as { rows: number; cols: number };
  assert.deepEqual(size(), { rows: 3, cols: 3 });
  clickButton(canvasOf(fakeDoc), "+ Row");
  assert.deepEqual(size(), { rows: 4, cols: 3 });
  clickButton(canvasOf(fakeDoc), "− Row");
  assert.deepEqual(size(), { rows: 3, cols: 3 });
  clickButton(canvasOf(fakeDoc), "+ Column");
  assert.deepEqual(size(), { rows: 3, cols: 4 });
  clickButton(canvasOf(fakeDoc), "− Column");
  assert.deepEqual(size(), { rows: 3, cols: 3 });
  clickButton(canvasOf(fakeDoc), "Header row");
  assert.equal((ui.doc?.blocks[0] as BlockNode).headerRow, false);
  assert.doesNotMatch(renderBlock(ui.doc?.blocks[0] as BlockNode), /<th/);
  clickButton(canvasOf(fakeDoc), "Header row");
  assert.equal((ui.doc?.blocks[0] as BlockNode).headerRow, true);
  assert.match(renderBlock(ui.doc?.blocks[0] as BlockNode), /<th scope="col">/);
});

test("slash input inserts a numbered list with first-item text", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([]));
  const input = fakeDoc.getElementById("slash-input") as FakeElement;
  input.value = "/ol Buy milk";
  input.fire("keydown", { key: "Enter" });
  const block = ui.doc?.blocks[0] as BlockNode;
  assert.equal(block.type, "list");
  assert.equal(block.listStyle, "ol");
  assert.deepEqual(
    (block.listItems ?? []).map((i) => i.text),
    ["Buy milk"],
  );
  assert.deepEqual(validateDocument(ui.doc as SiteDocument), []);
});

test("slash input inserts a sized table, or a captioned default table", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([]));
  const input = fakeDoc.getElementById("slash-input") as FakeElement;
  input.value = "/table 2x4";
  input.fire("keydown", { key: "Enter" });
  assert.deepEqual(tableSize(ui.doc?.blocks[0] as BlockNode), { rows: 2, cols: 4 });
  input.value = "/table Sales";
  input.fire("keydown", { key: "Enter" });
  const second = ui.doc?.blocks[1] as BlockNode;
  assert.equal(second.type, "table");
  assert.equal(second.caption, "Sales");
  assert.deepEqual(tableSize(second), { rows: 3, cols: 3 });
  assert.deepEqual(validateDocument(ui.doc as SiteDocument), []);
});

test("shared format bar bolds the selected text in a table cell", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([defaultBlock("table")]));
  const canvas = canvasOf(fakeDoc);
  // First cell editable: the first .an-ed-text inside a table cell.
  const cellEditables = findAll(canvas, (el) =>
    el.className.split(" ").includes("an-ed-text") &&
    (el.parentNode?.className.split(" ").includes("an-ed-table-cell") ?? false),
  );
  assert.ok(cellEditables.length === 9, `expected 9 cell editables, got ${cellEditables.length}`);
  const editable = cellEditables[0] as FakeElement;
  assert.equal(editable.textContent, "Header 1");
  editable.fire("focus");
  fakeWindow.selection = new FakeSelection([new FakeRange("Header 1", 0, 6, editable)]);
  // Mousedown on the format bar captures the selection (B3).
  const bar = findAll(canvas, (el) => el.className.split(" ").includes("an-fmt-bar"))[0] as FakeElement;
  bar.fire("mousedown");
  clickButton(canvas, "B");
  const cell = getTableCell(ui.doc?.blocks[0] as BlockNode, 0, 0);
  assert.deepEqual(cell?.runs, [{ text: "Header", format: { bold: true } }, { text: " 1" }]);
  assert.match(renderBlock(ui.doc?.blocks[0] as BlockNode), /<th scope="col"><strong>Header<\/strong> 1<\/th>/);
});

test("shared format bar bolds the selected text in a list item", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([defaultBlock("list")]));
  const canvas = canvasOf(fakeDoc);
  const itemEditables = findAll(canvas, (el) =>
    el.className.split(" ").includes("an-ed-text") &&
    (el.parentNode?.className.split(" ").includes("an-ed-list-item") ?? false),
  );
  assert.ok(itemEditables.length === 2, `expected 2 item editables, got ${itemEditables.length}`);
  const editable = itemEditables[0] as FakeElement;
  assert.equal(editable.textContent, "First item");
  editable.fire("focus");
  fakeWindow.selection = new FakeSelection([new FakeRange("First item", 0, 5, editable)]);
  const bar = findAll(canvas, (el) => el.className.split(" ").includes("an-fmt-bar"))[0] as FakeElement;
  bar.fire("mousedown");
  clickButton(canvas, "B");
  const item = getListItem(ui.doc?.blocks[0] as BlockNode, [0]);
  assert.deepEqual(item?.runs, [{ text: "First", format: { bold: true } }, { text: " item" }]);
  assert.match(renderBlock(ui.doc?.blocks[0] as BlockNode), /<li><strong>First<\/strong> item<\/li>/);
});

test("format bar with no focused cell/item says so instead of formatting", () => {
  const { ui, fakeDoc } = setup();
  ui.open(listDoc([defaultBlock("table")]));
  const canvas = canvasOf(fakeDoc);
  clickButton(canvas, "B");
  const status = fakeDoc.getElementById("editor-status") as FakeElement;
  assert.match(status.textContent, /Click a list item or table cell first/);
  assert.equal(getTableCell(ui.doc?.blocks[0] as BlockNode, 0, 0)?.runs, undefined);
});
