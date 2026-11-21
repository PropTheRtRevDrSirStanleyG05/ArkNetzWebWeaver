# ArkNetzWebWeaver — pre-GitHub finishing program: integration record

Date: 2026-11-20. Coordinator program ordered by Stanley 15:10 PST:
fix as much of the missing thread work as possible BEFORE putting
anything on GitHub. **Nothing has been created or pushed on GitHub.**
No repos, no OAuth App, no central repos exist yet.

## Verified state (2026-11-20, after integration)

- `npx tsc -p tsconfig.json --noEmit`: clean, exit 0.
- `npm run build`: passes (tsc + asset copy).
- `npm test`: **320 tests, 320 pass, 0 fail** (22 test files).
- Tauri Linux build: see "Tauri build" below.
- All tests mock network (injected mock fetch). **No test hits real
  GitHub or real Internet Archive.**

## What was built, per phase

### Phase 1 — Protocol mail (47 tests, `tests/mail.test.ts`)

`src/lib/mail/`: `types.ts` (EncryptedMailEnvelope), `crypto.ts`,
`contacts.ts`, `lists.ts`, `delivery.ts`, `inbox.ts`, `compose.ts`,
`team-inbox.ts`, `mail-ui.ts`, `index.ts`.
Inbox list, unread, search by sender/subject/date, threaded
conversations, compose with To/CC/BCC/Reply All, drafts saved locally,
group mail, mailing lists (`mail_lists.json.zst`), global contacts
directory, shared team inbox (`mail.read` / `mail.send`), E2E
AES-256-GCM hybrid encryption (compress + encrypt once with a random
AES key, wrap the 32-byte key per recipient; To:/CC: inside the
encrypted header; BCC stripped from the inner header), delivery via
`gh:<user>/protocol-inbox` Issues, archive to IndexedDB or the private
mail-archive repo, delete/close the inbox Issue.

### Phase 2 — ArkDrive (21 tests, `tests/drive.test.ts`)

`src/lib/drive/`: `types.ts`, `crypto.ts`, `chunks.ts`, `backends.ts`,
`github.ts`, `gitlab.ts`, `codeberg.ts`, `huggingface.ts`, `drive.ts`,
`pooled.ts`, `backup.ts`, `drive-ui.ts`.
File manager (folders, upload/download, rename/move/delete, search),
zero-knowledge (Zstd compress, AES-256-GCM encrypt contents AND
filename/folder metadata, key from vault passphrase via PBKDF2 100k),
files >10 MB split into 10 MB encrypted chunks, SHA-256 dedup,
reassembly in-browser on download, encrypted manifest
`vault-index.enc.zst` + `blob_*.enc` chunks, pooled multi-account view
with space per backend, one-click encrypted backups for sites /
`.arknetz` bundles / archived mail / game projects. Backends:
GitHub/GitLab/Codeberg private repos + Hugging Face open-science only.
**Internet Archive and Wikimedia are refused by ArkDrive by design
(ToS).**

### Phase 3a — Comments + federated search (32 tests, `tests/comments-search.test.ts`)

`src/lib/viewer/comments.ts`, `search.ts`, `viewer-ui.ts`.
Threaded comments via GitHub Discussions/Issues in the site owner's
repo (guests read free, signed-in comment, nested replies to depth 5,
Markdown sanitised, reactions, `comments.moderate` gating, Root Master
moderation). Federated search: dependency-free inverted index over
`directory-*.json.zst` shards in IndexedDB (no MiniSearch dependency),
Trending / Newly Updated feeds, search history.

### Phase 3b — Offline, stats, streaming (14 tests, `tests/viewer.test.ts`)

`src/lib/viewer/offline.ts`, `stats.ts`, `streaming.ts`, `viewer2-ui.ts`.
Offline `.arknetz` bundles (STORE-method ZIP, single portable archive,
opens with zero internet). Privacy-preserving stats: comment/reaction
counts, IA play counts, opt-in batched anonymous VIEW_PING Issues +
nightly rollup into `stats.json.zst`, Strict Offline/No-Telemetry Mode.
Streaming: series-grid preset, Continue Watching in IndexedDB,
season dropdowns, cast notes, private local My List, 720p faststart
HTTP Range video.

### Phase 4a — Domains + moderation (40 tests, `tests/domains-moderation.test.ts`)

`src/lib/domains.ts`, `moderation.ts`, `domains-ui.ts`,
`moderation-ui.ts`, `protocol/register.yml`.
Custom domains: claim flow (REGISTER Issue shape + `register.yml`
Action template), exact-string domains only, sub-delegation
(`delegations.json.zst`), completely open registration (no
account-age minimum, no per-user limit). Two-tier moderation: Root
Master Admin Panel (only when the active GitHub account is
`PropTheRtRevDrSirStanleyG05`) reading `moderation.json.zst`, content
override/redaction patches at render time; registrar
`sub_moderation.json.zst`; resolution order Root Master → Parent
Registrar → Post Author.

### Phase 4b — Backends, Wayback, multi-account, ToS, PROTOCOL.md (51 tests, `tests/backends.test.ts`)

`src/lib/network/backends.ts`, `wayback.ts`, `accounts.ts`, `tos.ts`,
`accounts-ui.ts`, `backends-ui.ts`, `PROTOCOL.md` (scaffold root).
Pluggable backends `gh:` / `gl:` / `cb:` / `ia:` / `hf:` / `wm:` /
`ipfs:` with mirror arrays and automatic failover; ToS-aware routing
(`hf:` / `wm:` only when the creator marks open dataset / educational
/ CC work). Wayback Machine: one-click Snapshot (Save Page Now on the
public raw URL), Time Machine viewer via the free CDX API, automatic
read-only failover to the latest preserved `.json.zst` snapshot.
Multi-account: encrypted IndexedDB keyring (`AccountKeyring`),
Account Switcher Pill UI, per-provider labelled profiles, one-click
switch, smart per-site auto-binding, Master Admin Badge detection.
ToS: pass-through GitHub ToS + IA Terms, passive Acceptable Use notice
for guests, one-click creator acceptance with a timestamped flag.
PROTOCOL.md documents every `.json.zst` schema, Zstd dictionary
versioning, sandboxed postMessage APIs, encryption formats,
registry/shard rules, configurable root / multi-root peering, and
bring-your-own OAuth (`GITHUB_OAUTH_CLIENT_ID` in `src/lib/config.ts`).

### Fix-up agent (parallel, v0.3.0 — landed before integration)

Inline formatting, media crop/flip/rotate, Zstd wiring
(`@bokuweb/zstd-wasm`, MIT), IA account-linking UI, real Publish.
Tests: `inline.test.ts` (9), `media-edit.test.ts` (7),
`zstd.test.ts` (5), `zstd-registry.test.ts` (4), `ia-settings.test.ts`
(4), `publish.test.ts` (7). Version bumped to 0.3.0.

### Integration (this program)

- `src/lib/app.ts` — `createArkNetzApp()`: constructs every phase
  service once with shared stores; `APP_PANELS` registry (13 panels:
  browse, builder, mail, drive, search, comments, streaming, offline,
  domains, moderation, accounts, wayback, settings). Tests:
  `tests/app.test.ts` (5).
- `src/lib/panels.ts` — mounts the 13 panels into the shell sidebar
  (`#panel-nav` / `#panel-host` in `src/index.html`, wired in
  `src/main.ts`): mail keypair creation + inbox + draft compose,
  vault open, directory search, offline save of the current site
  (real `.arknetz` download), domain availability check, Wayback CDX
  lookup + Save Page Now, ToS acceptance, account switcher, moderation
  gating. Tests: `tests/panels.test.ts` (9).
- `src/lib/network/accounts.ts` — added a read-only
  `AccountKeyring.snapshot()` accessor for the switcher UI (no
  behaviour change).

## Tauri build

- Linux build previously succeeded 2026-11-20 15:04 (exit 0, 7m 54s):
  `.deb` 3.58 MiB, `.rpm` 3.58 MiB, AppImage 78.80 MiB, binary 11 MiB.
  (AppImage is far bigger than the thread's ~7 MB claim — the .deb is
  the small one; AppImage bundles the runtime.)
- **Rebuild with all phases wired in (2026-11-20 ~23:37–23:40 UTC):
  binary + .deb + .rpm rebuilt fresh.** The VM had been reset since
  15:04, which removed the Tauri system -dev packages and restored the
  Hatch-patched libzstd1; the first rebuild failed at link time
  (`unable to find library -lgdk-3`, `-lwebkit2gtk-4.1`, etc.). After
  re-downgrading libzstd1 to stock `1.5.5+dfsg2-2build1.1` (the
  Hatch-patched library is still saved at
  `build/sysdeps-backup/libzstd.so.1.5.5`) and reinstalling
  `libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev
  librsvg2-dev libssl-dev libxdo-dev`, the Rust binary compiled and
  linked cleanly: binary 11,417,376 bytes, `.deb` 4,130,500 bytes,
  `.rpm` 4,135,248 bytes, all timestamped 23:40 UTC, in
  `src-tauri/target/release/bundle/`.
- **AppImage did NOT finish in the rebuild:** packaging stalled inside
  `appimagetool` (0 CPU for 8+ minutes, no output file) while the
  build session waited on a runtime confirmation that never cleared;
  the stuck build was killed. The 15:04 AppImage (78.80 MiB, pre-phase
  code) is still on disk. The stall looks environmental (FUSE /
  confirmation gate), not a code failure — the AppDir was fully
  populated. Re-running the AppImage step on a machine with FUSE (or
  with the confirmation cleared) is the remaining step.
- Windows `.exe` and Android `.apk` are NOT built yet (need a Windows
  machine / Android SDK).

## Honest gaps — what is still missing or unverified

### Built but only mock-verified (needs real accounts/services)

- **Live GitHub round-trips:** mail send → poll → decrypt → close;
  `register.yml` domain claim end to end; ArkDrive provider APIs
  (GitHub/GitLab/Codeberg/HF); Wayback snapshots against real raw URLs.
- **Real IA uploads:** stealth upload, thumbnails, and IA rate-limit
  behaviour on a residential IP — mocked only.
- **Live OAuth App:** no GitHub OAuth App exists; `config.ts` has no
  client id, so sign-in throws loudly by design. No central repos exist
  (`ArkNetzWebWeaver`, registry shards, moderation, contacts, feed,
  directory), so registry resolution, claims, mail delivery, and
  comments have no live endpoint.
- **Real ArkDrive timings:** 10 MB / 100 MB upload/download, chunk
  dedup at scale — unmeasured.
- **Lighthouse 100/100** on an exported site — not run.
- **Standards-proof scope:** which standards surface proves
  "completely compatible with every modern web standard" and what
  "faster" is measured against — still open (see READINESS-PARITY.md).
- **Fork / Root Master boundary:** how a fork's client points at his
  registry vs its own; whether his Root Master moderation applies to
  sites viewed through a fork — still open.
- **Live interactive QA:** no real browser/Tauri session has yet built
  a site, viewed it as guest, sent a group mail, and
  uploaded/downloaded in ArkDrive in one session. A green battery
  alone never calls a build verified.

### Known deviations from the thread's numbers (documented in code)

- The thread's "~64 bytes per wrapped key" is really **~256 bytes**
  with RSA-OAEP-2048; "~40 MB per 1M contacts" is really **~400 MB
  pre-Zstd** for RSA-2048 JWKs. X25519 would restore the thread's
  figures — a future decision, not yet made.
- The thread's mail Issue format is not specified; the implementation
  defines it as `ARKNETZ-MAIL <messageId>` + fenced envelope JSON.
- Large-list mail outbox storage is a shape, not a writer; pointer
  resolution for large lists is untested end to end.
- Zstd **dictionary** compression is specified in PROTOCOL.md, but
  `zstd.ts` uses plain Zstd — the ~32 KB dictionary is not wired yet.
- The `["app", ...]` postMessage save-state bridge is specified in
  PROTOCOL.md but not implemented.
- ArkDrive uses **PBKDF2 100k**; Argon2id is documented as the upgrade
  path, not implemented.
- Hugging Face upload shape is flagged UNVERIFIED in code and PROTOCOL.md.
- Phase 4a's availability check fetches plain `registry.json` — shard
  repos must publish that plain mirror alongside the canonical
  `registry.json.zst`, or the check must route through `zstd.ts`
  decompression.
- Directory-shard layout vs REPO-TOPOLOGY.md (per-category repos vs
  `directory-<category>.json.zst` at protocol-root) is not yet
  reconciled — confirm at first central-repo creation.
- IndexedDB stores (mail, drive, search, keyring) are typechecked and
  unit-tested with in-memory stores; the IndexedDB implementations
  have not been run in a real browser session yet.
- Panel action wiring is view-level for some flows: mail sending stays
  disabled until the contacts directory has a recipient key and a
  signed-in GitHub account; ArkDrive file upload/download UI is the
  vault-open + file-list surface, with drag-and-drop upload as the
  next step; comments posting needs sign-in + a real site repo.

### Still genuinely missing (not built)

- Windows `.exe` / Android `.apk` builds.
- Central repos + Muse GitHub App selection + OAuth App (blocked on
  Stanley's go-ahead to create repos — nothing was created in this
  program, by his 15:10 instruction).
- `arknetz://` deep-link registration (Tauri config pending).
- No live session QA (see above).

### Excluded by Stanley — not gaps, out of scope

