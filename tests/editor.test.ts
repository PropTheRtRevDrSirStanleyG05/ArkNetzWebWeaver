// Tests: visual builder editor state machine + block registry.
import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "../src/lib/editor.js";
import {
  BLOCK_TYPES,
  defaultBlock,
  parseSlashCommand,
  slashSuggestions,
  validateBlock,
  validateDocument,
} from "../src/lib/blocks.js";
import { OWNER_ROLE, WRITER_ROLE } from "../src/lib/roles.js";
import type { SiteDocument } from "../src/lib/types.js";

function freshDoc(): SiteDocument {
  return {
    domain: "test.zine",
    title: "Test",
    nav: [{ label: "Home", href: "arknetz://test.zine" }],
    blocks: [
      { type: "h1", text: "Hello", id: "b1" },
      { type: "p", text: "Body", id: "b2" },
    ],
  };
}

test("block whitelist covers every required type and nothing else is accepted", () => {
  for (const t of ["hero", "nav", "h1", "h2", "h3", "p", "cols", "cards", "series-grid", "img", "video", "audio", "code", "quote", "link", "docs-sidebar", "gallery", "app"]) {
    assert.ok(BLOCK_TYPES.includes(t as never), `missing ${t}`);
  }
  assert.deepEqual(validateBlock({ type: "mystery" as never }), ["blocks[0]: unknown block type \"mystery\""]);
  assert.deepEqual(validateBlock({ type: "p", text: "ok" }), []);
});

test("app blocks over the ~150 KB cap are rejected at validation", () => {
  const problems = validateBlock({ type: "app", appSrcdoc: "x".repeat(150 * 1024 + 1) });
  assert.match(problems.join(" "), /150 KB cap/);
  assert.deepEqual(validateDocument(freshDoc()), []);
  assert.ok(validateDocument({ domain: "", title: "", blocks: [] }).length >= 2);
});

test("slash commands parse type + text, and unknown commands return null", () => {
  assert.deepEqual(parseSlashCommand("/h2 My heading"), { type: "h2", text: "My heading" });
  assert.deepEqual(parseSlashCommand("/image"), { type: "img", text: "" });
  assert.equal(parseSlashCommand("plain text"), null);
  assert.equal(parseSlashCommand("/nope"), null);
  assert.ok(slashSuggestions("h").some((s) => s.keyword === "h1"));
  assert.ok(slashSuggestions("").length >= 15);
});

test("editor inserts, moves, deletes, duplicates blocks", () => {
  const ed = new EditorState(freshDoc());
  const inserted = ed.insertBlock("h2", 1, { text: "Middle" });
  assert.equal(ed.blocks[1]?.id, inserted.id);
  assert.equal(ed.blocks.length, 3);
  assert.equal(ed.moveBlock(inserted.id as string, -1), true);
  assert.equal(ed.blocks[0]?.id, inserted.id);
  assert.equal(ed.moveBlock(inserted.id as string, -1), false); // already at top
  const dup = ed.duplicateBlock("b2");
  assert.ok(dup && dup.id !== "b2" && dup.text === "Body");
  assert.equal(ed.deleteBlock("b1"), true);
  assert.equal(ed.deleteBlock("nope"), false);
  assert.equal(ed.blocks.length, 3);
});

test("typeLine turns /commands into blocks and plain text into paragraphs", () => {
  const ed = new EditorState(freshDoc());
  const h = ed.typeLine("/h3 Section title");
  assert.equal(h.type, "h3");
  assert.equal(h.text, "Section title");
  const p = ed.typeLine("Just a sentence.");
  assert.equal(p.type, "p");
  assert.equal(p.text, "Just a sentence.");
});

test("per-block visibility is stored and updateable", () => {
  const ed = new EditorState(freshDoc());
  assert.equal(ed.setVisibility("b1", ["desktop"]), true);
  assert.deepEqual(ed.blocks[0]?.visibleOn, ["desktop"]);
  assert.equal(ed.setVisibility("missing", ["desktop"]), false);
});

test("addPage updates the global navigation on every page", () => {
  const ed = new EditorState(freshDoc());
  const page = ed.addPage("about", "About");
  assert.equal(page.slug, "about");
  assert.ok(ed.doc.nav?.some((n) => n.label === "About" && n.href === "arknetz://test.zine/about"));
  assert.equal(ed.pages.length, 1);
});

test("publish preview serialises the document and refuses bad roles", async () => {
  const ed = new EditorState(freshDoc());
  const ok = await ed.publishPreview(OWNER_ROLE);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.preview.filename, "site.json.zst");
    assert.ok(ok.preview.bytes > 50);
    assert.ok(ok.preview.compressedBytes > 0 && ok.preview.compressedBytes <= ok.preview.bytes);
    assert.match(ok.preview.json, /"domain": "test\.zine"/);
  }
  const bad = await ed.publishPreview(WRITER_ROLE);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /pages\.publish/);
});

test("an app block cannot be published by a role without apps.embed", async () => {
  const doc = freshDoc();
  doc.blocks.push({ type: "app", appSrcdoc: "<p>x</p>", id: "app1" });
  const ed = new EditorState(doc);
  const bad = await ed.publishPreview(WRITER_ROLE);
  assert.equal(bad.ok, false);
  const ok = await ed.publishPreview(OWNER_ROLE);
  assert.equal(ok.ok, true);
});

test("defaultBlock gives every type a usable shape", () => {
  for (const t of BLOCK_TYPES) {
    const b = defaultBlock(t);
    assert.equal(b.type, t);
    assert.ok(b.id);
  }
  assert.equal(defaultBlock("cols").columns?.length, 2);
});
