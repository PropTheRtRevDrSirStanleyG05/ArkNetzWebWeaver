// Panels — mounts the 15 phase panels into the shell.
// This is the single integration hook for phases 1–4: the app is
// constructed once (createArkNetzApp) and every panel renders from the
// real phase services, not from placeholders. Where a panel needs a
// network/account that does not exist yet (no central repos, no OAuth
// App), it says so in the panel instead of pretending.
// Pure renderers live in renderPanelHtml() so tests can exercise them
// without a DOM; mountPanels() adds the nav + button wiring.
import { APP_PANELS, visiblePanelsForLogin, type ArkNetzApp } from "./app.js";
import { MASTER_GITHUB_USER } from "./config.js";
import { ADMIN_COPY, buildAdminPanelViewModel } from "./moderation-ui.js";
import { availabilityMessage, CLAIM_COPY, claimSteps } from "./domains-ui.js";
import { checkDomainAvailability, normalizeDomain } from "./domains.js";
import { accountSwitcherPillView, tosAcceptanceView } from "./network/accounts-ui.js";
import { backendPickerView } from "./network/backends-ui.js";
import { wireWaybackPanel } from "./network/wayback-ui.js";
import { renderBackendsPanelHtml, mountBackendsPanel } from "./network/backends-panel.js";
import type { BackendPrefix, MirrorAttempt, ProjectFlags } from "./network/backends.js";
import { createMemoryTosStore, hasAccepted, recordAcceptance, tosAcceptanceStatusLine } from "./network/tos.js";
import { COPY as VIEWER_COPY, commentsPanelView } from "./viewer/viewer-ui.js";
import {
  OFFLINE_COPY,
  STREAMING_COPY,
  offlineViewModel,
  streamingViewModel,
} from "./viewer/viewer2-ui.js";
import { renderStatsPanelHtml, mountStatsPanel } from "./viewer/stats-panel.js";
import { defaultTelemetrySettings, emptyStats } from "./viewer/stats.js";
import type { SiteStats, TelemetrySettings } from "./viewer/stats.js";
import { bundleSummary, packSiteOffline } from "./viewer/offline.js";
import { buildNewlyUpdatedFeed, buildTrendingFeed } from "./viewer/search.js";
import { newDraft, saveDraft, validateDraft, validateMailAddress } from "./mail/compose.js";
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
}

