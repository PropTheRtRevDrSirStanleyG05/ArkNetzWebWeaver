// ArkNetzWebWeaver — editor state machine (builder phase).
// Pure logic, no DOM: insert / move / delete / update blocks, slash
// commands, per-block visibility, reusable components, global nav /
// pages, and the publish stub. The DOM wiring lives in main.ts; this
// module is what the tests exercise, and what the UI calls.

import { defaultBlock, newBlockId, parseSlashCommand, validateDocument } from "./blocks.js";
import { gateAppEmbed, gatePublish } from "./roles.js";
import type { BlockNode, BlockType, SiteDocument, TeamRole } from "./types.js";
import { applyFormat, clearLink, plainText, runsFromText, setLink } from "./inline.js";
import type { FormatPatch, InlineRun } from "./inline.js";
import { compressJson } from "./zstd.js";
import { publishSite } from "./publish.js";
import type { GithubFetchFn, PublishResult } from "./publish.js";
import { siteRepoName } from "./publish.js";
import { CollabRelay } from "./collab/relay.js";
import { CollabSession } from "./collab/session.js";
import { applyBlockOps, diffBlocks, mergeSnapshot } from "./collab/merge.js";
import type { PlacementKey } from "./collab/merge.js";
import type {
  BlockOp,
  BlockVersion,
  CollabPeer,
  CollabStateFile,
  ConflictNote,
  CursorPosition,
  LocalSnapshot,
} from "./collab/index.js";
import { colourForLogin } from "./collab/index.js";

export interface CollabStartOptions {
  /** The acting user's OWN GitHub OAuth token. Null = refuse. */
  token: string | null;
  /** Fallback repo owner (the signed-in user). Used only when no
   *  site owner is known — see `siteOwner`. */
  owner: string;
  /** GitHub login that OWNS the site repo (from the document's
   *  registry entry, or the claim record that created it). The
   *  relay addresses the owner's repo: a collaborator who is not
   *  the owner joins the owner's repo, never their own. When
   *  absent/blank, `owner` is used (own site / unknown owner). */
  siteOwner?: string | null;
  /** Site repo name; defaults to siteRepoName(doc.domain). */
  repo?: string | null;
  /** GitHub login of the joining user. */
  login: string;
  fetchFn: GithubFetchFn;
  pollMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  /** False = no timers (tests drive pollOnce by hand). */
  autoPoll?: boolean;
}

export interface PageRecord {
  slug: string;
  title: string;
  blocks: BlockNode[];
}

export interface PublishPreview {
  domain: string;
  /** What WOULD be committed: the Zstd-compressed site.json.zst —
   *  the same bytes Publish would send, measured for real. */
  filename: string;
  bytes: number;
  compressedBytes: number;
  json: string;
  /** The Git SHA check that would run against the live repo. */
  shaCheck: string;
}

/** Inline runs of a block, deriving them from `text` when the block
 *  has never been formatted. */
export function blockRuns(block: BlockNode): InlineRun[] {
  if (block.runs && block.runs.length > 0) return block.runs;
  return runsFromText(block.text ?? "");
}

function setBlockRuns(block: BlockNode, runs: InlineRun[]): void {
  const text = plainText(runs);
  block.text = text;
  block.runs = runs.length > 0 && runs.some((r) => r.format !== undefined) ? runs : undefined;
}

export class EditorState {
  doc: SiteDocument;
  /** Extra pages of this domain. The document's nav is the global
   *  navigation: adding a page here adds a nav entry to every page. */
  pages: PageRecord[] = [];
  selectedBlockId: string | null = null;
  /** True once the document differs from the last saved revision. */
  dirty = false;

