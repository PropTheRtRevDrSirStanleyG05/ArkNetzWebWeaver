// Tests: collab merge (per-block LWW + convergence), presence
// (join/leave/30 s expiry), live cursors, and the block diff.
// All network is mocked or absent — nothing here touches real GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import type { BlockNode } from "../src/lib/types.js";
import {
  COLLAB_STATE_VERSION,
  PEER_EXPIRY_MS,
  PEER_PRUNE_AFTER_MS,
  colourForLogin,
  describeConflict,
  parseCollabStateFile,
} from "../src/lib/collab/types.js";
import type { CollabStateFile } from "../src/lib/collab/types.js";
import {
  applyBlockOps,
  diffBlocks,
  mergeSnapshot,
} from "../src/lib/collab/merge.js";
import type { MergeInput } from "../src/lib/collab/merge.js";
import { PresenceRegistry } from "../src/lib/collab/presence.js";
import { describePeerCursors, isValidCursor } from "../src/lib/collab/cursors.js";
import type { BlockOp, BlockVersion } from "../src/lib/collab/types.js";

function block(id: string, text: string, type = "p"): BlockNode {
  return { type: type as BlockNode["type"], text, id };
}

function input(
  blocks: BlockNode[],
  versions?: Record<string, BlockVersion>,
  placement?: Record<string, { updatedAt: number; author: string; blockId: string }>,
): MergeInput {
  const v = new Map<string, BlockVersion>();
  for (const b of blocks) {
    v.set(b.id as string, versions?.[b.id as string] ?? { updatedAt: 0, author: "" });
  }
  return {
    blocks,
    versions: v,
    placement: new Map(Object.entries(placement ?? {})),
    deleted: new Map(),
    lastSynced: new Map(),
  };
}

function stateFile(login: string, blocks: BlockNode[], versions: Record<string, BlockVersion>, heartbeatAt = 1000): CollabStateFile {
  return {
    v: COLLAB_STATE_VERSION,
    session: "computers-edu",
    login,
    colour: colourForLogin(login),
    heartbeatAt,
    cursor: null,
    blocks,
    versions,
  };
}

