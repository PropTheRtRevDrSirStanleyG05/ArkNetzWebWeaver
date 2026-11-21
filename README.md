# ArkNetzWebWeaver — core shell v0.1.0 + visual builder v0.3.0 (local scaffold)

Zero-server, $0/month decentralized web by STANBEYOND. **Licence: MIT**
(decided by Stanley 2026-11-20; see `LICENSE`, Copyright (c) 2026
PropTheRtRevDrSirStanleyG05 / STANBEYOND).

This is the **core shell + visual builder + all four pre-GitHub phases**
(mail, ArkDrive, viewer/network features, domains/moderation/backends/
Wayback/multi-account/ToS/PROTOCOL.md), integrated into one app object
and mounted as 13 sidebar panels. Full integration record, per-phase
file trees, test counts, and the honest-gaps list:
`INTEGRATION.md` in this directory.
Full brief: `~/workspace/arknetzwebweaver/THREAD-SPEC.md`.
Repo topology: `~/workspace/arknetzwebweaver/REPO-TOPOLOGY.md`.
Readiness/parity bar: `~/workspace/arknetzwebweaver/READINESS-PARITY.md`.

## What the shell does

- **Anonymous guest browsing is the default on launch.** No sign-in is
  required to read. A bundled demo site (`welcome.arknetz`) renders so the
  shell is usable before any central repo exists; it is labelled a demo.
- **Tabs, bookmarks, back/forward** per tab (`src/lib/shell.ts`).
- **GitHub OAuth sign-in as a real entry point** (`src/lib/auth.ts`):
  builds the real `https://github.com/login/oauth/authorize` URL with a
  random `state`, validates the redirect, and exchanges the code only in
  the Tauri Rust command, because the client secret must never be in the
  webview. It throws loudly until a GitHub OAuth App client id is set in
  `src/lib/config.ts` and `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET` is supplied
  to the shell at runtime. No fake tokens, ever.
- **IndexedDB ETag cache** (`src/lib/cache.ts`): reads hit
  `raw.githubusercontent.com` only — never `api.github.com`. A 304 returns
  the cached body with 0 bytes; a network error with a cached copy returns
  the stale copy instead of a blank page.
- **Sharded registry resolution** (`src/lib/registry.ts`): `SHA256(domain)`
  first hex digit → `arknetz-registry-0x` (16 shards, expandable to 256);
  protocol-root manifest fetched first, with a built-in default fallback
  if it is unreachable. Entry shard fields are verified against SHA256.
  Mirrors are tried in order. Master account:
  `PropTheRtRevDrSirStanleyG05`.
- **Shared block renderer** (`src/lib/renderer.ts`): the ONE renderer the
  visual builder must reuse — never duplicate it. Renders a `SiteDocument`
  to standard HTML5 + CSS3, escapes all text, allow-lists URLs to
  `archive.org` / `raw.githubusercontent.com` / `arknetz:` deep links, and
  renders `["app", ...]` blocks only as sandboxed iframes.
- **Stealth Internet Archive media** (`src/lib/ia-media.ts`): attaching a
  file returns a local blob preview immediately while the upload runs in
  the background through a polite queue (max 2 concurrent, ~120 ms
  stagger, exponential backoff on 429/503, max 5 attempts). On success the
  post stores ONLY the hotlink `https://archive.org/download/<item>/<file>`.
  The local copy is kept until the upload succeeds. Thumbnails (~12 KB
  WebP) go to IA the same way, never to a GitHub repo. IA S3 keys are the
  user's own, stored AES-256-GCM encrypted in IndexedDB (PBKDF2, 100k
  iterations) — never hardcoded, never in code. If IA is not linked the
  module reports `ia_not_linked` and uploads nothing.


## Visual builder v0.3.0 — what it does (new in v0.3.0)

- **Live canvas, same renderer.** Click “✎ Edit site” in the toolbar to
  edit the site the reader is showing. The canvas is click-to-type
  (contenteditable) and the live preview below it renders through the
  SHARED renderer (`renderSiteDocument`) — what you edit is exactly what
  a reader sees. Closing the editor re-renders the reader from the
  edited document. No second renderer anywhere.
