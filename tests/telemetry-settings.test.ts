// Tests: telemetry-settings store (integration pass) + the app-level
// accessors the Stats/Backends panels read through. No network, no DOM:
// the memory store is the store under test here (the IndexedDB store
// follows the same shape as the IA-account store and throws without
// IndexedDB, like every other IndexedDB store in the app).
import test from "node:test";
import assert from "node:assert/strict";
import { createArkNetzApp } from "../src/lib/app.js";
import {
  createMemoryTelemetrySettingsStore,
  defaultTelemetrySettings,
  normalizeTelemetrySettings,
} from "../src/lib/viewer/stats.js";

const throwingFetch = (() => {
  throw new Error("no network in tests");
}) as unknown as typeof fetch;

test("telemetry settings: memory store round-trips, defaults when empty", async () => {
  const store = createMemoryTelemetrySettingsStore();
  assert.deepEqual(await store.get(), defaultTelemetrySettings());
  await store.set({ strictOffline: true, publicViewCounter: true, allowIaPlayCounts: false });
  assert.deepEqual(await store.get(), { strictOffline: true, publicViewCounter: true, allowIaPlayCounts: false });
  assert.deepEqual(store.peek(), { strictOffline: true, publicViewCounter: true, allowIaPlayCounts: false });
});

test("telemetry settings: normalize falls back per-field, never invents telemetry-on", () => {
  assert.deepEqual(normalizeTelemetrySettings(null), defaultTelemetrySettings());
  assert.deepEqual(normalizeTelemetrySettings("junk"), defaultTelemetrySettings());
  assert.deepEqual(normalizeTelemetrySettings({ strictOffline: true }), {
    strictOffline: true,
    publicViewCounter: false,
    allowIaPlayCounts: true,
  });
  assert.deepEqual(normalizeTelemetrySettings({ publicViewCounter: "yes" }), defaultTelemetrySettings());
});

test("app: telemetry accessors share one source — set is visible synchronously and survives a reload", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  assert.deepEqual(app.getTelemetrySettings(), defaultTelemetrySettings());
  const next = { strictOffline: true, publicViewCounter: false, allowIaPlayCounts: true };
  app.setTelemetrySettings(next);
  // Synchronous mirror: a panel re-rendered right after the toggle
  // sees the new value without awaiting the store write.
  assert.deepEqual(app.getTelemetrySettings(), next);
  assert.deepEqual(await app.loadTelemetrySettings(), next);
  assert.deepEqual(await app.telemetrySettingsStore.get(), next);
});

test("app: getSiteStats is honestly empty until a stats loader exists", () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const stats = app.getSiteStats("welcome.arknetz");
  assert.equal(stats.domain, "welcome.arknetz");
  assert.equal(stats.totalViews, 0);
  assert.deepEqual(stats.views, {});
  assert.deepEqual(app.getProjectFlags(), {});
  assert.deepEqual(app.getLastMirrorAttempts(), []);
});

test("app: getLinkedBackends maps keyring profiles to backend prefixes, ipfs never linked", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  assert.deepEqual(app.getLinkedBackends(), {});
  await app.keyring.unlock("correct horse battery staple");
  await app.keyring.addAccount(
    "github",
    { id: "alice", label: "alice (GitHub)", username: "alice" },
    { kind: "token", token: "t1" },
  );
  await app.keyring.addAccount(
    "internet_archive",
    { id: "ia-edu", label: "alice@archive.org" },
    { kind: "s3keys", accessKey: "A", secretKey: "S" },
  );
  assert.deepEqual(app.getLinkedBackends(), { gh: "alice (GitHub)", ia: "alice@archive.org" });
});