test("colourForLogin is deterministic and differs across logins", () => {
  assert.equal(colourForLogin("alice"), colourForLogin("Alice"));
  assert.equal(colourForLogin("alice"), colourForLogin("alice"));
  assert.notEqual(colourForLogin("alice"), colourForLogin("bob"));
  assert.match(colourForLogin("alice"), /^#[0-9a-f]{6}$/);
});

test("two peers adding different blocks converge to the same X+Y document", () => {
  const base = [block("b1", "Hello", "h1"), block("b2", "Body")];
  // Peer A adds block X at the end; peer B adds block Y at the end.
  const a = input(base);
  const b = input(base);
  const opX: BlockOp = {
    opId: "alice:1", author: "alice", kind: "upsert", blockId: "bx",
    block: block("bx", "From Alice"), index: 2, updatedAt: 100, baseUpdatedAt: 0,
  };
  const opY: BlockOp = {
    opId: "bob:1", author: "bob", kind: "upsert", blockId: "by",
    block: block("by", "From Bob"), index: 2, updatedAt: 100, baseUpdatedAt: 0,
  };
  const aAfter = applyBlockOps(a, [opX], 200);
  const bAfter = applyBlockOps(b, [opY], 200);
  // Exchange: A applies Bob's op, B applies Alice's op.
  const aFinal = applyBlockOps(
    { blocks: aAfter.blocks, versions: aAfter.versions, placement: aAfter.placement, deleted: aAfter.deleted, lastSynced: new Map() },
    [opY], 300,
  );
  const bFinal = applyBlockOps(
    { blocks: bAfter.blocks, versions: bAfter.versions, placement: bAfter.placement, deleted: bAfter.deleted, lastSynced: new Map() },
    [opX], 300,
  );
  const aIds = aFinal.blocks.map((x) => x.id);
  const bIds = bFinal.blocks.map((x) => x.id);
  assert.deepEqual(aIds, ["b1", "b2", "bx", "by"]);
  assert.deepEqual(bIds, aIds, "both peers converge to the same order — no block lost");
  assert.equal(aFinal.conflicts.length, 0);
});

test("snapshot merge converges the same way (peer A adds X, peer B adds Y)", () => {
  const base = [block("b1", "Hello", "h1")];
  const aState = stateFile("alice", [...base, block("bx", "From Alice")], {
    b1: { updatedAt: 0, author: "" },
    bx: { updatedAt: 100, author: "alice" },
  });
  const bState = stateFile("bob", [...base, block("by", "From Bob")], {
    b1: { updatedAt: 0, author: "" },
    by: { updatedAt: 100, author: "bob" },
  });
  // Alice merges Bob's snapshot; Bob merges Alice's. Each side's own
  // block carries its placement key (as the real editor stamps it),
  // so the concurrent inserts order deterministically.
  const aMerged = mergeSnapshot(
    input(
      [...base, block("bx", "From Alice")],
      { b1: { updatedAt: 0, author: "" }, bx: { updatedAt: 100, author: "alice" } },
      { bx: { updatedAt: 100, author: "alice", blockId: "bx" } },
    ),
    { ...bState, placement: { by: { updatedAt: 100, author: "bob", blockId: "by" } } },
    200,
  );
  const bMerged = mergeSnapshot(
    input(
      [...base, block("by", "From Bob")],
      { b1: { updatedAt: 0, author: "" }, by: { updatedAt: 100, author: "bob" } },
      { by: { updatedAt: 100, author: "bob", blockId: "by" } },
    ),
    { ...aState, placement: { bx: { updatedAt: 100, author: "alice", blockId: "bx" } } },
    200,
  );
  assert.deepEqual(aMerged.blocks.map((x) => x.id), bMerged.blocks.map((x) => x.id));
  assert.deepEqual(aMerged.blocks.map((x) => x.id).sort(), ["b1", "bx", "by"]);
});

test("same-block conflict: newer version wins and the loser is recorded", () => {
  const base = [block("b1", "Hello", "h1"), block("b2", "Body")];
  const local = input(base, { b2: { updatedAt: 200, author: "alice" } });
  local.blocks[1] = block("b2", "Alice's edit");
  local.lastSynced.set("b2", 100);
  const remote = stateFile("bob", [block("b1", "Hello", "h1"), block("b2", "Bob's edit")], {
    b1: { updatedAt: 0, author: "" },
    b2: { updatedAt: 300, author: "bob" },
  });
  const merged = mergeSnapshot(local, remote, 400);
  assert.equal(merged.blocks[1]?.text, "Bob's edit", "newer (Bob, t=300) wins over Alice (t=200)");
  assert.equal(merged.conflicts.length, 1);
  const note = merged.conflicts[0] as NonNullable<(typeof merged.conflicts)[number]>;
  assert.equal(note.blockId, "b2");
  assert.equal(note.keptAuthor, "bob");
  assert.equal(note.lostAuthor, "alice");
  assert.equal(note.lostText, "Alice's edit", "losing text is preserved in the note");
  assert.match(describeConflict(note), /kept bob's newer version over alice's version/);
  assert.match(describeConflict(note), /Alice's edit/);
});

test("same-block conflict the other way: local newer wins, remote loser recorded", () => {
  const base = [block("b2", "Body")];
  const local = input(base, { b2: { updatedAt: 300, author: "alice" } });
  local.blocks[0] = block("b2", "Alice's newer edit");
  local.lastSynced.set("b2", 100);
  const remote = stateFile("bob", [block("b2", "Bob's older edit")], {
    b2: { updatedAt: 200, author: "bob" },
  });
  const merged = mergeSnapshot(local, remote, 400);
  assert.equal(merged.blocks[0]?.text, "Alice's newer edit");
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0]?.lostAuthor, "bob");
  assert.equal(merged.conflicts[0]?.lostText, "Bob's older edit");
});

