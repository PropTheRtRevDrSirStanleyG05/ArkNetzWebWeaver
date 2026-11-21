// Tests: sandboxed ["app", ...] postMessage save-state bridge (§7).
// All storage is the in-memory fake — no test ever hits real GitHub, IA,
// or a real IndexedDB. The "iframe" is a fake source object + origin
// "null" (the opaque origin real srcdoc iframes have).
import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_BRIDGE_CLIENT_METHODS,
  APP_BRIDGE_VERSION,
  APP_SRCDOC_CSP,
  AppSaveBridge,
  MAX_APP_SAVE_BYTES,
  MAX_APP_SAVE_SLOTS_PER_DOMAIN,
  buildAppBridgeShim,
  createAppBridgeTokensForSite,
  createMemoryAppSaveStore,
  injectAppBridgeShim,
  installAppBridgeListener,
  isJsonValue,
  isValidRequestId,
  isValidSaveSlot,
  saveStateByteSize,
  validateAppBridgeMessage,
} from "../src/lib/viewer/app-bridge.js";
import type { AppBridgeMessageEvent } from "../src/lib/viewer/app-bridge.js";
import { renderBlock, renderSiteDocument } from "../src/lib/renderer.js";

const DOMAIN_A = "games.example";
const DOMAIN_B = "games.other";

function makeBridge(domain = DOMAIN_A) {
  const store = createMemoryAppSaveStore();
  return { store, bridge: new AppSaveBridge(store, domain) };
}

/** Drive one request through a fresh session and return the reply. */
async function call(
  bridge: AppSaveBridge,
  sid: string,
  source: object,
  data: Record<string, unknown>,
  origin = "null",
) {
  return bridge.handleMessage({ source, origin, data });
}

async function saveOk(bridge: AppSaveBridge, sid: string, source: object, slot: string, state: unknown) {
  const reply = await call(bridge, sid, source, { arknetz: 1, op: "save", slot, state, sid, requestId: `r-${slot}` });
  assert.equal(reply?.op, "saved", JSON.stringify(reply));
  return reply;
}

// --- round-trip ------------------------------------------------------------

