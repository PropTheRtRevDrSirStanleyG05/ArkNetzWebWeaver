// ArkNetzWebWeaver — core shell UI wiring.
// Guest browsing is the default: the app opens on the demo site with no
// sign-in. Sign-in is a real GitHub OAuth entry point (auth.ts) — it
// throws, loudly, until a GitHub OAuth App client id is configured, and
// it never invents a token. Reads go through CachedFetcher +
// RegistryResolver (raw.githubusercontent.com only, ETag cached).
// The demo site (welcome.arknetz) is bundled so the shell is usable
// before any central repo exists; it is labelled as a demo in the page.

import { CachedFetcher, createIndexedDBStore, createMemoryCacheStore } from "./lib/cache.js";
import { RegistryResolver, siteZstUrl } from "./lib/registry.js";
import { installArknetzLinkInterceptor, renderSiteDocument } from "./lib/renderer.js";
import {
  AppSaveBridge,
  createAppBridgeTokensForSite,
  createIndexedDBAppSaveStore,
  createMemoryAppSaveStore,
  installAppBridgeListener,
} from "./lib/viewer/app-bridge.js";
import type { AppBridgeReplyTarget, AppSaveStore } from "./lib/viewer/app-bridge.js";
import { buildAuthorizeUrl, completeOAuthCallback, completeDeviceSignIn, pollDeviceToken, randomState, requestDeviceCode, savePendingOAuthState, takePendingOAuthState } from "./lib/auth.js";
import { openExternalUrl } from "./lib/opener.js";
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
import { pageSlugForAddress, sitePageForPath } from "./lib/pages.js";
import { ClaimWatcher } from "./lib/claim-watcher.js";
import { buildSiteOpenedViewModel } from "./lib/domains-ui.js";
import {
  BookmarkManager,
  TabManager,
  createMemoryShellStore,
} from "./lib/shell.js";
import { DEMO_SITE } from "./lib/sample.js";
import { EditorUI } from "./lib/editor-ui.js";
import type { SiteDocument } from "./lib/types.js";
import { createArkNetzApp } from "./lib/app.js";
import type { ArkNetzApp } from "./lib/app.js";
import { buildMailFromDraft } from "./lib/mail/compose.js";
import type { MailDraft } from "./lib/mail/compose.js";
import type { MailAddress, MailKeypair } from "./lib/mail/types.js";
import type { VaultManager } from "./lib/drive/drive.js";
import { installDeepLinkListener, isOAuthCallbackUrl } from "./lib/deep-link.js";
import { scrollBelowTopbar } from "./lib/scroll.js";
import { mountPanels } from "./lib/panels.js";
import { AccountPill } from "./lib/network/account-pill.js";
import type { PillElement } from "./lib/network/account-pill.js";
import type { AccountProfile, AccountProvider } from "./lib/network/accounts.js";

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
/** Phase 2 P2P shell state: the mail keypair + address (from the
 *  mail panel — the shell never invents them) and the open vault
 *  (from the drive panel). syncP2PShell() runs whenever any of the
 *  inputs lands; until sign-in + keypair are present the host stays
 *  inert (all-off settings, no connections, no ads). */
let mailKeypair: MailKeypair | null = null;
let mailAddress = "";
let openVault: VaultManager | null = null;
/** The top-bar Account Switcher Pill (D6): created once the app
 *  object exists, re-rendered on every GitHub status refresh. */
let accountPill: AccountPill | null = null;
/** Rebuild the panel nav after sign-in/out (Moderation appears only
 *  for the Root Master). Set by mountPanels in init(). */
let panelsRefreshNav: (() => void) | null = null;
// The document currently shown in the reader — the editor edits a clone
// of this, and the reader re-renders from the edited copy on close, so
// View and Edit always show the same renderer output.
let currentDoc: SiteDocument = JSON.parse(JSON.stringify(DEMO_SITE)) as SiteDocument;
/** Sub-page slug of the address the reader is showing ("" = the site
 *  root). While a sub-page is shown the Edit toggle is disabled:
 *  the editor publishes the document it opened as the site root, so
 *  editing a sub-page would overwrite the root with it (hunt 4).
 *  Sub-page editing lands as its own change, with a page-aware
 *  publish; until then the toggle says so in its title. */
