// Tests: ToS acceptance timestamp display (fix agent C, bug P2) —
// the raw ISO value stays in storage; only the display is human-readable.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryTosStore,
  formatAcceptanceDate,
  recordAcceptance,
  tosAcceptanceStatusLine,
} from "../src/lib/network/tos.js";
import { tosAcceptanceView } from "../src/lib/network/accounts-ui.js";

const RAW = "2026-11-21T03:13:38.872Z";

test("tos-ui: formatAcceptanceDate shows a human date, never the raw ISO string", () => {
  const shown = formatAcceptanceDate(RAW);
  assert.notEqual(shown, RAW);
  assert.doesNotMatch(shown, /T\d\d:/);
  assert.doesNotMatch(shown, /Z$/);
  assert.match(shown, /2026/);
  // Month name + day + time, e.g. "Nov 21, 2026, 3:13 AM".
  assert.match(shown, /[A-Za-z]{3,}/);
});

test("tos-ui: formatAcceptanceDate returns an unparseable value as-is instead of throwing", () => {
  assert.equal(formatAcceptanceDate("not-a-date"), "not-a-date");
});

test("tos-ui: storage still keeps the raw ISO timestamp", async () => {
  const store = createMemoryTosStore();
  const acceptance = await recordAcceptance(store, "guest", "first-sign-in", new Date(RAW));
  assert.equal(acceptance.acceptedAt, RAW);
  assert.equal(store.peek("guest")?.acceptedAt, RAW);
});

test("tos-ui: the acceptance status line uses the human date", async () => {
  const store = createMemoryTosStore();
  const acceptance = await recordAcceptance(store, "guest", "first-sign-in", new Date(RAW));
  const line = tosAcceptanceStatusLine(acceptance);
  assert.match(line, /^Accepted /);
  assert.match(line, /recorded on this device\.$/);
  assert.doesNotMatch(line, /T03:13:38/);
  assert.match(line, /2026/);
});

test("tos-ui: tosAcceptanceView carries both the raw value and the human display", async () => {
  const store = createMemoryTosStore();
  const acceptance = await recordAcceptance(store, "guest", "first-sign-in", new Date(RAW));
  const vm = tosAcceptanceView(acceptance);
  assert.equal(vm.accepted, true);
  assert.equal(vm.acceptedAt, RAW);
  assert.ok(vm.acceptedAtDisplay);
  assert.notEqual(vm.acceptedAtDisplay, RAW);
  assert.match(vm.acceptedAtDisplay, /2026/);

  const none = tosAcceptanceView(null);
  assert.equal(none.accepted, false);
  assert.equal(none.acceptedAt, null);
  assert.equal(none.acceptedAtDisplay, null);
});