- No AI builder, no MCP server, no x402 payments ("AI Builder can be
  skipped entirely, no AI built in", 2026-11-20).
- No Fediverse / ActivityPub, no RSS / `feed.xml` (both rejected).
- No Gmail / SMTP bridge (mail is protocol-native only, by design).
- No GPL dependencies (MIT/BSD/Apache only).

---

# Fix round 2 — 2026-11-20/21 (Stanley 16:38: "Fix more first, and actually you can do both AppImage and .Deb")

**Nothing was created or pushed on GitHub in this program either.** No repos, no OAuth App, no GitHub writes of any kind.

## Verified state (after round-2 integration)

- `npx tsc -p tsconfig.json --noEmit`: clean, exit 0.
- `npm run build`: passes (tsc + asset copy).
- `npm test`: **388 tests, 388 pass, 0 fail** (was 320 after round 1).
- All tests mock network (injected mock fetch). **No test hits real GitHub or real Internet Archive.**
- Tauri Linux rebuild: see "Tauri build (round 2)" below.

## Per-item status

1. **AppImage + .deb — DONE, both produced fresh.** AppImage packaging
   stalled in round 1 because this VM has **no `/dev/fuse`**
   (fuse3 + fusermount exist, but no device node; `mknod` not
   permitted, `modprobe fuse` module not found), and the AppImage form
   of appimagetool needs FUSE to mount itself, so it hangs at 0 CPU.
   The fix: run the already-extracted appimagetool at
   `/tmp/appimage_extracted_3e47bb3598c757625f89e196368f9fc3/usr/bin/appimagetool`
   (continuous build 8c8c91f, 2025-12-04) directly on the populated
   AppDir — ~42 seconds, exit 0. AppImages can be **built** here this
   way but never **run/mount-tested** here (needs a machine with
   /dev/fuse). Note: /tmp is ephemeral — if a VM reset deletes the
   extracted copy, re-extract from
   `~/.cache/tauri/linuxdeploy-plugin-appimage.AppImage` with
   `--appimage-extract` (that extraction needs no FUSE). Final sizes
   below, from the rebuild after all round-2 edits landed.
2. **Zstd dictionary — DONE.** Dictionary v1 "v1-corpus-derived",
   26,300 bytes, ID `0x41524B01`, SHA-256
   `9e7346fce69bd694f438c83acced640aba7f804f5901ad4dd932d0d4816b19ae`
   (pinned in code, recomputed by test). Built deterministically from
   the scaffold's own JSON schemas + sample documents. **Honest
   provenance: this is NOT the thread's pre-trained dictionary** — no
   trainer exists in this environment (no `zstd` CLI, no Python
   `zstandard`, no Node trainer); a real trained dictionary replaces it
   as v2 with a new ID. Formatted dictionary (RFC 8878 §5) — a
   raw-content dictionary was proven to mis-decode silently, so the
   decoder checks the ID and a wrong/missing dictionary throws.
   Measured: 158-byte site doc → 69 bytes (122 plain); 191-byte
   registry entry → 37 bytes (128 plain). Pre-dictionary plain frames
   still decompress; 404 → plain-`.json` fallback untouched.
3. **`["app",...]` postMessage save bridge — DONE and wired into the
   shell.** `src/lib/viewer/app-bridge.ts`: per-domain IndexedDB save
   slots, wire shape per PROTOCOL.md §7, `delete`/`list` now the fixed
   op names, replies `saved`/`loaded`/`deleted`/`listed`/`error` with
   echoed `requestId`. Three auth checks, all required: origin
   `"null"`, per-iframe session id baked into that iframe's srcdoc
   only, and the `event.source` the parent created (first valid message
   binds it). Unauthenticated messages dropped silently; authenticated
   but invalid payloads get an `error` reply and write nothing. Limits:
   slot ≤ 64 KiB, ≤ 16 slots/domain, slot-name regex, plain-JSON state
   (max depth 64). The iframe exposes exactly
   `window.ArkNetzSave = { save, load, delete, list }` — no
   indexedDB/localStorage/fetch/cookie/OAuth references in the shim.
   Wired in `src/main.ts` (`renderSiteWithSaveBridge`, one bridge per
   domain, sessions revoked on re-render, listener installed once per
   bridge) via the new `createAppBridgeTokensForSite()` helper — only
   id'd srcdoc app blocks get a session; URL-sourced apps get no shim.
   19 bridge tests + 1 tokens-helper test. Deliberately not done:
   per-slot rate limiting / replay window for `requestId`s (replaying a
   save just re-saves the same state into the same domain's slot, which
   the sid+source binding already confines); no quota UI.
4. **X25519 mail keys — DONE, adopted.** RSA-OAEP-2048 replaced with
   X25519 (ECDH) + HKDF-SHA-256 + AES-KW wrapping (fresh ephemeral
   keypair per recipient; all-zero shared secrets rejected; bare
   KDF-derived keys deliberately rejected). **Measured wrapped-key
   entry: 72 bytes** (32 ephemeral + 40 AES-KW) — the thread's ~64 did
   not count AES-KW's 8-byte integrity value; 72 is the sound minimum
   for an authenticated wrap. **Contacts: ~35.3 MiB per 1M users in the
   stored `.json.zst` form** (37.0 bytes/entry measured on 2,000 real
   entries) — the thread's ~40 MB holds for compressed storage, not
   for uncompressed JSON (157.4 MiB/1M; raw keys alone are 32 MB/1M).
   Engine floor: standard `{ name: "X25519" }` (Chrome/Edge 133+,
   Firefox 130+, Safari 17+); the old `{ name: "ECDH", namedCurve:
   "X25519" }` form fails in this Node. No migration needed: v1 never
   shipped, no envelopes exist in the wild.
5. **ArkDrive drag-and-drop upload — DONE and wired into the panel.**
   Drop → existing upload path only (Zstd → 10 MB split → SHA-256
   dedup → AES-256-GCM encrypt → backend → manifest). Folder drops keep
   relative paths; empty folders preserved; duplicate content deduped
   (0 new chunks); duplicate names a per-file error; `..` refused;
   one bad file doesn't stop the rest; per-file progress
   (queued → chunking → encrypting → uploading → done / error). **Real
   bug fixed:** a failed blob write used to leave a phantom chunk
   record, so a retry would report the chunk as deduped while the blob
   was never stored — `uploadFile` now snapshots the manifest and
   rolls back on failure (proven by a fail-once test). Wired in
   `src/lib/panels.ts`: the drive panel shows a drop zone once a vault
   is open (not before), binds `bindDriveDropZone` to the open vault,
   refreshes the file list after each drop. Sequential uploads in drop
   order (avoids concurrent manifest writes); no auto-retry (the error
   row invites a re-drop).
6. **Large-list mail outbox — DONE, real writer.** Payload stored once
   (`buildLargeListOutbox` / `deliverLargeList`), one shared pointer
   object, one 72-byte wrapped key per recipient; recipients deduped;
   a member with no wrapped key throws instead of being silently
   dropped; payload verified (byte-length + SHA-256 + messageId)
   before decrypting; store idempotent for retries. **Measured on a
   55-recipient send: payload 12,694 bytes stored once** (vs 698,170
   if duplicated); **pointer JSON 316 bytes, not the thread's 120**
   (full-length ids) — reported honestly, pointer shape unchanged.
7. **Directory-shard layout — DONE, reconciled.** Per-category repos
   are right (REPO-TOPOLOGY.md §8, Stanley-approved); the old code
   fetched `directory-<category>.json(zst)` from protocol-root, where
   no directory file ever lives, so every shard fetch would 404 and
   search would silently index nothing. Search now fetches from
   `arknetz-directory-<category>` repos; a shard whose `category`
   field mismatches the request throws. Not done: manifest-discoverable
   categories — `ProtocolManifest` has no `directoryCategories` field,
   so that needs a protocol change; the documented default list
   (`tech`, `cinema`, `games`) stands until then.
8. **Availability check — DONE, .zst-first.** The check now reads the
   canonical `registry.json.zst` first (decompressed via the §4
   dictionary path), plain `registry.json` only on `.zst` 404 — because
   the plain mirror is a secondary artifact a direct Root Master write
   can omit, and a missing mirror would then read as "available" for a
   domain that is actually taken. Corrupt `.zst` throws, never falls
   back; an entry whose `shard` disagrees with SHA256(domain) throws.
   `protocol/register.yml` needed no change — it already commits both
   files on every claim. Decision recorded in PROTOCOL.md §3.1.
9. **HF upload shape — DONE, verified against docs.** The old
   implementation was wrong in three of four operations — it invented
   endpoints that do not exist on the Hub (`PUT …/upload/…`,
   `DELETE …/delete/…`, `/api/…/resolve`). Rewritten in both places
   (`src/lib/drive/huggingface.ts` — full client incl. LFS batch →
   presigned PUT → verify → commit `lfsFile` — and
   `src/lib/network/backends.ts` — preupload → NDJSON commit for
   regular files; the generic layer fails loudly on LFS instead of
   guessing, because its fetch shape carries string bodies only and
   the LFS PUT needs raw bytes; the vault client is the full LFS
   implementation). Sources: huggingface_hub `_commit_api.py`,
   `lfs.py`, `file_download.py`; @huggingface/hub `commit.ts`,
   `list-files.ts`; Hub upload docs. **Live behaviour still
   UNVERIFIED** — no HF account/token exists here and none was used;
   server error bodies, the preupload size threshold that flips a file
   to LFS, and multipart-transfer responses are unconfirmed against a
   live account. PROTOCOL.md §8 updated to the verified shape.

## Integration work (coordinator, this round)

- `src/lib/panels.ts`: drive drop-zone wiring (vault handle + file list
  kept in panel state; drop zone shown only once a vault is open;
  `bindDriveDropZone` → `uploadDroppedFiles` → refresh + rerender).
  One test added (drop zone present iff a vault is open).
- `src/lib/network/backends.ts`: HF write rewritten to the verified
  preupload → NDJSON commit shape (regular files); LFS refused loudly
  with a pointer to the vault client. Two tests added (regular flow
  with exact URL/method/header/body assertions; 401 mapping + LFS
  refusal).
- `src/lib/viewer/app-bridge.ts` + `src/main.ts`: shell wiring for the
  save bridge (`createAppBridgeTokensForSite` helper + 1 test;
  `renderSiteWithSaveBridge` in the reader for the demo site, loaded
  sites, and the editor-closed re-render; falls back to the plain
  render on any failure). The editor preview renders without a bridge
  (no save API there), as before.
- `PROTOCOL.md` updated for all of the above: dictionary v1 (§4),
  X25519 construction + 72-byte wrapped keys (§6.1), contacts measured
  size (§3.5, §5), large-list pointer 316 bytes (§3.11, §6.1), save
  bridge implemented with `delete`/`list` fixed (§7), directory shards
  in per-category repos (§3.6), availability .zst-first (§3.1), HF
  preupload/commit shape (§8).

## Tauri build (round 2)

- Final rebuild after all round-2 edits landed (2026-11-21 ~01:00 UTC,
  `tauri build` exit 0, 4m 08s): **binary 11,499,472 bytes; `.deb`
  4,211,172 bytes; `.rpm` 4,216,036 bytes; `.AppImage` 83,085,816 bytes
  (79.24 MiB)**, all timestamped 01:02–01:03 UTC in
  `src-tauri/target/release/bundle/`. Notably, this time `tauri build`
  produced the AppImage itself — the round-1 stall did not recur, so
  no separate appimagetool run was needed. The AppImage was verified by
  `--appimage-extract` (exit 0; payload contains `AppRun` and
  `usr/bin/arknetzwebweaver`); it was **not** launch-tested (no
  /dev/fuse in this VM — see item 1). The earlier 83,012,088-byte
  AppImage from the extracted-tool run was superseded by this fresh
  one. `dpkg-deb --info` confirms package `ark-netz-web-weaver` 0.1.0
  amd64.

## Honest gaps — updated (what round 2 did NOT close)

- Everything from round 1's "mock-verified only" list still stands:
  no live GitHub round-trips, no real IA uploads, no OAuth App, no
  central repos at all, no live interactive QA session, no Lighthouse
  run, no Windows `.exe` / Android `.apk`, no `arknetz://` deep-link
  registration.
- **AppImages can be built here but never run/mount-tested here** (no
  /dev/fuse in this VM) — the fresh AppImage is verified by extraction
  only, not by launching it.
- **HF live behaviour still UNVERIFIED** (see item 9): shape verified
  against docs/SDK sources, but no live upload/download has ever run
  against a real HF account.
- **Dictionary v1 is corpus-derived, NOT pre-trained** (see item 2) —
  a real trained dictionary would be v2 with a new ID.
- **Manifest-discoverable directory categories** need a protocol
  change (`ProtocolManifest.directoryCategories`); the documented
  default list stands until then.
- ArkDrive still uses **PBKDF2 100k**; Argon2id is the documented
  upgrade path, not implemented. IndexedDB stores are typechecked and
  unit-tested with in-memory stores; the IndexedDB implementations
  have not been run in a real browser session yet.
- **Fork / Root Master boundary** and **standards-proof scope** are
  still open decisions for Stanley (see READINESS-PARITY.md).

---

# Fix round 3 — QA (Lighthouse + live interactive QA), 2026-11-20/21

**Nothing was created or pushed on GitHub in this workstream.**
No repos, no OAuth App, no GitHub writes of any kind. The live-QA
drive stubbed `api.github.com` at the network layer (404), so no
request to GitHub left the machine at all. No IA upload was
attempted: per Stanley's 2026-11-20 17:16 correction, a real IA
upload uses the individual user's own IA keys via the in-app linking
flow — never Stanley's keys, never a shared key — and no test
account's keys were available, so IA upload is recorded as "needs a
test account's own keys" (not attempted, keys not requested).

## Environment (verified this round)

- No Chrome/Chromium/Firefox in PATH; `xvfb-run` + Xvfb work; no
  `/dev/fuse`; no `zstd` CLI. BUT a Chrome binary **was** present in
  the Puppeteer cache: Google Chrome for Testing 156.0.8078.47 at
  `~/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome`
  (plus a `chrome-headless-shell` build). Lighthouse 13 and
  `puppeteer-core` were `npm install`ed into `/tmp/arknetz-lh/`
  (ephemeral scratch, not committed) and pointed at that binary —
  that is how both halves below ran. To re-run: serve a directory
  with `python3 -m http.server`, set `CHROME_PATH` to the cached
  binary, and run `lighthouse` / the `qa.mjs` driver from
  `/tmp/arknetz-lh/` (re-create it if /tmp was wiped; the steps are
  in this section).

## 1. Lighthouse — 100 / 100 / 100 / 100 (after fixes)

Method: the exported site is the app's own static export —
`exportStaticFiles(DEMO_SITE)` (`welcome.arknetz`, the bundled demo
site) via the compiled `dist/` build, served over plain HTTP on
localhost. Lighthouse 13, Chrome 156 headless, categories
performance / accessibility / best-practices / SEO, run on `/` and
on `/about/`.

**Before fixes (first run, `/`): Performance 100, Accessibility 96,
Best Practices 96, SEO 90.** The three failing audits were all
controlled by the export code:

- `landmark-one-main` (0) — page body had no `<main>` landmark.
- `meta-description` (0) — no meta description.
- `errors-in-console` (0) — the browser requested `/favicon.ico`
  and got a 404.

**Fixes (all in `src/lib/export.ts`, with a regression test in
`tests/builder.test.ts`):**

- Every exported page now wraps its body in `<main>`.
- Every page gets `<meta name="description">`, derived from the
  document's own text (hero subtitle → first paragraph → first
  heading, truncated to 160 chars, escaped; falls back to the
  title, never empty) — `docDescription()`. `SiteDocument` has no
  description field, so nothing is invented.
- The export ships a real `favicon.svg` (blue rounded square, white
  "A") and links it (`<link rel="icon" type="image/svg+xml">`), so
  no favicon 404 is ever logged.

**After fixes (second run): Performance 100, Accessibility 100,
Best Practices 100, SEO 100 on `/`, and 100/100/100/100 on
`/about/` too.** Remaining sub-1.0 entries in the report are
Lighthouse *insights*, not scored audits, and none of them moves a
category below 100: `cache-insight` (the throwaway `python
-m http.server` sends no `Cache-Control` — a hosting concern, not
an export concern), `render-blocking-insight` (the 1.9 KB
`style.css`; Performance is still 100), `document-latency-insight`,
`network-dependency-tree-insight`, `forced-reflow-insight`. No
audit was waived or hidden; the export controls nothing further
that would change these.

## 2. Live interactive QA — first real browser session (partial)

Two routes were tried.

### (a) The Tauri binary under Xvfb — runs, cannot be driven here

`./src-tauri/target/release/arknetzwebweaver` under `DISPLAY=:97`
(Xvfb, 1280x800) **launched and stayed running for the full 20 s
observation window** (killed by `timeout`, exit 124 — i.e. it did
not crash or exit on its own). Its only output was two harmless
`libEGL warning: DRI3 error` lines (software-rendering fallback;
Xvfb has no DRI3). An earlier `xvfb-run -a` attempt exited in
0.35 s with exit 1 and no output; Xvfb itself was verified working
afterwards, so that first failure was the `xvfb-run` wrapper, not
the app — the direct-Xvfb run is the result that stands. **But the
session could not be seen or driven:** no screenshot tool exists
here (`xwd`/`import`/`scrot` all absent), and the release build
exposes no devtools port or WebDriver (`tauri.conf.json` sets
none; Tauri release builds disable the inspector). So the Tauri
WebView is confirmed *launchable* here and nothing more. A machine
with a real display (or a debug/dev build with devtools enabled
plus a screenshot tool) is what would run a visual Tauri session.

### (b) The built frontend in headless Chrome — 21/21 steps pass

`dist/` served on localhost, driven by `puppeteer-core` + the
cached Chrome 156 (`/tmp/arknetz-lh/qa.mjs`, results in
`/tmp/arknetz-lh/qa-results.json`, screenshots
`qa-reader.png` / `qa-editor.png` / `qa-mail.png` /
`qa-drive.png`). **21 steps, 21 pass, 0 fail; 0 console errors,
0 page errors, 0 failed requests** (second run, after the fixes
below; the first run had exactly one console error — the shell
favicon 404 — which is bug #3). What actually ran and was
observed:

- App loads as guest: demo site renders ("Welcome to
  ArkNetzWebWeaver"), Guest badge present. Screenshot inspected:
  shell chrome, tabs, address bar, demo-site notice, IA settings
  panel all render correctly.
- Visual builder: "✎ Edit site" opens the editor; `/h2 Live QA
  heading` in the slash box inserts a block that appears in the
  live preview; closing the editor re-renders the reader with the
  new block. Screenshot inspected: block toolbar, canvas, and live
  preview all render.
- All 13 panels mount with real content (Browse, Builder, Mail,
  ArkDrive, Search, Comments, Watch, Offline, Domains,
  Moderation, Accounts, Time Machine, Settings).
- Sign-in refuses loudly and correctly: "GitHub OAuth is not
  configured: GITHUB_OAUTH_CLIENT_ID is empty…" (no OAuth App
  exists — by design).
- Export .zip downloads a real file (`welcome.arknetz.zip`,
  8,348 bytes); unzipped and verified to contain `style.css`,
  `favicon.svg`, `index.html` (with `<main>` + meta description),
  `about/index.html`.
- Drive vault open without a token now reports: "A GitHub token is
  required — sign in with your own GitHub account first. ArkDrive
  never uses a shared token." (That guard landed in
  `src/lib/panels.ts` from a sibling round-3 workstream during
  this run; it fires before any fetch, so the live path no longer
  reaches the fetch layer. The fetch bug below is still proven
  fixed by its unit regression test, which drives
  `openVault` → `vault.open` through the default fetch path.)

**What did NOT run live (precise blockers):**

- **Mail send** — needs a signed-in GitHub account, a recipient
  key in the contacts directory, and the central repos; none
  exist. Panel mounts and describes the flow; no send was
  attempted.
- **ArkDrive upload/download** — needs a real backend token +
  repo (the vault-open guard above refuses without one, by
  design). Drag-and-drop upload remains unit-tested only.
- **IA upload (stealth media)** — needs a test account's own IA
  keys via the in-app linking flow (Stanley 17:16 correction);
  no keys were available, none were requested, no shared/master
  key was used. The IA settings panel renders and states keys
  are encrypted on-device under the user's passphrase.
- **Tauri WebView interaction** — see (a): no display capture,
  no devtools/WebDriver in the release build.
- IndexedDB stores ran only in-memory in tests; this browser
  session exercised the app's IndexedDB-backed stores only as
  far as guest browsing + editor autosave paths go (no errors
  observed).

## 3. Bugs found by this QA and fixed

1. **Export failed three Lighthouse audits (96/96/90 → 100×4).**
   `src/lib/export.ts`: `<main>` landmark, derived meta
   description, shipped `favicon.svg`. Regression test:
   "static export: main landmark, meta description, and a real
   favicon" in `tests/builder.test.ts` (also asserts the
   description cap and the title fallback). No test was weakened.
2. **App's default fetch was detached — every fetch-backed call
   through `createArkNetzApp()` threw in a real browser.**
   `src/lib/app.ts:111` stored `globalThis.fetch` bare. In
   browsers `fetch` is a `Window` method, so the detached
   reference throws `TypeError: Failed to execute 'fetch' on
   'Window': Illegal invocation`; in Node, `fetch` is
   unbound-safe, so all 388 unit tests passed while the live
   vault-open path showed the raw TypeError in the panel status
   (first QA run). This affected mail delivery and every vault
   backend, not just Drive — `main.ts` calls `fetch(...)`
   directly and was unaffected. Fixed by wrapping the default so
   the call is always a method call on `globalThis`. Regression
   test: "app: default fetch works when fetch enforces its
   receiver (browser-like)" in `tests/app.test.ts` — swaps in a
   receiver-enforcing stub fetch, opens a vault through the
   default path, and asserts the failure is a real HTTP 404,
   never "Illegal invocation". No test was weakened.
3. **Shell loaded with a `/favicon.ico` 404 console error on
   every launch.** `src/index.html` declared no icon.
   Fixed: `src/favicon.svg` (same mark as the export),
   `<link rel="icon" ... href="./favicon.svg">` in
   `src/index.html`, copied by `scripts/copy-assets.mjs` into
   `dist/favicon.svg`. Regression test: "shell: index.html links
   a favicon that ships with the app" in `tests/app.test.ts`
   (reads the dist copies, same convention as the
   `protocol/register.yml` test). Verified live: second QA run
   logged 0 console errors and `GET /favicon.svg` returned 200.

## Verified state (after round-3 QA)

- `npx tsc -p tsconfig.json --noEmit`: clean, exit 0.
- `npm run build`: passes (tsc + asset copy, incl. favicon).
- `npm test`: **413 tests, 413 pass, 0 fail.** (Round-2 baseline
  was 388; +3 are this workstream's regression tests, +22 are
  sibling round-3 workstreams' tests that landed during this run —
  the count moved 405 → 413 between the two final runs as siblings
  landed more.)
