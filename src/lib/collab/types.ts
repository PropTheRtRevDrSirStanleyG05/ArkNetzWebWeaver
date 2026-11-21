// ArkNetzWebWeaver — real-time multi-user collaboration: shared types.
// Zero-server: peers sync through the GitHub-backed relay in relay.ts
// (a `collab/<domain-slug>` branch in the site repo, one state file per
// peer). No AI builder, no MCP, no x402, no Fediverse, no RSS, no
// Gmail/SMTP bridge. Every write uses the acting user's OWN GitHub
// token (per-user keys rule) — there is no shared or master token.
// This is NOT Google Docs parity: no character-level OT, no sub-second
// latency, no server. See src/lib/collab/README.md for the honest
// limits and INTEGRATION.md for the latency/offline behaviour.

import type { BlockNode } from "../types.js";

/** A peer is stale ("(away)") when no heartbeat has been seen for
 *  longer than this. 30 s, per the task spec. Stale is a MARK, not a
 *  removal: a stale peer stays listed (and its blocks stay marked)
 *  until it returns or the much longer prune window below expires. */
export const PEER_EXPIRY_MS = 30_000;
/** A peer whose relay state file still exists but whose heartbeat
 *  has been silent for longer than this is pruned from presence.
 *  5 minutes: long enough that a crashed tab, a flaky connection,
 *  or a laptop lid stays "(away)" instead of vanishing, short
 *  enough that a peer who never comes back does not linger
 *  forever. A peer whose state file is GONE (graceful leave) is
 *  removed at once, without waiting for either window. */
export const PEER_PRUNE_AFTER_MS = 300_000;
/** How often a joined peer re-writes its heartbeat (well inside the
 *  30 s expiry, so one failed write does not drop the peer). */
export const HEARTBEAT_MS = 10_000;
/** Default poll interval for the sync engine. Expected latency for a
 *  remote edit to appear is roughly one poll interval (plus GitHub
 *  API time): ~5 s in the normal case, never sub-second. */
export const POLL_MS = 5_000;
/** Protocol version of the collab state file. Bumped only on a
 *  breaking change to the file shape; readers reject unknown versions
 *  loudly instead of mis-merging. */
export const COLLAB_STATE_VERSION = 1;

/** Deterministic display colours, one per login. A peer keeps the
 *  same colour on every device and every session, so "the blue cursor
 *  is Alice" stays true. */
export const PEER_COLOURS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#d97706", // amber
  "#7c3aed", // violet
  "#db2777", // pink
  "#0891b2", // cyan
  "#65a30d", // lime
] as const;

/** Stable colour for a login: FNV-1a hash of the lowercased login
 *  into the palette. Pure function — no two clients can disagree. */
