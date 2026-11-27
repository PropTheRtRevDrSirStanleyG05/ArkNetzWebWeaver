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

#[derive(Serialize)]
struct DeviceCodeResult {
    #[serde(rename = "device_code", skip_serializing_if = "Option::is_none")]
    device_code: Option<String>,
    #[serde(rename = "user_code", skip_serializing_if = "Option::is_none")]
    user_code: Option<String>,
    #[serde(rename = "verification_uri", skip_serializing_if = "Option::is_none")]
    verification_uri: Option<String>,
    #[serde(rename = "expires_in", skip_serializing_if = "Option::is_none")]
    expires_in: Option<u64>,
    #[serde(rename = "interval", skip_serializing_if = "Option::is_none")]
    interval: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct DeviceTokenResult {
    #[serde(rename = "access_token", skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// One reqwest client for all GitHub POSTs below (rustls, no CORS —
/// Rust has no origin to check).
fn github_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().user_agent("ArkNetzWebWeaver/1.0");
    // Test-only: this VM's egress is a MITM proxy whose CA lives in
    // SSL_CERT_FILE; rustls trusts only webpki roots by default, so a
    // live test here would fail the TLS handshake. Load that bundle
    // when present, in test builds only, so
    // `cargo test --offline -- --ignored` can run. Production builds
    // never take this branch — and a phone has no such file — so the
    // shipped app's trust roots are unchanged (public webpki roots).
    #[cfg(test)]
    {
        if let Ok(path) = std::env::var("SSL_CERT_FILE") {
            if let Ok(pem) = std::fs::read(&path) {
                if let Ok(certs) = reqwest::Certificate::from_pem_bundle(&pem) {
                    for cert in certs {
                        builder = builder.add_root_certificate(cert);
                    }
                }
            }
        }
    }
    builder.build().map_err(|e| e.to_string())
}

/// Shared GitHub POST helper for the device-flow commands below:
/// one reqwest client (rustls, no CORS — Rust has no origin to check),
/// form-encoded body, JSON response. Network/parse failures come back
/// as Err(String) so the caller can surface them, never panic.
async fn post_github_form(
    url: &str,
    form: &HashMap<&str, String>,
) -> Result<serde_json::Value, String> {
    let client = github_client()?;
    let res = client
        .post(url)
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Hunt 5 — device-code request, Rust side.
///
/// The webview MUST NOT call POST https://github.com/login/device/code
/// with window.fetch: GitHub's login endpoints send no
/// Access-Control-Allow-Origin header, so the WebView's CORS check
/// rejects the (HTTP 200) response and fetch throws a bare
/// "Failed to fetch" — which is exactly what Stanley saw on his Pixel
/// on v0.5.0. This command makes the same POST from Rust, where there
/// is no CORS, and hands the JSON straight back to the webview.
/// No secret is involved (device flow needs only the client id).
#[tauri::command]
async fn github_device_code(client_id: String, scope: String) -> DeviceCodeResult {
    let mut form = HashMap::new();
    form.insert("client_id", client_id);
    form.insert("scope", scope);
    let body = match post_github_form("https://github.com/login/device/code", &form).await {
        Ok(v) => v,
        Err(e) => {
            return DeviceCodeResult {
                device_code: None,
                user_code: None,
                verification_uri: None,
                expires_in: None,
                interval: None,
                error: Some(e),
            };
        }
    };
    if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
        return DeviceCodeResult {
            device_code: None,
            user_code: None,
            verification_uri: None,
            expires_in: None,
            interval: None,
            error: Some(err.to_string()),
        };
    }
    DeviceCodeResult {
        device_code: body
            .get("device_code")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        user_code: body
            .get("user_code")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        verification_uri: body
            .get("verification_uri")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        expires_in: body.get("expires_in").and_then(|v| v.as_u64()),
        interval: body.get("interval").and_then(|v| v.as_u64()),
        error: None,
    }
}

/// Hunt 5 — device-token poll, Rust side. Same CORS reason as
/// github_device_code: POST https://github.com/login/oauth/access_token
/// from the webview is rejected by the WebView's CORS check even
/// though GitHub answers 200. One poll attempt per invoke; the
/// TypeScript poll loop (auth.ts pollDeviceToken) still owns the
/// interval / slow_down / deadline logic and maps the error strings
/// (authorization_pending, slow_down, expired_token, access_denied)
/// exactly as before.
#[tauri::command]
async fn github_device_token(client_id: String, device_code: String) -> DeviceTokenResult {
    let mut form = HashMap::new();
    form.insert("client_id", client_id);
    form.insert("device_code", device_code);
    form.insert(
        "grant_type",
        "urn:ietf:params:oauth:grant-type:device_code".to_string(),
    );
    let body = match post_github_form("https://github.com/login/oauth/access_token", &form).await {
        Ok(v) => v,
        Err(e) => {
            return DeviceTokenResult {
                access_token: None,
                error: Some(e),
            };
        }
    };
    if let Some(err) = body.get("error").and_then(|v| v.as_str()) {
        return DeviceTokenResult {
            access_token: None,
            error: Some(err.to_string()),
        };
    }
    match body.get("access_token").and_then(|v| v.as_str()) {
        Some(token) => DeviceTokenResult {
            access_token: Some(token.to_string()),
            error: None,
        },
        None => DeviceTokenResult {
            access_token: None,
            error: Some("GitHub returned no access_token".to_string()),
        },
    }
}

/// Result of the Wayback fetch command: the HTTP status plus the body
/// text (or an error string when the request itself failed).
#[derive(serde::Serialize)]
struct WaybackFetchResult {
    status: u16,
    body: Option<String>,
    error: Option<String>,
}

/// Hunt 5 (P1) — Wayback CDX fetch, Rust side.
///
/// The Time Machine panel used to fetch https://web.archive.org/cdx
/// with window.fetch, but web.archive.org sends no
/// Access-Control-Allow-Origin header, so the WebView's CORS check
/// rejects the (HTTP 200) response and every lookup fails with a bare
/// "Failed to fetch" — the same CORS class as the hunt-5 sign-in bug.
/// This command makes the same GET from Rust, where there is no CORS.
/// The URL is restricted to https://web.archive.org: the command must
/// never become a generic fetch proxy for arbitrary hosts.
#[tauri::command]
async fn wayback_fetch(url: String) -> WaybackFetchResult {
    let parsed = match tauri::Url::parse(&url) {
        Ok(u) => u,
        Err(e) => {
            return WaybackFetchResult {
                status: 0,
                body: None,
                error: Some(format!("Wayback fetch: bad URL: {e}")),
            }
        }
    };
    if parsed.scheme() != "https" || parsed.host_str() != Some("web.archive.org") {
        return WaybackFetchResult {
            status: 0,
            body: None,
            error: Some(
                "Wayback fetch only allows https://web.archive.org URLs".to_string(),
            ),
        };
    }
    // github_client() is the shared rustls client (GitHub-named for
    // history); it carries no GitHub-specific behaviour.
    let client = match github_client() {
        Ok(c) => c,
        Err(e) => {
            return WaybackFetchResult {
                status: 0,
                body: None,
                error: Some(e),
            }
        }
    };
    let res = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            return WaybackFetchResult {
                status: 0,
                body: None,
                error: Some(e.to_string()),
            }
        }
    };
    let status = res.status().as_u16();
    match res.text().await {
        Ok(body) => WaybackFetchResult {
            status,
            body: Some(body),
            error: None,
        },
        Err(e) => WaybackFetchResult {
            status,
            body: None,
            error: Some(e.to_string()),
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
        .invoke_handler(tauri::generate_handler![
            github_oauth_exchange,
            github_device_code,
            github_device_token,
            wayback_fetch
        ])
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

    // Hunt 5 — LIVE test, #[ignore]d so the normal suite never touches
    // the network. Run on demand:
    //   cargo test --offline -- --ignored
    // It proves the two new Rust commands really talk to GitHub with
    // the same POST shape the webview used to send: the device-code
    // command returns a real code set, and the token command answers
    // a bogus device code with an error (not a token, never a panic).
    // The device code it mints is discarded — it simply expires.
    #[tokio::test]
    #[ignore]
    async fn github_device_commands_live_round_trip() {
        let code = super::github_device_code(
            "Ov23lic8terv0XOd3GDe".to_string(),
            "read:user public_repo".to_string(),
        )
        .await;
        assert!(code.error.is_none(), "device-code error: {:?}", code.error);
        let device_code = code.device_code.expect("device_code present");
        assert!(!device_code.is_empty());
        assert!(code.user_code.as_deref().unwrap_or("").len() >= 8);
        assert!(code
            .verification_uri
            .as_deref()
            .unwrap_or("")
            .starts_with("https://github.com/login/device"));
        assert!(code.expires_in.unwrap_or(0) > 0);
        assert!(code.interval.unwrap_or(0) > 0);
        let _ = device_code;

        let token = super::github_device_token(
            "Ov23lic8terv0XOd3GDe".to_string(),
            "bogus-device-code-that-github-never-issued".to_string(),
        )
        .await;
        assert!(token.access_token.is_none(), "bogus code must never yield a token");
        assert!(token.error.is_some(), "bogus code must come back as an error");
    }

    // Hunt 5 (P1) — LIVE test, #[ignore]d like the one above. Run on
    // demand: cargo test --offline -- --ignored
    // It proves the Wayback command really reaches web.archive.org:
    // a CDX query for example.com returns 200 with a JSON array, and
    // a non-archive URL is refused without any network call.
    #[tokio::test]
    #[ignore]
    async fn wayback_fetch_live_round_trip() {
        let res = super::wayback_fetch(
            "https://web.archive.org/cdx/search/cdx?url=example.com&output=json&limit=1".to_string(),
        )
        .await;
        assert!(res.error.is_none(), "wayback error: {:?}", res.error);
        assert_eq!(res.status, 200);
        let body = res.body.expect("CDX body present");
        assert!(body.trim_start().starts_with('['), "CDX body is a JSON array: {body}");

        let refused = super::wayback_fetch("https://example.com/".to_string()).await;
        assert_eq!(refused.status, 0);
        assert!(refused.error.is_some(), "non-archive URL must be refused");
    }
}
