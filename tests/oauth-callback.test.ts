// Tests: OAuth callback completion — deep link -> handleRedirect ->
// exchangeCode -> /user -> keyring. The token exchange and the /user
// lookup are MOCKED here; no test ever hits real GitHub, and no real
// secret exists anywhere in the tree.
import test from "node:test";
import assert from "node:assert/strict";
import {
  completeOAuthCallback,
  fetchGithubUser,
} from "../src/lib/auth.js";
import {
  AccountKeyring,
  addGithubAccount,
  createMemoryKeyringStore,
} from "../src/lib/network/accounts.js";
import { accountSwitcherPillView } from "../src/lib/network/accounts-ui.js";

const CALLBACK = "arknetz://oauth/callback?code=CODE123&state=s1";

test("completeOAuthCallback exchanges the code and reads the login (mocked)", async () => {
  const seen: { code?: string; token?: string } = {};
  const out = await completeOAuthCallback(CALLBACK, "s1", {
    exchange: async (code) => {
      seen.code = code;
      return "gho_mocktoken";
    },
    fetchUser: async (token) => {
      seen.token = token;
      return { login: "someuser", avatarUrl: "https://example.com/a.png" };
    },
  });
  assert.equal(seen.code, "CODE123");
  assert.equal(seen.token, "gho_mocktoken");
  assert.deepEqual(out, {
    token: "gho_mocktoken",
    user: { login: "someuser", avatarUrl: "https://example.com/a.png" },
  });
});

test("completeOAuthCallback rejects a state mismatch and never calls the exchange", async () => {
  let exchangeCalled = false;
  await assert.rejects(
    () =>
      completeOAuthCallback(CALLBACK, "different-state", {
        exchange: async () => {
          exchangeCalled = true;
          return "gho_x";
        },
        fetchUser: async () => ({ login: "x", avatarUrl: null }),
      }),
    /state mismatch/,
  );
  assert.equal(exchangeCalled, false);
});

test("completeOAuthCallback surfaces the error param and refuses a missing code", async () => {
  const never = {
    exchange: async () => {
      throw new Error("exchange must not run");
    },
    fetchUser: async () => {
      throw new Error("fetchUser must not run");
    },
  };
  await assert.rejects(
    () =>
      completeOAuthCallback(
        "arknetz://oauth/callback?error=access_denied&state=s1",
        "s1",
        never,
      ),
    /access_denied/,
  );
  await assert.rejects(
    () => completeOAuthCallback("arknetz://oauth/callback?state=s1", "s1", never),
    /no code/,
  );
});

test("completeOAuthCallback propagates an exchange failure (e.g. not_configured) loudly", async () => {
  await assert.rejects(
    () =>
      completeOAuthCallback(CALLBACK, "s1", {
        exchange: async () => {
          throw new Error(
            "GitHub token exchange failed: not_configured: ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET is not set.",
          );
        },
        fetchUser: async () => ({ login: "x", avatarUrl: null }),
      }),
    /not_configured/,
  );
});

test("fetchGithubUser parses login + avatar from /user, throws on non-2xx or no login", async () => {
  const okFetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ login: "octocat", avatar_url: "https://example.com/o.png" }),
    }) as unknown as Response) as typeof fetch;
  assert.deepEqual(await fetchGithubUser("gho_tok", okFetch), {
    login: "octocat",
    avatarUrl: "https://example.com/o.png",
  });

  const deniedFetch = (async () =>
    ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as typeof fetch;
  await assert.rejects(() => fetchGithubUser("gho_bad", deniedFetch), /HTTP 401/);

  const noLoginFetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ avatar_url: null }),
    }) as unknown as Response) as typeof fetch;
  await assert.rejects(() => fetchGithubUser("gho_tok", noLoginFetch), /no login/);
});

async function unlockedKeyring(): Promise<AccountKeyring> {
  const keyring = new AccountKeyring(createMemoryKeyringStore());
  await keyring.load();
  await keyring.unlock("test-passphrase");
  return keyring;
}

test("addGithubAccount puts the signed-in GitHub account in the keyring, active, pill-visible", async () => {
  const keyring = await unlockedKeyring();
  const account = await addGithubAccount(
    keyring,
    { login: "someuser", avatarUrl: "https://example.com/a.png" },
    "gho_mocktoken",
  );
  assert.equal(account.provider, "github");
  assert.equal(account.username, "someuser");
  assert.equal(keyring.getActive("github")?.id, "someuser");
  assert.equal(keyring.isMasterAdmin(), false);
  // The token is stored encrypted, never in plaintext.
  assert.equal(await keyring.revealSecret("github", "someuser"), "gho_mocktoken");
  // The Account Switcher Pill shows it like any other backend account.
  const pill = accountSwitcherPillView(keyring.snapshot(), keyring.isMasterAdmin());
  assert.equal(pill.pillLabel, "someuser");
  assert.equal(pill.masterBadgeVisible, false);
  assert.equal(pill.signedInCount, 1);
  const gh = pill.sections.find((s) => s.provider === "github");
  assert.equal(gh?.accounts.length, 1);
  assert.equal(gh?.accounts[0]?.isActive, true);
});

test("addGithubAccount for the master login shows the Root Master badge", async () => {
  const keyring = await unlockedKeyring();
  await addGithubAccount(
    keyring,
    { login: "PropTheRtRevDrSirStanleyG05", avatarUrl: null },
    "gho_mastertoken",
  );
  assert.equal(keyring.isMasterAdmin(), true);
  const pill = accountSwitcherPillView(keyring.snapshot(), keyring.isMasterAdmin());
  assert.equal(pill.masterBadgeVisible, true);
  assert.equal(pill.masterBadgeLabel, "Root Master");
  assert.equal(pill.pillLabel, "PropTheRtRevDrSirStanleyG05");
});

test("addGithubAccount re-sign-in refreshes the stored token instead of duplicating", async () => {
  const keyring = await unlockedKeyring();
  await addGithubAccount(keyring, { login: "someuser", avatarUrl: null }, "gho_old");
  await addGithubAccount(keyring, { login: "someuser", avatarUrl: null }, "gho_new");
  assert.equal(keyring.listAccounts("github").length, 1);
  assert.equal(await keyring.revealSecret("github", "someuser"), "gho_new");
  assert.equal(keyring.getActive("github")?.id, "someuser");
});

test("addGithubAccount refuses loudly when the keyring is locked", async () => {
  const keyring = new AccountKeyring(createMemoryKeyringStore());
  await keyring.load();
  assert.equal(keyring.isUnlocked, false);
  await assert.rejects(
    () => addGithubAccount(keyring, { login: "someuser", avatarUrl: null }, "gho_tok"),
    /keyring is locked/,
  );
  assert.equal(keyring.listAccounts("github").length, 0);
});
