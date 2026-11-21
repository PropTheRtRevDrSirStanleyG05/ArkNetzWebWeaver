// ArkNetzWebWeaver — collab merge: per-block last-write-wins.
// The merge unit is a whole block. There is no character-level OT:
// two peers editing different blocks never interfere; two peers
// editing the SAME block resolve by (updatedAt, author) — the newer
// version wins, the losing version is recorded in a ConflictNote,
// never silently dropped. Ordering of concurrent inserts at the same
// index is deterministic (placement keys), so two peers that exchange
// the same snapshots converge to the same block order. Deletes are
// tombstones: absence from a peer's block list is never a delete on
// its own, or a slow peer would delete blocks it had not received yet.

import type { BlockNode } from "../types.js";
import type {
  BlockOp,
  BlockVersion,
  CollabStateFile,
  ConflictNote,
} from "./types.js";

export type PlacementKey = { updatedAt: number; author: string; blockId: string };

export interface MergeInput {
  blocks: BlockNode[];
  versions: Map<string, BlockVersion>;
  placement: Map<string, PlacementKey>;
  deleted: Map<string, BlockVersion>;
  /** blockId -> updatedAt at the last sync that both sides shared.
   *  A conflict is recorded only when BOTH sides changed the block
   *  after this version. Absent = never synced (0). */
  lastSynced: Map<string, number>;
}

export interface MergeResult {
  blocks: BlockNode[];
  versions: Map<string, BlockVersion>;
  placement: Map<string, PlacementKey>;
  deleted: Map<string, BlockVersion>;
  conflicts: ConflictNote[];
  /** True when anything in the document changed. */
  changed: boolean;
}

/** Total order on versions: later timestamp wins; ties break on the
 *  author login, so every peer picks the same winner. */
export function compareVersions(a: BlockVersion, b: BlockVersion): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  return 0;
}

export function comparePlacementKeys(a: PlacementKey, b: PlacementKey): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  if (a.author !== b.author) return a.author < b.author ? -1 : 1;
  if (a.blockId !== b.blockId) return a.blockId < b.blockId ? -1 : 1;
  return 0;
}

export function cloneBlock(block: BlockNode): BlockNode {
  return JSON.parse(JSON.stringify(block)) as BlockNode;
}

function blockText(block: BlockNode | undefined): string | null {
  if (!block) return null;
  const text = block.text ?? block.title ?? block.subtitle ?? null;
  return text === null || text === "" ? null : text;
}

function sameBlock(a: BlockNode, b: BlockNode): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Insert `block` into `blocks` at the position the deterministic rule
 * picks for `key` at desired `index`: the block goes into the
 * contiguous run of placed (non-anchor) blocks around `index`, at the
 * spot that keeps that run sorted by placement key. Pre-session
 * anchor blocks (no placement key) bound the run and never move.
 * Every peer applies the same rule, so concurrent inserts at the same
 * index converge to the same order on all peers.
 */
export function insertPlaced(
  blocks: BlockNode[],
  placement: Map<string, PlacementKey>,
  block: BlockNode,
  key: PlacementKey,
  index: number,
): void {
  const at = Math.max(0, Math.min(index, blocks.length));
  let start = at;
  while (start > 0) {
    const prev = blocks[start - 1];
    if (!prev?.id || !placement.has(prev.id)) break;
    start -= 1;
  }
  let end = at;
  while (end < blocks.length) {
    const cur = blocks[end];
    if (!cur?.id || !placement.has(cur.id)) break;
    end += 1;
  }
  let pos = end;
  for (let p = start; p < end; p += 1) {
    const cur = blocks[p];
    const curKey = cur?.id ? placement.get(cur.id) : undefined;
    if (curKey && comparePlacementKeys(curKey, key) > 0) {
      pos = p;
      break;
    }
  }
  blocks.splice(pos, 0, block);
}

interface MutableState {
  blocks: BlockNode[];
  versions: Map<string, BlockVersion>;
  placement: Map<string, PlacementKey>;
  deleted: Map<string, BlockVersion>;
  lastSynced: Map<string, number>;
  conflicts: ConflictNote[];
  changed: boolean;
  now: number;
}