- **Blocks** (`src/lib/blocks.ts` — the whitelist): hero, nav, h1–h3, p,
  cols, cards, series-grid, img, video, audio, code, quote, link,
  docs-sidebar, gallery, plus `["app", ...]` sandboxed iframes. Typed
  semantic JSON only; unknown types are rejected at validation and
  rendered as a visible placeholder, never as raw HTML. App blocks over
  the ~150 KB cap are rejected.
- **Slash commands + inserter + drag reorder.** Type `/h2 My heading`
  (or plain text for a paragraph) in the insert box, pick from the block
  inserter, or drag blocks by their handle. Each block has a floating
  toolbar (move up/down, duplicate, delete).
- **Themes** (`src/lib/themes.ts`): Academic/University, Tech Docs,
  Editorial Magazine, Minimalist Portfolio — CSS Custom Properties, plus
  dark/light mode. The preview uses the same variables as the reader.
- **Reusable components + global navigation.** Header/footer persist
  across pages; “+ Add page” adds a nav entry that shows on every page
  of the domain.
- **Responsive:** per-block visibility checkboxes (desktop / tablet /
  mobile) in the settings sidebar; the renderer emits `an-hide-*`
  classes with matching media queries.
- **Revisions + autosave** (`src/lib/revisions.ts`): local autosave
  (debounced, IndexedDB-shaped store), “Save revision”, and a visual
  diff (added / removed / changed / same, matched by block id). A failed
  autosave reports the exact reason and a retry countdown — never a
  silent fail. **Publish is real in v0.3.0**: it Zstd-compresses the
  document to `site.json.zst` and PUTs it to the per-domain site repo
  via the GitHub Contents API (GET first for the existing SHA on
  updates), batched on Publish only. If the repo does not exist yet or
  the user is not signed in, Publish says exactly that and pushes
  nothing. The dry-run preview (byte counts, SHA check) is still
  available in `EditorState.publishPreview`.
- **Inline rich text (v0.3.0)** (`src/lib/inline.ts`): bold, italic,
  underline, strikethrough, inline code, and links on selected text in
  p/h1–h3/quote blocks, via a format toolbar above each text block.
  Stored as typed inline runs on the BlockNode — never raw HTML — and
  the shared renderer renders the same runs in the reader.
- **Media crop/flip/rotate (v0.3.0)** (`src/lib/media-edit.ts`): on image
  blocks, a crop panel (aspect 1:1/4:3/3:4/16:9/9:16 or freeform),
  rotate 90° steps, flip H/V — applied before the stealth IA upload,
  in the fixed order crop → rotate → flip → downscale (max 1600px,
  WebP 80% / AVIF when available, ~12 KB thumbnail). The 6 MB
  phone-photo downscale now runs in the attach flow itself, not only
  in the IA path.
- **Zstd (v0.3.0)** (`src/lib/zstd.ts`): real compression/decompression
  for `.json.zst` via `@bokuweb/zstd-wasm` (MIT); the registry reader
  tries `.json.zst` first and falls back to plain `.json` on 404, and a
  corrupt `.zst` throws instead of silently falling back.
- **IA account linking (v0.3.0)** (`src/lib/ia-settings.ts`): a Settings
  screen links the Internet Archive account (S3 keys encrypted under a
  passphrase in IndexedDB), shows linked/locked status, tests the
  connection, and unlinks. After linking + unlocking, attachments go
  through the stealth IA upload instead of reporting `ia_not_linked`.
- **Media in the editor** (`src/lib/ia-media.ts`, reused): attach on an
  image/video/audio block shows a local preview immediately and uploads
  to the Internet Archive in the background; the post stores only the IA
  hotlink. Alt text, focal point (horizontal slider), and “mark as
  decorative” controls are in the sidebar / block. Lazy load on images.
- **WordPress import** (`src/lib/wxr.ts`): drop a WXR `.xml` export in
  the builder — posts/pages map to semantic blocks, `<script>`/embeds
  become sandboxed app blocks (never executed, never dropped),
  attachments and drafts are skipped and counted in the report.
- **Static export** (`src/lib/export.ts`): one-click `.zip` — a real ZIP
  (STORE method, hand-written CRC32, no dependency) containing
  `index.html`, `style.css`, and one page per nav entry, rendered by the
  shared renderer with IA hotlinks preserved. Drop it on Cloudflare
  Pages, Neocities, Netlify, or any static host.
