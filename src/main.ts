// ArkNetzWebWeaver — core shell UI wiring.
// Guest browsing is the default: the app opens on the demo site with no
// sign-in. Sign-in is a real GitHub OAuth entry point (auth.ts) — it
// throws, loudly, until a GitHub OAuth App client id is configured, and
// it never invents a token. Reads go through CachedFetcher +
// RegistryResolver (raw.githubusercontent.com only, ETag cached).
// The demo site (welcome.arknetz) is bundled so the shell is usable
// before any central repo exists; it is labelled as a demo in the page.

import { CachedFetcher, createIndexedDBStore, createMemoryCacheStore } from "./lib/cache.js";
import { RegistryResolver } from "./lib/registry.js";
import { installArknetzLinkInterceptor, renderSiteDocument } from "./lib/renderer.js";
import {
  AppSaveBridge,
  createAppBridgeTokensForSite,
  createIndexedDBAppSaveStore,
  createMemoryAppSaveStore,
  installAppBridgeListener,
} from "./lib/viewer/app-bridge.js";
import type { AppBridgeReplyTarget, AppSaveStore } from "./lib/viewer/app-bridge.js";
import { buildAuthorizeUrl, completeOAuthCallback, isMasterUser, randomState, savePendingOAuthState, takePendingOAuthState } from "./lib/auth.js";
import { addGithubAccount } from "./lib/network/accounts.js";
import { attachMedia, IaUploadQueue } from "./lib/ia-media.js";
import type { IaKeys } from "./lib/ia-media.js";
import {
  createIndexedDBIaAccountStore,
  createMemoryIaAccountStore,
  getIaAccountStatus,
  linkIaAccount,
  testIaConnection,
  unlinkIaAccount,
  unlockIaAccount,
} from "./lib/ia-settings.js";
import type { IaAccountStore } from "./lib/ia-settings.js";
import { prepareImageForUpload } from "./lib/media-edit.js";
import { siteRepoName } from "./lib/publish.js";
import type { GithubFetchFn } from "./lib/publish.js";
import { claimDomainAndOpenSite } from "./lib/domains.js";
import type { OpenedSite } from "./lib/domains.js";
import { buildSiteOpenedViewModel } from "./lib/domains-ui.js";
import {
  BookmarkManager,
  TabManager,
  createMemoryShellStore,
} from "./lib/shell.js";
import { DEMO_SITE } from "./lib/sample.js";
import { MASTER_GITHUB_USER } from "./lib/config.js";
import { EditorUI } from "./lib/editor-ui.js";
import type { SiteDocument } from "./lib/types.js";
import { createArkNetzApp } from "./lib/app.js";
import type { ArkNetzApp } from "./lib/app.js";
import { installDeepLinkListener, isOAuthCallbackUrl } from "./lib/deep-link.js";
import { mountPanels } from "./lib/panels.js";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const fetcher = new CachedFetcher(
  typeof indexedDB !== "undefined" ? createIndexedDBStore() : createMemoryCacheStore(),
  async (url, init) => {
    const res = await fetch(url, { headers: init?.headers });
    return {
      status: res.status,
      headers: { get: (n: string) => res.headers.get(n) },
      text: () => res.text(),
    };
  },
  async (url, init) => {
    const res = await fetch(url, { headers: init?.headers });
    return {
      status: res.status,
      headers: { get: (n: string) => res.headers.get(n) },
      arrayBuffer: () => res.arrayBuffer(),
    };
  },
);
const resolver = new RegistryResolver(fetcher);
const tabs = new TabManager(createMemoryShellStore());
const bookmarks = new BookmarkManager(createMemoryShellStore());
const iaQueue = new IaUploadQueue(2, 120);
// IA keys: null until the user links an IA account in Settings and
// unlocks it with the passphrase (ia-settings.ts). The shell never
// invents them.
let iaKeys: IaKeys | null = null;
// GitHub token: null until sign-in completes via the Tauri OAuth
// command (auth.ts exchangeCode). No token is ever pasted or stored.
let githubToken: string | null = null;
let githubLogin: string | null = null;
/** The app object, once init() has built it — the sign-in completion
 *  (which can arrive via a deep link at any moment) needs the keyring. */
