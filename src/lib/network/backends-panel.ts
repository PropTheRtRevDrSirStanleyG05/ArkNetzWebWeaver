// ArkNetzWebWeaver — Backends panel (fix agent C).
// Backends surfaced only as a Backend select inside the ArkDrive panel.
// This module is the dedicated Backends panel: every pluggable backend
// (gh:/gl:/cb:/ia:/hf:/wm:/ipfs:) with its linked-account status, whether
// it may be used as an upload target for this project (ToS-aware
// routing), and the mirror-failover state from the last site load.
//
// This module is created, NOT wired in: panels.ts / app.ts belong to
// the integration pass. See WIRING at the bottom for the exact calls.
//
// Licence: MIT. No new dependencies.

import {
  BACKEND_INFO,
  BACKEND_PREFIXES,
  type BackendPrefix,
  type MirrorAttempt,
  type ProjectFlags,
} from "./backends.js";
import { backendPickerView, mirrorStatusView } from "./backends-ui.js";

export const BACKENDS_PANEL_ID = "backends";
export const BACKENDS_PANEL_TITLE = "Backends";
export const BACKENDS_PANEL_DESCRIPTION =
  "Every storage backend ArkNetz can read and write — linked accounts, mirror failover, and ToS-aware upload routing.";

export interface BackendsPanelDeps {
  /** What the current project is (open dataset / educational / CC) —
   *  decides whether hf: and wm: may be offered as upload targets. */
  projectFlags: ProjectFlags;
  /**
   * Linked account label per backend prefix, e.g.
   * { gh: "alice (GitHub)", ia: "alice@archive.org" }.
   * A missing prefix means no account is linked for that backend.
   * The integration pass builds this from the keyring profiles.
   */
  linked: Partial<Record<BackendPrefix, string>>;
  /**
   * Mirror attempts from the last site load, if any. Drives the
   * failover status line; omit (or pass []) when nothing has loaded
   * through mirrors yet.
   */
  lastMirrorAttempts?: MirrorAttempt[];
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

/** Render the Backends panel to HTML from the panel deps. */
export function renderBackendsPanelHtml(deps: BackendsPanelDeps): string {
  const picker = backendPickerView(deps.projectFlags);
  const h = `<h2>${esc(BACKENDS_PANEL_TITLE)}</h2>`;

  const rows = picker.targets.map((t) => {
    const linkedLabel = deps.linked[t.prefix];
    const linkedLine = linkedLabel
      ? `Linked: ${esc(linkedLabel)}`
      : "Not linked — sign in in Accounts to link it.";
    const uploadLine = t.offered
      ? "Available as an upload target."
      : `Not offered as an upload target — ${esc(t.reason ?? "its terms do not allow this project.")}`;
    return (
      `<li><strong>${esc(t.prefix)}: — ${esc(t.label)}</strong> — ${esc(t.role)}<br>` +
      `${linkedLine}<br>${uploadLine}</li>`
    );
  });
  const backends = section(
    "Storage backends",
    `<ul>${rows.join("")}</ul>` +
      `<p class="an-note">${esc(picker.note)}</p>`,
  );

  const attempts = deps.lastMirrorAttempts ?? [];
  const failover = section(
    "Mirror failover",
    attempts.length
      ? (() => {
          const vm = mirrorStatusView(attempts);
          return (
            `<p>${esc(vm.summary)}</p>` +
            (vm.failed.length
              ? `<ul>${vm.failed.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
              : "")
          );
        })()
      : `<p>No site has loaded through mirrors yet — failover status appears here after a load. When a primary repo is deleted or unreachable, ArkNetz tries each mirror in order, then the latest Wayback Machine snapshot.</p>`,
  );

  const routing = section(
    "ToS-aware routing",
    `<p>Hugging Face (hf:) and Wikimedia Commons (wm:) only appear as upload targets for open, educational, or Creative Commons work — their terms do not allow arbitrary personal uploads. Reads are never gated: any backend may be read. ArkDrive never uses a shared or master key; every upload goes through the account you linked yourself.</p>`,
  );

  return h + backends + failover + routing;
}

/**
 * Mount the Backends panel into `root`. The panel is read-only today
 * (linking happens in Accounts; uploads happen in ArkDrive), so mount
 * renders the HTML; it exists so the integration pass has the same
 * mount-function contract as the other panels.
 */
export function mountBackendsPanel(root: HTMLElement, deps: BackendsPanelDeps): void {
  root.innerHTML = renderBackendsPanelHtml(deps);
}

// ---------------------------------------------------------------------------
// WIRING (integration pass — app.ts / panels.ts are owned elsewhere):
//
// 1. app.ts — add to APP_PANELS (after "wayback", before "settings"
//    keeps the network group together):
//      { id: "backends", title: "Backends",
//        description: "Every storage backend ArkNetz can read and write — linked accounts, mirror failover, and ToS-aware upload routing.",
//        module: "network/backends", needsSignIn: false },
//
// 2. panels.ts — in renderPanelHtml(), add:
//      case "backends": {
//        return renderBackendsPanelHtml({
//          projectFlags: opts.getProjectFlags ? opts.getProjectFlags() : {},
//          linked: opts.getLinkedBackends ? opts.getLinkedBackends() : {},
//          lastMirrorAttempts: opts.getLastMirrorAttempts ? opts.getLastMirrorAttempts() : [],
//        });
//      }
//    (import renderBackendsPanelHtml from "./network/backends-panel.js").
//    And in wirePanel(), add:
//      if (panelId === "backends") {
//        mountBackendsPanel(root, {
//          projectFlags: opts.getProjectFlags ? opts.getProjectFlags() : {},
//          linked: opts.getLinkedBackends ? opts.getLinkedBackends() : {},
//          lastMirrorAttempts: opts.getLastMirrorAttempts ? opts.getLastMirrorAttempts() : [],
//        });
//      }
//    (import mountBackendsPanel from "./network/backends-panel.js").
//    PanelHostOptions will need three optional accessors:
//    getProjectFlags?: () => ProjectFlags;
//    getLinkedBackends?: () => Partial<Record<BackendPrefix, string>>;
//    getLastMirrorAttempts?: () => MirrorAttempt[];
//    NOTE: renderPanelHtml() and wirePanel() must use the SAME accessors,
//    or the panel will render one state and mount another.
//
//    Building `linked` from the keyring (provider -> backend prefix):
//    github -> gh, gitlab -> gl, codeberg -> cb,
//    internet_archive -> ia, huggingface -> hf, wikimedia -> wm.
//    ipfs has no account provider and is never "linked" — it is a
//    public gateway, so it always shows "Not linked".
//    A suggested builder (lives in the integration pass, not here):
//      const PREFIX_BY_PROVIDER = { github: "gh", gitlab: "gl",
//        codeberg: "cb", internet_archive: "ia", huggingface: "hf",
//        wikimedia: "wm" } as const;
//      for (const p of keyring.snapshot().profiles)
//        linked[PREFIX_BY_PROVIDER[p.provider]] = p.label;
// ---------------------------------------------------------------------------
