// ArkNetzWebWeaver — collab sync engine: poll, merge, heartbeat.
// One poll = read every peer's state file from the relay, hand the
// remote states to the editor (which owns the document and merges
// them), then write my own state file (heartbeat + my current
// snapshot + my cursor). Polls are the only network traffic: there is
// no push, no websocket, no server — so remote edits appear after
// roughly one poll interval (~5 s by default), never sub-second.
//
// Offline behaviour: a failed poll sets `offline` and keeps the last
// known presence and document untouched. Nothing is deleted, nothing
// is reverted. The next poll retries; on success the engine re-reads
// every peer and re-syncs from scratch, so a peer that was offline
// for an hour converges in a single poll. A peer whose heartbeat is
// older than PEER_EXPIRY_MS is marked stale (presence only) — its
// blocks stay in the document, marked stale, until it returns.

import type { BlockNode } from "../types.js";
import type { BlockVersion, CollabStateFile, CursorPosition } from "./types.js";
import type { PlacementKey } from "./merge.js";
import { COLLAB_STATE_VERSION, PEER_EXPIRY_MS, colourForLogin } from "./types.js";
import { PresenceRegistry } from "./presence.js";
import type { CollabRelay } from "./relay.js";

export interface LocalSnapshot {
  blocks: BlockNode[];
  versions: Map<string, BlockVersion>;
  placement: Map<string, PlacementKey>;
  deleted: Map<string, BlockVersion>;
}

export interface SyncCallbacks {
  /** The editor merges these remote states into its document. */
  onRemoteStates: (states: CollabStateFile[]) => void;
  /** Current local snapshot, read fresh at write time. */
  getLocalSnapshot: () => LocalSnapshot;
  /** Presence list changed (join / leave / expiry). */
  onPresence?: (peers: import("./types.js").CollabPeer[]) => void;
  /** A poll or write failed (offline, relay error). The engine keeps
   *  going; the next poll retries. */
  onError?: (err: Error) => void;
}

export interface PollSummary {
  ok: boolean;
  /** Peers seen on the relay this poll (excluding self). */
  peers: string[];
  /** Logins that flipped live -> stale this poll. */
  expired: string[];
  /** True when this poll ran while previously offline. */
  recovered: boolean;
}

export class CollabSyncEngine {
  readonly session: string;
  readonly selfLogin: string;
  readonly colour: string;
  readonly presence: PresenceRegistry;
  /** True after a failed poll/write, until a poll succeeds again. */
  offline = false;
  /** Last error, if any — surfaced to the UI, never swallowed. */
  lastError: Error | null = null;
  private cursor: CursorPosition | null = null;
  private readonly now: () => number;

  constructor(
    readonly relay: CollabRelay,
    selfLogin: string,
    private readonly callbacks: SyncCallbacks,
    now: () => number = () => Date.now(),
  ) {
    this.session = relay.domain.toLowerCase().replace(/\./g, "-");
    this.selfLogin = selfLogin;
    this.colour = colourForLogin(selfLogin);
    this.now = now;
    this.presence = new PresenceRegistry(now);
  }

  setCursor(cursor: CursorPosition | null): void {
    this.cursor = cursor;
  }

  getCursor(): CursorPosition | null {
    return this.cursor;
  }

  /** My state file as it will be written on the next poll: heartbeat
   *  + cursor + my full current snapshot. */
  buildOwnState(): CollabStateFile {
    const snap = this.callbacks.getLocalSnapshot();
    const versions: Record<string, BlockVersion> = {};
    for (const [id, v] of snap.versions) versions[id] = { ...v };
    const placement: Record<string, PlacementKey> = {};
    for (const [id, k] of snap.placement) placement[id] = { ...k };
    const deleted: Record<string, BlockVersion> = {};
    for (const [id, v] of snap.deleted) deleted[id] = { ...v };
    return {
      v: COLLAB_STATE_VERSION,
      session: this.session,
      login: this.selfLogin,
      colour: this.colour,
      heartbeatAt: this.now(),
      cursor: this.cursor,
      blocks: snap.blocks.map((b) => JSON.parse(JSON.stringify(b)) as BlockNode),
      versions,
      placement,
      deleted,
    };
  }

  /** Write my state file now (heartbeat / broadcast after a local
   *  edit). Throws on relay failure — the caller decides whether to
   *  surface it (pollOnce converts it to offline + onError). */
  async writeOwn(): Promise<void> {
    await this.relay.writeOwn(this.buildOwnState());
    this.presence.seen({ login: this.selfLogin, heartbeatAt: this.now(), cursor: this.cursor });
  }

  /** One full poll: read peers, merge, write my heartbeat. Safe to
   *  call on a timer or by hand; never throws (failures go to
   *  onError + `offline`). */
  async pollOnce(): Promise<PollSummary> {
    const wasOffline = this.offline;
    let remote: Array<{ login: string; state: CollabStateFile }>;
    try {
      remote = await this.relay.readAllPeers();
    } catch (err) {
      this.offline = true;
      this.lastError = err instanceof Error ? err : new Error(String(err));
      this.callbacks.onError?.(this.lastError);
      return { ok: false, peers: [], expired: [], recovered: false };
    }
    const others = remote.filter((r) => r.login !== this.selfLogin);
    for (const { state } of others) {
      this.presence.seen({ login: state.login, heartbeatAt: state.heartbeatAt, cursor: state.cursor });
    }
    // Self-presence is refreshed by the write below; seed it now so a
    // poll that fails on write still lists me as present.
    this.presence.seen({ login: this.selfLogin, heartbeatAt: this.now(), cursor: this.cursor });
    if (others.length > 0) {
      try {
        this.callbacks.onRemoteStates(others.map((o) => o.state));
      } catch (err) {
        // A merge must never kill the poll: presence and the heartbeat
        // still go out, and the error is surfaced.
        this.lastError = err instanceof Error ? err : new Error(String(err));
        this.callbacks.onError?.(this.lastError);
      }
    }
    const expired = this.presence.expire();
    this.callbacks.onPresence?.(this.presence.all());
    try {
      await this.writeOwn();
    } catch (err) {
      this.offline = true;
      this.lastError = err instanceof Error ? err : new Error(String(err));
      this.callbacks.onError?.(this.lastError);
      return { ok: false, peers: others.map((o) => o.login), expired, recovered: false };
    }
    const recovered = wasOffline;
    this.offline = false;
    this.lastError = null;
    return { ok: true, peers: others.map((o) => o.login), expired, recovered };
  }

  /** Block ids whose last writer is currently stale. The editor marks
   *  these blocks stale in the UI; the blocks themselves stay put. */
  staleBlockIds(snapshot: LocalSnapshot): Set<string> {
    const staleLogins = new Set(this.presence.stalePeers().map((p) => p.login));
    const out = new Set<string>();
    for (const [id, v] of snapshot.versions) {
      if (staleLogins.has(v.author)) out.add(id);
    }
    return out;
  }

  /** True when a peer has not heartbeated inside PEER_EXPIRY_MS. */
  isPeerStale(login: string): boolean {
    const peer = this.presence.get(login);
    if (!peer) return false;
    return this.now() - peer.lastHeartbeat > PEER_EXPIRY_MS;
  }
}