let app: ArkNetzApp | null = null;
/** Rebuild the panel nav after sign-in/out (Moderation appears only
 *  for the Root Master). Set by mountPanels in init(). */
let panelsRefreshNav: (() => void) | null = null;
// The document currently shown in the reader — the editor edits a clone
// of this, and the reader re-renders from the edited copy on close, so
// View and Edit always show the same renderer output.
let currentDoc: SiteDocument = JSON.parse(JSON.stringify(DEMO_SITE)) as SiteDocument;
let editorUi: EditorUI | null = null;

/** Build the EditorUI once (the edit toggle and the claim hook share
 *  it): the signed-in GitHub token/login come from the session
 *  variables, the IA keys from the settings unlock. */
function ensureEditorUi(): EditorUI {
  if (!editorUi) {
    editorUi = new EditorUI($("editor"), {
      getIaKeys: () => iaKeys,
      iaQueue,
      iaFetch: async (url, init) => {
        const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
        return { status: res.status, text: () => res.text() };
      },
      getGithubToken: () => githubToken,
      getGithubLogin: () => githubLogin,
      getSiteRepo: (domain: string) => siteRepoName(domain),
      githubFetch,
      htmlFetch,
    });
  }
  return editorUi;
}
/** Save-bridge for the site the reader is showing: one bridge per domain,
 *  sessions revoked on every re-render so a removed iframe's sid dies
 *  with it. */
let appBridge: AppSaveBridge | null = null;
let appBridgeSids: string[] = [];
let uninstallAppBridge: (() => void) | null = null;
let iaStore: IaAccountStore = createMemoryIaAccountStore();

/** The GitHub API fetch, shared by the editor (Publish / collab)
 *  and the domain claim flow: plain fetch, no auth header of its
 *  own — the caller passes the token in init.headers where the API
 *  needs it. */
const githubFetch: GithubFetchFn = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return {
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};

/** Plain fetch for the HTML importer's URL import: no auth, no
 *  GitHub — any public page. */
const htmlFetch = async (url: string) => {
  const res = await fetch(url);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

function cloneDoc(doc: SiteDocument): SiteDocument {
  return JSON.parse(JSON.stringify(doc)) as SiteDocument;
}

function parseAddress(raw: string): { kind: "demo" | "domain" | "https"; value: string } {
  const s = raw.trim();
  if (s === "home" || s === "arknetz://welcome.arknetz") return { kind: "demo", value: s };
  if (s.startsWith("arknetz://")) {
    // Any path on the bundled demo domain resolves to the demo site
    // itself — the demo is a single document with no sub-pages, so
    // arknetz://welcome.arknetz/about lands on the site instead of an
    // error page (and, via the T1 interceptor, instead of destroying
    // the app with a top-level WebView navigation).
    const host = s.slice("arknetz://".length).split("/")[0] as string;
    if (host === DEMO_SITE.domain) return { kind: "demo", value: s };
    return { kind: "domain", value: host };
  }
  if (s.startsWith("https://")) return { kind: "https", value: s };
  return { kind: "domain", value: s };
}

/** Render a site document with save-bridge sessions for its sandboxed
 *  app blocks. Any failure (no IndexedDB, invalid domain) falls back to
 *  the plain render — an app block then simply has no save API, exactly
 *  as before the bridge existed. */
function renderSiteWithSaveBridge(site: SiteDocument): string {
  try {
    if (!appBridge || appBridge.domain !== site.domain) {
      uninstallAppBridge?.();
      uninstallAppBridge = null;
      let store: AppSaveStore;
      try {
        store = createIndexedDBAppSaveStore();
      } catch {
        store = createMemoryAppSaveStore();
      }
      appBridge = new AppSaveBridge(store, site.domain);
      appBridgeSids = [];
      uninstallAppBridge = installAppBridgeListener(appBridge, window, (event) => {
        const source = event.source as unknown;
        return source && typeof (source as { postMessage?: unknown }).postMessage === "function"
          ? (source as AppBridgeReplyTarget)
          : null;
      });
    }
    for (const sid of appBridgeSids) appBridge.revokeSession(sid);
    const tokens = createAppBridgeTokensForSite(appBridge, site);
    appBridgeSids = [...tokens.values()];
    return renderSiteDocument(site, { appBridgeTokens: tokens });
  } catch {
    return renderSiteDocument(site);
  }
}

async function renderCurrent(): Promise<void> {
  const reader = $("reader");
  const tab = tabs.active();
  if (!tab) return;
  const parsed = parseAddress(tab.address);
  if (parsed.kind === "demo") {
    currentDoc = cloneDoc(DEMO_SITE);
    reader.innerHTML = `<p class="an-note">Demo site bundled with the shell — the registry does not exist yet, so this is not a live network site.</p>` + renderSiteWithSaveBridge(DEMO_SITE);
    return;
  }
  if (parsed.kind === "https") {
    reader.innerHTML = `<p>External link — opened in the system browser in the Tauri app. <a href="${parsed.value}">${parsed.value}</a></p>`;
    return;
  }
  reader.innerHTML = `<p>Loading ${parsed.value}…</p>`;
  try {
    const site = await resolver.loadSite(parsed.value);
    currentDoc = cloneDoc(site);
    reader.innerHTML = renderSiteWithSaveBridge(site);
  } catch (err) {
    reader.innerHTML = `<h1>Could not load ${parsed.value}</h1><p>${err instanceof Error ? err.message : String(err)}</p><p class="an-note">The central registry repos do not exist yet (licence decision pending). Until they do, only the demo site resolves.</p>`;
  }
}

function renderTabs(): void {
  const bar = $("tabbar");
  bar.innerHTML = "";
  for (const t of tabs.list()) {
    const el = document.createElement("button");
    el.className = "an-tab";
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(t.id === tabs.active()?.id));
    el.textContent = `${t.title} ×`;
    el.onclick = async () => {
      // Clicking the "×" half is close; keep it simple: activate, and
      // double-click closes. (Close button lands with the tab menu.)
      await tabs.activate(t.id);
      ($("address-input") as HTMLInputElement).value = t.address;
      renderTabs();
      await renderCurrent();
      updateNavButtons();
    };
    el.ondblclick = async () => {
      await tabs.close(t.id);
      renderTabs();
      await renderCurrent();
      updateNavButtons();
    };
    bar.appendChild(el);
  }
}