let currentPath = "";
function updateEditToggle(): void {
  const btn = $("edit-toggle-btn") as HTMLButtonElement;
  btn.disabled = currentPath !== "";
  btn.title =
    currentPath === ""
      ? "Edit the current site in the visual builder"
      : "Sub-pages are read-only in this version — go Home to edit the site";
}
/** GitHub login that owns the site repo for currentDoc (registry
 *  entry / claim record). Null = unknown (demo site, external link,
 *  or a load whose entry could not be read) — collab join then
 *  falls back to the signed-in user. */
let currentSiteOwner: string | null = null;
/** Watches the pending REGISTER issue of the last filed claim (D3):
 *  one watcher at a time, stopped when the claim resolves, fails, or
 *  the editor closes. */
let claimWatcher: ClaimWatcher | null = null;
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
      getSiteOwner: () => currentSiteOwner,
      getSiteRepo: (domain: string) => siteRepoName(domain),
      githubFetch,
      htmlFetch,
      // Phase 2 P2P: the editor joins the P2P collab channel
      // alongside the relay when the app has a host and P2P collab
      // is enabled; relay-only when this returns null.
      getCollabP2PHook: (domain: string) => app?.getP2PCollabHook(domain) ?? null,
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

function parseAddress(raw: string): { kind: "demo" | "domain" | "https"; value: string; path: string } {
  const s = raw.trim();
  if (s === "home" || s === "arknetz://welcome.arknetz") return { kind: "demo", value: s, path: "" };
  if (s.startsWith("arknetz://")) {
    // A path on the bundled demo domain is a sub-page of the demo
    // site (hunt 4: it used to resolve to the demo root and the
    // reader re-rendered the same home document, so the address
    // changed and the content never did).
    const host = s.slice("arknetz://".length).split("/")[0] as string;
    if (host === DEMO_SITE.domain) return { kind: "demo", value: s, path: pageSlugForAddress(s, host) };
    return { kind: "domain", value: host, path: pageSlugForAddress(s, host) };
  }
  if (s.startsWith("https://")) return { kind: "https", value: s, path: "" };
  return { kind: "domain", value: s, path: "" };
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
  // The sub-page slug of the address being shown ("" = the site
  // root). Sub-pages are read-only in the editor for now — editing
  // one could publish it as the site root — so the Edit toggle is
  // disabled while one is shown (hunt 4).
  currentPath = parsed.path;
  updateEditToggle();
  if (parsed.kind === "demo") {
    const page = sitePageForPath(DEMO_SITE, parsed.path);
    currentDoc = cloneDoc(page);
    currentSiteOwner = null;
    reader.innerHTML = `<p class="an-note">Demo site bundled with the shell — the registry is live but no sites have been published yet, so this is a demo, not a live network site.</p>` + renderSiteWithSaveBridge(page);
    return;
  }
  if (parsed.kind === "https") {
    currentSiteOwner = null;
    reader.innerHTML = `<p>External link — opened in the system browser in the Tauri app. <a href="${parsed.value}">${parsed.value}</a></p>`;
    return;
  }
  reader.innerHTML = `<p>Loading ${parsed.value}…</p>`;
  try {
    // Phase 2 P2P: try a peer first, then the CDN. loadSiteViaPeer
    // returns null whenever P2P cannot serve (off, unsigned, no
    // peer, any failure) — the reader then loads from the CDN
    // exactly as before, silently. A P2P failure never surfaces as
    // a load error.
    let peerSite: SiteDocument | null = null;
    try {
      peerSite = await app?.p2pHost.loadSiteViaPeer(parsed.value, (domain) => resolver.resolve(domain)) ?? null;
    } catch {
      peerSite = null;
    }
    const site = peerSite ?? (await resolver.loadSite(parsed.value));
    const page = sitePageForPath(site, parsed.path);
    currentDoc = cloneDoc(page);
    // The registry entry knows the site repo's owner — collab join
    // addresses the owner's repo, so a non-owner collaborator joins
    // the right repo. Best-effort: the shard fetch is cached, and a
    // failure here only loses the owner (join falls back to the
    // signed-in user) — never the site itself.
    try {
      currentSiteOwner = (await resolver.resolve(parsed.value)).owner;
    } catch {
      currentSiteOwner = null;
    }
    reader.innerHTML = renderSiteWithSaveBridge(page);
  } catch (err) {
    currentSiteOwner = null;
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
 *  (githubToken/githubLogin). The Account Switcher Pill shows the
 *  active account (or Guest); the Accounts panel copy points at it.
 *  Enforcement stays GitHub's 403, never the UI. */
function refreshGithubStatus(): void {
  const ghStatus = $("gh-status");
  ghStatus.textContent = githubToken
    ? `GitHub: signed in as ${githubLogin ?? "unknown"} — Publish can run.`
    : "GitHub: not signed in. Publish needs sign-in (and a GitHub OAuth App must exist first).";
  renderAccountPill();
}

/** Phase 2 P2P shell sync: wire the host's identity, mail handler,
 *  and drive sink from whatever the shell knows so far. Safe to call
 *  after every input lands (sign-in, keypair creation, vault open)
 *  and at init. Each half is independent:
 *  - identity needs sign-in + a mail keypair (the private key opens
 *    sealed signal Issues; the address is the peer ad's address).
 *    Until both exist the host stays inert — no connections, no ads.
 *  - the drive sink needs only an open vault (chunk receipt is
 *    independent of mail identity).
 *  The host's own timers (signal poll 30 s, ad republish 15 min,
 *  silence check 60 s) start once identity + the master switch are
 *  on; the shell never runs a second poller. */
function syncP2PShell(): void {
  if (!app) return;
  const host = app.p2pHost;
  if (githubToken && githubLogin && mailKeypair && mailAddress) {
    host.configureIdentity({
      address: mailAddress as MailAddress,
      githubLogin,
      token: githubToken,
      privateKey: mailKeypair.privateKey,
    });
    // Inbound P2P envelopes land in the normal inbox path (the same
    // store the mail panel reads). The handler is only set once a
    // keypair exists — until then the mail adapter is never attached,
    // so no envelope is ever acked and then lost.
    host.setMailEnvelopeHandler(async (envelope) => {
      if (!mailKeypair || !app) return;
      const inbox = app.openInbox(mailKeypair);
      await inbox.receive(envelope);
    });
  } else {
    host.setMailEnvelopeHandler(null);
  }
  if (openVault?.vaultId) {
    host.setKnownVaultIds(new Set([openVault.vaultId]));
    host.setDriveChunkSink(async (chunk) => {
      if (!openVault || openVault.vaultId !== chunk.vaultId) return;
      await openVault.importStoredChunk(chunk.vaultId, chunk.blobId, chunk.bytes);
    });
  } else {
    host.setKnownVaultIds(new Set());
    host.setDriveChunkSink(null);
  }
  host.start();
}

/** Send a sealed protocol-mail draft (the mail panel's Send button).
 *  P2P first, GitHub inbox fallback — the host seals once and
 *  delivers per recipient. When the host cannot send (no identity
 *  configured — e.g. the keypair predates this session's sign-in),
 *  the shell seals the same draft itself and delivers straight to
 *  each recipient's GitHub inbox, so a send never fails for a P2P
 *  reason. Not signed in → exact refusal, zero GitHub calls. */
async function sendProtocolMail(
  draft: MailDraft,
  keypair: MailKeypair,
): Promise<{ ok: boolean; message: string }> {
  if (!app) return { ok: false, message: "The app is not ready yet — try again in a moment." };
  if (!githubToken || !githubLogin) {
    return { ok: false, message: "Sign in with GitHub first to send mail." };
  }
  const host = app.p2pHost;
  try {
    const result = await host.sendDraft(draft, keypair);
    const viaP2p = result.p2p.length;
    const viaGithub = result.github.length;
    const parts: string[] = [];
    if (viaP2p) parts.push(`${viaP2p} delivered direct over P2P`);
    if (viaGithub) parts.push(`${viaGithub} delivered to the GitHub inbox`);
    return { ok: true, message: `Sent. ${parts.join("; ") || "No recipients?"}.` };
  } catch (err) {
    // The host path needs identity; fall back to the plain GitHub
    // inbox delivery with the same sealed envelope.
    if (!(err instanceof Error) || !/identity/i.test(err.message)) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    const envelope = await buildMailFromDraft(draft, keypair, (address) =>
      host.resolveContact(address).then((entry) => entry ?? undefined),
    );
    const sent: string[] = [];
    for (const address of [...draft.to, ...draft.cc, ...draft.bcc]) {
      const contact = await host.resolveContact(address);
      const githubUser =
        contact?.githubUser ?? (await resolver.resolve(address.split("@")[1] as string)).owner;
      await app.mailDelivery.deliver(envelope, githubUser, githubToken);
      sent.push(address);
    }
    return { ok: true, message: `Sent to the GitHub inbox (${sent.length} recipient${sent.length === 1 ? "" : "s"}) — P2P was not available for this send.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Build the Account Switcher Pill once, re-render it on every
 *  status refresh. The pill reads the keyring (snapshot + master
 *  check); switching goes through switchAccount below, which owns
 *  the token + session update. No app object yet (before init) →
 *  the pill keeps its static "Guest" label from index.html. */
function renderAccountPill(): void {
  if (!app) return;
  if (!accountPill) {
    accountPill = new AccountPill(
      $("account-pill") as unknown as PillElement,
      $("account-menu") as unknown as PillElement,
      {
        keyring: app.keyring,
        switchAccount: (provider, id) => switchAccount(provider, id),
        onAddAccount: () => startGitHubSignIn(),
        onSwitched: () => {
          refreshGithubStatus();
          panelsRefreshNav?.();
        },
        reportStatus: (message) => {
          const status = $("signin-status");
          status.textContent = message;
          status.hidden = false;
        },
        createElement: (tag) => document.createElement(tag) as unknown as PillElement,
      },
    );
  }
  accountPill.render();
}

/** Switch the active account from the Account Switcher Pill (D6).
 *  The token is revealed FIRST: when the keyring is locked the
 *  secret cannot be read, so the switch is refused before anything
 *  changes — the pill, the session, and the active account all stay
 *  as they were. On success the keyring switch persists (switchAll),
 *  the session token/login move to the new GitHub account, and the
 *  pill + panels re-render. Non-GitHub providers switch the keyring
 *  active account only (no session token). Throws on failure; the
 *  pill reports it. */
async function switchAccount(
  provider: AccountProvider,
  id: string,
): Promise<{ profile: AccountProfile; token: string | null }> {
  if (!app) throw new Error("the app is not ready yet — try switching again in a moment");
  let token: string | null = null;
  if (provider === "github") {
    // Throws when locked (or the account is gone): no switch happens.
    token = await app.keyring.revealSecret("github", id);
  }
  const selected = await app.keyring.switchAll({ [provider]: id });
  const profile = selected[provider];
  if (!profile) throw new Error(`could not switch to the ${provider} account "${id}"`);
  if (provider === "github") {
    githubToken = token;
    githubLogin = profile.username ?? profile.label;
  }
  return { profile, token };
}

/** Start the GitHub OAuth sign-in: build the authorize URL (client id
 *  + redirect_uri + scopes + random state) and open it in the SYSTEM
 *  browser through the opener plugin — never inside the app WebView
 *  (hunt 4: window.open kept GitHub in-app, where the nav guard
 *  blocks the arknetz:// callback, so sign-in could never return).
 *  The pending state is saved to localStorage so the callback can be
 *  validated even if the OS delivers it to a second app process (see
 *  auth.ts). Throws loudly, with the exact fix, when no client id is
 *  configured — never a broken URL, never a fake token. */
function startRedirectSignIn(): void {
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
    showStatus("Opening GitHub sign-in in your browser…");
    void openExternalUrl(url).then((tookPlugin) => {
      if (!tookPlugin) {
        showStatus("Opening GitHub sign-in… if nothing opened, open this URL by hand: " + url);
      }
    });
  } catch (err) {
    showStatus(err instanceof Error ? err.message : String(err));
  }
}

/** Set to true by the Cancel button while a device-flow poll is
 *  running; the poll's sleep function throws on the next wait, which
 *  ends the poll as a cancellation instead of a token. */
let deviceFlowCancelled = false;

/** Start GitHub sign-in with the DEVICE flow (hunt 4, BUG 1 — the
 *  primary path). It needs only the client id: no client secret, no
 *  redirect URI, no deep link — so it is the only sign-in that can
 *  complete on a phone, where the redirect flow's secret can never
 *  exist. The app shows the short code, opens github.com/device in
 *  the system browser, and polls until GitHub issues the token.
 *  If Device Flow is not enabled on the OAuth App yet, GitHub answers
 *  device_flow_disabled: the strip shows the exact checkbox to enable
 *  and offers the redirect sign-in as a fallback (which still needs
 *  the client secret on desktop via the environment variable). */
async function startGitHubSignIn(): Promise<void> {
  const status = $("signin-status");
  const showStatus = (msg: string): void => {
    status.textContent = msg;
    status.hidden = false;
  };
  // A fresh attempt clears any previous device-code UI.
  status.replaceChildren();
  showStatus("Starting GitHub sign-in…");
  let code;
  try {
    code = await requestDeviceCode();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showStatus(message);
    if (/Device Flow is not enabled/.test(message)) {
      const fallback = document.createElement("button");
      fallback.type = "button";
      fallback.textContent = "Try redirect sign-in instead";
      fallback.onclick = () => startRedirectSignIn();
      status.appendChild(document.createTextNode(" "));
      status.appendChild(fallback);
    }
    return;
  }
  // Show the code + actions. The code comes from GitHub, so it is
  // inserted as text, never HTML.
  deviceFlowCancelled = false;
  status.replaceChildren();
  const intro = document.createElement("span");
  intro.textContent = `GitHub sign-in: enter code `;
  const codeEl = document.createElement("code");
  codeEl.textContent = code.userCode;
  const at = document.createElement("span");
  at.textContent = ` at github.com/device, then wait here — this page completes itself. `;
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.textContent = "Open github.com/device";
  openBtn.onclick = () => {
    void openExternalUrl(code.verificationUri).then((tookPlugin) => {
      if (!tookPlugin) {
        showStatus(`If nothing opened, open ${code.verificationUri} by hand and enter code ${code.userCode}.`);
      }
    });
  };
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => {
    deviceFlowCancelled = true;
  };
  status.append(intro, codeEl, at, openBtn, document.createTextNode(" "), cancelBtn);
  status.hidden = false;
  // Offer the browser immediately as well as on button press — the
  // user asked to sign in, so opening the page is the expected step.
  void openExternalUrl(code.verificationUri);
  try {
    const token = await pollDeviceToken(code.deviceCode, {
      intervalSec: code.interval,
      deadlineMs: Date.now() + code.expiresIn * 1000,
      sleepFn: async (ms: number) => {
        if (deviceFlowCancelled) throw new Error("cancelled");
        await new Promise<void>((r) => setTimeout(r, ms));
        if (deviceFlowCancelled) throw new Error("cancelled");
      },
    });
    const { user } = await completeDeviceSignIn(token);
    githubToken = token;
    githubLogin = user.login;
    syncP2PShell();
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
    if (err instanceof Error && err.message === "cancelled") {
      showStatus("GitHub sign-in cancelled — no account was created.");
      return;
    }
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
    syncP2PShell();
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
    let message = err instanceof Error ? err.message : String(err);
    // Hunt 4: the common mobile failure is the missing client secret
    // (the redirect exchange needs one and a phone has none). Point
    // at the sign-in that needs no secret instead of leaving the user
    // with a dead end.
    if (/not_configured/.test(message)) {
      message += " On this device, use the device sign-in instead — it needs no client secret (tap “Sign in with GitHub” again).";
    }
    showStatus(message);
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
  currentPath = "";
  updateEditToggle();
  // The claim record knows the site repo's owner (the claimer) —
  // collab join addresses that repo.
  currentSiteOwner = opened.registryEntry.owner;
  // Phase 2 P2P: the claimed domain is now one of my own — the peer
  // ad publishes it (serves) once P2P is on and identity is set.
  void app?.p2pHost.addOwnDomain(opened.domain).catch(() => undefined);
  const ui = ensureEditorUi();
  ($("reader") as HTMLElement).hidden = true;
  ui.showSiteOpened(opened);
  startClaimWatcher(opened);
  scrollBelowTopbar($("editor") as HTMLElement);
}

/** Watch the filed claim's REGISTER issue until it closes (D3): the
 *  pending-claim screen said it updates when the issue closes, and
 *  this is what does it. One watcher at a time — a new claim stops
 *  the old one. Resolves into the editor status line; a terminal
 *  failure (issue gone, token dead) says so plainly and stops
 *  instead of spinning. Stopped when the editor closes. */
function startClaimWatcher(opened: OpenedSite): void {
  claimWatcher?.stop();
  claimWatcher = null;
  const ui = editorUi;
  if (!ui) return;
  const watcher = new ClaimWatcher(
    { fetchFn: githubFetch, getToken: () => githubToken },
    {
      onResolved: (claim) => {
        claimWatcher = null;
        ui.setStatusLine(
          `"${claim.domain}" is now registered — the register bot closed the claim issue (${claim.issueUrl ?? "no issue URL"}).`,
        );
      },
      onFailed: (claim, reason) => {
        claimWatcher = null;
        ui.setStatusLine(
          `Could not confirm the claim for "${claim.domain}": ${reason}. The claim may still be pending — check ${claim.issueUrl ?? "the registry repo"} directly.`,
        );
      },
      onError: (claim, reason) => {
        ui.setStatusLine(
          `Still waiting on the claim for "${claim.domain}" — the last check failed: ${reason}`,
        );
      },
    },
  );
  claimWatcher = watcher;
  watcher.start(opened.claim);
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
  await appInstance.loadP2PSettings();
  await appInstance.keyring.load();
  // Phase 2 P2P shell wiring: the host resolves registry entries
  // through the shell's resolver, and serves sites from the
  // reader's ETag cache (a bundle already fetched stays servable;
  // serving never fetches from the CDN on someone else's behalf).
  // The host's own timers start once identity + the master switch
  // are on (syncP2PShell, called on sign-in / keypair / vault).
  appInstance.p2pHost.setRegistryResolver((domain) => resolver.resolve(domain));
  appInstance.p2pHost.setCachedBundleProvider(async (domain) => {
    try {
      const entry = await resolver.resolve(domain);
      const { bytes } = await fetcher.fetchBytes(siteZstUrl(entry));
      return bytes;
    } catch {
      return null;
    }
  });
  syncP2PShell();

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
      // Hunt 4: through the opener plugin, so an external link leaves
      // the app for the system browser instead of opening a second
      // in-app window (or nothing at all, on Android).
      void openExternalUrl(href);
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
    getGithubToken: () => githubToken,
    onSendMail: (draft, keypair) => sendProtocolMail(draft, keypair),
    onMailKeypair: (keypair, address) => {
      mailKeypair = keypair;
      mailAddress = address;
      syncP2PShell();
    },
    onVaultOpened: (vault) => {
      openVault = vault;
      syncP2PShell();
    },
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
    // Hunt 4 M4: a panel replaces the page instead of stacking above
    // it — while a non-browse, non-builder panel is active the main
    // layout (reader + sidebar + editor) is hidden, so a panel never
    // reads as one endless page with the whole site underneath it.
    // Browse shows the reader, Builder shows the editor (both live
    // inside main, so it stays visible for those two).
    onPanelShown: (panelId) => {
      const main = document.querySelector("main.an-layout") as HTMLElement | null;
      // Hunt 4 regression watch: showPanel runs once on MOUNT (Browse),
      // and on mount main was never hidden — scrolling the reader then
      // yanks a fresh load ~1300px down the page, past the toolbar,
      // panels and sidebar. Only scroll when we are RETURNING from a
      // hidden main (another panel was showing).
      const wasHidden = main?.hidden ?? false;
      if (main) main.hidden = panelId !== "browse" && panelId !== "builder";
      // The view switch scrolls its content below the topbar too:
      // the Builder click opens the editor BEFORE this runs (its own
      // scroll fires while main is still hidden), so the scroll that
      // counts is this one, after main is visible again.
      if (!wasHidden) return;
      if (panelId === "browse") scrollBelowTopbar($("reader") as HTMLElement);
      if (panelId === "builder") scrollBelowTopbar($("editor") as HTMLElement);
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
    scrollBelowTopbar($("editor") as HTMLElement);
  };
  document.addEventListener("arknetz:editor-closed", () => {
    // Closing the editor ends the pending-claim watch too: nothing
    // polls for a claim nobody is looking at.
    claimWatcher?.stop();
    claimWatcher = null;
    if (editorUi?.doc) currentDoc = cloneDoc(editorUi.doc);
    ($("reader") as HTMLElement).hidden = false;
    ($("reader") as HTMLElement).innerHTML = renderSiteWithSaveBridge(currentDoc);
    scrollBelowTopbar($("reader") as HTMLElement);
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
