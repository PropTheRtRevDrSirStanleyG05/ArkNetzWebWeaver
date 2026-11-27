// ArkNetzWebWeaver — GitHub OAuth sign-in.
// Thread turn 9: "Sign in with GitHub" (OAuth). Write actions are locked
// until sign-in; browsing is anonymous by default.
// The OAuth flow is the real GitHub shape — no fake tokens, ever:
//   1. buildAuthorizeUrl() -> https://github.com/login/oauth/authorize
//      ?client_id=<id>&redirect_uri=arknetz://oauth/callback
//      &scope=read:user+public_repo&state=<random>
//   2. GitHub redirects to arknetz://oauth/callback?code=...&state=...
//      The OS hands that URL to the app through the deep-link plugin;
//      deep-link.ts intercepts it (it is not a site address) and the
//      shell routes it to completeOAuthCallback() below.
//   3. handleRedirect() validates state and extracts the code.
//   4. The code is exchanged for a token ONLY in the Tauri Rust command
//      `github_oauth_exchange` (src-tauri/src/lib.rs), because the
//      client secret must never be in the webview. Until a client secret
//      is supplied at runtime via ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET,
//      that command returns "not_configured" and sign-in stops there,
//      loudly — it does not invent a token.
//   5. fetchGithubUser() reads GET /user with the token, so the
//      account that lands in the keyring carries the real login (and
//      the Master Admin Badge keys off that login).
// GITHUB_OAUTH_CLIENT_ID lives in config.ts (registered 2026-11-21).
// startSignIn() in main.ts throws when no client id is configured,
// with a message that says exactly what to do, instead of opening a
// broken URL.

import {
  GITHUB_API_BASE,
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_REDIRECT_URI,
  GITHUB_OAUTH_SCOPES,
  MASTER_GITHUB_USER,
  USER_AGENT,
} from "./config.js";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface AuthState {
  state: string;
  codeVerifier?: string;
}

export function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildAuthorizeUrl(state: string, clientId = GITHUB_OAUTH_CLIENT_ID): string {
  if (!clientId) {
    throw new Error(
      "GitHub OAuth is not configured: GITHUB_OAUTH_CLIENT_ID is empty. " +
        "Create a GitHub OAuth App and set its client id in src/lib/config.ts at build time. " +
        "The client secret must never be put in the app — it belongs to the Tauri command (see src-tauri/src/lib.rs).",
    );
  }
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  // The redirect URI is registered on the OAuth App; without it GitHub
  // refuses the authorize request (or redirects somewhere the app
  // cannot receive). It must match config.ts exactly.
  url.searchParams.set("redirect_uri", GITHUB_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", GITHUB_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export function handleRedirect(
  redirectUrl: string,
  expectedState: string,
): { code: string } {
  const url = new URL(redirectUrl);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) throw new Error(`GitHub sign-in failed: ${error}`);
  if (state !== expectedState) {
    throw new Error("GitHub sign-in failed: state mismatch (possible CSRF — refusing the code)");
  }
  if (!code) throw new Error("GitHub sign-in failed: no code in redirect");
  return { code };
}

/** Is the signed-in GitHub login the Root Master? The app only REVEALS
 *  the Master Admin Panel for this login; enforcement is GitHub's 403 on
 *  protocol-root writes, never the UI (thread turn 9). */
export function isMasterUser(githubLogin: string | null | undefined): boolean {
  return githubLogin === MASTER_GITHUB_USER;
}

/** The Tauri shell's invoke bridge, when the app runs inside Tauri
 *  (window.__TAURI__ with withGlobalTauri). Null in a plain browser
 *  or in tests that do not install a mock. */
type TauriCore = {
  core: { invoke(cmd: string, args?: unknown): Promise<unknown> };
};

function tauriCore(): TauriCore["core"] | null {
  const tauri = (globalThis as unknown as { __TAURI__?: TauriCore }).__TAURI__;
  return tauri?.core ?? null;
}

/** Turn a bare browser/network failure into something a person can
 *  act on. fetch() throws `TypeError: Failed to fetch` (and friends)
 *  with no cause attached — shown verbatim that string tells the user
 *  nothing. Anything that is not a network failure passes through
 *  unchanged, including the exact GitHub error strings
 *  (device_flow_disabled, expired_token, …). */
export function friendlySignInError(message: string): string {
  if (/failed to fetch|networkerror|network request failed|load failed|failed to load/i.test(message)) {
    return (
      "Couldn't reach GitHub — check your connection, then tap “Sign in with GitHub” again. " +
        `(The network said: ${message})`
    );
  }
  return message;
}

