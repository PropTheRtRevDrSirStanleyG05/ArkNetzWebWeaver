// ArkNetzWebWeaver — collab presence: who is in this site now.
// A peer joins by writing their state file (see relay.ts) and stays
// present by heartbeating. The sync engine removes a peer from this
// registry on its poll in exactly two cases: at once when the peer's
// relay state file is gone (a graceful leave deletes it — `leave()`),
// and by pruning when the peer has been silent past
// PEER_PRUNE_AFTER_MS (`expire()` marks them stale at PEER_EXPIRY_MS
// first — they stay listed as "(away)" with their blocks marked —
// and `pruneStale()` drops them only after the 5-minute window).
// Their blocks stay in the document either way, and when they return
// they re-sync from the relay. Pure logic, injectable clock: tests
// drive time by hand.

import { PEER_EXPIRY_MS, PEER_PRUNE_AFTER_MS, colourForLogin } from "./types.js";
import type { CollabPeer, CursorPosition } from "./types.js";

export interface PresenceUpdate {
  login: string;
  heartbeatAt: number;
  cursor: CursorPosition | null;
}

export class PresenceRegistry {
  private readonly peers = new Map<string, CollabPeer>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** A heartbeat (or a first sighting) from a peer. Joins them if
   *  new, refreshes them if known. Returns the peer record. */
  seen(update: PresenceUpdate): CollabPeer {
    const existing = this.peers.get(update.login);
    if (existing) {
      existing.lastHeartbeat = update.heartbeatAt;
      existing.cursor = update.cursor;
      existing.stale = false;
      return existing;
    }
    const peer: CollabPeer = {
      login: update.login,
      colour: colourForLogin(update.login),
      lastHeartbeat: update.heartbeatAt,
      cursor: update.cursor,
      stale: false,
    };
    this.peers.set(update.login, peer);
    return peer;
  }

  /** Explicit leave (graceful close): the peer is gone at once, not
   *  after the 30 s expiry. */
  leave(login: string): boolean {
    return this.peers.delete(login);
  }

  /** Recompute staleness against the clock. Returns the logins that
   *  flipped live -> stale in this call. Stale peers are NOT removed:
   *  their blocks stay, marked stale, until they return or the
   *  prune window (PEER_PRUNE_AFTER_MS) expires. */
  expire(): string[] {
    const now = this.now();
    const flipped: string[] = [];
    for (const peer of this.peers.values()) {
      const stale = now - peer.lastHeartbeat > PEER_EXPIRY_MS;
      if (stale && !peer.stale) flipped.push(peer.login);
      peer.stale = stale;
    }
    return flipped;
  }

  /** Drop peers silent past `afterMs` (default PEER_PRUNE_AFTER_MS,
   *  5 minutes) from the registry. A peer stale for only ~30 s is
   *  NOT dropped — it stays listed as "(away)" until it returns or
   *  the prune window expires. Their blocks are the document's
   *  problem, not this registry's — this only forgets the presence
   *  record. */
  pruneStale(afterMs: number = PEER_PRUNE_AFTER_MS): string[] {
    const now = this.now();
    const dropped: string[] = [];
    for (const [login, peer] of this.peers) {
      if (now - peer.lastHeartbeat > afterMs) {
        this.peers.delete(login);
        dropped.push(login);
      }
    }
    return dropped;
  }

  live(): CollabPeer[] {
    return [...this.peers.values()].filter((p) => !p.stale);
  }

  stalePeers(): CollabPeer[] {
    return [...this.peers.values()].filter((p) => p.stale);
  }

  all(): CollabPeer[] {
    return [...this.peers.values()];
  }

  get(login: string): CollabPeer | undefined {
    return this.peers.get(login);
  }

  has(login: string): boolean {
    return this.peers.has(login);
  }

  get size(): number {
    return this.peers.size;
  }
}
