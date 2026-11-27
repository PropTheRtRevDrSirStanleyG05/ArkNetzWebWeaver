// Tests: the hunt-5 top menu (Stanley's dropdown direction).
// Behaviour: toggle on the trigger, close on selection / outside tap /
// Escape, move the panel nav + toolbar actions into the menu on
// narrow screens and restore them in order on desktop, idempotent
// init (a second wiring must not double-toggle).
import test from "node:test";
import assert from "node:assert/strict";
import { initTopMenu } from "../src/lib/topmenu.js";

class FakeEl {
  readonly tagName: string;
  readonly id: string;
  hidden = false;
  dataset: Record<string, string> = {};
  textContent = "";
  focused = false;
  parentNode: FakeEl | null = null;
  children: FakeEl[] = [];
  #attrs = new Map<string, string>();
  #listeners = new Map<string, Array<(e: Record<string, unknown>) => void>>();

  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
  }

  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }

  get nextSibling(): FakeEl | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] ?? null;
  }

  appendChild(child: FakeEl): FakeEl {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeEl, ref: FakeEl | null): FakeEl {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (!ref) {
      this.children.push(child);
      return child;
    }
    const i = this.children.indexOf(ref);
    if (i === -1) throw new Error("NotFoundError");
    this.children.splice(i, 0, child);
    return child;
  }

  prepend(child: FakeEl): FakeEl {
    return this.insertBefore(child, this.firstChild);
  }

  removeChild(child: FakeEl): FakeEl {
    const i = this.children.indexOf(child);
    if (i === -1) throw new Error("NotFoundError");
    this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type: string, fn: (e: Record<string, unknown>) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.#listeners.get(type) ?? []) {
      fn({ ...event, target: event.target ?? this });
    }
  }

  setAttribute(name: string, value: string): void {
    this.#attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attrs.get(name) ?? null;
  }

  focus(): void {
    this.focused = true;
  }

  contains(node: unknown): boolean {
    let cur = node as FakeEl | null;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  closest(selector: string): FakeEl | null {
    const tags = selector.split(",").map((s) => s.trim().toUpperCase());
    let cur: FakeEl | null = this;
    while (cur) {
      if (tags.includes(cur.tagName)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}

class FakeDoc {
  #listeners = new Map<string, Array<(e: Record<string, unknown>) => void>>();

  addEventListener(type: string, fn: (e: Record<string, unknown>) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(event);
  }
}

class FakeMQ {
  matches: boolean;
  #listeners: Array<() => void> = [];

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: string, fn: () => void): void {
    this.#listeners.push(fn);
  }

  setMatches(next: boolean): void {
    this.matches = next;
    for (const fn of this.#listeners) fn();
  }
}

interface Rig {
  button: FakeEl;
  menu: FakeEl;
  nav: FakeEl;
  host: FakeEl;
  panelsHome: FakeEl;
  toolbar: FakeEl;
  buttons: Record<string, FakeEl>;
  panelsSlot: FakeEl;
  toolsSlot: FakeEl;
  doc: FakeDoc;
  mq: FakeMQ;
}

function makeRig(narrow: boolean): Rig {
  const button = new FakeEl("button", "topmenu-btn");
  const menu = new FakeEl("nav", "topmenu");
  menu.hidden = true;
  const nav = new FakeEl("nav", "panel-nav");
  const host = new FakeEl("div", "panel-host");
  const panelsHome = new FakeEl("section");
  panelsHome.appendChild(nav);
  panelsHome.appendChild(host);
  const toolbar = new FakeEl("div");
  const buttons: Record<string, FakeEl> = {};
  for (const [tag, id] of [
    ["button", "back-btn"],
    ["button", "forward-btn"],
    ["button", "new-tab-btn"],
    ["input", "address-input"],
    ["button", "go-btn"],
    ["button", "bookmark-btn"],
    ["button", "edit-toggle-btn"],
  ] as Array<[string, string]>) {
    const el = new FakeEl(tag, id);
    buttons[id] = el;
    toolbar.appendChild(el);
  }
  const panelsSlot = new FakeEl("div");
  const toolsSlot = new FakeEl("div");
  menu.appendChild(new FakeEl("h2"));
  menu.appendChild(panelsSlot);
  menu.appendChild(new FakeEl("h2"));
  menu.appendChild(toolsSlot);
  const doc = new FakeDoc();
  const mq = new FakeMQ(narrow);
  return { button, menu, nav, host, panelsHome, toolbar, buttons, panelsSlot, toolsSlot, doc, mq };
}

function init(rig: Rig): void {
  initTopMenu({
    button: rig.button as unknown as HTMLElement,
    menu: rig.menu as unknown as HTMLElement,
    nav: rig.nav as unknown as HTMLElement,
    panelsHome: rig.panelsHome as unknown as HTMLElement,
    toolbar: rig.toolbar as unknown as HTMLElement,
    toolbarButtons: ["back-btn", "forward-btn", "new-tab-btn", "bookmark-btn", "edit-toggle-btn"].map(
      (id) => rig.buttons[id] as unknown as HTMLElement,
    ),
    panelsSlot: rig.panelsSlot as unknown as HTMLElement,
    toolsSlot: rig.toolsSlot as unknown as HTMLElement,
    mediaQuery: rig.mq as unknown as MediaQueryList,
    doc: rig.doc as unknown as Document,
  });
}

test("topmenu: trigger toggles open/closed with aria-expanded", () => {
  const rig = makeRig(true);
  init(rig);
  rig.button.fire("click");
  assert.equal(rig.menu.hidden, false);
  assert.equal(rig.button.getAttribute("aria-expanded"), "true");
  rig.button.fire("click");
  assert.equal(rig.menu.hidden, true);
  assert.equal(rig.button.getAttribute("aria-expanded"), "false");
});

test("topmenu: selecting a panel button inside the menu closes it", () => {
  const rig = makeRig(true);
  init(rig);
  const panelBtn = new FakeEl("button");
  panelBtn.textContent = "Calls";
  rig.panelsSlot.appendChild(panelBtn);
  rig.button.fire("click");
  assert.equal(rig.menu.hidden, false);
  rig.menu.fire("click", { target: panelBtn });
  assert.equal(rig.menu.hidden, true);
});

test("topmenu: a tap on a nested element inside a menu button still closes it", () => {
  const rig = makeRig(true);
  init(rig);
  const panelBtn = new FakeEl("button");
  const inner = new FakeEl("span");
  panelBtn.appendChild(inner);
  rig.panelsSlot.appendChild(panelBtn);
  rig.button.fire("click");
  rig.menu.fire("click", { target: inner });
  assert.equal(rig.menu.hidden, true);
});

test("topmenu: outside tap closes, taps on the menu chrome or trigger do not", () => {
  const rig = makeRig(true);
  init(rig);
  const outside = new FakeEl("div");
  const heading = rig.menu.children[0]!;
  rig.button.fire("click");
  rig.doc.fire("click", { target: heading });
  assert.equal(rig.menu.hidden, false);
  rig.doc.fire("click", { target: rig.button });
  assert.equal(rig.menu.hidden, false);
  rig.doc.fire("click", { target: outside });
  assert.equal(rig.menu.hidden, true);
});

test("topmenu: Escape closes and returns focus to the trigger; other keys do not", () => {
  const rig = makeRig(true);
  init(rig);
  rig.button.fire("click");
  rig.doc.fire("keydown", { key: "Enter" });
  assert.equal(rig.menu.hidden, false);
  rig.doc.fire("keydown", { key: "Escape" });
  assert.equal(rig.menu.hidden, true);
  assert.equal(rig.button.focused, true);
});

test("topmenu: narrow moves the nav + toolbar actions into the menu, desktop restores the exact order", () => {
  const rig = makeRig(true);
  init(rig);
  assert.equal(rig.nav.parentNode, rig.panelsSlot);
  assert.deepEqual(
    rig.toolsSlot.children.map((c) => c.id),
    ["back-btn", "forward-btn", "new-tab-btn", "bookmark-btn", "edit-toggle-btn"],
  );
  // The address bar + Go never move.
  assert.deepEqual(
    rig.toolbar.children.map((c) => c.id),
    ["address-input", "go-btn"],
  );
  rig.mq.setMatches(false);
  assert.equal(rig.nav.parentNode, rig.panelsHome);
  assert.equal(rig.panelsHome.children[0], rig.nav);
  assert.equal(rig.panelsHome.children[1], rig.host);
  assert.deepEqual(
    rig.toolbar.children.map((c) => c.id),
    ["back-btn", "forward-btn", "new-tab-btn", "address-input", "go-btn", "bookmark-btn", "edit-toggle-btn"],
  );
});

test("topmenu: widening to desktop closes an open menu", () => {
  const rig = makeRig(true);
  init(rig);
  rig.button.fire("click");
  assert.equal(rig.menu.hidden, false);
  rig.mq.setMatches(false);
  assert.equal(rig.menu.hidden, true);
});

test("topmenu: a second init does not double-wire the trigger", () => {
  const rig = makeRig(true);
  init(rig);
  init(rig);
  assert.equal(rig.button.dataset.topmenuInit, "1");
  rig.button.fire("click");
  // Double-wired, one click would toggle twice and land closed.
  assert.equal(rig.menu.hidden, false);
});

test("topmenu: init with no document and no elements never throws", () => {
  assert.doesNotThrow(() => initTopMenu());
});
