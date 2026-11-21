// Tests: builder themes, roles, revisions, WXR import, static export.
import test from "node:test";
import assert from "node:assert/strict";
import { THEME_PRESETS, applyPresetToDocument, themeCssVariables, themePreset } from "../src/lib/themes.js";
import {
  EDITOR_ROLE,
  WRITER_ROLE,
  can,
  canEditPath,
  gateAppEmbed,
  gateMediaUpload,
  gatePublish,
  presetRole,
} from "../src/lib/roles.js";
import {
  autosaveDraft,
  createFailingRevisionStore,
  createMemoryRevisionStore,
  diffRevisions,
  loadDraft,
  makeRevision,
} from "../src/lib/revisions.js";
import { htmlToBlocks, importWxr, parseWxr } from "../src/lib/wxr.js";
import { buildZip, crc32, exportStaticFiles, exportStaticZip } from "../src/lib/export.js";
import { renderBlock } from "../src/lib/renderer.js";
import type { SiteDocument } from "../src/lib/types.js";

test("theme presets: all four exist and produce CSS variables in both modes", () => {
  for (const id of ["academic", "tech-docs", "editorial", "portfolio"]) {
    const preset = themePreset(id);
    assert.ok(preset, `missing preset ${id}`);
    const light = themeCssVariables(preset!, "light");
    const dark = themeCssVariables(preset!, "dark");
    assert.match(light, /--an-accent:/);
    assert.match(dark, /--an-bg:#111827/);
    assert.notEqual(light, dark);
  }
  assert.equal(THEME_PRESETS.length, 4);
  const doc: SiteDocument = { domain: "a.zine", title: "T", blocks: [] };
  applyPresetToDocument(doc, themePreset("editorial")!);
  assert.equal(doc.theme?.accent, "#b91c1c");
});

test("roles: owner can do everything, writer is path-limited, viewer cannot publish", () => {
  assert.equal(can(presetRole("owner")!, "pages.publish"), true);
  assert.equal(can(WRITER_ROLE, "pages.publish"), false);
  assert.equal(can(WRITER_ROLE, "media.upload"), true);
  assert.equal(can(EDITOR_ROLE, "apps.embed"), false);
  assert.equal(gatePublish(WRITER_ROLE).allowed, false);
  assert.match(gatePublish(WRITER_ROLE).reason, /pages\.publish/);
  assert.equal(gateMediaUpload(WRITER_ROLE).allowed, true);
  assert.equal(gateAppEmbed(EDITOR_ROLE).allowed, false);
  assert.equal(canEditPath(WRITER_ROLE, "blog/hello"), true);
  assert.equal(canEditPath(WRITER_ROLE, "about"), false);
  assert.equal(canEditPath(EDITOR_ROLE, "about"), true);
});

test("revisions: diff reports added, removed, changed and same blocks", () => {
  const base: SiteDocument = {
    domain: "a.zine",
    title: "T",
    blocks: [
      { type: "h1", text: "Same", id: "1" },
      { type: "p", text: "Old", id: "2" },
      { type: "p", text: "Gone", id: "3" },
    ],
  };
  const edited: SiteDocument = {
    domain: "a.zine",
    title: "T",
    blocks: [
      { type: "h1", text: "Same", id: "1" },
      { type: "p", text: "New", id: "2" },
      { type: "p", text: "Added", id: "4" },
    ],
  };
  const lines = diffRevisions(makeRevision(base, "r1"), makeRevision(edited, "r2"));
  assert.equal(lines.filter((l) => l.kind === "same").length, 1);
  assert.equal(lines.filter((l) => l.kind === "changed").length, 1);
  assert.equal(lines.filter((l) => l.kind === "added").length, 1);
  assert.equal(lines.filter((l) => l.kind === "removed").length, 1);
});

test("autosave: success stores a draft, failure names the reason and a retry delay", async () => {
  const store = createMemoryRevisionStore();
  const doc: SiteDocument = { domain: "a.zine", title: "T", blocks: [{ type: "p", text: "hi" }] };
  const ok = await autosaveDraft(store, "draft:a.zine", doc);
  assert.equal(ok.ok, true);
  const loaded = await loadDraft(store, "draft:a.zine");
  assert.equal(loaded?.blocks[0]?.text, "hi");

  const failing = createFailingRevisionStore("IndexedDB quota exceeded");
  const bad = await autosaveDraft(failing, "draft:a.zine", doc, 1);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.error, /IndexedDB quota exceeded/);
    assert.equal(bad.retryInMs, 2000);
  }
});