function upsertRemoteBlock(
  st: MutableState,
  block: BlockNode,
  version: BlockVersion,
  key: PlacementKey | undefined,
  index: number,
): void {
  const id = block.id as string;
  const localIdx = st.blocks.findIndex((b) => b.id === id);
  const localVersion = st.versions.get(id);
  const syncedAt = st.lastSynced.get(id) ?? 0;
  if (localIdx < 0) {
    // A delete tombstone newer than this upsert wins over the upsert.
    const tomb = st.deleted.get(id);
    if (tomb && compareVersions(tomb, version) > 0) return;
    st.deleted.delete(id);
    const copy = cloneBlock(block);
    insertPlaced(st.blocks, st.placement, copy, key ?? { updatedAt: version.updatedAt, author: version.author, blockId: id }, index);
    st.versions.set(id, { ...version });
    if (key) st.placement.set(id, { ...key });
    st.changed = true;
    return;
  }
  if (!localVersion) {
    st.blocks[localIdx] = cloneBlock(block);
    st.versions.set(id, { ...version });
    st.changed = true;
    return;
  }
  const localBlock = st.blocks[localIdx] as BlockNode;
  if (sameBlock(localBlock, block)) {
    // Same content: adopt the newer version stamp so the next sync
    // does not re-report this as a change.
    if (compareVersions(version, localVersion) > 0) st.versions.set(id, { ...version });
    return;
  }
  const cmp = compareVersions(version, localVersion);
  const bothChangedSinceSync =
    version.updatedAt > syncedAt && localVersion.updatedAt > syncedAt;
  if (cmp > 0) {
    // Remote is newer: it wins. If the local side also changed since
    // the last shared version, the local version is a recorded loser.
    if (bothChangedSinceSync) {
      st.conflicts.push({
        blockId: id,
        keptAuthor: version.author,
        keptUpdatedAt: version.updatedAt,
        lostAuthor: localVersion.author,
        lostUpdatedAt: localVersion.updatedAt,
        lostText: blockText(localBlock),
        at: st.now,
      });
    }
    st.blocks[localIdx] = cloneBlock(block);
    st.versions.set(id, { ...version });
    st.changed = true;
  } else {
    // Local is newer (or a tie the local author wins): keep local.
    // A remote edit that also post-dates the last sync is still a
    // conflict — the remote version lost and is recorded.
    if (bothChangedSinceSync) {
      st.conflicts.push({
        blockId: id,
        keptAuthor: localVersion.author,
        keptUpdatedAt: localVersion.updatedAt,
        lostAuthor: version.author,
        lostUpdatedAt: version.updatedAt,
        lostText: blockText(block),
        at: st.now,
      });
    }
  }
}

function applyRemoteDelete(
  st: MutableState,
  blockId: string,
  tomb: BlockVersion,
): void {
  const localIdx = st.blocks.findIndex((b) => b.id === blockId);
  const localVersion = st.versions.get(blockId);
  const syncedAt = st.lastSynced.get(blockId) ?? 0;
  const existing = st.deleted.get(blockId);
  if (existing && compareVersions(existing, tomb) >= 0) return;
  if (localIdx < 0) {
    st.deleted.set(blockId, { ...tomb });
    return;
  }
  if (!localVersion) {
    st.blocks.splice(localIdx, 1);
    st.placement.delete(blockId);
    st.versions.delete(blockId);
    st.deleted.set(blockId, { ...tomb });
    st.changed = true;
    return;
  }
  if (compareVersions(tomb, localVersion) > 0) {
    // The delete is newer: the block goes, but an edit the local side
    // made after the last sync is recorded as the loser.
    if (localVersion.updatedAt > syncedAt) {
      st.conflicts.push({
        blockId,
        keptAuthor: tomb.author,
        keptUpdatedAt: tomb.updatedAt,
        lostAuthor: localVersion.author,
        lostUpdatedAt: localVersion.updatedAt,
        lostText: blockText(st.blocks[localIdx]),
        at: st.now,
      });
    }
    st.blocks.splice(localIdx, 1);
    st.placement.delete(blockId);
    st.versions.delete(blockId);
    st.deleted.set(blockId, { ...tomb });
    st.changed = true;
  } else {
    // Local edit is newer: the block stays; the delete lost.
    if (tomb.updatedAt > syncedAt && localVersion.updatedAt > syncedAt) {
      st.conflicts.push({
        blockId,
        keptAuthor: localVersion.author,
        keptUpdatedAt: localVersion.updatedAt,
        lostAuthor: tomb.author,
        lostUpdatedAt: tomb.updatedAt,
        lostText: null,
        at: st.now,
      });
    }
    st.deleted.set(blockId, { ...tomb });
  }
}

