// Tests: panel mount layer — every registered panel renders real content
// from the live app services, with no network. DOM wiring (mountPanels /
// wirePanel) is exercised in the browser; here we cover the renderers.
import test from "node:test";
import assert from "node:assert/strict";
import { APP_PANELS, createArkNetzApp, panelVisibleForLogin, visiblePanelsForLogin } from "../src/lib/app.js";
import { MASTER_GITHUB_USER } from "../src/lib/config.js";
import { createPanelState, renderPanelHtml } from "../src/lib/panels.js";
import { DEMO_SITE } from "../src/lib/sample.js";
import type { SiteDocument } from "../src/lib/types.js";

const throwingFetch = (() => {
  throw new Error("no network in tests");
}) as unknown as typeof fetch;

const opts = {
  getCurrentDoc: (): SiteDocument => JSON.parse(JSON.stringify(DEMO_SITE)) as SiteDocument,
  showReader: () => {},
  showEditor: () => {},
  fetchFn: throwingFetch,
};

test("panels: all 15 registered panels render a titled section", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  for (const panel of APP_PANELS) {
    const html = await renderPanelHtml(app, panel.id, state, opts);
    assert.match(html, new RegExp(panel.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), panel.id);
    assert.ok(html.length > panel.title.length + 20, panel.id);
  }
});

test("panels: unknown panel id renders an honest note, not a crash", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const html = await renderPanelHtml(app, "no-such-panel", createPanelState(), opts);
  assert.match(html, /Unknown panel/);
});

test("panels: mail without a keypair shows the keypair step, not a fake inbox", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const html = await renderPanelHtml(app, "mail", createPanelState(), opts);
  assert.match(html, /Create my mail keypair/);
  assert.doesNotMatch(html, /Your inbox is empty/);
});

test("panels: mail with a generated keypair shows the real (empty) inbox + compose", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  state.mailKeypair = await app.newMailKeypair("alice@computers.edu");
  state.mailAddress = "alice@computers.edu";
  const html = await renderPanelHtml(app, "mail", state, opts);
  assert.match(html, /alice@computers\.edu/);
  assert.match(html, /Compose/);
  assert.match(html, /Drafts are real and saved locally/);
});

test("panels: drive shows the honest limits and the backend picker", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const html = await renderPanelHtml(app, "drive", createPanelState(), opts);
  assert.match(html, /What ArkDrive is/);
  assert.match(html, /no public share links/i);
  assert.match(html, /Open a vault/);
});

test("panels: drive shows the drop zone once a vault is open, not before", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const closed = await renderPanelHtml(app, "drive", createPanelState(), opts);
  assert.doesNotMatch(closed, /an-drive-dropzone/);
  const state = createPanelState();
  state.vault = { listFolder: async () => [] } as never;
  state.vaultFiles = [];
  const open = await renderPanelHtml(app, "drive", state, opts);
  assert.match(open, /an-drive-dropzone/);
  assert.match(open, /Drag files or folders here/);
});

test("panels: search shows the local index count; comments say guests cannot post", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  const search = await renderPanelHtml(app, "search", state, opts);
  assert.match(search, /0 metadata cards indexed locally/);
  const comments = await renderPanelHtml(app, "comments", state, opts);
  assert.match(comments, /Guests can comment: no/);
});

test("panels: offline offers a real save button; domains lists the claim steps", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  const offline = await renderPanelHtml(app, "offline", state, opts);
  assert.match(offline, /Save the current site offline/);
  const domains = await renderPanelHtml(app, "domains", state, opts);
  assert.match(domains, /Pick a domain/);
  assert.match(domains, /no account-age minimum/);
});

test("panels: domains renders the claim form (terms + claim button) and the exact signed-out refusal for guests", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  const guest = await renderPanelHtml(app, "domains", state, opts);
  assert.match(guest, /an-domain-terms/);
  assert.match(guest, /an-domain-claim-btn/);
  assert.match(guest, /Claim this domain/);
  assert.match(guest, /Sign in with GitHub first to claim a domain/);
  // Signed in: the refusal note is gone (the claim button stays —
  // the flow itself still refuses loudly without a token).
  const signedIn = await renderPanelHtml(app, "domains", state, {
    ...opts,
    getGithubLogin: () => "alice",
  });
  assert.doesNotMatch(signedIn, /an-domain-signin-note/);
  assert.match(signedIn, /an-domain-claim-btn/);
});

test("panels: moderation hides the admin panel from guests; accounts show the keyring state", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  const mod = await renderPanelHtml(app, "moderation", state, opts);
  assert.match(mod, /only visible to the Root Master/);
  const accounts = await renderPanelHtml(app, "accounts", state, opts);
  assert.match(accounts, /keyring is locked/);
  assert.match(accounts, /PropTheRtRevDrSirStanleyG05/);
});

