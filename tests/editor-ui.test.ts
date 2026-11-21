// Tests: editor UI behaviour — format toolbar selection survival (B3),
// viewer role enforcement (B4), app-wide dark mode (B5), slash-menu
// dedupe (P1).
//
// EditorUI is DOM code, and the suite runs in plain node:test with no
// jsdom, so these tests drive it through a minimal fake DOM below: just
// enough of createElement / getElementById / events / classList /
// querySelectorAll for the editor's real code paths to run end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { EditorUI, SavedSelection, roleCanEdit, roleCanPublish, selectionOffsetsIn } from "../src/lib/editor-ui.js";
import type { EditorUiOptions } from "../src/lib/editor-ui.js";
import { parseSlashCommand, slashSuggestions } from "../src/lib/blocks.js";
import { appThemeCss } from "../src/lib/themes.js";
import { EDITOR_ROLE, OWNER_ROLE, VIEWER_ROLE, WRITER_ROLE } from "../src/lib/roles.js";
import type { IaFetchFn, IaUploadQueue } from "../src/lib/ia-media.js";
import type { GithubFetchFn } from "../src/lib/publish.js";
import type { SiteDocument } from "../src/lib/types.js";

// ---------------------------------------------------------------------------
// Minimal fake DOM
// ---------------------------------------------------------------------------

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: FakeElement | null = null;
  constructor(public type: string) {}
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
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  // textContent mirrors the real DOM: assigning it replaces the
  // children with a single text node; reading it concatenates the
  // descendant text (so elements built with appendChild/createTextNode
  // — e.g. the sidebar nav rows with <wbr> breaks — read back the
  // same text a browser would).
  private _text = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  draggable = false;
  contentEditable = "";
  type = "";
  placeholder = "";
  rows = 0;
  min = "";
  max = "";
  onclick: Handler | null = null;
  onchange: Handler | null = null;
  oninput: Handler | null = null;
  onkeydown: Handler | null = null;
  ondragstart: Handler | null = null;
  ondragover: Handler | null = null;
  ondrop: Handler | null = null;
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

  /** Fire an event on this element only (no bubbling): listeners first,
   *  then the on<type> property, like the real dispatch order here. */
  fire(type: string): FakeEvent {
    const e = new FakeEvent(type);
    e.target = this;
    for (const fn of this.listeners.get(type) ?? []) fn(e);
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === "function") (handler as Handler)(e);
    return e;
  }

  /** Fire an event that bubbles up the ancestor chain, like a real
   *  mouse click on a nested element (R1): listeners run target-first,
   *  then each ancestor, until stopPropagation(). The on<type>
   *  property runs at each level too. */
  fireBubbled(type: string): FakeEvent {
    const e = new FakeEvent(type);
    e.target = this;
    let cur: FakeElement | null = this;
    while (cur && !e.propagationStopped) {
      for (const fn of cur.listeners.get(type) ?? []) fn(e);
      const handler = (cur as unknown as Record<string, unknown>)[`on${type}`];
      if (typeof handler === "function") (handler as Handler)(e);
      cur = cur.parentNode;
    }
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

/** A Range over a plain string, with the editable element as the
 *  container — enough for selectionOffsetsIn's clone/selectNodeContents/
 *  setEnd/toString dance. */
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

function setSelection(editable: FakeElement, text: string, start: number, end: number): void {
  fakeWindow.selection = new FakeSelection([new FakeRange(text, start, end, editable)]);
}

function clearSelection(): void {
  fakeWindow.selection = new FakeSelection([]);
}

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

function freshDoc(): SiteDocument {
  return {
    domain: "test.zine",
    title: "Test",
    nav: [],
    blocks: [{ type: "p", text: "Hello world", id: "b1" }],
  };
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

function findEditable(root: FakeElement): FakeElement {
  const found = findAll(root, (el) => el.className.split(" ").includes("an-ed-text"));
  assert.ok(found.length >= 1, "expected a contenteditable block in the canvas");
  return found[0] as FakeElement;
}

function findButton(root: FakeElement, label: string): FakeElement {
  const found = findAll(root, (el) => el.tagName === "button" && el.textContent === label);
  assert.ok(found.length >= 1, `expected a button labelled ${label}`);
  return found[0] as FakeElement;
}

function findToolbar(root: FakeElement): FakeElement {
  const found = findAll(root, (el) => el.className.split(" ").includes("an-fmt-bar"));
  assert.ok(found.length >= 1, "expected a format toolbar in the canvas");
  return found[0] as FakeElement;
}

function findBlockWrap(root: FakeElement): FakeElement {
  const found = findAll(root, (el) => el.className.split(" ").includes("an-ed-block"));
  assert.ok(found.length >= 1, "expected a block wrapper in the canvas");
  return found[0] as FakeElement;
}

// ---------------------------------------------------------------------------
// B3 — format toolbar selection survival
// ---------------------------------------------------------------------------

test("B3: Bold applies to the selected text; the button mousedown does not steal focus", () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const canvas = fakeDoc.getElementById("editor-canvas") as FakeElement;
  const editable = findEditable(canvas);
  assert.equal(editable.textContent, "Hello world");
  setSelection(editable, "Hello world", 6, 11); // "world"
  const boldBtn = findButton(canvas, "B");
  const down = boldBtn.fire("mousedown");
  assert.equal(down.defaultPrevented, true, "mousedown must preventDefault so the selection survives");
  boldBtn.fire("click");
  const block = ui.doc?.blocks[0];
  assert.deepEqual(block?.runs, [{ text: "Hello " }, { text: "world", format: { bold: true } }]);
});

test("B3: Link applies to the saved selection after the URL input takes focus", () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const canvas = fakeDoc.getElementById("editor-canvas") as FakeElement;
  const editable = findEditable(canvas);
  setSelection(editable, "Hello world", 0, 5); // "Hello"
  // Clicking into the link input moves focus there; the mousedown
  // bubbling to the toolbar is what captures the selection first.
  findToolbar(canvas).fire("mousedown");
  clearSelection();
  const linkInput = findAll(canvas, (el) => el.tagName === "input" && el.placeholder.startsWith("https://"))[0] as FakeElement;
  linkInput.value = "https://archive.org/details/x";
  findButton(canvas, "Link").fire("click");
  const block = ui.doc?.blocks[0];
  assert.deepEqual(block?.runs, [
    { text: "Hello", format: { href: "https://archive.org/details/x" } },
    { text: " world" },
  ]);
});

