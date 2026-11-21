# Real-time multi-user collaboration

Added 2026-11-21 (Stanley 03:59 — this **overrides** the earlier v1.0
note that live-cursor collaboration was out of scope).

Zero-server collaboration for the editor, using only what the app
already has: the GitHub Contents API + the user's own OAuth token.

## Relay choice: Contents API on a `collab/<domain-slug>` branch

Each site gets one collab branch in its per-domain site repo
(`arknetz-site-<domain-slug>`), named `collab/<domain-slug>` — one
session per site, so any collaborator opening the same site joins the
same branch with no discovery step. Each peer writes exactly one
file, `peers/<login>.json`, holding their presence (heartbeat +
cursor) and their full block snapshot (blocks + per-block versions +
placement keys + delete tombstones). Polling is one directory list +
one read per peer, then a write of my own file.

Why this route, and why it works with the runtime token:

- The OAuth scope is `read:user public_repo` — the same scope Publish
  already uses. `public_repo` grants exactly what this needs on
  public repos: Contents API read/write, git-refs branch create/delete,
  and the per-file SHA guard. Site repos are public by design, so no
  wider scope is required.
- **Each peer writes only its own file, so peers never contend for the
  same SHA.** There is no write-write conflict at the relay layer at
  all. The SHA guard still applies per file: a 409 on your own file
  means it changed under you, and the relay surfaces it instead of
  overwriting blindly.
- It reuses the exact API pattern `publish.ts` already proves
  (GET-for-SHA then PUT-with-SHA), so there is one authenticated
  write path to audit, not two.
- It is invisible to readers: collab state lives only on the collab
  branch. `main` and `site.json.zst` are untouched until someone
  Publishes, and Publish keeps its own SHA collision protection.
- Reads go through `api.github.com`, **never**
  `raw.githubusercontent.com`: the raw CDN caches branch content, so
  a poll could see minutes-old state. API reads are fresh
  (authenticated, 5,000/hr — a 5 s poll with a handful of peers uses
  a few hundred requests per hour).

### Rejected alternative: GitHub Issues as the relay

Issues were considered and rejected. Every op would be a public
Issue or comment in the site repo — visible noise in a repo readers
browse — and comments have no per-peer separation, so merging means
re-reading and ordering a growing comment thread with no SHA guard
at all. The branch route is quieter, has per-peer files, and reuses
the proven Contents API shape. (Protocol mail already uses Issues
for delivery; collab deliberately does not follow it.)

## What syncs, and how

- **Presence**: who is in this site now (GitHub login + deterministic
  display colour from `colourForLogin`). Heartbeat every 10 s. A peer
  whose state file is gone from the relay left gracefully and is
  removed from presence on the next poll; a peer silent >30 s is
  marked stale and stays listed as "(away)" with its blocks marked
  stale; only after 5 minutes of silence (`PEER_PRUNE_AFTER_MS`)
  with the file still present is it pruned from presence. Either
  way their blocks stay in the document, and a returning peer
  re-syncs in one poll. (D1 correction, fix pass 2, 2026-11-21: fix
  pass 1 pruned at 30 s, deleting the intentional "(away)" phase —
  the original contract is stale-at-30 s, prune-at-5-minutes.)
- **Live cursors/selections**: block id + text offsets, with names and
  colours (`describePeerCursors`). They ride in the same state file
  as blocks, so they propagate on the same poll.
- **Concurrent editing**: per-block last-write-wins on
  `(updatedAt, author)`. Two peers editing different blocks never
  interfere. Editing the same block keeps the newer version and
  records the losing version in a visible `ConflictNote` (losing text
  included) — never silently dropped. Concurrent inserts at the same
  index order deterministically by placement key, so peers converge
  to the same block order. Deletes are tombstones: a peer that has
  not seen a block yet never deletes it by absence.
- **Wire format**: snapshots, not an op log. A peer that was offline
  for an hour re-syncs from one read per peer. The editor-level API
  is still op-based (`applyRemoteBlockOps` /
  `broadcastOps`) — the snapshot is what crosses the wire.
- **Session lifecycle**: `join()` creates the branch from `main` when
  needed, writes the first state file, starts poll (5 s) + heartbeat
  (10 s) timers. `leave()` stops the timers, deletes my state file,
  drops my presence record, and deletes the branch when I was the
  last peer. A crash or a closed tab is the same as going offline:
  my file stays until my heartbeat ages past 30 s (I show as
  "(away)" with my blocks marked stale), then I am pruned from
  presence after 5 minutes of silence; my blocks stay in the
  document either way.
- **Offline peers**: their blocks stay in the document. When they
  return they re-sync in one poll. A failed poll sets
  `collabOffline`, keeps the last known presence and document
  untouched, and retries on the next poll.

## What syncs — scope

Collab covers the document's **blocks** only. Header/footer, global
nav, and extra pages are not synced (a peer's nav edit stays local
until Publish). The editor UI that renders cursors and conflict
notes reads `EditorState.collabPeers`, `collabConflicts`,
`staleBlockIds()`, and `describePeerCursors()` — the DOM rendering
itself is the editor UI's job, not this module's.

## Honest limits (see also INTEGRATION.md)

- **Latency is ~one poll interval (~5 s)**, plus GitHub API time.
  Never sub-second. Typing does not stream; blocks do.
- **No character-level OT.** Two peers typing in the same block
  resolve whole-block: one version wins, the other is a conflict
  note. Do not edit the same block at the same time if you want both
  texts — this is not Google Docs parity, and it does not claim to be.
- **No server.** If GitHub is unreachable, collab is offline; local
  editing keeps working, and sync resumes when GitHub does.
- **Poll cost.** Every peer polls every 5 s (list + one read per
  peer + one write). With many peers this is chatty against the
  5,000/hr authenticated rate limit; sessions are per-site and small
  by design.
- **Live verification only with mocks.** No live GitHub round-trip
  has run (no repos exist yet, same as the rest of the app). The
  relay, engine, and editor wiring are proven against an in-memory
  fake GitHub in `tests/collab-relay.test.ts` and
  `tests/collab-editor.test.ts`.

## Files

- `types.ts` — state-file shape + validation, colours, conflict notes.
- `merge.ts` — per-block LWW merge, deterministic insert ordering,
  tombstones, `diffBlocks`.
- `presence.ts` — join/heartbeat/leave/30 s stale marking + 5-minute prune registry.
- `cursors.ts` — cursor marks for the UI (`describePeerCursors`).
- `relay.ts` — Contents-API relay (branch + per-peer files).
- `sync.ts` — poll/merge/heartbeat engine + offline handling.
- `session.ts` — join/leave lifecycle + timers.
- `index.ts` — re-exports.

## Rules honoured

No AI builder / MCP / x402, no Fediverse, no RSS, no Gmail/SMTP
bridge, no new dependencies, no shared/master keys — every relay
call uses the acting user's own token and refuses before any network
call when there is none.
