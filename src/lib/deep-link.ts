// ArkNetzWebWeaver — arknetz:// deep-link handling (fix round 3, item 1).
// OS registration lives in the Tauri shell, not here:
//   - src-tauri/Cargo.toml: tauri-plugin-deep-link = "2"
//   - src-tauri/src/main.rs: .plugin(tauri_plugin_deep_link::init()),
//     plus register_all() in debug builds so an uninstalled dev binary
//     can be tested with `xdg-open arknetz://…` (release builds rely on
//     the installer registration from tauri.conf.json).
//   - src-tauri/tauri.conf.json > plugins.deep-link: desktop schemes
//     ["arknetz"], mobile [{ scheme: ["arknetz"], appLink: false }]
//     (custom scheme, no host verification needed — no assetlinks /
//     apple-app-site-association file, no server).
//   - src-tauri/capabilities/default.json: "deep-link:default" +
//     "core:event:default" permissions.
//   - src-tauri/tauri.conf.json > app.withGlobalTauri: true, so the
//     plugin's guest bindings are reachable as window.__TAURI__.deepLink
//     (this project has no bundler, so the npm guest bindings cannot be
//     imported — the documented withGlobalTauri path is used instead).
//
// This module is the pure, testable half: parse an arknetz:// URL the
// OS hands the app, and open it through the shell's existing tab
// navigation (the same parseAddress() path as a typed address). It
// feature-detects window.__TAURI__.deepLink and no-ops cleanly when it
// is absent (plain browser, tests) — the app still works, it just
// cannot receive OS deep links there.
//
// HONEST LIMITS (see INTEGRATION.md "Fix round 3"):
//   - No single-instance plugin is registered, so on Linux/Windows a
//     deep link clicked while the app is already running spawns a
//     SECOND app process (the OS hands the URL to a new process as a
//     CLI argument); that second window opens the linked site via
//     getCurrent(). Focusing the already-running window needs
//     tauri-plugin-single-instance with its deep-link feature — not
//     wired yet.
//   - Android registration is config-only here: no .apk was built and
//     no emulator test ran in this round, so the Android intent-filter
//     is declared but unproven on a device.
//   - Nothing here was launch-tested: no installed .deb exists yet in
//     this round, so the exact manual check is documented in
//     INTEGRATION.md instead of claimed as verified.

import { isValidDomain } from "./types.js";

/** The OS-registered custom scheme. */
export const DEEP_LINK_SCHEME = "arknetz";

/** A parsed deep link: the domain to resolve plus the path inside it
 *  ("" for the site root, "/about" for arknetz://domain/about). */
export interface ParsedDeepLink {
  domain: string;
  /** Path within the site, "" or starting with "/". */
  path: string;
}

/** Parse an arknetz:// URL. Returns null (never throws) for anything
 *  that is not a well-formed arknetz:// link to a valid domain: other
 *  schemes, missing/uppercase/invalid domains, URLs with credentials.
 *  Query strings and fragments are dropped — the shell resolves by
 *  domain + path only, same as a typed address. */
export function parseDeepLinkUrl(url: string): ParsedDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const domain = parsed.hostname.toLowerCase();
  // URL parsing already lowercases the hostname; domains are
  // case-insensitive, so "ARKNETZ://EXAMPLE.EDU" resolves the same
  // site as the lowercase form.
  if (!isValidDomain(domain)) return null;
  let path = parsed.pathname;
  if (path === "/") path = "";
  return { domain, path };
}

/** The shell address for a parsed deep link — the same string a user
 *  would type in the address bar, so tab navigation handles it. */
export function deepLinkToAddress(link: ParsedDeepLink): string {
  return `${DEEP_LINK_SCHEME}://${link.domain}${link.path}`;
}

/** Open every parseable URL in `urls` through `openTab` (in order),
 *  skipping unparseable ones silently — a stray CLI argument must
 *  never break startup. Returns how many links were opened. */
export async function handleDeepLinkUrls(
  urls: readonly string[],
  openTab: (address: string) => Promise<void> | void,
): Promise<number> {
  let opened = 0;
  for (const url of urls) {
    const parsed = parseDeepLinkUrl(url);
    if (!parsed) continue;
    await openTab(deepLinkToAddress(parsed));
    opened++;
  }
  return opened;
}

/** Minimal shape of the Tauri global the deep-link plugin exposes
 *  when withGlobalTauri is on (per the Tauri deep-linking docs:
 *  window.__TAURI__.deepLink.{getCurrent,onOpenUrl}). Declared here
 *  instead of importing @tauri-apps/plugin-deep-link because this
 *  project has no bundler. */
export interface TauriDeepLinkApi {
  getCurrent: () => Promise<string[] | null | undefined>;
  onOpenUrl: (callback: (urls: string[]) => void) => Promise<unknown>;
}

export interface TauriGlobalScope {
  __TAURI__?: {
    deepLink?: TauriDeepLinkApi;
  };
}

export type DeepLinkListenerStatus =
  | { status: "installed"; startupOpened: number }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

/** Install the OS deep-link listener on the given scope (normally
 *  `window`). Reads the startup URLs via getCurrent() (the desktop
 *  path: the OS spawned this process with the URL as a CLI argument)
 *  and subscribes to onOpenUrl() for links arriving while the app
 *  runs (mobile / macOS path). Never throws: any failure is reported
 *  in the returned status and the app carries on without deep links. */
export async function installDeepLinkListener(
  scope: TauriGlobalScope,
  openTab: (address: string) => Promise<void> | void,
): Promise<DeepLinkListenerStatus> {
  const api = scope.__TAURI__?.deepLink;
  if (!api || typeof api.getCurrent !== "function" || typeof api.onOpenUrl !== "function") {
    return {
      status: "unavailable",
      reason: "window.__TAURI__.deepLink is not present — the app is not running inside the Tauri shell (plain browser, or withGlobalTauri off), so OS deep links cannot be received",
    };
  }
  try {
    const startup = await api.getCurrent();
    const startupOpened = startup ? await handleDeepLinkUrls(startup, openTab) : 0;
    await api.onOpenUrl((urls) => {
      void handleDeepLinkUrls(urls, openTab);
    });
    return { status: "installed", startupOpened };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
