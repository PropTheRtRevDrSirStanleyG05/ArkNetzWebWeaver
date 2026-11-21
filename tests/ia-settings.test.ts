// Tests: IA account-linking state machine — link / unlock / status /
// test / unlink. The secret key is never in any status object, and
// wrong passphrases / short passphrases are refused.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryIaAccountStore,
  getIaAccountStatus,
  linkIaAccount,
  testIaConnection,
  unlinkIaAccount,
  unlockIaAccount,
} from "../src/lib/ia-settings.js";

const GOOD = {
  username: "stanley",
  accessKey: "ABCD1234EFGH5678",
  secretKey: "super-secret-key-123",
  passphrase: "correct horse battery",
};

test("link -> locked status -> unlock -> keys in memory; secret never leaks", async () => {
  const store = createMemoryIaAccountStore();
  assert.deepEqual(await getIaAccountStatus(store), { linked: false });
  const status = await linkIaAccount(store, GOOD);
  assert.equal(status.linked, true);
  if (!status.linked) throw new Error("unreachable");
  assert.equal(status.locked, true);
  assert.equal(status.username, "stanley");
  assert.equal(status.accessKeyLast4, "5678");
  assert.equal(typeof status.linkedAt, "number");
  assert.equal(JSON.stringify(status).includes("super-secret"), false);
  // Before unlock there are no usable keys.
  await assert.rejects(() => unlockIaAccount(store, "wrong passphrase"), /passphrase/i);
  const keys = await unlockIaAccount(store, GOOD.passphrase);
  assert.equal(keys.accessKey, GOOD.accessKey);
  assert.equal(keys.secretKey, GOOD.secretKey);
  // The stored status still reports locked — the session unlock lives
  // in the caller's memory (iaKeys), not in the store.
  const after = await getIaAccountStatus(store);
  assert.equal(after.linked, true);
});

test("testIaConnection accepts 200 and 404, rejects 403", async () => {
  const store = createMemoryIaAccountStore();
  await linkIaAccount(store, GOOD);
  const keys = await unlockIaAccount(store, GOOD.passphrase);
  for (const code of [200, 404]) {
    const result = await testIaConnection(keys, async () => ({ status: code, text: async () => "" }));
    assert.equal(result.ok, true, `HTTP ${code} should be accepted`);
  }
  const bad = await testIaConnection(keys, async () => ({ status: 403, text: async () => "forbidden" }));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /403/);
});

test("validation: short passphrase, empty keys, and bad username are refused", async () => {
  const store = createMemoryIaAccountStore();
  await assert.rejects(() => linkIaAccount(store, { ...GOOD, passphrase: "short" }), /8/);
  await assert.rejects(() => linkIaAccount(store, { ...GOOD, accessKey: "" }), /access key/i);
  await assert.rejects(() => linkIaAccount(store, { ...GOOD, secretKey: "" }), /secret key/i);
  await assert.rejects(() => linkIaAccount(store, { ...GOOD, username: "  " }), /username/i);
});

test("unlink removes the account and locks it out", async () => {
  const store = createMemoryIaAccountStore();
  await linkIaAccount(store, GOOD);
  await unlockIaAccount(store, GOOD.passphrase);
  await unlinkIaAccount(store);
  assert.deepEqual(await getIaAccountStatus(store), { linked: false });
  await assert.rejects(() => unlockIaAccount(store, GOOD.passphrase), /linked/i);
});

test("per-user keys: testIaConnection with blank keys reports not-ok without any network call", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return { status: 200, text: async () => "" };
  };
  const result = await testIaConnection(
    { username: "alice", accessKey: "", secretKey: "SK" },
    fetchFn,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /link your own/i);
  assert.equal(calls, 0);
});