  // --- Real-time collaboration (see src/lib/collab/README.md) -------
  // The collab session is optional: null until startCollab() joins.
  // Blocks only — header/footer/nav/pages are NOT synced (a peer's
  // nav edit stays local until Publish). Remote edits apply through
  // mergeSnapshot/applyBlockOps; local edits broadcast by diffing
  // against lastBroadcast. While applyingRemote is set, local
  // mutations are not re-broadcast (no echo loop).
  collabSession: CollabSession | null = null;
  /** Conflict notes LWW recorded, newest last — the UI shows these. */
  collabConflicts: ConflictNote[] = [];
  /** Last presence list reported by the session (live + stale). */
  collabPeers: CollabPeer[] = [];
  /** GitHub login that owns the site repo the active collab session
   *  addresses (registry entry / claim record). "" when no session
   *  is active. A collaborator who is not the owner still joins
   *  this owner's repo — never their own. */
  collabSiteOwner = "";
  /** True after a failed poll/write, until a poll succeeds again. */
  collabOffline = false;
  collabError: string | null = null;
  private collabLogin = "";
  private collabNow: () => number = () => Date.now();
  private collabVersions = new Map<string, BlockVersion>();
  private collabPlacement = new Map<string, PlacementKey>();
  private collabDeleted = new Map<string, BlockVersion>();
  private collabLastSynced = new Map<string, number>();
  private collabLastBroadcast = new Map<string, { json: string; updatedAt: number }>();
  private collabOpCounter = { n: 0 };
  private applyingRemote = false;

  constructor(doc: SiteDocument) {
    this.doc = doc;
    this.doc.blocks.forEach((b) => {
      if (!b.id) b.id = newBlockId();
    });
  }

  get blocks(): BlockNode[] {
    return this.doc.blocks;
  }

  select(id: string | null): void {
    this.selectedBlockId = id;
  }

  selected(): BlockNode | undefined {
    return this.doc.blocks.find((b) => b.id === this.selectedBlockId);
  }

  // --- Collaboration ---------------------------------------------------

  /** Join the collab session for this site (one session per site:
   *  the relay branch derives from the domain). The relay addresses
   *  the SITE OWNER's repo (`options.siteOwner`, falling back to
   *  `options.owner` when the document has no owner): a
   *  collaborator who does not own the site still joins the owner's
   *  repo. Throws when the token is missing or the relay is
   *  unreachable — the caller must surface that instead of showing
   *  a fake "collaborating" state. */
  async startCollab(options: CollabStartOptions): Promise<void> {
    if (this.collabSession) throw new Error("collab session already started — stop it first");
    if (!options.token) {
      throw new Error(
        "Collab needs your own GitHub token — sign in with GitHub first. Collab never uses a shared or master token.",
      );
    }
    if (!options.login) throw new Error("collab session needs a GitHub login");
    // The document's owner wins; the signed-in user is only the
    // fallback for a document with no owner (e.g. the demo site).
    // A blank siteOwner is the same as absent — never an empty owner.
    const siteOwner = (options.siteOwner ?? "").trim() || options.owner;
    this.collabSiteOwner = siteOwner;
    this.collabLogin = options.login;
    this.collabNow = options.now ?? (() => Date.now());
    this.collabVersions = new Map();
    this.collabPlacement = new Map();
    this.collabDeleted = new Map();
    this.collabLastSynced = new Map();
    this.collabLastBroadcast = new Map();
    this.collabOpCounter = { n: 0 };
    this.collabConflicts = [];
    this.collabOffline = false;
    this.collabError = null;
    // Pre-session blocks are anchors: version 0, no placement key,
    // so any real edit (local or remote) wins over them and concurrent
    // inserts order deterministically around them.
    for (const block of this.doc.blocks) {
      const id = block.id as string;
      this.collabVersions.set(id, { updatedAt: 0, author: "" });
      this.collabLastBroadcast.set(id, { json: JSON.stringify(block), updatedAt: 0 });
    }
    const relay = new CollabRelay({
      owner: siteOwner,
      repo: options.repo ?? siteRepoName(this.doc.domain),
      domain: this.doc.domain,
      token: options.token,
      fetchFn: options.fetchFn,
    });
    const session = new CollabSession({
      relay,
      login: options.login,
      getLocalSnapshot: () => this.collabSnapshot(),
      onRemoteStates: (states) => this.applyRemoteStates(states),
      onPresence: (peers) => {
        this.collabPeers = peers;
      },
      onError: (err) => {
        this.collabOffline = true;
        this.collabError = err.message;
      },
      pollMs: options.pollMs,
      heartbeatMs: options.heartbeatMs,
      now: this.collabNow,
      autoPoll: options.autoPoll,
    });
    await session.join();
    this.collabSession = session;
    this.collabOffline = false;
    // I am present from the moment I join — seed the peer list with
    // myself now, instead of leaving it empty until the first poll
    // (~5 s) reports me back. The poll refreshes this list (and adds
    // remote peers) from then on.
    this.collabPeers = [
      {
        login: options.login,
        colour: colourForLogin(options.login),
        lastHeartbeat: this.collabNow(),
        cursor: null,
        stale: false,
      },
    ];
  }

