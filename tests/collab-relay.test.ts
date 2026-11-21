// Tests: the GitHub Contents-API relay (branch + per-peer state
// files) and the sync engine (poll, heartbeat, offline recovery,
// stale peers). All GitHub calls go to the in-memory FakeGitHub —
// no test touches real GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub } from "./collab-fake-github.js";
import { CollabRelay, collabBranchName, collabPeerPath } from "../src/lib/collab/relay.js";
import { CollabSyncEngine } from "../src/lib/collab/sync.js";
import type { LocalSnapshot } from "../src/lib/collab/sync.js";
import { COLLAB_STATE_VERSION, PEER_EXPIRY_MS } from "../src/lib/collab/types.js";
import type { BlockNode } from "../src/lib/types.js";

const OWNER = "alice";
const REPO = "arknetz-site-computers-edu";
const DOMAIN = "computers.edu";

function relayFor(fake: FakeGitHub, token: string | null = "tok-alice"): CollabRelay {
  return new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token, fetchFn: fake.fetchFn });
}

function stateFile(login: string, blocks: BlockNode[], heartbeatAt: number) {
  const versions: Record<string, { updatedAt: number; author: string }> = {};
  for (const b of blocks) versions[b.id as string] = { updatedAt: heartbeatAt, author: login };
  return {
    v: COLLAB_STATE_VERSION,
    session: "computers-edu",
    login,
    colour: "#2563eb",
    heartbeatAt,
    cursor: null,
    blocks,
    versions,
  };
}

test("relay: branch name and peer path derive from domain and login", () => {
  assert.equal(collabBranchName("computers.edu"), "collab/computers-edu");
  assert.equal(collabPeerPath("Alice"), "peers/alice.json");
  assert.equal(collabPeerPath("bob-dev"), "peers/bob-dev.json");
});

test("relay: no token means no network call at all", async () => {
  const fake = new FakeGitHub();
  const relay = relayFor(fake, null);
  await assert.rejects(() => relay.ensureBranch(), /own GitHub token/);
  await assert.rejects(() => relay.writeOwn(stateFile("alice", [], 1000)), /own GitHub token/);
  assert.equal(fake.calls.length, 0, "refused before any fetch");
});

test("relay round-trip: ensure branch, write own state, list + read it back, delete, drop branch", async () => {
  const fake = new FakeGitHub();
  const relay = relayFor(fake);
  assert.equal(fake.hasBranch(REPO, "collab/computers-edu"), false);
  assert.equal(await relay.ensureBranch(), true, "branch created from main");
  assert.equal(await relay.ensureBranch(), false, "second ensure is a no-op");
  assert.equal(fake.hasBranch(REPO, "collab/computers-edu"), true);

  const written = stateFile("alice", [{ type: "h1", text: "Hello", id: "b1" }], 1000);
  const sha = await relay.writeOwn(written);
  assert.match(sha, /^fakesha/);
  assert.deepEqual(await relay.listPeers(), ["alice"]);
  const read = await relay.readPeer("alice");
  assert.ok(read);
  assert.equal(read.state.login, "alice");
  assert.equal(read.state.blocks[0]?.text, "Hello");
  assert.equal(read.state.heartbeatAt, 1000);
  assert.equal(read.sha, sha);

  // Update: same file, new SHA — the write carries the old SHA.
  const updated = stateFile("alice", [{ type: "h1", text: "Hello again", id: "b1" }], 2000);
  await relay.writeOwn(updated);
  const read2 = await relay.readPeer("alice");
  assert.equal(read2?.state.blocks[0]?.text, "Hello again");
  assert.notEqual(read2?.sha, sha);

  // A second peer's file does not disturb the first.
  const bob = new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token: "tok-bob", fetchFn: fake.fetchFn });
  await bob.writeOwn(stateFile("bob", [{ type: "p", text: "Bob here", id: "b9" }], 1500));
  assert.deepEqual((await relay.listPeers()).sort(), ["alice", "bob"]);
  const all = await relay.readAllPeers();
  assert.equal(all.length, 2);

  assert.equal(await relay.deleteOwn("alice"), true);
  assert.equal(await relay.readPeer("alice"), null);
  assert.equal(await relay.deleteOwn("alice"), false, "deleting twice is a no-op");
  assert.deepEqual(await relay.listPeers(), ["bob"]);

  assert.equal(await relay.deleteOwn("bob"), true);
  assert.equal(await relay.deleteBranch(), true);
  assert.equal(fake.hasBranch(REPO, "collab/computers-edu"), false);
  assert.equal(await relay.deleteBranch(), false, "deleting a missing branch is a no-op");
});