- **Teams in the builder** (`src/lib/roles.ts`): all 12 flags from the
  thread (pages.draft / pages.publish, allowed_paths, apps.embed,
  media.upload, subdomains.manage, moderation.sub, comments.moderate,
  mail.read, mail.send, stats.view, team.manage). A role switcher in the
  builder bar demonstrates gating: a writer cannot Publish, cannot
  embed apps, and may only edit `blog/*`. **Client-side gating only** —
  the GitHub Action that validates commits to `site.json.zst` /
  `team.json.zst` follows with the central repos.

### Honest gaps vs READINESS-PARITY section 1 (do not claim these)
- No real-time multi-user collaboration — sequential editing only, by
  design for v1.0 (WordPress 7.0 pulled the same feature before shipping).
- No AI builder like EmDash Build, no MCP server, no x402 payments.
  Excluded entirely by Stanley, 2026-11-20 — not a gap, out of scope.
- No WordPress plugin ecosystem / PHP themes — the answer is sandboxed
  `["app", ...]` embeds, not plugins.
- No in-editor rich-text toolbar for tables or lists yet; inline
  formatting (bold/italic/underline/strikethrough/code/links) is in.
- Publish commits only to a site repo that already exists; this build
  creates no repos (the parent creates them after verification).

## Toolchain (checked 2026-11-20 on this VM)

- Node v24.22.1, npm 10.9.4 — TypeScript 5.9.3, @tauri-apps/cli 2.12.6
- Rust: **installed during this task** — rustc/cargo 1.100.0 (stable, via
  rustup; no toolchain was installed before)
- **Tauri binary DOES build on this VM now** (2026-11-20 23:40 UTC,
  after reinstalling the system deps — see below). Binary + `.deb` +
  `.rpm` rebuilt with all phases; AppImage step stalled (see below).
  The TypeScript build and the full test battery run and pass.

## Commands

```sh
npm install
npm run build    # tsc + copy index.html/styles.css into dist/
npm test         # build + node --test (320 tests)
npm run tauri:build   # needs the system deps below; see below
```

## Tests — 320 passed, 0 failed (2026-11-20, `npm test`)

- `tests/cache.test.ts` (5): 200 stores + ETag, 304 returns cached 0 bytes,
  stale copy on network error, 404 throws, raw-URL guard refuses
  `api.github.com`.
- `tests/registry.test.ts` (11): shard determinism/distribution, shard URL
  under the master account, entry/shard/site/manifest parsing, manifest
  shard-count validation, resolve + shard verification, wrong-shard
  rejection, mirror failover, manifest fallback when protocol-root is down.
- `tests/renderer.test.ts` (8): HTML escaping / injection, semantic blocks,
  IA hotlink accept vs tracker/non-https reject, `arknetz:` allow-list,
  sandboxed-iframe-only app blocks, nested cols/cards, unknown-block
  placeholder, full site document with theme accent.
- `tests/ia-media.test.ts` (12): item naming, hotlink, filename sanitising,
  backoff doubling + 30 s cap, upload success / 429-retry / 503-give-up
  after 5 attempts (local copy kept), 403 not retried, queue concurrency
  cap 2, `ia_not_linked` with no keys and no upload, attach → ready with
  hotlink, key encrypt/decrypt round-trip + wrong passphrase fails.
- `tests/shell.test.ts` (5): tabs, back/forward, forward-history truncation,
  last-tab close recreates home, bookmark add/dedupe/remove.
- `tests/auth.test.ts` (5): authorize URL throws with no client id, real
  GitHub authorize URL shape, random state, redirect state validation,
  master-user check (only `PropTheRtRevDrSirStanleyG05`).
- `tests/editor.test.ts` (10): whitelist coverage, app-cap rejection,
  slash parsing/suggestions, insert/move/delete/duplicate, typeLine,
  visibility, addPage updates global nav, publish preview + role refusal,
  app-block publish gating, default shapes for every type.
- `tests/builder.test.ts` (9): four theme presets + light/dark variables,
  role flags and path limits, id-matched revision diff, autosave success
  + named failure with retry delay, WXR parse/import (script → sandboxed
  app block), HTML→blocks mapping, static export files, real ZIP writer
  (CRC32, headers, filenames), renderer gallery/docs-sidebar/visibility/
  focal-point/decorative.