/** Exchange a code for a token via the Tauri command. In a plain browser
 *  (no Tauri) this throws — sign-in is a Tauri-app feature, not a web-page
 *  feature, precisely so the secret never reaches the webview.
 *  The Rust command takes (code, client_id): the client id comes from
 *  the webview at call time, the secret from the shell's runtime
 *  environment — neither side ever sees the other's half. */
export async function exchangeCode(
  code: string,
  clientId = GITHUB_OAUTH_CLIENT_ID,
): Promise<string> {
  const core = tauriCore();
  if (!core) {
    throw new Error(
      "GitHub token exchange needs the Tauri shell (github_oauth_exchange command). " +
        "Running outside Tauri — sign-in stops here, no token is issued.",
    );
  }
  const result = (await core.invoke("github_oauth_exchange", { code, client_id: clientId })) as {
    accessToken?: string;
    error?: string;
  };
  if (result.error) throw new Error(`GitHub token exchange failed: ${result.error}`);
  if (!result.accessToken) throw new Error("GitHub token exchange returned no token");
  return result.accessToken;
}

/** The GitHub user a token belongs to (GET /user — the one
 *  authenticated read GITHUB_API_BASE is used for, per config.ts). */
export interface GithubUser {
  login: string;
  avatarUrl: string | null;
}

/** Read the token owner's login. Throws loudly on any non-2xx — a
 *  token GitHub does not accept must never silently become an
 *  account. `fetchFn` is injectable so tests never hit real GitHub. */
export async function fetchGithubUser(
  token: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<GithubUser> {
  let res: Response;
  try {
    res = await fetchFn(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
    });
  } catch (err) {
    // Hunt 5: a dropped connection while reading /user used to surface
    // as a bare "Failed to fetch". Say what happened and what to try.
    throw new Error(friendlySignInError(err instanceof Error ? err.message : String(err)));
  }
  if (!res.ok) {
    throw new Error(
      `GitHub /user lookup failed: HTTP ${res.status} — the token was not accepted, so no account was created`,
    );
  }
  const body = (await res.json()) as { login?: unknown; avatar_url?: unknown };
  if (typeof body.login !== "string" || !body.login) {
    throw new Error("GitHub /user lookup returned no login — no account was created");
  }
  return {
    login: body.login,
    avatarUrl: typeof body.avatar_url === "string" ? body.avatar_url : null,
  };
}

export interface OAuthCompletionDeps {
  /** Defaults to the real Tauri exchange (exchangeCode). Tests pass a
   *  mock — the real exchange is never called from a test. */
  exchange?: (code: string) => Promise<string>;
  /** Defaults to fetchGithubUser. Tests pass a mock. */
  fetchUser?: (token: string) => Promise<GithubUser>;
}

/** The full callback half of the flow: validate the redirect (state +
 *  code), exchange the code for a token, and read the token owner's
 *  login. Every step throws loudly on failure — a half-finished
 *  sign-in never leaves a token or an account behind. */
export async function completeOAuthCallback(
  redirectUrl: string,
  expectedState: string,
  deps: OAuthCompletionDeps = {},
): Promise<{ token: string; user: GithubUser }> {
  const { code } = handleRedirect(redirectUrl, expectedState);
  const token = await (deps.exchange ?? exchangeCode)(code);
  const user = await (deps.fetchUser ?? fetchGithubUser)(token);
  return { token, user };
}

