// ArkNetzWebWeaver — P2P live collab adapter.
// Same session as the GitHub relay (`collab/<domain-slug>`, same
// session id), but over a data channel instead of the branch. Local
// edits are diffed with the existing `diffBlocks` and sent as `op`
// control messages; remote ops are applied with the existing
// `applyBlockOps`. THE CONFLICT RULE IS UNCHANGED: per-block
// last-write-wins on (updatedAt, author), with ConflictNotes.
//
// THE BRANCH RELAY STAYS AUTHORITATIVE FOR CONVERGENCE. P2P is an
// accelerator: ops arrive in milliseconds instead of ~5 s, but the
// periodic branch poll still runs (phase 2 slows it while P2P is
// connected) so a peer that was offline, or that never got a P2P op,
// still converges from the branch. A peer that drops from P2P is
// re-synced by the next poll — nothing is lost.
//
// Only peers in the session's team may use this session: the caller
// enforces the team check before attaching (phase 2), and this
// adapter refuses ops from any login that is not in `teamLogins`.

import type { BlockOp } from "../collab/types.js";
import type { CursorPosition } from "../collab/types.js";
import type { P2PConnection } from "./transport.js";
import { TransferHub } from "./transfer.js";
import { P2P_CHANNEL_LABELS } from "./types.js";

export interface P2PCollabCallbacks {
  /** Remote block ops arrived (apply with applyBlockOps). */
  onOps: (ops: BlockOp[]) => void;
  /** Remote cursor moved. */
  onCursor: (login: string, cursor: CursorPosition | null) => void;
  /** The channel closed or the peer dropped — fall back to the relay
   *  poll (the next poll re-syncs from the branch). */
  onDrop: (reason: string) => void;
}

export class P2PCollabSession {
  private hub: TransferHub | null = null;
  /** True once the remote hello arrived on this channel. */
  helloReceived = false;

  constructor(
    private readonly session: string,
    private readonly selfLogin: string,
    private readonly teamLogins: ReadonlySet<string>,
    private readonly callbacks: P2PCollabCallbacks,
  ) {}

  /** Attach to a peer connection (creates the collab channel + hub)
   *  and send our hello. */
  attach(connection: P2PConnection): void {
    const channel = connection.createChannel(P2P_CHANNEL_LABELS.collab);
    this.hub = new TransferHub(channel);
    this.hub.onControl = (msg) => {
      if (msg.t === "hello") {
        this.helloReceived = true;
        return;
      }
      if (msg.t === "op" && msg.session === this.session) {
        this.handleOps(msg.ops);
        return;
      }
      if (msg.t === "cursor" && msg.session === this.session) {
        if (typeof msg.login === "string" && this.teamLogins.has(msg.login)) {
          this.callbacks.onCursor(msg.login, msg.cursor as CursorPosition | null);
        }
        return;
      }
      if (msg.t === "bye") {
        this.callbacks.onDrop(msg.reason ?? "peer left");
      }
    };
    channel.onclose = () => {
      this.hub?.detach();
      this.hub = null;
      this.callbacks.onDrop("channel closed");
    };
    try {
      this.hub.sendControl({
        t: "hello",
        v: "arknetz-p2p/1",
        peerId: this.selfLogin,
        features: ["collab"],
      });
    } catch {
      // Channel not open yet — the caller retries attach on connect.
    }
  }

  detach(reason = "left"): void {
    try {
      this.hub?.sendControl({ t: "bye", reason });
    } catch {
      // Channel already gone.
    }
    this.hub?.detach();
    this.hub = null;
  }

  private handleOps(rawOps: unknown[]): void {
    const ops: BlockOp[] = [];
    for (const raw of rawOps) {
      if (typeof raw !== "object" || raw === null) continue;
      const op = raw as BlockOp;
      if (typeof op.author !== "string" || !this.teamLogins.has(op.author)) continue;
      if (typeof op.opId !== "string" || typeof op.blockId !== "string") continue;
      if (op.kind !== "upsert" && op.kind !== "delete") continue;
      if (typeof op.updatedAt !== "number") continue;
      ops.push(op);
    }
    if (ops.length > 0) this.callbacks.onOps(ops);
  }

  /** Broadcast local ops to this peer. No-op when not attached. */
  sendOps(ops: BlockOp[]): void {
    if (ops.length === 0) return;
    try {
      this.hub?.sendControl({ t: "op", session: this.session, ops });
    } catch {
      // Channel gone — the relay poll carries these instead.
    }
  }

  /** Broadcast a cursor position to this peer. */
  sendCursor(cursor: CursorPosition | null): void {
    try {
      this.hub?.sendControl({ t: "cursor", session: this.session, login: this.selfLogin, cursor });
    } catch {
      // Channel gone — nothing to do.
    }
  }
}