export function colourForLogin(login: string): string {
  let hash = 0x811c9dc5;
  for (const ch of login.toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  const idx = Math.abs(hash) % PEER_COLOURS.length;
  return PEER_COLOURS[idx] as string;
}

/** Where a peer's caret/selection is: block id + plain-text offsets
 *  inside that block, as the editor-ui selection helpers report them.
 *  Null blockId = no caret in a block (e.g. focus outside the canvas). */
export interface CursorPosition {
  blockId: string | null;
  /** Caret offset when start === end; a range when they differ. */
  start: number;
  end: number;
}

/** One collaborator in the session. */
export interface CollabPeer {
  /** GitHub login (the identity the relay file is named after). */
  login: string;
  /** Display colour, from colourForLogin(login). */
  colour: string;
  /** Unix ms of the last heartbeat seen from this peer. */
  lastHeartbeat: number;
  /** Where their caret is now, if they have shared one. */
  cursor: CursorPosition | null;
  /** True when the peer has not heartbeated inside PEER_EXPIRY_MS.
   *  Stale peers stay listed (marked stale) until they return or
   *  the PEER_PRUNE_AFTER_MS window expires — their blocks are
   *  never removed. */
  stale: boolean;
}

/** Per-block version: who last wrote this block, and when (Unix ms).
 *  Last-write-wins per block is decided on (updatedAt, author): the
 *  later timestamp wins; ties break on the author login, so two peers
 *  deciding the same conflict always pick the same winner. */
export interface BlockVersion {
  updatedAt: number;
  author: string;
}

/** One block-level edit. The merge unit is a whole block, never a
 *  character range — there is no character-level OT in this design. */
export interface BlockOp {
  /** Unique per op: `<author>:<counter>` — used only as a final
   *  tie-breaker, never as an ordering promise. */
  opId: string;
  author: string;
  kind: "upsert" | "delete";
  blockId: string;
  /** Present for upsert: the full new block content. */
  block?: BlockNode;
  /** Desired position for a new block (index into the block list at
   *  the author's end). Clamped on apply; concurrent inserts at the
   *  same index are ordered deterministically by (updatedAt, author,
   *  blockId) — see merge.ts. */
  index?: number;
  /** Unix ms of the author's edit. */
  updatedAt: number;
  /** The version the author had last synced for this block when they
   *  made the edit (0 = the block did not exist for them). A conflict
   *  is a remote op whose base is older than the local version while
   *  the local side also changed after that base — see merge.ts. */
  baseUpdatedAt: number;
}

/** A same-block conflict that LWW resolved: the newer version was
 *  kept, the losing version is recorded (never silently dropped) so
 *  the editor can show it. `lostText` is the loser's plain text, when
 *  the losing block carried any — enough to re-type or restore it. */
export interface ConflictNote {
  blockId: string;
  /** The version that won (kept in the document). */
  keptAuthor: string;
  keptUpdatedAt: number;
  /** The version that lost. */
  lostAuthor: string;
  lostUpdatedAt: number;
  lostText: string | null;
  /** Unix ms the conflict was recorded. */
  at: number;
}

/** Human-readable one-liner for a conflict note, for the editor UI. */
export function describeConflict(note: ConflictNote): string {
  const when = new Date(note.at).toLocaleTimeString();
  const lost = note.lostText ? ` — losing text was: ${JSON.stringify(note.lostText)}` : "";
  return (
    `Conflict on block ${note.blockId} at ${when}: kept ${note.keptAuthor}'s newer ` +
    `version over ${note.lostAuthor}'s version${lost}. The losing version was ` +
    `not saved to the document; re-apply it by hand if you still want it.`
  );
}

/** What one peer publishes to the relay on every poll: their whole
 *  current block list + per-block versions + presence. Peers merge
 *  snapshots (not an op log): a peer that was offline for an hour
 *  re-syncs from one read per peer, with no history to replay. */
export interface CollabStateFile {
  v: number;
  /** Session id: the domain slug (`computers-edu`). One session per
   *  site — any collaborator opening the same site joins it. */
  session: string;
  login: string;
  colour: string;
  /** Unix ms this file was written (heartbeat). */
  heartbeatAt: number;
  cursor: CursorPosition | null;
  blocks: BlockNode[];
  /** blockId -> version. Every block in `blocks` must have an entry. */
  versions: Record<string, BlockVersion>;
  /** blockId -> placement key used to order concurrent inserts at the
   *  same index: [updatedAt, author, blockId] of the op that placed
   *  the block there. Absent = a pre-session block (an anchor: sorts
   *  before any concurrent insert at the same index). */
  placement?: Record<string, { updatedAt: number; author: string; blockId: string }>;
  /** Tombstones: blockId -> version of the delete. A peer that never
   *  saw a block has no entry for it — absence from `blocks` alone is
   *  NEVER a delete, or a slow peer would delete blocks it simply
   *  had not received yet. */
  deleted?: Record<string, BlockVersion>;
}

/** Validate a parsed collab state file. Throws with the exact problem
 *  — a corrupt peer file must never be merged silently. */
export function parseCollabStateFile(raw: unknown): CollabStateFile {
  if (typeof raw !== "object" || raw === null) throw new Error("collab state file is not an object");
  const f = raw as Record<string, unknown>;
  if (f.v !== COLLAB_STATE_VERSION) {
    throw new Error(`collab state file has unsupported version ${String(f.v)} (this client knows v${COLLAB_STATE_VERSION})`);
  }
  if (typeof f.session !== "string" || !f.session) throw new Error("collab state file has no session");
  if (typeof f.login !== "string" || !f.login) throw new Error("collab state file has no login");
  if (typeof f.heartbeatAt !== "number") throw new Error("collab state file has no heartbeatAt");
  if (!Array.isArray(f.blocks)) throw new Error("collab state file has no blocks array");
  if (typeof f.versions !== "object" || f.versions === null) throw new Error("collab state file has no versions");
  for (const b of f.blocks as BlockNode[]) {
    if (!b || typeof b !== "object" || typeof (b as BlockNode).id !== "string") {
      throw new Error("collab state file has a block without an id");
    }
    const v = (f.versions as Record<string, unknown>)[(b as BlockNode).id as string];
    if (typeof v !== "object" || v === null || typeof (v as BlockVersion).updatedAt !== "number") {
      throw new Error(`collab state file has no version for block ${(b as BlockNode).id}`);
    }
  }
  return raw as CollabStateFile;
}