function renderBookmarks(): void {
  const list = $("bookmark-list");
  list.innerHTML = "";
  for (const b of bookmarks.list()) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = b.title;
    a.onclick = async (e) => {
      e.preventDefault();
      await tabs.navigate(b.address, b.title);
      ($("address-input") as HTMLInputElement).value = b.address;
      renderTabs();
      await renderCurrent();
      updateNavButtons();
    };
    li.appendChild(a);
    list.appendChild(li);
  }
}

function updateNavButtons(): void {
  ($("back-btn") as HTMLButtonElement).disabled = !tabs.canBack();
  ($("forward-btn") as HTMLButtonElement).disabled = !tabs.canForward();
}

async function go(address: string): Promise<void> {
  // The OAuth callback is not a site address: intercept it before the
  // tab navigation / site resolver, which would try to load a site
  // called "oauth" and fail. (Same interception as the deep-link
  // listener — this covers a callback URL pasted into the address bar.)
  if (isOAuthCallbackUrl(address)) {
    await completeGitHubSignIn(address);
    return;
  }
  await tabs.navigate(address);
  ($("address-input") as HTMLInputElement).value = address;
  renderTabs();
  await renderCurrent();
  updateNavButtons();
}

/** Settings sidebar + top bar, from the one source of truth
 *  (githubToken/githubLogin). The guest badge shows the signed-in
 *  login — with the Root Master marker only when the login is the
 *  master user; enforcement stays GitHub's 403, never the UI. */
function refreshGithubStatus(): void {
  const ghStatus = $("gh-status");
  ghStatus.textContent = githubToken
    ? `GitHub: signed in as ${githubLogin ?? "unknown"} — Publish can run.`
    : "GitHub: not signed in. Publish needs sign-in (and a GitHub OAuth App must exist first).";
  ($("guest-badge") as HTMLElement).textContent = githubLogin
    ? `Signed in as ${githubLogin}${isMasterUser(githubLogin) ? " · Root Master" : ""}`
    : `Guest · Master: ${MASTER_GITHUB_USER}`;
}

