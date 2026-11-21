// Tests: opening URLs outside the app (hunt 4) — the opener plugin
// must be preferred over window.open, which never leaves the app.
import test from "node:test";
import assert from "node:assert/strict";
import { openExternalUrl } from "../src/lib/opener.js";

test("openExternalUrl uses the Tauri opener plugin when present", async () => {
  const opened: string[] = [];
  const scope = {
    __TAURI__: {
      opener: {
        openUrl: async (url: string) => {
          opened.push(url);
        },
      },
    },
  };
  const tookPlugin = await openExternalUrl("https://github.com/device", scope);
  assert.equal(tookPlugin, true);
  assert.deepEqual(opened, ["https://github.com/device"]);
});

test("openExternalUrl falls back to window.open when the plugin is absent", async () => {
  const opened: string[] = [];
  const realWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: unknown }).window = {
    open: (url: string) => {
      opened.push(url);
    },
  };
  try {
    const tookPlugin = await openExternalUrl("https://github.com/device", {});
    assert.equal(tookPlugin, false);
    assert.deepEqual(opened, ["https://github.com/device"]);
  } finally {
    if (realWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
    else (globalThis as unknown as { window?: unknown }).window = realWindow;
  }
});

test("openExternalUrl returns false when the plugin throws (caller shows the URL)", async () => {
  const scope = {
    __TAURI__: {
      opener: {
        openUrl: async (_url: string) => {
          throw new Error("no browser");
        },
      },
    },
  };
  const tookPlugin = await openExternalUrl("https://github.com/device", scope);
  assert.equal(tookPlugin, false);
});