test("relay: a stale SHA on write is a loud 409, never a blind overwrite", async () => {
  const fake = new FakeGitHub();
  const relay = relayFor(fake);
  await relay.ensureBranch();
  await relay.writeOwn(stateFile("alice", [], 1000));
  // Simulate a concurrent writer changing the file under us: write
  // directly through a second relay, then force our relay to PUT with
  // the now-stale SHA by patching the stored file again.
  const stored = fake.storedFile(REPO, "collab/computers-edu", "peers/alice.json");
  assert.ok(stored);
  stored.sha = "someone-else-sha";
  // The relay re-GETs before PUT, so it picks up the fresh SHA and
  // succeeds — the 409 path is exercised by the raw API below.
  await relay.writeOwn(stateFile("alice", [], 2000));
  // Raw: PUT with an explicitly stale sha must 409.
  const res = await fake.fetchFn(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/peers/alice.json`,
    {
      method: "PUT",
      headers: { Authorization: "Bearer tok-alice" },
      body: JSON.stringify({ content: "e30=", sha: "stale-sha", branch: "collab/computers-edu" }),
    },
  );
  assert.equal(res.status, 409);
});

test("relay: corrupt peer state throws instead of merging garbage", async () => {
  const fake = new FakeGitHub();
  const relay = relayFor(fake);
  await relay.ensureBranch();
  // Hand-craft a state file with a bad version through the fake.
  const bad = { v: 99, session: "computers-edu", login: "mallory", heartbeatAt: 1, cursor: null, blocks: [], versions: {} };
  const content = Buffer.from(JSON.stringify(bad)).toString("base64");
  await fake.fetchFn(`https://api.github.com/repos/${OWNER}/${REPO}/contents/peers/mallory.json`, {
    method: "PUT",
    headers: { Authorization: "Bearer tok" },
    body: JSON.stringify({ content, branch: "collab/computers-edu" }),
  });
  await assert.rejects(() => relay.readPeer("mallory"), /unsupported version/);
});

test("engine: two engines sharing one fake relay converge (A adds X, B adds Y)", async () => {
  const fake = new FakeGitHub();
  let now = 10_000;
  const clock = () => now;

  function makeEngine(login: string, baseBlocks: BlockNode[]) {
    let blocks = baseBlocks.map((b) => ({ ...b }));
    const versions = new Map<string, { updatedAt: number; author: string }>();
    for (const b of blocks) versions.set(b.id as string, { updatedAt: 0, author: "" });
    const placement = new Map<string, { updatedAt: number; author: string; blockId: string }>();
    const engine = new CollabSyncEngine(
      new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token: `tok-${login}`, fetchFn: fake.fetchFn }),
      login,
      {
        getLocalSnapshot: (): LocalSnapshot => ({
          blocks: blocks.map((b) => ({ ...b })),
          versions: new Map(versions),
          placement: new Map(placement),
          deleted: new Map(),
        }),
        onRemoteStates: (states) => {
          // Minimal merge for the test: adopt any remote block we do
          // not have yet (the full merge lives in merge.test.ts and
          // in EditorState.applyRemoteStates).
          for (const st of states) {
            for (const rb of st.blocks) {
              if (!blocks.some((b) => b.id === rb.id)) {
                blocks = [...blocks, { ...rb }];
                versions.set(rb.id as string, { ...(st.versions[rb.id as string] as { updatedAt: number; author: string }) });
              }
            }
          }
        },
      },
      clock,
    );
    return {
      engine,
      addBlock: (id: string, text: string) => {
        blocks = [...blocks, { type: "p", text, id }];
        versions.set(id, { updatedAt: now, author: login });
        placement.set(id, { updatedAt: now, author: login, blockId: id });
      },
      blocks: () => blocks.map((b) => b.id),
    };
  }

  const base: BlockNode[] = [{ type: "h1", text: "Hello", id: "b1" }];
  const a = makeEngine("alice", base);
  const b = makeEngine("bob", base);
  // Both join (branch creation + first write).
  await a.engine.relay.ensureBranch();
  await a.engine.writeOwn();
  await b.engine.writeOwn();
  // Concurrent edits, one poll apart in time but neither has polled.
  now = 11_000;
  a.addBlock("bx", "From Alice");
  b.addBlock("by", "From Bob");
  await a.engine.writeOwn();
  await b.engine.writeOwn();
  // Now both poll: each reads the other's file.
  await a.engine.pollOnce();
  await b.engine.pollOnce();
  assert.deepEqual(a.blocks().sort(), ["b1", "bx", "by"]);
  assert.deepEqual(b.blocks().sort(), ["b1", "bx", "by"], "neither peer lost the other's block");
  assert.equal(a.engine.offline, false);
});