/** Start the GitHub OAuth sign-in: build the authorize URL (client id
 *  + redirect_uri + scopes + random state) and open it. The pending
 *  state is saved to localStorage so the callback can be validated
 *  even if the OS delivers it to a second app process (see auth.ts).
 *  Throws loudly, with the exact fix, when no client id is
 *  configured — never a broken URL, never a fake token. */
function startGitHubSignIn(): void {
  const status = $("signin-status");
  // B8: the status lives in its own strip below the topbar (hidden
  // until there is a message) — show it when we have something to say.
  const showStatus = (msg: string): void => {
    status.textContent = msg;
    status.hidden = false;
  };
  try {
    const state = randomState();
    savePendingOAuthState(state);
    const url = buildAuthorizeUrl(state);
    showStatus("Opening GitHub sign-in…");
    window.open(url, "_blank", "noopener");
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err));
  }
}

/** Finish a GitHub OAuth sign-in from the callback URL the OS handed
 *  back (arknetz://oauth/callback?code=…&state=…): validate the state,
 *  exchange the code for a token in the Tauri shell, read the token
 *  owner's login, and add the account to the multi-account keyring.
 *  Every failure is shown in the sign-in status strip, loudly and
 *  exactly — no token is invented, and a half-finished sign-in leaves
 *  no account behind. When the keyring is locked the session still
 *  works for this run, but the account is not saved: the strip says
 *  so and points at the Accounts panel to unlock it. */
async function completeGitHubSignIn(callbackUrl: string): Promise<void> {
  const status = $("signin-status");
  const showStatus = (msg: string): void => {
    status.textContent = msg;
    status.hidden = false;
  };
  showStatus("GitHub sign-in: completing…");
  try {
    const expectedState = takePendingOAuthState();
    if (!expectedState) {
      throw new Error(
        "GitHub sign-in failed: no sign-in was started in this app (no pending state) — click “Sign in with GitHub” and try again.",
      );
    }
    const { token, user } = await completeOAuthCallback(callbackUrl, expectedState);
    githubToken = token;
    githubLogin = user.login;
    if (app?.keyring.isUnlocked) {
      await addGithubAccount(app.keyring, user, token);
      showStatus(`Signed in with GitHub as ${user.login} — account saved in the keyring.`);
    } else {
      showStatus(`Signed in with GitHub as ${user.login} for this session. The keyring is locked, so the account is not saved yet — unlock the keyring in the Accounts panel to keep it signed in.`);
    }
    refreshGithubStatus();
    panelsRefreshNav?.();
  } catch (err) {
    githubToken = null;
    githubLogin = null;
    refreshGithubStatus();
    showStatus(err instanceof Error ? err.message : String(err));
  }
}

/** Settings screen: Internet Archive account linking + GitHub status.
 *  The IA secret key is typed into a password field, encrypted under a
 *  passphrase, and never displayed or logged. Status shows only the
 *  username and the last 4 of the access key. */