test("B3: SavedSelection falls back to the captured range, is single-use, and ignores collapsed selections", () => {
  const fakeDoc = new FakeDocument();
  const editable = fakeDoc.createElement("p");
  editable.textContent = "Hello world";
  const live = new FakeSelection([new FakeRange("Hello world", 6, 11, editable)]);
  const gone = new FakeSelection([]);
  const saved = new SavedSelection();
  const asNode = (el: FakeElement): Node => el as unknown as Node;
  const asSel = (s: FakeSelection): Selection => s as unknown as Selection;

  saved.capture(asNode(editable), asSel(live));
  assert.deepEqual(saved.take(asNode(editable), asSel(gone)), { start: 6, end: 11 });
  // Single-use: the saved range is gone after one take.
  assert.equal(saved.take(asNode(editable), asSel(gone)), null);

  // A live selection wins over a stale saved one.
  saved.capture(asNode(editable), asSel(live));
  assert.deepEqual(saved.take(asNode(editable), asSel(live)), { start: 6, end: 11 });

  // A collapsed selection is not worth saving.
  const collapsed = new FakeSelection([new FakeRange("Hello world", 3, 3, editable)]);
  saved.capture(asNode(editable), asSel(collapsed));
  assert.equal(saved.take(asNode(editable), asSel(gone)), null);

  // A selection outside the editable resolves to null.
  const other = fakeDoc.createElement("p");
  const outside = new FakeSelection([new FakeRange("Hello world", 0, 5, other)]);
  assert.equal(selectionOffsetsIn(asNode(editable), asSel(outside)), null);
  assert.equal(selectionOffsetsIn(asNode(editable), null), null);
});

// ---------------------------------------------------------------------------
// R1 — clicking into a contenteditable must not rebuild the canvas
// ---------------------------------------------------------------------------

