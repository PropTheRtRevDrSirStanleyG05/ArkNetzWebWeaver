// Tests: round-2 integration wiring — HTML importer UI, collab UI
// surface, domain-claim → editor hook, data:image rendering, and the
// canvas table grid.
//
// EditorUI is DOM code and the suite runs in plain node:test with no
// jsdom, so these tests drive it through the same minimal fake DOM
// the editor-ui / tables-lists batteries use: just enough of
// createElement / getElementById / events / classList /
// querySelectorAll for the editor's real code paths to run end to
// end. GitHub calls go to the in-memory FakeGitHub — no test touches
// real GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EditorUI } from "../src/lib/editor-ui.js";
import type { EditorUiOptions } from "../src/lib/editor-ui.js";
import { EditorState } from "../src/lib/editor.js";
import { FakeGitHub } from "./collab-fake-github.js";
import { colourForLogin } from "../src/lib/collab/types.js";
import { importHtml } from "../src/lib/html-import.js";
import type { HtmlFetchFn } from "../src/lib/html-import.js";
import { renderBlock, READER_CSS } from "../src/lib/renderer.js";
import {
  SIGN_IN_TO_CLAIM_MESSAGE,
  claimDomainAndOpenSite,
  shardForDomain,
} from "../src/lib/domains.js";
import { MASTER_GITHUB_USER, registryShardRepo } from "../src/lib/config.js";
import type { GithubFetchFn } from "../src/lib/publish.js";
import type { IaFetchFn, IaUploadQueue } from "../src/lib/ia-media.js";
import type { SiteDocument } from "../src/lib/types.js";

// ---------------------------------------------------------------------------
// Minimal fake DOM (copied pattern from tests/editor-ui.test.ts)
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
  // descendant text.
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
  /** File inputs: the test sets this to stub files. */
  files: Array<{ name?: string; text: () => Promise<string> }> | null = null;
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
  // side effects the assertions do not need. (setInterval is likewise
  // absent, so the collab refresh timer is a no-op here and tests
  // drive refreshCollab() by hand.)
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