test("panels: wayback and streaming render their honest empty states", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  const wayback = await renderPanelHtml(app, "wayback", state, opts);
  assert.match(wayback, /Wayback Machine/);
  assert.match(wayback, /Look up snapshots/);
  const streaming = await renderPanelHtml(app, "streaming", state, opts);
  assert.match(streaming, /Continue watching/);
  assert.match(streaming, /My List/);
});

// P5: the Moderation nav button is hidden unless the active account is
// the Root Master — guests used to see it and land on a note saying it
// was "only visible to the Root Master". The panel renderer itself
// still says so when called directly (honest empty state, covered
// above); only the nav button is gated.
test("panels: moderation nav button hidden for guests and non-masters, shown for the Root Master", () => {
  const moderation = APP_PANELS.find((p) => p.id === "moderation")!;
  assert.equal(panelVisibleForLogin(moderation, null), false);
  assert.equal(panelVisibleForLogin(moderation, "alice"), false);
  assert.equal(panelVisibleForLogin(moderation, MASTER_GITHUB_USER), true);
  assert.equal(MASTER_GITHUB_USER, "PropTheRtRevDrSirStanleyG05");
  const guestVisible = visiblePanelsForLogin(APP_PANELS, null);
  assert.equal(guestVisible.length, 14);
  assert.equal(guestVisible.some((p) => p.id === "moderation"), false);
  const masterVisible = visiblePanelsForLogin(APP_PANELS, MASTER_GITHUB_USER);
  assert.equal(masterVisible.length, 15);
  assert.equal(masterVisible.some((p) => p.id === "moderation"), true);
  // Every other panel stays visible to guests — guest browsing is the
  // default and hiding moderation must not hide anything else.
  for (const panel of APP_PANELS) {
    if (panel.id !== "moderation") assert.equal(panelVisibleForLogin(panel, null), true, panel.id);
  }
});

// Integration pass: the Stats + Backends panels are wired into
// renderPanelHtml(). With no accessors they render their honest empty
// states; with accessors they render the supplied stats / linked
// accounts — and render + wire read the same source (the shared
// statsDeps/backendsDeps helpers), so these render assertions pin the
// render half of that contract.
test("panels: stats renders honest empty states with no accessors, real counts with them", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  const empty = await renderPanelHtml(app, "stats", state, opts);
  assert.match(empty, /Stats/);
  assert.match(empty, /No views recorded yet/);
  assert.match(empty, /Turn on the Public View Counter/);
  assert.match(empty, /Strict Offline/);

  const withStats = await renderPanelHtml(app, "stats", state, {
    ...opts,
    getSiteStats: () => ({
      v: 1 as const,
      domain: "welcome.arknetz",
      updated: Date.now(),
      views: { index: 12, about: 3 },
      totalViews: 15,
      comments: 2,
    }),
    getTelemetrySettings: () => ({ strictOffline: false, publicViewCounter: true, allowIaPlayCounts: true }),
  });
  assert.match(withStats, /15 views/);
  assert.match(withStats, /index — 12 views/);
  assert.match(withStats, /Turn off the Public View Counter/);
});

test("panels: backends renders every backend unlinked with no accessors, linked with them", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const state = createPanelState();
  const empty = await renderPanelHtml(app, "backends", state, opts);
  assert.match(empty, /Backends/);
  assert.match(empty, /Not linked/);
  assert.match(empty, /No site has loaded through mirrors yet/);
  assert.match(empty, /ToS-aware routing/);

  const linked = await renderPanelHtml(app, "backends", state, {
    ...opts,
    getProjectFlags: () => ({ isOpenDataset: true }),
    getLinkedBackends: () => ({ gh: "alice (GitHub)", ia: "alice@archive.org" }),
    getLastMirrorAttempts: () => [],
  });
  assert.match(linked, /Linked: alice \(GitHub\)/);
  assert.match(linked, /Linked: alice@archive\.org/);
  // ipfs has no account provider and always shows "Not linked".
  assert.match(linked, /ipfs:/);
});

// Integration pass: the Wayback panel is wired through wireWaybackPanel
// now — the rendered HTML (input + two buttons + results div) is
// unchanged, so the lookup still has the exact ids it binds to.
test("panels: wayback still renders the exact ids wireWaybackPanel binds to", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  const html = await renderPanelHtml(app, "wayback", createPanelState(), opts);
  assert.match(html, /id="an-wayback-url"/);
  assert.match(html, /id="an-wayback-btn"/);
  assert.match(html, /id="an-wayback-save-btn"/);
  assert.match(html, /id="an-wayback-results"/);
});