test("WXR: parses posts, skips attachments and drafts, maps HTML to blocks", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Hello World</title><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><wp:post_name>hello-world</wp:post_name><content:encoded><![CDATA[<h2>Intro</h2><p>First para.</p><blockquote>Quoted.</blockquote><script>alert(1)</script><img src="https://example.com/a.jpg" alt="A photo">]]></content:encoded></item>
    <item><title>Draft</title><wp:post_type>post</wp:post_type><wp:status>draft</wp:status><content:encoded><![CDATA[<p>Not published.</p>]]></content:encoded></item>
    <item><title>Pic</title><wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status><content:encoded><![CDATA[]]></content:encoded></item>
  </channel></rss>`;
  const posts = parseWxr(xml);
  assert.equal(posts.length, 3);
  assert.equal(posts[0]?.title, "Hello World");
  const { doc, imported, skipped } = importWxr(xml, "blog.zine");
  assert.equal(imported, 1);
  assert.equal(skipped, 2);
  const types = doc.blocks.map((b) => b.type);
  assert.deepEqual(types, ["h1", "h2", "p", "quote", "app", "img"]);
  // The script became a sandboxed app block, never executed HTML.
  const app = doc.blocks.find((b) => b.type === "app");
  assert.ok(app?.appSrcdoc?.includes("alert(1)"));
  assert.doesNotMatch(renderBlock(app!), /<script>alert/);
});

test("htmlToBlocks maps headings, lists, code and figures", () => {
  const blocks = htmlToBlocks(`<h1>Title</h1><p>Text</p><ul><li>One</li><li>Two</li></ul><pre><code>const x = 1;</code></pre>`);
  assert.deepEqual(blocks.map((b) => b.type), ["h1", "p", "p", "p", "code"]);
  assert.equal(blocks[2]?.text, "• One");
});

test("static export: index + style + one page per nav entry, rendered by the shared renderer", () => {
  const doc: SiteDocument = {
    domain: "blog.zine",
    title: "Blog",
    nav: [
      { label: "Home", href: "arknetz://blog.zine" },
      { label: "About", href: "arknetz://blog.zine/about" },
    ],
    blocks: [{ type: "h1", text: "Hello" }, { type: "p", text: "World" }],
  };
  const files = exportStaticFiles(doc);
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("index.html"));
  assert.ok(paths.includes("style.css"));
  assert.ok(paths.includes("about/index.html"));
  const index = files.find((f) => f.path === "index.html")!.content as string;
  assert.match(index, /<h1>Hello<\/h1>/);
  assert.match(index, /<p>World<\/p>/);
  assert.match(index, /archive\.org|style\.css/);
});

// Regression tests for the three Lighthouse audits the export controls
// (round 3 QA, 2026-11-20): missing <main> landmark, missing meta
// description, and the /favicon.ico 404 console error.
test("static export: main landmark, meta description, and a real favicon", () => {
  const doc: SiteDocument = {
    domain: "blog.zine",
    title: "Blog",
    nav: [{ label: "Home", href: "arknetz://blog.zine" }],
    blocks: [
      { type: "hero", title: "Blog", subtitle: "Notes from the edge of the web." },
      { type: "p", text: "First paragraph." },
    ],
  };
  const files = exportStaticFiles(doc);
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("favicon.svg"), "export must ship a favicon file");
  const favicon = files.find((f) => f.path === "favicon.svg")!.content as string;
  assert.match(favicon, /<svg/);
  const index = files.find((f) => f.path === "index.html")!.content as string;
  assert.match(index, /<main>/, "page body must be inside a <main> landmark");
  assert.match(index, /<\/main>/);
  assert.match(index, /<meta name="description" content="Notes from the edge of the web\."/);
  assert.match(index, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
  // Description is derived, escaped, and capped at 160 chars.
  const long = exportStaticFiles({
    domain: "x.zine",
    title: "X",
    blocks: [{ type: "p", text: "A".repeat(200) }],
  });
  const longIndex = long.find((f) => f.path === "index.html")!.content as string;
  const desc = longIndex.match(/<meta name="description" content="([^"]*)"/)![1]!;
  assert.ok(desc.length <= 161, `description capped, got ${desc.length}`);
  // A doc with no text blocks falls back to the title, never empty.
  const bare = exportStaticFiles({ domain: "y.zine", title: "Bare", blocks: [] });
  const bareIndex = bare.find((f) => f.path === "index.html")!.content as string;
  assert.match(bareIndex, /<meta name="description" content="Bare">/);
});

test("zip writer: real ZIP with stored entries, correct CRC32, readable headers", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const zip = exportStaticZip({
    domain: "blog.zine",
    title: "Blog",
    nav: [],
    blocks: [{ type: "p", text: "Hi" }],
  });
  assert.equal(zip.filename, "blog.zine.zip");
  assert.ok(zip.bytes.length > 100);
  const view = new DataView(zip.bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50); // local file header
  const text = new TextDecoder().decode(zip.bytes);
  assert.ok(text.includes("index.html"));
  assert.ok(text.includes("style.css"));
  assert.ok(text.includes("Hello") || text.includes("Hi"));
  // End of central directory signature is present near the end.
  assert.ok(text.includes("PK\u0005\u0006") || zip.bytes[zip.bytes.length - 22] === 0x50);
  void buildZip;
});

test("renderer: new block types, visibility classes, focal point and decorative images", () => {
  const gallery = renderBlock({
    type: "gallery",
    items: [{ type: "img", src: "https://archive.org/download/i/a.webp", alt: "A" }],
  });
  assert.match(gallery, /an-gallery/);
  const sidebar = renderBlock({ type: "docs-sidebar", items: [{ type: "link", text: "Start", href: "arknetz://a.zine" }] });
  assert.match(sidebar, /an-docs-sidebar/);
  const hidden = renderBlock({ type: "p", text: "desktop only", visibleOn: ["desktop"] });
  assert.match(hidden, /an-hide-tablet/);
  assert.match(hidden, /an-hide-mobile/);
  assert.doesNotMatch(hidden, /an-hide-desktop/);
  const focal = renderBlock({
    type: "img",
    src: "https://archive.org/download/i/a.webp",
    alt: "A",
    focalPoint: { x: 20, y: 80 },
  });
  assert.match(focal, /object-position:20% 80%/);
  const decorative = renderBlock({
    type: "img",
    src: "https://archive.org/download/i/a.webp",
    alt: "ignored",
    decorative: true,
  });
  assert.match(decorative, /alt=""/);
  assert.match(decorative, /aria-hidden="true"/);
});
