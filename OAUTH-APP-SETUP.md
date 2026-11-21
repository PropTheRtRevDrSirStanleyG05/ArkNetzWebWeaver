# GitHub OAuth App setup for ArkNetzWebWeaver

> **Status: NOT DONE — no OAuth App exists yet, and sign-in does not work.**
> OAuth Apps **cannot** be created via the GitHub API, so no agent or script
> can create one. A human (Stanley) must create it in the GitHub web UI using
> the values below. **Do not invent a client ID or secret** — sign-in throws
> loudly until the real values are in place, by design.

## Values to enter in the GitHub web UI

| Field in GitHub | Value |
|---|---|
| **Application name** | `ArkNetzWebWeaver` |
| **Homepage URL** | `https://github.com/PropTheRtRevDrSirStanleyG05/ArkNetzWebWeaver` |
| **Application description** | `ArkNetzWebWeaver by STANBEYOND — zero-server, $0/month decentralized web app (Tauri + TypeScript). Sign-in is only for writes (domain claims, publishing, mail, ArkDrive); browsing is anonymous.` |
| **Authorization callback URL** | `arknetz://oauth/callback` (see "Callback URL — read this" below) |

## Steps (GitHub web UI, signed in as PropTheRtRevDrSirStanleyG05)

1. Open **Settings → Developer settings → OAuth Apps → New OAuth App**
   (direct URL: `https://github.com/settings/developers` → "OAuth Apps").
2. Fill in the four fields from the table above and click **Register application**.
3. On the app page, copy the **Client ID**.
4. Click **Generate a new client secret** and copy the **Client Secret** once —
   GitHub shows it only once.
5. Put the **Client ID** in `src/lib/config.ts`:
   `GITHUB_OAUTH_CLIENT_ID = "<the client id>"` (it is empty today).
6. Put the **Client Secret** in the **builder's own machine environment only**:
   `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET="<the secret>"` at runtime when
   building/running the Tauri shell. **Never put the secret in the app bundle,
   in `config.ts`, in any repo, or in any file.**
7. Rebuild the app (`npm run build` + `tauri build`).
8. Test: click Sign in → GitHub authorizes → the app returns to
   ArkNetzWebWeaver signed in. If anything fails, the app must say exactly
   what is missing — it must never invent a token.

## What the code actually does today (quoted from source — verify before trusting this file)

- `src/lib/auth.ts` — `buildAuthorizeUrl(state)` builds
  `https://github.com/login/oauth/authorize?client_id=<id>&scope=read:user+public_repo&state=<random>`.
  **It sets NO `redirect_uri` parameter.** GitHub therefore redirects to
  whatever **Authorization callback URL** is registered on the OAuth App —
  that is why the table above registers `arknetz://oauth/callback`.
- `src/lib/auth.ts` — `handleRedirect(redirectUrl, expectedState)` parses
  `?code=…&state=…` out of any URL string, validates the state (CSRF check),
  and returns the code. It accepts an `arknetz://oauth/callback?code=…&state=…`
  URL — **but nothing calls it yet** (see below).
- `src/lib/config.ts` — `GITHUB_OAUTH_SCOPES = ["read:user", "public_repo"]`
  (the scopes requested) and `GITHUB_OAUTH_CLIENT_ID = ""` (empty until
  this setup is done). `MASTER_GITHUB_USER = "PropTheRtRevDrSirStanleyG05"`.
- `src-tauri/src/main.rs` — `github_oauth_exchange(code, client_id)` posts
  the code + client secret to `https://github.com/login/oauth/access_token`
  and returns the token. The secret comes from the environment variable
  `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET` at runtime; if it is absent the
  command returns `"not_configured"` and sign-in stops loudly.
- `src/main.ts` — the Sign in button only builds the authorize URL and
  opens it in a new tab (`window.open(url, "_blank", "noopener")`). It does
  **not** handle the return redirect.

## Callback URL — read this (the honest gap)

The recommended callback is **`arknetz://oauth/callback`**: the app already
registers the `arknetz://` custom scheme with the OS
(`tauri-plugin-deep-link`, `src/lib/deep-link.ts`, `src-tauri/tauri.conf.json`
`plugins.deep-link`), so the OS can hand the redirect back to the app as a
deep link. **But the receiver is NOT wired yet:**

- `src/lib/deep-link.ts` routes incoming `arknetz://` URLs through the
  shell's tab navigation (`openTab` as a site address). An
  `arknetz://oauth/callback?code=…&state=…` URL would be parsed as domain
  `oauth`, which is not a valid domain, so it is silently skipped today.
- Nobody wires the deep-link listener's `onOpenUrl` to `handleRedirect()` +
  `exchangeCode()` yet, and the sign-in button stores the OAuth `state` in
  `sessionStorage` (`arknetz-oauth-state`), which a second app process
  spawned by the OS for the deep link would not share.

**So: registering the callback URL above is the correct first step, but
sign-in will not work end to end until the receiver is built** (deep-link
listener → detect `arknetz://oauth/callback` → `handleRedirect()` with the
stored state → `exchangeCode()` → store the token + login). That wiring is
a code task for the next round, not a settings task. An alternative callback
— a loopback URL such as `http://127.0.0.1:<port>/callback` — would need a
local HTTP listener that also does not exist yet, so the custom scheme stays
the recommendation.

## What NOT to do

- Do not create the OAuth App via any API/CLI/script — GitHub does not
  allow it, and any "client ID" produced that way would be invented.
- Do not put the client secret anywhere in the repo, the app bundle, or
  chat. The secret lives only in the builder's runtime environment.
- Do not widen the scopes: `read:user` + `public_repo` is what the code
  requests. More scopes need a code change and a reason.
- Do not claim sign-in works until the manual test in step 8 passes.
