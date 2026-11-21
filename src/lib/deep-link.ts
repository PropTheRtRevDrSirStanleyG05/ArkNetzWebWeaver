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

import { GITHUB_OAUTH_REDIRECT_URI } from "./config.js";
import { isValidDomain } from "./types.js";

/** The OS-registered custom scheme. */
export const DEEP_LINK_SCHEME = "arknetz";

/** The GitHub OAuth callback URL (config.ts), re-exported here so the
 *  router and the shell test against the same value. */
export const OAUTH_CALLBACK_URL = GITHUB_OAUTH_REDIRECT_URI;

/** True for the OAuth callback URL (arknetz://oauth/callback, query
 *  string allowed). It is NOT a site address — "oauth" is not a valid
 *  domain (isValidDomain needs two labels), so parseDeepLinkUrl would
 *  reject it and the old handler silently dropped it. The callback
 *  must be intercepted before the site resolver, or the app would try
 *  to load a site called "oauth" and fail. */
export function isOAuthCallbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${DEEP_LINK_SCHEME}:` &&
    parsed.hostname.toLowerCase() === "oauth" &&
    parsed.pathname === "/callback"
  );
}

/** Optional handlers for deep links that are not site addresses. */
export interface DeepLinkHandlers {
  /** Called with the full callback URL when an OAuth callback arrives
   *  (startup or while running). The handler owns the whole completion
   *  (state check, code exchange, account) and reports its own errors
   *  — a failure here must never break the deep-link listener. */
  onOAuthCallback?: (url: string) => Promise<void> | void;
}

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
 *  never break startup. OAuth callback URLs are intercepted first and
 *  handed to `handlers.onOAuthCallback` instead of the site resolver.
 *  Returns how many URLs were handled (site links opened + callbacks
 *  intercepted). */
export async function handleDeepLinkUrls(
  urls: readonly string[],
  openTab: (address: string) => Promise<void> | void,
  handlers: DeepLinkHandlers = {},
): Promise<number> {
  let handled = 0;
  for (const url of urls) {
    if (isOAuthCallbackUrl(url)) {
      if (handlers.onOAuthCallback) {
        try {
          await handlers.onOAuthCallback(url);
        } catch {
          // The handler reports its own errors (sign-in status strip);
          // one bad callback must never break the listener or startup.
        }
      }
      handled++;
      continue;
    }
    const parsed = parseDeepLinkUrl(url);
    if (!parsed) continue;
    await openTab(deepLinkToAddress(parsed));
    handled++;
  }
  return handled;
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
  // startupOpened counts every startup URL handled: site links opened
  // plus OAuth callbacks intercepted (not just tabs opened).
  | { status: "installed"; startupOpened: number }
  | { status: "unavailable"; reason: string }
  | { status: "error"; reason: string };

/** Install the OS deep-link listener on the given scope (normally
 *  `window`). Reads the startup URLs via getCurrent() (the desktop
 *  path: the OS spawned this process with the URL as a CLI argument)
 *  and subscribes to onOpenUrl() for links arriving while the app
 *  runs (mobile / macOS path). `handlers.onOAuthCallback` receives
 *  OAuth callback URLs from both paths, before the site resolver.
 *  Never throws: any failure is reported in the returned status and
 *  the app carries on without deep links. */
export async function installDeepLinkListener(
  scope: TauriGlobalScope,
  openTab: (address: string) => Promise<void> | void,
  handlers: DeepLinkHandlers = {},
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
    const startupOpened = startup ? await handleDeepLinkUrls(startup, openTab, handlers) : 0;
    await api.onOpenUrl((urls) => {
      void handleDeepLinkUrls(urls, openTab, handlers);
    });
    return { status: "installed", startupOpened };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
