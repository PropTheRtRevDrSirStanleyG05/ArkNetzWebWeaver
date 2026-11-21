// Tests: arknetz:// deep-link parsing + listener wiring (fix round 3).
// The OS registration itself (Tauri config / Cargo / main.rs) cannot be
// exercised by a unit test — the exact manual check is documented in
// INTEGRATION.md. What is tested here is everything above that layer:
// parsing, rejection of bad URLs, opening through the shell's tab
// navigation, and the window.__TAURI__.deepLink feature detection.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEEP_LINK_SCHEME,
  deepLinkToAddress,
  handleDeepLinkUrls,
  installDeepLinkListener,
  parseDeepLinkUrl,
} from "../src/lib/deep-link.js";
import type { TauriGlobalScope } from "../src/lib/deep-link.js";

test("parseDeepLinkUrl accepts a bare domain and a domain + path", () => {
  assert.deepEqual(parseDeepLinkUrl("arknetz://computers.edu"), { domain: "computers.edu", path: "" });
  assert.deepEqual(parseDeepLinkUrl("arknetz://computers.edu/about"), { domain: "computers.edu", path: "/about" });
  assert.deepEqual(parseDeepLinkUrl("arknetz://bakery.example/recipes/rye"), { domain: "bakery.example", path: "/recipes/rye" });
  assert.equal(parseDeepLinkUrl("arknetz://computers.edu/")?.path, "");
});

test("parseDeepLinkUrl rejects non-arknetz schemes, bad domains, credentials, garbage", () => {
  assert.equal(parseDeepLinkUrl("https://computers.edu"), null);
  assert.equal(parseDeepLinkUrl("http://computers.edu"), null);
  assert.equal(parseDeepLinkUrl("arknetz://edu"), null);
  assert.equal(parseDeepLinkUrl("arknetz://"), null);
  assert.equal(parseDeepLinkUrl("arknetz://COMPUTERS.EDU".replace("COMPUTERS", "computers").replace("EDU", "e d u")), null);
  assert.equal(parseDeepLinkUrl("arknetz://user:pass@computers.edu"), null);
  assert.equal(parseDeepLinkUrl("not a url"), null);
  assert.equal(parseDeepLinkUrl(""), null);
});

test("deepLinkToAddress round-trips through parseDeepLinkUrl", () => {
  for (const url of ["arknetz://computers.edu", "arknetz://bakery.example/recipes"]) {
    const parsed = parseDeepLinkUrl(url);
    assert.ok(parsed);
    assert.equal(deepLinkToAddress(parsed), url);
  }
  assert.equal(DEEP_LINK_SCHEME, "arknetz");
});

test("handleDeepLinkUrls opens the valid links in order and skips the rest", async () => {
  const opened: string[] = [];
  const n = await handleDeepLinkUrls(
    ["arknetz://computers.edu", "https://example.com", "arknetz://bakery.example/recipes", "garbage"],
    async (address) => {
      opened.push(address);
    },
  );
  assert.equal(n, 2);
  assert.deepEqual(opened, ["arknetz://computers.edu", "arknetz://bakery.example/recipes"]);
});

test("installDeepLinkListener reports unavailable when window.__TAURI__.deepLink is absent", async () => {
  const opened: string[] = [];
  const status = await installDeepLinkListener({} as TauriGlobalScope, async (a) => {
    opened.push(a);
  });
  assert.equal(status.status, "unavailable");
  assert.deepEqual(opened, []);
});

test("installDeepLinkListener opens startup URLs and subscribes to onOpenUrl", async () => {
  const opened: string[] = [];
  let listener: ((urls: string[]) => void) | null = null;
  const scope: TauriGlobalScope = {
    __TAURI__: {
      deepLink: {
        getCurrent: async () => ["arknetz://computers.edu/about"],
        onOpenUrl: async (cb) => {
          listener = cb;
          return () => {};
        },
      },
    },
  };
  const status = await installDeepLinkListener(scope, async (a) => {
    opened.push(a);
  });
  assert.equal(status.status, "installed");
  assert.deepEqual(opened, ["arknetz://computers.edu/about"]);
  assert.ok(listener, "onOpenUrl must have been subscribed");
  (listener as unknown as (urls: string[]) => void)(["arknetz://bakery.example"]);
  // The callback is fire-and-forget inside the listener; give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(opened, ["arknetz://computers.edu/about", "arknetz://bakery.example"]);
});

test("installDeepLinkListener reports an error when getCurrent throws, and never throws itself", async () => {
  const scope: TauriGlobalScope = {
    __TAURI__: {
      deepLink: {
        getCurrent: async () => {
          throw new Error("plugin unavailable");
        },
        onOpenUrl: async () => () => {},
      },
    },
  };
  const status = await installDeepLinkListener(scope, async () => {});
  assert.equal(status.status, "error");
  assert.match((status as { reason: string }).reason, /plugin unavailable/);
});
