// Tests: GitHub OAuth entry point — real endpoint shape, no fake tokens.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GITHUB_AUTHORIZE_URL,
  buildAuthorizeUrl,
  handleRedirect,
  isMasterUser,
  randomState,
  requestDeviceCode,
  pollDeviceToken,
  completeDeviceSignIn,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
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

// --- Device flow (hunt 4) -------------------------------------------------

function mockDeviceFetch(responses: unknown[]) {
  let i = 0;
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: String(init?.body ?? "") });
    const body = responses[Math.min(i++, responses.length - 1)];
    return { json: async () => body };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test("requestDeviceCode posts client_id + scopes and returns the code set", async () => {
  const { fetchFn, calls } = mockDeviceFetch([
    {
      device_code: "dev-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/device",
      expires_in: 900,
      interval: 5,
    },
  ]);
  const got = await requestDeviceCode("Iv1.testclient", fetchFn);
  assert.equal(got.deviceCode, "dev-123");
  assert.equal(got.userCode, "ABCD-EFGH");
  assert.equal(got.verificationUri, "https://github.com/device");
  assert.equal(got.expiresIn, 900);
  assert.equal(got.interval, 5);
  assert.equal(calls[0]?.url, GITHUB_DEVICE_CODE_URL);
  assert.match(calls[0]?.body ?? "", /client_id=Iv1\.testclient/);
  assert.match(calls[0]?.body ?? "", /scope=read%3Auser/);
});

test("requestDeviceCode turns device_flow_disabled into the exact fix", async () => {
  const { fetchFn } = mockDeviceFetch([{ error: "device_flow_disabled" }]);
  await assert.rejects(() => requestDeviceCode("Iv1.testclient", fetchFn), /Enable Device Flow/);
});

test("requestDeviceCode throws when GitHub returns no code", async () => {
  const { fetchFn } = mockDeviceFetch([{}]);
  await assert.rejects(() => requestDeviceCode("Iv1.testclient", fetchFn), /no code/);
});

test("pollDeviceToken polls through authorization_pending, then returns the token", async () => {
  const { fetchFn, calls } = mockDeviceFetch([
    { error: "authorization_pending" },
    { error: "authorization_pending" },
    { access_token: "gho_token123" },
  ]);
  const slept: number[] = [];
  const token = await pollDeviceToken("dev-123", {
    fetchFn,
    sleepFn: async (ms) => {
      slept.push(ms);
    },
    deadlineMs: Date.now() + 60_000,
  });
  assert.equal(token, "gho_token123");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, GITHUB_TOKEN_URL);
  assert.match(calls[0]?.body ?? "", /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
  assert.deepEqual(slept, [5000, 5000]);
});

test("pollDeviceToken honors slow_down by adding 5s to the interval", async () => {
  const { fetchFn } = mockDeviceFetch([
    { error: "slow_down" },
    { access_token: "gho_token456" },
  ]);
  const slept: number[] = [];
  const token = await pollDeviceToken("dev-123", {
    fetchFn,
    intervalSec: 5,
    sleepFn: async (ms) => {
      slept.push(ms);
    },
    deadlineMs: Date.now() + 60_000,
  });
  assert.equal(token, "gho_token456");
  assert.deepEqual(slept, [10000]);
});

test("pollDeviceToken throws expired_token / access_denied instead of polling forever", async () => {
  const { fetchFn: f1 } = mockDeviceFetch([{ error: "expired_token" }]);
  await assert.rejects(
    () => pollDeviceToken("dev-123", { fetchFn: f1, sleepFn: async () => {}, deadlineMs: Date.now() + 60_000 }),
    /expired/,
  );
  const { fetchFn: f2 } = mockDeviceFetch([{ error: "access_denied" }]);
  await assert.rejects(
    () => pollDeviceToken("dev-123", { fetchFn: f2, sleepFn: async () => {}, deadlineMs: Date.now() + 60_000 }),
    /denied/,
  );
});

test("pollDeviceToken stops at the deadline instead of polling past expiry", async () => {
  const { fetchFn } = mockDeviceFetch([{ error: "authorization_pending" }]);
  await assert.rejects(
    () => pollDeviceToken("dev-123", { fetchFn, intervalSec: 5, sleepFn: async () => {}, deadlineMs: Date.now() + 1000 }),
    /expired/,
  );
});

test("completeDeviceSignIn reads the token owner's login (mock user lookup)", async () => {
  const got = await completeDeviceSignIn("gho_token123", {
    fetchUser: async () => ({ login: "PropTheRtRevDrSirStanleyG05", avatarUrl: null }),
  });
  assert.equal(got.token, "gho_token123");
  assert.equal(got.user.login, "PropTheRtRevDrSirStanleyG05");
});