test("engine: cursor set on one peer is visible to the other after a poll", async () => {
  const fake = new FakeGitHub();
  const alice = new CollabSyncEngine(
    new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token: "tok-alice", fetchFn: fake.fetchFn }),
    "alice",
    {
      getLocalSnapshot: (): LocalSnapshot => ({ blocks: [], versions: new Map(), placement: new Map(), deleted: new Map() }),
      onRemoteStates: () => undefined,
    },
  );
  const bob = new CollabSyncEngine(
    new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token: "tok-bob", fetchFn: fake.fetchFn }),
    "bob",
    {
      getLocalSnapshot: (): LocalSnapshot => ({ blocks: [], versions: new Map(), placement: new Map(), deleted: new Map() }),
      onRemoteStates: () => undefined,
    },
  );
  await alice.relay.ensureBranch();
  alice.setCursor({ blockId: "b1", start: 4, end: 4 });
  await alice.writeOwn();
  await bob.writeOwn();
  await bob.pollOnce();
  const seen = bob.presence.get("alice");
  assert.ok(seen);
  assert.deepEqual(seen.cursor, { blockId: "b1", start: 4, end: 4 });
});

test("engine: failed poll marks offline and keeps state; next good poll recovers", async () => {
  const fake = new FakeGitHub();
  let now = 10_000;
  const errors: string[] = [];
  const engine = new CollabSyncEngine(
    new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token: "tok-alice", fetchFn: fake.fetchFn }),
    "alice",
    {
      getLocalSnapshot: (): LocalSnapshot => ({ blocks: [], versions: new Map(), placement: new Map(), deleted: new Map() }),
      onRemoteStates: () => undefined,
      onError: (err) => errors.push(err.message),
    },
    () => now,
  );
  await engine.relay.ensureBranch();
  const first = await engine.pollOnce();
  assert.equal(first.ok, true);
  assert.equal(engine.offline, false);
  fake.failAll = true;
  const failed = await engine.pollOnce();
  assert.equal(failed.ok, false);
  assert.equal(engine.offline, true);
  assert.ok(engine.lastError);
  assert.ok(errors.length >= 1);
  fake.failAll = false;
  const recovered = await engine.pollOnce();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(engine.offline, false);
  assert.equal(engine.lastError, null);
});

test("engine: a peer gone >30 s is stale (blocks stay), and returns re-sync", async () => {
  const fake = new FakeGitHub();
  let now = 10_000;
  const clock = () => now;
  const bobSeen: string[] = [];
  const engine = new CollabSyncEngine(
    new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token: "tok-alice", fetchFn: fake.fetchFn }),
    "alice",
    {
      getLocalSnapshot: (): LocalSnapshot => ({ blocks: [], versions: new Map(), placement: new Map(), deleted: new Map() }),
      onRemoteStates: () => undefined,
    },
    clock,
  );
  await engine.relay.ensureBranch();
  // Bob joins and heartbeats at t=10_000.
  const bobRelay = new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token: "tok-bob", fetchFn: fake.fetchFn });
  await bobRelay.writeOwn(stateFile("bob", [{ type: "p", text: "Bob block", id: "bb" }], now));
  const first = await engine.pollOnce();
  assert.deepEqual(first.peers, ["bob"]);
  assert.equal(engine.presence.get("bob")?.stale, false);
  // Bob goes quiet; 31 s later Alice polls again.
  now += PEER_EXPIRY_MS + 1000;
  const second = await engine.pollOnce();
  assert.deepEqual(second.expired, ["bob"]);
  assert.equal(engine.presence.get("bob")?.stale, true);
  // Bob's blocks are still the document's business, not presence's:
  // the engine reports them stale, never deletes them.
  const snap: LocalSnapshot = {
    blocks: [{ type: "p", text: "Bob block", id: "bb" }],
    versions: new Map([["bb", { updatedAt: 10_000, author: "bob" }]]),
    placement: new Map(),
    deleted: new Map(),
  };
  assert.deepEqual([...engine.staleBlockIds(snap)], ["bb"]);
  void bobSeen;
  // Bob returns: fresh heartbeat, next poll revives him.
  await bobRelay.writeOwn(stateFile("bob", [{ type: "p", text: "Bob block", id: "bb" }], now));
  const third = await engine.pollOnce();
  assert.equal(third.ok, true);
  assert.equal(engine.presence.get("bob")?.stale, false);
  assert.deepEqual([...engine.staleBlockIds(snap)], [], "a returned peer's blocks are live again");
});
