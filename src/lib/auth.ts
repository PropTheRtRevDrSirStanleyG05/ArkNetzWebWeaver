// ArkNetzWebWeaver — GitHub OAuth sign-in.
// Thread turn 9: "Sign in with GitHub" (OAuth). Write actions are locked
// until sign-in; browsing is anonymous by default.
// The OAuth flow is the real GitHub shape — no fake tokens, ever:
//   1. buildAuthorizeUrl() -> https://github.com/login/oauth/authorize
//      ?client_id=<id>&scope=read:user+public_repo&state=<random>
//   2. GitHub redirects to the app's redirect URI with ?code=...&state=...
//   3. handleRedirect() validates state and extracts the code.
//   4. The code is exchanged for a token ONLY in the Tauri Rust command
//      `github_oauth_exchange` (src-tauri/src/main.rs), because the
//      client secret must never be in the webview. Until a client secret
//      is supplied via the build environment, that command returns
//      "not_configured" and sign-in stops there, loudly — it does not
//      invent a token.
// GITHUB_OAUTH_CLIENT_ID is empty in config.ts until Stanley (or a fork)
// creates a GitHub OAuth App. startSignIn() throws in that case, with a
// message that says exactly what to do, instead of opening a broken URL.

import {
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_SCOPES,
  MASTER_GITHUB_USER,
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
        "The client secret must never be put in the app — it belongs to the Tauri command (see src-tauri/src/main.rs).",
    );
  }
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
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
 *  feature, precisely so the secret never reaches the webview. */
export async function exchangeCode(code: string): Promise<string> {
  const tauri = (globalThis as unknown as { __TAURI__?: { core: { invoke(cmd: string, args?: unknown): Promise<unknown> } } }).__TAURI__;
  if (!tauri) {
    throw new Error(
      "GitHub token exchange needs the Tauri shell (github_oauth_exchange command). " +
        "Running outside Tauri — sign-in stops here, no token is issued.",
    );
  }
  const result = (await tauri.core.invoke("github_oauth_exchange", { code })) as {
    accessToken?: string;
    error?: string;
  };
  if (result.error) throw new Error(`GitHub token exchange failed: ${result.error}`);
  if (!result.accessToken) throw new Error("GitHub token exchange returned no token");
  return result.accessToken;
}
