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

  insertBlock(type: BlockType, index?: number, initial?: Partial<BlockNode>): BlockNode {
    const block = { ...defaultBlock(type), ...(initial ?? {}) };
    const at = index === undefined ? this.doc.blocks.length : Math.max(0, Math.min(index, this.doc.blocks.length));
    this.doc.blocks.splice(at, 0, block);
    this.selectedBlockId = block.id ?? null;
    this.dirty = true;
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
    return true;
  }

  moveBlockTo(id: string, index: number): boolean {
    const i = this.doc.blocks.findIndex((b) => b.id === id);
    if (i < 0) return false;
    const [block] = this.doc.blocks.splice(i, 1) as [BlockNode];
    const at = Math.max(0, Math.min(index, this.doc.blocks.length));
    this.doc.blocks.splice(at, 0, block);
    this.dirty = true;
    return true;
  }

  deleteBlock(id: string): boolean {
    const before = this.doc.blocks.length;
    this.doc.blocks = this.doc.blocks.filter((b) => b.id !== id);
    if (this.doc.blocks.length === before) return false;
    if (this.selectedBlockId === id) this.selectedBlockId = null;
    this.dirty = true;
    return true;
  }

  duplicateBlock(id: string): BlockNode | null {
    const i = this.doc.blocks.findIndex((b) => b.id === id);
    if (i < 0) return null;
    const copy: BlockNode = JSON.parse(JSON.stringify(this.doc.blocks[i])) as BlockNode;
    copy.id = newBlockId();
    this.doc.blocks.splice(i + 1, 0, copy);
    this.dirty = true;
    return copy;
  }

  updateBlock(id: string, patch: Partial<BlockNode>): boolean {
    const block = this.doc.blocks.find((b) => b.id === id);
    if (!block) return false;
    Object.assign(block, patch);
    this.dirty = true;
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
    return true;
  }

  clearBlockLink(id: string, start: number, end: number): boolean {
    const block = this.doc.blocks.find((b) => b.id === id);
    if (!block) return false;
    setBlockRuns(block, clearLink(blockRuns(block), start, end));
    this.dirty = true;
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