// --- GitHub device authorization flow (hunt 4, BUG 1) --------------------
// Why this exists: the redirect flow (above) can never complete on a
// phone. Its code exchange needs the OAuth App's client secret, and the
// secret is read from the ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET environment
// variable — which cannot exist inside a released APK (or any app a
// user installs). The redirect itself is also broken as shipped: with
// no opener plugin, window.open keeps GitHub inside the app's WebView,
// where the Rust nav guard blocks the arknetz:// callback, so the app
// never sees the code at all. The device flow needs NEITHER: only the
// client id (already in config.ts), no secret, no redirect URI, no
// deep link. The user types a short code at github.com/device in their
// own browser; the app polls until GitHub issues the token.
//   POST https://github.com/login/device/code
//     {client_id, scope} -> {device_code, user_code, verification_uri,
//       expires_in, interval}
//   POST https://github.com/login/oauth/access_token
//     {client_id, device_code, grant_type:
//      "urn:ietf:params:oauth:grant-type:device_code"}
//     -> {access_token} | {error: "authorization_pending"|"slow_down"|
//       "expired_token"|"access_denied"|"device_flow_disabled"}
// Hunt 5: BOTH posts go through the Tauri Rust commands
// `github_device_code` / `github_device_token` (src-tauri/src/lib.rs)
// whenever the app runs inside Tauri. They used to go through
// window.fetch — and GitHub's login endpoints send NO
// Access-Control-Allow-Origin header, so the WebView's CORS check
// rejected the (HTTP 200) response and fetch threw a bare
// "Failed to fetch" on Stanley's Pixel (v0.5.0). Rust has no CORS,
// so the same posts succeed there. The window.fetch path below
// survives ONLY for plain-browser/test use: passing an explicit
// fetchFn forces it (tests do this), and with no __TAURI__ present
// the global fetch is the only option left.
// The GET /user call (fetchGithubUser, above) deliberately stays on
// fetch: api.github.com DOES return Access-Control-Allow-Origin: *
// (verified live 2026-11-27), so the WebView fetch is not blocked
// there, and routing it through Rust would add a third command —
// and another IPC hop carrying the access token — for no gain.
// One prerequisite lives OUTSIDE this repo: Device Flow must be
// enabled on the OAuth App itself (GitHub Settings -> Developer
// settings -> OAuth Apps -> ArkNetzWebWeaver -> "Enable Device Flow").
// Until that checkbox is on, GitHub answers device_flow_disabled —
// the request below surfaces that as an exact, actionable error
// instead of a silent failure. Do NOT change OAuth App settings from
// here; the app owner flips the checkbox.

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const DEVICE_FLOW_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires (GitHub default 900). */
  expiresIn: number;
  /** Seconds between polls (GitHub default 5). */
  interval: number;
}

/** Ask GitHub for a device code. Inside Tauri this goes through the
 *  `github_device_code` Rust command (no CORS in Rust — see above);
 *  with an explicit `fetchFn` it uses that fetch instead (tests, and
 *  plain-browser use where there is no Tauri shell). Throws loudly
 *  on device_flow_disabled with the exact fix (enable Device Flow on
 *  the OAuth App). A network failure surfaces as a friendly
 *  couldn't-reach-GitHub message, never a bare "Failed to fetch". */
export async function requestDeviceCode(
  clientId = GITHUB_OAUTH_CLIENT_ID,
  fetchFn?: typeof fetch,
): Promise<DeviceCodeResponse> {
  let body: Record<string, unknown>;
  const core = fetchFn ? null : tauriCore();
  if (core) {
    try {
      body = (await core.invoke("github_device_code", {
        client_id: clientId,
        scope: GITHUB_OAUTH_SCOPES.join(" "),
      })) as Record<string, unknown>;
    } catch (err) {
      throw new Error(friendlySignInError(err instanceof Error ? err.message : String(err)));
    }
  } else {
    const fetchImpl = fetchFn ?? globalThis.fetch;
    let res: Response;
    try {
      res = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: clientId,
          scope: GITHUB_OAUTH_SCOPES.join(" "),
        }).toString(),
      });
    } catch (err) {
      throw new Error(friendlySignInError(err instanceof Error ? err.message : String(err)));
    }
    body = (await res.json()) as Record<string, unknown>;
  }
  if (typeof body.error === "string") {
    if (body.error === "device_flow_disabled") {
      throw new Error(
        "GitHub sign-in failed: Device Flow is not enabled on this OAuth App. " +
          "Enable it in the OAuth App settings (GitHub Settings → Developer settings → OAuth Apps → ArkNetzWebWeaver → Enable Device Flow), then try again.",
      );
    }
    throw new Error(`GitHub device-code request failed: ${body.error}`);
  }
  const deviceCode = body.device_code;
  const userCode = body.user_code;
  const verificationUri = body.verification_uri;
  if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode || typeof verificationUri !== "string" || !verificationUri) {
    throw new Error("GitHub device-code request returned no code — sign-in cannot start");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}

/** Poll GitHub until the user authorizes (or denies / the code
 *  expires). Sleeps `interval` seconds between attempts; honors
 *  slow_down by adding 5 s; stops at `deadlineMs` (the code's
 *  expiry). `sleepFn` is injectable so tests run instantly. Returns
 *  the access token; never invents one.
 *  Inside Tauri each poll attempt goes through the
 *  `github_device_token` Rust command (no CORS in Rust — see above);
 *  an explicit `fetchFn` forces the fetch path instead (tests, and
 *  plain-browser use). A network failure on one attempt ends the
 *  sign-in with a friendly couldn't-reach-GitHub message — it does
 *  NOT silently retry, so a dead connection never spins the poll
 *  until the code expires. */
