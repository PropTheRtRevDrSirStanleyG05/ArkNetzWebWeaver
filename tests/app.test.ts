// Tests: app wiring layer — every phase service constructs from one
// place, every panel is registered, and the shell has a single entry
// point. No network: the app is built with a mock fetch that throws.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_PANELS, createArkNetzApp, panelById } from "../src/lib/app.js";

const throwingFetch = (() => {
  throw new Error("no network in tests");
}) as unknown as typeof fetch;

test("app: all 15 panels are registered, ids unique, titles present", () => {
  assert.equal(APP_PANELS.length, 15);
  const ids = APP_PANELS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of APP_PANELS) {
    assert.ok(p.title.length > 0, p.id);
    assert.ok(p.description.length > 0, p.id);
    assert.ok(p.module.length > 0, p.id);
  }
  for (const id of ["browse", "builder", "mail", "drive", "search", "comments", "streaming", "offline", "stats", "domains", "moderation", "accounts", "wayback", "backends", "settings"]) {
    assert.ok(panelById(id), `panel ${id} is registered`);
  }
  assert.equal(panelById("no-such-panel"), undefined);
});

test("app: createArkNetzApp constructs every phase service with no network", () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  assert.equal(app.panels.length, 15);
  assert.ok(app.mailDelivery);
  assert.ok(app.mailStore);
  assert.ok(app.draftStore);
  assert.ok(app.searchIndex);
  assert.equal(app.searchIndex.size, 0);
  assert.ok(app.searchHistory);
  assert.ok(app.pingStore);
  assert.ok(app.progressStore);
  assert.ok(app.myListStore);
  assert.ok(app.keyring);
  assert.equal(app.keyring.isUnlocked, false);
  const readiness = app.describeReadiness();
  assert.equal(readiness.panels, 15);
  assert.ok(readiness.signedInPanels > 0);
  assert.match(readiness.note, /real central repos/);
});

test("app: mail keypair generation + inbox open work end to end (in memory)", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const keypair = await app.newMailKeypair("alice@computers.edu");
  assert.ok(keypair.publicKey);
  const inbox = app.openInbox(keypair);
  assert.equal((await inbox.list("inbox")).length, 0);
});

test("app: openVault refuses ia:/wm: backends and accepts gh:", () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  assert.throws(
    () => app.openVault({ kind: "ia", uri: "ia:alice/vault", repo: "alice/vault", accountId: "alice" } as never),
    /Internet Archive|Wikimedia|not.*drive/i,
  );
  const vault = app.openVault(
    { kind: "gh", uri: "gh:alice/arknetz-vault", repo: "alice/arknetz-vault", accountId: "alice" } as never,
  );
  assert.equal(vault.isOpen, false);
});

test("app: pooled drive over zero vaults is empty, not an error", () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const pooled = app.pooledDrive([]);
  assert.equal(pooled.vaultCount, 0);
});