function freshDoc(): SiteDocument {
  return {
    domain: "test.zine",
    title: "Test",
    nav: [],
    blocks: [
      { type: "h1", text: "Hello", id: "b1" },
      { type: "p", text: "Body", id: "b2" },
    ],
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

function setup(opts?: {
  token?: string | null;
  login?: string | null;
  htmlFetch?: HtmlFetchFn;
  fake?: FakeGitHub;
}): {
  ui: EditorUI;
  fakeDoc: FakeDocument;
  root: FakeElement;
  fake: FakeGitHub;
  setToken: (t: string | null) => void;
  setLogin: (l: string | null) => void;
} {
  const fakeDoc = new FakeDocument();
  (globalThis as unknown as { document: FakeDocument }).document = fakeDoc;
  (globalThis as unknown as { window: typeof fakeWindow }).window = fakeWindow;
  fakeWindow.selection = null;
  const root = buildStaticDom(fakeDoc);
  let token: string | null = opts?.token !== undefined ? opts.token : "tok-alice";
  let login: string | null = opts?.login !== undefined ? opts.login : "alice";
  const fake = opts?.fake ?? new FakeGitHub();
  const uiOpts: EditorUiOptions = {
    getIaKeys: () => null,
    iaQueue: {} as unknown as IaUploadQueue,
    iaFetch: (async () => {
      throw new Error("no IA in tests");
    }) as unknown as IaFetchFn,
    getGithubToken: () => token,
    getGithubLogin: () => login,
    getSiteRepo: (domain: string) => `arknetz-site-${domain.replace(/[^a-z0-9]/gi, "-")}`,
    githubFetch: fake.fetchFn,
    htmlFetch: opts?.htmlFetch,
  };
  const ui = new EditorUI(root as unknown as HTMLElement, uiOpts);
  return {
    ui,
    fakeDoc,
    root,
    fake,
    setToken: (t) => {
      token = t;
    },
    setLogin: (l) => {
      login = l;
    },
  };
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

function statusOf(fakeDoc: FakeDocument): string {
  return (fakeDoc.getElementById("editor-status") as FakeElement).textContent;
}

function collabStatusOf(fakeDoc: FakeDocument): string {
  return (fakeDoc.getElementById("collab-status") as FakeElement).textContent;
}

function elById(fakeDoc: FakeDocument, id: string): FakeElement {
  const el = fakeDoc.getElementById(id);
  assert.ok(el, `expected #${id} to exist`);
  return el as FakeElement;
}

// ---------------------------------------------------------------------------
// HTML importer UI
// ---------------------------------------------------------------------------

test("HTML import (file): malformed HTML never throws — blocks append, counts shown, data: image kept", async () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const malformed =
    `<div><p>Unclosed <b>bold</b></p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="dot">` +
    `<script>alert(1)</script><h1>Imported Title`;
  const input = elById(fakeDoc, "html-import-input");
  input.files = [{ text: async () => malformed }];
  input.fire("change");
  await flush();
  const status = statusOf(fakeDoc);
  assert.match(status, /HTML import: \d+ block\(s\) imported, \d+ skipped\./);
  // The existing blocks stay; the imported blocks are appended.
  const doc = ui.doc as SiteDocument;
  assert.ok(doc.blocks.length > 2, `expected appended blocks, got ${doc.blocks.length}`);
  assert.equal(doc.blocks[0]?.id, "b1");
  assert.equal(doc.domain, "test.zine");
  // The data: image survived the import (not dropped, not skipped as
  // unsafe) and the shared renderer now renders it as a real <img>.
  const img = doc.blocks.find((b) => b.type === "img");
  assert.ok(img, "expected an imported img block");
  assert.match(img.src ?? "", /^data:image\/png;base64,/);
  assert.match(renderBlock(img), /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(renderBlock(img), /blocked/);
  // The script was dropped, never executed, and counted as skipped.
  assert.match(status, /HTML import: [1-9]\d* block\(s\) imported, [1-9]\d* skipped\./);
  const direct = importHtml(malformed, { domain: "test.zine" });
  assert.equal(direct.imported, doc.blocks.length - 2);
});

test("HTML import (file): garbage input degrades to an empty import, never throws", async () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  const input = elById(fakeDoc, "html-import-input");
  input.files = [{ text: async () => "<script>alert(1)</script>" }];
  input.fire("change");
  await flush();
  assert.match(statusOf(fakeDoc), /HTML import: 0 block\(s\) imported, [1-9]\d* skipped\./);
  assert.equal((ui.doc as SiteDocument).blocks.length, 2);
});

test("HTML import (URL): a fetched page imports; a fetch failure shows a note, never throws", async () => {
  const page = `<html><head><title>From URL</title></head><body><h1>From URL</h1><p>Fetched body.</p></body></html>`;
  const { ui, fakeDoc } = setup({
    htmlFetch: (async () => page) as unknown as HtmlFetchFn,
  });
  ui.open(freshDoc());
  const urlInput = elById(fakeDoc, "html-import-url");
  urlInput.value = "https://example.com/page.html";
  elById(fakeDoc, "html-import-url-btn").fire("click");
  await flush();
  assert.match(statusOf(fakeDoc), /HTML import: \d+ block\(s\) imported, \d+ skipped\./);
  const doc = ui.doc as SiteDocument;
  assert.ok(doc.blocks.some((b) => b.text === "Fetched body."), "fetched paragraph appended");
  assert.ok(doc.blocks.length > 2);

  const failing = setup({
    htmlFetch: (async () => {
      throw new Error("network down");
    }) as unknown as HtmlFetchFn,
  });
  failing.ui.open(freshDoc());
  const urlInput2 = elById(failing.fakeDoc, "html-import-url");
  urlInput2.value = "https://example.com/gone.html";
  elById(failing.fakeDoc, "html-import-url-btn").fire("click");
  await flush();
  assert.match(statusOf(failing.fakeDoc), /Fetching https:\/\/example\.com\/gone\.html failed/);
  assert.equal((failing.ui.doc as SiteDocument).blocks.length, 2, "failed fetch imports nothing");
});

test("HTML import (URL): an empty URL field refuses plainly instead of fetching", async () => {
  const { ui, fakeDoc } = setup();
  ui.open(freshDoc());
  elById(fakeDoc, "html-import-url-btn").fire("click");
  await flush();
  assert.match(statusOf(fakeDoc), /Type a page URL first/);
});

// ---------------------------------------------------------------------------
// Collaboration UI surface
// ---------------------------------------------------------------------------

function collabDoc(): SiteDocument {
  return {
    domain: "computers.edu",
    title: "Computers",
    nav: [],
    blocks: [
      { type: "h1", text: "Hello", id: "b1" },
      { type: "p", text: "Body", id: "b2" },
    ],
  };
}

async function joinBob(fake: FakeGitHub): Promise<EditorState> {
  const bob = new EditorState(collabDoc());
  await bob.startCollab({
    token: "tok-bob",
    owner: "alice",
    repo: "arknetz-site-computers-edu",
    login: "bob",
    fetchFn: fake.fetchFn,
    autoPoll: false,
  });
  return bob;
}

test("collab Join without a token refuses loudly and makes no network calls", async () => {
  const { ui, fakeDoc, fake } = setup({ token: null, login: null });
  ui.open(collabDoc());
  elById(fakeDoc, "collab-join-btn").fire("click");
  await flush();
  assert.match(statusOf(fakeDoc), /own GitHub token/);
  assert.match(collabStatusOf(fakeDoc), /own GitHub token/);
  assert.equal(fake.calls.length, 0, "no GitHub call without a token");
  assert.equal(ui.editorState?.collabSession, null);
  assert.equal(
    findAll(elById(fakeDoc, "collab-peers"), (el) => el.classList.contains("an-collab-peer")).length,
    0,
  );
});

test("collab Join renders peers, a remote peer's cursor mark renders, a conflict note renders, Leave cleans up", async () => {
  const { ui, fakeDoc, fake } = setup({ token: "tok-alice", login: "alice" });
  ui.open(collabDoc());
  const ed = ui.editorState as EditorState;

  // Join as alice. The try/finally spans the whole joined session:
  // a joined session's poll timers would keep the test process alive
  // if an assertion below failed before Leave.
  let bob: EditorState | null = null;
  try {
    elById(fakeDoc, "collab-join-btn").fire("click");
    await flush();
    assert.ok(ed.collabSession?.joined, "alice joined");
    assert.match(collabStatusOf(fakeDoc), /Collaborating as alice on computers\.edu/);
    // Only self is present yet — the peer list shows her, marked (you).
    assert.match(elById(fakeDoc, "collab-peers").textContent, /alice \(you\)/);

    // Bob joins and parks his caret on b1 (a 5-char selection).
    bob = await joinBob(fake);
    bob.setLocalCursor({ blockId: "b1", start: 0, end: 5 });
    await flush();

    // One poll: alice sees bob's presence + cursor.
    await ed.collabSession?.pollOnce();
    ui.refreshCollab();
    const peersText = elById(fakeDoc, "collab-peers").textContent;
    assert.match(peersText, /alice \(you\)/);
    assert.match(peersText, /bob/);
    const canvas = elById(fakeDoc, "editor-canvas");
    const marks = findAll(canvas, (el) => el.classList.contains("an-collab-cursor"));
    assert.equal(marks.length, 1, "one cursor mark for the remote peer");
    assert.match(marks[0]?.textContent ?? "", /bob is selecting/);
    assert.equal(marks[0]?.style.color, colourForLogin("bob"), "bob's deterministic colour");
    // Self is excluded from cursor marks: no mark labelled alice.
    assert.ok(!findAll(canvas, (el) => el.classList.contains("an-collab-cursor")).some((m) => /alice/.test(m.textContent)));

    // Same-block conflict: both edit b2, alice polls, LWW records it.
    ed.updateBlock("b2", { text: "Alice's edit" });
    bob.updateBlock("b2", { text: "Bob's edit" });
    await flush();
    await ed.collabSession?.pollOnce();
    assert.ok(ed.collabConflicts.length >= 1, "a conflict was recorded");
    ui.refreshCollab();
    const notes = findAll(canvas, (el) => el.classList.contains("an-collab-conflict"));
    assert.equal(notes.length, ed.collabConflicts.length, "one note per conflict, on the losing block");
    assert.match(notes[0]?.textContent ?? "", /Conflict on block b2/);
    assert.match(notes[0]?.textContent ?? "", /kept .*?'s newer version over .*?'s version/);

    // Leave: session ends, peers + marks + notes are gone.
    elById(fakeDoc, "collab-leave-btn").fire("click");
    await flush();
    assert.equal(ed.collabSession, null);
    assert.equal(elById(fakeDoc, "collab-peers").textContent, "");
    assert.equal(findAll(canvas, (el) => el.classList.contains("an-collab-cursor")).length, 0);
    assert.equal(findAll(canvas, (el) => el.classList.contains("an-collab-conflict")).length, 0);
    assert.match(statusOf(fakeDoc), /Left collaboration/);
    assert.equal((ui.doc as SiteDocument).blocks.length, 2, "leaving keeps my blocks");
  } finally {
    if (ed.collabSession) await ed.stopCollab();
    if (bob) await bob.stopCollab();
  }
});

test("collab stale peers are flagged (away) in the peer list and on their cursor mark", async () => {
  const { ui, fakeDoc } = setup({ token: "tok-alice", login: "alice" });
  ui.open(collabDoc());
  const ed = ui.editorState as EditorState;
  try {
    elById(fakeDoc, "collab-join-btn").fire("click");
    await flush();
    assert.ok(ed.collabSession?.joined);
    // UI-level fixture: a stale peer record, as the presence registry
    // produces after 30 s without a heartbeat (expiry itself is covered
    // by the presence battery). The UI must render it as away, never as
    // if it were live.
    ed.collabPeers = [
      { login: "alice", colour: "#2563eb", lastHeartbeat: Date.now(), cursor: null, stale: false },
      { login: "bob", colour: "#dc2626", lastHeartbeat: 0, cursor: { blockId: "b1", start: 0, end: 0 }, stale: true },
    ];
    ui.refreshCollab();
    assert.match(elById(fakeDoc, "collab-peers").textContent, /bob \(away\)/);
    const marks = findAll(elById(fakeDoc, "editor-canvas"), (el) => el.classList.contains("an-collab-cursor"));
    assert.equal(marks.length, 1);
    assert.match(marks[0]?.textContent ?? "", /bob \(away\)/);
    assert.equal(marks[0]?.dataset.stale, "true");
    elById(fakeDoc, "collab-leave-btn").fire("click");
    await flush();
    assert.equal(ed.collabSession, null);
  } finally {
    if (ed.collabSession) await ed.stopCollab();
  }
});

// ---------------------------------------------------------------------------
// Domain claim -> editor hook
// ---------------------------------------------------------------------------

/** A mock GitHub API for the claim flow (same shape as the
 *  domain-claim-open battery): repo create 201, REGISTER issue 201,
 *  seed GET 404 then PUT 201. */
function mockClaimGithub(shardRepo: string): { fetchFn: GithubFetchFn; calls: string[] } {
  const calls: string[] = [];
  const repoUrl = "https://github.com/alice/arknetz-site-computers-edu";
  const fetchFn: GithubFetchFn = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const json = (status: number, body: unknown) => ({
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (url === "https://api.github.com/user/repos" && init.method === "POST") {
      return json(201, { html_url: repoUrl });
    }
    if (
      url === `https://api.github.com/repos/${MASTER_GITHUB_USER}/${shardRepo}/issues` &&
      init.method === "POST"
    ) {
      return json(201, { number: 42, html_url: `https://github.com/${MASTER_GITHUB_USER}/${shardRepo}/issues/42` });
    }
    if (url === "https://api.github.com/repos/alice/arknetz-site-computers-edu/contents/site.json") {
      if (init.method === "GET") return json(404, { message: "Not Found" });
      if (init.method === "PUT") return json(201, { commit: { sha: "abc123" } });
    }
    throw new Error(`mock GitHub: unexpected ${init.method} ${url}`);
  };
  return { fetchFn, calls };
}

test("domain claim opens the site in the editor with the pending-claim state (never 'registered')", async () => {
  const { ui, fakeDoc, root } = setup();
  const shard = await shardForDomain("computers.edu");
  const { fetchFn } = mockClaimGithub(registryShardRepo(shard));
  const opened: unknown[] = [];
  const result = await claimDomainAndOpenSite({
    domainInput: "computers.edu",
    token: "tok-alice",
    login: "alice",
    acceptedTerms: true,
    fetchFn,
    // This is the shell hook (main.ts handleSiteOpened): load the
    // opened document into the editor for the claimed domain.
    onSiteOpened: (o) => {
      opened.push(o);
      ui.showSiteOpened(o);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(opened.length, 1);
  assert.equal(ui.doc?.domain, "computers.edu");
  assert.equal(root.hidden, false, "the editor is shown on the claimed domain");
  const status = statusOf(fakeDoc);
  assert.match(status, /Your site is open/);
  assert.match(status, /claim is filed and waiting for the register bot/);
  assert.match(status, /5 to 10 seconds/);
  assert.match(status, /Claim issue: https:\/\/github\.com\//);
  assert.doesNotMatch(status, /This domain is yours/);
  assert.doesNotMatch(status, /is registered\./);
});

test("domain claim without sign-in refuses with the exact message and never opens the editor", async () => {
  const { ui, fakeDoc } = setup({ token: null, login: null });
  ui.open(freshDoc());
  let hookFired = false;
  const result = await claimDomainAndOpenSite({
    domainInput: "computers.edu",
    token: null,
    login: null,
    acceptedTerms: true,
    fetchFn: (async () => {
      throw new Error("must not be called");
    }) as unknown as GithubFetchFn,
    onSiteOpened: () => {
      hookFired = true;
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, SIGN_IN_TO_CLAIM_MESSAGE);
  assert.equal(hookFired, false);
  assert.equal(ui.doc?.domain, "test.zine", "the editor stayed on the old document");
  assert.doesNotMatch(statusOf(fakeDoc), /Your site is open/);
});

// ---------------------------------------------------------------------------
// Canvas table layout
// ---------------------------------------------------------------------------

test("canvas table layout: table cells sit in a grid row, and styles.css carries the editor-only grid rule", () => {
  const { ui, fakeDoc } = setup();
  ui.open({
    domain: "test.zine",
    title: "Test",
    nav: [],
    blocks: [
      {
        type: "table",
        id: "t1",
        headerRow: true,
        rows: [
          [
            { text: "A" },
            { text: "B" },
            { text: "C" },
          ],
          [
            { text: "1" },
            { text: "2" },
            { text: "3" },
          ],
        ],
      },
    ],
  });
  const canvas = elById(fakeDoc, "editor-canvas");
  const rows = findAll(canvas, (el) => el.classList.contains("an-ed-table-row"));
  assert.equal(rows.length, 2, "one grid row per table row");
  const cells = findAll(canvas, (el) => el.classList.contains("an-ed-table-cell"));
  assert.equal(cells.length, 6, "cells are siblings inside the row, not stacked wrappers");
  // The CSS rule itself: grid on the editor-only class.
  const css = readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.an-ed-table-row\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.an-ed-table-row\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(120px,\s*1fr\)\)/);
  // The reader/preview rendering is untouched: no editor canvas class
  // in the shared reader CSS, and a rendered table has no grid row.
  assert.doesNotMatch(READER_CSS, /an-ed-table-row/);
  assert.doesNotMatch(
    renderBlock({
      type: "table",
      id: "t1",
      headerRow: true,
      rows: [[{ text: "A" }], [{ text: "1" }]],
    }),
    /an-ed-table-row/,
  );
});