- Two bugs were found by these tests and fixed in the implementation:
  publish preview never checked `pages.publish` (a writer could publish),
  and the revision diff matched blocks by position instead of by id.

Tests mock the IA endpoint and the GitHub raw CDN — **no test ever hits
real IA or real GitHub**.

## Tauri binary build — current status (2026-11-20)

The stale "does not build here" note below is superseded. The VM was
reset after the 15:04 build, which removed the system -dev packages
and restored the Hatch-patched libzstd1; the first post-integration
rebuild failed at link time on the missing libraries. After
re-downgrading libzstd1 to stock `1.5.5+dfsg2-2build1.1` and
reinstalling `libgtk-3-dev libwebkit2gtk-4.1-dev
libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev`, the
binary compiled and linked cleanly at 23:40 UTC (binary 11,417,376
bytes, `.deb` 4,130,500 bytes, `.rpm` 4,135,248 bytes — fresh, with all
phases wired in). The AppImage step stalled in `appimagetool` (0 CPU
for 8+ min, likely FUSE / a pending runtime confirmation); the 15:04
AppImage (78.80 MiB, pre-phase code) is still on disk. See
`INTEGRATION.md` for the full record.

### Earlier history (kept for the record)

1. `npx tauri build` first failed on the config (fixed: `identifier` /
   `productName` / `version` are top-level in Tauri 2, not under `app`).
2. Then: `failed to run 'cargo metadata' … rustup could not choose a
   version of cargo … no default is configured.` — fixed by installing
   Rust stable 1.100.0.
3. Then `cargo check` (exit 101) fails on the system libraries:
   `The system library 'gdk-3.0' required by crate 'gdk-sys' was not found.`
4. Installing them is blocked by apt: `libwebkit2gtk-4.1-dev` needs
   `libzstd-dev`, which needs `libzstd1 (= 1.5.5+dfsg2-2build1.1)` — but
   this VM has `libzstd1 1.5.5+dfsg2-2build1.1+hatch1` (a Hatch-patched
   version) installed, so apt reports "held broken packages" and refuses.
   Downgrading a system library is out of scope for this scaffold; the
   binary should be built on a clean Ubuntu 24.04 machine (or CI) with
   `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
   librsvg2-dev libssl-dev libxdo-dev` installed, or on Stanley's Windows
   machine via the Tauri Windows toolchain.

The Rust code itself (`src-tauri/src/main.rs`, one command) has not been
compiled anywhere yet — do not claim it builds until a machine with the
system deps runs `cargo check` / `tauri build` cleanly. Re-checked in the
builder phase (2026-11-20, `cargo check` in `src-tauri/` with Rust 1.100.0
on PATH): same failure, `The system library 'gdk-3.0' required by crate
'gdk-sys' was not found.` The parent is installing the Tauri system deps
separately; this build does not attempt apt changes.

## Dependencies — permissive licences only (Stanley's standing rule)

- `@tauri-apps/api` ^2.0.0 (MIT), `@tauri-apps/cli` ^2.0.0 (MIT/Apache),
  `typescript` ^5.9.0 (Apache-2.0), `@types/node` ^24 (MIT),
  `@bokuweb/zstd-wasm` ^0.0.27 (MIT, zero dependencies — real Zstd for
  `.json.zst`; the ESM web build is vendored into `dist/vendor/zstd/` by
  `scripts/copy-assets.mjs`, no bundler, no CDN).
  No GPL dependencies.

## Still missing before this shell can be pushed to GitHub

1. **Nothing is blocked by the licence any more** — MIT was decided by
   Stanley 2026-11-20, and `LICENSE` + `package.json` carry it. Repo
   creation is unblocked on that count (still local-only in this task;
   creation happens after the scaffold is verified).
2. **Create the repos** under `PropTheRtRevDrSirStanleyG05`:
   `ArkNetzWebWeaver` (this scaffold) plus the central repos from
   REPO-TOPOLOGY.md — and select them for the Muse GitHub App installation
   (per the GitHub connector doc) before pushing.