  /** Graceful leave: stops timers, deletes my relay state file, and
   *  deletes the collab branch when I was the last peer. My blocks
   *  stay in the document. */
  async stopCollab(): Promise<{ branchDeleted: boolean }> {
    const session = this.collabSession;
    this.collabSession = null;
    this.collabPeers = [];
    this.collabSiteOwner = "";
    if (!session) return { branchDeleted: false };
    return session.leave();
  }

  /** My current snapshot for the relay: full block list + versions +
   *  placement + tombstones. The wire carries snapshots, not an op
   *  log, so a peer that missed ops still converges. */
  collabSnapshot(): LocalSnapshot {
    return {
      blocks: this.doc.blocks.map((b) => JSON.parse(JSON.stringify(b)) as BlockNode),
      versions: new Map(this.collabVersions),
      placement: new Map(this.collabPlacement),
      deleted: new Map(this.collabDeleted),
    };
  }

  /** Share my cursor with the session (propagates on the next write). */
  setLocalCursor(cursor: CursorPosition | null): void {
    this.collabSession?.setCursor(cursor);
  }

  /** Block ids whose last writer is currently stale (>30 s without a
   *  heartbeat). The UI marks these blocks stale; they stay put. */
  staleBlockIds(): Set<string> {
    const session = this.collabSession;
    if (!session) return new Set();
    return session.engine.staleBlockIds(this.collabSnapshot());
  }

  /** Apply remote block ops to the document (LWW per block). Remote
   *  application never re-broadcasts. Returns what changed and any
   *  conflicts recorded (newer version kept, loser noted). */
  applyRemoteBlockOps(ops: BlockOp[]): { changed: boolean; conflicts: ConflictNote[] } {
    if (ops.length === 0) return { changed: false, conflicts: [] };
    this.applyingRemote = true;
    try {
      const result = applyBlockOps(
        {
          blocks: this.doc.blocks,
          versions: this.collabVersions,
          placement: this.collabPlacement,
          deleted: this.collabDeleted,
          lastSynced: this.collabLastSynced,
        },
        ops,
        this.collabNow(),
      );
      this.adoptMergeResult(result, ops);
      return { changed: result.changed, conflicts: result.conflicts };
    } finally {
      this.applyingRemote = false;
    }
  }

  /** Apply peers' state files (the path the poll loop uses). States
   *  are merged in login order so the result is deterministic. */
  applyRemoteStates(states: CollabStateFile[]): { changed: boolean; conflicts: ConflictNote[] } {
    if (states.length === 0) return { changed: false, conflicts: [] };
    this.applyingRemote = true;
    try {
      let changed = false;
      const conflicts: ConflictNote[] = [];
      const sorted = [...states].sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
      for (const state of sorted) {
        const result = mergeSnapshot(
          {
            blocks: this.doc.blocks,
            versions: this.collabVersions,
            placement: this.collabPlacement,
            deleted: this.collabDeleted,
            lastSynced: this.collabLastSynced,
          },
          state,
          this.collabNow(),
        );
        this.adoptMergeResult(result);
        // Blocks both sides now agree on (same content) advance the
        // shared version, so a later edit is not misread as a
        // conflict against a version the other side never saw.
        for (const block of result.blocks) {
          const id = block.id as string;
          const remoteVersion = state.versions[id];
          const localVersion = result.versions.get(id);
          if (!remoteVersion || !localVersion) continue;
          const remoteBlock = state.blocks.find((b) => b.id === id);
          if (remoteBlock && JSON.stringify(remoteBlock) === JSON.stringify(block)) {
            const shared = Math.min(localVersion.updatedAt, remoteVersion.updatedAt);
            const prev = this.collabLastSynced.get(id) ?? 0;
            if (shared > prev) this.collabLastSynced.set(id, shared);
          }
        }
        changed = changed || result.changed;
        conflicts.push(...result.conflicts);
      }
      return { changed, conflicts };
    } finally {
      this.applyingRemote = false;
    }
  }

