// ArkNetzWebWeaver — visual builder UI (builder phase).
// Live-canvas Gutenberg-style editor. The preview pane renders through
// the SHARED renderer (renderSiteDocument) — the editor never renders
// pages itself, so what you see while editing is exactly what a reader
// sees. Click-to-type is contenteditable on the canvas; the preview
// refreshes on every change (debounced). State lives in EditorState
// (editor.ts); this module is only DOM wiring.

import { blockLabel, BLOCK_TYPES, defaultBlock, slashSuggestions } from "./blocks.js";
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
import type { BlockNode, SiteDocument } from "./types.js";
import { renderBlock, renderSiteDocument } from "./renderer.js";
import type { GithubFetchFn } from "./publish.js";
import { importWxr } from "./wxr.js";
import { syncRunsFromText } from "./inline.js";
import { blockRuns } from "./editor.js";

export interface EditorUiOptions {
  getIaKeys: () => IaKeys | null;
  iaQueue: IaUploadQueue;
  iaFetch: IaFetchFn;
  /** OAuth token from the GitHub sign-in flow. Null = not signed in. */
  getGithubToken: () => string | null;
  /** The signed-in GitHub login (repo owner for Publish). */
  getGithubLogin: () => string | null;
  /** The per-domain site repo, when it exists. Null = not created yet. */
  getSiteRepo: (domain: string) => string | null;
  githubFetch: GithubFetchFn;
}

export interface EditorUiOptions {
  getIaKeys: () => IaKeys | null;
  iaQueue: IaUploadQueue;
  iaFetch: IaFetchFn;
}

const TEXT_BLOCKS = new Set(["h1", "h2", "h3", "p", "quote", "code"]);

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

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: EditorUiOptions,
  ) {}

  get doc(): SiteDocument | null {
    return this.editor?.doc ?? null;
  }

  private $(id: string): HTMLElement {
    const el = this.root.ownerDocument.getElementById(id);
    if (!el) throw new Error(`editor element #${id} is missing`);
    return el;
  }

  open(doc: SiteDocument): void {
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
   *  the current selection inside a contenteditable text block. The
   *  selection is read from the DOM, applied to the block's typed runs,
   *  and the canvas re-renders through the shared renderer.
   *
   *  Selection survival (B3): a mousedown on a toolbar button moves
   *  focus out of the contenteditable and collapses the selection
   *  before the click handler runs — Bold used to read an empty
   *  selection and silently do nothing. Two defences: every toolbar
   *  button preventDefaults its mousedown so focus (and the selection)
   *  never leaves the editable, and the toolbar captures the selection
   *  on mousedown into a SavedSelection, so actions that must move
   *  focus — typing a URL in the link input, then clicking Link — still
   *  apply to the text that was selected. */
  private formatToolbar(block: BlockNode, editable: HTMLElement): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "an-fmt-bar";
    const saved = new SavedSelection();
    const canEdit = this.canEdit();
    // Capture before focus moves: mousedown fires before the default
    // focus change collapses the selection.
    bar.addEventListener("mousedown", () => saved.capture(editable, window.getSelection()));
    const sel = (): { start: number; end: number } | null => saved.take(editable, window.getSelection());
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
        const r = sel();
        if (!r || r.start === r.end) {
          this.setStatus("Select some text first, then apply formatting.");
          return;
        }
        fn(r);
        this.afterChange();
      };
      bar.appendChild(b);
    };
    mkBtn("B", "Bold", (r) => this.editor?.formatBlock(block.id ?? "", r.start, r.end, { bold: true }, "toggle"));
    mkBtn("I", "Italic", (r) => this.editor?.formatBlock(block.id ?? "", r.start, r.end, { italic: true }, "toggle"));
    mkBtn("U", "Underline", (r) => this.editor?.formatBlock(block.id ?? "", r.start, r.end, { underline: true }, "toggle"));
    mkBtn("S", "Strikethrough", (r) => this.editor?.formatBlock(block.id ?? "", r.start, r.end, { strike: true }, "toggle"));
    mkBtn("<>", "Inline code", (r) => this.editor?.formatBlock(block.id ?? "", r.start, r.end, { code: true }, "toggle"));
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
      if (!this.editor?.setBlockLink(block.id ?? "", r.start, r.end, href)) {
        this.setStatus(`Refused unsafe link target: ${href}. Links must be https: to archive.org / raw.githubusercontent.com, or arknetz://.`);
        return;
      }
      this.afterChange();
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
      const r = sel();
      if (!r || r.start === r.end) {
        this.setStatus("Select the linked text first, then Unlink.");
        return;
      }
      this.editor?.clearBlockLink(block.id ?? "", r.start, r.end);
      this.afterChange();
    };
    bar.appendChild(unlinkBtn);
    return bar;
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
      el.textContent = block.text ?? "";
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
