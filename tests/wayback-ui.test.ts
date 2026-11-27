// Tests: Time Machine lookup UI (fix agent C, bug B6) — loading state,
// plain-language errors with retry, and correct CDX parsing.
// No real network: every fetch is injected. DOM wiring is exercised
// through a minimal fake element (no jsdom in this repo).
import test from "node:test";
import assert from "node:assert/strict";
import {
  WAYBACK_RETRY_BUTTON_ID,
  WAYBACK_UNREACHABLE_MESSAGE,
  runWaybackLookup,
  waybackLookupErrorMessage,
  waybackLookupHtml,
  wireWaybackPanel,
} from "../src/lib/network/wayback-ui.js";
import type { NetworkFetch, NetworkResponse } from "../src/lib/network/backends.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Minimal fake element: id-indexed children, innerHTML id scan, click. */
class FakeEl {
  textContent = "";
  disabled = false;
  value = "";
  #html = "";
  #listeners = new Map<string, Array<() => void>>();
  #children = new Map<string, FakeEl>();

  constructor(public readonly id = "") {}

  get innerHTML(): string {
    return this.#html;
  }
  set innerHTML(v: string) {
    this.#html = v;
    this.#children.clear();
    for (const m of v.matchAll(/id="([^"]+)"/g)) {
      const childId = m[1]!;
      if (!this.#children.has(childId)) this.#children.set(childId, new FakeEl(childId));
    }
  }

  querySelector<T>(selector: string): T | null {
    const m = /^#([\w-]+)$/.exec(selector);
    if (!m) return null;
    const id = m[1]!;
    const direct = this.#children.get(id);
    if (direct) return direct as unknown as T;
    for (const child of this.#children.values()) {
      const found = child.querySelector<T>(selector);
      if (found) return found;
    }
    return null;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }

  click(): void {
    for (const fn of this.#listeners.get("click") ?? []) fn();
  }
}

function mockFetch(status: number, body: string): NetworkFetch {
  return (async () => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  })) as NetworkFetch;
}

const CDX_OK = JSON.stringify([
  ["timestamp", "original", "statuscode", "mimetype", "digest"],
  ["20261120120000", "https://example.com/site.json.zst", "200", "application/octet-stream", "abc123"],
  ["20261119120000", "https://example.com/site.json.zst", "200", "application/octet-stream", "def456"],
]);
const CDX_EMPTY = JSON.stringify([
  ["timestamp", "original", "statuscode", "mimetype", "digest"],
]);
const URL = "https://example.com/site.json.zst";

// --- Error messages ---------------------------------------------------------

test("wayback-ui: 'Failed to fetch' becomes the plain-language unreachable message", () => {
  assert.equal(
    waybackLookupErrorMessage(new TypeError("Failed to fetch")),
    WAYBACK_UNREACHABLE_MESSAGE,
  );
  assert.equal(
    waybackLookupErrorMessage(new Error("Failed to fetch")),
    WAYBACK_UNREACHABLE_MESSAGE,
  );
  assert.match(WAYBACK_UNREACHABLE_MESSAGE, /Could not reach archive\.org/);
  assert.match(WAYBACK_UNREACHABLE_MESSAGE, /check your connection and try again/);
  // Hunt 5 (P1): the lookup now goes through the Rust `wayback_fetch`
  // command, so a failure genuinely means the network or archive.org
  // itself — the message must not blame an app-side block any more.
  assert.match(WAYBACK_UNREACHABLE_MESSAGE, /archive\.org itself may be down/);
  assert.doesNotMatch(WAYBACK_UNREACHABLE_MESSAGE, /needs an app update to fix/);
});

test("wayback-ui: HTTP statuses get plain-language explanations, not bare codes", () => {
  assert.match(waybackLookupErrorMessage(new Error("HTTP 429")), /rate-limiting.*wait a few minutes/);
  assert.match(waybackLookupErrorMessage(new Error("HTTP 503")), /probably temporary.*try again/);
  assert.match(waybackLookupErrorMessage(new Error("HTTP 404")), /check the URL/);
  assert.doesNotMatch(waybackLookupErrorMessage(new Error("HTTP 429")), /^HTTP 429$/);
});

test("wayback-ui: already-plain errors (arknetz:// validation) pass through", () => {
  const msg = waybackLookupErrorMessage(
    new Error('Wayback Machine cannot archive "arknetz://x" — it archives public https:// URLs only'),
  );
  assert.match(msg, /archives public https:\/\/ URLs only/);
});

// --- Async lookup -----------------------------------------------------------

test("wayback-ui: runWaybackLookup parses real CDX array rows into results", async () => {
  const state = await runWaybackLookup(URL, mockFetch(200, CDX_OK));
  assert.equal(state.status, "results");
  if (state.status !== "results") return;
  assert.equal(state.view.count, 2);
  assert.equal(state.view.latest?.displayDate, "2026-11-20 12:00 UTC");
});

test("wayback-ui: runWaybackLookup with no snapshots is an honest empty state", async () => {
  const state = await runWaybackLookup(URL, mockFetch(200, CDX_EMPTY));
  assert.equal(state.status, "empty");
  if (state.status !== "empty") return;
  assert.match(state.note, /No Wayback Machine snapshots exist/);
});

test("wayback-ui: runWaybackLookup never throws — a dead network is an error state with retry", async () => {
  const throwing: NetworkFetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as NetworkFetch;
  const state = await runWaybackLookup(URL, throwing);
  assert.equal(state.status, "error");
  if (state.status !== "error") return;
  assert.equal(state.message, WAYBACK_UNREACHABLE_MESSAGE);
  assert.equal(state.retryable, true);
});

