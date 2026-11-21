// ArkNetzWebWeaver — collab live cursors/selections.
// A peer's cursor is part of their relay state file (see relay.ts),
// so it propagates on the same ~5 s poll as their blocks. Pure
// functions: given the presence list, describe the cursor marks the
// editor UI should render. The DOM rendering itself lives in the
// editor UI (which owns the canvas); this module only decides WHAT to
// draw, never touches the DOM, so it stays unit-testable in Node.
// Colours come from colourForLogin — the same colour a peer has in
// the presence list, so a name tag and its cursor always match.

import type { CollabPeer, CursorPosition } from "./types.js";

/** One cursor mark for the editor UI to render. */
export interface PeerCursorMark {
  login: string;
  colour: string;
  /** Block the caret is in; null = caret outside any block. */
  blockId: string | null;
  start: number;
  end: number;
  /** True when a range is selected (start !== end). */
  isSelection: boolean;
  /** "Alice" / "Alice is selecting" — the label the UI shows. */
  label: string;
  /** The peer has not heartbeated inside PEER_EXPIRY_MS: render the
   *  mark faded / "away", never as if they were live. */
  stale: boolean;
}

/** Cursor marks for every peer that has shared a cursor position,
 *  excluding `selfLogin` (your own caret is drawn by the editor, not
 *  by the collab layer). Sorted by login so rendering order is stable
 *  across peers. */
export function describePeerCursors(peers: CollabPeer[], selfLogin: string): PeerCursorMark[] {
  return peers
    .filter((p) => p.login !== selfLogin && p.cursor !== null)
    .map((p) => {
      const cursor = p.cursor as CursorPosition;
      const isSelection = cursor.start !== cursor.end;
      return {
        login: p.login,
        colour: p.colour,
        blockId: cursor.blockId,
        start: cursor.start,
        end: cursor.end,
        isSelection,
        label: isSelection ? `${p.login} is selecting` : p.login,
        stale: p.stale,
      };
    })
    .sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
}

/** Validate a cursor a peer claims: block ids are strings, offsets
 *  are non-negative integers, start <= end. Invalid cursors are
 *  dropped by the relay reader, never rendered. */
export function isValidCursor(value: unknown): value is CursorPosition {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (c.blockId !== null && typeof c.blockId !== "string") return false;
  if (typeof c.start !== "number" || !Number.isInteger(c.start) || c.start < 0) return false;
  if (typeof c.end !== "number" || !Number.isInteger(c.end) || c.end < 0) return false;
  return c.start <= c.end;
}
