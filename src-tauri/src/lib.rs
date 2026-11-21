// ArkNetzWebWeaver — Tauri shell (Rust). "No Rust to write" in the
// thread means the app logic is TypeScript; this file is only the thin
// native shell: window + the one command that must never run in the
// webview — the GitHub OAuth code exchange, because it needs the client
// secret. The secret is NEVER in the app bundle. It is read at runtime
// from the environment variable ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET on
// the builder's own machine (or from the Tauri app's secure storage in
// a later phase). If it is absent, the command returns
// "not_configured" and sign-in stops there — no token is ever invented.
// The client id comes from the webview (config.ts) at call time.
//
// This file exists as a library (not just src/main.rs) because the
// Android target requires a cdylib: `cargo tauri android build` runs
// `cargo build --lib --target aarch64-linux-android`, and the mobile
// entry point below is what the Android activity calls. The desktop
// binary (src/main.rs) is a one-line wrapper around `run()`.

use serde::Serialize;
use std::collections::HashMap;

/// True when a top-level WebView navigation to `url` must be refused.
///
/// arknetz:// is the app's own scheme: it names a site in the
/// registry, not a page the WebView can load. A top-level navigation
/// to one (T1, 2026-11-20) makes WebKitGTK replace the entire app UI
/// — header, tabs, toolbar, sidebar — with a blank "The URL can't be
/// shown" page, unrecoverable except by relaunch. The TypeScript
/// shell intercepts arknetz:// clicks first (renderer.ts
/// installArknetzLinkInterceptor) and routes them through the
/// registry resolver; this is the second line of defence for any link
/// that escapes the JS handler (e.g. a link inside a sandboxed app
/// iframe or a programmatic navigation). Everything else — the app's
/// own tauri://localhost URL, localhost in dev, https: links — is
/// allowed through untouched.
pub fn should_block_top_level_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "arknetz"
}

/// Inline navigation-guard plugin: Tauri 2's app `Builder` has no
/// `on_navigation` of its own (that hook lives on
/// `WebviewWindowBuilder`, which the config-created main window never
/// goes through), but every navigation consults each registered
/// plugin's `on_navigation` hook — so a zero-dependency inline plugin
/// is how the main window gets the guard. Returning false cancels the
/// navigation; the app stays exactly where it was.
fn arknetz_nav_guard_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("arknetz-nav-guard")
        .on_navigation(|_webview, url| !should_block_top_level_navigation(url))
        .build()
}

#[derive(Serialize)]
struct ExchangeResult {
    #[serde(rename = "accessToken", skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tauri::command]
async fn github_oauth_exchange(code: String, client_id: String) -> ExchangeResult {
    let secret = match std::env::var("ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            return ExchangeResult {
                access_token: None,
                error: Some(
                    "not_configured: ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET is not set. \
                     Create a GitHub OAuth App and supply its client secret to the \
                     Tauri shell at runtime — never put it in the app bundle."
                        .to_string(),
                ),
            };
        }
    };
    let mut form = HashMap::new();
    form.insert("client_id", client_id);
    form.insert("client_secret", secret);
    form.insert("code", code);
    let client = reqwest::Client::builder()
        .user_agent("ArkNetzWebWeaver/1.0")
        .build();
    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return ExchangeResult { access_token: None, error: Some(e.to_string()) };
        }
    };
    let res = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => {
            return ExchangeResult { access_token: None, error: Some(e.to_string()) };
        }
    };
    let body: serde_json::Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            return ExchangeResult { access_token: None, error: Some(e.to_string()) };
        }
    };
    if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
        return ExchangeResult {
            access_token: None,
            error: Some(format!("GitHub: {}", err)),
        };
    }
    match body.get("access_token").and_then(|v| v.as_str()) {
        Some(token) => ExchangeResult {
            access_token: Some(token.to_string()),
            error: None,
        },
        None => ExchangeResult {
            access_token: None,
            error: Some("GitHub returned no access_token".to_string()),
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        // Hunt 4 (BUG 1): without the opener plugin, window.open kept
        // GitHub inside the app's WebView and the OAuth redirect could
        // never come back. The opener sends URLs to the system browser
        // (Chrome on Android, default browser on desktop) — the only
        // place a redirect to arknetz:// can be delivered by the OS.
        .plugin(tauri_plugin_opener::init())
        .plugin(arknetz_nav_guard_plugin())
        .setup(|_app| {
            // Debug builds only: register the arknetz:// scheme for the
            // current (dev) executable so `xdg-open arknetz://…` can be
            // tested without installing the app (Tauri docs' testing
            // path — app.deep_link().register_all()). Release builds
            // rely on the installer registration from
            // tauri.conf.json > plugins.deep-link.desktop.schemes, so a
            // dev binary never hijacks the scheme on a user's machine.
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = _app.deep_link().register_all();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![github_oauth_exchange])
        .run(tauri::generate_context!())
        .expect("error while running ArkNetzWebWeaver");
}

#[cfg(test)]
mod tests {
    use super::should_block_top_level_navigation;

    fn blocked(url: &str) -> bool {
        should_block_top_level_navigation(&tauri::Url::parse(url).expect("test URL parses"))
    }

    // T1 regression: the exact navigation that used to destroy the app.
    #[test]
    fn arknetz_deep_links_are_blocked_top_level() {
        assert!(blocked("arknetz://welcome.arknetz/about"));
        assert!(blocked("arknetz://welcome.arknetz"));
        assert!(blocked("arknetz://computers.edu/some/page"));
    }

    #[test]
    fn app_and_web_urls_are_not_blocked() {
        assert!(!blocked("tauri://localhost/"));
        assert!(!blocked("http://localhost:1420/"));
        assert!(!blocked("https://github.com/login/oauth/authorize"));
        assert!(!blocked(
            "https://raw.githubusercontent.com/a/b/main/site.json"
        ));
    }
}