export async function pollDeviceToken(
  deviceCode: string,
  opts: {
    clientId?: string;
    intervalSec?: number;
    deadlineMs?: number;
    fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<string> {
  const clientId = opts.clientId ?? GITHUB_OAUTH_CLIENT_ID;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let intervalMs = (opts.intervalSec ?? 5) * 1000;
  const deadlineMs = opts.deadlineMs ?? Date.now() + 900_000;
  const core = opts.fetchFn ? null : tauriCore();
  /** One poll attempt, by whichever transport applies. Returns the
   *  raw GitHub JSON shape ({access_token} or {error}) either way,
   *  so the loop below maps errors exactly as before. */
  const postOnce = async (): Promise<Record<string, unknown>> => {
    if (core) {
      try {
        return (await core.invoke("github_device_token", {
          client_id: clientId,
          device_code: deviceCode,
        })) as Record<string, unknown>;
      } catch (err) {
        throw new Error(friendlySignInError(err instanceof Error ? err.message : String(err)));
      }
    }
    const fetchImpl = opts.fetchFn ?? globalThis.fetch;
    try {
      const res = await fetchImpl(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: DEVICE_FLOW_GRANT_TYPE,
        }).toString(),
      });
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(friendlySignInError(err instanceof Error ? err.message : String(err)));
    }
  };
  for (;;) {
    const body = await postOnce();
    if (typeof body.access_token === "string" && body.access_token) {
      return body.access_token;
    }
    const error = typeof body.error === "string" ? body.error : "";
    if (error === "authorization_pending") {
      // Not yet — wait and poll again.
    } else if (error === "slow_down") {
      intervalMs += 5000;
    } else if (error === "expired_token") {
      throw new Error("GitHub sign-in failed: the device code expired — start sign-in again for a fresh code.");
    } else if (error === "access_denied") {
      throw new Error("GitHub sign-in failed: the authorization was denied on github.com/device.");
    } else if (error) {
      throw new Error(`GitHub device sign-in failed: ${error}`);
    } else {
      throw new Error("GitHub device sign-in returned neither a token nor an error");
    }
    if (Date.now() + intervalMs > deadlineMs) {
      throw new Error("GitHub sign-in failed: the device code expired — start sign-in again for a fresh code.");
    }
    await sleepFn(intervalMs);
  }
}

/** The full device-flow completion: fetch the token owner's login for
 *  a token obtained by pollDeviceToken. Same shape as
 *  completeOAuthCallback's tail, so the shell finishes both flows the
 *  same way (keyring, pill, panels). */
export async function completeDeviceSignIn(
  token: string,
  deps: OAuthCompletionDeps = {},
): Promise<{ token: string; user: GithubUser }> {
  const user = await (deps.fetchUser ?? fetchGithubUser)(token);
  return { token, user };
}

// --- Pending state across processes ---------------------------------------
// The OS may deliver the callback to a SECOND app process (no
// single-instance plugin yet — see deep-link.ts): that process shares
// localStorage with the first but not sessionStorage, so the pending
// state lives in localStorage. It is a one-time CSRF nonce, not a
// secret; it is consumed (deleted) the moment the callback is handled,
// and it never leaves this origin. Falls back to sessionStorage, then
// to nothing, when localStorage is unavailable (plain browser, tests).

export const OAUTH_STATE_STORAGE_KEY = "arknetz-oauth-state";

function pendingStateStorage(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Storage access denied — fall through to the next option.
  }
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    // Storage access denied.
  }
  return null;
}

export function savePendingOAuthState(state: string): void {
  pendingStateStorage()?.setItem(OAUTH_STATE_STORAGE_KEY, state);
}

/** Read and delete the pending state. Null when no sign-in was
 *  started (or storage is unavailable) — the caller must refuse the
 *  callback in that case instead of guessing. */
export function takePendingOAuthState(): string | null {
  const storage = pendingStateStorage();
  if (!storage) return null;
  const state = storage.getItem(OAUTH_STATE_STORAGE_KEY);
  if (state) storage.removeItem(OAUTH_STATE_STORAGE_KEY);
  return state;
}
