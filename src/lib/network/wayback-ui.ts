// ArkNetzWebWeaver — Time Machine (Wayback) lookup UI.
// Fix agent C, bug B6: the old inline lookup in panels.ts showed no
// loading state (the button stayed live and silent for ~1.5 s) and ended
// in a bare "Failed to fetch" with no explanation and no retry.
//
// This module owns the whole lookup interaction:
// - a loading state (button disabled + "Looking up…" while fetching),
// - plain-language errors that say what happened and what to do next,
//   with a Retry button,
// - correct CDX parsing via listSnapshots() (the old inline code read
//   CDX rows as objects; the CDX API returns arrays, so it silently
//   found zero snapshots even on success).
//
// Pure renderers + the async lookup live here so tests can exercise
// them without a DOM; wireWaybackPanel() is the DOM binding the
// integration pass calls from panels.ts (see WIRING at the bottom).
//
// Licence: MIT. No new dependencies.

import { listSnapshots, savePageNowUrl, type WaybackSnapshot } from "./wayback.js";
import { timeMachineView, type TimeMachineView } from "./backends-ui.js";
import type { NetworkFetch } from "./backends.js";

export const WAYBACK_LOOKUP_BUTTON_ID = "an-wayback-btn";
export const WAYBACK_SAVE_BUTTON_ID = "an-wayback-save-btn";
export const WAYBACK_URL_INPUT_ID = "an-wayback-url";
export const WAYBACK_RESULTS_ID = "an-wayback-results";
export const WAYBACK_RETRY_BUTTON_ID = "an-wayback-retry-btn";

/** Canonical plain-language message for an unreachable archive.org.
 *  Hunt 5: the second sentence matters — before P1, web.archive.org's
 *  CDX API sent no Access-Control-Allow-Origin header, so the app's
 *  in-WebView fetch was blocked even when the device was online, and
 *  saying only "check your connection" sent the user chasing their
 *  wifi for an app-side block. P1 moved the lookup to the Rust
 *  `wayback_fetch` command (no CORS), so a failure now genuinely
 *  means the network or archive.org itself, and the message says so. */
export const WAYBACK_UNREACHABLE_MESSAGE =
  "Could not reach archive.org — check your connection and try again. If you are online, archive.org itself may be down or blocking the request.";

export type WaybackLookupState =
  | { status: "idle" }
  | { status: "loading"; url: string }
  | { status: "results"; url: string; view: TimeMachineView }
  | { status: "empty"; url: string; note: string }
  | { status: "error"; url: string; message: string; retryable: boolean };

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turn a thrown lookup failure into a plain-language message that says
 * what happened and what to do next. Never returns a bare error code
 * or a bare "Failed to fetch".
 *
 * - Network failures (fetch throwing, timeouts, DNS) -> the canonical
 *   "could not reach archive.org" message with a retry hint.
 * - HTTP statuses -> what the status means in plain English.
 * - Anything else (e.g. the archivable-URL validation errors from
 *   wayback.ts, which are already plain English and say what to do)
 *   passes through unchanged.
 */
export function waybackLookupErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) {
    const status = Number(http[1]);
    if (status === 429) {
      return "archive.org is rate-limiting requests right now — wait a few minutes and try again.";
    }
    if (status === 404) {
      return "archive.org answered 404 for that address — check the URL and try again.";
    }
    if (status >= 500) {
      return `archive.org had a problem (HTTP ${status}) — it is probably temporary, so wait a bit and try again.`;
    }
    return `archive.org answered with HTTP ${status} — check the URL and try again.`;
  }
  if (
    /failed to fetch|networkerror|network request failed|ECONN|ENOTFOUND|ETIMEDOUT|timed out|fetch failed/i.test(
      msg,
    )
  ) {
    return WAYBACK_UNREACHABLE_MESSAGE;
  }
  return msg;
}

/**
 * Run one CDX lookup. Returns a state object — never throws — so the
 * UI always has something honest to show: results, an empty note, or
 * a plain-language error with retry.
 */
export async function runWaybackLookup(
  url: string,
  fetchFn: NetworkFetch,
): Promise<WaybackLookupState> {
  let snapshots: WaybackSnapshot[];
  try {
    snapshots = await listSnapshots(url, fetchFn);
  } catch (err) {
    return {
      status: "error",
      url,
      message: waybackLookupErrorMessage(err),
      retryable: true,
    };
  }
  const view = timeMachineView(url, snapshots);
  if (view.entries.length === 0) {
    return { status: "empty", url, note: view.emptyNote };
  }
  return { status: "results", url, view };
}