test("a remote edit that post-dates the last sync but loses to local is still a conflict", () => {
  const local = input([block("b2", "Mine")], { b2: { updatedAt: 500, author: "alice" } });
  local.lastSynced.set("b2", 100);
  const remote = stateFile("bob", [block("b2", "Theirs")], { b2: { updatedAt: 200, author: "bob" } });
  const merged = mergeSnapshot(local, remote, 600);
  assert.equal(merged.blocks[0]?.text, "Mine");
  assert.equal(merged.conflicts.length, 1);
});

test("no conflict when only one side changed since the last sync", () => {
  const local = input([block("b2", "Body")], { b2: { updatedAt: 100, author: "" } });
  local.lastSynced.set("b2", 100);
  const remote = stateFile("bob", [block("b2", "Bob's edit")], { b2: { updatedAt: 200, author: "bob" } });
  const merged = mergeSnapshot(local, remote, 300);
  assert.equal(merged.blocks[0]?.text, "Bob's edit");
  assert.equal(merged.conflicts.length, 0, "local never edited after the sync, so nothing was lost");
});

test("delete tombstones: a real delete removes the block, a slow peer never deletes by absence", () => {
  const base = [block("b1", "Keep"), block("b2", "Delete me")];
  // Bob deletes b2 (tombstone at t=200); Alice's snapshot still has b2
  // but no tombstone — merging Alice's snapshot must NOT delete b2.
  const local = input(base, {
    b1: { updatedAt: 0, author: "" },
    b2: { updatedAt: 0, author: "" },
  });
  const aliceState = stateFile("alice", base, {
    b1: { updatedAt: 0, author: "" },
    b2: { updatedAt: 0, author: "" },
  });
  const stillThere = mergeSnapshot(local, aliceState, 100);
  assert.deepEqual(stillThere.blocks.map((b) => b.id), ["b1", "b2"]);
  const bobState = stateFile("bob", [block("b1", "Keep")], { b1: { updatedAt: 0, author: "" } });
  bobState.deleted = { b2: { updatedAt: 200, author: "bob" } };
  const deleted = mergeSnapshot(local, bobState, 300);
  assert.deepEqual(deleted.blocks.map((b) => b.id), ["b1"]);
  // And a delete that loses to a newer local edit keeps the block.
  const editedLocal = input([block("b1", "Keep"), block("b2", "Edited after delete")], {
    b1: { updatedAt: 0, author: "" },
    b2: { updatedAt: 300, author: "alice" },
  });
  editedLocal.lastSynced.set("b2", 100);
  const kept = mergeSnapshot(editedLocal, bobState, 400);
  assert.deepEqual(kept.blocks.map((b) => b.id), ["b1", "b2"]);
  assert.equal(kept.conflicts.length, 1, "delete-vs-edit is a recorded conflict");
});

test("diffBlocks produces upserts for new/changed blocks and deletes for removed ones", () => {
  const prev = new Map([
    ["b1", { json: JSON.stringify(block("b1", "Hello", "h1")), updatedAt: 0 }],
    ["b2", { json: JSON.stringify(block("b2", "Body")), updatedAt: 0 }],
  ]);
  const next = [block("b1", "Hello", "h1"), block("b2", "Changed"), block("b3", "New")];
  const counter = { n: 0 };
  const ops = diffBlocks(prev, next, "alice", 1000, new Map(), counter);
  assert.equal(ops.length, 2);
  assert.equal(ops.find((o) => o.blockId === "b2")?.kind, "upsert");
  assert.equal(ops.find((o) => o.blockId === "b3")?.kind, "upsert");
  assert.equal(ops.find((o) => o.blockId === "b3")?.index, 2);
  assert.equal(ops.find((o) => o.blockId === "b3")?.baseUpdatedAt, 0);
  const gone = diffBlocks(
    new Map([["b1", { json: JSON.stringify(block("b1", "Hello", "h1")), updatedAt: 0 }]]),
    [],
    "alice",
    1000,
    new Map(),
    counter,
  );
  assert.deepEqual(gone.map((o) => [o.blockId, o.kind]), [["b1", "delete"]]);
  // No change, no ops.
  assert.equal(diffBlocks(prev, [block("b1", "Hello", "h1"), block("b2", "Body")], "alice", 1000, new Map(), counter).length, 0);
});