- Lighthouse on the app's own static export of the bundled demo
  site: **100 Performance / 100 Accessibility / 100 Best
  Practices / 100 SEO** (`/` and `/about/`).
- Live browser QA: **21/21 steps pass, 0 console errors, 0 page
  errors, 0 failed requests** (headless Chrome 156, `dist/`
  served on localhost; Tauri binary launch-verified under Xvfb
  but not visually driven — see (a) above).

## Honest gaps — updated (what round 3 QA did NOT close)

- Still no live GitHub round-trips, no real IA uploads, no OAuth
  App, no central repos, no Windows `.exe` / Android `.apk`, no
  `arknetz://` deep-link registration (that last item was being
  worked by a sibling round-3 workstream during this run — see
  `deep-link.test.ts`; its status is theirs to report).
- Live mail send, ArkDrive upload/download, and IA upload remain
  unverified end to end — each needs real accounts/keys/tokens
  and central repos, as listed in §2 above.
- The Tauri WebView has still never been seen or clicked through
  in a live session anywhere; this round proves the binary
  launches under Xvfb and the frontend works in Chrome, which is
  not the same thing.

---

# Fix round 3 — GitHub (2026-11-20/21, Stanley 17:08: "Get all of the missing stuff fixed")

**Authorised by Stanley 2026-11-20 17:08, after two "fix first" deferrals.
This section is the GitHub workstream's record. Nothing in this section
was created on GitHub — see the blocker below. The parallel local-fix
agent was still editing the scaffold while this ran (see "Scaffold state").**

## Blocker — repos could NOT be created via the connector (verified, not assumed)

- Connector: `/opt/hatch/bin/github status` → `connected`,
  authenticated as **`PropTheRtRevDrSirStanleyG05` (id 268819959)**,
  verified by `get_me` in this round. Read access works: `get_file_contents`
  on `PropTheRtRevDrSirStanleyG05/STANBEYOND-Labs-Calculator/README.md`
  succeeded, so the Muse GitHub App installation has at least that repo
  selected.
- `create_repository` for `ArkNetzWebWeaver` (public, MIT) returned, after
  approval:
  `failed to create repository: POST https://api.github.com/user/repos: 403 Resource not accessible by integration`.
  **Cause: a GitHub App installation token cannot create repositories under
  a user account** — the REST `POST /user/repos` endpoint needs a user
  OAuth/PAT credential, which the connector must never collect (connector
  doc: never ask for tokens, never run `gh auth login`/device auth/PATs).
  No further create attempts were made: the 403 is an authorization
  failure, not a schema error, and retrying it would not change the outcome.
- **What Stanley (or the main agent, in the browser) must do instead:**
  create the 43 repos below in the GitHub web UI (all public, MIT licence),
  then select them for the Muse GitHub App installation. Installation link
  (from `github install-url` this round):
  `https://github.com/apps/meta-muse-ai/installations/new`
  — after the repos exist, open it and select all 43 so the connector can
  read/write them. **Do not claim App access to any repo until a read-back
  verifies it** (the Calculator read above is the only access verified so
  far).
- Repo creation and the push therefore remain **unblocked work for a human
  + browser session, not for this connector**. Everything below is staged
  and ready so that session is mechanical.

## Repos to create (43, all public, MIT, under PropTheRtRevDrSirStanleyG05)

- Client: `ArkNetzWebWeaver`
- Protocol: `arknetz-protocol`, `arknetz-protocol-root`
- Registry shards (16): `arknetz-registry-00` … `arknetz-registry-0f`
- Moderation: `arknetz-moderation`
- Contacts shards (16): `arknetz-contacts-00` … `arknetz-contacts-0f`
- Feed (current month): `arknetz-feed-2026-11`
- Directory categories (3): `arknetz-directory-tech`,
  `arknetz-directory-cinema`, `arknetz-directory-games`
- Shared: `arknetz-actions`, `arknetz-mirrors`, `arknetz-website`

No repo URL can be listed yet — none exists. (The account currently holds
only 3 public repos: `STANBEYOND-Labs-Calculator`,
`STANBEYOND-Labs-StudyForge`, `stanbeyond-media`, confirmed by
`search_repositories user:PropTheRtRevDrSirStanleyG05` this round.)

## Seed content — staged, ready to push (no GitHub writes made)

Staging tree: `~/workspace/arknetzwebweaver/github-seed/` — **190 files,
~1 MB**, built by `github-seed/BUILD-SEED.mjs` (re-runnable). Test/seed data
only, no real user content. Per repo:

- `arknetz-protocol-root/manifest.json` — protocolVersion `0.1.0`,
  `defaultRootRepo` `PropTheRtRevDrSirStanleyG05/arknetz-protocol-root`,
  master `PropTheRtRevDrSirStanleyG05`, 16 registry + 16 contacts shard
  lists, `directoryCategories` ["tech","cinema","games"] (additive manifest
  field — closes round 2's "manifest-discoverable categories" gap; older
  clients ignore unknown fields), `feedShards` ["arknetz-feed-2026-11"],
  mirrors, `zstdDictionary` {version 1, url, sha256}.
- `arknetz-protocol/` — `PROTOCOL.md` (copied from the scaffold, v0.1.0),
  `schemas/*.json` (6 JSON Schemas derived from PROTOCOL.md §3 — registry
  entry, site document, contacts entry, directory card, feed pointer,
  protocol manifest; the spec text is authoritative), Zstd dictionary v1
  as `zstd-dictionary-v1.bin` **and** `zstd-dictionary-v1.b64`.
- `arknetz-actions/.github/workflows/` — `register.yml` (copied from
  scaffold `protocol/register.yml`), `cleanup.yml` (monthly squash
  template — schedule commented out until the Root Master reviews it, see
  file header), `stats.yml` (nightly VIEW_PING rollup template for site
  repos).
- Registry shards ×16 — `registry.json` (`{}`), real `registry.json.zst`
  (15 bytes, round-trip verified), `.github/workflows/register.yml`,
  README. Contacts shards ×16 — `contacts.json` (`{}`), real
  `contacts.json.zst` (15 bytes, round-trip verified), README.
- `arknetz-moderation/` — `moderation.json` / `moderation.json.zst`
  (`{"patches":[]}`, 27 bytes, round-trip verified).
- `arknetz-feed-2026-11/` — `feed-2026-11.json(.zst)`
  (`{"month":"2026-11","pointers":[]}`), `feed-index.json(.zst)`.
- Directory repos ×3 — `directory-<category>.json(.zst)` (`{"cards":[]}`).
- `arknetz-mirrors/` — README only: **no mirrors configured yet** (no
  GitLab/Codeberg mirror accounts exist; the mirror Action has never run).
- `arknetz-website/` — README placeholder only.
- Every seed repo carries the scaffold's MIT `LICENSE`.

## Zstd dictionary — v1 published in seed (no v2 appeared)

- Checked the scaffold immediately before copying: `src/lib/zstd.ts`
  still has `ZSTD_DICTIONARY_VERSION = 1`, label `v1-corpus-derived`, ID
  `0x41524B01`. **No dictionary v2 appeared while this ran — nothing was
  overwritten.**
- Dictionary bytes regenerated from the scaffold's own code
  (`getZstdDictionary()`): **26,300 bytes, SHA-256
  `9e7346fce69bd694f438c83acced640aba7f804f5901ad4dd932d0d4816b19ae`** —
  matches the value pinned in `zstd.ts` and `PROTOCOL.md` §4.
- Seed `.zst` files were compressed with the scaffold's own
  `compressJson` (dictionary path) and decompressed back successfully
  before staging.

## Client repo push — planned, NOT executed (no repo exists yet)

- Intended route: the connector's `push_files` snapshot (see connector
  doc `references/snapshot-push.md`), never a force-push, never a PAT.
  Snapshot limits (2,000 files / 16 MiB UTF-8, no binaries) fit the
  source tree: **111 files, 1.68 MB** excluding `node_modules`,
  `src-tauri/target`, and `dist` (regenerable build output — excluded).
- One binary cannot go in a snapshot: `src-tauri/icons/icon.png` — it
  must be added afterwards via `create_or_update_file` (base64) or the
  GitHub web UI, and the push must be verified by reading the tree back.
- **No commit SHA exists** — nothing was pushed. The SHA will be recorded
  here when the push lands.