  private adoptMergeResult(
    result: {
      blocks: BlockNode[];
      versions: Map<string, BlockVersion>;
      placement: Map<string, PlacementKey>;
      deleted: Map<string, BlockVersion>;
      conflicts: ConflictNote[];
      changed: boolean;
    },
    ops?: BlockOp[],
  ): void {
    this.doc.blocks = result.blocks;
    this.collabVersions = result.versions;
    this.collabPlacement = result.placement;
    this.collabDeleted = result.deleted;
    if (ops) {
      for (const op of ops) {
        const v = result.versions.get(op.blockId);
        if (v && v.updatedAt === op.updatedAt) {
          const prev = this.collabLastSynced.get(op.blockId) ?? 0;
          if (op.updatedAt > prev) this.collabLastSynced.set(op.blockId, op.updatedAt);
        }
        if (op.kind === "delete") {
          const tomb = result.deleted.get(op.blockId);
          if (tomb) {
            const prev = this.collabLastSynced.get(op.blockId) ?? 0;
            if (tomb.updatedAt > prev) this.collabLastSynced.set(op.blockId, tomb.updatedAt);
          }
        }
      }
    }
    // Remote blocks are now part of the broadcast baseline: the next
    // local diff must not re-broadcast them as my own ops.
    for (const block of result.blocks) {
      const id = block.id as string;
      const v = result.versions.get(id);
      this.collabLastBroadcast.set(id, {
        json: JSON.stringify(block),
        updatedAt: v?.updatedAt ?? 0,
      });
    }
    for (const id of [...this.collabLastBroadcast.keys()]) {
      if (!result.blocks.some((b) => b.id === id)) this.collabLastBroadcast.delete(id);
    }
    this.collabConflicts.push(...result.conflicts);
    if (result.changed) this.dirty = true;
  }

  /** After a local block mutation: diff against the last broadcast
   *  snapshot, stamp versions, and broadcast the ops (immediate relay
   *  write of the current snapshot). No-op when no session is active
   *  or when the change came from a remote apply. */
  private noteLocalChange(): void {
    const session = this.collabSession;
    if (!session || !session.joined || this.applyingRemote) return;
    const ops = diffBlocks(
      this.collabLastBroadcast,
      this.doc.blocks,
      this.collabLogin,
      this.collabNow(),
      this.collabLastSynced,
      this.collabOpCounter,
    );
    if (ops.length === 0) return;
    for (const op of ops) {
      if (op.kind === "delete") {
        this.collabVersions.delete(op.blockId);
        this.collabPlacement.delete(op.blockId);
        this.collabDeleted.set(op.blockId, { updatedAt: op.updatedAt, author: op.author });
        this.collabLastBroadcast.delete(op.blockId);
      } else if (op.block) {
        this.collabVersions.set(op.blockId, { updatedAt: op.updatedAt, author: op.author });
        this.collabPlacement.set(op.blockId, {
          updatedAt: op.updatedAt,
          author: op.author,
          blockId: op.blockId,
        });
        this.collabLastBroadcast.set(op.blockId, {
          json: JSON.stringify(op.block),
          updatedAt: op.updatedAt,
        });
      }
      // NOTE: lastSynced is deliberately NOT advanced here. It records
      // the version both sides have *shared*, which only advances when
      // a remote state is merged and the contents agree (see
      // applyRemoteStates). Advancing it on a local edit would make a
      // genuine same-block conflict invisible: the remote op's
      // updatedAt would no longer post-date the "synced" version.
    }
    void session.broadcastOps(ops).catch((err: unknown) => {
      this.collabOffline = true;
      this.collabError = err instanceof Error ? err.message : String(err);
    });
  }

