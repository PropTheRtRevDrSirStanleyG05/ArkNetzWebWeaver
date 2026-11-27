// Panels — mounts the 17 phase panels into the shell.
// This is the single integration hook for phases 1–4: the app is
// constructed once (createArkNetzApp) and every panel renders from the
// real phase services, not from placeholders. Where a panel needs a
// network/account that does not exist yet (no central repos, no OAuth
// App), it says so in the panel instead of pretending.
// Pure renderers live in renderPanelHtml() so tests can exercise them
// without a DOM; mountPanels() adds the nav + button wiring.
import { APP_PANELS, visiblePanelsForLogin, type ArkNetzApp } from "./app.js";
import { scrollBelowTopbar } from "./scroll.js";
import { MASTER_GITHUB_USER } from "./config.js";
import { ADMIN_COPY, buildAdminPanelViewModel } from "./moderation-ui.js";
import { availabilityMessage, CLAIM_COPY, claimSteps } from "./domains-ui.js";
import { checkDomainAvailability, normalizeDomain } from "./domains.js";
import { accountSwitcherPillView, tosAcceptanceView } from "./network/accounts-ui.js";
import { backendPickerView } from "./network/backends-ui.js";
import { wireWaybackPanel } from "./network/wayback-ui.js";
import { waybackFetch } from "./network/wayback.js";
import { renderBackendsPanelHtml, mountBackendsPanel } from "./network/backends-panel.js";
import type { BackendPrefix, MirrorAttempt, ProjectFlags } from "./network/backends.js";
import { createMemoryTosStore, hasAccepted, recordAcceptance, tosAcceptanceStatusLine } from "./network/tos.js";
import type { TosStore } from "./network/tos.js";
import { COPY as VIEWER_COPY, commentsPanelView } from "./viewer/viewer-ui.js";
import {
  OFFLINE_COPY,
  STREAMING_COPY,
  offlineViewModel,
  streamingViewModel,
} from "./viewer/viewer2-ui.js";
import { renderStatsPanelHtml, mountStatsPanel } from "./viewer/stats-panel.js";
import { renderP2PPanelHtml, mountP2PPanel } from "./p2p/panel.js";
import type { P2PPanelDeps } from "./p2p/panel.js";
import { CALLS_NO_WEBRTC_COPY, mountCallsPanel, renderCallsPanelHtml } from "./p2p/call-panel.js";
import { defaultTelemetrySettings, emptyStats } from "./viewer/stats.js";
import type { SiteStats, TelemetrySettings } from "./viewer/stats.js";
import { bundleSummary, packSiteOffline } from "./viewer/offline.js";
import { buildNewlyUpdatedFeed, buildTrendingFeed } from "./viewer/search.js";
import { newDraft, saveDraft, validateDraft, validateMailAddress } from "./mail/compose.js";
import type { MailDraft } from "./mail/compose.js";
import type { MailKeypair } from "./mail/types.js";
import { inboxViewModel, MAIL_NO_KEY_COPY, MAIL_ONLY_PROTOCOL_NOTICE } from "./mail/mail-ui.js";
import { bindDriveDropZone, DropUploadTracker, DROP_ZONE_COPY, fileListView, HONEST_LIMITS_COPY, quotaView } from "./drive/drive-ui.js";
import type { VaultManager } from "./drive/drive.js";
import type { VaultFile } from "./drive/types.js";
import type { SiteDocument } from "./types.js";

export interface PanelHostOptions {
  /** The document the reader is showing (used by Save Site Offline). */
  getCurrentDoc: () => SiteDocument;
  /** Show the reader (browse panel) / editor (builder panel). */
  showReader: () => void;
  showEditor: () => void;
  /** The signed-in GitHub login, or null for a guest. Used only to
   *  decide whether the Moderation nav button is shown (P5: hidden
   *  unless the active account is the Root Master). Defaults to guest. */
  getGithubLogin?: () => string | null | undefined;
  /** The signed-in user's own GitHub OAuth token (mail inbox poll +
   *  send). Null = not signed in. */
  getGithubToken?: () => string | null | undefined;
  /** Mail panel: send a sealed draft. The shell owns the send
   *  (P2P first, GitHub inbox fallback) and returns the plain-
   *  language outcome for the status line. Absent in tests — the
   *  Send button then says so. */
  onSendMail?: (draft: MailDraft, keypair: MailKeypair) => Promise<{ ok: boolean; message: string }>;
  /** Mail panel: a keypair was just created (or cleared) — the shell
   *  uses it to configure the P2P identity + inbound envelope
   *  handler. */
  onMailKeypair?: (keypair: MailKeypair | null, address: string) => void;
  /** Drive panel: a vault was just opened (or closed) — the shell
   *  uses it to wire the P2P drive-chunk sink + known vault ids. */
  onVaultOpened?: (vault: VaultManager | null) => void;
  /** Called synchronously on every panel switch, after the reader /
   *  editor toggle: the shell uses it to hide the main layout (reader
   *  + sidebar + editor) while a non-browse, non-builder panel is
   *  active (hunt 4 M4 — panels used to stack above the full reader,
   *  so every panel read as one endless page). */
  onPanelShown?: (panelId: string) => void;
  fetchFn?: typeof fetch;
  /** Default: anchor-click download. Overridable in tests. */
  download?: (blob: Blob, filename: string) => void;
  /** Stats panel: rolled-up stats for the site being read. Defaults
   *  to emptyStats(current doc domain) — honest empty states until a
   *  site with stats is loaded. */
  getSiteStats?: () => SiteStats;
  /** Stats panel: current telemetry settings (Strict Offline / Public
   *  View Counter). Defaults to defaultTelemetrySettings(). */
  getTelemetrySettings?: () => TelemetrySettings;
  /** Stats panel: persist toggled telemetry settings. */
  setTelemetrySettings?: (next: TelemetrySettings) => void;
  /** Backends panel: project flags for ToS-aware upload routing.
   *  Defaults to {} (hf:/wm: not offered as upload targets). */
  getProjectFlags?: () => ProjectFlags;
  /** Backends panel: linked-account label per backend prefix.
   *  Defaults to {} (nothing linked). */
  getLinkedBackends?: () => Partial<Record<BackendPrefix, string>>;
  /** Backends panel: mirror attempts from the last site load.
   *  Defaults to [] (no load through mirrors yet). */
  getLastMirrorAttempts?: () => MirrorAttempt[];
  /** Accounts panel: start the GitHub OAuth sign-in (the shell's
   *  startGitHubSignIn). The panel only renders the button; the shell
   *  owns the flow. Absent in tests — the button then says so. */
  onSignInWithGitHub?: () => void;
  /** Domains panel: file a claim for a domain (the shell's
   *  claimDomainAndOpenSite call). Returns the plain-language outcome
   *  for the status line — including the exact refusal when the user
   *  is not signed in. Absent in tests — the button then says so. */
  onClaimDomain?: (domain: string, acceptedTerms: boolean) => Promise<{ ok: boolean; message: string }>;
}

