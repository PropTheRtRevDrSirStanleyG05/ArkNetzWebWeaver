// ArkNetzWebWeaver — collab session lifecycle: join / leave.
// A session is one site's collab branch. Joining creates the branch
// (from main) when it does not exist, writes my first state file, and
// starts the poll + heartbeat timers. Leaving clears the timers,
// deletes my state file, and — only when no other peer file remains
// — deletes the branch, so an empty session leaves no clutter behind.
// A crash or a closed tab without leave() is the same as going
// offline: my state file stays until my heartbeat ages past 30 s,
// then I drop from presence. My blocks stay in the document either
// way; nothing is ever deleted for me by another peer's leave.

import { HEARTBEAT_MS, POLL_MS } from "./types.js";
import type { BlockOp, CollabStateFile, CursorPosition } from "./types.js";
import type { CollabRelay } from "./relay.js";
import { CollabSyncEngine } from "./sync.js";
import type { LocalSnapshot, SyncCallbacks } from "./sync.js";

export interface CollabSessionOptions {
  relay: CollabRelay;
  /** GitHub login of the joining user. */
  login: string;
  getLocalSnapshot: () => LocalSnapshot;
  onRemoteStates: (states: CollabStateFile[]) => void;
  onPresence?: SyncCallbacks["onPresence"];
  onError?: SyncCallbacks["onError"];
  /** Poll interval ms (default POLL_MS). */
  pollMs?: number;
  /** Heartbeat interval ms (default HEARTBEAT_MS). */
  heartbeatMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
  /** False = do not start timers (tests drive pollOnce by hand). */
  autoPoll?: boolean;
}

export class CollabSession {
  readonly login: string;
  readonly engine: CollabSyncEngine;
  joined = false;
  private readonly relay: CollabRelay;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly autoPoll: boolean;

  constructor(options: CollabSessionOptions) {
    if (!options.login) throw new Error("collab session needs a GitHub login");
    this.login = options.login;
    this.relay = options.relay;
    this.pollMs = options.pollMs ?? POLL_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.autoPoll = options.autoPoll ?? true;
    this.engine = new CollabSyncEngine(
      options.relay,
      options.login,
      {
        onRemoteStates: options.onRemoteStates,
        getLocalSnapshot: options.getLocalSnapshot,
        onPresence: options.onPresence,
        onError: options.onError,
      },
      options.now ?? (() => Date.now()),
    );
  }

  /** Join the session: ensure the branch, write my first state file,
   *  start the timers. Throws when the relay is unreachable or the
   *  token is missing — the caller must surface that instead of
   *  showing a fake "collaborating" state. */
  async join(): Promise<void> {
    if (this.joined) return;
    await this.relay.ensureBranch();
    await this.engine.writeOwn();
    this.joined = true;
    if (this.autoPoll) this.startTimers();
  }

  private startTimers(): void {
    this.stopTimers();
    this.pollTimer = setInterval(() => {
      void this.engine.pollOnce();
    }, this.pollMs);
    this.heartbeatTimer = setInterval(() => {
      void this.engine.writeOwn().catch(() => {
        // A failed heartbeat is reported on the next poll; the poll
        // timer keeps running and will surface it via onError.
      });
    }, this.heartbeatMs);
  }

  private stopTimers(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
  }

  /** Broadcast local block ops: the ops are the editor-level record
   *  of what changed; the wire carries the full local snapshot, so
   *  this triggers an immediate write of the current snapshot. The
   *  ops themselves are validated (unknown kinds rejected) but the
   *  snapshot is authoritative — a peer that missed an op still
   *  converges from the snapshot. */
  async broadcastOps(ops: BlockOp[]): Promise<void> {
    if (!this.joined) throw new Error("collab session is not joined — call join() first");
    for (const op of ops) {
      if (op.kind !== "upsert" && op.kind !== "delete") {
        throw new Error(`collab: unknown block op kind ${JSON.stringify(op.kind)}`);
      }
      if (!op.blockId || !op.author) throw new Error("collab: block op needs a blockId and an author");
    }
    if (ops.length === 0) return;
    await this.engine.writeOwn();
  }

  /** Share my cursor position with the session. Propagates on the
   *  next write (immediate: this triggers a write now). Failures are
   *  reported via onError, never thrown — a cursor is not worth
   *  breaking the editing session over. */
  setCursor(cursor: CursorPosition | null): void {
    this.engine.setCursor(cursor);
    if (!this.joined) return;
    void this.engine.writeOwn().catch(() => undefined);
  }

  /** One poll on demand (also what the timer calls). */
  pollOnce(): Promise<import("./sync.js").PollSummary> {
    return this.engine.pollOnce();
  }

  /** Graceful leave: stop timers, delete my state file, delete the
   *  branch when I was the last peer. Never throws for the
   *  branch-cleanup step — a leftover empty branch is clutter, not a
   *  failure of leaving. Returns whether the branch was deleted. */
  async leave(): Promise<{ branchDeleted: boolean }> {
    this.stopTimers();
    if (!this.joined) return { branchDeleted: false };
    this.joined = false;
    await this.relay.deleteOwn(this.login);
    // My presence record goes at once — peers learn I left from the
    // missing file on their next poll, and I stop listing myself.
    this.engine.leave();
    let branchDeleted = false;
    try {
      const remaining = await this.relay.listPeers();
      if (remaining.length === 0) branchDeleted = await this.relay.deleteBranch();
    } catch {
      branchDeleted = false;
    }
    return { branchDeleted };
  }
}