test("R1: clicking into a contenteditable does not rebuild it — the same element survives, selected in place", () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const canvas = fakeDoc.getElementById("editor-canvas") as FakeElement;
  const editable = findEditable(canvas);
  const wrap = findBlockWrap(canvas);
  assert.equal(wrap.dataset.selected, "false", "nothing selected before the click");
  // A real mouse click bubbles from the editable up to the block
  // wrapper. The old handler re-rendered the whole canvas here,
  // destroying the editable the click had just focused — so no mouse
  // action could ever create a selection to type into.
  editable.fireBubbled("click");
  assert.equal(findEditable(canvas), editable, "the editable element must survive the click, not be rebuilt");
  assert.equal(wrap.dataset.selected, "true", "the clicked block is selected in place");
  const sidebar = fakeDoc.getElementById("editor-sidebar") as FakeElement;
  const selTitle = findAll(sidebar, (el) => el.tagName === "h3" && el.textContent.startsWith("Selected:"));
  assert.equal(selTitle.length, 1);
  assert.equal(selTitle[0]?.textContent, "Selected: Paragraph");
  // A second click on the same block leaves the canvas alone too.
  editable.fireBubbled("click");
  assert.equal(findEditable(canvas), editable);
  assert.equal(wrap.dataset.selected, "true");
});

test("R1: the B3 flow works by mouse — click in, drag-select, Bold bolds the text", () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const canvas = fakeDoc.getElementById("editor-canvas") as FakeElement;
  const editable = findEditable(canvas);
  // Click into the paragraph (bubbles to the wrapper) — the editable
  // must survive, or no mouse selection could ever be created.
  editable.fireBubbled("click");
  assert.equal(findEditable(canvas), editable);
  // Drag-select "world", as a mouse user would after clicking in.
  setSelection(editable, "Hello world", 6, 11);
  const boldBtn = findButton(canvas, "B");
  boldBtn.fire("mousedown");
  boldBtn.fire("click");
  const block = ui.doc?.blocks[0];
  assert.deepEqual(block?.runs, [{ text: "Hello " }, { text: "world", format: { bold: true } }]);
});

// ---------------------------------------------------------------------------
// B4 — viewer role enforcement
// ---------------------------------------------------------------------------

test("B4: roleCanEdit / roleCanPublish match the preset roles", () => {
  assert.equal(roleCanEdit(OWNER_ROLE), true);
  assert.equal(roleCanEdit(EDITOR_ROLE), true);
  assert.equal(roleCanEdit(WRITER_ROLE), true); // writer can draft
  assert.equal(roleCanEdit(VIEWER_ROLE), false);
  assert.equal(roleCanPublish(OWNER_ROLE), true);
  assert.equal(roleCanPublish(EDITOR_ROLE), true);
  assert.equal(roleCanPublish(WRITER_ROLE), false);
  assert.equal(roleCanPublish(VIEWER_ROLE), false);
});

test("B4: Viewer disables Publish and all editing; switching back re-enables", () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const byId = (id: string): FakeElement => fakeDoc.getElementById(id) as FakeElement;
  assert.equal(byId("publish-btn").disabled, false);
  const roleSelect = byId("role-select");
  roleSelect.value = "viewer";
  roleSelect.fire("change");

  assert.equal(byId("publish-btn").disabled, true, "Publish must be disabled for viewer");
  const canvas = byId("editor-canvas");
  assert.equal(findEditable(canvas).contentEditable, "false", "canvas blocks must not be editable for viewer");
  assert.equal(findButton(canvas, "B").disabled, true, "format buttons must be disabled for viewer");
  assert.equal(byId("inserter-btn").disabled, true);
  assert.equal(byId("slash-input").disabled, true);
  assert.equal(byId("slash-add-btn").disabled, true);
  assert.equal(byId("revision-btn").disabled, true);
  assert.equal(byId("theme-select").disabled, true);
  // Read-only controls stay usable, including the role select itself.
  assert.equal(byId("mode-btn").disabled, false);
  assert.equal(byId("export-btn").disabled, false);
  assert.equal(byId("role-select").disabled, false);

  // Switching back to owner re-enables everything.
  roleSelect.value = "owner";
  roleSelect.fire("change");
  assert.equal(byId("publish-btn").disabled, false);
  assert.equal(findEditable(byId("editor-canvas")).contentEditable, "true");
  assert.equal(findButton(byId("editor-canvas"), "B").disabled, false);
  assert.equal(byId("inserter-btn").disabled, false);
});

test("Nit (a): viewer role status ends with a single period, not a double", () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const byId = (id: string): FakeElement => fakeDoc.getElementById(id) as FakeElement;
  const roleSelect = byId("role-select");
  roleSelect.value = "viewer";
  roleSelect.fire("change");
  const status = byId("editor-status").textContent;
  assert.doesNotMatch(status, /\.\./, "no double period in the role status");
  assert.match(status, /editing is disabled for this role\.$/);
});

