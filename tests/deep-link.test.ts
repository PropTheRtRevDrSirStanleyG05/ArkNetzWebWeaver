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
  isOAuthCallbackUrl,
  parseDeepLinkUrl,
} from "../src/lib/deep-link.js";
import type { TauriGlobalScope } from "../src/lib/deep-link.js";

test("isOAuthCallbackUrl matches only arknetz://oauth/callback", () => {
  assert.equal(isOAuthCallbackUrl("arknetz://oauth/callback?code=C&state=S"), true);
  assert.equal(isOAuthCallbackUrl("arknetz://oauth/callback"), true);
  assert.equal(isOAuthCallbackUrl("arknetz://oauth/callback/"), false);
  assert.equal(isOAuthCallbackUrl("arknetz://oauth"), false);
  assert.equal(isOAuthCallbackUrl("arknetz://oauth/other"), false);
  assert.equal(isOAuthCallbackUrl("arknetz://computers.edu"), false);
  assert.equal(isOAuthCallbackUrl("https://oauth/callback"), false);
  assert.equal(isOAuthCallbackUrl("not a url"), false);
});

test("the callback URL is not a site link (parseDeepLinkUrl rejects it)", () => {
  // "oauth" is a single label, so isValidDomain fails — the callback
  // would be silently dropped if the router did not intercept it first.
  assert.equal(parseDeepLinkUrl("arknetz://oauth/callback?code=C&state=S"), null);
});

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

test("handleDeepLinkUrls intercepts the OAuth callback and never sends it to the site resolver", async () => {
  const opened: string[] = [];
  const callbacks: string[] = [];
  const n = await handleDeepLinkUrls(
    [
      "arknetz://computers.edu",
      "arknetz://oauth/callback?code=C&state=S",
      "arknetz://bakery.example/recipes",
    ],
    async (address) => {
      opened.push(address);
    },
    {
      onOAuthCallback: async (url) => {
        callbacks.push(url);
      },
    },
  );
  assert.equal(n, 3);
  assert.deepEqual(opened, ["arknetz://computers.edu", "arknetz://bakery.example/recipes"]);
  assert.deepEqual(callbacks, ["arknetz://oauth/callback?code=C&state=S"]);
});

test("handleDeepLinkUrls without a callback handler still counts the callback as handled, not as a site", async () => {
  const opened: string[] = [];
  const n = await handleDeepLinkUrls(
    ["arknetz://oauth/callback?code=C&state=S"],
    async (address) => {
      opened.push(address);
    },
  );
  assert.equal(n, 1);
  assert.deepEqual(opened, []);
});

test("handleDeepLinkUrls survives a throwing callback handler (listener keeps working)", async () => {
  const opened: string[] = [];
  const n = await handleDeepLinkUrls(
    ["arknetz://oauth/callback?code=C&state=S", "arknetz://computers.edu"],
    async (address) => {
      opened.push(address);
    },
    {
      onOAuthCallback: async () => {
        throw new Error("state mismatch");
      },
    },
  );
  assert.equal(n, 2);
  assert.deepEqual(opened, ["arknetz://computers.edu"]);
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

test("installDeepLinkListener routes startup and live OAuth callbacks to the handler, not to tabs", async () => {
  const opened: string[] = [];
  const callbacks: string[] = [];
  let listener: ((urls: string[]) => void) | null = null;
  const scope: TauriGlobalScope = {
    __TAURI__: {
      deepLink: {
        getCurrent: async () => ["arknetz://oauth/callback?code=C1&state=S"],
        onOpenUrl: async (cb) => {
          listener = cb;
          return () => {};
        },
      },
    },
  };
  const status = await installDeepLinkListener(
    scope,
    async (a) => {
      opened.push(a);
    },
    {
      onOAuthCallback: async (url) => {
        callbacks.push(url);
      },
    },
  );
  assert.equal(status.status, "installed");
  assert.equal((status as { startupOpened: number }).startupOpened, 1);
  assert.deepEqual(opened, []);
  assert.deepEqual(callbacks, ["arknetz://oauth/callback?code=C1&state=S"]);
  assert.ok(listener, "onOpenUrl must have been subscribed");
  (listener as unknown as (urls: string[]) => void)([
    "arknetz://oauth/callback?code=C2&state=S",
    "arknetz://computers.edu",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(callbacks, [
    "arknetz://oauth/callback?code=C1&state=S",
    "arknetz://oauth/callback?code=C2&state=S",
  ]);
  assert.deepEqual(opened, ["arknetz://computers.edu"]);
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