- **Scaffold state at push-prep time:** the parallel local-fix agent was
  actively editing during this round (files modified after 01:09 UTC
  2026-11-21: `src/lib/export.ts`, `src/lib/deep-link.ts`, `src/main.ts`,
  `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
  `src-tauri/gen/schemas/*`, `tests/builder.test.ts`,
  `tests/deep-link.test.ts`). Any push must re-check the tree and push
  the latest state — the 388-pass figure from round 2 predates these
  edits and was **not** re-run in this round. `OAUTH-APP-SETUP.md` (below)
  is the only file this workstream added to the scaffold.

## GitHub App installation — selection status

- **Not verified for any arknetz repo: none exist yet.** The only verified
  App access is a read of `STANBEYOND-Labs-Calculator`. After the 43 repos
  are created in the web UI, Stanley must select **all 43** at
  `https://github.com/apps/meta-muse-ai/installations/new`, and each repo
  must then be verified by a read-back before any write is attempted
  against it.

## OAuth App — NOT created (cannot be created via API)

- Prepared in `OAUTH-APP-SETUP.md` at the scaffold root (also to be
  committed into `ArkNetzWebWeaver` with the push): app name
  `ArkNetzWebWeaver`, homepage
  `https://github.com/PropTheRtRevDrSirStanleyG05/ArkNetzWebWeaver`,
  callback `arknetz://oauth/callback`, scopes `read:user public_repo`,
  exact web-UI steps, client ID → `src/lib/config.ts`
  `GITHUB_OAUTH_CLIENT_ID`, client secret → runtime env
  `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET` only, never in the bundle/repo.
- **No client ID or secret exists or was invented.** Sign-in does not work.
- Code facts quoted in that file (verified from source this round):
  `buildAuthorizeUrl()` sets no `redirect_uri`, so GitHub redirects to
  the App's registered callback URL; `handleRedirect()` exists but nothing
  calls it; the Sign in button only opens the authorize URL; and the
  deep-link listener currently routes `arknetz://` URLs as site addresses,
  so an `arknetz://oauth/callback` return would be silently skipped.
  **The callback receiver (deep-link → `handleRedirect()` →
  `exchangeCode()`) is still to be built** — registering the callback URL
  is step one, not a working sign-in.

## Honest gaps remaining on the GitHub side

- All 43 repos still to be created (web UI) + selected in the App
  installation + verified by read-back.
- All seed content still to be pushed (after repos exist); client push
  still to be executed and verified (commit SHA: none yet).
- OAuth App still to be created (web UI) + client ID wired + receiver
  built + manual sign-in test passed.
- Mirrors (GitLab/Codeberg) still unconfigured; no mirror Action has run.
- `arknetz://` deep-link registration: the parallel agent's round-3
  `src/lib/deep-link.ts` exists in the scaffold, but per its own header
  nothing was launch-tested and Android is config-only.

---

# Fix round 3 — per-user keys (2026-11-20, Stanley's correction 17:16)

**Correction:** "a real IA upload is done with INDIVIDUAL user IA keys.
Everyone will not use Stanley's keys; that is what the sign-in flow for
all backends is for." Applied to every backend: no master/shared keys
anywhere; each user signs in with their own account for
`gh:` / `gl:` / `cb:` / `ia:` / `hf:` / `wm:` (and `ipfs:` Filebase keys
when that flow lands). **Nothing was created or pushed on GitHub in this
program either. No credential of any kind (Stanley's, test, or otherwise)
was used, requested, or stored — no credential appears in any file, log,
or report from this round.**

## Verified state (after this round)

- `npx tsc -p tsconfig.json --noEmit`: clean, exit 0.
- `npm run build`: passes (tsc + asset copy).
- `npm test`: **413 tests, 413 pass, 0 fail** (was 388; +25 new tests in
  this round, all mock-network — no test hits real GitHub or real IA).
- PROTOCOL.md updated: per-user key rule stated explicitly (§1
  principle 8, §6.4, §8, changelog).

## 1. Per-user key audit — findings

Searched the whole scaffold (`src/lib/**`, `src-tauri/src/main.rs`,
`protocol/`): no hard-coded key/secret/token anywhere; `config.ts`
holds no secrets (empty `GITHUB_OAUTH_CLIENT_ID`, secret only via the
Tauri env var `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET`, `not_configured`
without it); the Root Master name `PropTheRtRevDrSirStanleyG05` appears
only as an AUTHORIZATION/identity check (`moderation.ts`,
`network/accounts.ts` `isMasterAdmin()`, `config.ts`) — never as a
credential, and it was left untouched as instructed.

**Already correct (verified, no change):** `ia-media.ts` `attachMedia`
(null keys → `ia_not_linked`, no upload); `ia-settings.ts` (per-user
encrypted store, secret never in status/logs); `network/backends.ts`
(`gh:`/`gl:`/`cb:`/`hf:` writes throw without a token);
`publish.ts` (throws without a token); `auth.ts` (no fake tokens);
`network/accounts.ts` (per-account encrypted keyring, per-site
auto-binding throws on a missing bound account instead of falling
back to the active account); `drive/pooled.ts` (per-account binding
enforced); `mail/inbox.ts` (close-call only built when a token is
present); comments (read-only path, no write client), Wayback Save
Page Now (public archiving, no credential by design), stats VIEW_PING
(local counters only; the module never creates Issues).

**Three real findings — all fixed in the implementation (not the tests):**

| # | File(s) | Finding | Fix |
|---|---|---|---|
| F1 | `src/lib/drive/github.ts` (`GitContentsClient`, incl. Codeberg), `src/lib/drive/gitlab.ts`, `src/lib/drive/huggingface.ts` | Vault clients took `token?` and silently omitted the auth header when it was absent (`if (this.token) …`), then sent the request anyway. Private vault repos would fail with an ambiguous provider 401/404, and a mis-pointed public repo could even be read unauthenticated. | `requireOwnToken()` at the top of every operation: `gh`/`cb` (all 4 methods, via `getEntry` + `listBlobs`) and `gl` (all 4 methods) refuse with a `DriveBackendError` (`auth_failed`) naming the provider — "sign in / link your own <provider> account first … no shared or master vault token" — before any network call. `hf` refuses on `putBlob` (after the open-science check, so the existing personal-files refusal still fires first) and `deleteBlob`; `hf` `getBlob`/`listBlobs` are the deliberate documented exception — open-science Hub datasets are public by the Hub's own rules, so reads need no token, writes still do. `src/lib/panels.ts` drive-open now also requires a token in the UI before calling `openVault`. |
| F2 | `src/lib/ia-media.ts` (`uploadToIa`, `attachMedia`), `src/lib/ia-settings.ts` (`testIaConnection`) | `uploadToIa` accepted any `IaKeys` object, including blank/empty fields, and would send an empty `LOW :` header. `attachMedia` with a blank-keys object would have started an upload the same way. | New exported `requireOwnIaKeys()` — `uploadToIa` throws before any network call when any key field is blank ("link your own Internet Archive account … there is no shared IA key"). `attachMedia` treats blank keys as unlinked (`ia_not_linked`, no upload, `onDone` never fires). `testIaConnection` with blank keys returns `{ok:false}` without a network call. |
| F3 | `src/lib/mail/delivery.ts` (`buildDeliverIssueCall`, `buildDeliverPointerCall`, `buildCloseIssueCall`, `buildListInboxIssuesCall`) | Builders accepted an empty sender token and produced a call with an empty `Bearer ` header; `MailDelivery` would then send it. | New exported `requireOwnMailToken()` — all four builders throw on an empty/whitespace token ("protocol mail … needs your own GitHub token — sign in with your own GitHub account first. There is no shared mail token.") before the call is built, so `deliver`/`deliverPointer`/`closeDelivered`/`pollInbox` can no longer send unauthenticated. |

**Test-only alignments (behaviour change, not weakening):** the
Codeberg client test now passes its own token (`cb-test` — it
previously proved the F1 bug by reading without one); the round-3
live-QA `app.test.ts` browser-fetch test now passes its own token to
`openVault` (its intent is the fetch binding, and vault-open without a
token is now refused before the fetch runs).

**Regression tests added (25 new, all mock-network, each asserting zero
network calls on refusal):** `tests/drive.test.ts` — vault clients
refuse get/put/list/delete without a token for `gh`/`gl`/`cb`
(incl. whitespace-only token), HF writes refuse without a Hub token
while public reads stay token-free; `tests/ia-media.test.ts` —
`uploadToIa` refuses blank keys (access/secret/username), `attachMedia`
with blank keys → `ia_not_linked`, thumbnail uploads to the same
monthly item as the photo via the exact S3 URL shape
(`https://s3.us.archive.org/<item>/<file>`) with the user's own LOW
auth; `tests/ia-settings.test.ts` — `testIaConnection` with blank keys
is not-ok with no network call; `tests/mail.test.ts` — all four call
builders throw on an empty token, `deliver`/`pollInbox`/`closeDelivered`
refuse an empty token with no GitHub call.

## 2. Live IA upload verification — NOT performed (blocker recorded)

**Status: needs a test account's own keys.** No live IA upload was
performed, and none is claimed. Exact blocker: a live upload needs a
dedicated archive.org test account's own S3 keys, and no such account
could be created in this environment without Stanley's credentials and
without inventing an identity — archive.org signup requires an email
address the creator controls plus email verification (its signup page
redirects, HTTP 302, to the account flow), and this environment has no
email inbox under agent control and no live browser to complete signup
or any captcha. No keys were asked for, no keys were invented, no
account was created. **What would unblock it:** Stanley (or the parent
agent, in a browser session) creates a throwaway archive.org account,
links it in the app's Settings IA flow, and runs one stealth upload —
or supplies a test account's own keys through the in-app linking flow
only, never in chat/files.

**What was verified instead (mocks + a public read):** the IA path's
URL shapes, LOW-auth header, 429/503 retry with exponential backoff
(max 5 attempts, local copy kept), 403 hard-fail with no retry,
`ia_not_linked` behaviour, thumbnail flow (same item, `-thumb.webp`,
same queue) — all covered by tests above. Connectivity sanity check
only: public `https://archive.org/metadata/nasa` returned HTTP 200 in
0.74 s (a public read, no auth, no upload), confirming the IA endpoint
is reachable from this VM; it proves nothing about uploads.

## Honest gaps — updated by this round

- Live IA upload still unverified (blocker above). Same standing as
  before for live GitHub round-trips, HF live behaviour, OAuth App,
  central repos, live interactive QA, Lighthouse, Windows `.exe` /
  Android `.apk`, `arknetz://` deep-link registration.
- `wm:` / `ipfs:` writes have no dedicated upload flow in the scaffold
  yet (the backend layer refuses generic writes); when those flows
  land they must take the user's own Wikimedia/Filebase keys under
  this same rule — no shared credential.

# Fix round 3 — local fixes (2026-11-20/21, Stanley 17:09: final round)

Four local items, in order. Nothing on GitHub was touched in this
section (no repos, no pushes — another agent owns the GitHub side).
Licence rule held: every new dependency MIT (checked before install).
No AI builder / MCP / x402, no Fediverse, no RSS, no Gmail/SMTP bridge.

Verified state after this round: `npm test` **424 pass, 0 fail**
(baseline in the task was 388; the tree already held 391 when work
started — a concurrent round-3 workstream was editing the same tree,
e.g. a favicon regression test in `tests/app.test.ts` — so 391 is the
honest in-tree baseline for this round, not 388). This round added
25 tests: deep-link 7, drive-kdf 7, zstd-dict-v2 6, item-4 5.
`npx tsc -p tsconfig.json --noEmit` clean; `npm run build` passes.
`cargo check` in `src-tauri` passed (exit 0, 2m 23s) after the
deep-link plugin was added. **`tauri build` SUCCEEDED 2026-11-21
~01:53 UTC** (after installing the missing system webview dev
libraries in this VM — see below): binary 11,409,936 bytes,
`.deb` 4,296,442 bytes, `.rpm` 4.10 MiB, AppImage 82,946,552 bytes
(`src-tauri/target/release/bundle/`). The built .deb's desktop
entry declares `MimeType=x-scheme-handler/arknetz` (verified by
extracting the package) — the OS-level scheme registration is in
the shipped package. One release-build warning (`unused variable:
app` in `src-tauri/src/lib.rs` — the debug-only `register_all()`
block compiles out in release) was fixed by renaming the closure
parameter to `_app`; `cargo check` and `cargo check --release`
are now both warning-free. The bundle artifacts predate that
one-character rename by minutes; it changes no behaviour.
Build-environment note: `cargo` is at `~/.cargo/bin` but NOT on
the default PATH in this shell — the build needs
`PATH="$HOME/.cargo/bin:$PATH"`. The first build attempt failed
at the link stage (`-lgtk-3`, `-lwebkit2gtk-4.1` missing); fixed by
`apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev
libayatana-appindicator3-dev librsvg2-dev`, which first needed a
`libzstd1` downgrade (`1.5.5+dfsg2-2build1.1+hatch1` →
`1.5.5+dfsg2-2build1.1`) to satisfy `libzstd-dev`'s exact pin.
The zstd CLI still reports v1.5.5 after the downgrade.

## 1. `arknetz://` deep-link registration — DONE (wired; launch verification pending)

- `src/lib/deep-link.ts` (new): `DEEP_LINK_SCHEME = "arknetz"`,
  `parseDeepLinkUrl()` (accepts only the `arknetz` scheme with a
  valid domain; query/fragment dropped, credentials rejected),
  `deepLinkToAddress()`, `handleDeepLinkUrls()` (opens valid links
  in order, skips the rest, returns count), `installDeepLinkListener()`
  (feature-detects `window.__TAURI__.deepLink`, calls `getCurrent()`
  at startup + subscribes `onOpenUrl()`, never throws; returns
  `{ status: "installed" | "unavailable" | "error" }`).
- `src-tauri/tauri.conf.json`: added `"withGlobalTauri": true` and
  `"plugins": { "deep-link": { "desktop": { "schemes": ["arknetz"] },
  "mobile": [{ "appLink": false, "scheme": ["arknetz"] }] } }`.
  Rationale: the project has no bundler and no `@tauri-apps/*`
  imports anywhere, so the documented `window.__TAURI__.deepLink`
  path is used instead of importing npm guest bindings.
- `src-tauri/Cargo.toml`: added `tauri-plugin-deep-link = "2"`.
- `src-tauri/src/main.rs`: `.plugin(tauri_plugin_deep_link::init())`
  + `.setup()` calling `register_all()` only in debug builds on
  Windows/Linux (a dev binary can be tested with
  `xdg-open arknetz://…` without a release build hijacking the scheme).
- `src-tauri/capabilities/default.json`: permissions now
  `["core:default", "core:event:default", "deep-link:default"]`.
- `src/main.ts`: imports `installDeepLinkListener`; `init()` calls it
  with `go(address)` (opens the link in the current tab via the
  existing navigation) after `renderCurrent()`, fire-and-forget.
- Tests: `tests/deep-link.test.ts` (7 tests — parse accept/reject,
  round-trip, handle ordering, unavailable when no `__TAURI__`,
  startup URLs + `onOpenUrl` subscription, error reporting).
- Docs: PROTOCOL.md §13 updated with the registration + the exact
  manual check. Tauri deep-link docs (tauri.app/plugin/deep-linking/,
  fetched 2026-11-21 01:10 UTC) confirm the config shape,
  `register_all()` testing path, and permissions.
- **Honest limits:** no single-instance plugin, so on Linux/Windows
  a deep link clicked while the app runs spawns a SECOND process
  (the URL arrives as a CLI argument; that window opens it via
  `getCurrent()`); focusing the running window needs
  `tauri-plugin-single-instance` with the deep-link feature — not
  wired. Android registration is config-only; no .apk built, no
  emulator test. **Launch not yet tested** — a fresh .deb WAS built
  this round (see "Verified state" above) and its desktop entry
  proves the scheme registration ships in the package, but the app
  was not installed and `xdg-open arknetz://…` was not run, so the
  end-to-end click → app opens site path is still unverified.
  Exact manual check (PROTOCOL.md §13): install the built app,
  then `xdg-open 'arknetz://computers.edu'` (Linux) /
  `start arknetz://computers.edu` (Windows) / tap a link on Android,
  and confirm the app opens the site.

## 2. Argon2id for ArkDrive — DONE (implemented, both paths tested)

- Dependency: `@noble/hashes@2.4.0` (MIT, zero dependencies —
  licence verified before install; its `argon2id`/`argon2idAsync`
  exist). Measured ~337 ms per derivation in Node for the chosen
  parameters. Added to `package.json`.
- `src/lib/drive/crypto.ts` (rewritten):
  - Parameters: `ARGON2ID_DEFAULT_PARAMS = { m: 19456, t: 2, p: 1 }`
    (OWASP first-factor recommendation), `ARGON2ID_OUTPUT_BYTES = 32`,
    `ARGON2ID_VERSION = 0x13`.
  - Envelope v2: magic `"ARKV"` + version byte `0x02` + salt (16) +
    m_cost u32 LE + t_cost u32 LE + parallelism u8 + IV (12) +
    ciphertext. Legacy PBKDF2 envelope unchanged: salt (16) | IV (12)
    | ciphertext, no magic; anything not starting with `ARKV` is
    read as legacy (random-salt collision probability 2^-32, and a
    collision would fail loudly at the GCM check).
  - Exports: `VaultKdf` (`"pbkdf2" | "argon2id"`), `deriveVaultKey`
    (PBKDF2, unchanged), `deriveVaultKeyArgon2id`,
    `deriveVaultKeyFor`, `argon2idKeyBytes`, `encryptVaultEnvelope`
    (now Argon2id v2 — new vaults), `encryptVaultEnvelopePbkdf2`
    (legacy, tests/tooling only), `decryptVaultEnvelope` (detects
    KDF, returns `{ plaintext, key, salt, kdf, argonParams? }`),
    `packVaultEnvelope` (legacy), `packVaultEnvelopeV2`,
    `packVaultEnvelopeForKdf`, `unpackVaultEnvelope` (validates
    version byte, rejects zero params), `isArgon2idVaultEnvelope`,
    `resetArgon2idForTests`. The Argon2 loader is environment-aware
    like `zstd.ts` (Node: `import("@noble/hashes/argon2.js"`;
    browser: vendored `../../vendor/noble-hashes/argon2.js`).
  - The account keyring (`src/lib/network/accounts.ts`) and IA keys
    (`src/lib/ia-media.ts`) still use PBKDF2 — out of scope; the
    task covers ArkDrive vaults only.
- `src/lib/drive/drive.ts`: `VaultManager` tracks `kdf` +
  `argonParams`, exposes `get vaultKdf()`; new vaults derive
  Argon2id; `open()` on a legacy PBKDF2 vault re-encrypts the exact
  compressed manifest bytes under a fresh Argon2id key + fresh salt
  and stores it BEFORE assigning in-memory state (a failed migration
  leaves the old envelope untouched and `open()` throws with nothing
  half-migrated); `saveManifest()` packs via
  `packVaultEnvelopeForKdf(this.kdf, ...)`.
- `src/lib/drive/drive-ui.ts`: `HONEST_LIMITS_COPY.encryption`
  updated to Argon2id (19 MiB, 2 iterations, OWASP) + legacy
  auto-migration note.
- `scripts/copy-assets.mjs`: vendors
  `node_modules/@noble/hashes/*.js` to `dist/vendor/noble-hashes/`
  (flat dir, relative imports preserved).
- Tests: `tests/drive-kdf.test.ts` (7 tests — Argon2id determinism +
  OWASP params, new v2 vs legacy envelope round-trips, wrong
  passphrase fails for both, header-param tamper fails + unknown
  version/truncation throw, fresh vault is Argon2id and reopens,
  legacy vault migrates on unlock and upload/download still works +
  reopens as Argon2id, wrong passphrase on a legacy vault fails
  before any migration with stored bytes byte-identical).
- Docs: PROTOCOL.md §6.3 updated (Argon2id is now the vault KDF;
  PBKDF2 legacy + auto-migration on unlock; keyring/IA keys still
  PBKDF2).

## 3. Zstd dictionary v2 — DONE (genuinely trained; mixed results reported honestly)

- Trainer obtained: `apt-get install -y zstd` worked in this VM
  (zstd CLI 1.5.5, root). No `xxd` in the environment (replaced
  with `od` in `train.sh`).
- Corpus: `dict-training/generate-corpus.mjs` (deterministic, seeded
  mulberry32 PRNG), 3,400 files, ~2 MB under `dict-training/corpus/`:
  registry shards (map + entries-array), site documents (every block
  type), directory shards, contacts shards, mail envelopes +
  plaintext, comments, posts, manifests (including the new
  `directoryCategories` field), team, stats, feed pointers,
  delegations, moderation, plus 200 structural-fragment `.txt`
  files (dense JSON key/structure patterns). Prose is generated
  combinatorially from templates + vocabulary, so almost every
  sentence is unique — a deliberate fix after the first v2 attempt
  (see below).
- Training: `dict-training/train.sh` —
  `zstd --train --maxdict=32768 --dictID=1095912194 -o
  zstd-dictionary-v2.bin corpus/*` (decimal 1095912194 =
  `0x41524B02`; `--dictID` takes decimal — an earlier attempt used
  the wrong decimal 1095918082 and produced ID `0x41526202`,
  caught by the header check in the embed script and retrained).
  Trainer: fastcover with zstd's defaults. Also does a CLI
  round-trip sanity check and prints plain-vs-dict sizes per file
  kind.
- **Current trained v2: 32,768 bytes, ID `0x41524B02` ("ARK\x02"),
  SHA-256 `a1786956c8f9b919c393ba27347213c8db48a283615b23bfe03582f92544c96d`**
  (magic bytes `37 a4 30 ec`, ID bytes `02 4b 52 41`). The first
  trained attempt had SHA-256
  `a80d131a1c46ad315161bd78160b776a4ff7e140a36a8a66f6f6d7baa7dab0d6`
  — superseded; do not use.
- `dict-training/embed-dict-v2.mjs`: verifies 32,768 bytes + magic +
  ID, rewrites `ZSTD_DICTIONARY_V2_BASE64` (43,692 chars) +
  `ZSTD_DICTIONARY_V2_SHA256` in `src/lib/zstd.ts`.
  `dict-training/README.md` records command, corpus stats,
  CLI-measured sizes, regeneration steps, versioning.
- `src/lib/zstd.ts` changes: v2 constants
  (`ZSTD_DICTIONARY_V2_VERSION = 2`, `LABEL = "v2-trained"`,
  `ID = 0x41524b02`, `SHA256`, `BASE64`, `CURRENT_*` aliases),
  `getZstdDictionaryV2()`, `getCurrentZstdDictionary()`,
  `resetZstdDictionaryV2ForTests()`; `compressBytes()` now uses v2;
  new `decompressBytesPlain()` (no-dict decompress);
  `decompressBytes()` now tries v2 → v1 → plain, and on total
  failure throws naming both known dictionaries. v1
  constants/functions kept intact for decoding old files.
- Tests: `tests/zstd-dict-v2.test.ts` (6 tests — v2 identity incl.
  SHA-256 + base64 length 43,692; frames carry v2 ID; v2 round-trips
  all doc kinds byte-identical; v1 frames still decode via built-in
  path + explicit v1 API; v2 frames refused by v1 alone +
  unknown-dictionary frame fails naming known dicts; v2 beats plain
  on all docs + beats v1 where measured — see the numbers below).
  Existing tests updated (deliberate behaviour change, not
  weakening): `tests/zstd.test.ts` (header comment, v2 ID pins,
  wrong-dictionary fake IDs changed to `0x41524b09` — CRITICAL:
  `0x41524B02` can no longer be used as a fake ID since it is the
  real v2 ID; a fake dict sharing a real ID would make the built-in
  path try wrong content under a matching ID; error regex
  `/v1-corpus-derived/` → `/v2-trained/` where the built-in path is
  exercised) and `tests/zstd-registry.test.ts` (served frames now
  carry v2 ID; wrong-dict fake ID likewise `0x41524b09`).
- **Measured v2-vs-v1 results (honest, not a clean win):**
  - Corpus sample, 100 files, 104,600 raw bytes (in-app engine):
    plain 48,227, v1 36,962, **v2 22,769** — v2 wins 100/100 files.
  - CLI per-kind samples: registry-map raw 607 plain 240 dict 141;
    site raw 2105 plain 969 dict 448; directory raw 1681 plain 776
    dict 383; contacts raw 1087 plain 399 dict 264; mail-envelope
    raw 594 plain 369 dict 122.
  - Held-out novel docs (NOT in training corpus, in-app engine):
    novel registry 339 raw — plain 173, v1 139, **v2 104 (v2 wins)**;
    novel mail 359 raw — plain 263, v1 208, **v2 184 (v2 wins)**;
    held-out harbour site 1,396 raw — plain 711, v1 497, v2 574
    (**v1 wins**); demo site `src/lib/sample.ts` 1,347 raw — plain
    727, v1 152, v2 619 (**v1 wins big, but the demo site doc is
    literally baked into v1's content source — pure v1 overfit, not
    a fair held-out test**).
  - First v2 attempt (fixed 8-sentence prose pool, memorised
    verbatim by the trainer) was worse: 158-byte site fixture v1 69
    vs v2 81 (plain 122); novel big site v1 497 vs v2 633. That is
    why the corpus was rebuilt with combinatorial unique prose +
    structural fragments.
  - Two further variants were trained and measured on the same
    held-out docs (CLI sizes): `--train-cover` (harbour 604, demo
    643, mail 201, registry 68 — worse than fastcover on held-out,
    marginally better on corpus files) and a fragments×3 fastcover
    rerun (identical to current v2 on every file — the trainer was
    already saturated on structure). The current fastcover v2 was
    kept; it is the best of the three on held-out docs.
  - The test asserts what the measurement supports: v2 beats plain
    everywhere, beats v1 on novel registry/mail and on the corpus
    aggregate; it does NOT assert a v1 win on long-prose site docs,
    where v1 still wins (its hand-assembled content repeats the JSON
    structural fragments with a density no trainer reproduced).
- Docs: PROTOCOL.md §4 updated (v2 trained, ID + SHA-256, measured
  sizes, v1 still decodes; manifest field now version 2) and §15
  changelog.

## 4. Manifest-discoverable directory categories — DONE

- `src/lib/types.ts`: `ProtocolManifest` gained
  `directoryCategories?: string[]` (documented);
  `DEFAULT_DIRECTORY_CATEGORIES = ["tech", "cinema", "games"]`
  moved here from `search.ts`; new `isValidDirectoryCategory(slug)`
  (regex `/^[a-z0-9]+(-[a-z0-9]+)*$/`).
- `src/lib/viewer/search.ts`: re-exports
  `DEFAULT_DIRECTORY_CATEGORIES` from `types.js` (existing import
  sites keep working); stale round-2 comment block replaced with
  manifest-discoverable description; new
  `directoryCategoriesFromManifest(manifest)` (manifest field wins;
  `undefined`/null → default copy; present-but-invalid — non-array,
  empty, or bad slug — throws); new
  `loadDirectoryShardsFromManifest(manifest, fetcher)` (delegates to
  `loadDirectoryShards` with resolved categories).
  `loadDirectoryShards(categories, fetcher)` unchanged for explicit
  callers.
- `src/lib/registry.ts`: `parseManifest` validates optional
  `directoryCategories` (array of valid slugs, else throw);
  `defaultManifest()` includes
  `directoryCategories: [...DEFAULT_DIRECTORY_CATEGORIES]` — the
  built-in manifest publishes the category list. Note honestly:
  `defaultManifest()` is the built-in manifest the client falls back
  to; the real `manifest.json` is published by the Root Master from
  protocol-root, which does not exist yet.
- `src/lib/app.ts`: `ArkNetzApp` gained `loadDirectoryShards(manifest,
  fetcher)`, which loads via `loadDirectoryShardsFromManifest` and
  indexes cards into `app.searchIndex`, returning the shards. (The
  app object previously never loaded directory shards at all —
  `searchIndex` started empty.)
- Tests (5): `tests/registry.test.ts` (default publishes the list;
  parse keeps a new category, accepts a missing field, rejects bad
  lists), `tests/comments-search.test.ts` (3 — manifest list vs
  fallback vs invalid; `loadDirectoryShardsFromManifest` loads a
  non-default category `"music"` served by a mock fetcher; fallback
  to the default list when the manifest has no field / is null),
  `tests/app.test.ts` (app-level load indexes the `"music"` card and
  it is searchable).
- Docs: PROTOCOL.md §3.6 (manifest-discoverable rule, fallback,
  slug regex), §10.4 (manifest lists `directoryCategories`), §15
  changelog.

## Honest gaps — updated by fix round 3

- Deep links: no launch test (no installed .deb this round), no
  single-instance plugin (second process on Linux/Windows while
  running), Android config-only, no .apk.
- ArkDrive Argon2id: keyring and IA keys still PBKDF2 (out of
  scope); Argon2id derivation ~337 ms in Node — browser/Tauri
  timing not measured.
- Zstd v2: v1 still wins on long-prose site docs (see §3 numbers);
  the dictionary is trained on generated sample data, not real
  user sites — a future v3 could retrain on real corpus data once
  sites exist.
- Still open from round 2 (unchanged): no live GitHub/IA
  round-trips, no OAuth App, no central repos, no live interactive
  QA this round, no Lighthouse re-run this round, HF live behaviour
  still unverified. Windows .exe and Android .apk BOTH BUILT this
  round — see "Fix round 3 — Windows/Android" below (NSIS installer
  and signed APK still outstanding: installer needs a Windows host,
  APK needs a release keystore).
- Transient note: one full-suite run was interrupted by a runtime
  restart mid-run (no result recorded); the re-run completed cleanly
  at 424 pass, 0 fail. A transient `dist/src/index.html` ENOENT in
  the favicon test appeared once earlier in the round and passed
  cleanly on re-run — treated as a stale-dist race, not a real
  failure, unless it reproduces.

## Fix round 3 — Windows/Android (2026-11-21 UTC; 2026-11-20 evening PST)

Both remaining platform targets were built on this Linux VM. The
claim "a Windows target is NOT buildable on Linux" is FALSE in the
strong sense: a portable Windows .exe cross-compiles cleanly with
cargo-xwin. Only the NSIS installer bundle still needs a Windows
host, and the .apk is unsigned (no release keystore configured).

### Android .apk — BUILT AND VERIFIED

- Artifact:
  `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`
  — **13,232,764 bytes**, 2026-11-21 02:34 UTC. Universal APK
  (arm64-v8a only in this build: `--target aarch64`).
- Verification: `aapt2 dump badging` — package
  `com.stanbeyond.arknetzwebweaver`, versionCode 1000, versionName
  0.1.0, compileSdk 36, minSdk 24, targetSdk 36, INTERNET
  permission, label ArkNetzWebWeaver. `unzip -l`: 676 files,
  14,198,387 bytes uncompressed, including
  `lib/arm64-v8a/libarknetzwebweaver_lib.so` (11,616,936 bytes),
  `classes.dex` (1,477,888 bytes), `assets/tauri.conf.json`.
  Tauri CLI printed "Finished 1 APK at: <path>".
- UNSIGNED: no keystore is configured, so this APK cannot be
  installed as-is. To sign: create a keystore (`keytool -genkeypair`)
  and sign with `apksigner` from build-tools 36.0.0, or configure
  `signingConfigs` in `gen/android/app/build.gradle.kts`.
- Toolchain installed OUTSIDE the work tree (reusable for later
  builds): Temurin OpenJDK 17.0.21.1+2 (`~/jdk17/`); Android SDK
  (`~/Android/Sdk/`): cmdline-tools 11076708, platform-tools
  37.0.3 (adb 1.0.41), platforms android-34 ext12 + android-36,
  build-tools 34.0.0 + 36.0.0, NDK r26d (26.3.11579264); Gradle
  9.6.1 (pre-seeded distribution), AGP 9.3.1, Kotlin 2.2.10.
  Rust targets added: aarch64/armv7/i686/x86_64-linux-android.
- Build-config changes (in the tree, all required for Android):
  - `src-tauri/gen/android/` generated by `npx @tauri-apps/cli@2
    android init` (Gradle project, com.stanbeyond.arknetzwebweaver).
  - `gen/android/app/build.gradle.kts`: `compileSdk 37 → 36`,
    `targetSdk 37 → 36` — API 37 does not exist in Google's public
    SDK repository (platforms listed only up to android-36;
    direct HEAD checks on platform-37 zips returned 404).
  - `src-tauri/src/lib.rs` created; `src-tauri/src/main.rs`
    reduced to a wrapper calling `arknetzwebweaver_lib::run()`.
    The moved shell (OAuth exchange command + Tauri builder) is
    byte-identical to the original `main.rs` (verified by diff;
    an early draft that dropped `form.insert("code", code)` and
    altered error strings was caught and fixed). Behaviour is
    unchanged; the refactor is required because the Android
    build compiles the crate as a library (`cargo build --lib`).
  - `src-tauri/Cargo.toml`: added `[lib]` section
    (`arknetzwebweaver_lib`, staticlib/cdylib/rlib); reqwest
    changed to `default-features = false, features = ["json",
    "rustls-tls"]` — the default `default-tls` (native-tls)
    pulls openssl-sys, which cannot find OpenSSL for
    aarch64-linux-android; the only reqwest use is the GitHub
    OAuth POST, which works over rustls.
- Environment fixes needed in THIS sandbox (not app changes;
  record for any future build here):
  - Gradle daemon could not communicate: strace showed the
    client JVM's socket bound to the VM's external IPv6 ULA
    (`fd8b:4f84:7d32:99::2`) when connecting to the v4-mapped
    loopback `::ffff:127.0.0.1` — the daemon never accepts and
    the client write fails EPIPE. Fix:
    `-Djava.net.preferIPv4Stack=true` (via `JDK_JAVA_OPTIONS`),
    after which a minimal Gradle project built cleanly and the
    real build proceeded.
  - Gradle dependency downloads failed TLS verification
    (`PKIX path building failed`) because the egress proxy
    MITMs TLS with its own CA. Fix: imported the sandbox CA
    (`CN = Hatch Sandbox Egress CA`, from
    `/run/hatch/egress-tls/ca-bundle.pem`) into the JDK trust
    store (`keytool -importcert -cacerts -alias hatch-egress-ca`
    in `~/jdk17`). After that, AGP/Kotlin resolved; a later
    transient "Read timed out" fetching Kotlin artifacts from
    Maven Central cleared on re-run (Gradle cache resumes).
  - Gradle wrapper distribution pre-seeded under both
    `~/.gradle/wrapper/dists/gradle-9.6.1-bin/4ticwg1pgcbps2hj28r8so764/`
    and `/root/.gradle/...` (Java's user.home is /root, not
    $HOME); `GRADLE_USER_HOME=$HOME/.gradle` exported for every
    build. Proxy systemProps live in `~/.gradle/gradle.properties`
    (token rotates per shell — rewrite from the current env
    before each build; never print the token).
  - `sdkmanager`'s legacy downloader cannot do CONNECT through
    this proxy (JDK `HttpURLConnection` tunneling bug); SDK
    packages were downloaded with curl from
    `dl.google.com/android/repository/` and installed manually,
    SHA-1-verified against repository2-1.xml.
- Build command (relaunch exactly): `cd src-tauri && export
  PATH="$HOME/.cargo/bin:$PATH" JAVA_HOME=$HOME/jdk17
  ANDROID_HOME=$HOME/Android/Sdk ANDROID_SDK_ROOT=$HOME/Android/Sdk
  NDK_HOME=$HOME/Android/Sdk/ndk/26.3.11579264
  GRADLE_USER_HOME=$HOME/.gradle` plus `JDK_JAVA_OPTIONS` with
  `-Djava.net.preferIPv4Stack=true` and the current proxy props,
  then `npx --yes @tauri-apps/cli@2 android build --apk --target
  aarch64`. Rust lib alone:
  `cargo build --lib --target aarch64-linux-android --release`
  → `target/aarch64-linux-android/release/libarknetzwebweaver_lib.so`
  (11,616,936 bytes).
- Logs/downloads kept in `~/android-setup/` (android-build.log,
  xwin-build.log, xwin-install.log, gradle-*.log, SDK zips,
  repo2.xml, certs/).

### Windows .exe — BUILT AND VERIFIED (portable; no NSIS installer)

- Artifact:
  `src-tauri/target/x86_64-pc-windows-msvc/release/arknetzwebweaver.exe`
  — **10,759,680 bytes**, 2026-11-21 02:58 UTC (copied there from
  the build's `CARGO_TARGET_DIR=$HOME/cargo-target`; same file).
- Verification: `file` → "PE32+ executable (console) x86-64, for
  MS Windows, 9 sections". Wine 9.0 smoke test: the exe loads and
  runs — it reaches Tauri's app setup and panics at
  `tauri-2.12.7/src/app.rs:1444` "Failed to setup app: runtime
  error: failed to create window" because the VM has no X server /
  DISPLAY (Wine: "Make sure that your X server is running"). That
  is the expected headless-Wine failure for a GUI app, not a bad
  binary. Never launched on real Windows.
- Route: cargo-xwin 0.23.1 (`cargo install --locked cargo-xwin`),
  Rust target `x86_64-pc-windows-msvc`, clang 17 + lld-link from
  the Android NDK toolchain
  (`~/Android/Sdk/ndk/26.3.11579264/toolchains/llvm/prebuilt/linux-x86_64/bin/`,
  on PATH — no apt, no separate LLVM download needed), xwin
  splat of MSVC CRT + Windows SDK (~1.2 GB in
  `~/.cache/xwin`). `cargo xwin build --target
  x86_64-pc-windows-msvc --release` — "Finished `release` profile
  [optimized] target(s) in 3m 02s".
- Gotchas found and fixed:
  - `cargo xwin build --release` WITHOUT `--target` silently
    builds the Linux host binary (glib/gio compiled, artifacts
    under `release/` not `x86_64-pc-windows-msvc/release/`).
    The `--target x86_64-pc-windows-msvc` flag is mandatory.
  - `cargo install cargo-xwin` first failed with "No space left
    on device" because cargo-install builds under /tmp (512 MB
    tmpfs). Fix: `CARGO_TARGET_DIR=$HOME/cargo-target
    TMPDIR=$HOME/tmp` for the install (and for the build).
  - Build failed in tauri-build: `icons/icon.ico not found;
    required for generating a Windows Resource file during
    tauri-build`. Fix (build asset only, generated from the
    existing art): `src-tauri/icons/icon.ico` created from
    `icons/icon.png` (512×512 RGBA) with Pillow, 6 sizes
    16/32/48/64/128/256, 48,933 bytes. No app source touched.
    (`package.metadata does not exist` is a non-fatal tauri-build
    note.)
  - The deep-link plugin (`tauri-plugin-deep-link`, sibling's
    round-3 work) compiled for Windows without issue; its
    `arknetz` scheme is registered in tauri.conf.json.
- NOT produced: the NSIS installer (`.exe` installer bundle).
  Tauri only exposes Linux bundle types on Linux; NSIS needs a
  Windows host (or `cargo tauri build` run on Windows). The
  portable .exe above is the deliverable here; it needs the
  WebView2 runtime on the target Windows machine (evergreen
  WebView2 is preinstalled on Windows 11 / most Windows 10).
- What would build the installer on Windows: Windows 10/11 host
  + Rust (stable, `x86_64-pc-windows-msvc` target) + Node.js +
  Tauri CLI 2 (`npx @tauri-apps/cli@2`) + WebView2 runtime +
  NSIS (Tauri installs/bundles it) — then `npx tauri build`
  in `src-tauri/` produces the NSIS `.exe` installer under
  `target/release/bundle/nsis/`. No code change needed: the
  `icons/icon.ico` fix above already covers the Windows
  resource-file requirement.

# Integration pass — UI/UX polish + bug-hunt wiring (fix agents A/B/C), 2026-11-20/21

All three fix agents' modules are now wired in; nothing of theirs was
left unmounted. No GitHub work done here. No new dependencies.

- **Wayback + ToS (agent C):** `panels.ts` `wirePanel()` Wayback block
  replaced with `wireWaybackPanel(root, fetchFn)` (loading state,
  plain-language errors + Retry, correct CDX array parsing via
  `listSnapshots()`); the six now-unused wayback imports deleted.
  Rendered panel HTML and element ids unchanged. Accounts ToS status
  line now uses `tosAcceptanceStatusLine()` (human date, same wording).
- **Stats panel (agent C):** registered in `APP_PANELS` after
  `"offline"`; `renderPanelHtml()` + `wirePanel()` both read one
  shared source (`statsDeps()` helper in panels.ts), so toggles never
  re-render stale values. Telemetry-settings store added in
  `viewer/stats.ts`: `TelemetrySettingsStore` +
  `createMemoryTelemetrySettingsStore()` +
  `createIndexedDBTelemetrySettingsStore()` (DB `arknetz-telemetry`,
  same one-DB/one-store/one-key shape as the IA-account store) +
  `normalizeTelemetrySettings()` (corrupt/partial rows fall back
  per-field, never invent telemetry-on). The app keeps a synchronous
  in-memory mirror (`get/set/loadTelemetrySettings()` on
  `ArkNetzApp`); the shell awaits `loadTelemetrySettings()` before
  mounting panels. The IndexedDB store is used when the app is built
  with `useIndexedDB: true` — the shell still constructs the app
  memory-only, so in the shipped build toggles currently reset on
  restart (see "Still open" below). `getSiteStats(domain)` honestly
  returns `emptyStats(domain)` until a stats.json.zst loader exists.
- **Backends panel (agent C):** registered in `APP_PANELS` after
  `"wayback"`; render + wire share `backendsDeps()`. `linked` is built
  from the keyring in `app.ts` (`PROVIDER_PREFIX`, profile label as
  value; ipfs has no provider, always "Not linked").
  `getProjectFlags()` returns `{}` and `getLastMirrorAttempts()`
  returns `[]` until a project-flags source / mirror-attempt recorder
  exists — both panels show their honest empty states meanwhile.
- **P3 (agent B):** demo hero title `"ArkNetzWebWeaver"` →
  `"The zero-server web"` (`sample.ts`). Verified: the built demo
  renders with the new hero, the document title intact, no doubled
  heading.
- **Fix agent A follow-ups (both done, both safe + quick):**
  (a) `https:`/`http:` clicks in the reader no longer top-level
  navigate the app WebView away: `installArknetzLinkInterceptor`
  (renderer.ts) now preventDefaults them and hands them to
  `openExternal` — `window.open(href, "_blank", "noopener")` in the
  shell, the same external-open idiom OAuth + Save Page Now already
  use. `arknetz://` stays internal; `mailto:` untouched. Deliberately
  NOT done in the Rust guard: it must keep allowing `https:` (its own
  test asserts the GitHub OAuth authorize URL is not blocked), and
  blocking there would break the OAuth window. Renderer test updated
  to the new behaviour.
  (b) B9 tooltip moved to its cleaner home: `editor-ui.ts`
  `renderSidebar()` sets `li.title` at render time; the shell's
  mouseover delegation in `main.ts` is deleted. Covered by a new
  editor-ui test (tooltip present with no hover).
- **Counts updated, not weakened:** `app.test.ts` / `panels.test.ts`
  13 → 15 panels (stats + backends registered); new tests:
  stats/backends render with and without accessors, wayback ids
  still bound, telemetry store round-trip + normalize + app
  accessors + keyring→prefix mapping, B9 tooltip, https: external
  open.

## Verification (this pass)

- `npx tsc --noEmit`: clean.
- `npm test`: **477 pass, 0 fail** (baseline 468 + 9 new).
- `npm run build`: passes (also re-run by the Tauri build's
  beforeBuildCommand).
- `cargo check --offline`: passes. `cargo test --offline`: **2
  passed, 0 failed** — this VM previously could not run it at all
  (missing GTK dev headers, fix agent A's report). Fixed by
  installing the Tauri system deps (`libgtk-3-dev`,
  `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`, `patchelf`); the install needed the round-1
  libzstd1 dance again (`libzstd-dev` requires stock libzstd1
  `1.5.5+dfsg2-2build1.1`, but the Hatch-patched `+hatch1` was
  installed): downgraded libzstd1, installed the dev packages, then
  restored the patched `/usr/lib/x86_64-linux-gnu/libzstd.so.1.5.5`
  from `build/sysdeps-backup/` (md5 `6539c4a4774a79f568d5e5299d5a2d6c`,
  verified identical to the backup after restore) + `ldconfig`.
  dpkg now records libzstd1 as stock while the file on disk is the
  patched one — same state round 1 left it in.
- Full `tauri build` (release, LTO): all 3 bundles produced, AppImage
  did NOT stall this time (no extracted-appimagetool workaround
  needed), verified by listing the files + `--appimage-extract`:
  - `src-tauri/target/release/bundle/deb/ArkNetzWebWeaver_0.1.0_amd64.deb` — **4,346,148 bytes**
  - `src-tauri/target/release/bundle/appimage/ArkNetzWebWeaver_0.1.0_amd64.AppImage` — **82,987,512 bytes** (extracts cleanly, binary present)
  - `src-tauri/target/release/bundle/rpm/ArkNetzWebWeaver-0.1.0-1.x86_64.rpm` — **4,350,568 bytes** (bonus bundle from the same build)
  - Binary `src-tauri/target/release/arknetzwebweaver` — 11,461,088 bytes

## Still open (for the visual re-check agent / parent)

- Telemetry settings persist only when the app is built with
  `useIndexedDB: true`; `main.ts` still calls
  `createArkNetzApp()` with no options, so in the shipped build the
  Stats toggles reset on restart. Flipping the flag would also flip
  mail/draft/search/keyring stores to IndexedDB — a wider change
  than this pass; needs a deliberate call.
- No stats.json.zst loader yet: the Stats panel always shows empty
  states for any real site (by design, honestly). No project-flags
  source yet: hf:/wm: never offered as upload targets. No
  mirror-attempt recording yet: Backends failover always shows "no
  load yet".
- `window.open(..., "_blank")` in the Tauri WebView opens the
  external page in a new app window, not necessarily the system
  browser (no opener plugin in the Rust shell); it does NOT destroy
  the main UI, which was the bug. If "system browser" is required,
  that needs `tauri-plugin-opener` (MIT/Apache) + a Rust command.

## OAuth callback receiver (2026-11-21, post-push)

The client repo was pushed to GitHub (head fbe1d8f0d93d5bf58ff3cae45905fddfbd840901)
with the OAuth flow half-built: `buildAuthorizeUrl()` set no
`redirect_uri`, `handleRedirect()` existed but nothing called it, and
the deep-link listener routed every `arknetz://` URL to the site
resolver. All three gaps are now closed, inside the main app — the
GitHub OAuth is part of the accounts / multi-account sign-in system,
not a side piece.

### What changed

- `src/lib/config.ts`: `GITHUB_OAUTH_REDIRECT_URI =
  "arknetz://oauth/callback"` (registered on the OAuth App, client id
  `Ov23lic8terv0XOd3GDe`, scopes `read:user public_repo`). No secret
  anywhere in any file — the secret stays runtime env
  `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET`, read only by the Rust command.
- `src/lib/auth.ts`: `buildAuthorizeUrl()` sets `redirect_uri`;
  `exchangeCode()` now passes `{ code, client_id }` — the Rust
  command signature is `(code, client_id)` and the old call passed
  only `{ code }`, which would have failed the invoke. New:
  `fetchGithubUser()` (GET /user, throws loudly on non-2xx or no
  login), `completeOAuthCallback()` (handleRedirect -> exchange ->
  /user, every step throws loudly, injectable mocks for tests), and
  `savePendingOAuthState()` / `takePendingOAuthState()` — the pending
  state lives in localStorage, not sessionStorage, because the OS may
  deliver the callback to a second app process, which shares
  localStorage but not sessionStorage. It is a one-time CSRF nonce,
  consumed on use, never leaves the origin.
- `src/lib/deep-link.ts`: `isOAuthCallbackUrl()` +
  `handleDeepLinkUrls(urls, openTab, { onOAuthCallback })` intercepts
  `arknetz://oauth/callback` before the site resolver (the old code
  silently dropped it: "oauth" is not a valid domain). Both the
  startup (`getCurrent`) and live (`onOpenUrl`) paths route through
  it; a throwing handler never breaks the listener.
- `src/lib/network/accounts.ts`: `addGithubAccount()` adds the
  signed-in GitHub account to the keyring like any other backend
  account (encrypted token, active GitHub account, re-sign-in
  refreshes the token instead of duplicating; throws when locked).
- `src/lib/panels.ts`: Accounts panel now renders a real "Sign in
  with GitHub" button (wired to the shell's sign-in via
  `PanelHostOptions.onSignInWithGitHub`) and a keyring unlock/lock
  form; the Master badge reads `app.keyring.isMasterAdmin()` instead
  of the hardcoded `isRootMaster(null)` it used before.
- `src/main.ts`: `startGitHubSignIn()` (shared by the top-bar button
  and the Accounts panel), `completeGitHubSignIn()` (state check ->
  exchange -> /user -> keyring, or a loud exact message when the
  keyring is locked — session works, account not saved),
  `refreshGithubStatus()` (Settings status + guest badge, Root Master
  marker only for the master login), `go()` intercepts a callback URL
  pasted in the address bar, the app object + `keyring.load()` now
  happen before the deep-link listener installs (a startup callback
  needs the keyring), and `panelsRefreshNav` rebuilds the nav after
  sign-in so Moderation appears for the Root Master.
- Rust: no change needed. `github_oauth_exchange` already took
  `(code, client_id)` and reads the secret from the runtime env; the
  nav guard already blocks top-level `arknetz://` WebView navigation,
  which is correct for the callback (it arrives via the deep-link
  plugin, not the WebView).

### Verification

- `npm run check` (tsc): clean.
- `npm test`: **497 pass, 0 fail** (481 baseline + 16 new:
  authorize-URL redirect_uri + exact scopes, `completeOAuthCallback`
  happy path / state mismatch / error param / missing code /
  exchange failure with mocked exchange, `fetchGithubUser` mocked
  fetch, `addGithubAccount` keyring integration incl. master badge,
  token refresh, locked-keyring refusal, callback routing +
  interception + listener passthrough). No test hits real GitHub.
- Tauri Linux build: see "Tauri build" below (rebuilt for this change).

### Still NOT verified — needs a real OAuth sign-in (Stanley only)

- The end-to-end live flow (click sign-in -> github.com -> callback
  -> token -> account in the pill) has never run: it needs the real
  client secret in `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET` at runtime,
  which only Stanley holds. Until that runs, the exchange path is
  proven only with mocks, and `github_oauth_exchange` will answer
  `not_configured` — loudly, by design, never a fake token.
- `window.open(url, "_blank")` in the Tauri WebView opens the GitHub
  authorize page in a new app window, not necessarily the system
  browser (pre-existing, see "Still open" above); whether the OS
  routes `arknetz://oauth/callback` back to the running app or spawns
  a second process is unproven on an installed build (the
  localStorage pending-state change covers the second-process case,
  but no installed .deb launch test has run it).
- The keyring still uses the memory store in the shipped build
  (`createArkNetzApp()` with no options), so a GitHub account saved
  to the keyring lasts the session only — same pre-existing limit as
  every other account (see "Still open" above). Flipping
  `useIndexedDB: true` is a wider change needing a deliberate call.

---

# Real-time multi-user collaboration — 2026-11-21 (Stanley 03:59)

**This overrides the earlier v1.0 note that live-cursor collaboration
was out of scope.** Built in `src/lib/collab/` + collab-session wiring
in `src/lib/editor.ts` only. No other owned files were touched
(`blocks.ts`, `renderer.ts`, `editor-ui.ts`, `types.ts`, `domains.ts`,
`domains-ui.ts`, `wxr.ts` untouched). No AI builder / MCP / x402, no
Fediverse, no RSS, no Gmail/SMTP bridge, no new dependencies, no
shared/master keys.

## What was built

- `src/lib/collab/types.ts` — state-file shape + validation, deterministic
  peer colours, `ConflictNote` + `describeConflict`.
- `src/lib/collab/merge.ts` — per-block last-write-wins on
  `(updatedAt, author)`; deterministic ordering of concurrent inserts
  at the same index (placement keys); delete tombstones (absence from
  a peer's list is never a delete); `diffBlocks` (local broadcast ops).
- `src/lib/collab/presence.ts` — join/heartbeat/leave, 30 s expiry
  (stale peers stay listed, marked stale; their blocks stay).
- `src/lib/collab/cursors.ts` — live cursor/selection marks for the
  editor UI (`describePeerCursors`, self excluded, stale flagged).
- `src/lib/collab/relay.ts` — GitHub Contents-API relay (see below).
- `src/lib/collab/sync.ts` — poll/merge/heartbeat engine, offline
  flag + retry, stale-block reporting.
- `src/lib/collab/session.ts` — join/leave lifecycle + timers; branch
  deleted when the last peer leaves.
- `src/lib/collab/index.ts`, `src/lib/collab/README.md` (full rationale).
- `src/lib/editor.ts` (collab wiring only) — `startCollab` /
  `stopCollab`, `applyRemoteBlockOps`, `applyRemoteStates`,
  `setLocalCursor`, `staleBlockIds`, `collabConflicts`,
  `collabPeers`, `collabOffline`; local block mutations diff + broadcast.
  Collab covers blocks only — header/footer/nav/pages are not synced.
- Tests: `tests/collab.test.ts` (13), `tests/collab-relay.test.ts` (8),
  `tests/collab-editor.test.ts` (7) — **28 tests, 28 pass**, all against
  an in-memory fake GitHub (`tests/collab-fake-github.ts`); no test
  hits real GitHub. Includes the two-peer convergence proof (A adds X,
  B adds Y, both end with X+Y in the same order), same-block conflict
  (newer wins, loser recorded with its text), presence join/leave/30 s
  expiry, cursor propagation, relay round-trip, offline → recovery,
  and a regression test that Publish still refuses on a SHA mismatch
  (HTTP 409, with the attempted SHA in the PUT body).

## Relay choice + rationale

**Chosen: a `collab/<domain-slug>` branch in the per-domain site repo,
one state file per peer (`peers/<login>.json`), via the GitHub Contents
API with the user's OWN OAuth token (`public_repo` scope).**
- `public_repo` grants exactly what this needs on public repos
  (Contents API, git-refs branch create/delete, per-file SHA guard);
  site repos are public by design, so no wider scope is required.
- Each peer writes only its own file, so peers never contend for the
  same SHA — no write-write conflict is possible at the relay layer.
- It reuses the exact API pattern `publish.ts` already proves
  (GET-for-SHA then PUT-with-SHA), and it is invisible to readers:
  `main` and `site.json.zst` are untouched until someone Publishes.
- Reads use `api.github.com`, never `raw.githubusercontent.com` — the
  raw CDN caches branch content, so polls could see minutes-old state.
**Rejected: GitHub Issues as the relay.** Every op would be a public
Issue/comment in the site repo (visible noise), with no per-peer file
separation and no SHA guard. Full rationale in `src/lib/collab/README.md`.

## Honest limits — what the sync can and cannot do

- **Expected latency is roughly one poll interval (~5 s)**, plus GitHub
  API time. A remote edit appears after the next poll, never
  sub-second. Typing does not stream; whole blocks do.
- **Offline peers:** their blocks stay in the document, marked stale
  (the editor exposes `staleBlockIds()`); the peer drops from live
  presence after 30 s without a heartbeat. When they return they
  re-sync from one poll. A failed poll marks the session offline,
  keeps the last known presence and document untouched, and retries
  on the next poll — local editing keeps working throughout.
- **Conflict cases:** different blocks never interfere. The same block
  edited by two peers resolves whole-block: the newer version wins
  and the losing version is recorded in a visible conflict note (with
  its text) — it is never silently dropped, but it is NOT merged and
  NOT auto-restored. A delete that loses to a newer edit keeps the
  block and is recorded the same way. Two peers inserting at the same
  index converge to the same order, but that order is by placement key,
  not by who typed first.
- **This is NOT Google Docs parity.** No character-level OT, no
  sub-second latency, no server, no simultaneous typing in the same
  block. Do not claim it. Live GitHub round-trips have NOT run (no
  repos exist yet, same as the rest of the app) — the relay, engine,
  and editor wiring are proven only against the in-memory fake GitHub.
- **Poll cost:** every peer polls every 5 s (list + one read per peer
  + one write). With many peers this is chatty against the 5,000/hr
  authenticated rate limit; sessions are per-site and small by design.
- **Wired into the UI by the feature-round-2 integration pass
  (2026-11-21, see below):** the editor renders cursor marks and
  conflict notes and offers a Join/Leave control; `EditorState`
  exposes `collabPeers`, `collabConflicts`, `staleBlockIds()`, and
  `describePeerCursors()` for it.
- **One real bug found and fixed in the implementation (not the
  tests):** `noteLocalChange` originally advanced `lastSynced` on
  every local edit, which made genuine same-block conflicts
  invisible (the remote op no longer post-dated the "synced"
  version). `lastSynced` now advances only when a remote state is
  merged and the contents agree.

## Verified state (this workstream)

- `npx tsc -p tsconfig.json --noEmit`: **clean at final check** (the
  sibling errors seen mid-work — `tests/html-import.test.ts`,
  `tests/tables-lists.test.ts` — were fixed by their owners while this
  ran; no collab file was ever implicated).
- `npm run build`: passes (tsc + asset copy).
- `npm test`: **583 tests, 581 pass, 2 fail — both failures are the
  sibling table/list workstream's, not collab's** ("malformed HTML:
  unclosed tags degrade gracefully and never throw",
  "slash menu lists list and table once each (P1 dedupe)"). All 28
  collab tests pass inside the full run, and standalone:
  **28 pass, 0 fail** (`node --test dist/tests/collab.test.js
  dist/tests/collab-relay.test.js dist/tests/collab-editor.test.js`).

# Feature round 2 — integration wiring, 2026-11-21

The four round-2 feature agents finished (collab engine, tables/lists,
domain-claim-open, HTML importer) at 583 pass / 0 fail. This pass wires
all four into the running app. No new features beyond the wiring below;
no push to GitHub; seed tree and /tmp/repush-seed.py untouched.

## 1. Domain claim → editor (main.ts + panels.ts + editor-ui.ts)

- The Domains panel now has the claim form: Terms checkbox
  (`#an-domain-terms`), Claim button (`#an-domain-claim-btn`), and —
  for guests — the exact refusal "Sign in with GitHub first to claim a
  domain" rendered in the panel (`#an-domain-signin-note`).
- `PanelHostOptions.onClaimDomain` (panels.ts) is wired in main.ts to
  `claimDomainAndOpenSite` with the signed-in user's OWN token + login
  from the session (keyring-backed after sign-in) and the shared
  `githubFetch`. Not signed in → the flow refuses with the exact
  message and makes no GitHub call (the flow itself guarantees this;
  the panel surfaces the returned reason verbatim).
- The `onSiteOpened` hook (`handleSiteOpened` in main.ts) loads
  `opened.doc` into the EditorUI for `opened.domain` and switches to
  the builder; `EditorUI.showSiteOpened` shows the pending-claim state
  ("Your claim is filed and waiting for the register bot — usually 5
  to 10 seconds") and never says the domain is registered. The
  reader's current document is updated too, so closing the editor
  shows the new site. A hook failure is reported on the claim result
  as `hookError` and surfaced in the panel status; the claim still
  stands.
- `ensureEditorUi()` was hoisted to module level in main.ts so the
  edit toggle and the claim hook share one EditorUI construction; the
  GitHub fetch adapter is likewise shared (`githubFetch`), and the
  HTML importer gets a plain unauthenticated fetch (`htmlFetch`).

## 2. HTML importer UI (editor-ui.ts + index.html)

- Editor bar gains "Import HTML (.html)" file picker
  (`#html-import-input`, same pattern as the WXR entry) and an
  "Import HTML from URL" field + button (`#html-import-url`,
  `#html-import-url-btn`).
- File import: `importHtml` on the file text; URL import:
  `importHtmlFromUrl` with the app's fetch. Both append blocks to the
  current document through `insertBlock` (so a live collab session
  broadcasts them like any other local edit); an empty document also
  adopts the imported title/nav. Status shows imported/skipped counts
  plainly plus the importer's notes. A read failure, a fetch failure,
  or malformed input never throws — the status line says so.
- Role-gated like WXR import (viewer cannot import).

## 3. Collab UI surface (editor-ui.ts + editor.ts)

- The editor bar gains a collab strip (`#collab-bar`): Join / Leave
  buttons, a status line (`#collab-status`), and the peer list
  (`#collab-peers`, "who is in this site now", self marked "(you)").
- Peer cursor/selection marks render in the canvas on the block the
  peer's caret is in (`describePeerCursors`, self excluded, names +
  deterministic colours, stale peers flagged "(away)"). Conflict
  notes render on the losing block (`describeConflict`). Blocks whose
  last writer is stale get a stale note (`staleBlockIds()`).
- Join refuses loudly with no token — the engine's message is
  surfaced in both the editor status and the collab strip, never
  swallowed. Leave stops timers, deletes my relay state, and deletes
  the branch when I was the last peer; blocks stay.
- The surface re-renders after every edit and on a 2 s timer while
  joined (remote polls arrive without a local edit). My caret is
  shared on focus of a text block / list item / table cell only — a
  write per keystroke would spam the relay. Opening a different
  domain ends the old session; re-opening the same domain keeps it.
- **One real bug found and fixed in the implementation (not the
  tests):** the peer list stayed empty until the first poll (~5 s)
  because `onPresence` only fires inside `pollOnce`. `startCollab`
  now seeds `collabPeers` with self immediately after joining; polls
  refresh it from then on.

## 4. Data:image fix (inline.ts)

- `isSafeUrl` now allows exactly
  `data:image/png|jpeg|gif|webp;base64,<b64>` — the HTML importer's
  image allow-list, mirrored character-for-character. SVG data: URLs
  stay refused (they can carry script), as do all other data: shapes
  (parameters, whitespace, non-base64, wrong type). Imported data:
  images now render as real `<img>` in the shared renderer instead of
  "[image blocked]".

## 5. Canvas table layout (styles.css)

- `.an-ed-table-row` is now a grid
  (`repeat(auto-fit, minmax(120px, 1fr))`) so table cells sit
  side-by-side instead of stacking vertically. Editor-only classes;
  the reader/preview rendering (`.an-table`) is untouched.

## Verified state (this pass)

- `npm run build`: passes (tsc + asset copy).
- `npm test`: **596 pass, 0 fail** (583 baseline + 13 new: 2 renderer
  data-URL tests, 1 panels claim-form test, 10
  `tests/integration-round2.test.ts` — HTML import file/URL/malformed,
  collab join-refusal / join-peers-cursor-conflict-leave / stale flags,
  claim → editor hook + signed-out refusal, canvas table grid).
- Two test bugs found and fixed in the new battery (not the
  implementation): `??` in the test setup turned an explicit `null`
  token/login into the defaults (the "no token" test was secretly
  joining as alice and leaking live poll timers, which hung the whole
  suite run), and the collab assertions read `#editor-status` while
  the joined state lives in `#collab-status`.

## Bug hunt 2 — on the uploaded product (2026-11-21)

Three tracks (source verification, visual QA, feature surfaces) run
against the live GitHub product (client head d07c5bb), then two fix
passes. `npm test`: **596 → 618 → 627 pass, 0 fail** throughout.
Headless verification of the visual fixes: 11/11 checks, 0 console
errors. Screenshots: `~/workspace/arknetzwebweaver/qa-screenshots/hunt2/`
(hunt) and `.../hunt2-fix/` (fix verification).

### Track 1 — source verification (no drift, binaries proven)
- Clone of the live client repo at d07c5bb diffed against the scaffold:
  zero content differences (local-only: dict-training corpus,
  dictionary .bin, Tauri-generated `src-tauri/gen/`).
- All 7 live binaries sha256-identical to local seeds and
  decompressed with the app's real zstd path: registry-00/0f
  `registry.json.zst`, contacts-00 `contacts.json.zst`,
  moderation `moderation.json.zst`, dictionary v1/v2 `.bin`,
  protocol-root manifest (protocol 0.1.0, 16+16 shards,
  `pendingRepos` = the 13 missing repos at the time).
- The 10 repos created later (contacts-0a–0f, feed-2026-11,
  directory-tech/cinema/games) had their `.zst` files verified the
  same way — all sha256-match local seeds.
- Live `register.yml` confirmed PR-based (blob f695c533) vs the
  issue-based client flow. **Stanley ruled ISSUE-based 2026-11-21
  06:28**; the live workflow is being replaced via the web UI.

### Track 3 — feature surfaces (all work, 6 defects)
- Two-peer collab convergence + same-block conflicts both
  directions; tables/lists render + escape correctly; claim flow
  refuses exactly with no token and fails cleanly on a fake token;
  HTML importer on 4 fixtures (scripts/iframes/`javascript:`
  stripped and counted); OAuth chain complete up to the live
  exchange (needs Stanley's runtime secret).

### Fixes applied
- D2 (HIGH): collab relay now addresses the site OWNER's repo
  (`siteOwner` plumbed from the document/registry; `EditorState.collabSiteOwner`).
- D1 (MEDIUM): gracefully-left peers removed on next poll;
  silent peers show "(away)" for a 5-min grace (`PEER_PRUNE_AFTER_MS`)
  then prune. (Fix pass 1 briefly pruned at 30 s, removing the
  "(away)" phase; pass 2 restored the stale window.)
- D3 (MEDIUM): new `src/lib/claim-watcher.ts` polls the REGISTER
  issue every 30 s while a claim is pending; closed → resolved,
  404/401 → failed and stops.
- D6 (HIGH): the Account Switcher Pill is now real UI — top-bar
  button + dropdown in `src/index.html`, `src/lib/network/account-pill.ts`
  controller, switch wiring in `main.ts` (locked keyring refuses
  before anything changes).
- D4/D5 (LOW): stale data-URL comment deleted; the 512 KB data-URL
  cap now lives in `isSafeUrl` so every path enforces it.
- H1 (HIGH): `.an-slash-row` wraps at 390px (was 539px wide, "+ Block"
  off-viewport).
- M2 (MEDIUM): the editor canvas now renders inline formatting
  (`setEditableContent` + `renderInlineRuns` in contenteditables).
- M3: `showPanel()` scrolls the panel host into view.
- M4: HTML-URL import failures surface in the status line
  (with a 10 s hold so an autosave can't overwrite the message).
- M5: switching to any non-builder panel closes the editor.
- L6–L11: terms checkbox + label together; editor status on its
  own full-width row; collab error de-duplicated; code-block scroll
  fade; pill wraps instead of truncating; import-URL input widened;
  "Not collaborating." no longer wraps mid-phrase.

### register.yml dictionary fix (found during the hunt, blocks the rollout)
- The issue-based `protocol/register.yml` decompressed the canonical
  shard with a bare `zstd -d` and recompressed with a bare `zstd`.
  Canonical files ARE dictionary-compressed (dict ID 0x41524B02):
  bare `zstd -d` fails with "Dictionary mismatch" (proven), so the
  availability check silently fell back to the plain mirror, and a
  successful claim would have rewritten the canonical file as a
  plain frame. Fixed: the workflow now fetches the v2 dictionary
  from the protocol repo and uses `-D` for both steps (plain
  fallback kept if the fetch fails). Verified by simulation:
  with-`-D` read + write frames carrying DictID 1095912194
  (0x41524B02); YAML parses. The app itself reads both frame kinds
  (proven with `decompressBytesWithDictionary`), so no shipped
  client change was needed — but the web-UI replacement of the
  live workflow MUST use this fixed file, not the pre-fix copy.
- Manifest `pendingRepos` corrected to only the 3 repos that still
  do not exist (`arknetz-actions`, `arknetz-mirrors`,
  `arknetz-website`); re-pushed to arknetz-protocol-root.

### Still not verified live (do not claim)
- Live OAuth sign-in (needs Stanley's runtime client secret),
  live mail round-trip, live IA upload (needs a test account's
  own keys), live collab session between two signed-in peers,
  live REGISTER round-trip under the new issue-based workflow
  (no Action run has happened anywhere yet), deep-link end-to-end
  launch, AppImage launch (no /dev/fuse in VM), Windows.exe on
  real Windows, Android.apk signing + install.

## Bug hunt 3 (second hunt on the live product), 2026-11-21

Method: cloned the live client repo (head f567d9a4) and diffed it against
the scaffold — zero drift (only local-only files differ: dict-training
corpus/bin, src-tauri/gen). `npm run build` clean, dist/ served on
localhost:8123, driven by puppeteer-core + Chrome 156 headless, desktop
1280x900 and mobile 390x844; 20+ screenshots read as images. Tests
627 -> 629 pass, 0 fail. Note: the cloned code failed an execution-risk
check, so the test/build numbers below are from the scaffold (as in
hunt 1), not from inside the clone.

### Verified live (again)
- All 7 workflow files parse as YAML and are byte-identical to the
  scaffold copies: register.yml (FIXED 255-line version) in registry
  shards 00/07/0f AND arknetz-actions; cleanup.yml, stats.yml,
  mirror.yml. register.yml name: "Register domain".
- Uploaded binaries from GitHub are sha256-identical to local seeds
  and decompress with the v2 dictionary to valid JSON (registry/
  contacts `{}`, moderation `{version:"0.1.0", patches:[]}`); dict
  v2 sha256 a1786956… matches the seed.
- Website status.json: 43 existing, 0 pending. OAuth chain by
  execution: Sign in opens
  `github.com/login/oauth/authorize?client_id=Ov23lic8terv0XOd3GDe&redirect_uri=arknetz%3A%2F%2Foauth%2Fcallback&scope=read%3Auser+public_repo`.
  Claim dry-run stops exactly at "Sign in with GitHub first to claim
  a domain" with zero GitHub calls. Publish as guest refuses exactly.
  HTML import: 4 blocks from a fixture, imported <strong> renders bold
  in the canvas. Table insert renders a full grid in the canvas
  (Header 1-3, +Row/-Row/+Column/-Column); list insert works.
  Dark mode toggles app-wide (body rgb(17,24,39)). No real 404s in
  the console (the one 404 was the deliberate bad-URL import test).
- Hunt-1 regressions all hold: Account Switcher Pill is a real top-bar
  pill with a working menu ("No accounts signed in… + Add Another
  Account"); panel nav scrolls the panel into view; URL-import
  failures surface in the status line; domains terms checkbox is
  inline with its label; slash row fits at 390px (rowScrollW ==
  rowClientW == 358, + Block visible); no horizontal scroll at 390px;
  claim watcher polls while pending. Bold (M2) re-verified with real
  mouse events: `<strong>MOUSEBOLDTEST</strong>` in the live canvas
  AND the preview (an earlier execCommand-based probe was a false
  alarm — it targeted the Hero title, not a text block, and read a
  stale detached node).

### Bugs found and fixed
- **Topbar scrolled off-screen at load (MEDIUM-HIGH):** on load the
  app scrolls the reader into view (main.ts showReader), while the
  topbar was `position: static` — scrollY 166 at load, brand /
  account pill / Sign in button invisible until the user scrolled
  up. Fix: `.an-topbar` is now `position: sticky; top: 0;
  z-index: 50`. First attempt (sticky alone) did NOT work: `body`
  and `html` carried `overflow-x: hidden`, which computes
  `overflow-y` to `auto`, making body a scroll container that
  breaks sticky in Chrome (proven via getComputedStyle: sticky
  applied, header still at top -166). Fix: `overflow-x: clip`
  on html/body instead — clip prevents sideways scrolling without
  creating a scroll container, so sticky works. The B7 test now
  asserts `overflow-x: clip` and forbids `hidden`. Verified:
  headerTop 0 at load and after scrolling, desktop and 390px;
  mobile docScrollW still 390 (no horizontal overflow).
- **Collab-join refusal overwritten by autosave (MEDIUM):** as a
  guest, Join showed "Collab needs your own GitHub token…" at
  500 ms, but a pending autosave replaced it with "Autosaved
  locally…" at 1000 ms — a ~500 ms window to read why Join did
  nothing. Root cause: handleCollabJoin's catch set the status
  without the M4 `statusHoldUntil` that the HTML-import failure
  path uses. Fix: the catch now arms the 10 s hold before
  setStatus. Verified: refusal persists through a full 10 s trace
  after a dirty edit. Test added (integration-round2): refused
  join + driven autosaveNow keeps the refusal.
- **Manifest `pendingRepos` stale (MEDIUM, data):** the
  protocol-root manifest still listed arknetz-actions,
  arknetz-mirrors, arknetz-website as pending — all three have
  existed since 2026-11-21 12:15. Fixed in the seed manifest and
  in BUILD-SEED.mjs (which hardcodes the list and would have
  reintroduced it on the next rebuild), plus the seed README
  paragraph; re-pushed to arknetz-protocol-root.
- **Stale "central repos don't exist" copy (LOW, five places):**
  footer ("until the central repos exist"), reader demo note
  ("the registry does not exist yet"), demo-site quote in
  sample.ts, mail panel note ("directory is empty until the
  central repos exist"), editor sidebar gate note ("the GitHub
  Action … follows with the central repos"). All reworded to the
  true state (registry live, no sites/contacts published yet; no
  validating Action exists yet). The identical sentence inside
  `ZSTD_DICTIONARY_CONTENT_SOURCE` (zstd.ts) was deliberately
  LEFT alone: it is dictionary training data, clearly labelled
  invented sample data, and changing it would desync the corpus
  from the shipped dictionary bytes.

### Version alignment (release prerequisite)
- package.json said 0.3.0, tauri.conf.json and Cargo.toml said
  0.1.0, the footer said "core shell 0.1.0 + visual builder
  0.3.0" — and the AppImage was named _0.1.0. The app reports
  its version nowhere else (no About/version UI). Aligned
  everything to **0.4.0**: minor bump for the feature-round-2
  additions since 0.3.0 (real-time collab, tables/lists, HTML
  importer). 0.3.1 was claimed in one earlier report but never
  landed in package.json, so it would understate the additions.
  Left alone deliberately: PROTOCOL_VERSION 0.1.0 (protocol
  version), registry/moderation entry `version: "0.1.0"` (data
  format versions). `src-tauri/gen/android/app/tauri.properties`
  is autogenerated (versionName=0.1.0) and refreshes from
  tauri.conf.json on the next Android build — verify it reads
  0.4.0 when the APK is rebuilt for the release.

### Still not verified live (do not claim)
- Live OAuth sign-in (needs Stanley's runtime client secret),
  live mail round-trip, live IA upload (needs a test account's
  own keys), live collab session between two signed-in peers,
  live REGISTER round-trip under the new issue-based workflow
  (no Action run has happened anywhere yet), deep-link end-to-end
  launch, AppImage launch (no /dev/fuse in VM), Windows.exe on
  real Windows, Android.apk signing + install.

### Hunt 3 delivery record
- Tests: 627 -> **629 pass, 0 fail** (2 new: sticky-topbar +
  single-version footer in app.test.ts; collab-join hold in
  integration-round2.test.ts; B7 assertion updated to
  `overflow-x: clip`).
- Client re-pushed 2026-11-21 ~21:35: commit
  **fde9aaa63a08f00c9dc59350115c74a4ef573262** (13 files, read-back
  verified live: package.json version 0.4.0, tauri.conf.json
  0.4.0, footer "ArkNetzWebWeaver 0.4.0").
- Protocol-root re-pushed: commit
  **246735afa2af5daa402f595201f73b5bed2fe791** (manifest.json +
  README.md; live manifest now `pendingRepos: []`).
- Linux artifacts rebuilt (tauri build exit 0, version 0.4.0 in
  filenames): **ArkNetzWebWeaver_0.4.0_amd64.deb 4,526,154 B**,
  **ArkNetzWebWeaver_0.4.0_amd64.AppImage 83,171,832 B**,
  ArkNetzWebWeaver-0.4.0-1.x86_64.rpm 4.32 MiB, binary
  11,645,672 B. The VM had reset since hunt 1: Tauri -dev
  packages were gone and the Hatch-patched libzstd1 was back —
  reinstalled the deps and re-downgraded libzstd1 to stock
  1.5.5+dfsg2-2build1.1 (backup .so still at
  build/sysdeps-backup/libzstd.so.1.5.5); a future VM reset will
  need the same two steps again.
- Real Tauri binary launched under Xvfb and screenshotted
  (qa-screenshots/hunt3/53-tauri-0.4.0-xvfb.png): renders
  correctly, topbar pinned with brand + Guest pill + Sign in.
  AppImage launch still unverified (no /dev/fuse in VM).

---

## P2P phase 1 — optional WebRTC transport core (2026-11-21, NEW FILES ONLY)

Stanley decided 2026-11-21 14:18: **"Do it all"** — every P2P
surface, not just one. Phase 1 is the transport core + spec only:
**new files under `src/lib/p2p/` + new tests + `P2P-SPEC.md`** at
the repo root (`~/workspace/arknetzwebweaver/P2P-SPEC.md`). No
existing file was edited (a bug-hunt agent was editing the same
scaffold at the time). **No wiring into the app yet** — that is
phase 2, after bug hunt 3 lands. No push, no release, no keystore
touch, no dictionary touch (separate drop job queued).

**Design, in one paragraph:** optional WebRTC data channels, OFF by
default, GitHub stays the fallback and the source of truth for every
feature. No central server. No shared/master keys — each user still
signs in with their own per-backend accounts. Signaling goes through
GitHub: registry/contacts entries carry a peer advertisement (public
peer ID + capabilities, never a private key), and peers connect
directly after that. Payloads reuse the app's existing encryption:
site bundles are public content (verified on receipt), collab edits
ride the channel as they ride the branch, mail reuses the X25519
wrapped-key scheme, drive chunks are AES-256-GCM before they leave
the device.

**Files** (`src/lib/p2p/`, 13 files + README):

| File | What it does |
|---|---|
| `types.ts` | `P2PSettings` + `defaultP2PSettings` (everything off; maxPeers 8; maxUploadKBps 512), `P2PTurnConfig`, `PeerAd`, `SignalMessage`, `ControlMessage` union, channel labels `arknetz/site`, `arknetz/collab`, `arknetz/mail`, `arknetz/drive` |
| `ice.ts` | No-account ICE assembly + diagnostics (§7 below) |
| `identity.ts` | `generatePeerId` (16 random bytes → 32 hex), `buildPeerAd` / `parsePeerAd` (1 h TTL, future-skew guard, domain/owner pinning), `peerAdUrl` (raw.githubusercontent.com, site repo, `peer-ad.json`) |
| `signaling.ts` | `SignalingClient` — fetch/publish ads via Contents API (SHA guard), sealed signal Issues (`ARKNETZ-SIGNAL <id>`, label `arknetz-signal`, ```` ```arknetz-signal ```` fence, sealed with `sealBytesForRecipient` to the recipient's X25519 mail key), poll + skip-counting |
| `transport.ts` | `P2PConnection` interface, `LoopbackConnectionFactory` (in-memory paired connections, same ordering/close semantics — the test double), `WebRtcConnectionFactory` (browser-only; throws a plain error in Node) |
| `transfer.ts` | Frame codec (`0x01` JSON control / `0x02` chunk, 16 KiB chunks), SHA-256 verification, missing-chunk retry (fixed during testing: originally only checked on count-complete, which would have hung on a dropped middle chunk), token bucket (default 512 KiB/s), caps: site 25 MB, mail 10 MB, drive chunk 10 MB+28, collab batch 1 MB |
| `peer-manager.ts` | Settings, handshake state machine, glare rule (smaller peerId keeps its initiated connection), 30 s handshake / 10 s hello / 60 s silence / 5 min keep timeouts, session-only block-list, 3-strikes disconnect |
| `site-sharing.ts` | Serve cached bundle only; fetch verifies SHA-256 when supplied + always decompresses + parses the site document and checks its `domain` equals the requested domain; null = CDN fallback. **Honest gap:** registry entries carry no content hash, so a first-time fetch cannot be verified against the registry pointer — needs a protocol change (`siteSha256` on registry entries), flagged, not claimed. |
| `collab-p2p.ts` | `hello` / `op` / `cursor` control messages; existing `diffBlocks` / `applyBlockOps` (per-block last-write-wins on `(updatedAt, author)`); team-login filter on incoming ops/cursors; branch relay stays authoritative |
| `mail-p2p.ts` | Sealed envelope (`sealMail`) sent as one transfer; receiver parses with the same validation as an inbox Issue; `transfer-done { ok: true }` is the receipt; no peer / no receipt → Issue inbox exactly as today |
| `drive-p2p.ts` | Stored chunk bytes only (`iv | ciphertext`); vault-id gate (unknown vault refused before transfer); receiver re-verifies via existing `decryptChunk` |
| `index.ts` / `README.md` | Barrel exports; module readme (file table, rules, tests) |

**Tests** (`tests/p2p-*.test.ts`, 7 files): ice, identity,
signaling, transport, transfer, peer-manager, adapters. **49 P2P
tests, all passing; full suite 704 pass, 0 fail** (`npm run build`
exit 0, `npm test` exit 0, 2026-11-21). Real WebRTC is NOT tested:
Node has no WebRTC (verified: `RTCPeerConnection` is `undefined` on
Node v24.22.1, `--experimental-webrtc` is not a valid flag), so the
loopback factory is the test double and real peer connections need
two real devices in phase 2.

**TURN — the 14:22 decision (Stanley): add ALL the ICE/TURN options
that work WITHOUT creating any account.** No personal accounts of
his used to create keys, no signups in his name. Wired into
`ice.ts` (`assembleIceServers`):

- **STUN, default on, 9 servers in order:** Google
  `stun.l.google.com:19302` + `stun1`–`stun4` on `:19302`,
  `stun:stun.cloudflare.com:3478` (Cloudflare states free and
  unlimited), `stun:openrelay.metered.ca:80`,
  `stun:stun.stunprotocol.org:3478`, `stun:freeturn.net:3478`.
  **Twilio STUN dropped** — one source claims it needs API
  credentials; it could not be probed from this VM, so per the
  "include only if it answers" rule it is out.
- **TURN fallback, freeturn.net** — `turn:freeturn.net:3478` +
  `turns:freeturn.net:5349`, `free`/`free`. Included by default when
  TURN is on, labelled "community-run, no SLA, not a production
  dependency".
- **TURN opt-in fallback, Open Relay demo credential** —
  `turn:openrelay.metered.ca:80` + `turns:openrelay.metered.ca:443`,
  `openrelayproject`/`openrelayproject` (published in Metered's own
  docs). Behind the `useOpenRelayDemo` toggle, **off by default**,
  labelled "community shared credential — anyone can use it, quota
  is shared, may be rate-limited or revoked". Never the default,
  never presented as private; inert unless the master TURN switch
  is on.
- **Static-auth explicitly NOT used** (`staticauth.openrelay.metered.ca`)
  — shared credential for self-hosted servers, not clients.
- **Per-user credential fields stay empty-by-default** (Metered API
  key, Cloudflare TURN, custom TURN) for users who bring their own
  keys. `meteredOwnTurnServers(apiKey)` deliberately returns `[]` —
  a bare API key is not a TURN entry; real entries come from
  Metered's API response (phase-2 wiring point).
- **Why this does not break the no-shared-keys rule:** freeturn and
  demo credentials are public, published by their operators for
  anyone to use, with no account behind them and no secret of
  Stanley's (or any user's) involved. Nothing personal of his was
  used — no account created, no signup, no email.
- **Settings UI note + diagnostics** (specified in P2P-SPEC.md
  §7.6, constants in `ice.ts`): plain-words note that relayed
  traffic passes through the relay operator's servers, content is
  DTLS-encrypted so the operator cannot read it, but the operator
  sees both peers' IPs; and a diagnostics line naming the ICE path
  that succeeded (`direct (host)` / `direct (srflx)` / `relayed via
  freeturn.net` / `relayed via openrelay.metered.ca (demo
  credential)` / `relayed via your own TURN server` /
  `loopback (test only)` / `unknown`).

**Endpoint verification (2026-11-21): no server probed live from
this VM.** Hand-built STUN binding (RFC 5389) + TURN allocate
(RFC 5766) probes: all UDP sends fail EPERM (VM blocks UDP egress),
all TCP reset by the egress proxy, TLS to freeturn.net:5349 fails
(proxy speaks plain HTTP). Uniform across every endpoint including
Google's STUN — the block is local to the VM, not per-server. DNS
resolves for all hosts (via proxy). curl HTTPS: metered.ca/tools/
openrelay/ → 200; freeturn.net → 000; openrelay.metered.ca → 000.
Credentials confirmed independently by web search from live sources
(freeturn `free`/`free` per Mozilla bug tracker; demo credential per
Metered docs, RomM docs, dev.to, GitHub READMEs). **Runtime ICE
gathering + the diagnostics line on a real device is the real
verification**; a server that does not answer simply drops out of
the fallback order.

**Phase 2 wiring points** (P2P-SPEC.md §13): `app.ts` panel wiring
(settings persistence in IndexedDB per device, settings panel,
peer-ID rotation/reset, per-feature toggles); site reader try-peer-
first then `RegistryResolver.loadSite`; collab session start
`P2PCollabSession` alongside the relay poll (slow the poll while
P2P is connected; team check before accepting); mail compose/send
try `MailP2P.deliver` when the recipient is an online peer, inbox
poller also polls `arknetz-signal` Issues; ArkDrive sync offer
`DriveP2P` between own devices (repo blobs stay the durable copy);
`PROTOCOL.md` §16 merge + `peer-ad.json` in the repo topology;
manual verification on real devices (two browsers, different
networks, one behind a symmetric NAT, with and without TURN).

**Open decisions for Stanley:** none blocking phase 2 — the TURN
default question is settled by the 14:22 decision. The remaining
protocol decision is the optional `siteSha256` on registry entries
for first-time site-fetch verification (§8.1 honest gap).

## Bug hunt 4 (hunt 4 in the notes) — LIVE v0.4.0 → 0.4.1, 2026-11-21

Trigger: Stanley's 14:13 PST report from his Pixel 7 Pro — (1) "Sign in
with GitHub opens GitHub sign in but it doesn't redirect to the
authenticated app", (2) "the UI kinda looks like shit rn at least on
mobile". Folded in from the 0.4.0 benchmark: (3) in-app reader sub-page
nav broken for the demo site (0/5), (4) static export nav links are dead
`arknetz://` URLs in a normal browser. NOT acted on: the Lighthouse 100
regression (91 on `/` — a reporting correction) and the zstd v2
dictionary saving zero bytes (Stanley's decision, queued after hunt 3).
Full record: `qa-screenshots/hunt4/HUNT4-NOTES.md` (audit in
`hunt4/mobile/`, re-verification in `hunt4/recheck/`).

Live verification first: live client clone at head
`fde9aaa63a08f00c9dc59350115c74a4ef573262` — source code ZERO drift vs the
scaffold (only this file differs: the scaffold has the Hunt 3 delivery
record the live repo lacks — included in the re-push).

### BUG 1 — OAuth sign-in never returns (root causes, all verified)

1. No opener plugin: `window.open(url, "_blank")` with no
   tauri-plugin-opener behind it. On Android the generated
   `RustWebChromeClient.kt` has NO `onCreateWindow` and
   `setSupportMultipleWindows` is never set, so `window.open` is a
   silent no-op.
2. Rust nav guard (`should_block_top_level_navigation` in lib.rs)
   blocks ANY top-level `arknetz://` navigation in-app, so the
   `arknetz://oauth/callback` redirect can never be delivered.
3. The code exchange reads the client secret ONLY from env var
   `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET`, which cannot exist inside a
   released APK — even a delivered callback fails with `not_configured`.
4. The OS return path itself is FINE (released 0.4.0 APK manifest has
   the deep-link intent filter; `MainActivity` → `TauriActivity` →
   `onNewIntent`; `tauri.conf.json` mobile deep-link config present;
   `launchMode="singleTask"`).
5. Live GitHub endpoint tests (Client ID `Ov23lic8terv0XOd3GDe`):
   device-code request → `device_flow_disabled`; token exchange with
   bogus code + code_verifier and NO secret → `incorrect_client_credentials`
   (PKCE does NOT let this OAuth App exchange without the secret);
   authorize URL GET → HTTP 302 to github.com/login, no redirect_uri
   mismatch.

Fix: GitHub **device flow as the primary sign-in** (client id only — no
secret, no redirect, no deep link) + **opener plugin** (GitHub opens in
the system browser) + redirect flow kept as fallback for desktop
env-var users. `src/lib/auth.ts`: `requestDeviceCode()`,
`pollDeviceToken()`, `completeDeviceSignIn()`; `src/lib/opener.ts`
(new): `openExternalUrl()`; `src-tauri/Cargo.toml`:
`tauri-plugin-opener = "2"` + `.plugin(tauri_plugin_opener::init())` +
`"opener:default"` capability; `src/main.ts`: `startGitHubSignIn()`
rewritten as async device-flow primary (code + "Open github.com/device"
+ "Cancel" in `#signin-status`, auto-open via opener, cancellable poll),
old behaviour preserved as `startRedirectSignIn()`. Tests: +8 auth, +3
opener (new file).

Live proof: the app's own compiled `requestDeviceCode` against live
GitHub threw exactly "Device Flow is not enabled on this OAuth App.
Enable it in the OAuth App settings (…), then try again." — the client
code works; the gate is the checkbox. **Stanley's decision still needed:
enable Device Flow on the OAuth App, or sign-in on the phone stays
broken.** Device-flow UI verified in headless Chrome with a stubbed
fetch (strip visible, code shown, Open + Cancel present). Cargo check
for the opener plugin registration is NOT yet compile-verified: the
VM/service restart wiped the Tauri `-dev` system packages and the
reinstall was still running at the end of this hunt (apt-get update took
~2 min at ~7 KB/s through the egress proxy).

### Benchmark finding 1 — reader sub-page nav (FIXED)

`parseAddress()` mapped ANY path on `welcome.arknetz` to kind "demo"
and `renderCurrent()` always rendered the whole `DEMO_SITE`.
`SiteDocument` now has optional `pages?: Record<string, SiteDocument>`
(types.ts); `src/lib/pages.ts` (new): `pageSlugForAddress()` +
`sitePageForPath()`; `DEMO_ABOUT` + `pages: { about: DEMO_ABOUT }` in
sample.ts; main.ts resolves via `sitePageForPath` (unknown slug → root
doc). Edit toggle is DISABLED on sub-pages (read-only in this version —
the editor publishes the document it opened as the site root, so editing
a sub-page would overwrite the root with it). Verified in headless
Chrome at 360/390/412: clicking "About the protocol" → address
`arknetz://welcome.arknetz/about`, H1 "About the protocol". Tests:
`tests/pages.test.ts` (new, 4 tests).

### Benchmark finding 2 — export arknetz:// links dead (FIXED)

`RenderOptions.rewriteHref?` (renderer.ts, applied after the allow-list
check; `data-arknetz-link` marker computed from the FINAL href);
`exportStaticFiles` rewrites same-domain arknetz:// links to relative
URLs per page depth; cross-domain links stay as-is; favicon/stylesheet
links relative too (depth-aware `../` prefix); sub-page body from
`doc.pages?.[slug]` when present. Tests: +2 export, +2 renderer.

### BUG 2 — mobile UI (audit: 10 defects, all fixed and re-verified)

Audit: `hunt4/mobile/MOBILE-AUDIT.md` (360/390/412 × 844, DSF 2, touch).
- **H1 (HIGH)** panel heading under the sticky topbar on load/switch —
  `src/lib/scroll.ts` (new): `scrollBelowTopbar()` measures the real bar
  height; `showPanel` uses it instead of `scrollIntoView`. Verified: h2
  top 212–269px vs topbar bottom 57–60px.
- **H2 (HIGH)** editor Back button under the topbar — all 3
  `scrollIntoView` calls in main.ts replaced. Verified: Back top 73–77px.
- **M1** code blocks clipped — READER_CSS + `pre.an-ed-text` wrap on
  narrow screens (`overflow-wrap:break-word`, NOT `anywhere` — the first
  draft used `anywhere` and tripped the B9-nit guard in app.test.ts).
- **M2** tap targets ~28px — 44px min-height/min-width rules in
  styles.css. Verified: editor bar buttons all 44px.
- **M3** topbar two rows at 360px (80px) — one-row rule under 400px.
  Recheck follow-ons: Guest pill wrapped mid-word ("Gues / t") → pill
  nowrap + ellipsis; brand `flex-shrink:0` stopped it truncating so the
  pill squeezed to "Gu…" → `flex-shrink:1` + smaller brand/sign-in.
  Final 360px topbar: full brand, full "Guest", full "Sign in with
  GitHub", one row, 57px.
- **M4** panels stacked above the full reader — `onPanelShown` hides
  `main.an-layout` except Browse/Builder. Verified: hidden on Mail,
  visible on Browse.
- **M5** format toolbar below the fold after tapping text — wrap click
  handler scrolls the block's `.an-fmt-bar` into view ONLY when hidden.
  Verified with a real below-fold tap: fmt bar y=994 → y=68 (topbar
  bottom 60).
- **L1** ToS checkbox 13px → 20×20 + `accent-color:#2563eb`. Verified.
- **L2** Wayback placeholder truncated at 360px → `https://…/site.json.zst`
  (verified in shipped dist; panel is `needsSignIn`, guest-hidden).
- **L3** disabled button low-contrast → `color:#4b5563;background:#f3f4f6;
  opacity:1`. Verified.
- **Hunt-4 regression caught by the recheck (own goal, fixed):** the M4
  `onPanelShown` browse-scroll fired on MOUNT too, yanking a fresh load
  ~1300px down (fresh scrollY 1274–1413). Fix: `showPanel(panelId,
  scroll = true)` with the mount call passing `false`, and `onPanelShown`
  only scrolls when main WAS hidden. Verified: fresh load scrollY 0 at
  all widths. No horizontal overflow at any width; Hunt 2 #1/#9/#11 and
  Hunt 3 #1 still hold.

### Battery and version

- Battery: **704 pass, 0 fail** (final run 2026-11-21 ~23:00 UTC;
  `tsc --noEmit` exit 0; was 629 at 0.4.0, +75 tests incl. 26 hunt-4
  and the P2P phase-1 suite). NOTE: a mid-hunt full run showed 701/704
  with `tsc` errors in peer-manager/signaling/transport — a STALE dist
  built while the sibling P2P agent was mid-write (its files finished
  changing 22:35 UTC); the source tree was never red after that. This
  hunt touched NO p2p file. **Re-push DONE 2026-11-21 ~22:58 UTC: live
  head `d07418664f9f4142ab9020fa1af8ec1928882e45`** (28 files, all
  byte-verified live). No release created; keystore untouched. The P2P
  phase-1 files are green in the scaffold but unpushed (separate
  program's step).
- Version bumped to **0.4.1** (patch) — package.json, tauri.conf.json,
  Cargo.toml, footer, hunt-3 version test. PROTOCOL_VERSION 0.1.0 left.

### Still needs a real-device check (only Stanley)

OAuth on a real phone (enable Device Flow first — see above); APK
install on a real device (0.4.1 never built as a release — no `tauri
build` was run per the benchmark constraint); `cargo check` for the
opener plugin — PASSED (exit 0, 2m 09s, after the system-deps reinstall);
live REGISTER round-trip
(no GitHub Action has run anywhere yet); live mail/IA/collab round-trips.

## Zstd v2 dictionary drop (2026-11-21, Stanley's decision 14:17 PST)

- **Decision:** drop the v2 dictionary. The benchmark (BENCHMARK-0.4.0.md)
  found it saves ZERO bytes on every realistic payload tested; plain zstd
  keeps every measured win. Stanley: "I guess drop the dictionary".
- **Re-measured evidence (in-app engine, this VM) — the honest correction
  to the benchmark's "0 bytes" shorthand:** on TINY docs the dictionary
  does save bytes (158 B site: plain 122, v2 82, v1 69; 191 B registry:
  plain 128, v2 61, v1 37; 125 B mail: plain 112, v2 50, v1 53). At
  realistic scale the advantage is negligible and sometimes negative:
  100-entry registry (14,251 raw): plain 729, v2 1,306 — v2 WORSE by 577;
  1,000-entry registry (126,451 raw): plain 4,224, v2 3,970 — 254 bytes
  (0.2% of raw); 92 KB site: plain 182, v2 141 — 41 bytes. Tests assert
  the measured bound (≤300 bytes either way at realistic scale) plus
  plain zstd keeping the real win (>10×), NOT "zero bytes" on small docs.
- **Client (`src/lib/zstd.ts`):** `compressBytes` now plain
  `engine.compress` — new frames carry NO DictID. `decompressBytes`
  unchanged: tries v2, then v1, then plain, so every already-published
  dictionary frame (DictID `0x41524B02`) still decodes — nothing on
  GitHub breaks. `compressBytesWithDictionary` /
  `decompressBytesWithDictionary` kept as legacy/explicit (old-frame
  fixtures need them). `ZSTD_DICTIONARY_CURRENT_*` /
  `getCurrentZstdDictionary()` kept but re-documented as the legacy
  decode dictionary. The client never fetched a dictionary at runtime
  (dictionaries were embedded), so there was no startup/sync fetch to
  remove. `ZSTD_DICTIONARY_CONTENT_SOURCE` deliberately UNTOUCHED — it
  is shipped training data for the v1 decode dictionary; changing it
  would desync corpus from shipped dictionary.
- **Workflows:** client `protocol/register.yml` rewritten to 253 lines —
  plain `zstd -d` / `zstd`, no dictionary fetch, no `-D`; comments
  explain old dict frames fall back to the plain mirror and get
  rewritten as plain zstd. Copied to all 17 seed copies (16 registry
  shards + arknetz-actions), verified byte-identical, zero
  `zstd-dictionary` / `-D` references. **Live GitHub shards +
  arknetz-actions still hold the 255-line dict version** — workflow
  files cannot go via the connector (403); the web-UI pass is the
  parent's step, using `protocol/register.yml` in the client repo as
  the exact fixed text (253 lines).
- **Docs:** PROTOCOL.md §4 carries the deprecation note (evidence +
  re-measured numbers; new files plain zstd; manifest `zstdDictionary`
  field deprecated and ignored; `.bin` files stay published, never
  deleted; decoder keeps v2→v1→plain). Seed
  `github-seed/arknetz-protocol/PROTOCOL.md` synced byte-identical.
  Seed `github-seed/arknetz-protocol/README.md` updated (deprecation
  banner, v1/v2 marked decode-only, `.bin` files kept).
  `dict-training/` left alone (historical training record). P2P-SPEC.md
  has no dictionary references — nothing to change there.
- **Tests:** new `tests/zstd-dictionary-drop.test.ts` + updated
  `tests/zstd.test.ts`, `tests/zstd-dict-v2.test.ts`,
  `tests/zstd-registry.test.ts`. Scope battery **30 pass, 0 fail**
  (re-verified after the full run). Full battery at drop time: **758
  tests, 749 pass, 9 fail** — all 9 failures are media/p2p call tests
  from the parallel media agent's in-progress work (recording consent,
  quality monitor relayed event, getUserMedia failure, mixer
  re-election, declined-call ×2, CallManager busy ×2, 1:1 voice/video
  flow); zero failures in dictionary scope. `npm test` could not run
  end-to-end at the time because `npm run build` chains on `tsc` and
  the parallel agents' in-progress files had type errors (tsc still
  emits JS; manual `npx tsc` → `copy-assets` → `node --test` was the
  working battery route).
- **Push:** client repo re-push DONE — live head
  `cb0ff1d777c7a62bb775c0be1754b4b4627b83c6` (8 files, all byte-verified
  live); protocol-repo README + PROTOCOL.md re-push DONE — live head
  `985d2098606ef49e32af7087a7dcda8a6f237d43` (2 files, byte-verified).
  No release created; keystore untouched.
