// ArkNetzWebWeaver — central configuration.
// One file holds every network-wide constant so a fork can re-point the
// client at its own registry / OAuth app without touching the rest of the
// code (thread turn 40: bring-your-own OAuth, configurable root).
// NOTHING secret lives here: no tokens, no IA keys, no client secret.
// Licence: MIT, decided by Stanley 2026-11-20. See LICENSE.

export const MASTER_GITHUB_USER = "PropTheRtRevDrSirStanleyG05";
export const CLIENT_REPO = "ArkNetzWebWeaver";
export const DEFAULT_ROOT_REPO = "PropTheRtRevDrSirStanleyG05/arknetz-protocol-root";
// Thread turn 40 used "stanbeyond/protocol-root"; superseded 2026-11-20 by
// the confirmed master account above.

export const PROTOCOL_VERSION = "0.1.0";
export const USER_AGENT = "ArkNetzWebWeaver/1.0";

// GitHub OAuth app id, registered 2026-11-21 (callback
// arknetz://oauth/callback, scopes read:user public_repo). The client
// SECRET must never be in this file or in the app bundle — the code
// exchange happens in the Tauri Rust command (see
// src-tauri/src/lib.rs), which reads it at runtime from
// ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET and returns "not_configured"
// until it is supplied on the builder's own machine.
export const GITHUB_OAUTH_CLIENT_ID = "Ov23lic8terv0XOd3GDe";
export const GITHUB_OAUTH_SCOPES = ["read:user", "public_repo"];
/** The OAuth redirect URI, registered on the GitHub OAuth App: the
 *  OS hands this URL back to the app via the arknetz:// deep link,
 *  and the deep-link listener intercepts it before the site resolver
 *  (it is not a site address — "oauth" is not a valid domain). */
export const GITHUB_OAUTH_REDIRECT_URI = "arknetz://oauth/callback";

export const RAW_GITHUB_BASE = "https://raw.githubusercontent.com";
export const GITHUB_API_BASE = "https://api.github.com";
// Reads MUST use RAW_GITHUB_BASE. GITHUB_API_BASE is only for the
// authenticated master check (GET /user) and write actions — never for
// routine site/registry reads (thread turn 11).

export const IA_S3_BASE = "https://s3.us.archive.org";
export const IA_DOWNLOAD_BASE = "https://archive.org/download";

export const REGISTRY_SHARD_COUNT = 16; // 00-0f, expandable to 256 (00-ff)
export const CONTACTS_SHARD_COUNT = 16;

export function registryShardRepo(shardHex: string): string {
  return `arknetz-registry-${shardHex.padStart(2, "0")}`;
}
export function contactsShardRepo(shardHex: string): string {
  return `arknetz-contacts-${shardHex.padStart(2, "0")}`;
}
export function protocolRootRawUrl(): string {
  return `${RAW_GITHUB_BASE}/${DEFAULT_ROOT_REPO}/main/manifest.json`;
}