/** Merge one peer's state file into the local document. Pure except
 *  for the `now` used to timestamp conflict notes. The local arrays
 *  and maps are never mutated — the result carries fresh copies. */
export function mergeSnapshot(input: MergeInput, remote: CollabStateFile, now: number): MergeResult {
  const st: MutableState = {
    blocks: input.blocks.map(cloneBlock),
    versions: new Map(input.versions),
    placement: new Map(input.placement),
    deleted: new Map(input.deleted),
    lastSynced: input.lastSynced,
    conflicts: [],
    changed: false,
    now,
  };
  remote.blocks.forEach((block, i) => {
    const id = block.id as string;
    const version = remote.versions[id];
    if (!version) return;
    const key = remote.placement?.[id];
    upsertRemoteBlock(st, block, version, key, i);
  });
  for (const [blockId, tomb] of Object.entries(remote.deleted ?? {})) {
    applyRemoteDelete(st, blockId, tomb);
  }
  return {
    blocks: st.blocks,
    versions: st.versions,
    placement: st.placement,
    deleted: st.deleted,
    conflicts: st.conflicts,
    changed: st.changed || st.conflicts.length > 0,
  };
}

/** Apply a list of block ops (local broadcast API / direct tests) to
 *  the local document. Ops are applied in deterministic order
 *  (updatedAt, author, opId) so two peers applying the same op set
 *  converge. Returns the same shape as mergeSnapshot. */
export function applyBlockOps(input: MergeInput, ops: BlockOp[], now: number): MergeResult {
  const st: MutableState = {
    blocks: input.blocks.map(cloneBlock),
    versions: new Map(input.versions),
    placement: new Map(input.placement),
    deleted: new Map(input.deleted),
    lastSynced: input.lastSynced,
    conflicts: [],
    changed: false,
    now,
  };
  const sorted = [...ops].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    if (a.author !== b.author) return a.author < b.author ? -1 : 1;
    if (a.opId !== b.opId) return a.opId < b.opId ? -1 : 1;
    return 0;
  });
  for (const op of sorted) {
    if (op.kind === "delete") {
      applyRemoteDelete(st, op.blockId, { updatedAt: op.updatedAt, author: op.author });
    } else if (op.block) {
      upsertRemoteBlock(
        st,
        op.block,
        { updatedAt: op.updatedAt, author: op.author },
        { updatedAt: op.updatedAt, author: op.author, blockId: op.blockId },
        op.index ?? st.blocks.length,
      );
    }
  }
  return {
    blocks: st.blocks,
    versions: st.versions,
    placement: st.placement,
    deleted: st.deleted,
    conflicts: st.conflicts,
    changed: st.changed || st.conflicts.length > 0,
  };
}

/**
 * Diff a previous block snapshot against the current one and produce
 * the block ops that carry the change. `prev` maps block id ->
 * { json, updatedAt } as last broadcast; `baseUpdatedAt` maps block
 * id -> the version the author had synced when the edit was made.
 * New/changed blocks become upserts (with their list index), missing
 * blocks become deletes. Unchanged blocks produce no ops.
 */
export function diffBlocks(
  prev: Map<string, { json: string; updatedAt: number }>,
  next: BlockNode[],
  author: string,
  now: number,
  baseUpdatedAt: Map<string, number>,
  opCounter: { n: number },
): BlockOp[] {
  const ops: BlockOp[] = [];
  const seen = new Set<string>();
  next.forEach((block, index) => {
    const id = block.id as string;
    seen.add(id);
    const json = JSON.stringify(block);
    const p = prev.get(id);
    if (p && p.json === json) return;
    opCounter.n += 1;
    ops.push({
      opId: `${author}:${opCounter.n}`,
      author,
      kind: "upsert",
      blockId: id,
      block: cloneBlock(block),
      index,
      updatedAt: now,
      baseUpdatedAt: baseUpdatedAt.get(id) ?? 0,
    });
  });
  for (const id of prev.keys()) {
    if (seen.has(id)) continue;
    opCounter.n += 1;
    ops.push({
      opId: `${author}:${opCounter.n}`,
      author,
      kind: "delete",
      blockId: id,
      updatedAt: now,
      baseUpdatedAt: baseUpdatedAt.get(id) ?? 0,
    });
  }
  return ops;
}
