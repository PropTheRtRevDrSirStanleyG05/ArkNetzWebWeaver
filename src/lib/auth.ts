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
  const tauri = (globalThis as unknown as { __TAURI__?: { core: { invoke(cmd: string, args?: unknown): Promise<unknown> } } }).__TAURI__;
  if (!tauri) {
    throw new Error(
      "GitHub token exchange needs the Tauri shell (github_oauth_exchange command). " +
        "Running outside Tauri — sign-in stops here, no token is issued.",
    );
  }
  const result = (await tauri.core.invoke("github_oauth_exchange", { code, client_id: clientId })) as {
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
  const res = await fetchFn(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });
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