// Regression test for the round-3 live-QA bug (2026-11-20): the app
// object used to store `globalThis.fetch` bare as its default fetch.
// In browsers fetch is a Window method, so the detached reference
// threw "Failed to execute 'fetch' on 'Window': Illegal invocation"
// on the first fetch-backed call (vault open showed the raw
// TypeError in the panel status), while Node's unbound-safe fetch let
// every unit test pass. The test swaps in a browser-like fetch that
// enforces its receiver, then opens a vault through the DEFAULT
// fetch path: with the bug the open rejects with Illegal invocation;
// fixed, the fetch runs and the (stubbed) GitHub 404 surfaces as a
// real HTTP error instead.
test("app: default fetch works when fetch enforces its receiver (browser-like)", async () => {
  const realFetch = globalThis.fetch;
  function browserLikeFetch(this: unknown): Promise<Response> {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }
  globalThis.fetch = browserLikeFetch as unknown as typeof fetch;
  try {
    const app = createArkNetzApp(); // no fetchFn: the default path
    const vault = app.openVault(
      { kind: "gh", uri: "gh:someone/arknetz-vault", repo: "someone/arknetz-vault", accountId: "" } as never,
      "ghp_test",
    );
    await assert.rejects(
      () => vault.open("correct horse battery staple"),
      (e: unknown) => {
        assert.match(String((e as Error).message), /HTTP 404/);
        assert.doesNotMatch(String((e as Error).message), /Illegal invocation/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Regression test for the round-3 live-QA console error: the shell
// loaded with a /favicon.ico 404 on every launch because index.html
// declared no icon. The shell now ships src/favicon.svg (same mark as
// the static export) and links it. (Tests run compiled from dist/, so
// these read the dist copies — the same convention as the
// protocol/register.yml test.)
test("shell: index.html links a favicon that ships with the app", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="icon"[^>]*href="\.\/favicon\.svg">/);
  const svg = readFileSync(new URL("../favicon.svg", import.meta.url), "utf8");
  assert.match(svg, /<svg/);
});

test("app: loadDirectoryShards indexes the manifest's categories, not the hardcoded default", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const musicCard = { domain: "songs.example", title: "Kitchen Sessions", tags: ["music"], category: "music", updated_timestamp: 400 };
  const { CachedFetcher, createMemoryCacheStore } = await import("../src/lib/cache.js");
  const { directoryShardUrl } = await import("../src/lib/viewer/search.js");
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    async (url: string) => {
      if (url === directoryShardUrl("music")) {
        return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ category: "music", version: 1, updated: 1, cards: [musicCard] }) };
      }
      return { status: 404, headers: { get: () => null }, text: async () => "" };
    },
  );
  const shards = await app.loadDirectoryShards({ directoryCategories: ["music"] } as never, fetcher);
  assert.equal(shards.length, 1);
  assert.equal(app.searchIndex.size, 1);
  assert.equal(app.searchIndex.search("kitchen")[0]?.card.domain, "songs.example");
});

// Shell layout regressions (B1/B2/B8/B10, 2026-11-20): the panels used
// to sit at the bottom of the 260px sidebar ~1,150px below the fold,
// the sign-in status rendered inline in the topbar and blew it up to
// 82px, the editor landed in a new grid row below the reader at the
// footer's position, and the IA form labels wrapped mid-phrase with
// the input wedged between fragments.
test("shell: panels are a full-width strip above the reader, status below the topbar, editor in the reader cell", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  // B2: panel nav/host are inside .an-panels, which sits between the
  // toolbar and <main>; the sidebar no longer contains them.
  const sidebar = html.slice(html.indexOf('<aside class="an-sidebar">'), html.indexOf("</aside>"));
  assert.doesNotMatch(sidebar, /panel-nav/);
  assert.doesNotMatch(sidebar, /panel-host/);
  assert.ok(html.indexOf('id="panel-nav"') < html.indexOf("<main"), "panel nav is above the reader layout");
  assert.ok(html.indexOf('id="panel-host"') < html.indexOf("<main"), "panel host is above the reader layout");
  assert.match(html, /<section class="an-panels"/);
  // B8: sign-in status is a standalone strip after </header>, not a
  // span inside the topbar; it starts hidden.
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.doesNotMatch(header, /signin-status/);
  assert.match(html, /<div class="an-signin-status" id="signin-status" role="status" hidden>/);
  // B10: IA labels sit above their inputs (label-for + input siblings),
  // never wrapping the input inside the label text.
  assert.match(html, /<label for="ia-username">IA username<\/label>/);
  assert.match(html, /<label for="ia-passphrase">Passphrase \(protects your keys on this device, min 8 chars\)<\/label>/);
  assert.doesNotMatch(html, /<label>IA username <input/);
  // B1: the editor occupies the reader's grid cell, not a full-width
  // row below it; P6: the body is not a tab stop.
  assert.match(css, /\.an-editor\{grid-column:2;grid-row:1/);
  assert.match(html, /<body tabindex="-1">/);
  // R2: the ≤700px rule must BEAT the base .an-editor{grid-column:2}
  // (same specificity + later order used to win, crushing the sidebar
  // to 0px at 390px), so it is scoped under .an-layout.
  assert.match(css, /\.an-layout \.an-editor\{grid-column:1;grid-row:auto\}/);
  // Nit (b): sidebar nav rows wrap at spaces, not mid-word —
  // overflow-wrap:anywhere + word-break:break-word broke "about" into
  // "abo ut". break-word only breaks a token that cannot fit alone.
  assert.doesNotMatch(css, /overflow-wrap:anywhere/);
  assert.doesNotMatch(css, /word-break:break-word/);
  assert.match(css, /\.an-editor-sidebar li\{overflow-wrap:break-word\}/);
  // Nit (c): the topbar guest badge never splits mid-username — it
  // stays on one line (ellipsised only if it cannot fit at all).
  assert.match(css, /#guest-badge\{[^}]*white-space:nowrap/);
  // B7: the toolbar wraps and the page cannot scroll horizontally.
  // overflow-x:clip (not hidden) on html/body: hidden computes
  // overflow-y to auto, which makes body a scroll container and breaks
  // the sticky topbar (hunt 3) — clip prevents sideways scrolling
  // without creating a scroll container, so sticky keeps working.
  assert.match(css, /\.an-toolbar\{[^}]*flex-wrap:wrap/);
  assert.match(css, /overflow-x:clip/);
  assert.doesNotMatch(css, /overflow-x:hidden/);
});

// Hunt 3 (2026-11-21): on load the app scrolled the reader into view
// (main.ts showReader) while the topbar was position:static, so the
// brand, account pill and Sign in button sat 166px above the viewport
// and a first-time user could not see them until scrolling up. The
// topbar is sticky now. The footer also carried two version strings
// (core shell 0.1.0 + visual builder 0.3.0) while package.json said
// 0.3.0 and tauri.conf.json/Cargo.toml said 0.1.0; the app is 0.4.0
// everywhere now (minor bump for the feature-round-2 additions since
// 0.3.0: collab, tables/lists, HTML importer). Hunt 4: patch bump to
// 0.4.1 for the OAuth device-flow + mobile + sub-page + export fixes.
test("hunt3: topbar is sticky and the app reports one version, 0.4.1", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.an-topbar\{[^}]*position:sticky;top:0/);
  assert.match(html, /ArkNetzWebWeaver 0\.4\.1/);
  assert.doesNotMatch(html, /core shell 0\.1\.0 \+ visual builder/);
  assert.doesNotMatch(html, /until the central repos exist/);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(pkg.version, "0.4.1");
  const tauriConf = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(tauriConf.version, "0.4.1");
  const cargo = readFileSync(new URL("../../src-tauri/Cargo.toml", import.meta.url), "utf8");
  assert.match(cargo, /^version = "0\.4\.1"$/m);
});

