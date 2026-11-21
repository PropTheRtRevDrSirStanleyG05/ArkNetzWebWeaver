// ArkNetzWebWeaver — visual builder UI (builder phase).
// Live-canvas Gutenberg-style editor. The preview pane renders through
// the SHARED renderer (renderSiteDocument) — the editor never renders
// pages itself, so what you see while editing is exactly what a reader
// sees. Click-to-type is contenteditable on the canvas; the preview
// refreshes on every change (debounced). State lives in EditorState
// (editor.ts); this module is only DOM wiring.

import {
  addTableColumn,
  addTableRow,
  appendListItem,
  blockLabel,
  BLOCK_TYPES,
  clearListItemLink,
  clearTableCellLink,
  defaultBlock,
  formatListItem,
  formatTableCell,
  getListItem,
  getTableCell,
  indentListItem,
  insertListItem,
  makeTableRows,
  outdentListItem,
  parseSlashCommand,
  parseTableSize,
  removeListItem,
  removeTableColumn,
  removeTableRow,
  setListItemLink,
  setListItemText,
  setTableCellLink,
  setTableCellText,
  slashSuggestions,
  tableSize,
  toggleTableHeader,
} from "./blocks.js";
import { EditorState } from "./editor.js";
import { exportStaticZip } from "./export.js";
import { attachMedia } from "./ia-media.js";
import type { IaFetchFn, IaKeys, IaUploadQueue } from "./ia-media.js";
import { blobToPixels, cropForAspect, prepareImageForUpload } from "./media-edit.js";
import type { MediaEditOpts } from "./media-edit.js";
import { applyPresetToDocument, appThemeCss, DARK_MODE_CLASS, DARK_STYLE_ELEMENT_ID, themeCssVariables, themePreset, THEME_PRESETS } from "./themes.js";
import type { ColorMode } from "./themes.js";
import { autosaveDraft, createMemoryRevisionStore, diffRevisions, loadDraft, makeRevision } from "./revisions.js";
import type { RevisionStore } from "./revisions.js";
import { gateAppEmbed, gateMediaUpload, gatePublish, presetRole } from "./roles.js";
import type { TeamRole } from "./types.js";
import type { BlockNode, ListItem, SiteDocument, TableCell } from "./types.js";
import { renderBlock, renderSiteDocument } from "./renderer.js";
import type { GithubFetchFn } from "./publish.js";
import { importWxr } from "./wxr.js";
import { importHtml, importHtmlFromUrl } from "./html-import.js";
import type { HtmlFetchFn, HtmlImportResult } from "./html-import.js";
import { describePeerCursors } from "./collab/cursors.js";
import { describeConflict } from "./collab/types.js";
import { buildSiteOpenedViewModel } from "./domains-ui.js";
import type { OpenedSite } from "./domains.js";
import { plainText, renderInlineRuns, runsFromText, syncRunsFromText } from "./inline.js";
import type { FormatPatch, InlineRun } from "./inline.js";
import { blockRuns } from "./editor.js";

export interface EditorUiOptions {
  getIaKeys: () => IaKeys | null;
  iaQueue: IaUploadQueue;
  iaFetch: IaFetchFn;
  /** OAuth token from the GitHub sign-in flow. Null = not signed in. */
  getGithubToken: () => string | null;
  /** The signed-in GitHub login (repo owner for Publish). */
  getGithubLogin: () => string | null;
  /** GitHub login that owns the site repo for this domain (the
   *  document's registry entry, or the claim record that created
   *  it). Null/undefined = unknown — the join falls back to the
   *  signed-in user. A collaborator who does not own the site
   *  still joins the owner's repo, never their own. */
  getSiteOwner?: (domain: string) => string | null;
  /** The per-domain site repo, when it exists. Null = not created yet. */
  getSiteRepo: (domain: string) => string | null;
  githubFetch: GithubFetchFn;
  /** Fetch for the HTML importer's URL import (plain fetch, no auth).
   *  Defaults to an adapter over githubFetch. */
  htmlFetch?: HtmlFetchFn;
}

export interface EditorUiOptions {
  getIaKeys: () => IaKeys | null;
  iaQueue: IaUploadQueue;
  iaFetch: IaFetchFn;
}

/** Which repo owner a collab join addresses: the document's owner
 *  (registry entry / claim record) when known, otherwise the
 *  signed-in user. A blank owner is the same as unknown. Exported
 *  for tests — the join button drives it through handleCollabJoin. */
export function resolveCollabSiteOwner(
  siteOwner: string | null | undefined,
  login: string | null,
): string {
  const owner = (siteOwner ?? "").trim();
  if (owner) return owner;
  return (login ?? "").trim();
}

const TEXT_BLOCKS = new Set(["h1", "h2", "h3", "p", "quote", "code"]);

/** The collab strip's idle label. The space is a non-breaking space
 *  (L11): at 390px the strip is narrow and "Not" / "collaborating."
 *  wrapped onto two lines. */
const NOT_COLLABORATING = "Not\u00a0collaborating.";

/** A role may edit the document when it can draft or publish pages.
 *  Viewer has neither flag, so it is read-only; writer can draft. */
export function roleCanEdit(role: TeamRole): boolean {
  return role.flags.includes("pages.draft") || role.flags.includes("pages.publish");
}

/** A role may Publish when it holds pages.publish (owner, editor). */
export function roleCanPublish(role: TeamRole): boolean {
  return role.flags.includes("pages.publish");
}

/** Offsets of the live selection inside a contenteditable element, as
 *  plain-text [start, end). Null when there is no selection, or the
 *  selection is outside the element. */
export function selectionOffsetsIn(
  editable: Node,
  sel: Selection | null,
): { start: number; end: number } | null {
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editable.contains(range.commonAncestorContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(editable);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length };
}

/** The format toolbar's saved selection. Clicking a toolbar button
 *  steals focus — and the selection — from the contenteditable before
 *  the click handler runs, so Bold silently did nothing (B3). The
 *  toolbar captures the selection on mousedown, before focus moves,
 *  and every format action takes the live selection when it exists and
 *  the saved one when it is gone (e.g. after typing a URL in the link
 *  input). A saved selection is single-use: it is cleared once taken,
 *  so a stale range can never format the wrong text. */
export class SavedSelection {
  private saved: { start: number; end: number } | null = null;

  capture(editable: Node, sel: Selection | null): void {
    const r = selectionOffsetsIn(editable, sel);
    if (r && r.start !== r.end) this.saved = r;
  }

  take(editable: Node, sel: Selection | null): { start: number; end: number } | null {
    const live = selectionOffsetsIn(editable, sel);
    if (live && live.start !== live.end) {
      this.saved = null;
      return live;
    }
    const s = this.saved;
    this.saved = null;
    return s;
  }
}

function findBlock(blocks: BlockNode[], id: string): BlockNode | undefined {
  for (const b of blocks) {
    if (b.id === id) return b;
    const inItems = b.items ? findBlock(b.items, id) : undefined;
    if (inItems) return inItems;
    for (const col of b.columns ?? []) {
      const inCol = findBlock(col, id);
      if (inCol) return inCol;
    }
  }
  return undefined;
}