async function refreshIaStatus(): Promise<void> {
  const statusEl = $("ia-status");
  try {
    const status = await getIaAccountStatus(iaStore);
    if (!status.linked) {
      statusEl.textContent = "Internet Archive: not linked. Attachments stay local until you link an account.";
    } else if (iaKeys) {
      statusEl.textContent = `Internet Archive: linked as ${status.username} (key …${status.accessKeyLast4}), unlocked — stealth upload is on.`;
    } else {
      statusEl.textContent = `Internet Archive: linked as ${status.username} (key …${status.accessKeyLast4}), locked — enter your passphrase and Unlock to enable stealth upload.`;
    }
  } catch (err) {
    statusEl.textContent = `Internet Archive status unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function wireSettings(): void {
  try {
    iaStore = typeof indexedDB !== "undefined" ? createIndexedDBIaAccountStore() : createMemoryIaAccountStore();
  } catch {
    iaStore = createMemoryIaAccountStore();
  }
  void refreshIaStatus();
  ($("ia-link-btn") as HTMLButtonElement).onclick = async () => {
    const statusEl = $("ia-status");
    const username = ($("ia-username") as HTMLInputElement).value;
    const accessKey = ($("ia-access-key") as HTMLInputElement).value;
    const secretKey = ($("ia-secret-key") as HTMLInputElement).value;
    const passphrase = ($("ia-passphrase") as HTMLInputElement).value;
    try {
      const status = await linkIaAccount(iaStore, { username, accessKey, secretKey, passphrase });
      ($("ia-secret-key") as HTMLInputElement).value = "";
      if (status.linked) {
        statusEl.textContent = `Internet Archive: linked as ${status.username} (key …${status.accessKeyLast4}), locked — enter your passphrase and Unlock to enable stealth upload.`;
      } else {
        statusEl.textContent = "Internet Archive: not linked.";
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  ($("ia-unlock-btn") as HTMLButtonElement).onclick = async () => {
    const statusEl = $("ia-status");
    const passphrase = ($("ia-passphrase") as HTMLInputElement).value;
    try {
      iaKeys = await unlockIaAccount(iaStore, passphrase);
      await refreshIaStatus();
    } catch (err) {
      iaKeys = null;
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  ($("ia-test-btn") as HTMLButtonElement).onclick = async () => {
    const statusEl = $("ia-status");
    if (!iaKeys) {
      statusEl.textContent = "Unlock your Internet Archive account first (link it, then enter your passphrase and Unlock).";
      return;
    }
    statusEl.textContent = "Testing the Internet Archive connection…";
    const result = await testIaConnection(iaKeys, async (url, init) => {
      const res = await fetch(url, { method: init.method, headers: init.headers });
      return { status: res.status, text: () => res.text() };
    });
    statusEl.textContent = result.ok
      ? "Internet Archive connection OK — these keys were accepted."
      : `Internet Archive test failed: ${result.reason}`;
  };
  ($("ia-unlink-btn") as HTMLButtonElement).onclick = async () => {
    await unlinkIaAccount(iaStore);
    iaKeys = null;
    ($("ia-access-key") as HTMLInputElement).value = "";
    ($("ia-secret-key") as HTMLInputElement).value = "";
    await refreshIaStatus();
  };
  refreshGithubStatus();
}

/** The claim flow's onSiteOpened hook: a claim just succeeded, so
 *  load the opened document into the editor for the claimed domain
 *  and switch to the builder. The editor shows the pending-claim
 *  state (EditorUI.showSiteOpened) — the claim is pending until
 *  register.yml closes the REGISTER issue, never "registered". The
 *  reader's current document is updated too, so closing the editor
 *  shows the new site instead of the old one. */
function handleSiteOpened(opened: OpenedSite): void {
  currentDoc = cloneDoc(opened.doc);
  const ui = ensureEditorUi();
  ($("reader") as HTMLElement).hidden = true;
  ui.showSiteOpened(opened);
  ($("editor") as HTMLElement).scrollIntoView({ block: "start" });
}

async function init(): Promise<void> {
  await tabs.load();
  await bookmarks.load();
  renderTabs();
  renderBookmarks();
  updateNavButtons();
  await renderCurrent();

  // The app object first: the deep-link listener below can deliver an
  // OAuth callback at startup, and completing it needs the keyring.
  // Load persisted telemetry settings before the panels mount, so the
  // Stats panel renders the stored toggles (not the defaults) on the
  // first paint. With the memory store this is just the defaults.
  // The keyring load likewise restores saved accounts (same store).
  const appInstance = createArkNetzApp();
  app = appInstance;
  await appInstance.loadTelemetrySettings();
  await appInstance.keyring.load();

  // OS deep links (arknetz://…): the Tauri deep-link plugin delivers
  // them via window.__TAURI__.deepLink when the app runs in the shell
  // (getCurrent at startup, onOpenUrl while running). In a plain
  // browser the listener reports "unavailable" and the app carries on
  // — deep links simply cannot arrive there. A site link opens in the
  // current tab through the same navigation as a typed address; the
  // OAuth callback (arknetz://oauth/callback) is intercepted before
  // the site resolver and completes the GitHub sign-in instead.
  void installDeepLinkListener(window as unknown as Parameters<typeof installDeepLinkListener>[0], async (address) => {
    await go(address);
  }, {
    onOAuthCallback: (url) => completeGitHubSignIn(url),
  });

  // T1: intercept arknetz:// clicks ANYWHERE in the document (reader,
  // editor preview, panels) and route them through internal navigation.
  // Without this a click on a site nav link navigates the whole WebView
  // top-level to arknetz://…, which WebKitGTK cannot load — the entire
  // app UI is replaced by "The URL can't be shown" and only a relaunch
  // recovers. The Rust on_navigation guard in src-tauri/src/lib.rs is
  // the second line of defence for any link that still escapes this.
  // https: links are opened externally the same way (window.open,
  // _blank) instead of top-level-navigating the app WebView away to
  // them — the same idiom the OAuth sign-in and Save Page Now flows
  // already use. arknetz:// stays internal.
  installArknetzLinkInterceptor(document, (href) => {
    void go(href);
  }, {
    openExternal: (href) => {
      window.open(href, "_blank", "noopener");
    },
  });

  wireSettings();

  // Phase 1–4 panels: one app object, constructed once, mounted into the
  // sidebar nav. The panels render from the real services (mail, drive,
  // search, comments, streaming, offline, stats, domains, moderation,
  // accounts, wayback, backends) and say plainly where a network/account
  // does not exist yet.
  const panels = mountPanels(appInstance, $("panel-nav"), $("panel-host"), {
    getCurrentDoc: () => currentDoc,
    getGithubLogin: () => githubLogin,
    getSiteStats: () => appInstance.getSiteStats(currentDoc.domain),
    getTelemetrySettings: () => appInstance.getTelemetrySettings(),
    setTelemetrySettings: (next) => appInstance.setTelemetrySettings(next),
    getProjectFlags: () => appInstance.getProjectFlags(),
    getLinkedBackends: () => appInstance.getLinkedBackends(),
    getLastMirrorAttempts: () => appInstance.getLastMirrorAttempts(),
    onSignInWithGitHub: () => startGitHubSignIn(),
    onClaimDomain: async (domain, acceptedTerms) => {
      // The claim flow takes the signed-in user's OWN token + login
      // from this session (keyring-backed after sign-in) — never a
      // shared or master token. Not signed in → the flow refuses
      // with the exact message and makes no GitHub call.
      const result = await claimDomainAndOpenSite({
        domainInput: domain,
        token: githubToken,
        login: githubLogin,
        acceptedTerms,
        fetchFn: githubFetch,
        onSiteOpened: handleSiteOpened,
      });
      if (!result.ok) return { ok: false, message: result.reason };
      const vm = buildSiteOpenedViewModel(result);
      const hookNote = result.hookError
        ? ` (The claim stands, but opening the site in the editor failed: ${result.hookError})`
        : "";
      return { ok: true, message: `${vm.heading}: ${vm.message} ${vm.pendingNote}${hookNote}` };
    },
    showReader: () => {
      ($("editor") as HTMLElement).hidden = true;
      ($("reader") as HTMLElement).hidden = false;
    },
    showEditor: () => ($("edit-toggle-btn") as HTMLButtonElement).click(),
  });
  // After a sign-in completes, rebuild the nav (Moderation appears
  // only for the Root Master) and re-render the active panel.
  panelsRefreshNav = panels.refreshNav;

  ($("go-btn") as HTMLButtonElement).onclick = () => go(($("address-input") as HTMLInputElement).value);
  ($("address-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") void go(($("address-input") as HTMLInputElement).value);
  });
  ($("back-btn") as HTMLButtonElement).onclick = async () => {
    await tabs.back();
    const t = tabs.active();
    if (t) ($("address-input") as HTMLInputElement).value = t.address;
    await renderCurrent();
    updateNavButtons();
  };
  ($("forward-btn") as HTMLButtonElement).onclick = async () => {
    await tabs.forward();
    const t = tabs.active();
    if (t) ($("address-input") as HTMLInputElement).value = t.address;
    await renderCurrent();
    updateNavButtons();
  };
  ($("new-tab-btn") as HTMLButtonElement).onclick = async () => {
    // P4: a fresh tab opens the canonical guest home ("home", exactly
    // the launch state) — never a copy of the current tab. (It used to
    // open arknetz://welcome.arknetz, a second address for the same
    // welcome content, so the tab bar showed two identical
    // "ArkNetz — Home" tabs with different addresses.)
    await tabs.open("home", "ArkNetz — Home");
    ($("address-input") as HTMLInputElement).value = "home";
    renderTabs();
    await renderCurrent();
    updateNavButtons();
  };
  ($("bookmark-btn") as HTMLButtonElement).onclick = async () => {
    const t = tabs.active();
    if (!t) return;
    if (bookmarks.isBookmarked(t.address)) {
      await bookmarks.remove(t.address);
    } else {
      await bookmarks.add(t.address, t.title);
    }
    renderBookmarks();
  };
  // Top-bar sign-in: the same flow as the Accounts panel's button.
  ($("signin-btn") as HTMLButtonElement).onclick = () => startGitHubSignIn();
  // Guest badge until a sign-in lands (refreshGithubStatus owns it).
  refreshGithubStatus();

  // Visual builder: Edit mode on the document the reader is showing.
  // The editor edits a clone; closing it re-renders the reader from the
  // edited copy through the SAME renderer, so View and Edit never diverge.
  ($("edit-toggle-btn") as HTMLButtonElement).onclick = () => {
    const ui = ensureEditorUi();
    ($("reader") as HTMLElement).hidden = true;
    ui.open(currentDoc);
    // B1 (belt & braces with the grid placement in styles.css): the
    // editor replaces the reader in the same grid cell, and the view
    // scrolls to it so a first-time user never sees a blank page.
    ($("editor") as HTMLElement).scrollIntoView({ block: "start" });
  };
  document.addEventListener("arknetz:editor-closed", () => {
    if (editorUi?.doc) currentDoc = cloneDoc(editorUi.doc);
    ($("reader") as HTMLElement).hidden = false;
    ($("reader") as HTMLElement).innerHTML = renderSiteWithSaveBridge(currentDoc);
    ($("reader") as HTMLElement).scrollIntoView({ block: "start" });
  });

  ($("media-input") as HTMLInputElement).addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    const statusEl = $("media-status");
    if (!file) return;
    void (async () => {
      // Images are prepared before the stealth IA upload: downscale to
      // max 1600px, WebP 80%. The original full-size file never leaves
      // the device.
      let uploadFile: Blob = file;
      let uploadName = file.name;
      let thumbnail: { blob: Blob; filename: string } | null = null;
      if (file.type.startsWith("image/")) {
        try {
          const prepared = await prepareImageForUpload(file, file.name);
          uploadFile = prepared.blob;
          uploadName = prepared.filename;
          thumbnail = { blob: prepared.thumbnail.blob, filename: prepared.thumbnail.filename };
        } catch (err) {
          statusEl.textContent = `Image processing unavailable (${err instanceof Error ? err.message : String(err)}) — attaching the original file.`;
        }
      }
      const media = attachMedia(
        uploadFile,
        uploadName,
        iaKeys,
        iaQueue,
        async (url, init) => {
          const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
          return { status: res.status, text: () => res.text() };
        },
        (done) => {
          if (done.status === "ready") {
            statusEl.innerHTML = `Uploaded to the Internet Archive: <a href="${done.hotlink}">${done.hotlink}</a> — the post stores only this hotlink.`;
          } else if (done.status === "failed") {
            statusEl.textContent = "Upload failed — your local copy is kept, retry later. Nothing was lost.";
          }
        },
      );
      if (thumbnail && iaKeys) {
        attachMedia(thumbnail.blob, thumbnail.filename, iaKeys, iaQueue, async (url, init) => {
          const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
          return { status: res.status, text: () => res.text() };
        }, () => {});
      }
      if (media.status === "ia_not_linked") {
        statusEl.textContent = "ia_not_linked — link an Internet Archive account in Settings to enable stealth upload. Your file is shown locally for now; nothing was uploaded.";
      } else {
        statusEl.textContent = `Uploading “${uploadName}” to the Internet Archive in the background… (local preview kept until it succeeds)`;
        if (media.localPreviewUrl) {
          const img = document.createElement("img");
          img.src = media.localPreviewUrl;
          img.style.maxWidth = "100%";
          statusEl.appendChild(img);
        }
      }
    })();
  });
}

void init();