test("presence: join, heartbeat refresh, leave, 30 s stale marking, and 5-minute prune", () => {
  let now = 1_000_000;
  const reg = new PresenceRegistry(() => now);
  reg.seen({ login: "alice", heartbeatAt: now, cursor: null });
  reg.seen({ login: "bob", heartbeatAt: now, cursor: null });
  assert.equal(reg.size, 2);
  assert.equal(reg.live().length, 2);
  now += PEER_EXPIRY_MS;
  assert.deepEqual(reg.expire(), [], "exactly at the boundary the peer is still live");
  now += 1;
  assert.deepEqual(reg.expire(), ["alice", "bob"]);
  assert.equal(reg.live().length, 0);
  assert.equal(reg.stalePeers().length, 2, "stale peers stay listed, marked stale");
  // A heartbeat from a stale peer revives them.
  reg.seen({ login: "alice", heartbeatAt: now, cursor: null });
  assert.equal(reg.get("alice")?.stale, false);
  assert.equal(reg.live().length, 1);
  assert.equal(reg.leave("alice"), true);
  assert.equal(reg.leave("alice"), false);
  assert.equal(reg.size, 1);
  // D1 correction (fix pass 2): a peer stale for only ~30 s is NOT
  // pruned — it stays listed as "(away)" until the 5-minute window
  // expires. Only then does pruneStale() drop it.
  assert.deepEqual(reg.pruneStale(), [], "a peer stale ~30 s stays listed, marked (away)");
  assert.equal(reg.size, 1);
  now += PEER_PRUNE_AFTER_MS;
  assert.deepEqual(reg.pruneStale(), ["bob"]);
  assert.equal(reg.size, 0);
});

test("cursors: peer marks carry names/colours, exclude self, flag stale peers", () => {
  const peers = [
    { login: "alice", colour: colourForLogin("alice"), lastHeartbeat: 100, cursor: { blockId: "b2", start: 3, end: 3 }, stale: false },
    { login: "bob", colour: colourForLogin("bob"), lastHeartbeat: 100, cursor: { blockId: "b2", start: 0, end: 5 }, stale: true },
    { login: "me", colour: colourForLogin("me"), lastHeartbeat: 100, cursor: { blockId: "b1", start: 0, end: 0 }, stale: false },
    { login: "carol", colour: colourForLogin("carol"), lastHeartbeat: 100, cursor: null, stale: false },
  ];
  const marks = describePeerCursors(peers, "me");
  assert.deepEqual(marks.map((m) => m.login), ["alice", "bob"]);
  assert.equal(marks[0]?.isSelection, false);
  assert.equal(marks[0]?.label, "alice");
  assert.equal(marks[1]?.isSelection, true);
  assert.equal(marks[1]?.label, "bob is selecting");
  assert.equal(marks[1]?.stale, true, "a stale peer's cursor is flagged, never drawn as live");
  assert.equal(marks[0]?.colour, colourForLogin("alice"));
  assert.equal(isValidCursor({ blockId: "b1", start: 2, end: 2 }), true);
  assert.equal(isValidCursor({ blockId: null, start: 0, end: 0 }), true);
  assert.equal(isValidCursor({ blockId: "b1", start: 5, end: 2 }), false);
  assert.equal(isValidCursor({ blockId: "b1", start: -1, end: 0 }), false);
  assert.equal(isValidCursor("nope"), false);
});

test("parseCollabStateFile rejects bad versions, missing versions, and blocks without ids", () => {
  const good = stateFile("alice", [block("b1", "Hi", "h1")], { b1: { updatedAt: 0, author: "" } });
  assert.equal(parseCollabStateFile(good).login, "alice");
  assert.throws(() => parseCollabStateFile({ ...good, v: 99 }), /unsupported version/);
  assert.throws(() => parseCollabStateFile({ ...good, blocks: [{ type: "p", text: "no id" }] }), /without an id/);
  assert.throws(
    () => parseCollabStateFile({ ...good, versions: {} }),
    /no version for block/,
  );
});