3. **Linux AppImage** — the rebuild produced a fresh binary, `.deb`
   and `.rpm` (23:40 UTC, all phases in); the AppImage step stalled
   in `appimagetool` on this VM. Still to produce: a fresh AppImage,
   plus Windows `.exe` and Android `.apk` (need a Windows machine /
   Android SDK).
4. **GitHub OAuth App**: create one, put its client id in
   `src/lib/config.ts` (`GITHUB_OAUTH_CLIENT_ID`), and supply the client
   secret at runtime via `ARKNETZ_GITHUB_OAUTH_CLIENT_SECRET`. Until then
   sign-in correctly refuses with "not configured".
5. **Central repos do not exist yet** — registry shards, protocol-root
   manifest, moderation, contacts. Until they do, only the bundled demo
   site resolves; real domains return "could not load" with that reason.
6. **`arknetz://` deep-link registration** (Tauri deep-link plugin) —
   TODO, not a blocker for a first push. The app icon is in place
   (placeholder RGBA `src-tauri/icons/icon.png`, bundled in the .deb).
   first push.
7. **Zstd**: DONE in v0.3.0 — real Zstd for `.json.zst` (registry/site/
   posts round-trip byte-identical JSON; publish preview and the
   registry reader use it). The ~32 KB pre-trained Zstd dictionary from
   the thread is NOT wired yet — plain frames only; a follow-up, not a
   blocker.
8. **IA account linking UI**: DONE in v0.3.0 — Settings screen links an
   IA account (S3 keys encrypted under a passphrase in IndexedDB),
   shows linked/locked status, test-connection, unlink. After linking
   + unlocking, attachments go through the stealth IA upload.

## File tree

```
ArkNetzWebWeaver/
├── LICENSE                      MIT, Copyright (c) 2026 PropTheRtRevDrSirStanleyG05 / STANBEYOND
├── README.md
├── package.json                 MIT, @tauri-apps/api + cli, typescript, @types/node
├── tsconfig.json
├── .gitignore
├── src/
│   ├── index.html               shell chrome + builder panel (edit/view toggle, editor bar, canvas, sidebar)
│   ├── styles.css               shell + editor styles
│   ├── main.ts                  wires tabs/bookmarks/reader/sign-in/media-attach + Edit mode to the lib
│   └── lib/
│       ├── config.ts            master account, shard counts, OAuth id, raw/IA bases
│       ├── types.ts             RegistryEntry, SiteDocument, BlockNode, AttachedMedia, ThemePreset, TeamRole, Revision
│       ├── cache.ts             IndexedDB ETag cache + CachedFetcher (raw.githubusercontent.com only)
│       ├── registry.ts          SHA256 sharding, manifest fallback, resolve/loadSite, mirror failover
│       ├── renderer.ts          THE shared block renderer (reader + builder) — now gallery, docs-sidebar, visibility, focal/decorative
│       ├── auth.ts              GitHub OAuth authorize/redirect/master check, no fake tokens
│       ├── ia-media.ts          stealth IA upload: queue, backoff, hotlinks, encrypted keys
│       ├── shell.ts             TabManager + BookmarkManager (store-injected)
│       ├── sample.ts            bundled demo site (welcome.arknetz)
│       ├── blocks.ts            block whitelist, slash commands, defaults, validation
│       ├── editor.ts            EditorState: insert/move/delete/duplicate, visibility, pages, publish preview
│       ├── editor-ui.ts         live-canvas DOM wiring: click-to-type, drag reorder, sidebar, preview, autosave
│       ├── themes.ts            4 presets + dark/light CSS variables
│       ├── roles.ts             12 team flags, preset roles, gating with reasons
│       ├── revisions.ts         revision store, id-matched diff, autosave with named failures
│       ├── wxr.ts               WordPress WXR parser + HTML→blocks (scripts → sandboxed app blocks)
│       └── export.ts            static HTML export + real STORE-method ZIP writer (CRC32, no dependency)
├── src-tauri/
│   ├── Cargo.toml               tauri 2, serde, reqwest (rustls) — Rust shell only
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/default.json
│   └── src/main.rs              github_oauth_exchange command (secret from env only)
├── scripts/copy-assets.mjs
└── tests/
    ├── cache.test.ts  registry.test.ts  renderer.test.ts
    ├── ia-media.test.ts  shell.test.ts  auth.test.ts
    ├── editor.test.ts  builder.test.ts
```