  insertBlock(type: BlockType, index?: number, initial?: Partial<BlockNode>): BlockNode {
    const block = { ...defaultBlock(type), ...(initial ?? {}) };
    const at = index === undefined ? this.doc.blocks.length : Math.max(0, Math.min(index, this.doc.blocks.length));
    this.doc.blocks.splice(at, 0, block);
    this.selectedBlockId = block.id ?? null;
    this.dirty = true;
    this.noteLocalChange();
    return block;
  }

  /** Handle a typed line: "/h2 Title" inserts that block; anything else
   *  inserts a paragraph with the text. Returns the inserted block. */
  typeLine(line: string, index?: number): BlockNode {
    const cmd = parseSlashCommand(line);
    if (cmd) {
      return this.insertBlock(cmd.type, index, { text: cmd.text || undefined, title: cmd.text || undefined });
    }
    return this.insertBlock("p", index, { text: line });
  }

  moveBlock(id: string, direction: -1 | 1): boolean {
    const i = this.doc.blocks.findIndex((b) => b.id === id);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= this.doc.blocks.length) return false;
    const [block] = this.doc.blocks.splice(i, 1) as [BlockNode];
    this.doc.blocks.splice(j, 0, block);
    this.dirty = true;
    this.noteLocalChange();
    return true;
  }

  moveBlockTo(id: string, index: number): boolean {
    const i = this.doc.blocks.findIndex((b) => b.id === id);
    if (i < 0) return false;
    const [block] = this.doc.blocks.splice(i, 1) as [BlockNode];
    const at = Math.max(0, Math.min(index, this.doc.blocks.length));
    this.doc.blocks.splice(at, 0, block);
    this.dirty = true;
    this.noteLocalChange();
    return true;
  }

  deleteBlock(id: string): boolean {
    const before = this.doc.blocks.length;
    this.doc.blocks = this.doc.blocks.filter((b) => b.id !== id);
    if (this.doc.blocks.length === before) return false;
    if (this.selectedBlockId === id) this.selectedBlockId = null;
    this.dirty = true;
    this.noteLocalChange();
    return true;
  }

  duplicateBlock(id: string): BlockNode | null {
    const i = this.doc.blocks.findIndex((b) => b.id === id);
    if (i < 0) return null;
    const copy: BlockNode = JSON.parse(JSON.stringify(this.doc.blocks[i])) as BlockNode;
    copy.id = newBlockId();
    this.doc.blocks.splice(i + 1, 0, copy);
    this.dirty = true;
    this.noteLocalChange();
    return copy;
  }

  updateBlock(id: string, patch: Partial<BlockNode>): boolean {
    const block = this.doc.blocks.find((b) => b.id === id);
    if (!block) return false;
    Object.assign(block, patch);
    this.dirty = true;
    this.noteLocalChange();
    return true;
  }

  /** Inline rich-text formatting on a text block: bold/italic/
   *  underline/strikethrough/inline code on the character range
   *  [start, end). Toggle flips a mark when the whole range has it.
   *  The block's `text` stays in sync with the runs. Returns false
   *  when the block does not exist or has no text to format. */
  formatBlock(
    id: string,
    start: number,
    end: number,
    patch: FormatPatch,
    mode: "set" | "toggle" = "set",
  ): boolean {
    const block = this.doc.blocks.find((b) => b.id === id);
    if (!block || !["h1", "h2", "h3", "p", "quote", "link"].includes(block.type)) return false;
    const runs = applyFormat(blockRuns(block), start, end, patch, mode);
    if (plainText(runs) !== (block.text ?? "")) return false;
    setBlockRuns(block, runs);
    this.dirty = true;
    this.noteLocalChange();
    return true;
  }

  /** Link the character range [start, end) of a text block. Unsafe
   *  hrefs are refused (isSafeUrl) and the block is left unchanged. */
  setBlockLink(id: string, start: number, end: number, href: string): boolean {
    const block = this.doc.blocks.find((b) => b.id === id);
    if (!block || !["h1", "h2", "h3", "p", "quote", "link"].includes(block.type)) return false;
    const runs = setLink(blockRuns(block), start, end, href);
    if (plainText(runs) !== (block.text ?? "")) return false;
    setBlockRuns(block, runs);
    this.dirty = true;
    this.noteLocalChange();
    return true;
  }

  clearBlockLink(id: string, start: number, end: number): boolean {
    const block = this.doc.blocks.find((b) => b.id === id);
    if (!block) return false;
    setBlockRuns(block, clearLink(blockRuns(block), start, end));
    this.dirty = true;
    this.noteLocalChange();
    return true;
  }

  /** Per-block responsive visibility: which viewports show this block. */
  setVisibility(id: string, viewports: Array<"desktop" | "tablet" | "mobile">): boolean {
    return this.updateBlock(id, { visibleOn: viewports });
  }

  /** Reusable component: a named block saved into the document's header
   *  (persistent across pages) so every page reuses the same component. */
  addReusableComponent(name: string, block: BlockNode): void {
    const component: BlockNode = { ...block, id: newBlockId(), title: block.title ?? name };
    this.doc.header = [...(this.doc.header ?? []), component];
    this.dirty = true;
  }

  /** Add a page to the domain. The global nav gains an entry, so every
   *  page of the domain shows the new page — that is the point. */
  addPage(slug: string, title: string): PageRecord {
    const page: PageRecord = { slug, title, blocks: [{ type: "h1", text: title, id: newBlockId() }] };
    this.pages.push(page);
    const href = `arknetz://${this.doc.domain}/${slug}`;
    this.doc.nav = [...(this.doc.nav ?? []), { label: title, href }];
    this.dirty = true;
    return page;
  }

  /** Set the global header / footer (persistent across pages). */
  setChrome(header: BlockNode[], footer: BlockNode[]): void {
    this.doc.header = header;
    this.doc.footer = footer;
    this.dirty = true;
  }

  validate(): string[] {
    return validateDocument(this.doc);
  }

  /** Publish dry-run: serialises the document and compresses it to
   *  site.json.zst for real, so the byte counts are the true numbers
   *  Publish would send. Nothing touches the network. A role without
   *  pages.publish is refused here, before any serialisation. App
   *  blocks are refused for roles without apps.embed. */
  async publishPreview(
    role: TeamRole,
  ): Promise<{ ok: true; preview: PublishPreview } | { ok: false; reason: string }> {
    const publishGate = gatePublish(role);
    if (!publishGate.allowed) return { ok: false, reason: publishGate.reason };
    if (this.doc.blocks.some((b) => b.type === "app")) {
      const gate = gateAppEmbed(role);
      if (!gate.allowed) return { ok: false, reason: gate.reason };
    }
    const problems = this.validate();
    if (problems.length > 0) {
      return { ok: false, reason: `Cannot publish — document has ${problems.length} problem(s): ${problems[0]}` };
    }
    const json = JSON.stringify(this.doc, null, 2);
    let compressedBytes: number;
    try {
      compressedBytes = (await compressJson(this.doc)).length;
    } catch (err) {
      return { ok: false, reason: `Cannot publish — Zstd compression failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      ok: true,
      preview: {
        domain: this.doc.domain,
        filename: "site.json.zst",
        bytes: new TextEncoder().encode(json).length,
        compressedBytes,
        json,
        shaCheck: "Publish checks the live repo's site.json.zst SHA before committing (create = no SHA, update = existing SHA)",
      },
    };
  }

  /** Real Publish: commits site.json.zst to the per-domain site repo
   *  via the GitHub Contents API. `token` is the OAuth token (null =
   *  not signed in), `repo` the target repo (null = not created yet) —
   *  both missing cases are reported exactly, never faked. */
  publish(
    role: TeamRole,
    token: string | null,
    owner: string,
    repo: string | null,
    fetchFn: GithubFetchFn,
  ): Promise<PublishResult> {
    return publishSite({ doc: this.doc, role, token, owner, repo, fetchFn });
  }

  toJSON(): string {
    return JSON.stringify(this.doc, null, 2);
  }
}