test("save round-trips: load returns byte-identical state", async () => {
  const { bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  const state = { level: 7, hp: 42, inventory: ["sword", "potion"], pos: { x: 1.5, y: -3 }, flags: { boss: true }, notes: "héllo — ünïcode ✓" };
  await saveOk(bridge, sid, source, "slot-1", state);
  const reply = await call(bridge, sid, source, { arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r-load" });
  assert.equal(reply?.op, "loaded");
  assert.deepEqual((reply as { state: unknown }).state, state);
  // Identical bytes: serialised form of what load returned == what was saved.
  assert.equal(JSON.stringify((reply as { state: unknown }).state), JSON.stringify(state));
});

test("load of a never-saved slot returns null state, not an error", async () => {
  const { bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  const reply = await call(bridge, sid, source, { arknetz: 1, op: "load", slot: "nope", sid, requestId: "r1" });
  assert.deepEqual(reply, { arknetz: 1, op: "loaded", slot: "nope", state: null, requestId: "r1" });
});

test("save overwrites a slot; delete removes it and list tracks slots", async () => {
  const { bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  await saveOk(bridge, sid, source, "slot-1", { v: 1 });
  await saveOk(bridge, sid, source, "slot-1", { v: 2 });
  await saveOk(bridge, sid, source, "slot-2", { v: 3 });
  const listed = await call(bridge, sid, source, { arknetz: 1, op: "list", sid, requestId: "r-list" });
  assert.deepEqual((listed as { slots: string[] }).slots, ["slot-1", "slot-2"]);
  const loaded = await call(bridge, sid, source, { arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r-l2" });
  assert.deepEqual((loaded as { state: unknown }).state, { v: 2 });
  const deleted = await call(bridge, sid, source, { arknetz: 1, op: "delete", slot: "slot-1", sid, requestId: "r-del" });
  assert.equal(deleted?.op, "deleted");
  const after = await call(bridge, sid, source, { arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r-l3" });
  assert.deepEqual((after as { state: unknown }).state, null);
  const listed2 = await call(bridge, sid, source, { arknetz: 1, op: "list", sid, requestId: "r-list2" });
  assert.deepEqual((listed2 as { slots: string[] }).slots, ["slot-2"]);
});

// --- per-domain isolation ---------------------------------------------------

test("a save for domain A is not visible from domain B (same store, same slot name)", async () => {
  const store = createMemoryAppSaveStore();
  const a = new AppSaveBridge(store, DOMAIN_A);
  const b = new AppSaveBridge(store, DOMAIN_B);
  const sidA = a.createSession();
  const sidB = b.createSession();
  const srcA = {};
  const srcB = {};
  await saveOk(a, sidA, srcA, "slot-1", { secret: "A-only" });
  const fromB = await call(b, sidB, srcB, { arknetz: 1, op: "load", slot: "slot-1", sid: sidB, requestId: "r-b" });
  assert.deepEqual((fromB as { state: unknown }).state, null);
  const listB = await call(b, sidB, srcB, { arknetz: 1, op: "list", sid: sidB, requestId: "r-lb" });
  assert.deepEqual((listB as { slots: string[] }).slots, []);
  // And B writing the same slot name does not clobber A's save.
  await saveOk(b, sidB, srcB, "slot-1", { secret: "B-only" });
  const fromA = await call(a, sidA, srcA, { arknetz: 1, op: "load", slot: "slot-1", sid: sidA, requestId: "r-a2" });
  assert.deepEqual((fromA as { state: unknown }).state, { secret: "A-only" });
});

test("a message carrying another domain is dropped silently, writes nothing", async () => {
  const { store, bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  const reply = await call(bridge, sid, source, {
    arknetz: 1, op: "save", slot: "slot-1", state: { v: 1 }, sid, requestId: "r1", domain: DOMAIN_B,
  });
  assert.equal(reply, null);
  assert.equal(await store.get(DOMAIN_A, "slot-1"), undefined);
  assert.equal(await store.get(DOMAIN_B, "slot-1"), undefined);
});

// --- authentication: silent drops -------------------------------------------

test("unauthorised messages are dropped with no reply and no write", async () => {
  const { store, bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  const good = { arknetz: 1, op: "save", slot: "slot-1", state: { v: 1 }, sid, requestId: "r1" };

  // Unknown / revoked session id.
  assert.equal(await call(bridge, "00000000-0000-0000-0000-000000000000", source, { ...good, sid: "00000000-0000-0000-0000-000000000000" }), null);
  // Missing sid.
  const { sid: _s, ...noSid } = good;
  assert.equal(await call(bridge, sid, source, noSid), null);
  // Non-"null" origin (a real page / another site trying to impersonate).
  assert.equal(await call(bridge, sid, source, good, "https://evil.example"), null);
  assert.equal(await call(bridge, sid, source, good, ""), null);
  // Missing arknetz marker.
  const { arknetz: _a, ...noMarker } = good;
  assert.equal(await call(bridge, sid, source, noMarker), null);
  // Wrong marker value.
  assert.equal(await call(bridge, sid, source, { ...good, arknetz: 2 }), null);
  // Non-object payloads.
  assert.equal(await bridge.handleMessage({ source, origin: "null", data: "save slot-1" }), null);
  assert.equal(await bridge.handleMessage({ source, origin: "null", data: null }), null);
  assert.equal(await bridge.handleMessage({ source, origin: "null", data: ["save"] }), null);

  assert.equal(await store.get(DOMAIN_A, "slot-1"), undefined);
});

test("a session bound to one iframe source rejects a different source reusing its sid", async () => {
  const { bridge } = makeBridge();
  const sid = bridge.createSession();
  const iframeA = {};
  const iframeB = {};
  await saveOk(bridge, sid, iframeA, "slot-1", { v: 1 }); // binds iframeA
  const reply = await call(bridge, sid, iframeB, { arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r-x" });
  assert.equal(reply, null);
  // The bound source still works.
  const ok = await call(bridge, sid, iframeA, { arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r-y" });
  assert.deepEqual((ok as { state: unknown }).state, { v: 1 });
});

test("revoked sessions are dropped", async () => {
  const { bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  await saveOk(bridge, sid, source, "slot-1", { v: 1 });
  assert.equal(bridge.revokeSession(sid), true);
  assert.equal(bridge.sessionCount(), 0);
  const reply = await call(bridge, sid, source, { arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r1" });
  assert.equal(reply, null);
});

test("replies never contain the session id, a token, or a key", async () => {
  const { bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  const replies = [
    await saveOk(bridge, sid, source, "slot-1", { v: 1 }),
    await call(bridge, sid, source, { arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r2" }),
    await call(bridge, sid, source, { arknetz: 1, op: "list", sid, requestId: "r3" }),
    await call(bridge, sid, source, { arknetz: 1, op: "save", slot: "../x", state: {}, sid, requestId: "r4" }),
  ];
  for (const reply of replies) {
    const text = JSON.stringify(reply);
    assert.ok(!text.includes(sid), `reply leaks sid: ${text}`);
    assert.ok(!/token|secret|indexeddb|localstorage|github|oauth/i.test(text), `reply leaks capability: ${text}`);
  }
});

// --- malformed / oversized: authenticated, so error replies, no writes -------

test("malformed messages get error replies and write nothing", async () => {
  const { store, bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  const cases: Array<{ data: Record<string, unknown>; error: string }> = [
    { data: { arknetz: 1, op: "explode", sid, requestId: "r1" }, error: "bad_op" },
    { data: { arknetz: 1, op: "save", slot: "slot-1", state: {}, sid }, error: "bad_request_id" },
    { data: { arknetz: 1, op: "save", slot: "slot-1", state: {}, sid, requestId: "bad id!" }, error: "bad_request_id" },
    { data: { arknetz: 1, op: "save", slot: "../escape", state: {}, sid, requestId: "r2" }, error: "bad_slot" },
    { data: { arknetz: 1, op: "save", slot: "has space", state: {}, sid, requestId: "r3" }, error: "bad_slot" },
    { data: { arknetz: 1, op: "save", slot: "", state: {}, sid, requestId: "r4" }, error: "bad_slot" },
    { data: { arknetz: 1, op: "save", slot: "a".repeat(65), state: {}, sid, requestId: "r5" }, error: "bad_slot" },
    { data: { arknetz: 1, op: "save", slot: "slot-1", sid, requestId: "r6" }, error: "state_not_json" },
    { data: { arknetz: 1, op: "load", sid, requestId: "r7" }, error: "bad_slot" },
    { data: { arknetz: 1, op: "delete", slot: "slot-1;DROP", sid, requestId: "r8" }, error: "bad_slot" },
  ];
  for (const { data, error } of cases) {
    const reply = await call(bridge, sid, source, data);
    assert.equal(reply?.op, "error", JSON.stringify(reply));
    assert.equal((reply as { error: string }).error, error, JSON.stringify(reply));
    // A valid requestId is echoed; a missing/malformed one is never
    // echoed back (null) — the parent never parrots attacker input.
    const expectedId = isValidRequestId(data.requestId) ? (data.requestId as string) : null;
    assert.equal((reply as { requestId: unknown }).requestId, expectedId);
  }
  assert.deepEqual(await store.list(DOMAIN_A), []);
  // Slot validation itself: boundary names.
  assert.equal(isValidSaveSlot("slot-1"), true);
  assert.equal(isValidSaveSlot("A"), true);
  assert.equal(isValidSaveSlot("a".repeat(64)), true);
  assert.equal(isValidSaveSlot("a".repeat(65)), false);
  assert.equal(isValidSaveSlot("../x"), false);
  assert.equal(isValidSaveSlot("a.b"), false);
  assert.equal(isValidSaveSlot(""), false);
});

test("non-JSON state is rejected: functions, bigint, circular, __proto__", async () => {
  const { store, bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  const circular: Record<string, unknown> = { v: 1 };
  circular.self = circular;
  const badStates: unknown[] = [
    () => 1,
    10n,
    undefined,
    circular,
    { __proto__: { polluted: true } },
    new Date(),
    new Map([["a", 1]]),
    Symbol("x"),
  ];
  for (const [i, state] of badStates.entries()) {
    const reply = await call(bridge, sid, source, { arknetz: 1, op: "save", slot: "slot-1", state, sid, requestId: `r-bad-${i}` });
    assert.equal((reply as { error: string }).error, "state_not_json", `state ${i} was not rejected: ${JSON.stringify(reply)}`);
  }
  assert.equal(await store.get(DOMAIN_A, "slot-1"), undefined);
  assert.equal(isJsonValue({ a: [1, "x", null, true] }), true);
  assert.equal(isJsonValue(Number.NaN), false);
  assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false);
  assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false, "no prototype pollution from the __proto__ attempt");
});

test("oversized state is rejected; exactly at the cap is accepted", async () => {
  const { store, bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  // JSON form is {"pad":"..."} — 10 chars of overhead, so pad to cap-10.
  const atCap = "x".repeat(MAX_APP_SAVE_BYTES - 10);
  assert.equal(saveStateByteSize({ pad: atCap }), MAX_APP_SAVE_BYTES);
  const ok = await call(bridge, sid, source, { arknetz: 1, op: "save", slot: "slot-1", state: { pad: atCap }, sid, requestId: "r-cap" });
  assert.equal(ok?.op, "saved", JSON.stringify(ok));
  const over = "x".repeat(MAX_APP_SAVE_BYTES - 9);
  const tooBig = await call(bridge, sid, source, { arknetz: 1, op: "save", slot: "slot-2", state: { pad: over }, sid, requestId: "r-over" });
  assert.equal((tooBig as { error: string }).error, "state_too_large");
  assert.equal(await store.get(DOMAIN_A, "slot-2"), undefined);
  // The at-cap slot still holds its exact bytes.
  assert.equal((await store.get(DOMAIN_A, "slot-1"))?.length, MAX_APP_SAVE_BYTES);
});

test("slot-count cap: the 17th new slot is rejected, overwrites still work", async () => {
  const { bridge } = makeBridge();
  const sid = bridge.createSession();
  const source = {};
  for (let i = 0; i < MAX_APP_SAVE_SLOTS_PER_DOMAIN; i++) {
    await saveOk(bridge, sid, source, `slot-${i}`, { i });
  }
  const extra = await call(bridge, sid, source, { arknetz: 1, op: "save", slot: "slot-extra", state: { i: 99 }, sid, requestId: "r-x" });
  assert.equal((extra as { error: string }).error, "too_many_slots");
  // Overwriting an existing slot is not a new slot, so it still works.
  await saveOk(bridge, sid, source, "slot-0", { i: 100 });
});

test("validateAppBridgeMessage accepts the PROTOCOL.md §7 wire shape", () => {
  const ok = validateAppBridgeMessage(
    { arknetz: 1, op: "save", slot: "slot-1", state: { a: 1 }, sid: "abc", requestId: "r1" },
    DOMAIN_A,
  );
  assert.equal(ok.ok, true);
  const load = validateAppBridgeMessage({ arknetz: 1, op: "load", slot: "slot-1", requestId: "r2" }, DOMAIN_A);
  assert.equal(load.ok, true);
  assert.equal(validateAppBridgeMessage({ arknetz: 1, op: "load", slot: "slot-1", requestId: "r3", domain: DOMAIN_B }, DOMAIN_A).ok, false);
});

// --- iframe-facing surface ----------------------------------------------------

test("the iframe-facing API exposes only save/load/delete/list — no token/key/IndexedDB access", () => {
  assert.deepEqual([...APP_BRIDGE_CLIENT_METHODS], ["save", "load", "delete", "list"]);
  assert.equal(APP_BRIDGE_VERSION, 1);
  const shim = buildAppBridgeShim("11111111-2222-4333-8444-555555555555");
  // Exactly one object is exposed on window, with exactly four methods.
  // (The literal contains nested braces, so match each method entry
  // directly rather than trying to regex out the whole literal.)
  assert.equal((shim.match(/window\.ArkNetzSave=\{/g) ?? []).length, 1, "shim must define window.ArkNetzSave once");
  for (const method of ["save:function(slot,state)", "load:function(slot)", "delete:function(slot)", "list:function()"]) {
    assert.ok(shim.includes(method), `shim must expose ArkNetzSave.${method}`);
  }
  assert.ok(!/window\.ArkNetzSave\.\w+\s*=/.test(shim), "nothing else may hang off window.ArkNetzSave");
  // No capability words anywhere in the shim source.
  for (const forbidden of ["indexedDB", "localStorage", "sessionStorage", "fetch(", "XMLHttpRequest", "document.cookie", "OAuth", "github", "apiKey", "secret", "token"]) {
    assert.ok(!shim.toLowerCase().includes(forbidden.toLowerCase()), `shim contains forbidden ${forbidden}`);
  }
  // The session id is in a closure variable, never as a readable property.
  assert.ok(!shim.includes("ArkNetzSave.sid") && !shim.includes("ArkNetzSave.token"));
  assert.ok(!/window\.\w*(token|key|secret)/i.test(shim));
  assert.throws(() => buildAppBridgeShim("bad sid!!"), /invalid app-bridge session id/);
});

test("injectAppBridgeShim adds the shim + strict CSP meta, and leaves a plain srcdoc untouched otherwise", () => {
  const srcdoc = "<!doctype html><html><head><title>G</title></head><body><p>play</p></body></html>";
  const sid = "11111111-2222-4333-8444-555555555555";
  const out = injectAppBridgeShim(srcdoc, sid);
  assert.ok(out.includes("window.ArkNetzSave"), "shim missing");
  assert.ok(out.includes(sid), "shim must carry its session id");
  assert.ok(out.includes(APP_SRCDOC_CSP), "CSP meta missing");
  assert.ok(out.includes("default-src 'none'"), "CSP must start default-src 'none'");
  assert.ok(out.includes("<p>play</p>"), "original bundle must survive injection");
  // A fragment with no html/body still gets the shim appended.
  const frag = injectAppBridgeShim("<p>hi</p>", sid);
  assert.ok(frag.startsWith("<p>hi</p>") && frag.includes("window.ArkNetzSave"));
});

// --- renderer integration -----------------------------------------------------

test("renderer injects the bridge only when a session id is supplied; sandbox + CSP survive", () => {
  const block = { type: "app" as const, appSrcdoc: "<!doctype html><p>game</p>" };
  const sid = "11111111-2222-4333-8444-555555555555";
  const withBridge = renderBlock(block, { appBridgeToken: sid });
  assert.match(withBridge, /<iframe[^>]*sandbox="allow-scripts allow-pointer-lock"/);
  assert.match(withBridge, /referrerpolicy="no-referrer"/);
  assert.ok(withBridge.includes("window.ArkNetzSave"), "bridged app must carry the shim");
  assert.ok(withBridge.includes("Content-Security-Policy"), "bridged app must carry the CSP meta");
  assert.ok(!withBridge.includes("<script>alert"), "srcdoc must stay attribute-escaped");

  const withoutBridge = renderBlock(block);
  assert.match(withoutBridge, /sandbox="allow-scripts allow-pointer-lock"/);
  assert.ok(!withoutBridge.includes("ArkNetzSave"), "no session id => no shim, no save API");

  // Per-block tokens win over the fallback; URL apps never get a shim.
  const docHtml = renderSiteDocument(
    { domain: DOMAIN_A, title: "T", blocks: [{ type: "app", id: "b1", appSrcdoc: "<p>a</p>" }, { type: "app", id: "b2", appSrcdoc: "<p>b</p>" }] },
    { appBridgeTokens: new Map([["b1", sid]]) },
  );
  assert.equal((docHtml.match(/ArkNetzSave/g) ?? []).length, 1, "only the block with a token gets a shim");
  const urlApp = renderBlock({ type: "app", appSrc: "https://example.com/game.html" }, { appBridgeToken: sid });
  assert.ok(!urlApp.includes("ArkNetzSave"), "URL-sourced apps get no bridge shim");

  // A malformed token is a loud error, never a silently broken shim.
  assert.throws(() => renderBlock(block, { appBridgeToken: "bad sid!!" }), /invalid app-bridge session id/);
});

// --- parent-side listener adapter ----------------------------------------------

test("installAppBridgeListener routes messages and posts replies to the iframe window", async () => {
  const { bridge } = makeBridge();
  const sid = bridge.createSession();
  const iframeWindow = {};
  const posted: unknown[] = [];
  const listeners = new Map<string, Array<(e: AppBridgeMessageEvent) => void>>();
  const fakeWindow = {
    addEventListener: (type: "message", fn: (e: AppBridgeMessageEvent) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: "message", fn: (e: AppBridgeMessageEvent) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };
  const uninstall = installAppBridgeListener(bridge, fakeWindow, () => ({
    postMessage: (message: unknown) => {
      posted.push(message);
    },
  }));
  const emit = (data: unknown) => {
    for (const fn of listeners.get("message") ?? []) fn({ source: iframeWindow, origin: "null", data });
  };
  emit({ arknetz: 1, op: "save", slot: "slot-1", state: { v: 5 }, sid, requestId: "r1" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(posted, [{ arknetz: 1, op: "saved", slot: "slot-1", requestId: "r1" }]);
  emit({ arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r2" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(posted[1], { arknetz: 1, op: "loaded", slot: "slot-1", state: { v: 5 }, requestId: "r2" });
  // Unauthorised traffic gets no reply at all.
  emit({ arknetz: 1, op: "load", slot: "slot-1", sid: "bogus-bogus-bogus-bogus", requestId: "r3" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted.length, 2);
  uninstall();
  emit({ arknetz: 1, op: "load", slot: "slot-1", sid, requestId: "r4" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted.length, 2, "listener must stop after uninstall");
});

// --- store namespacing, direct -------------------------------------------------

test("memory store keys are namespaced by domain", async () => {
  const store = createMemoryAppSaveStore();
  await store.put(DOMAIN_A, "slot-1", '{"v":1}');
  await store.put(DOMAIN_B, "slot-1", '{"v":2}');
  assert.equal(await store.get(DOMAIN_A, "slot-1"), '{"v":1}');
  assert.equal(await store.get(DOMAIN_B, "slot-1"), '{"v":2}');
  assert.deepEqual(await store.list(DOMAIN_A), ["slot-1"]);
  await store.delete(DOMAIN_A, "slot-1");
  assert.equal(await store.get(DOMAIN_A, "slot-1"), undefined);
  assert.equal(await store.get(DOMAIN_B, "slot-1"), '{"v":2}');
});

// --- shell wiring helper -----------------------------------------------------

test("createAppBridgeTokensForSite issues one session per id'd srcdoc app block only", () => {
  const { bridge } = makeBridge();
  const site = {
    domain: DOMAIN_A,
    title: "t",
    blocks: [
      { type: "app", id: "game-1", appSrcdoc: "<html></html>" },
      { type: "app", id: "game-2", appSrcdoc: "<html></html>" },
      { type: "app", id: "game-1", appSrcdoc: "<html></html>" },
      { type: "app", id: "remote", appSrc: "https://archive.org/download/x/game.html" },
      { type: "app", appSrcdoc: "<html></html>" },
      { type: "p", text: "hello" },
      { type: "cols", columns: [[{ type: "app", id: "nested", appSrcdoc: "<html></html>" }]] },
    ],
    header: [{ type: "app", id: "head-game", appSrcdoc: "<html></html>" }],
  } as never;
  const tokens = createAppBridgeTokensForSite(bridge, site);
  assert.deepEqual([...tokens.keys()].sort(), ["game-1", "game-2", "head-game", "nested"]);
  assert.equal(new Set(tokens.values()).size, 4, "one distinct session per block, never shared");
  for (const sid of tokens.values()) assert.equal(bridge.hasSession(sid), true);
});
