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
import { collabBranchName } from "./relay.js";
import { CollabSyncEngine } from "./sync.js";
import type { LocalSnapshot, SyncCallbacks } from "./sync.js";

/** Relay poll while a P2P collab channel is live: 6x slower than the
 *  5 s default. The branch stays the convergence safety net — it just
 *  stops being the hot path. Restored when the last P2P peer drops. */
export const COLLAB_P2P_SLOW_POLL_MS = 30_000;

/** Events the P2P hook reports back to the session. */
export interface CollabP2PHookEvents {
  /** At least one P2P peer connected — slow the relay poll. */
  onConnected(): void;
  /** The last P2P peer dropped — restore the normal poll. */
  onDropped(): void;
  /** Remote block ops arrived over P2P (apply with the same LWW
   *  merge as the relay path). */
  onOps(ops: BlockOp[]): void;
  /** A remote cursor moved over P2P. */
  onCursor(login: string, cursor: CursorPosition | null): void;
}

/** The P2P side of a collab session (phase 2, implemented by the P2P
 *  host). The session owns the relay; the hook owns the data-channel
 *  sessions. The hook never applies ops itself — it reports them
 *  through the events, and the session applies them exactly as it
 *  applies relay states. */
export interface CollabP2PHook {
  /** Start P2P for this session (no-op when P2P is off). */
  start(sessionId: string, domain: string, events: CollabP2PHookEvents): Promise<void>;
  /** Presence update: logins currently in the session (from the
   *  relay poll). The hook connects lazily to new ones. */
  notePresence(logins: readonly string[]): void;
  /** Broadcast local ops / cursor to connected P2P peers. */
  sendOps(ops: BlockOp[]): void;
  sendCursor(cursor: CursorPosition | null): void;
  /** Stop P2P for this session (leave). */
  stop(): void;
}

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
  /** Optional P2P hook (phase 2): when present, local ops/cursors
   *  also ride the data channel, and remote P2P ops arrive through
   *  onP2POps. The relay stays authoritative for convergence. */
  p2p?: CollabP2PHook;
  /** Remote block ops that arrived over P2P (applied with the same
   *  LWW merge as relay states). */
  onP2POps?: (ops: BlockOp[]) => void;
}

export class CollabSession {
  readonly login: string;
  readonly engine: CollabSyncEngine;
  joined = false;
  private readonly relay: CollabRelay;
  private pollMs: number;
  private readonly heartbeatMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly autoPoll: boolean;
  private readonly p2p?: CollabP2PHook;
  private readonly onP2POps?: (ops: BlockOp[]) => void;
  private readonly onPresenceCb?: SyncCallbacks["onPresence"];
  private readonly nowFn: () => number;

  constructor(options: CollabSessionOptions) {
    if (!options.login) throw new Error("collab session needs a GitHub login");
    this.login = options.login;
    this.relay = options.relay;
    this.pollMs = options.pollMs ?? POLL_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.autoPoll = options.autoPoll ?? true;
    this.p2p = options.p2p;
    this.onP2POps = options.onP2POps;
    this.onPresenceCb = options.onPresence;
    this.nowFn = options.now ?? (() => Date.now());
    this.engine = new CollabSyncEngine(
      options.relay,
      options.login,
      {
        onRemoteStates: options.onRemoteStates,
        getLocalSnapshot: options.getLocalSnapshot,
        onPresence: options.onPresence,
        onError: options.onError,
      },
      this.nowFn,
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
    // P2P rides alongside the relay from the start: the hook
    // connects lazily as presence reports peers (see notePresence,
    // called from the editor's onPresence). A hook failure must
    // never break the relay join — P2P is an accelerator, not a
    // dependency.
    if (this.p2p) {
      await this.p2p
        .start(collabBranchName(this.relay.domain), this.relay.domain, {
          onConnected: () => this.setPollMs(COLLAB_P2P_SLOW_POLL_MS),
          onDropped: () => this.setPollMs(POLL_MS),
          onOps: (ops) => this.onP2POps?.(ops),
          onCursor: (login, cursor) => {
            // Remote cursor over P2P: same presence record as the
            // relay path, refreshed immediately (no poll wait).
            this.engine.presence.seen({ login, heartbeatAt: this.nowFn(), cursor });
            this.onPresenceCb?.(this.engine.presence.all());
          },
        })
        .catch(() => undefined);
    }
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
    // Same ops ride the data channel when a P2P session is live.
    this.p2p?.sendOps(ops);
  }

  /** Share my cursor position with the session. Propagates on the
   *  next write (immediate: this triggers a write now). Failures are
   *  reported via onError, never thrown — a cursor is not worth
   *  breaking the editing session over. */
  setCursor(cursor: CursorPosition | null): void {
    this.engine.setCursor(cursor);
    this.p2p?.sendCursor(cursor);
    if (!this.joined) return;
    void this.engine.writeOwn().catch(() => undefined);
  }

  /** Relay poll cadence (phase 2): slowed while P2P is connected,
   *  restored when it drops. Restarts the poll timer when running. */
  setPollMs(ms: number): void {
    this.pollMs = ms;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => {
        void this.engine.pollOnce();
      }, this.pollMs);
    }
  }

  /** Current relay poll cadence (ms) — 30,000 while a P2P collab
   *  channel is live, the default 5,000 otherwise. */
  get currentPollMs(): number {
    return this.pollMs;
  }

  /** Presence update from the relay poll — the P2P hook connects
   *  lazily to logins it has not seen yet. */
  notePresence(logins: readonly string[]): void {
    this.p2p?.notePresence(logins);
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
    this.p2p?.stop();
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
