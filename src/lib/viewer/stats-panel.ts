// ArkNetzWebWeaver — Stats panel (fix agent C).
// Stats existed only as a service (src/lib/viewer/stats.ts) plus a view
// model (viewer2-ui.ts) with no UI surface. This module is the dedicated
// Stats panel: view counts, comment/reaction counts, IA play counts,
// the VIEW_PING rollup note, and the Strict Offline / No-Telemetry Mode
// toggle — with honest empty states throughout.
//
// This module is created, NOT wired in: panels.ts / app.ts belong to
// the integration pass. See WIRING at the bottom for the exact calls.
//
// Licence: MIT. No new dependencies.

import {
  type SiteStats,
  type TelemetrySettings,
} from "./stats.js";
import { statsViewModel } from "./viewer2-ui.js";

export const STATS_PANEL_ID = "stats";
export const STATS_PANEL_TITLE = "Stats";
export const STATS_PANEL_DESCRIPTION =
  "Privacy-preserving site stats — views, comments, reactions, media plays.";

export interface StatsPanelDeps {
  /** The site's rolled-up stats (stats.json.zst, decompressed). */
  stats: SiteStats;
  /** Telemetry settings (Strict Offline + Public View Counter). */
  settings: TelemetrySettings;
  /**
   * Called with the new settings when the user flips a toggle. The
   * integration pass owns persistence (there is no telemetry-settings
   * store in the app yet); until it exists, a caller may keep the
   * settings in memory and re-render with the updated copy.
   */
  onSettingsChange?: (next: TelemetrySettings) => void;
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

/** Render the Stats panel to HTML from live stats + settings. */
export function renderStatsPanelHtml(deps: StatsPanelDeps): string {
  const vm = statsViewModel(deps.stats, deps.settings);
  const h = `<h2>${esc(STATS_PANEL_TITLE)}</h2>`;

  const summary = section(
    "Overview",
    `<p>${esc(vm.summary)}</p>` +
      (vm.notice ? `<p class="an-note">${esc(vm.notice)}</p>` : "") +
      `<p class="an-note">${esc(vm.copy.rollupNote)}</p>`,
  );

  const perPage = section(
    "Views per page",
    vm.perPage.length
      ? `<ul>${vm.perPage
          .map((p) => `<li>${esc(p.page)} — ${p.views} view${p.views === 1 ? "" : "s"}</li>`)
          .join("")}</ul>`
      : `<p>No views recorded yet. Turn on the Public View Counter below and the first nightly count will appear here — one anonymous count per day, no visitor data.</p>`,
  );

  const countRow = (label: string, value: number | null, empty: string): string =>
    `<li>${esc(label)} — ${value === null ? esc(empty) : `${value}`}</li>`;
  const engagement = section(
    "Comments, reactions & plays",
    `<ul>` +
      countRow("Comments", vm.comments, "No comments yet") +
      countRow("Reactions", vm.reactions, "No reactions yet") +
      countRow("Media plays", vm.plays, "No plays recorded yet") +
      `</ul>` +
      `<p class="an-note">Comment and reaction counts come from the site's public GitHub Discussions/Issues; play counts come from the Internet Archive's public download count. Both are counts about the site, never about any visitor.</p>`,
  );

  const toggles = section(
    "Telemetry",
    `<p><button id="an-stats-toggle-view-counter" type="button" aria-pressed="${vm.publicViewCounter}">${vm.publicViewCounter ? "Turn off the Public View Counter" : "Turn on the Public View Counter"}</button></p>` +
      `<p class="an-note">${esc(vm.copy.optInHint)}</p>` +
      `<p><button id="an-stats-toggle-strict-offline" type="button" aria-pressed="${vm.strictOffline}">${vm.strictOffline ? "Turn off Strict Offline / No-Telemetry Mode" : "Turn on Strict Offline / No-Telemetry Mode"}</button></p>` +
      `<p class="an-note">${esc(vm.copy.strictOfflineHint)}</p>`,
  );

  return h + summary + perPage + engagement + toggles;
}

/**
 * Mount the Stats panel into `root`: render, then bind the two toggle
 * buttons. A toggle flips its setting, notifies onSettingsChange, and
 * re-renders in place so the button labels and notices stay truthful.
 */
export function mountStatsPanel(root: HTMLElement, deps: StatsPanelDeps): void {
  let settings: TelemetrySettings = { ...deps.settings };
  const render = (): void => {
    root.innerHTML = renderStatsPanelHtml({ ...deps, settings });
    const viewCounterBtn = root.querySelector<HTMLElement>(
      "#an-stats-toggle-view-counter",
    ) as HTMLButtonElement | null;
    const strictBtn = root.querySelector<HTMLElement>(
      "#an-stats-toggle-strict-offline",
    ) as HTMLButtonElement | null;
    viewCounterBtn?.addEventListener("click", () => {
      settings = { ...settings, publicViewCounter: !settings.publicViewCounter };
      deps.onSettingsChange?.(settings);
      render();
    });
    strictBtn?.addEventListener("click", () => {
      settings = { ...settings, strictOffline: !settings.strictOffline };
      deps.onSettingsChange?.(settings);
      render();
    });
  };
  render();
}

// ---------------------------------------------------------------------------
// WIRING (integration pass — app.ts / panels.ts are owned elsewhere):
//
// 1. app.ts — add to APP_PANELS (after "offline", before "domains" keeps
//    the viewer group together):
//      { id: "stats", title: "Stats",
//        description: "Privacy-preserving site stats — views, comments, reactions, media plays.",
//        module: "viewer/stats", needsSignIn: false },
//    Stats data: the app already owns the ping store
//    (app.pingStore). The rolled-up SiteStats comes from the site's
//    stats.json.zst once a site is loaded; until a site with stats is
//    loaded, pass emptyStats(domain) so the panel shows its honest
//    empty states. TelemetrySettings has no store in the app yet —
//    the integration pass should add one (memory store first, IndexedDB
//    later) and pass it through onSettingsChange.
//
// 2. panels.ts — in renderPanelHtml(), add:
//      case "stats": {
//        const stats = opts.getSiteStats ? opts.getSiteStats() : emptyStats("");
//        const settings = opts.getTelemetrySettings ? opts.getTelemetrySettings() : defaultTelemetrySettings();
//        return renderStatsPanelHtml({ stats, settings });
//      }
//    (import renderStatsPanelHtml from "./viewer/stats-panel.js" and
//    emptyStats / defaultTelemetrySettings from "./viewer/stats.js").
//    And in wirePanel(), add:
//      if (panelId === "stats") {
//        mountStatsPanel(root, {
//          stats: opts.getSiteStats ? opts.getSiteStats() : emptyStats(""),
//          settings: opts.getTelemetrySettings ? opts.getTelemetrySettings() : defaultTelemetrySettings(),
//          onSettingsChange: opts.setTelemetrySettings,
//        });
//      }
//    (import mountStatsPanel from "./viewer/stats-panel.js").
//    PanelHostOptions will need the three optional accessors:
//    getSiteStats?: () => SiteStats; getTelemetrySettings?: () => TelemetrySettings;
//    setTelemetrySettings?: (next: TelemetrySettings) => void.
//    NOTE: renderPanelHtml() and wirePanel() must use the SAME stats /
//    settings source, or the toggles will re-render stale values.
// ---------------------------------------------------------------------------