// Fix pass 2 (visual defects, hunt 2): the CSS pins for H1/L7/L8/L9/L10.
test("shell: fix-pass-2 CSS — slash row wraps, editor status is its own row, code has a scroll fade, pill wraps, import URL is wide", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  // H1: the block-inserter row wraps instead of running off-viewport
  // at 390px; the input shrinks and the select/buttons wrap with it.
  assert.match(css, /\.an-slash-row\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.an-slash-row input\{[^}]*min-width:0/);
  // L7: the editor status is a full-width row of its own at the foot
  // of the bar, never a squeezed mid-header column.
  assert.match(css, /\.an-editor-bar #editor-status\{flex:1 1 100%;order:99/);
  // L8: code blocks carry a fade at the clipped edge, signalling the
  // sideways scroll (reader + editor canvas).
  assert.match(css, /\.an-reader pre\{[^}]*mask-image:linear-gradient\(to right,#000 calc\(100% - 28px\),transparent 100%\)/);
  assert.match(css, /pre\.an-ed-text\{[^}]*mask-image:linear-gradient\(to right,#000 calc\(100% - 28px\),transparent 100%\)/);
  // L9: the account pill wraps cleanly at 390px instead of truncating
  // mid-name (the #guest-badge nowrap rule above is untouched — that
  // element no longer exists in the shell; the live badge is the pill).
  assert.match(css, /#account-pill\{white-space:normal;text-align:left;overflow-wrap:break-word/);
  // L10: the Import-URL label takes a wide flex share and its input
  // fills it, at desktop and mobile.
  assert.match(html, /<label class="an-file-label an-url-label">Import HTML from URL/);
  assert.match(css, /\.an-editor-bar \.an-url-label\{flex:1 1 320px;min-width:200px\}/);
  assert.match(css, /\.an-editor-bar #html-import-url\{width:100%;min-width:0\}/);
});
