// Tests: EditorState collab wiring (start/stop, local broadcast,
// remote apply without echo, conflict notes) and the Publish
// SHA-mismatch regression. All GitHub calls go to the in-memory
// FakeGitHub — no test touches real GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { PEER_PRUNE_AFTER_MS } from "../src/lib/collab/types.js";
import { EditorState } from "../src/lib/editor.js";
import { FakeGitHub } from "./collab-fake-github.js";
import { publishSite } from "../src/lib/publish.js";
import type { GithubFetchFn } from "../src/lib/publish.js";
import { OWNER_ROLE } from "../src/lib/roles.js";
import type { SiteDocument } from "../src/lib/types.js";

const OWNER = "alice";
const REPO = "arknetz-site-computers-edu";

function freshDoc(): SiteDocument {
  return {
    domain: "computers.edu",
    title: "Computers",
    blocks: [
      { type: "h1", text: "Hello", id: "b1" },
      { type: "p", text: "Body", id: "b2" },
    ],
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

async function joinEditor(
  fake: FakeGitHub,
  login: string,
  token: string,
  now: () => number,
): Promise<EditorState> {
  const ed = new EditorState(freshDoc());
  await ed.startCollab({
    token,
    owner: OWNER,
    repo: REPO,
    login,
    fetchFn: fake.fetchFn,
    now,
    autoPoll: false,
  });
  return ed;
}

test("startCollab refuses without a token and makes no network calls", async () => {
  const fake = new FakeGitHub();
  const ed = new EditorState(freshDoc());
  await assert.rejects(
    () =>
      ed.startCollab({ token: null, owner: OWNER, repo: REPO, login: "alice", fetchFn: fake.fetchFn, autoPoll: false }),
    /own GitHub token/,
  );
  assert.equal(fake.calls.length, 0);
  assert.equal(ed.collabSession, null);
});

test("two editors converge: A adds X, B adds Y, both end with X+Y in the same order", async () => {
  const fake = new FakeGitHub();
  let now = 1000;
  const clock = () => now;
  const a = await joinEditor(fake, "alice", "tok-alice", clock);
  const b = await joinEditor(fake, "bob", "tok-bob", clock);
  assert.ok(a.collabSession?.joined);
  assert.ok(b.collabSession?.joined);

  a.insertBlock("p", 2, { text: "From Alice" });
  b.insertBlock("p", 2, { text: "From Bob" });
  await flush();
  // Each poll reads the other's state file and merges it.
  await a.collabSession?.pollOnce();
  await b.collabSession?.pollOnce();
  const aTexts = a.blocks.map((x) => x.text);
  const bTexts = b.blocks.map((x) => x.text);
  assert.deepEqual(aTexts, ["Hello", "Body", "From Alice", "From Bob"]);
  assert.deepEqual(bTexts, aTexts, "both editors converge — neither block lost");
  assert.equal(a.collabConflicts.length, 0);
  assert.equal(b.collabConflicts.length, 0);
  assert.equal(a.collabOffline, false);
  await a.stopCollab();
  await b.stopCollab();
});

test("a local edit is broadcast; applying a remote op never re-broadcasts it", async () => {
  const fake = new FakeGitHub();
  let now = 1000;
  const ed = await joinEditor(fake, "alice", "tok-alice", () => now);
  const putsBefore = fake.putCalls().length;
  assert.ok(putsBefore >= 1, "join wrote my state file");
  now = 2000;
  ed.insertBlock("p", 2, { text: "Local edit" });
  await flush();
  const putsAfterLocal = fake.putCalls().length;
  assert.ok(putsAfterLocal > putsBefore, "local edit triggered a relay write");
  // A remote op from Bob arrives (direct apply, as the poll path does).
  const applied = ed.applyRemoteBlockOps([
    {
      opId: "bob:1", author: "bob", kind: "upsert", blockId: "bx",
      block: { type: "p", text: "Remote edit", id: "bx" },
      index: 3, updatedAt: 3000, baseUpdatedAt: 0,
    },
  ]);
  assert.equal(applied.changed, true);
  assert.deepEqual(ed.blocks.map((b) => b.id), ["b1", "b2", ed.blocks[2]?.id, "bx"]);
  await flush();
  assert.equal(fake.putCalls().length, putsAfterLocal, "applying a remote op must not broadcast it back");
  await ed.stopCollab();
});

test("same-block conflict through the editor: newer wins, loser is recorded and visible", async () => {
  const fake = new FakeGitHub();
  let nowA = 1000;
  let nowB = 1000;
  const a = await joinEditor(fake, "alice", "tok-alice", () => nowA);
  const b = await joinEditor(fake, "bob", "tok-bob", () => nowB);
  nowA = 2000;
  a.updateBlock("b2", { text: "Alice's edit" });
  nowB = 1500;
  b.updateBlock("b2", { text: "Bob's edit" });
  await flush();
  await a.collabSession?.pollOnce();
  assert.equal(a.blocks.find((x) => x.id === "b2")?.text, "Alice's edit", "newer local version wins");
  assert.equal(a.collabConflicts.length, 1);
  const note = a.collabConflicts[0] as NonNullable<(typeof a.collabConflicts)[number]>;
  assert.equal(note.blockId, "b2");
  assert.equal(note.keptAuthor, "alice");
  assert.equal(note.lostAuthor, "bob");
  assert.equal(note.lostText, "Bob's edit");
  await a.stopCollab();
  await b.stopCollab();
});

test("cursor sharing: one editor's cursor reaches the other via presence", async () => {
  const fake = new FakeGitHub();
  const a = await joinEditor(fake, "alice", "tok-alice", () => 1000);
  const b = await joinEditor(fake, "bob", "tok-bob", () => 1000);
  a.setLocalCursor({ blockId: "b2", start: 2, end: 2 });
  await flush();
  await b.collabSession?.pollOnce();
  const alice = b.collabPeers.find((p) => p.login === "alice");
  assert.ok(alice, "bob sees alice in presence");
  assert.deepEqual(alice.cursor, { blockId: "b2", start: 2, end: 2 });
  await a.stopCollab();
  await b.stopCollab();
});

test("stopCollab is a graceful leave: own file deleted, branch dropped when last out", async () => {
  const fake = new FakeGitHub();
  const a = await joinEditor(fake, "alice", "tok-alice", () => 1000);
  const b = await joinEditor(fake, "bob", "tok-bob", () => 1000);
  const first = await a.stopCollab();
  assert.equal(first.branchDeleted, false, "bob is still in the session");
  assert.equal(fake.storedFile(REPO, "collab/computers-edu", "peers/alice.json"), undefined);
  assert.ok(fake.storedFile(REPO, "collab/computers-edu", "peers/bob.json"));
  const second = await b.stopCollab();
  assert.equal(second.branchDeleted, true, "last peer out deletes the branch");
  assert.equal(fake.hasBranch(REPO, "collab/computers-edu"), false);
});

test("REGRESSION: Publish still refuses on a SHA mismatch (HTTP 409)", async () => {
  const fake = new FakeGitHub();
  // The repo's site.json.zst exists (sha sitesha1); the PUT is
  // answered 409, exactly what GitHub returns when the SHA the client
  // read is no longer current — someone else published first.
  const mismatchFetch: GithubFetchFn = async (url, init) => {
    if (init.method === "PUT") {
      // Record the refused PUT (it never reaches the fake's store —
      // GitHub refused it first) so the test can verify the SHA the
      // client attempted the write with.
      fake.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return { status: 409, json: async () => ({ message: "sha mismatch" }), text: async () => "sha mismatch" };
    }
    return fake.fetchFn(url, init);
  };
  const doc: SiteDocument = freshDoc();
  const result = await publishSite({
    doc,
    role: OWNER_ROLE,
    token: "tok",
    owner: OWNER,
    repo: REPO,
    fetchFn: mismatchFetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /HTTP 409/);
  assert.match(result.ok ? "" : result.reason, /site\.json\.zst/);
  // And the PUT that was refused really did carry the SHA it read —
  // the collision protection was attempted, not skipped.
  const put = fake.calls.find((c) => c.method === "PUT");
  assert.ok(put);
  const body = JSON.parse(put.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.sha, "sitesha1");
});

// ---------------------------------------------------------------------------
// D2 (fix pass 1): the collab join addresses the SITE OWNER's repo.
// ---------------------------------------------------------------------------

/** Wrap a fake's fetch so the test can assert WHICH owner's repo the
 *  relay addressed — the FakeGitHub itself ignores the owner segment,
 *  which is exactly the hole D2 fell through. */
function ownerRecordingFetch(fake: FakeGitHub): {
  fetchFn: GithubFetchFn;
  ownersSeen: string[];
} {
  const ownersSeen: string[] = [];
  const fetchFn: GithubFetchFn = async (url, init) => {
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\//.exec(url);
    if (m) ownersSeen.push(m[1] as string);
    return fake.fetchFn(url, init);
  };
  return { fetchFn, ownersSeen };
}

async function joinWithFetch(
  fetchFn: GithubFetchFn,
  login: string,
  opts?: {
    owner?: string;
    siteOwner?: string | null;
    domain?: string;
    now?: () => number;
  },
): Promise<EditorState> {
  const domain = opts?.domain ?? "computers.edu";
  const ed = new EditorState({
    domain,
    title: domain,
    blocks: [
      { type: "h1", text: "Hello", id: "b1" },
      { type: "p", text: "Body", id: "b2" },
    ],
  });
  await ed.startCollab({
    token: `tok-${login}`,
    owner: opts?.owner ?? OWNER,
    siteOwner: opts?.siteOwner,
    login,
    fetchFn,
    now: opts?.now,
    autoPoll: false,
  });
  return ed;
}

test("D2: a collaborator who does not own the site joins the OWNER's repo, not their own", async () => {
  const fake = new FakeGitHub();
  const { fetchFn, ownersSeen } = ownerRecordingFetch(fake);
  // Bob joins alice's site: the joiner is bob, the site owner is alice.
  const bob = await joinWithFetch(fetchFn, "bob", { owner: "bob", siteOwner: "alice" });
  try {
    assert.ok(bob.collabSession?.joined, "bob joined");
    assert.equal(bob.collabSiteOwner, "alice");
    assert.ok(ownersSeen.length > 0, "the relay made GitHub calls");
    assert.ok(
      ownersSeen.every((o) => o === "alice"),
      `every relay call must address alice's repo, saw owners: ${[...new Set(ownersSeen)].join(", ")}`,
    );
  } finally {
    await bob.stopCollab();
  }
});

test("D2: an owner-less document falls back to the signed-in user", async () => {
  const fake = new FakeGitHub();
  const { fetchFn, ownersSeen } = ownerRecordingFetch(fake);
  const bob = await joinWithFetch(fetchFn, "bob", { owner: "bob" });
  try {
    assert.ok(bob.collabSession?.joined);
    assert.equal(bob.collabSiteOwner, "bob");
    assert.ok(ownersSeen.every((o) => o === "bob"));
  } finally {
    await bob.stopCollab();
  }
  // A blank siteOwner is the same as absent.
  const { fetchFn: fetchFn2, ownersSeen: ownersSeen2 } = ownerRecordingFetch(new FakeGitHub());
  const bob2 = await joinWithFetch(fetchFn2, "bob", { owner: "bob", siteOwner: "   " });
  try {
    assert.equal(bob2.collabSiteOwner, "bob");
    assert.ok(ownersSeen2.every((o) => o === "bob"));
  } finally {
    await bob2.stopCollab();
  }
});

test("D2: joining a repo that genuinely does not exist names the owner/repo it tried", async () => {
  const fake = new FakeGitHub();
  const { fetchFn, ownersSeen } = ownerRecordingFetch(fake);
  const ed = new EditorState({
    domain: "other.edu",
    title: "Other",
    blocks: [{ type: "h1", text: "Hello", id: "b1" }],
  });
  await assert.rejects(
    () =>
      ed.startCollab({
        token: "tok-bob",
        owner: "bob",
        siteOwner: "alice",
        login: "bob",
        fetchFn,
        autoPoll: false,
      }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /alice\/arknetz-site-other-edu/, "names the owner/repo it tried");
      assert.match(message, /may not exist yet; Publish it once first/);
      return true;
    },
  );
  assert.equal(ed.collabSession, null, "no fake session after a refused join");
  assert.ok(ownersSeen.includes("alice"));
});

// ---------------------------------------------------------------------------
// D1 (fix pass 1): a gracefully-left peer leaves other peers' lists.
// ---------------------------------------------------------------------------

test("D1: B leaves (file deleted) + A polls → bob gone from A.collabPeers, not merely stale", async () => {
  const fake = new FakeGitHub();
  const alice = await joinEditor(fake, "alice", "tok-alice", () => 1000);
  const bob = await joinEditor(fake, "bob", "tok-bob", () => 1000);
  try {
    await alice.collabSession?.pollOnce();
    assert.ok(
      alice.collabPeers.some((p) => p.login === "bob"),
      "bob is present before leaving",
    );
    await bob.stopCollab();
    await alice.collabSession?.pollOnce();
    assert.ok(
      !alice.collabPeers.some((p) => p.login === "bob"),
      "bob is gone from A.collabPeers after leaving",
    );
    assert.ok(alice.collabPeers.some((p) => p.login === "alice"), "alice still lists herself");
  } finally {
    if (alice.collabSession) await alice.stopCollab();
    if (bob.collabSession) await bob.stopCollab();
  }
});

test("D1 (corrected, fix pass 2): a peer silent 31 s stays in collabPeers as stale (away), and is pruned only after 5 minutes of silence", async () => {
  const fake = new FakeGitHub();
  let now = 10_000;
  const clock = () => now;
  const alice = await joinEditor(fake, "alice", "tok-alice", clock);
  const bob = await joinEditor(fake, "bob", "tok-bob", clock);
  try {
    await alice.collabSession?.pollOnce();
    assert.ok(alice.collabPeers.some((p) => p.login === "bob"));
    // Bob's tab crashes: no leave, no heartbeat — 31 s of silence.
    now += 31_000;
    await alice.collabSession?.pollOnce();
    const bobPeer = alice.collabPeers.find((p) => p.login === "bob");
    assert.ok(bobPeer, "a peer silent 31 s stays listed, marked stale (away)");
    assert.equal(bobPeer?.stale, true);
    assert.equal(alice.collabPeers.length, 2, "alice + stale bob remain");
    // 5 more minutes of silence: now the prune fires.
    now += PEER_PRUNE_AFTER_MS;
    await alice.collabSession?.pollOnce();
    assert.ok(
      !alice.collabPeers.some((p) => p.login === "bob"),
      "silent peer is pruned after 5 minutes of silence",
    );
    assert.equal(alice.collabPeers.length, 1, "only alice remains");
    // Bob returns: a fresh heartbeat revives him on the next poll.
    await bob.collabSession?.pollOnce();
    await alice.collabSession?.pollOnce();
    const back = alice.collabPeers.find((p) => p.login === "bob");
    assert.ok(back, "a returning peer re-syncs and reappears");
    assert.equal(back?.stale, false);
  } finally {
    if (alice.collabSession) await alice.stopCollab();
    if (bob.collabSession) await bob.stopCollab();
  }
});