test("wayback-ui: runWaybackLookup turns a CDX HTTP 500 into a plain-language error", async () => {
  const state = await runWaybackLookup(URL, mockFetch(500, "boom"));
  assert.equal(state.status, "error");
  if (state.status !== "error") return;
  assert.match(state.message, /probably temporary/);
});

// --- Results HTML -----------------------------------------------------------

test("wayback-ui: loading HTML says what is happening; error HTML has a Retry button", () => {
  const loading = waybackLookupHtml({ status: "loading", url: URL });
  assert.match(loading, /Looking up snapshots on archive\.org/);
  assert.doesNotMatch(loading, /Retry/);

  const error = waybackLookupHtml({
    status: "error",
    url: URL,
    message: WAYBACK_UNREACHABLE_MESSAGE,
    retryable: true,
  });
  assert.match(error, /Could not reach archive\.org/);
  assert.match(error, new RegExp(WAYBACK_RETRY_BUTTON_ID));
  assert.match(error, /Retry lookup/);

  const idle = waybackLookupHtml({ status: "idle" });
  assert.equal(idle, "");
});

// --- DOM wiring -------------------------------------------------------------

function wiredRoot(fetchFn: NetworkFetch, opened: string[]): FakeEl {
  const root = new FakeEl("root");
  root.innerHTML =
    `<label>Public URL to look up <input id="an-wayback-url" type="text"></label>` +
    `<button id="an-wayback-btn" type="button">Look up snapshots</button>` +
    `<button id="an-wayback-save-btn" type="button">Snapshot now (Save Page Now)</button>` +
    `<div id="an-wayback-results" role="status"></div>`;
  wireWaybackPanel(root as unknown as HTMLElement, fetchFn, {
    openSavePageNow: (url) => {
      opened.push(url);
    },
  });
  return root;
}

test("wayback-ui: wiring disables the button + shows loading while fetching, then results", async () => {
  let resolveFetch!: (v: NetworkResponse) => void;
  const pending = new Promise<NetworkResponse>((r) => {
    resolveFetch = r;
  });
  const fetchFn = (() => pending) as NetworkFetch;
  const root = wiredRoot(fetchFn, []);
  const btn = root.querySelector<FakeEl>("#an-wayback-btn")!;
  const input = root.querySelector<FakeEl>("#an-wayback-url")!;
  const out = root.querySelector<FakeEl>("#an-wayback-results")!;
  input.value = URL;
  btn.click();
  await flush();
  assert.equal(btn.disabled, true);
  assert.equal(btn.textContent, "Looking up…");
  assert.match(out.innerHTML, /Looking up snapshots on archive\.org/);

  resolveFetch({
    status: 200,
    headers: { get: () => null },
    text: async () => CDX_OK,
  } as NetworkResponse);
  await flush();
  await flush();
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "Look up snapshots");
  assert.match(out.innerHTML, /2026-11-20 12:00 UTC/);
  assert.match(out.innerHTML, /web\.archive\.org\/web\/20261120120000\//);
});

test("wayback-ui: wiring shows the plain-language error + a working Retry button on failure", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  }) as NetworkFetch;
  const root = wiredRoot(fetchFn, []);
  const btn = root.querySelector<FakeEl>("#an-wayback-btn")!;
  const input = root.querySelector<FakeEl>("#an-wayback-url")!;
  const out = root.querySelector<FakeEl>("#an-wayback-results")!;
  input.value = URL;
  btn.click();
  await flush();
  await flush();
  assert.match(out.innerHTML, /Could not reach archive\.org/);
  assert.equal(btn.disabled, false);

  const retry = root.querySelector<FakeEl>(`#${WAYBACK_RETRY_BUTTON_ID}`)!;
  assert.ok(retry, "retry button is rendered");
  retry.click();
  await flush();
  await flush();
  assert.equal(calls, 2);
  assert.match(out.innerHTML, /Could not reach archive\.org/);
});

test("wayback-ui: wiring asks for a URL first instead of fetching an empty string", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return { status: 200, headers: { get: () => null }, text: async () => CDX_OK } as NetworkResponse;
  }) as NetworkFetch;
  const root = wiredRoot(fetchFn, []);
  root.querySelector<FakeEl>("#an-wayback-btn")!.click();
  await flush();
  assert.equal(calls, 0);
  assert.match(
    root.querySelector<FakeEl>("#an-wayback-results")!.innerHTML,
    /Enter a public https:\/\/ URL first/,
  );
});

test("wayback-ui: Save Page Now opens the save URL; arknetz:// gets a plain-language refusal", async () => {
  const opened: string[] = [];
  const root = wiredRoot(mockFetch(200, CDX_OK), opened);
  const input = root.querySelector<FakeEl>("#an-wayback-url")!;
  const out = root.querySelector<FakeEl>("#an-wayback-results")!;
  const saveBtn = root.querySelector<FakeEl>("#an-wayback-save-btn")!;

  input.value = URL;
  saveBtn.click();
  assert.deepEqual(opened, [`https://web.archive.org/save/${URL}`]);
  assert.match(out.innerHTML, /Opened Save Page Now/);

  input.value = "arknetz://computers.edu";
  saveBtn.click();
  assert.equal(opened.length, 1);
  assert.match(out.innerHTML, /archives public https:\/\/ URLs only/);
});