/** Render the results area for one lookup state. */
export function waybackLookupHtml(state: WaybackLookupState): string {
  switch (state.status) {
    case "idle":
      return "";
    case "loading":
      return `<p role="status">Looking up snapshots on archive.org… this usually takes a few seconds.</p>`;
    case "results":
      return `<ul>${state.view.entries
        .map(
          (s) =>
            `<li><a href="${esc(s.waybackUrl)}" target="_blank" rel="noopener">${esc(s.displayDate)}</a> (${esc(s.timestamp)}, ${esc(s.mimetype)})</li>`,
        )
        .join("")}</ul>`;
    case "empty":
      return `<p>${esc(state.note)}</p>`;
    case "error":
      return (
        `<p role="alert">${esc(state.message)}</p>` +
        (state.retryable
          ? `<button id="${WAYBACK_RETRY_BUTTON_ID}" type="button">Retry lookup</button>`
          : "")
      );
  }
}

/**
 * DOM binding for the Time Machine panel. Binds the lookup + Save Page
 * Now buttons inside `root` (the rendered panel host) and renders
 * loading / results / empty / error states into #an-wayback-results.
 * While a lookup is in flight the lookup button is disabled and reads
 * "Looking up…", so the panel never looks frozen and a double-click
 * cannot fire a second request. The Retry button re-runs the last URL.
 *
 * `openSavePageNow` defaults to window.open; tests inject a stub.
 */
export function wireWaybackPanel(
  root: HTMLElement,
  fetchFn: NetworkFetch,
  opts?: { openSavePageNow?: (url: string) => void },
): void {
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`);
  const lookupBtn = $(WAYBACK_LOOKUP_BUTTON_ID) as HTMLButtonElement | null;
  const saveBtn = $(WAYBACK_SAVE_BUTTON_ID);
  const urlInput = $(WAYBACK_URL_INPUT_ID) as HTMLInputElement | null;
  const out = $(WAYBACK_RESULTS_ID);
  if (!lookupBtn || !urlInput || !out) return;

  let lastUrl = "";
  let inFlight = false;

  const setLoading = (loading: boolean): void => {
    lookupBtn.disabled = loading;
    lookupBtn.textContent = loading ? "Looking up…" : "Look up snapshots";
  };

  const run = async (url: string): Promise<void> => {
    if (inFlight) return;
    lastUrl = url;
    inFlight = true;
    setLoading(true);
    out.innerHTML = waybackLookupHtml({ status: "loading", url });
    const state = await runWaybackLookup(url, fetchFn);
    inFlight = false;
    setLoading(false);
    out.innerHTML = waybackLookupHtml(state);
    // The Retry button is rendered by the error state; bind it now.
    $(WAYBACK_RETRY_BUTTON_ID)?.addEventListener("click", () => {
      void run(lastUrl);
    });
  };

  lookupBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (!url) {
      out.innerHTML =
        `<p role="alert">Enter a public https:// URL first — for example the raw.githubusercontent.com address of a site file.</p>`;
      return;
    }
    void run(url);
  });

  saveBtn?.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (!url) {
      out.innerHTML =
        `<p role="alert">Enter a public https:// URL first — Save Page Now can only snapshot a public address.</p>`;
      return;
    }
    let saveUrl: string;
    try {
      // Validates: public https:// only — throws a plain-language error
      // for arknetz:// or non-https addresses.
      saveUrl = savePageNowUrl(url);
    } catch (err) {
      out.innerHTML = `<p role="alert">${esc(waybackLookupErrorMessage(err))}</p>`;
      return;
    }
    const open = opts?.openSavePageNow ?? ((u: string) => {
      window.open(u, "_blank", "noopener");
    });
    open(saveUrl);
    out.innerHTML =
      `<p>Opened Save Page Now in a new tab — the snapshot is created by the Wayback Machine, not by this app.</p>`;
  });
}

// ---------------------------------------------------------------------------
// WIRING (integration pass — panels.ts is owned by another fix agent):
//
// In panels.ts, replace the whole `if (panelId === "wayback") { ... }`
// block inside wirePanel() with:
//
//   if (panelId === "wayback") {
//     wireWaybackPanel(root, fetchFn);
//   }
//
// and delete the now-unused wayback imports there (buildCdxUrl,
// savePageNowUrl, waybackIdUrlFor, waybackUrlFor, timeMachineView,
// WaybackSnapshot) once nothing else in panels.ts uses them — this
// module imports the ones it needs itself. The rendered panel HTML
// (input + the two buttons + #an-wayback-results) stays exactly as it
// is — this module binds to those same ids.
// ---------------------------------------------------------------------------
