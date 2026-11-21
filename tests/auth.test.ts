// Tests: GitHub OAuth entry point — real endpoint shape, no fake tokens.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GITHUB_AUTHORIZE_URL,
  buildAuthorizeUrl,
  handleRedirect,
  isMasterUser,
  randomState,
} from "../src/lib/auth.js";

test("buildAuthorizeUrl throws when no client id is configured (never a broken URL)", () => {
  assert.throws(() => buildAuthorizeUrl("abc123", ""), /GITHUB_OAUTH_CLIENT_ID is empty/);
});

test("buildAuthorizeUrl builds the real GitHub authorize URL with client_id, scope, state", () => {
  const url = new URL(buildAuthorizeUrl("state-xyz", "Iv1.testclient"));
  assert.equal(url.origin + url.pathname, GITHUB_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), "Iv1.testclient");
  assert.equal(url.searchParams.get("state"), "state-xyz");
  assert.match(url.searchParams.get("scope") as string, /read:user/);
});

test("buildAuthorizeUrl sets redirect_uri=arknetz://oauth/callback and both registered scopes", () => {
  const url = new URL(buildAuthorizeUrl("state-xyz", "Iv1.testclient"));
  assert.equal(url.searchParams.get("redirect_uri"), "arknetz://oauth/callback");
  assert.equal(url.searchParams.get("scope"), "read:user public_repo");
  // The default client id (config.ts) produces the same shape.
  const def = new URL(buildAuthorizeUrl("s1"));
  assert.equal(def.searchParams.get("client_id"), "Ov23lic8terv0XOd3GDe");
  assert.equal(def.searchParams.get("redirect_uri"), "arknetz://oauth/callback");
});

test("randomState is 32 hex chars and unique", () => {
  const a = randomState();
  const b = randomState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("handleRedirect extracts the code only when state matches", () => {
  assert.deepEqual(
    handleRedirect("arknetz://auth/callback?code=CODE123&state=s1", "s1"),
    { code: "CODE123" },
  );
  assert.throws(() => handleRedirect("arknetz://auth/callback?code=CODE123&state=other", "s1"), /state mismatch/);
  assert.throws(() => handleRedirect("arknetz://auth/callback?state=s1", "s1"), /no code/);
  assert.throws(() => handleRedirect("arknetz://auth/callback?error=access_denied&state=s1", "s1"), /access_denied/);
});

test("isMasterUser only for PropTheRtRevDrSirStanleyG05", () => {
  assert.equal(isMasterUser("PropTheRtRevDrSirStanleyG05"), true);
  assert.equal(isMasterUser("stanbeyond"), false);
  assert.equal(isMasterUser(null), false);
  assert.equal(isMasterUser(undefined), false);
});
