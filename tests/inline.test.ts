// Tests: inline rich-text formatting — typed runs, never raw HTML.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFormat,
  clearLink,
  isSafeUrl,
  normalizeRuns,
  plainText,
  renderInlineRuns,
  runsFromText,
  setLink,
  syncRunsFromText,
} from "../src/lib/inline.js";
import { renderBlock } from "../src/lib/renderer.js";
import { EditorState } from "../src/lib/editor.js";
import { validateBlock } from "../src/lib/blocks.js";

test("applyFormat bolds only the selected range and merges runs", () => {
  const runs = runsFromText("Hello world");
  const out = applyFormat(runs, 0, 5, { bold: true }, "set");
  assert.deepEqual(out, [{ text: "Hello", format: { bold: true } }, { text: " world" }]);
  assert.equal(plainText(out), "Hello world");
  assert.equal(renderInlineRuns(out), "<strong>Hello</strong> world");
});

test("toggle removes a mark when the whole range already has it, else sets it", () => {
  const bold = applyFormat(runsFromText("Hello world"), 0, 5, { bold: true }, "set");
  assert.deepEqual(applyFormat(bold, 0, 5, { bold: true }, "toggle"), runsFromText("Hello world"));
  // Half-covered: toggle sets it on all.
  const half = applyFormat(bold, 3, 8, { bold: true }, "toggle");
  assert.equal(renderInlineRuns(half), "<strong>Hello wo</strong>rld");
});

test("multiple marks nest deterministically and empty ranges are no-ops", () => {
  const runs = applyFormat(runsFromText("abc"), 0, 3, { bold: true, italic: true }, "set");
  assert.equal(renderInlineRuns(runs), "<strong><em>abc</em></strong>");
  assert.deepEqual(applyFormat(runs, 1, 1, { underline: true }, "set"), runs);
  assert.deepEqual(applyFormat(runs, -5, 99, { underline: true }, "set"), applyFormat(runsFromText("abc"), 0, 3, { bold: true, italic: true, underline: true }, "set"));
});

test("links are allow-listed: IA and arknetz: pass, javascript: and trackers are dropped", () => {
  assert.equal(isSafeUrl("https://archive.org/download/i/f.webp"), true);
  assert.equal(isSafeUrl("arknetz://a.zine/page"), true);
  assert.equal(isSafeUrl("javascript:alert(1)"), false);
  assert.equal(isSafeUrl("https://tracker.example/x"), false);
  const linked = setLink(runsFromText("click here"), 0, 5, "https://archive.org/download/i/f.webp");
  assert.equal(renderInlineRuns(linked), '<a href="https://archive.org/download/i/f.webp" rel="noopener">click</a> here');
  const bad = setLink(runsFromText("click here"), 0, 5, "javascript:alert(1)");
  assert.deepEqual(bad, runsFromText("click here"));
  assert.equal(renderInlineRuns(clearLink(linked, 0, 5)), "click here");
});

test("renderInlineRuns escapes text and never emits raw HTML", () => {
  const runs = applyFormat(runsFromText('<script>alert("x")</script>'), 0, 8, { bold: true }, "set");
  const html = renderInlineRuns(runs);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>/);
});

test("syncRunsFromText keeps formatting per character when the user types", () => {
  const runs = applyFormat(runsFromText("Hello"), 0, 5, { bold: true }, "set");
  // Type "!" at the end: it takes the bold of the run it was typed into.
  assert.equal(renderInlineRuns(syncRunsFromText(runs, "Hello!")), "<strong>Hello!</strong>");
  // Delete the middle: surviving characters keep bold.
  assert.equal(renderInlineRuns(syncRunsFromText(runs, "Hlo")), "<strong>Hlo</strong>");
  // Replace with plain text: no runs, no formatting.
  assert.deepEqual(syncRunsFromText(runs, ""), []);
});

test("the shared renderer renders runs in the reader — same code path", () => {
  const html = renderBlock({
    type: "p",
    text: "Hello world",
    runs: [
      { text: "Hello", format: { bold: true } },
      { text: " world" },
    ],
  });
  assert.equal(html, "<p><strong>Hello</strong> world</p>");
  // Plain text blocks render exactly as before.
  assert.equal(renderBlock({ type: "p", text: "Hello" }), "<p>Hello</p>");
  assert.equal(renderBlock({ type: "h2", text: "T" }), "<h2>T</h2>");
});

test("runs are validated: unsafe hrefs and runs/text disagreement are rejected", () => {
  assert.deepEqual(validateBlock({ type: "p", text: "x", runs: [{ text: "x", format: { href: "javascript:alert(1)" } }] }).length > 0, true);
  assert.deepEqual(validateBlock({ type: "p", text: "wrong", runs: [{ text: "right" }] }).length > 0, true);
  assert.deepEqual(validateBlock({ type: "p", text: "same", runs: [{ text: "same", format: { bold: true } }] }), []);
});

test("EditorState.formatBlock / setBlockLink keep text in sync", () => {
  const ed = new EditorState({
    domain: "test.zine",
    title: "Test",
    blocks: [{ type: "p", text: "Hello world", id: "b1" }],
  });
  assert.equal(ed.formatBlock("b1", 0, 5, { bold: true }, "toggle"), true);
  assert.equal(ed.blocks[0]?.text, "Hello world");
  assert.deepEqual(ed.blocks[0]?.runs, [{ text: "Hello", format: { bold: true } }, { text: " world" }]);
  assert.equal(ed.formatBlock("b1", 0, 5, { bold: true }, "toggle"), true);
  assert.equal(ed.blocks[0]?.runs, undefined);
  assert.equal(ed.setBlockLink("b1", 6, 11, "https://archive.org/download/i/f.webp"), true);
  assert.match(JSON.stringify(ed.blocks[0]?.runs), /archive\.org/);
  // Code blocks and missing blocks refuse formatting.
  assert.equal(ed.formatBlock("missing", 0, 1, { bold: true }), false);
  const code = ed.insertBlock("code", undefined, { text: "x = 1" });
  assert.equal(ed.formatBlock(code.id as string, 0, 1, { bold: true }), false);
  assert.deepEqual(normalizeRuns(runsFromText("")), []);
});