/** Per-mount mutable panel state (keypair, opened vault label + handle). */
export interface PanelState {
  mailKeypair: MailKeypair | null;
  mailAddress: string;
  vaultLabel: string | null;
  /** The opened vault, once the user has opened one — the drop zone
   *  binds to this handle. Null until then. */
  vault: VaultManager | null;
  /** Files in the vault root, refreshed after open and after each drop. */
  vaultFiles: VaultFile[];
  /** The ONE ToS acceptance store for this mount (hunt 5): render +
   *  wire used to create a fresh memory store each — the Accept
   *  button recorded into a throwaway store, so the acceptance never
   *  survived a panel switch even within the session. */
  tosStore: TosStore;
}

export function createPanelState(): PanelState {
  return { mailKeypair: null, mailAddress: "", vaultLabel: null, vault: null, vaultFiles: [], tosStore: createMemoryTosStore() };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function section(title: string, body: string): string {
  return `<section><h3>${esc(title)}</h3>${body}</section>`;
}

function note(text: string): string {
  return `<p class="an-note">${esc(text)}</p>`;
}

/** Stats deps from ONE source: renderPanelHtml() and wirePanel() must
 *  read the same stats/settings, or the toggles re-render stale
 *  values. No accessor yet → empty stats for the current doc's domain
 *  and the default settings (both honest). */
function statsDeps(opts: PanelHostOptions): { stats: SiteStats; settings: TelemetrySettings } {
  return {
    stats: opts.getSiteStats ? opts.getSiteStats() : emptyStats(opts.getCurrentDoc().domain ?? ""),
    settings: opts.getTelemetrySettings ? opts.getTelemetrySettings() : defaultTelemetrySettings(),
  };
}

/** Backends deps from ONE source, for the same reason. */
function backendsDeps(opts: PanelHostOptions): {
  projectFlags: ProjectFlags;
  linked: Partial<Record<BackendPrefix, string>>;
  lastMirrorAttempts: MirrorAttempt[];
} {
  return {
    projectFlags: opts.getProjectFlags ? opts.getProjectFlags() : {},
    linked: opts.getLinkedBackends ? opts.getLinkedBackends() : {},
    lastMirrorAttempts: opts.getLastMirrorAttempts ? opts.getLastMirrorAttempts() : [],
  };
}

/** P2P deps from ONE source: renderPanelHtml() and wirePanel() must
 *  read the same settings/peer id, or the toggles re-render stale
 *  values. Connected peers are read fresh on every render (an async
 *  diagnostics call) — a peer that connected since the last render
 *  shows up on the next panel switch. */
async function p2pDeps(app: ArkNetzApp): Promise<P2PPanelDeps> {
  return {
    settings: app.getP2PSettings(),
    peerId: app.getP2PPeerId(),
    selfAddress: app.getP2PSelfAddress(),
    connectedPeers: await app.getP2PConnectedPeers().catch(() => []),
    iceServersInEffect: app.getP2PIceServers(),
  };
}

/** Render one panel to HTML from the live app services. No DOM needed. */
export async function renderPanelHtml(
  app: ArkNetzApp,
  panelId: string,
  state: PanelState,
  opts: PanelHostOptions,
): Promise<string> {
  const panel = APP_PANELS.find((p) => p.id === panelId);
  if (!panel) return note(`Unknown panel: ${panelId}`);
  const h = `<h2>${esc(panel.title)}</h2><p>${esc(panel.description)}</p>`;

  switch (panelId) {
    case "browse":
      return h + note("The reader is the browse surface — use the address bar and tabs above. Guest browsing needs no sign-in.");
    case "builder":
      return h + note("The visual builder edits the document the reader is showing — use the ✎ Edit site button above.");
    case "mail": {
      if (!state.mailKeypair) {
        return (
          h +
          note(MAIL_ONLY_PROTOCOL_NOTICE) +
          note(MAIL_NO_KEY_COPY) +
          `<label>Your protocol address <input id="an-mail-address" type="text" placeholder="you@computers.edu" value="${esc(state.mailAddress)}"></label>
           <button id="an-mail-keypair-btn" type="button">Create my mail keypair</button>
           <div id="an-mail-status" role="status"></div>`
        );
      }
      const inbox = app.openInbox(state.mailKeypair);
      const mails = await inbox.list("inbox");
      const vm = inboxViewModel(mails);
      return (
        h +
        note(`Signed in to protocol mail as ${state.mailAddress}. ${MAIL_ONLY_PROTOCOL_NOTICE}`) +
        section("Inbox", `<p><button id="an-mail-refresh-btn" type="button">Refresh inbox</button></p><div id="an-mail-refresh-status" role="status"></div>` + (vm.totalCount === 0 ? `<p>${esc(vm.emptyCopy)}</p>` : `<ul>${vm.rows.map((r) => `<li><strong>${esc(r.subject)}</strong> — ${esc(r.from)} · ${esc(r.snippet)}</li>`).join("")}</ul><p>${vm.unreadCount} unread.</p>`)) +
        section(
          "Compose (draft saved locally)",
          `<label>To <input id="an-mail-to" type="text" placeholder="friend@computers.edu"></label>
           <label>CC <input id="an-mail-cc" type="text" placeholder="teammate@computers.edu (optional, comma-separated)"></label>
           <label>BCC <input id="an-mail-bcc" type="text" placeholder="quiet@computers.edu (optional, comma-separated)"></label>
           <label>Subject <input id="an-mail-subject" type="text"></label>
           <label>Body <textarea id="an-mail-body" rows="4"></textarea></label>
           <button id="an-mail-draft-btn" type="button">Save draft</button>
           <button id="an-mail-send-btn" type="button">Send</button>
           <div id="an-mail-draft-status" role="status"></div>
           <p class="an-note">Send seals the draft with the recipient's public key from the contacts directory and delivers it — straight to the recipient when they are an online peer, otherwise to their GitHub inbox. Sending needs a signed-in GitHub account; without one the button refuses and the draft still saves locally.</p>`,
        )
      );
    }
    case "drive": {
      const picker = backendPickerView({});
      const quota = state.vaultLabel
        ? quotaView({ backend: { kind: "gh", uri: state.vaultLabel, repo: state.vaultLabel, accountId: "" } as never, fileCount: 0, folderCount: 0, blobCount: 0, usedBytes: 0, quotaBytes: 0, usedRatio: 0 })
        : null;
      return (
        h +
        note(HONEST_LIMITS_COPY.title + " — " + HONEST_LIMITS_COPY.quota) +
        note(HONEST_LIMITS_COPY.sharing) +
        note(HONEST_LIMITS_COPY.collaboration) +
        section(
          "Open a vault",
          `<p>${esc(picker.note)}</p>
           <label>Backend <select id="an-drive-backend"><option value="gh">GitHub (private repo)</option><option value="gl">GitLab (private repo)</option><option value="cb">Codeberg (private repo)</option></select></label>
           <label>Repo <input id="an-drive-repo" type="text" placeholder="you/arknetz-vault"></label>
           <label>Vault passphrase <input id="an-drive-pass" type="password"></label>
           <label>Access token <input id="an-drive-token" type="password" autocomplete="off"></label>
           <button id="an-drive-open-btn" type="button">Open vault</button>
           <div id="an-drive-status" role="status">${state.vaultLabel ? `Vault open: ${esc(state.vaultLabel)}` : "No vault open yet."}</div>`,
        ) +
        section(
          "Files",
          state.vault
            ? `<div id="an-drive-dropzone" data-dropzone="true"><p>${esc(DROP_ZONE_COPY.hint)}</p>` +
              (fileListView(state.vaultFiles).rows.length
                ? `<ul>${fileListView(state.vaultFiles).rows.map((r) => `<li>${esc(r.name)} — ${esc(r.sizeLabel)}</li>`).join("")}</ul>`
                : `<p>${esc(fileListView([]).copy.body)}</p>`) +
              `<div id="an-drive-progress" role="status"></div></div>`
            : quota
              ? `<p>${esc(quota.usedLabel)} used of ${esc(quota.quotaLabel)} in ${esc(quota.repo)}.</p>`
              : `<p><strong>${esc(fileListView([]).copy.heading)}</strong> — ${esc(fileListView([]).copy.body)}</p>`,
        )
      );
    }
    case "search": {
      const hits = app.searchIndex.size;
      const trending = buildTrendingFeed([], [], Date.now() / 1000);
      const fresh = buildNewlyUpdatedFeed([], 20);
      return (
        h +
        `<label>Search the directory <input id="an-search-q" type="text" placeholder="domain, title, or tag"></label>
         <button id="an-search-btn" type="button">Search</button>
         <div id="an-search-results" role="status"></div>` +
        section("Index", `<p>${hits} metadata card${hits === 1 ? "" : "s"} indexed locally. The directory shards live in the central repos, which do not exist yet — search works over whatever the app has indexed so far.</p>`) +
        section("Trending", trending.length ? `<ul>${trending.map((t) => `<li>${esc(t.card.domain)}</li>`).join("")}</ul>` : "<p>Nothing trending yet.</p>") +
        section("Newly updated", fresh.length ? `<ul>${fresh.map((c) => `<li>${esc(c.domain)}</li>`).join("")}</ul>` : "<p>Nothing new yet.</p>")
      );
    }
    case "comments": {
      // Hunt 5: the thread used to be hardcoded to the demo site, so
      // the panel always said "0 comments on this page" for the demo
      // even while reading another site. The counts are still the
      // demo's honest empty state (no comments mirror is loaded yet),
      // but the panel now names the site actually being read.
      const doc = opts.getCurrentDoc();
      const vm = commentsPanelView(
        { id: "demo", domain: doc.domain, pagePath: "/", title: doc.title, locked: false, comments: [], moderationLog: [] },
        { viewerLogin: null, siteOwner: MASTER_GITHUB_USER },
      );
      return (
        h +
        note(VIEWER_COPY.commentsGuestRead) +
        `<p>Guests can read: ${vm.canRead ? "yes" : "no"}. Guests can comment: ${vm.canComment ? "yes" : "no"} — ${esc(vm.commentBlockedReason)}</p>
         <p>${vm.totalCount} comment${vm.totalCount === 1 ? "" : "s"} on ${esc(vm.domain)} yet. Comments live as GitHub Discussions/Issues in the site owner's repo, so posting needs sign-in and a real site repo.</p>`
      );
    }
    case "streaming": {
      const vm = await streamingViewModel([], app.progressStore, app.myListStore);
      return (
        h +
        note(STREAMING_COPY.myListHint) +
        section("Continue watching", vm.continueWatching.length ? `<ul>${vm.continueWatching.map((c) => `<li>${esc(c.seriesTitle)} — ${esc(c.episodeTitle)} · ${esc(c.resumeLabel)} (${c.percent}%)</li>`).join("")}</ul>` : "<p>Nothing in progress — resume positions are stored locally in IndexedDB.</p>") +
        section("My List", vm.myList.length ? `<ul>${vm.myList.map((m) => `<li>${esc(m.title)}</li>`).join("")}</ul>` : "<p>Your list is empty and private — it never leaves this device.</p>")
      );
    }
    case "offline": {
      const vm = offlineViewModel(packSiteOffline(opts.getCurrentDoc(), []));
      return (
        h +
        note(OFFLINE_COPY.saveHint) +
        `<button id="an-offline-save-btn" type="button">Save the current site offline (.arknetz)</button>
         <div id="an-offline-status" role="status">${esc(vm.summary)}</div>
         <p class="an-note">The bundle is a single portable ZIP you can open with zero internet, or share over USB/Bluetooth/Discord.</p>`
      );
    }
    case "stats": {
      // renderStatsPanelHtml carries its own <h2>Stats</h2>, like the
      // other dedicated panel modules — no `h` prefix here.
      return renderStatsPanelHtml(statsDeps(opts));
    }
    case "domains": {
      const steps = claimSteps();
      const signedIn = opts.getGithubLogin?.() != null;
      return (
        h +
        note(CLAIM_COPY.intro) +
        section(
          "Claim a domain",
          `<ol>${steps.map((s) => `<li><strong>${esc(s.title)}</strong> — ${esc(s.description)}</li>`).join("")}</ol>
           <label>Domain <input id="an-domain-name" type="text" placeholder="computers.edu"></label>
           <button id="an-domain-check-btn" type="button">Check availability</button>
           <label class="an-terms-label"><input id="an-domain-terms" type="checkbox"> ${esc(CLAIM_COPY.termsLabel)}</label>
           <button id="an-domain-claim-btn" type="button">${esc(CLAIM_COPY.submitLabel)}</button>
           <div id="an-domain-status" role="status">No claim in progress.</div>
           ${signedIn ? "" : `<p class="an-note" id="an-domain-signin-note">Sign in with GitHub first to claim a domain</p>`}
           <p class="an-note">Registration is completely open — no account-age minimum, no per-user limit. Availability is checked against the registry shard; claiming files a REGISTER issue, creates your site repo, and opens the site in the editor while the register bot files the domain (usually 5 to 10 seconds).</p>`,
        )
      );
    }
    case "moderation": {
      const vm = buildAdminPanelViewModel(null, [], []);
      return (
        h +
        (vm.visible
          ? section("Root Master admin", `<p>${esc(vm.intro)}</p>`)
          : note(ADMIN_COPY.hiddenMessage))
      );
    }
    case "accounts": {
      const pill = accountSwitcherPillView(app.keyring.snapshot(), app.keyring.isMasterAdmin());
      const accepted = await hasAccepted(state.tosStore, "guest");
      const tosVm = tosAcceptanceView(accepted);
      const activeGithub = app.keyring.getActive("github");
      const githubStatus = activeGithub
        ? `Signed in with GitHub as ${activeGithub.username ?? activeGithub.label}${app.keyring.isMasterAdmin() ? " — Root Master" : ""}.`
        : "Not signed in with GitHub. Publishing, claiming a domain, and sending mail need sign-in.";
      return (
        h +
        section("Accounts", `<p>${esc(pill.pillLabel)} — ${pill.signedInCount} account${pill.signedInCount === 1 ? "" : "s"} signed in. ${pill.masterBadgeVisible ? esc(pill.masterBadgeLabel) : "Root Master controls appear only when the active GitHub account is " + MASTER_GITHUB_USER + "."}</p>
         <p class="an-note">The keyring ${app.keyring.isUnlocked ? "is unlocked" : "is locked"} — profiles are encrypted in IndexedDB under your passphrase. One-click switching across gh:/gl:/cb:/ia:/hf:/wm: needs linked accounts; ${pill.signedInCount === 0 ? "none are linked yet." : "switch from the pill in the top bar."}</p>`) +
        section("GitHub sign-in", `<p>${esc(githubStatus)}</p><p class="an-note">Sign-in uses GitHub's device flow: the app shows you a short code, you enter it at github.com/device in your browser, and GitHub sends the app a token directly — no client secret lives on the device, and nothing needs to redirect back. If Device Flow is not enabled on the OAuth App yet, the app says so exactly and offers the redirect sign-in as a fallback. The signed-in account joins the keyring above like any other backend account.</p><button id="an-github-signin-btn" type="button">Sign in with GitHub</button><div id="an-github-signin-status" role="status"></div>`) +
        section("Keyring", `<p class="an-note">The keyring holds every backend account's token, encrypted under one vault passphrase. It must be unlocked before a signed-in account can be saved — a GitHub sign-in while it is locked works for this session only. ${app.keyring.isUnlocked ? "Unlocked." : "Locked."}</p><label>Vault passphrase <input id="an-keyring-pass" type="password" autocomplete="current-password"></label> <button id="an-keyring-unlock-btn" type="button">Unlock keyring</button> <button id="an-keyring-lock-btn" type="button">Lock keyring</button><div id="an-keyring-status" role="status"></div>`) +
        section("Acceptable Use", `<p>${esc(tosVm.note)}</p>${tosVm.accepted ? `<p>Accepted ${esc(tosVm.acceptedAtDisplay ?? tosVm.acceptedAt ?? "")} — recorded on this device.</p>` : `<button id="an-tos-accept-btn" type="button">${esc(tosVm.label)}</button>`}<div id="an-tos-status" role="status"></div>`)
      );
    }
    case "wayback": {
      return (
        h +
        note("Snapshots come from the Wayback Machine's free CDX API; if a site's primary repo is deleted or unreachable, the client falls back to the latest preserved snapshot.") +
        `<label>Public URL to look up <input id="an-wayback-url" type="text" placeholder="https://…/site.json.zst"></label>
         <button id="an-wayback-btn" type="button">Look up snapshots</button>
         <button id="an-wayback-save-btn" type="button">Snapshot now (Save Page Now)</button>
         <div id="an-wayback-results" role="status"></div>`
      );
    }
    case "backends": {
      // renderBackendsPanelHtml carries its own <h2>Backends</h2>.
      return renderBackendsPanelHtml(backendsDeps(opts));
    }
    case "p2p": {
      // renderP2PPanelHtml carries its own <h2>P2P</h2>.
      return renderP2PPanelHtml(await p2pDeps(app));
    }
    case "calls": {
      // renderCallsPanelHtml carries its own <h2>Calls</h2>. No
      // controller here (Node, or a WebView without WebRTC) means
      // the panel says calls cannot run, instead of pretending.
      const controller = app.getCallsController();
      if (!controller) return h + note(CALLS_NO_WEBRTC_COPY);
      return renderCallsPanelHtml(controller.viewModel());
    }
    case "settings":
      return h + note("Internet Archive and GitHub settings live in the sidebar — below the reader on a phone — link IA keys there to enable stealth upload, and sign in with GitHub to enable Publish.");
    default:
      return h + note("This panel is registered but has no renderer yet.");
  }
}

/** Split a comma-separated CC/BCC field into clean addresses. */
function splitMailAddresses(value: string): string[] {
  return value
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/** Wire a rendered panel's buttons. Called by mountPanels after render. */
export async function wirePanel(
  root: HTMLElement,
  app: ArkNetzApp,
  panelId: string,
  state: PanelState,
  opts: PanelHostOptions,
  rerender: () => void,
): Promise<void> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`);
  const download = opts.download ?? ((blob: Blob, filename: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  });

  if (panelId === "mail" && !state.mailKeypair) {
    $("an-mail-keypair-btn")?.addEventListener("click", () => {
      const addr = ($("an-mail-address") as HTMLInputElement | null)?.value.trim() ?? "";
      const status = $("an-mail-status");
      const err = validateMailAddress(addr);
      if (err) {
        if (status) status.textContent = err;
        return;
      }
      void app.newMailKeypair(addr).then((kp) => {
        state.mailKeypair = kp;
        state.mailAddress = addr;
        opts.onMailKeypair?.(kp, addr);
        rerender();
      }).catch((e) => {
        if (status) status.textContent = e instanceof Error ? e.message : String(e);
      });
    });
  }
  if (panelId === "mail" && state.mailKeypair) {
    // Inbox refresh: pull the GitHub inbox (Issue inbox) into the
    // local store, then re-render. The P2P signal poll lives in the
    // shell (it needs no keypair); this is the GitHub half, and it
    // needs the keypair that lives in this panel's state.
    $("an-mail-refresh-btn")?.addEventListener("click", () => {
      const status = $("an-mail-refresh-status");
      const login = opts.getGithubLogin?.();
      const token = opts.getGithubToken?.();
      if (!login || !token) {
        if (status) status.textContent = "Sign in with GitHub first to refresh the inbox.";
        return;
      }
      const keypair = state.mailKeypair;
      if (!keypair) return;
      if (status) status.textContent = "Refreshing inbox…";
      void app.mailDelivery
        .pollInbox(login, token)
        .then(async ({ pulled }) => {
          const inbox = app.openInbox(keypair);
          for (const item of pulled) {
            if (item.envelope) await inbox.receive(item.envelope, item.issueNumber);
          }
          if (status) status.textContent = pulled.length ? `${pulled.length} new message${pulled.length === 1 ? "" : "s"} pulled from the GitHub inbox.` : "Inbox is up to date — nothing new.";
          rerender();
        })
        .catch((e) => {
          if (status) status.textContent = e instanceof Error ? e.message : String(e);
        });
    });
    $("an-mail-draft-btn")?.addEventListener("click", () => {
      const to = ($("an-mail-to") as HTMLInputElement | null)?.value.trim() ?? "";
      const cc = splitMailAddresses(($("an-mail-cc") as HTMLInputElement | null)?.value ?? "");
      const bcc = splitMailAddresses(($("an-mail-bcc") as HTMLInputElement | null)?.value ?? "");
      const subject = ($("an-mail-subject") as HTMLInputElement | null)?.value ?? "";
      const body = ($("an-mail-body") as HTMLTextAreaElement | null)?.value ?? "";
      const status = $("an-mail-draft-status");
      const draft = { ...newDraft(state.mailAddress), to: to ? [to] : [], cc, bcc, subject, body };
      const problems = validateDraft(draft);
      if (problems.length) {
        if (status) status.textContent = problems.join(" ");
        return;
      }
      void saveDraft(app.draftStore, draft).then(() => {
        if (status) status.textContent = "Draft saved locally.";
      }).catch((e) => {
        if (status) status.textContent = e instanceof Error ? e.message : String(e);
      });
    });
    // Send: seal + deliver through the shell (P2P first, GitHub
    // inbox fallback). The button refuses plainly without sign-in
    // instead of pretending to send.
    $("an-mail-send-btn")?.addEventListener("click", () => {
      const to = ($("an-mail-to") as HTMLInputElement | null)?.value.trim() ?? "";
      const cc = splitMailAddresses(($("an-mail-cc") as HTMLInputElement | null)?.value ?? "");
      const bcc = splitMailAddresses(($("an-mail-bcc") as HTMLInputElement | null)?.value ?? "");
      const subject = ($("an-mail-subject") as HTMLInputElement | null)?.value ?? "";
      const body = ($("an-mail-body") as HTMLTextAreaElement | null)?.value ?? "";
      const status = $("an-mail-draft-status");
      const draft: MailDraft = { ...newDraft(state.mailAddress), to: to ? [to] : [], cc, bcc, subject, body };
      const problems = validateDraft(draft);
      if (problems.length) {
        if (status) status.textContent = problems.join(" ");
        return;
      }
      // Hunt 5: the panel promises the draft still saves locally when
      // sending refuses — so save it first, best-effort, before any
      // refusal path below (the old code claimed the save without
      // doing it).
      void saveDraft(app.draftStore, draft).catch(() => undefined);
      const keypair = state.mailKeypair;
      if (!keypair) return;
      if (!opts.onSendMail) {
        if (status) status.textContent = "Sending is not wired in this build — the draft is saved locally instead.";
        return;
      }
      if (status) status.textContent = "Sending…";
      void opts
        .onSendMail(draft, keypair)
        .then((result) => {
          if (status) status.textContent = result.message;
        })
        .catch((e) => {
          if (status) status.textContent = e instanceof Error ? e.message : String(e);
        });
    });
  }
  if (panelId === "drive") {
    $("an-drive-open-btn")?.addEventListener("click", () => {
      const backend = ($("an-drive-backend") as HTMLSelectElement | null)?.value as "gh" | "gl" | "cb";
      const repo = ($("an-drive-repo") as HTMLInputElement | null)?.value.trim() ?? "";
      const pass = ($("an-drive-pass") as HTMLInputElement | null)?.value ?? "";
      const token = ($("an-drive-token") as HTMLInputElement | null)?.value ?? "";
      const status = $("an-drive-status");
      if (!repo || !pass) {
        if (status) status.textContent = "A repo and a vault passphrase are required.";
        return;
      }
      // Per-user key rule (fix round 3): a vault opens only with its
      // owner's own provider token. No shared/master token exists, so
      // an empty token field is a plain-English stop, not a silent
      // unauthenticated attempt (the vault client would refuse anyway).
      if (!token) {
        if (status) status.textContent = `A ${backend === "gh" ? "GitHub" : backend === "gl" ? "GitLab" : "Codeberg"} token is required — sign in with your own ${backend === "gh" ? "GitHub" : backend === "gl" ? "GitLab" : "Codeberg"} account first. ArkDrive never uses a shared token.`;
        return;
      }
      try {
        const vault = app.openVault({ kind: backend, uri: `${backend}:${repo}`, repo, accountId: "" } as never, token || undefined);
        void vault.open(pass).then(async () => {
          state.vaultLabel = `${backend}:${repo}`;
          state.vault = vault;
          opts.onVaultOpened?.(vault);
          try {
            state.vaultFiles = await vault.listFolder(null);
          } catch {
            state.vaultFiles = [];
          }
          rerender();
        }).catch((e) => {
          if (status) status.textContent = e instanceof Error ? e.message : String(e);
        });
      } catch (e) {
        if (status) status.textContent = e instanceof Error ? e.message : String(e);
      }
    });
  }
  if (panelId === "drive" && state.vault) {
    const zone = $("an-drive-dropzone");
    const progressEl = $("an-drive-progress");
    if (zone) {
      const vault = state.vault;
      const tracker = new DropUploadTracker();
      const renderProgress = (): void => {
        if (!progressEl) return;
        const view = tracker.view();
        progressEl.innerHTML = view.items.length
          ? `<ul>${view.items.map((i) => `<li>${esc(i.relativePath)} — ${esc(i.stageLabel)} (${i.percent}%)${i.error ? ` — ${esc(i.error)}` : ""}</li>`).join("")}</ul>`
          : "";
      };
      bindDriveDropZone(zone, {
        onFiles: (files) => {
          void vault.uploadDroppedFiles(files, null, (p) => {
            tracker.progressCallback()(p);
            renderProgress();
          }).then(async () => {
            try {
              state.vaultFiles = await vault.listFolder(null);
            } catch {
              // Keep the old list — the upload itself already reported.
            }
            renderProgress();
            rerender();
          }).catch((e) => {
            if (progressEl) progressEl.textContent = e instanceof Error ? e.message : String(e);
          });
        },
        onError: (e) => {
          if (progressEl) progressEl.textContent = e.message;
        },
      });
    }
  }
  if (panelId === "search") {
    const run = () => {
      const q = ($("an-search-q") as HTMLInputElement | null)?.value ?? "";
      const out = $("an-search-results");
      if (!out) return;
      const hits = app.searchIndex.search(q);
      app.searchHistory.record(q);
      out.innerHTML = hits.length
        ? `<ul>${hits.map((hit) => `<li>${esc(hit.card.domain)} — ${esc(hit.card.title)}</li>`).join("")}</ul>`
        : `<p>No results for “${esc(q)}” in the local index.</p>`;
    };
    $("an-search-btn")?.addEventListener("click", run);
    ($("an-search-q") as HTMLInputElement | null)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
  }
  if (panelId === "offline") {
    $("an-offline-save-btn")?.addEventListener("click", () => {
      const status = $("an-offline-status");
      try {
        const doc = opts.getCurrentDoc();
        const bundle = packSiteOffline(doc, []);
        const blob = new Blob([bundle.bytes as unknown as BlobPart], { type: "application/zip" });
        download(blob, `${doc.domain ?? "site"}.arknetz`);
        if (status) status.textContent = bundleSummary(bundle);
      } catch (e) {
        if (status) status.textContent = e instanceof Error ? e.message : String(e);
      }
    });
  }
  if (panelId === "domains") {
    $("an-domain-claim-btn")?.addEventListener("click", () => {
      const raw = ($("an-domain-name") as HTMLInputElement | null)?.value ?? "";
      const status = $("an-domain-status");
      const domain = normalizeDomain(raw);
      if (!domain) {
        if (status) status.textContent = "Enter a domain, e.g. computers.edu.";
        return;
      }
      const terms = ($("an-domain-terms") as HTMLInputElement | null)?.checked ?? false;
      if (!opts.onClaimDomain) {
        if (status) status.textContent = "Claiming is not wired in this view — open the app shell to claim a domain.";
        return;
      }
      if (status) status.textContent = `Claiming ${domain}…`;
      void opts
        .onClaimDomain(domain, terms)
        .then((r) => {
          if (status) status.textContent = r.message;
        })
        .catch((e) => {
          if (status) status.textContent = e instanceof Error ? e.message : String(e);
        });
    });
    $("an-domain-check-btn")?.addEventListener("click", () => {
      const raw = ($("an-domain-name") as HTMLInputElement | null)?.value ?? "";
      const status = $("an-domain-status");
      const domain = normalizeDomain(raw);
      if (!domain) {
        if (status) status.textContent = "Enter a domain, e.g. computers.edu.";
        return;
      }
      if (status) status.textContent = `Checking ${domain} against its registry shard…`;
      void checkDomainAvailability(domain, async (url) => {
        const res = await fetchFn(url);
        // Pass arrayBuffer through: the check reads the canonical
        // registry.json.zst first (fix round 2, item 8) and a
        // text-only adapter would make every .zst read throw.
        return { status: res.status, text: () => res.text(), arrayBuffer: () => res.arrayBuffer() };
      }).then((result) => {
        if (status) status.textContent = availabilityMessage(result);
      }).catch((e) => {
        // The central repos do not exist yet, so a failed fetch means
        // "cannot check yet" — never "taken" and never "free".
        if (status) status.textContent = `Could not check ${domain} — the registry repos do not exist yet (${e instanceof Error ? e.message : String(e)}).`;
      });
    });
  }
  if (panelId === "accounts") {
    $("an-tos-accept-btn")?.addEventListener("click", () => {
      const status = $("an-tos-status");
      // Hunt 5: record into the mount's SHARED store (state.tosStore),
      // not a fresh one — the old handler recorded into a throwaway
      // store, so the acceptance vanished on the next panel switch.
      // Re-render so the section flips to its accepted state at once.
      void recordAcceptance(state.tosStore, "guest", "first-sign-in").then((a) => {
        if (status) status.textContent = tosAcceptanceStatusLine(a);
        rerender();
      }).catch((e) => {
        if (status) status.textContent = e instanceof Error ? e.message : String(e);
      });
    });
    $("an-keyring-unlock-btn")?.addEventListener("click", () => {
      const pass = ($("an-keyring-pass") as HTMLInputElement | null)?.value ?? "";
      const status = $("an-keyring-status");
      void app.keyring.unlock(pass).then(() => {
        rerender();
      }).catch((e) => {
        if (status) status.textContent = e instanceof Error ? e.message : String(e);
      });
    });
    $("an-keyring-lock-btn")?.addEventListener("click", () => {
      app.keyring.lock();
      rerender();
    });
    $("an-github-signin-btn")?.addEventListener("click", () => {
      const status = $("an-github-signin-status");
      if (status) status.textContent = "Opening GitHub sign-in…";
      if (opts.onSignInWithGitHub) {
        opts.onSignInWithGitHub();
      } else if (status) {
        status.textContent = "GitHub sign-in is not wired in this shell.";
      }
    });
  }
  if (panelId === "wayback") {
    // Hunt 5 (P1): the Time Machine lookup must go through the Rust
    // `wayback_fetch` command — web.archive.org sends no CORS headers,
    // so a plain window.fetch is blocked in the WebView.
    wireWaybackPanel(root, waybackFetch);
  }
  if (panelId === "stats") {
    const deps = statsDeps(opts);
    mountStatsPanel(root, {
      stats: deps.stats,
      settings: deps.settings,
      onSettingsChange: opts.setTelemetrySettings,
    });
  }
  if (panelId === "backends") {
    mountBackendsPanel(root, backendsDeps(opts));
  }
  if (panelId === "p2p") {
    const deps = await p2pDeps(app);
    mountP2PPanel(root, {
      ...deps,
      onSettingsChange: (next) => app.setP2PSettings(next),
      onRotatePeerId: () => {
        void app.rotateP2PPeerId().catch(() => undefined);
      },
      onResetPeerId: () => {
        void app.resetP2PPeerId().catch(() => undefined);
      },
    });
  }
  if (panelId === "calls") {
    const controller = app.getCallsController();
    if (controller) mountCallsPanel(root, controller);
  }
}

/** Mount the panel nav + host into the shell. The nav shows only the
 *  panels visible for the current login (P5: no Moderation button for
 *  guests or non-master accounts); `refreshNav()` rebuilds it after a
 *  sign-in/out, falling back to Browse if the active panel disappears.
 *  Guest browsing stays the default: Browse is active on mount. */
export function mountPanels(
  app: ArkNetzApp,
  nav: HTMLElement,
  host: HTMLElement,
  opts: PanelHostOptions,
): { showPanel: (panelId: string) => void; state: PanelState; refreshNav: () => void } {
  const state = createPanelState();
  let active = "browse";
  const showPanel = (panelId: string, scroll = true): void => {
    active = panelId;
    for (const btn of nav.querySelectorAll<HTMLButtonElement>("button[data-panel]")) {
      btn.setAttribute("aria-selected", String(btn.dataset.panel === panelId));
    }
    // M3: switching to a panel scrolls the panel host into view — a
    // panel clicked from the bottom of the page used to render above
    // the fold, with the viewport still showing the reader/editor.
    // Hunt 4: below the STICKY topbar, not under it — plain
    // scrollIntoView({block:"start"}) hid the panel heading behind
    // the bar on every switch.
    // Hunt 4 regression watch: the MOUNT call must not scroll at all —
    // a fresh load should land at scrollY 0 (toolbar first), not
    // yanked to the panel host. showPanel(active, false) below.
    if (scroll) scrollBelowTopbar(host);
    opts.onPanelShown?.(panelId);
    void renderPanelHtml(app, panelId, state, opts).then((html) => {
      host.innerHTML = html;
      void wirePanel(host, app, panelId, state, opts, () => showPanel(active));
    });
  };
  const buildNav = (): void => {
    nav.innerHTML = "";
    const login = opts.getGithubLogin?.() ?? null;
    for (const panel of visiblePanelsForLogin(APP_PANELS, login)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "an-panel-btn";
      btn.dataset.panel = panel.id;
      btn.textContent = panel.title;
      btn.setAttribute("aria-selected", String(panel.id === active));
      btn.addEventListener("click", () => {
        // M5: only Builder keeps the editor open. Browse — and every
        // other panel — shows the reader, so the editor never stacks
        // below a panel with the reader hidden behind it.
        if (panel.id === "builder") opts.showEditor();
        else opts.showReader();
        showPanel(panel.id);
      });
      nav.appendChild(btn);
    }
  };
  const refreshNav = (): void => {
    buildNav();
    const login = opts.getGithubLogin?.() ?? null;
    const visible = visiblePanelsForLogin(APP_PANELS, login);
    if (!visible.some((p) => p.id === active)) showPanel("browse");
    else showPanel(active);
  };
  buildNav();
  showPanel(active, false);
  return { showPanel, state, refreshNav };
}