// ---------------------------------------------------------------------------
// B5 — app-wide dark mode
// ---------------------------------------------------------------------------

test("B5: dark theme CSS covers the app chrome and gives code blocks dark contrast", () => {
  const css = appThemeCss("dark");
  assert.match(css, /\.an-dark/);
  assert.match(css, /\.an-dark \.an-topbar/);
  assert.match(css, /\.an-dark \.an-editor-bar/);
  assert.match(css, /\.an-dark \.an-site/);
  // Code blocks: dark surface + light text, overriding the renderer's
  // hardcoded light-grey pre background.
  assert.match(css, /\.an-dark \.an-site pre/);
  assert.match(css, /background:#1f2937;color:#f9fafb/);
  // B5 (re-check): the panels strip itself goes dark — background,
  // text, headings and labels — not just the panel buttons.
  assert.match(css, /\.an-dark \.an-panels\{background:#1f2937;border-bottom-color:#374151;color:#f9fafb\}/);
  assert.match(css, /\.an-dark \.an-panel-host\{color:#f9fafb\}/);
  assert.match(css, /\.an-dark \.an-panel-host h2,\.an-dark \.an-panel-host h3\{color:#f9fafb\}/);
  assert.equal(appThemeCss("light"), "");
});

test("B5: mode toggle applies dark mode app-wide and back", () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const byId = (id: string): FakeElement => fakeDoc.getElementById(id) as FakeElement;
  assert.equal(fakeDoc.documentElement.classList.contains("an-dark"), false);
  assert.equal(fakeDoc.getElementById("an-dark-theme"), null);

  byId("mode-btn").fire("click");
  assert.equal(byId("mode-btn").textContent, "Light mode");
  assert.equal(fakeDoc.documentElement.classList.contains("an-dark"), true);
  const style = fakeDoc.getElementById("an-dark-theme") as FakeElement;
  assert.ok(style, "a dark <style> element must be injected into <head>");
  assert.match(style.textContent, /background:#1f2937;color:#f9fafb/);

  byId("mode-btn").fire("click");
  assert.equal(byId("mode-btn").textContent, "Dark mode");
  assert.equal(fakeDoc.documentElement.classList.contains("an-dark"), false);
  assert.equal(fakeDoc.getElementById("an-dark-theme"), null);
});

// ---------------------------------------------------------------------------
// P1 — slash menu dedupe
// ---------------------------------------------------------------------------

test("P1: slash menu lists Paragraph (and every other block) exactly once", () => {
  const all = slashSuggestions("");
  assert.equal(all.filter((s) => s.type === "p").length, 1);
  assert.equal(all.filter((s) => s.type === "img").length, 1);
  assert.equal(all.filter((s) => s.type === "cols").length, 1);
  // The dropped keywords still parse: /text is a valid command.
  assert.deepEqual(parseSlashCommand("/text hello"), { type: "p", text: "hello" });
  assert.equal(slashSuggestions("text").filter((s) => s.type === "p").length, 1);
});

// ---------------------------------------------------------------------------
// B9 — sidebar nav-row tooltip set at render time (integration pass)
// ---------------------------------------------------------------------------

test("B9: sidebar nav rows carry the full URL as their title tooltip at render time", () => {
  const { ui, fakeDoc } = setup();
  const doc = freshDoc();
  doc.nav = [
    { label: "Home", href: "arknetz://test.zine" },
    { label: "About", href: "arknetz://test.zine/about" },
  ];
  ui.open(doc);
  const sidebar = fakeDoc.getElementById("editor-sidebar") as FakeElement;
  const rows = findAll(sidebar, (el) => el.tagName === "li");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    // Set by editor-ui.ts renderSidebar() — no hover, mouseover
    // delegation, or shell involvement needed.
    assert.equal((row as unknown as { title?: string }).title, row.textContent);
    assert.match(row.textContent, /arknetz:\/\//);
  }
  // Nit (b): the About row's href carries a <wbr> after its path
  // slash, so it wraps at the boundary instead of mid-word; the Home
  // row (no path) has none. <wbr> adds no text, so the assertions
  // above still hold.
  const aboutRow = rows.find((r) => r.textContent.includes("About")) as FakeElement;
  assert.equal(findAll(aboutRow, (el) => el.tagName === "wbr").length, 1);
  const homeRow = rows.find((r) => r.textContent.includes("Home")) as FakeElement;
  assert.equal(findAll(homeRow, (el) => el.tagName === "wbr").length, 0);
});