export function createPanelState(): PanelState {
  return { mailKeypair: null, mailAddress: "", vaultLabel: null, vault: null, vaultFiles: [] };
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
        section("Inbox", vm.totalCount === 0 ? `<p>${esc(vm.emptyCopy)}</p>` : `<ul>${vm.rows.map((r) => `<li><strong>${esc(r.subject)}</strong> — ${esc(r.from)} · ${esc(r.snippet)}</li>`).join("")}</ul><p>${vm.unreadCount} unread.</p>`) +
        section(
          "Compose (draft saved locally)",
          `<label>To <input id="an-mail-to" type="text" placeholder="friend@computers.edu"></label>
           <label>Subject <input id="an-mail-subject" type="text"></label>
           <label>Body <textarea id="an-mail-body" rows="4"></textarea></label>
           <button id="an-mail-draft-btn" type="button">Save draft</button>
           <div id="an-mail-draft-status" role="status"></div>
           <p class="an-note">Sending needs the recipient's public key from the contacts directory and a signed-in GitHub account — the directory is empty until the central repos exist, so sending stays disabled until then. Drafts are real and saved locally now.</p>`,
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
      const vm = commentsPanelView(
        { id: "demo", domain: "welcome.arknetz", pagePath: "/", title: "Welcome", locked: false, comments: [], moderationLog: [] },
        { viewerLogin: null, siteOwner: MASTER_GITHUB_USER },
      );
      return (
        h +
        note(VIEWER_COPY.commentsGuestRead) +
        `<p>Guests can read: ${vm.canRead ? "yes" : "no"}. Guests can comment: ${vm.canComment ? "yes" : "no"} — ${esc(vm.commentBlockedReason)}</p>
         <p>${vm.totalCount} comment${vm.totalCount === 1 ? "" : "s"} on this page. Comments live as GitHub Discussions/Issues in the site owner's repo, so posting needs sign-in and a real site repo.</p>`
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
      return (
        h +
        note(CLAIM_COPY.intro) +
        section(
          "Claim a domain",
          `<ol>${steps.map((s) => `<li><strong>${esc(s.title)}</strong> — ${esc(s.description)}</li>`).join("")}</ol>
           <label>Domain <input id="an-domain-name" type="text" placeholder="computers.edu"></label>
           <button id="an-domain-check-btn" type="button">Check availability</button>
           <div id="an-domain-status" role="status">No claim in progress.</div>
           <p class="an-note">Registration is completely open — no account-age minimum, no per-user limit. Claims go through a GitHub Issue to the central registry repos, which do not exist yet, so claiming is checked locally until they do.</p>`,
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
      const tosStore = createMemoryTosStore();
      const accepted = await hasAccepted(tosStore, "guest");
      const tosVm = tosAcceptanceView(accepted);
      const activeGithub = app.keyring.getActive("github");
      const githubStatus = activeGithub
        ? `Signed in with GitHub as ${activeGithub.username ?? activeGithub.label}${app.keyring.isMasterAdmin() ? " — Root Master" : ""}.`
        : "Not signed in with GitHub. Publishing, claiming a domain, and sending mail need sign-in.";
      return (
        h +
        section("Accounts", `<p>${esc(pill.pillLabel)} — ${pill.signedInCount} account${pill.signedInCount === 1 ? "" : "s"} signed in. ${pill.masterBadgeVisible ? esc(pill.masterBadgeLabel) : "Root Master controls appear only when the active GitHub account is " + MASTER_GITHUB_USER + "."}</p>
         <p class="an-note">The keyring ${app.keyring.isUnlocked ? "is unlocked" : "is locked"} — profiles are encrypted in IndexedDB under your passphrase. One-click switching across gh:/gl:/cb:/ia:/hf:/wm: needs linked accounts; ${pill.signedInCount === 0 ? "none are linked yet." : "switch from the pill in the top bar."}</p>`) +
        section("GitHub sign-in", `<p>${esc(githubStatus)}</p><p class="an-note">Sign-in runs the real GitHub OAuth flow: the app opens github.com, GitHub sends the app back to arknetz://oauth/callback, and the code is exchanged for a token inside the Tauri shell — the client secret never enters the app. The signed-in account joins the keyring above like any other backend account.</p><button id="an-github-signin-btn" type="button">Sign in with GitHub</button><div id="an-github-signin-status" role="status"></div>`) +
        section("Keyring", `<p class="an-note">The keyring holds every backend account's token, encrypted under one vault passphrase. It must be unlocked before a signed-in account can be saved — a GitHub sign-in while it is locked works for this session only. ${app.keyring.isUnlocked ? "Unlocked." : "Locked."}</p><label>Vault passphrase <input id="an-keyring-pass" type="password" autocomplete="current-password"></label> <button id="an-keyring-unlock-btn" type="button">Unlock keyring</button> <button id="an-keyring-lock-btn" type="button">Lock keyring</button><div id="an-keyring-status" role="status"></div>`) +
        section("Acceptable Use", `<p>${esc(tosVm.note)}</p><button id="an-tos-accept-btn" type="button">${esc(tosVm.label)}</button><div id="an-tos-status" role="status"></div>`)
      );
    }
    case "wayback": {
      return (
        h +
        note("Snapshots come from the Wayback Machine's free CDX API; if a site's primary repo is deleted or unreachable, the client falls back to the latest preserved snapshot.") +
        `<label>Public URL to look up <input id="an-wayback-url" type="text" placeholder="https://raw.githubusercontent.com/you/repo/main/site.json.zst"></label>
         <button id="an-wayback-btn" type="button">Look up snapshots</button>
         <button id="an-wayback-save-btn" type="button">Snapshot now (Save Page Now)</button>
         <div id="an-wayback-results" role="status"></div>`
      );
    }
    case "backends": {
      // renderBackendsPanelHtml carries its own <h2>Backends</h2>.
      return renderBackendsPanelHtml(backendsDeps(opts));
    }
    case "settings":
      return h + note("Internet Archive and GitHub settings live in the sidebar on the left — link IA keys there to enable stealth upload, and sign in with GitHub to enable Publish.");
    default:
      return h + note("This panel is registered but has no renderer yet.");
  }
}

/** Wire a rendered panel's buttons. Called by mountPanels after render. */
export function wirePanel(
  root: HTMLElement,
  app: ArkNetzApp,
  panelId: string,
  state: PanelState,
  opts: PanelHostOptions,
  rerender: () => void,
): void {
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
        rerender();
      }).catch((e) => {
        if (status) status.textContent = e instanceof Error ? e.message : String(e);
      });
    });
  }
  if (panelId === "mail" && state.mailKeypair) {
    $("an-mail-draft-btn")?.addEventListener("click", () => {
      const to = ($("an-mail-to") as HTMLInputElement | null)?.value.trim() ?? "";
      const subject = ($("an-mail-subject") as HTMLInputElement | null)?.value ?? "";
      const body = ($("an-mail-body") as HTMLTextAreaElement | null)?.value ?? "";
      const status = $("an-mail-draft-status");
      const draft = { ...newDraft(state.mailAddress), to: [to], subject, body };
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
      const store = createMemoryTosStore();
      void recordAcceptance(store, "guest", "first-sign-in").then((a) => {
        if (status) status.textContent = tosAcceptanceStatusLine(a);
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
    wireWaybackPanel(root, fetchFn);
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
  const showPanel = (panelId: string): void => {
    active = panelId;
    for (const btn of nav.querySelectorAll<HTMLButtonElement>("button[data-panel]")) {
      btn.setAttribute("aria-selected", String(btn.dataset.panel === panelId));
    }
    void renderPanelHtml(app, panelId, state, opts).then((html) => {
      host.innerHTML = html;
      wirePanel(host, app, panelId, state, opts, () => showPanel(active));
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
        if (panel.id === "browse") opts.showReader();
        if (panel.id === "builder") opts.showEditor();
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
  showPanel(active);
  return { showPanel, state, refreshNav };
}