export class EditorUI {
  private editor: EditorState | null = null;
  private role: TeamRole = presetRole("owner") as TeamRole;
  private presetId = "academic";
  private mode: ColorMode = "light";
  private revisions: { id: string; label: string; createdAt: number; document: SiteDocument }[] = [];
  private store: RevisionStore = createMemoryRevisionStore();
  private autosaveTimer: number | undefined;
  private previewTimer: number | undefined;
  private draggedId: string | null = null;
  /** Crop/rotate/flip applied to the next image attachment, before
   *  the stealth IA upload. Defaults: no crop, no rotation, no flip. */
  private mediaEditOpts: MediaEditOpts = {};
  /** Aspect ratio picked in the crop panel; the crop rectangle is
   *  computed against the real image dimensions at attach time. */
  private pendingAspect = "freeform";
  /** The list item / table cell the shared list/table format bar
   *  applies to: set when a cell/item editable gains focus. The block
   *  object stays the same across canvas re-renders (EditorState
   *  mutates it in place), but the editable element does not — after a
   *  rebuild the user clicks back into a cell/item and the target is
   *  set again; a stale editable simply yields "click a cell first". */
  private listTableTarget:
    | { block: BlockNode; kind: "item"; path: number[]; editable: HTMLElement }
    | { block: BlockNode; kind: "cell"; row: number; col: number; editable: HTMLElement }
    | null = null;
  /** Re-render timer for the collab surface while joined (remote
   *  polls arrive without a local edit, so the peer list / cursor
   *  marks / conflict notes refresh on a tick, not on keystrokes). */
  private collabTimer: ReturnType<typeof setInterval> | null = null;
  /** Until this timestamp, a successful autosave does not write the
   *  status line (M4): a failed HTML import sets it, so a pending
   *  autosave from an earlier edit cannot overwrite the failure
   *  with "Autosaved locally…" 800 ms later. The draft still saves
   *  — only the success message is held. Any later setStatus call
   *  (a user action) replaces the message as normal. */
  private statusHoldUntil = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: EditorUiOptions,
  ) {}

  get doc(): SiteDocument | null {
    return this.editor?.doc ?? null;
  }

  /** The underlying EditorState (collab session, peers, conflicts).
   *  The document itself is available as `doc`. */
  get editorState(): EditorState | null {
    return this.editor;
  }

  private $(id: string): HTMLElement {
    const el = this.root.ownerDocument.getElementById(id);
    if (!el) throw new Error(`editor element #${id} is missing`);
    return el;
  }

  open(doc: SiteDocument): void {
    const old = this.editor;
    if (old?.collabSession && old.doc.domain !== doc.domain) {
      // Switching sites ends the old session: its timers and relay
      // state belong to the old domain, and its blocks stay in the
      // old document. Re-opening the SAME domain keeps the session.
      this.stopCollabTimer();
      void old.stopCollab();
    }
    const clone: SiteDocument = JSON.parse(JSON.stringify(doc)) as SiteDocument;
    this.editor = new EditorState(clone);
    this.revisions = [];
    this.root.hidden = false;
    this.wireOnce();
    this.applyColorMode();
    this.renderAll();
    this.setStatus("Editing — autosave is local only. Publish commits site.json.zst to your site repo when you are signed in and the repo exists; otherwise it says exactly what is missing.");
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Open a freshly claimed site: the starter (or kept) document for
   *  the claimed domain, with the pending-claim state in the status
   *  line — the claim is pending until register.yml closes the
   *  REGISTER issue, so the UI never says the domain is registered. */
  showSiteOpened(opened: OpenedSite): void {
    const vm = buildSiteOpenedViewModel(opened);
    this.open(opened.doc);
    this.setStatus(`${vm.heading} — ${vm.message} ${vm.pendingNote} Claim issue: ${vm.issueUrl}`);
  }

  private wired = false;
  private wireOnce(): void {
    if (this.wired) return;
    this.wired = true;
    const inserter = this.$("inserter-select") as HTMLSelectElement;
    for (const t of BLOCK_TYPES) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = blockLabel(t);
      inserter.appendChild(opt);
    }
    (this.$("slash-add-btn") as HTMLButtonElement).onclick = () => this.handleSlash();
    (this.$("slash-input") as HTMLInputElement).addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.handleSlash();
    });
    (this.$("slash-input") as HTMLInputElement).addEventListener("input", (e) => {
      this.renderSlashSuggestions((e.target as HTMLInputElement).value);
    });
    (this.$("inserter-btn") as HTMLButtonElement).onclick = () => {
      const type = inserter.value as BlockNode["type"];
      this.guardApp(type, () => {
        this.editor?.insertBlock(type);
        this.afterChange();
      });
    };
    (this.$("edit-view-btn") as HTMLButtonElement).onclick = () => {
      this.close();
      document.getElementById("reader")!.hidden = false;
      document.dispatchEvent(new CustomEvent("arknetz:editor-closed"));
    };
    (this.$("role-select") as HTMLSelectElement).onchange = (e) => {
      this.role = presetRole((e.target as HTMLSelectElement).value) ?? this.role;
      // Re-rendering the canvas is what actually enforces the role:
      // contenteditable flips off for a viewer and every editing
      // control is disabled (B4). The message alone was not enough.
      this.renderAll();
      this.setStatus(`Role: ${this.role.name}. Publish ${roleCanPublish(this.role) ? "allowed" : "blocked for this role"}${roleCanEdit(this.role) ? "" : " — editing is disabled for this role"}.`);
    };
    (this.$("theme-select") as HTMLSelectElement).onchange = (e) => {
      this.presetId = (e.target as HTMLSelectElement).value;
      const preset = themePreset(this.presetId);
      if (preset && this.editor) {
        applyPresetToDocument(this.editor.doc, preset);
        this.afterChange();
      }
    };
    (this.$("mode-btn") as HTMLButtonElement).onclick = () => {
      this.mode = this.mode === "light" ? "dark" : "light";
      this.applyColorMode();
      this.refreshPreview();
    };
    (this.$("publish-btn") as HTMLButtonElement).onclick = () => this.handlePublish();
    (this.$("revision-btn") as HTMLButtonElement).onclick = () => {
      if (!this.editor) return;
      const rev = makeRevision(this.editor.doc, `Revision ${this.revisions.length + 1}`);
      this.revisions.push(rev);
      this.setStatus(`Saved revision ${this.revisions.length} at ${new Date(rev.createdAt).toLocaleTimeString()}.`);
    };
    (this.$("diff-btn") as HTMLButtonElement).onclick = () => this.renderDiff();
    (this.$("export-btn") as HTMLButtonElement).onclick = () => this.handleExport();
    (this.$("wxr-input") as HTMLInputElement).addEventListener("change", (e) => void this.handleWxr(e));
    (this.$("html-import-input") as HTMLInputElement).addEventListener("change", (e) => void this.handleHtmlImportFile(e));
    (this.$("html-import-url-btn") as HTMLButtonElement).onclick = () => void this.handleHtmlImportUrl();
    this.buildCollabBar();
  }

  /** The collaboration strip in the editor bar: Join / Leave, a
   *  status line and the peer list. Built once, like the rest of the
   *  chrome; renderCollab() owns its contents afterwards. */
  private buildCollabBar(): void {
    const bar = this.$("edit-view-btn").parentNode as HTMLElement | null;
    if (!bar) return;
    const strip = document.createElement("div");
    strip.className = "an-collab-bar";
    strip.id = "collab-bar";
    const joinBtn = document.createElement("button");
    joinBtn.type = "button";
    joinBtn.id = "collab-join-btn";
    joinBtn.textContent = "Join collaboration";
    joinBtn.title = "Edit this site live with others — needs GitHub sign-in";
    joinBtn.onclick = () => void this.handleCollabJoin();
    const leaveBtn = document.createElement("button");
    leaveBtn.type = "button";
    leaveBtn.id = "collab-leave-btn";
    leaveBtn.textContent = "Leave collaboration";
    leaveBtn.disabled = true;
    leaveBtn.onclick = () => void this.handleCollabLeave();
    const status = document.createElement("span");
    status.id = "collab-status";
    status.className = "an-note";
    status.textContent = NOT_COLLABORATING;
    const peers = document.createElement("div");
    peers.id = "collab-peers";
    peers.className = "an-collab-peers";
    strip.append(joinBtn, leaveBtn, status, peers);
    bar.appendChild(strip);
  }

  private guardApp(type: BlockNode["type"], fn: () => void): void {
    if (type === "app") {
      const gate = gateAppEmbed(this.role);
      if (!gate.allowed) {
        this.setStatus(gate.reason);
        return;
      }
    }
    fn();
  }

  private canEdit(): boolean {
    return roleCanEdit(this.role);
  }

  /** Enforce the current role on the editor chrome (B4). A viewer gets
   *  Publish disabled and every editing control disabled — the inserter,
   *  slash input, theme picker, revision save and WXR import — so the
   *  role actually restricts, instead of only saying so in the status
   *  line. Read-only controls stay enabled: mode toggle, export, diff,
   *  back-to-view, and the role select itself (so the user can switch
   *  back). Canvas blocks are enforced separately at render time
   *  (contenteditable=false + disabled controls in renderEditableBlock
   *  / renderSidebar). Runs on every render, so a role change can
   *  never leave stale enabled controls behind. */
  private applyRoleGating(): void {
    const doc = this.root.ownerDocument;
    const canEdit = this.canEdit();
    const setDisabled = (id: string, disabled: boolean): void => {
      const el = doc.getElementById(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | null;
      if (el) el.disabled = disabled;
    };
    setDisabled("publish-btn", !roleCanPublish(this.role));
    setDisabled("inserter-btn", !canEdit);
    setDisabled("inserter-select", !canEdit);
    setDisabled("slash-input", !canEdit);
    setDisabled("slash-add-btn", !canEdit);
    setDisabled("theme-select", !canEdit);
    setDisabled("revision-btn", !canEdit);
    setDisabled("wxr-input", !canEdit);
    setDisabled("html-import-input", !canEdit);
    setDisabled("html-import-url", !canEdit);
    setDisabled("html-import-url-btn", !canEdit);
  }

  /** Apply the colour mode app-wide (B5): toggle the .an-dark root
   *  class and inject/remove the dark stylesheet from themes.ts, which
   *  covers the topbar, sidebar, editor chrome, reader and code blocks
   *  — not just the live preview. The injected <style> lives in
   *  <head>, outside the editor root, so the reader stays dark after
   *  the editor closes. */
  private applyColorMode(): void {
    const doc = this.root.ownerDocument;
    doc.documentElement.classList.toggle(DARK_MODE_CLASS, this.mode === "dark");
    let style = doc.getElementById(DARK_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (this.mode === "dark") {
      if (!style) {
        style = doc.createElement("style") as HTMLStyleElement;
        style.id = DARK_STYLE_ELEMENT_ID;
        doc.head.appendChild(style);
      }
      style.textContent = appThemeCss("dark");
    } else if (style) {
      style.remove();
    }
    (this.$("mode-btn") as HTMLButtonElement).textContent = this.mode === "light" ? "Dark mode" : "Light mode";
  }

  private handleSlash(): void {
    const input = this.$("slash-input") as HTMLInputElement;
    const value = input.value.trim();
    if (!value) return;
    const cmd = parseSlashCommand(value);
    if (cmd && this.editor && (cmd.type === "list" || cmd.type === "table")) {
      // EditorState.typeLine can only pass { type, text } through, so
      // it cannot carry a list style or a table size — list/table slash
      // commands are inserted here instead, with the style/size parsed
      // from the text: "/ol Tasks" is a numbered list whose first item
      // is "Tasks"; "/table 2x4" is a 2×4 table; "/table Sales" is a
      // 3×3 table captioned "Sales".
      if (cmd.type === "list") {
        const keyword = value.slice(1).split(/\s/)[0]?.toLowerCase();
        const block = this.editor.insertBlock("list", undefined, {
          listStyle: keyword === "ol" ? "ol" : "ul",
        });
        if (cmd.text) block.listItems = [{ text: cmd.text }];
      } else {
        const size = parseTableSize(cmd.text);
        const block = this.editor.insertBlock("table");
        if (size) {
          block.rows = makeTableRows(size.rows, size.cols, true);
          block.headerRow = true;
        } else if (cmd.text) {
          block.caption = cmd.text;
        }
      }
      input.value = "";
      this.renderSlashSuggestions("");
      this.afterChange();
      return;
    }
    this.editor?.typeLine(value);
    input.value = "";
    this.renderSlashSuggestions("");
    this.afterChange();
  }

  private renderSlashSuggestions(value: string): void {
    let box = document.getElementById("slash-suggestions");
    if (!box) {
      box = document.createElement("div");
      box.id = "slash-suggestions";
      this.$("slash-input").after(box);
    }
    box.innerHTML = "";
    if (!value.trim().startsWith("/")) return;
    for (const s of slashSuggestions(value.slice(1)).slice(0, 6)) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `/${s.keyword} — ${s.label}`;
      b.onclick = () => {
        (this.$("slash-input") as HTMLInputElement).value = `/${s.keyword} `;
        (this.$("slash-input") as HTMLInputElement).focus();
      };
      box.appendChild(b);
    }
  }

  private async handlePublish(): Promise<void> {
    if (!this.editor) return;
    const gate = gatePublish(this.role);
    if (!gate.allowed) {
      this.setStatus(gate.reason);
      return;
    }
    const doc = this.editor.doc;
    const token = this.opts.getGithubToken();
    const owner = this.opts.getGithubLogin();
    const repo = this.opts.getSiteRepo(doc.domain);
    this.setStatus(`Publishing ${doc.domain}…`);
    const result = await this.editor.publish(this.role, token, owner ?? "", repo, this.opts.githubFetch);
    if (!result.ok) {
      this.setStatus(result.reason);
      return;
    }
    const rev = makeRevision(this.editor.doc, `Published ${new Date().toLocaleTimeString()}`);
    this.revisions.push(rev);
    this.editor.dirty = false;
    this.setStatus(
      `Published ${result.path} to ${result.repo} — commit ${result.commitSha.slice(0, 7)}, ${result.bytes} bytes → ${result.compressedBytes} bytes Zstd.`,
    );
  }

  /** Format toolbar: bold/italic/underline/strikethrough/code/link on
   *  the current selection inside a contenteditable element. The
   *  selection is read from the DOM, applied to the target's typed
   *  runs, and the preview refreshes on every change.
   *
   *  Selection survival (B3): a mousedown on a toolbar button moves
   *  focus out of the contenteditable and collapses the selection
   *  before the click handler runs — Bold used to read an empty
   *  selection and silently do nothing. Two defences: every toolbar
   *  button preventDefaults its mousedown so focus (and the selection)
   *  never leaves the editable, and the toolbar captures the selection
   *  on mousedown into a SavedSelection, so actions that must move
   *  focus — typing a URL in the link input, then clicking Link — still
   *  apply to the text that was selected.
   *
   *  `resolveEditable` supplies the editable the bar applies to: a
   *  fixed element for a text block, the focused cell/item for a list
   *  or table block (null when nothing is focused yet — the bar then
   *  says so instead of formatting the wrong text). `after` runs after
   *  a successful format action: text blocks rebuild the canvas
   *  (afterChange); list/table cells only refresh the preview, so the
   *  focused editable survives (R1). */
  private richTextBar(
    resolveEditable: () => HTMLElement | null,
    applyFormat: (start: number, end: number, patch: FormatPatch, mode: "set" | "toggle") => boolean,
    applyLink: (start: number, end: number, href: string) => boolean,
    clearLink: (start: number, end: number) => void,
    after: () => void,
    noTargetMessage?: string,
  ): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "an-fmt-bar";
    const saved = new SavedSelection();
    const canEdit = this.canEdit();
    // Capture before focus moves: mousedown fires before the default
    // focus change collapses the selection.
    bar.addEventListener("mousedown", () => {
      const editable = resolveEditable();
      if (editable) saved.capture(editable, window.getSelection());
    });
    const sel = (): { start: number; end: number } | null => {
      const editable = resolveEditable();
      if (!editable) return null;
      return saved.take(editable, window.getSelection());
    };
    const keepFocus = (e: MouseEvent): void => e.preventDefault();
    const mkBtn = (text: string, title: string, fn: (r: { start: number; end: number }) => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = title;
      b.disabled = !canEdit;
      b.addEventListener("mousedown", keepFocus);
      b.onclick = (e) => {
        e.stopPropagation();
        if (!resolveEditable()) {
          this.setStatus(noTargetMessage ?? "Select some text first, then apply formatting.");
          return;
        }
        const r = sel();
        if (!r || r.start === r.end) {
          this.setStatus("Select some text first, then apply formatting.");
          return;
        }
        fn(r);
        after();
      };
      bar.appendChild(b);
    };
    mkBtn("B", "Bold", (r) => applyFormat(r.start, r.end, { bold: true }, "toggle"));
    mkBtn("I", "Italic", (r) => applyFormat(r.start, r.end, { italic: true }, "toggle"));
    mkBtn("U", "Underline", (r) => applyFormat(r.start, r.end, { underline: true }, "toggle"));
    mkBtn("S", "Strikethrough", (r) => applyFormat(r.start, r.end, { strike: true }, "toggle"));
    mkBtn("<>", "Inline code", (r) => applyFormat(r.start, r.end, { code: true }, "toggle"));
    const linkInput = document.createElement("input");
    linkInput.className = "an-ed-field";
    linkInput.type = "text";
    linkInput.placeholder = "https://… or arknetz://…";
    linkInput.setAttribute("aria-label", "Link target");
    linkInput.disabled = !canEdit;
    bar.appendChild(linkInput);
    const linkBtn = document.createElement("button");
    linkBtn.type = "button";
    linkBtn.textContent = "Link";
    linkBtn.title = "Link the selected text";
    linkBtn.disabled = !canEdit;
    linkBtn.addEventListener("mousedown", keepFocus);
    linkBtn.onclick = (e) => {
      e.stopPropagation();
      if (!resolveEditable()) {
        this.setStatus(noTargetMessage ?? "Select some text first, then set a link.");
        return;
      }
      const r = sel();
      const href = linkInput.value.trim();
      if (!r || r.start === r.end) {
        this.setStatus("Select some text first, then set a link.");
        return;
      }
      if (!href) {
        this.setStatus("Type a link target first (https://… or arknetz://…).");
        return;
      }
      if (!applyLink(r.start, r.end, href)) {
        this.setStatus(`Refused unsafe link target: ${href}. Links must be https: to archive.org / raw.githubusercontent.com, or arknetz://.`);
        return;
      }
      after();
    };
    bar.appendChild(linkBtn);
    const unlinkBtn = document.createElement("button");
    unlinkBtn.type = "button";
    unlinkBtn.textContent = "Unlink";
    unlinkBtn.title = "Remove the link from the selected text";
    unlinkBtn.disabled = !canEdit;
    unlinkBtn.addEventListener("mousedown", keepFocus);
    unlinkBtn.onclick = (e) => {
      e.stopPropagation();
      if (!resolveEditable()) {
        this.setStatus(noTargetMessage ?? "Select the linked text first, then Unlink.");
        return;
      }
      const r = sel();
      if (!r || r.start === r.end) {
        this.setStatus("Select the linked text first, then Unlink.");
        return;
      }
      clearLink(r.start, r.end);
      after();
    };
    bar.appendChild(unlinkBtn);
    return bar;
  }

  /** The format bar for one text block: formatting goes through
   *  EditorState, and the canvas rebuilds after each action. */
  private formatToolbar(block: BlockNode, editable: HTMLElement): HTMLElement {
    return this.richTextBar(
      () => editable,
      (s, e, patch, mode) => this.editor?.formatBlock(block.id ?? "", s, e, patch, mode) ?? false,
      (s, e, href) => this.editor?.setBlockLink(block.id ?? "", s, e, href) ?? false,
      (s, e) => {
        this.editor?.clearBlockLink(block.id ?? "", s, e);
      },
      () => this.afterChange(),
    );
  }

  /** The format bar for one list/table block: one bar for the whole
   *  block, applying to the focused item/cell (see listTableTarget).
   *  Formatting goes through the list/table helpers in blocks.ts —
   *  EditorState.formatBlock only knows text blocks — and the canvas
   *  is NOT rebuilt, so the focused editable survives the action. */
  private listTableFormatBar(block: BlockNode): HTMLElement {
    const target = (): typeof this.listTableTarget =>
      this.listTableTarget?.block === block ? this.listTableTarget : null;
    return this.richTextBar(
      () => target()?.editable ?? null,
      (s, e, patch, mode) => {
        const t = target();
        if (!t) return false;
        const ok =
          t.kind === "item"
            ? formatListItem(block, t.path, s, e, patch, mode)
            : formatTableCell(block, t.row, t.col, s, e, patch, mode);
        if (ok && this.editor) this.editor.dirty = true;
        return ok;
      },
      (s, e, href) => {
        const t = target();
        if (!t) return false;
        const ok =
          t.kind === "item"
            ? setListItemLink(block, t.path, s, e, href)
            : setTableCellLink(block, t.row, t.col, s, e, href);
        if (ok && this.editor) this.editor.dirty = true;
        return ok;
      },
      (s, e) => {
        const t = target();
        if (!t) return;
        if (t.kind === "item") clearListItemLink(block, t.path, s, e);
        else clearTableCellLink(block, t.row, t.col, s, e);
        if (this.editor) this.editor.dirty = true;
      },
      () => {
        // M2: the canvas shows the new formatting in place — the
        // shared bar deliberately does NOT rebuild the canvas (that
        // would destroy the focused editable and its selection), so
        // the targeted editable is re-rendered from its runs here.
        const t = target();
        if (t) {
          if (t.kind === "item") {
            const item = getListItem(block, t.path);
            if (item) this.setEditableContent(t.editable, item.runs && item.runs.length > 0 ? item.runs : runsFromText(item.text ?? ""));
          } else {
            const cell = getTableCell(block, t.row, t.col);
            if (cell) this.setEditableContent(t.editable, cell.runs && cell.runs.length > 0 ? cell.runs : runsFromText(cell.text ?? ""));
          }
        }
        this.refreshPreview();
        this.scheduleAutosave();
      },
      "Click a list item or table cell first, then select text to format.",
    );
  }

  /** A small button for a block toolbar row (list/table structure
   *  controls). The click never selects the block itself. */
  private barButton(bar: HTMLElement, text: string, title: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    bar.appendChild(b);
    return b;
  }

  private handleExport(): void {
    if (!this.editor) return;
    const zip = exportStaticZip(this.editor.doc);
    const blob = new Blob([zip.bytes as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = zip.filename;
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus(`Exported ${zip.filename} — ${zip.files.join(", ")} (${zip.bytes.length} bytes). Drop it on Cloudflare Pages, Neocities, Netlify, or any static host.`);
  }

  private async handleWxr(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.editor) return;
    const text = await file.text();
    const { doc, imported, skipped } = importWxr(text, this.editor.doc.domain);
    this.editor = new EditorState(doc);
    this.afterChange();
    this.setStatus(`WordPress import: ${imported} post(s)/page(s) imported, ${skipped} attachment(s)/draft(s) skipped. Scripts were wrapped into sandboxed app blocks, not executed.`);
    input.value = "";
  }

  /** Fetch for the HTML importer's URL import: the injected
   *  htmlFetch when the shell provided one, else an adapter over the
   *  GitHub fetch (same shape — ok + status + text — no auth
   *  attached). The `ok` flag is derived from the status: without
   *  it a 404 body would be parsed as a page instead of reported
   *  as the HTTP failure it is (M4). */
  private htmlFetch(): HtmlFetchFn {
    if (this.opts.htmlFetch) return this.opts.htmlFetch;
    return async (url: string) => {
      const res = await this.opts.githubFetch(url, { method: "GET", headers: {} });
      return { ok: res.status >= 200 && res.status < 300, status: res.status, text: () => res.text() };
    };
  }

  /** Import an .html file into the current document. The importer
   *  never throws on malformed input (it degrades to an empty
   *  document with a note) — and a read failure is reported in the
   *  status line, never thrown either. */
  private async handleHtmlImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !this.editor) return;
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      this.setStatus(`HTML import failed — could not read “${file.name}”: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const result = importHtml(text, { domain: this.editor.doc.domain });
    this.applyHtmlImport(result);
    input.value = "";
  }

  /** Import a page from a URL into the current document. A fetch
   *  failure returns an empty document with a plain-language note
   *  (importHtmlFromUrl never throws) — the status line says so. */
  private async handleHtmlImportUrl(): Promise<void> {
    const url = (this.$("html-import-url") as HTMLInputElement).value.trim();
    if (!url) {
      this.setStatus("Type a page URL first, then Import URL.");
      return;
    }
    if (!this.editor) return;
    this.setStatus(`Fetching ${url}…`);
    const result = await importHtmlFromUrl(url, {
      domain: this.editor.doc.domain,
      fetchFn: this.htmlFetch(),
    });
    this.applyHtmlImport(result);
  }

  /** Append an import result to the current document. Blocks go in
   *  through insertBlock (not a direct splice) so a live collab
   *  session broadcasts them to peers like any other local edit. An
   *  empty document also adopts the imported title and nav; a
   *  document with content keeps its own. Counts are shown plainly,
   *  with the importer's notes when it dropped anything.
   *
   *  M4: a FETCH failure (importHtmlFromUrl could not fetch the page
   *  at all — 404, network down, no fetch function) imports nothing
   *  and says so in the status line, including the HTTP status when
   *  known — and it returns BEFORE afterChange(), so the autosave
   *  that afterChange schedules cannot overwrite the failure with
   *  "Autosaved locally…" 800 ms later (that overwrite is why a 404
   *  used to fail silently). The empty fallback document is never
   *  adopted: a failed fetch must not rename the document. */
  private applyHtmlImport(result: HtmlImportResult): void {
    if (!this.editor) return;
    const fetchFailure = result.notes.find(
      (n) => (n.startsWith("Fetching ") && n.includes("failed")) || n.startsWith("No fetch function was provided"),
    );
    if (result.imported === 0 && fetchFailure) {
      // Hold the status line: a pending autosave from an earlier
      // edit must not overwrite this failure with "Autosaved
      // locally…" when its timer fires.
      this.statusHoldUntil = Date.now() + 10_000;
      this.setStatus(`HTML import failed — ${fetchFailure}`);
      return;
    }
    if (this.editor.blocks.length === 0) {
      if (result.doc.title) this.editor.doc.title = result.doc.title;
      if ((this.editor.doc.nav ?? []).length === 0 && (result.doc.nav ?? []).length > 0) {
        this.editor.doc.nav = result.doc.nav;
      }
    }
    for (const block of result.doc.blocks) {
      this.editor.insertBlock(block.type, this.editor.blocks.length, { ...block });
    }
    this.afterChange();
    const notes = result.notes.length > 0 ? ` ${result.notes.join(" ")}` : "";
    this.setStatus(`HTML import: ${result.imported} block(s) imported, ${result.skipped} skipped.${notes}`);
  }

  // --- Real-time collaboration UI -------------------------------------

  /** Join the collab session for this site. The engine refuses
   *  loudly without a token (or when the relay is unreachable) —
   *  that message is surfaced in the status line, never swallowed
   *  and never replaced with a fake "collaborating" state. The
   *  relay addresses the DOCUMENT's owner (registry entry / claim
   *  record), falling back to the signed-in user only when the
   *  document has no owner — a collaborator who does not own the
   *  site still joins the owner's repo. */
  private async handleCollabJoin(): Promise<void> {
    if (!this.editor) return;
    const token = this.opts.getGithubToken();
    const login = this.opts.getGithubLogin();
    const siteOwner = resolveCollabSiteOwner(
      this.opts.getSiteOwner?.(this.editor.doc.domain),
      login,
    );
    try {
      await this.editor.startCollab({
        token,
        owner: login ?? "",
        siteOwner,
        login: login ?? "",
        fetchFn: this.opts.githubFetch,
        autoPoll: true,
      });
    } catch (err) {
      // The engine refuses loudly without a token (or when the relay
      // is unreachable) — surface that message in the editor status
      // line, never swallow it and never show a fake "collaborating"
      // state. L7: the message lives ONLY here — the collab strip
      // stays "Not collaborating." instead of repeating it, so a
      // refused join no longer shows the same error twice.
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus(message);
      return;
    }
    this.startCollabTimer();
    this.renderCollab();
  }

  /** Leave the collab session: timers stop, my relay state file is
   *  deleted, and the branch goes away when I was the last peer. My
   *  blocks stay in the document either way. */
  private async handleCollabLeave(): Promise<void> {
    if (!this.editor?.collabSession) {
      this.setStatus("Not collaborating — nothing to leave.");
      return;
    }
    this.stopCollabTimer();
    try {
      const result = await this.editor.stopCollab();
      this.renderCollab();
      this.setStatus(
        result.branchDeleted
          ? "Left collaboration — you were the last peer, so the collab branch was deleted. Your blocks stay in the document."
          : "Left collaboration. Your blocks stay in the document.",
      );
    } catch (err) {
      this.renderCollab();
      this.setStatus(`Leave failed: ${err instanceof Error ? err.message : String(err)} — the session may still be active; try leaving again.`);
    }
  }

  private startCollabTimer(): void {
    this.stopCollabTimer();
    const w = window as unknown as {
      setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    };
    if (typeof w.setInterval === "function") {
      this.collabTimer = w.setInterval(() => this.renderCollab(), 2000);
    }
  }

  private stopCollabTimer(): void {
    if (this.collabTimer !== null) {
      const w = window as unknown as { clearInterval?: (id: ReturnType<typeof setInterval>) => void };
      w.clearInterval?.(this.collabTimer);
      this.collabTimer = null;
    }
  }

  /** Public refresh for the collab surface (tests drive it by hand;
   *  the app uses the timer + afterChange). */
  refreshCollab(): void {
    this.renderCollab();
  }

  /** Set the editor status line from outside the editor (the claim
   *  watcher reports the REGISTER issue closing here — the screen
   *  the user is looking at after a claim). */
  setStatusLine(text: string): void {
    this.setStatus(text);
  }

  /** The canvas block wrap for a block id, or null (nested column
   *  children included — the walk covers the whole canvas tree). */
  private findBlockWrap(blockId: string): HTMLElement | null {
    const canvas = this.$("editor-canvas");
    let found: HTMLElement | null = null;
    const walk = (el: Element): void => {
      if (found) return;
      const h = el as HTMLElement;
      if (h.classList?.contains("an-ed-block") && h.dataset?.id === blockId) {
        found = h;
        return;
      }
      for (const child of el.children) walk(child);
    };
    walk(canvas);
    return found;
  }

  /** Re-render the collaboration surface from the EditorState: peer
   *  list, peer cursor marks on the canvas, conflict notes on the
   *  losing block, stale flags. Safe to call when not joined (it
   *  clears everything). Called after every render and on a timer
   *  while joined, because remote polls arrive without a local edit. */
  private renderCollab(): void {
    const doc = this.root.ownerDocument;
    const state = this.editor;
    const joined = !!state?.collabSession;
    const selfLogin = this.opts.getGithubLogin() ?? "";
    const joinBtn = doc.getElementById("collab-join-btn") as HTMLButtonElement | null;
    const leaveBtn = doc.getElementById("collab-leave-btn") as HTMLButtonElement | null;
    const status = doc.getElementById("collab-status");
    const peersEl = doc.getElementById("collab-peers");
    if (joinBtn) joinBtn.disabled = joined || !this.canEdit();
    if (leaveBtn) leaveBtn.disabled = !joined;
    if (peersEl) peersEl.innerHTML = "";
    // Clear the old canvas marks first: the canvas is rebuilt on
    // every edit, and a re-render must never stack duplicate marks.
    const canvas = doc.getElementById("editor-canvas");
    if (canvas) {
      const stale: Element[] = [];
      const walk = (el: Element): void => {
        const h = el as HTMLElement;
        if (
          h.classList?.contains("an-collab-cursor") ||
          h.classList?.contains("an-collab-conflict") ||
          h.classList?.contains("an-collab-stale")
        ) {
          stale.push(el);
        }
        for (const child of el.children) walk(child);
      };
      walk(canvas);
      for (const el of stale) (el as HTMLElement).remove();
    }
    if (!state) {
      if (status) status.textContent = NOT_COLLABORATING;
      return;
    }
    if (!joined) {
      // L7: a collab error is surfaced once, in the editor status
      // line (handleCollabJoin's catch) — the strip stays idle here
      // instead of repeating "Collaboration error: …" beside it.
      if (status) status.textContent = NOT_COLLABORATING;
      return;
    }
    const peers = state.collabPeers;
    const others = peers.filter((p) => p.login !== selfLogin);
    if (status) {
      status.textContent = state.collabOffline
        ? `Collaborating as ${selfLogin} — offline, retrying. ${others.length} other peer${others.length === 1 ? "" : "s"} here.`
        : `Collaborating as ${selfLogin} on ${state.doc.domain} — ${others.length} other peer${others.length === 1 ? "" : "s"} here. Edits sync about every 5 seconds.`;
    }
    if (peersEl) {
      for (const peer of peers) {
        const row = document.createElement("div");
        row.className = "an-collab-peer";
        row.textContent = `${peer.login}${peer.login === selfLogin ? " (you)" : ""}${peer.stale ? " (away)" : ""}`;
        (row as HTMLElement).style.color = peer.colour;
        peersEl.appendChild(row);
      }
    }
    if (!canvas) return;
    for (const mark of describePeerCursors(peers, selfLogin)) {
      if (!mark.blockId) continue;
      const wrap = this.findBlockWrap(mark.blockId);
      if (!wrap) continue;
      const el = document.createElement("div");
      el.className = "an-collab-cursor";
      el.textContent = mark.label + (mark.stale ? " (away)" : "");
      el.style.color = mark.colour;
      el.style.borderColor = mark.colour;
      if (mark.stale) el.dataset.stale = "true";
      wrap.appendChild(el);
    }
    for (const note of state.collabConflicts) {
      const wrap = this.findBlockWrap(note.blockId);
      if (!wrap) continue;
      const el = document.createElement("div");
      el.className = "an-collab-conflict";
      el.textContent = describeConflict(note);
      wrap.appendChild(el);
    }
    for (const blockId of state.staleBlockIds()) {
      const wrap = this.findBlockWrap(blockId);
      if (!wrap) continue;
      const el = document.createElement("div");
      el.className = "an-collab-stale";
      el.textContent = "The last writer of this block is away (no heartbeat for 30 s) — the block stays as it is.";
      wrap.appendChild(el);
    }
  }

  /** Share my caret with the collab session (focus only — a write
   *  per keystroke would spam the relay, and typing already
   *  broadcasts through the session's own diff). No-op when not
   *  joined. */
  private shareCursor(block: BlockNode, editable: HTMLElement): void {
    if (!this.editor?.collabSession) return;
    const sel = selectionOffsetsIn(editable, window.getSelection());
    this.editor.setLocalCursor(
      sel
        ? { blockId: block.id ?? null, start: sel.start, end: sel.end }
        : { blockId: block.id ?? null, start: 0, end: 0 },
    );
  }

  private renderDiff(): void {
    const out = this.$("diff-output");
    out.innerHTML = "";
    if (this.revisions.length < 2) {
      out.textContent = "Need at least two revisions to compare — press “Save revision”, edit, then save another.";
      return;
    }
    const a = this.revisions[this.revisions.length - 2]!;
    const b = this.revisions[this.revisions.length - 1]!;
    const lines = diffRevisions(a, b);
    const ul = document.createElement("ul");
    for (const line of lines) {
      const li = document.createElement("li");
      if (line.kind === "same") {
        li.className = "an-diff-same";
        li.textContent = `  ${line.block}`;
      } else if (line.kind === "added") {
        li.className = "an-diff-added";
        li.textContent = `+ ${line.block}`;
      } else if (line.kind === "removed") {
        li.className = "an-diff-removed";
        li.textContent = `− ${line.block}`;
      } else {
        li.className = "an-diff-changed";
        li.textContent = `~ ${line.before} → ${line.after}`;
      }
      ul.appendChild(li);
    }
    out.appendChild(ul);
  }

  private setStatus(text: string): void {
    this.$("editor-status").textContent = text;
  }

  /** After any edit: re-render canvas + sidebar, refresh the preview
   *  (debounced), and schedule an autosave. */
  private afterChange(): void {
    this.renderCanvas();
    this.renderSidebar();
    this.refreshPreview();
    this.scheduleAutosave();
    this.renderCollab();
  }

  private refreshPreview(): void {
    window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      if (!this.editor) return;
      const preset = themePreset(this.presetId);
      const preview = this.$("editor-preview");
      preview.innerHTML = renderSiteDocument(this.editor.doc);
      if (preset) preview.setAttribute("style", themeCssVariables(preset, this.mode));
    }, 150);
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => void this.autosaveNow(0), 800);
  }

  private async autosaveNow(attempt: number): Promise<void> {
    if (!this.editor) return;
    const result = await autosaveDraft(this.store, `draft:${this.editor.doc.domain}`, this.editor.doc, attempt);
    if (result.ok) {
      // M4: a held status line (e.g. a failed HTML import) is never
      // overwritten by the routine autosave message — the draft
      // still saved, the failure stays readable.
      if (Date.now() < this.statusHoldUntil) return;
      this.setStatus(`Autosaved locally at ${new Date(result.savedAt).toLocaleTimeString()} — drafts stay on this device until Publish.`);
    } else {
      this.setStatus(`${result.error} Retrying in ${Math.round(result.retryInMs / 1000)}s — your edits are still in the canvas, nothing was lost.`);
      window.setTimeout(() => void this.autosaveNow(attempt + 1), result.retryInMs);
    }
  }

  async restoreDraft(): Promise<boolean> {
    if (!this.editor) return false;
    const draft = await loadDraft(this.store, `draft:${this.editor.doc.domain}`);
    if (!draft) return false;
    this.editor = new EditorState(draft);
    this.renderAll();
    return true;
  }

  private renderAll(): void {
    this.renderCanvas();
    this.renderSidebar();
    this.refreshPreview();
    this.applyRoleGating();
    this.renderCollab();
  }

  private renderCanvas(): void {
    const canvas = this.$("editor-canvas");
    canvas.innerHTML = "";
    if (!this.editor) return;
    for (const block of this.editor.blocks) {
      canvas.appendChild(this.renderEditableBlock(block));
    }
    if (this.editor.blocks.length === 0) {
      const p = document.createElement("p");
      p.className = "an-note";
      p.textContent = "No blocks yet — type / in the box below to insert one.";
      canvas.appendChild(p);
    }
  }

  /** Update the selected-block highlight in place, without rebuilding
   *  the canvas (R1): re-rendering destroys the focused contenteditable
   *  and any live selection inside it. Walks the tree instead of
   *  querySelectorAll so nested column children are covered too. */
  private updateBlockSelection(): void {
    const selected = this.editor?.selectedBlockId ?? null;
    const walk = (el: Element): void => {
      if (el.classList.contains("an-ed-block")) {
        (el as HTMLElement).dataset.selected = String((el as HTMLElement).dataset.id === selected);
      }
      for (const child of el.children) walk(child);
    };
    walk(this.$("editor-canvas"));
  }

  private renderEditableBlock(block: BlockNode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "an-ed-block";
    wrap.draggable = this.canEdit();
    wrap.dataset.id = block.id ?? "";
    wrap.dataset.selected = String(this.editor?.selectedBlockId === block.id);
    wrap.addEventListener("click", () => {
      this.editor?.select(block.id ?? null);
      // R1: never rebuild the canvas on a click. renderCanvas() does
      // canvas.innerHTML = "" and rebuilds every block, destroying the
      // contenteditable the click just focused — mouse users could never
      // type or select text, because no mouse action could ever create
      // a selection. Update the selection highlight in place instead;
      // the sidebar re-render is safe (focus lives in the canvas, not
      // the sidebar).
      this.updateBlockSelection();
      this.renderSidebar();
    });
    wrap.addEventListener("dragstart", (e) => {
      this.draggedId = block.id ?? null;
      e.dataTransfer?.setData("text/plain", block.id ?? "");
    });
    wrap.addEventListener("dragover", (e) => e.preventDefault());
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      const dragged = this.draggedId;
      if (!dragged || !this.editor) return;
      const index = this.editor.blocks.findIndex((b) => b.id === block.id);
      if (this.editor.moveBlockTo(dragged, index)) this.afterChange();
      this.draggedId = null;
    });

    const bar = document.createElement("div");
    bar.className = "an-ed-bar";
    const label = document.createElement("span");
    label.className = "an-ed-label";
    label.textContent = blockLabel(block.type);
    bar.appendChild(label);
    const mkBtn = (text: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = title;
      b.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
      bar.appendChild(b);
    };
    mkBtn("↑", "Move up", () => {
      if (this.editor?.moveBlock(block.id ?? "", -1)) this.afterChange();
    });
    mkBtn("↓", "Move down", () => {
      if (this.editor?.moveBlock(block.id ?? "", 1)) this.afterChange();
    });
    mkBtn("⧉", "Duplicate", () => {
      if (this.editor?.duplicateBlock(block.id ?? "")) this.afterChange();
    });
    mkBtn("✕", "Delete", () => {
      if (this.editor?.deleteBlock(block.id ?? "")) this.afterChange();
    });
    wrap.appendChild(bar);

    wrap.appendChild(this.renderBlockBody(block));
    // Role enforcement (B4): a viewer gets every control inside the
    // block disabled, so the block cannot be edited, moved, duplicated
    // or deleted from the canvas. Re-applied on every render.
    if (!this.canEdit()) {
      for (const el of wrap.querySelectorAll("button,input,select,textarea")) {
        (el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = true;
      }
    }
    return wrap;
  }

  /** Render typed inline runs into a contenteditable (M2, fix pass
   *  2): the canvas shows bold/italic/underline/strikethrough/code/
   *  links while editing, exactly as the preview and reader render
   *  them — the canvas used to set plain textContent, so formatting
   *  was invisible until the preview below. Unformatted text takes
   *  the plain-text path, so typing and selection offsets (which read
   *  textContent) are unchanged. Safe by construction: the runs are
   *  typed, never raw HTML, and renderInlineRuns escapes the text. */
  private setEditableContent(el: HTMLElement, runs: InlineRun[]): void {
    if (runs.some((r) => r.format !== undefined)) {
      el.innerHTML = renderInlineRuns(runs);
    } else {
      el.textContent = plainText(runs);
    }
  }

  /** The editable body of one block. Text blocks are contenteditable;
   *  media blocks show the shared renderer's output plus controls;
   *  container blocks render their children editable too. */
  private renderBlockBody(block: BlockNode): HTMLElement {
    const body = document.createElement("div");
    if (TEXT_BLOCKS.has(block.type)) {
      const tag = block.type === "code" ? "pre" : block.type;
      const el = document.createElement(tag);
      el.className = "an-ed-text";
      // Viewers read: contenteditable is off for roles that cannot edit (B4).
      el.contentEditable = this.canEdit() ? "true" : "false";
      // M2: render the block's runs, not plain text, so inline
      // formatting is visible in the canvas while editing.
      this.setEditableContent(el, blockRuns(block));
      el.addEventListener("focus", () => this.shareCursor(block, el));
      el.addEventListener("input", () => {
        this.updateBlockText(block, el.textContent ?? "");
      });
      body.appendChild(this.formatToolbar(block, el));
      body.appendChild(el);
      return body;
    }
    switch (block.type) {
      case "hero": {
        const title = document.createElement("h1");
        title.className = "an-ed-text";
        title.contentEditable = this.canEdit() ? "true" : "false";
        title.textContent = block.title ?? "";
        title.addEventListener("input", () => this.patchBlock(block, { title: title.textContent ?? "" }));
        const sub = document.createElement("p");
        sub.className = "an-ed-text";
        sub.contentEditable = this.canEdit() ? "true" : "false";
        sub.textContent = block.subtitle ?? "";
        sub.addEventListener("input", () => this.patchBlock(block, { subtitle: sub.textContent ?? "" }));
        body.append(title, sub);
        return body;
      }
      case "link": {
        const text = document.createElement("p");
        text.className = "an-ed-text";
        text.contentEditable = this.canEdit() ? "true" : "false";
        text.textContent = block.text ?? "";
        text.addEventListener("input", () => this.patchBlock(block, { text: text.textContent ?? "" }));
        const href = this.fieldInput("Link target", block.href ?? "", (v) => this.patchBlock(block, { href: v }));
        body.append(text, href);
        return body;
      }
      case "img":
      case "video":
      case "audio": {
        const preview = document.createElement("div");
        preview.innerHTML = renderBlock(block);
        body.appendChild(preview);
        const src = this.fieldInput("Source (IA hotlink)", block.src ?? "", (v) => this.patchBlock(block, { src: v }));
        body.appendChild(src);
        if (block.type === "img") {
          const alt = this.fieldInput("Alt text", block.alt ?? "", (v) => this.patchBlock(block, { alt: v }));
          body.appendChild(alt);
          const dec = document.createElement("label");
          const decBox = document.createElement("input");
          decBox.type = "checkbox";
          decBox.checked = !!block.decorative;
          decBox.onchange = () => this.patchBlock(block, { decorative: decBox.checked });
          dec.append(decBox, document.createTextNode(" Mark as decorative (alt is empty, screen readers skip it)"));
          body.appendChild(dec);
          // Crop / rotate / flip: applied to the NEXT image attached to
          // this block, before the stealth IA upload (crop -> rotate ->
          // flip -> downscale to max 1600px, WebP 80%). The panel shows
          // the pending edit; attaching applies it.
          const cropBox = document.createElement("div");
          cropBox.className = "an-crop-panel";
          const cropLabel = document.createElement("span");
          cropLabel.textContent = "Crop next attachment: ";
          cropBox.appendChild(cropLabel);
          const aspect = document.createElement("select");
          aspect.setAttribute("aria-label", "Crop aspect ratio");
          for (const a of ["freeform", "1:1", "4:3", "3:4", "16:9", "9:16"]) {
            const opt = document.createElement("option");
            opt.value = a;
            opt.textContent = a === "freeform" ? "No crop" : a;
            aspect.appendChild(opt);
          }
          aspect.onchange = () => {
            this.pendingAspect = aspect.value;
            this.setStatus(`Crop for the next attachment: ${aspect.value === "freeform" ? "no crop" : aspect.value}. Attach an image to apply it.`);
          };
          cropBox.appendChild(aspect);
          const rotBtn = document.createElement("button");
          rotBtn.type = "button";
          rotBtn.textContent = "⟳ Rotate 90°";
          rotBtn.onclick = () => {
            const order = [0, 90, 180, 270] as const;
            const cur = this.mediaEditOpts.rotate ?? 0;
            const next = order[(order.indexOf(cur as 0) + 1) % order.length] as 0 | 90 | 180 | 270;
            this.mediaEditOpts = { ...this.mediaEditOpts, rotate: next };
            this.setStatus(`Rotate for the next attachment: ${next}°. Attach an image to apply it.`);
          };
          cropBox.appendChild(rotBtn);
          const flipHBtn = document.createElement("button");
          flipHBtn.type = "button";
          flipHBtn.textContent = "⇄ Flip H";
          flipHBtn.onclick = () => {
            this.mediaEditOpts = { ...this.mediaEditOpts, flipH: !this.mediaEditOpts.flipH };
            this.setStatus(`Flip horizontal for the next attachment: ${this.mediaEditOpts.flipH ? "on" : "off"}.`);
          };
          cropBox.appendChild(flipHBtn);
          const flipVBtn = document.createElement("button");
          flipVBtn.type = "button";
          flipVBtn.textContent = "⇅ Flip V";
          flipVBtn.onclick = () => {
            this.mediaEditOpts = { ...this.mediaEditOpts, flipV: !this.mediaEditOpts.flipV };
            this.setStatus(`Flip vertical for the next attachment: ${this.mediaEditOpts.flipV ? "on" : "off"}.`);
          };
          cropBox.appendChild(flipVBtn);
          body.appendChild(cropBox);
        }
        const attach = document.createElement("input");
        attach.type = "file";
        attach.accept = "image/*,video/*,audio/*";
        attach.addEventListener("change", () => void this.handleAttach(attach, block));
        const attachLabel = document.createElement("p");
        attachLabel.className = "an-note";
        attachLabel.textContent = "Attach media: uploads to the Internet Archive in the background; the post stores only the hotlink.";
        body.append(attachLabel, attach);
        return body;
      }
      case "app": {
        const note = document.createElement("p");
        note.className = "an-note";
        note.textContent = "Sandboxed iframe only — never inline HTML. Max ~150 KB.";
        const area = document.createElement("textarea");
        area.className = "an-ed-field";
        area.rows = 4;
        area.value = block.appSrcdoc ?? block.appSrc ?? "";
        area.addEventListener("input", () => {
          if (area.value.length > 150 * 1024) {
            this.setStatus(`App block is ${area.value.length} bytes — over the ~150 KB cap. Shorten it before publishing.`);
          }
          this.patchBlock(block, { appSrcdoc: area.value });
        });
        body.append(note, area);
        return body;
      }
      case "list": {
        const bar = document.createElement("div");
        bar.className = "an-ed-bar";
        const styleLabel = document.createElement("span");
        styleLabel.className = "an-ed-label";
        styleLabel.textContent = "List";
        bar.appendChild(styleLabel);
        const ulBtn = this.barButton(bar, "• Bulleted", "Bulleted list", () => {
          this.patchBlock(block, { listStyle: "ul" });
          this.afterChange();
        });
        const olBtn = this.barButton(bar, "1. Numbered", "Numbered list", () => {
          this.patchBlock(block, { listStyle: "ol" });
          this.afterChange();
        });
        ulBtn.setAttribute("aria-pressed", String((block.listStyle ?? "ul") === "ul"));
        olBtn.setAttribute("aria-pressed", String(block.listStyle === "ol"));
        this.barButton(bar, "+ Item", "Add an item at the end of the list", () => {
          if (appendListItem(block)) this.afterChange();
          else this.setStatus("List is full.");
        });
        body.appendChild(bar);
        body.appendChild(this.listTableFormatBar(block));
        for (const [i, item] of (block.listItems ?? []).entries()) {
          body.appendChild(this.renderListItemRow(block, item, [i]));
        }
        return body;
      }
      case "table": {
        const bar = document.createElement("div");
        bar.className = "an-ed-bar";
        const label = document.createElement("span");
        label.className = "an-ed-label";
        const size = tableSize(block);
        label.textContent = size ? `Table — ${size.rows}×${size.cols}` : "Table";
        bar.appendChild(label);
        this.barButton(bar, "+ Row", "Add a row at the bottom", () => {
          if (addTableRow(block)) this.afterChange();
          else this.setStatus("Table is at the maximum number of rows.");
        });
        this.barButton(bar, "− Row", "Remove the last row", () => {
          if (removeTableRow(block)) this.afterChange();
          else this.setStatus("A table keeps at least one row.");
        });
        this.barButton(bar, "+ Column", "Add a column at the right", () => {
          if (addTableColumn(block)) this.afterChange();
          else this.setStatus("Table is at the maximum number of columns.");
        });
        this.barButton(bar, "− Column", "Remove the last column", () => {
          if (removeTableColumn(block)) this.afterChange();
          else this.setStatus("A table keeps at least one column.");
        });
        const headerBtn = this.barButton(bar, "Header row", "Toggle the header row", () => {
          toggleTableHeader(block);
          this.afterChange();
        });
        headerBtn.setAttribute("aria-pressed", String(block.headerRow !== false));
        body.appendChild(bar);
        body.appendChild(this.listTableFormatBar(block));
        body.appendChild(
          this.fieldInput("Caption (shown above the table)", block.caption ?? "", (v) =>
            this.patchBlock(block, { caption: v }),
          ),
        );
        for (const [r, row] of (block.rows ?? []).entries()) {
          const rowEl = document.createElement("div");
          rowEl.className = "an-ed-table-row";
          for (const [c, cell] of row.entries()) {
            rowEl.appendChild(this.renderTableCell(block, cell, r, c));
          }
          body.appendChild(rowEl);
        }
        return body;
      }
      case "cols": {
        for (const col of block.columns ?? []) {
          const colEl = document.createElement("div");
          colEl.className = "an-ed-col";
          for (const child of col) colEl.appendChild(this.renderEditableBlock(child));
          body.appendChild(colEl);
        }
        return body;
      }
      default: {
        // cards, series-grid, gallery, docs-sidebar, nav: editable item rows.
        const items = block.items ?? [];
        if (items.length === 0) {
          const note = document.createElement("p");
          note.className = "an-note";
          note.textContent = `${blockLabel(block.type)} — no items yet. Use “+ Item” below.`;
          body.appendChild(note);
        }
        for (const item of items) {
          const row = document.createElement("div");
          const input = document.createElement("input");
          input.className = "an-ed-field";
          input.type = "text";
          input.value = item.text ?? item.title ?? "";
          input.placeholder = "Item text";
          input.addEventListener("input", () => {
            const target = findBlock(this.editor?.blocks ?? [], item.id ?? "");
            if (target) {
              target.text = input.value;
              this.editor!.dirty = true;
              this.refreshPreview();
              this.scheduleAutosave();
            }
          });
          row.appendChild(input);
          body.appendChild(row);
        }
        const add = document.createElement("button");
        add.type = "button";
        add.textContent = "+ Item";
        add.onclick = () => {
          const item: BlockNode = { ...defaultBlock("p"), text: "New item" };
          block.items = [...(block.items ?? []), item];
          this.editor!.dirty = true;
          this.afterChange();
        };
        body.appendChild(add);
        return body;
      }
    }
  }

  /** One editable list-item row: a contenteditable for the item text,
   *  indent/outdent/add/remove controls, and its nested children.
   *  Focusing the editable makes the item the shared format bar's
   *  target; typing updates the item's runs in place (no canvas
   *  rebuild, so focus survives — R1). */
  private renderListItemRow(block: BlockNode, item: ListItem, path: number[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "an-ed-list-item";
    const editable = document.createElement("div");
    editable.className = "an-ed-text";
    editable.contentEditable = this.canEdit() ? "true" : "false";
    // M2: a formatted list item renders its runs in the canvas too.
    this.setEditableContent(editable, item.runs && item.runs.length > 0 ? item.runs : runsFromText(item.text ?? ""));
    editable.addEventListener("focus", () => {
      this.listTableTarget = { block, kind: "item", path: [...path], editable };
      this.shareCursor(block, editable);
    });
    editable.addEventListener("input", () => {
      setListItemText(block, path, editable.textContent ?? "");
      if (this.editor) this.editor.dirty = true;
      this.refreshPreview();
      this.scheduleAutosave();
    });
    const controls = document.createElement("div");
    controls.className = "an-ed-bar";
    this.barButton(controls, "→", "Indent — make this item a child of the item above", () => {
      if (indentListItem(block, path)) this.afterChange();
      else this.setStatus("Cannot indent the first item of a level.");
    });
    this.barButton(controls, "←", "Outdent — move this item up one level", () => {
      if (outdentListItem(block, path)) this.afterChange();
      else this.setStatus("Top-level items cannot be outdented.");
    });
    this.barButton(controls, "+", "Add an item after this one", () => {
      if (insertListItem(block, path)) this.afterChange();
    });
    this.barButton(controls, "✕", "Remove this item", () => {
      if (removeListItem(block, path)) this.afterChange();
      else this.setStatus("A list keeps at least one item.");
    });
    row.append(editable, controls);
    if (item.children && item.children.length > 0) {
      const kids = document.createElement("div");
      kids.className = "an-ed-list-children";
      for (const [i, child] of item.children.entries()) {
        kids.appendChild(this.renderListItemRow(block, child, [...path, i]));
      }
      row.appendChild(kids);
    }
    return row;
  }

  /** One editable table cell. Focusing it makes the cell the shared
   *  format bar's target; typing updates the cell's runs in place. */
  private renderTableCell(block: BlockNode, cell: TableCell, row: number, col: number): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "an-ed-table-cell";
    const editable = document.createElement("div");
    editable.className = "an-ed-text";
    editable.contentEditable = this.canEdit() ? "true" : "false";
    // M2: a formatted table cell renders its runs in the canvas too.
    this.setEditableContent(editable, cell.runs && cell.runs.length > 0 ? cell.runs : runsFromText(cell.text ?? ""));
    editable.addEventListener("focus", () => {
      this.listTableTarget = { block, kind: "cell", row, col, editable };
      this.shareCursor(block, editable);
    });
    editable.addEventListener("input", () => {
      setTableCellText(block, row, col, editable.textContent ?? "");
      if (this.editor) this.editor.dirty = true;
      this.refreshPreview();
      this.scheduleAutosave();
    });
    wrap.appendChild(editable);
    return wrap;
  }

  private fieldInput(label: string, value: string, onInput: (v: string) => void): HTMLElement {
    const wrap = document.createElement("label");
    wrap.textContent = label;
    const input = document.createElement("input");
    input.className = "an-ed-field";
    input.type = "text";
    input.value = value;
    input.addEventListener("input", () => onInput(input.value));
    wrap.appendChild(input);
    return wrap;
  }

  private updateBlockText(block: BlockNode, text: string): void {
    const target = findBlock(this.editor?.blocks ?? [], block.id ?? "") ?? block;
    // Typing keeps the block's inline formatting per character position:
    // surviving characters keep their format, new characters take the
    // format of the run they were typed into.
    const runs = syncRunsFromText(blockRuns(target), text);
    target.text = text;
    target.runs = runs.some((r) => r.format !== undefined) ? runs : undefined;
    if (this.editor) this.editor.dirty = true;
    this.refreshPreview();
    this.scheduleAutosave();
  }

  private patchBlock(block: BlockNode, patch: Partial<BlockNode>): void {
    const target = findBlock(this.editor?.blocks ?? [], block.id ?? "") ?? block;
    Object.assign(target, patch);
    if (this.editor) this.editor.dirty = true;
    this.refreshPreview();
    this.scheduleAutosave();
  }

  private async handleAttach(input: HTMLInputElement, block: BlockNode): Promise<void> {
    const file = input.files?.[0];
    if (!file || !this.editor) return;
    const gate = gateMediaUpload(this.role);
    if (!gate.allowed) {
      this.setStatus(gate.reason);
      return;
    }
    const keys = this.opts.getIaKeys();
    // Images are prepared BEFORE the stealth IA upload: crop (from the
    // aspect picked in the crop panel, against the real dimensions),
    // rotate/flip, downscale to max 1600px, WebP 80%. The original
    // full-size file never leaves the device.
    let uploadFile: Blob = file;
    let uploadName = file.name;
    let thumbnail: { blob: Blob; filename: string } | null = null;
    if (file.type.startsWith("image/")) {
      try {
        const pixels = await blobToPixels(file);
        const crop =
          this.pendingAspect === "freeform"
            ? undefined
            : cropForAspect(pixels.width, pixels.height, this.pendingAspect);
        const prepared = await prepareImageForUpload(file, file.name, {
          ...this.mediaEditOpts,
          crop,
        });
        uploadFile = prepared.blob;
        uploadName = prepared.filename;
        thumbnail = { blob: prepared.thumbnail.blob, filename: prepared.thumbnail.filename };
        this.setStatus(
          `Prepared “${file.name}” — ${pixels.width}×${pixels.height} → ${prepared.width}×${prepared.height} ${prepared.mime}, thumbnail ${prepared.thumbnail.width}×${prepared.thumbnail.height}. Uploading to the Internet Archive…`,
        );
      } catch (err) {
        this.setStatus(
          `Image processing unavailable (${err instanceof Error ? err.message : String(err)}) — attaching the original file; it will be downscaled by the IA path instead.`,
        );
      }
    }
    const media = attachMedia(uploadFile, uploadName, keys, this.opts.iaQueue, this.opts.iaFetch, (done) => {
      if (done.status === "ready") {
        this.patchBlock(block, { src: done.hotlink, alt: done.hotlink.split("/").pop() ?? block.alt });
        this.setStatus(`Uploaded to the Internet Archive: ${done.hotlink} — the post stores only this hotlink.`);
        this.renderCanvas();
      } else if (done.status === "failed") {
        this.setStatus("Upload failed — your local copy is kept, retry later. Nothing was lost.");
      }
    });
    if (thumbnail && keys) {
      // The ~12 KB thumbnail goes to the same IA item, same queue.
      attachMedia(thumbnail.blob, thumbnail.filename, keys, this.opts.iaQueue, this.opts.iaFetch, () => {});
    }
    if (media.status === "ia_not_linked") {
      this.setStatus("ia_not_linked — link an Internet Archive account in Settings to enable stealth upload. Your file is shown locally for now; nothing was uploaded.");
      return;
    }
    this.setStatus(`Uploading “${uploadName}” to the Internet Archive in the background… (local preview kept until it succeeds)`);
    this.patchBlock(block, { src: media.localPreviewUrl ?? "" });
  }

  private renderSidebar(): void {
    const side = this.$("editor-sidebar");
    side.innerHTML = "";
    if (!this.editor) return;
    const doc = this.editor.doc;

    const docTitle = document.createElement("h3");
    docTitle.textContent = "Document";
    side.appendChild(docTitle);
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = doc.title;
    titleInput.setAttribute("aria-label", "Site title");
    titleInput.addEventListener("input", () => {
      doc.title = titleInput.value;
      this.editor!.dirty = true;
      this.refreshPreview();
      this.scheduleAutosave();
    });
    side.appendChild(titleInput);

    const navTitle = document.createElement("h3");
    navTitle.textContent = "Navigation — global, all pages";
    side.appendChild(navTitle);
    const navList = document.createElement("ul");
    for (const n of doc.nav ?? []) {
      const li = document.createElement("li");
      // Nit (b): the href wraps at path boundaries, not mid-word. A
      // <wbr> after each "/" (except the two in "://") gives the line
      // breaker a sensible break point, so "…/about" stays whole and a
      // long URL wraps as "…/segment/" + "next" instead of "abo ut".
      // <wbr> adds no text, so textContent and the title tooltip are
      // unchanged, and overflow-wrap:break-word stays as the fallback
      // for a single segment longer than the line.
      li.append(document.createTextNode(`${n.label} → `));
      let run = "";
      for (const ch of n.href) {
        run += ch;
        if (ch === "/") {
          const prev = run[run.length - 2] ?? "";
          if (prev !== ":" && prev !== "/") {
            li.append(document.createTextNode(run), document.createElement("wbr"));
            run = "";
          }
        }
      }
      if (run) li.append(document.createTextNode(run));
      // B9: the full URL is the row's title tooltip, set here at
      // render time — the shell no longer sets it by mouseover
      // delegation (that only fired on first hover, so keyboard /
      // touch users and visual QA never saw it).
      li.title = li.textContent;
      navList.appendChild(li);
    }
    side.appendChild(navList);
    const slugInput = document.createElement("input");
    slugInput.type = "text";
    slugInput.placeholder = "new-page slug";
    const pageTitleInput = document.createElement("input");
    pageTitleInput.type = "text";
    pageTitleInput.placeholder = "New page title";
    const addPageBtn = document.createElement("button");
    addPageBtn.type = "button";
    addPageBtn.textContent = "+ Add page";
    addPageBtn.onclick = () => {
      const slug = slugInput.value.trim();
      const title = pageTitleInput.value.trim();
      if (!slug || !title) {
        this.setStatus("To add a page, give it a slug and a title.");
        return;
      }
      this.editor?.addPage(slug, title);
      this.afterChange();
      this.setStatus(`Added page “${title}” — the global navigation now lists it on every page of ${doc.domain}.`);
    };
    side.append(pageTitleInput, slugInput, addPageBtn);

    const sel = this.editor.selected();
    const selTitle = document.createElement("h3");
    selTitle.textContent = sel ? `Selected: ${blockLabel(sel.type)}` : "No block selected";
    side.appendChild(selTitle);
    if (sel) {
      const visLabel = document.createElement("p");
      visLabel.textContent = "Show this block on:";
      side.appendChild(visLabel);
      for (const vp of ["desktop", "tablet", "mobile"] as const) {
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = (sel.visibleOn ?? ["desktop", "tablet", "mobile"]).includes(vp);
        box.onchange = () => {
          const current = new Set<"desktop" | "tablet" | "mobile">(sel.visibleOn ?? ["desktop", "tablet", "mobile"]);
          if (box.checked) current.add(vp);
          else current.delete(vp);
          this.editor?.setVisibility(sel.id ?? "", [...current]);
          this.refreshPreview();
          this.scheduleAutosave();
        };
        label.append(box, document.createTextNode(` ${vp}`));
        side.appendChild(label);
      }
      if (sel.type === "img") {
        const focal = document.createElement("label");
        focal.textContent = "Focal point (horizontal %)";
        const range = document.createElement("input");
        range.type = "range";
        range.min = "0";
        range.max = "100";
        range.value = String(sel.focalPoint?.x ?? 50);
        range.oninput = () => {
          this.patchBlock(sel, { focalPoint: { x: Number(range.value), y: sel.focalPoint?.y ?? 50 } });
          this.renderCanvas();
        };
        focal.appendChild(range);
        side.appendChild(focal);
      }
    }

    const gateNote = document.createElement("p");
    gateNote.className = "an-note";
    gateNote.textContent = `Signed in as role “${this.role.name}”. Client-side gating only — the GitHub Action that validates commits to site.json.zst / team.json.zst follows with the central repos.`;
    side.appendChild(gateNote);
    // Role enforcement (B4): a viewer cannot edit the title, add pages,
    // or change per-block visibility from the sidebar either.
    if (!this.canEdit()) {
      for (const el of side.querySelectorAll("input,select,button,textarea")) {
        (el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = true;
      }
    }
  }
}
