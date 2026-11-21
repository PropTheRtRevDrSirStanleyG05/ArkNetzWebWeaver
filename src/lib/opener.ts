// ArkNetzWebWeaver — opening URLs outside the app (hunt 4, BUG 1).
// The bug: every "open externally" path used window.open(url, "_blank"),
// but no opener plugin was registered, so the URL never left the app.
// On Android the generated WebView has no onCreateWindow handler, so
// window.open is a silent no-op; on desktop it opens a second in-app
// window, where the Rust nav guard then blocks the arknetz:// OAuth
// callback. Either way GitHub never runs in a real browser and the
// redirect can never come back. The fix is tauri-plugin-opener (v2):
//   - src-tauri/Cargo.toml: tauri-plugin-opener = "2"
//   - src-tauri/src/lib.rs: .plugin(tauri_plugin_opener::init())
//   - src-tauri/capabilities/default.json: "opener:default"
// With withGlobalTauri on, the plugin's guest bindings are reachable
// as window.__TAURI__.opener.openUrl. openExternalUrl() below prefers
// that and falls back to window.open only when the plugin is absent
// (plain browser, tests) — the fallback is honest about what it is,
// and callers must never assume it left the app.

export interface TauriOpenerApi {
  openUrl: (url: string, withHandler?: string) => Promise<void>;
  openPath?: (path: string, withHandler?: string) => Promise<void>;
}

export interface TauriOpenerScope {
  __TAURI__?: {
    opener?: TauriOpenerApi;
  };
}

/** Open a URL in the system browser (or the OS default handler).
 *  Returns true when the opener plugin took it, false when it fell
 *  back to window.open (no plugin present) — the caller can say so.
 *  Never throws: a failed open is reported as false and the caller
 *  shows the URL for the user to open by hand. */
export async function openExternalUrl(
  url: string,
  scope: TauriOpenerScope = globalThis as unknown as TauriOpenerScope,
): Promise<boolean> {
  const opener = scope.__TAURI__?.opener;
  if (opener && typeof opener.openUrl === "function") {
    try {
      await opener.openUrl(url);
      return true;
    } catch {
      return false;
    }
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener");
    return false;
  }
  return false;
}
