// Tests: HTML importer — importHtml / importHtmlFromUrl.
// Fixtures are real HTML files under tests/fixtures/html-import/.
// The compiled tests run from dist/tests/, so fixtures are read
// through the source tree (../../tests/… from dist/tests/).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MAX_BLOCKS,
  importHtml,
  importHtmlFromUrl,
} from "../src/lib/html-import.js";
import { validateDocument } from "../src/lib/blocks.js";
import { renderSiteDocument } from "../src/lib/renderer.js";

function fixture(name: string): string {
  return readFileSync(
    new URL(`../../tests/fixtures/html-import/${name}`, import.meta.url),
    "utf8",
  );
}

test("blog post: title, hero, paragraphs, inline runs, quote, code, figure, link block", () => {
  const { doc, imported, skipped } = importHtml(fixture("blog-post.html"), {
    domain: "blog.zine",
  });
  assert.equal(doc.domain, "blog.zine");
  assert.equal(doc.title, "My First Post");
  assert.deepEqual(
    doc.blocks.map((b) => b.type),
    ["hero", "p", "p", "quote", "code", "img", "link"],
  );
  assert.equal(imported, 7);
  // The javascript: href is dropped and counted; its text survives.
  assert.equal(skipped, 1);
  assert.deepEqual(validateDocument(doc), []);
  const hero = doc.blocks[0]!;
  assert.equal(hero.type, "hero");
  assert.equal(hero.title, "Hello, ArkNetz");
  assert.equal(hero.subtitle, "Notes from the edge of the web.");
  // No duplicate h1: the first heading became the hero.
  assert.equal(doc.blocks.filter((b) => b.type === "h1").length, 0);

  const p1 = doc.blocks[1]!;
  assert.equal(p1.text, "This is a bold start, with italic asides and a link to the archive.");
  const bold = p1.runs?.find((r) => r.text === "bold");
  assert.equal(bold?.format?.bold, true);
  const italic = p1.runs?.find((r) => r.text === "italic");
  assert.equal(italic?.format?.italic, true);
  const linkRun = p1.runs?.find((r) => r.text === "link to the archive");
  assert.equal(linkRun?.format?.href, "https://archive.org/download/item/page");
  const codeRun = doc.blocks[2]?.runs?.find((r) => r.text === "inline code");
  assert.equal(codeRun?.format?.code, true);
  assert.match(doc.blocks[2]?.text ?? "", /evil link/);

  assert.equal(doc.blocks[3]?.type, "quote");
  assert.equal(doc.blocks[3]?.text, "Build the web you want to live in. — Stanley");
  assert.equal(doc.blocks[4]?.type, "code");
  assert.equal(doc.blocks[4]?.language, "ts");
  assert.equal(doc.blocks[4]?.text, "const x = 1;\nconst y = 2;");
  assert.equal(doc.blocks[5]?.type, "img");
  assert.equal(doc.blocks[5]?.src, "https://archive.org/download/item/photo.webp");
  assert.equal(doc.blocks[5]?.alt, "A sunset");
  assert.equal(doc.blocks[5]?.caption, "Sunset over the archive");
  assert.equal(doc.blocks[6]?.type, "link");
  assert.equal(doc.blocks[6]?.text, "About this site");
  assert.equal(doc.blocks[6]?.href, "arknetz://blog.zine/about");
});

test("docs page: docs sidebar, nested lists, ordered list, table, h4 downgraded to h3", () => {
  const { doc, imported, skipped, skippedByReason } = importHtml(fixture("docs-page.html"), {
    domain: "docs.zine",
  });
  assert.equal(doc.title, "Getting Started");
  assert.equal(doc.theme?.layout, "docs");
  assert.deepEqual(
    doc.blocks.map((b) => b.type),
    ["docs-sidebar", "hero", "h2", "list", "h2", "list", "h2", "table", "h3", "p"],
  );
  assert.equal(imported, 10);
  // The tracker link inside the sidebar nav is dropped and counted.
  assert.equal(skipped, 1);
  assert.equal(skippedByReason["unsafeLinkHref"], 1);

  const sidebar = doc.blocks[0]!;
  assert.equal(sidebar.type, "docs-sidebar");
  assert.deepEqual(
    (sidebar.items ?? []).map((i) => i.text),
    ["Getting started", "Installation"],
  );

  const list = doc.blocks[3]!;
  assert.equal(list.type, "list");
  assert.equal(list.listStyle, "ul");
  assert.equal(list.listItems?.length, 3);
  assert.equal(list.listItems?.[0]?.text, "Install the app");
  // The nested list survives as children of its parent item.
  const nested = list.listItems?.[0]?.children ?? [];
  assert.equal(nested.length, 2);
  assert.deepEqual(
    nested.map((i) => i.text),
    ["Download the package", "Run the installer"],
  );
  assert.equal(list.listItems?.[1]?.text, "Link an account");
  assert.equal(list.listItems?.[2]?.text, "Publish your first page");

  const ordered = doc.blocks[5]!;
  assert.equal(ordered.listStyle, "ol");
  assert.deepEqual(
    (ordered.listItems ?? []).map((i) => i.text),
    ["First do this", "Then do that"],
  );

  const table = doc.blocks[7]!;
  assert.equal(table.type, "table");
  assert.equal(table.headerRow, true);
  assert.equal(table.rows?.length, 3);
  assert.deepEqual(
    (table.rows ?? []).map((row) => row.map((c) => c.text)),
    [
      ["Plan", "Price", "Sites"],
      ["Free", "$0", "1"],
      ["Pro", "$5", "10"],
    ],
  );
  assert.equal(table.caption, "What each plan includes");

  assert.equal(doc.blocks[8]?.type, "h3");
  assert.equal(doc.blocks[8]?.text, "A small heading");
  assert.equal(doc.blocks[9]?.text, "Done.");

  // The emitted document is valid against the block whitelist, and
  // the native list/table blocks render through the shared renderer.
  assert.deepEqual(validateDocument(doc), []);
  const rendered = renderSiteDocument(doc);
  assert.match(rendered, /<ul class="an-list">/);
  assert.match(rendered, /<ol class="an-list">/);
  assert.match(rendered, /<table class="an-table">/);
  assert.match(rendered, /Download the package/);
  assert.match(rendered, /<th scope="col">Plan<\/th>/);
  assert.doesNotMatch(rendered, /unsupported block/);
  assert.doesNotMatch(rendered, /invalid (list|table) block/);
});

test("hostile page: scripts, styles, iframes, embeds, forms and event handlers are stripped and counted", () => {
  const { doc, imported, skipped, skippedByReason } = importHtml(fixture("hostile.html"), {
    domain: "hostile.zine",
  });
  assert.deepEqual(
    doc.blocks.map((b) => b.type),
    ["hero", "p", "p", "p"],
  );
  assert.equal(imported, 4);
  assert.equal(skippedByReason["script"], 1);
  assert.equal(skippedByReason["style"], 1);
  assert.equal(skippedByReason["iframe"], 1);
  assert.equal(skippedByReason["object"], 1);
  assert.equal(skippedByReason["embed"], 1);
  assert.equal(skippedByReason["form"], 1);
  assert.equal(skippedByReason["eventHandlerAttribute"], 2);
  assert.equal(skippedByReason["unsafeLinkHref"], 2);
  assert.equal(skippedByReason["unsafeImageSrc"], 1);
  assert.equal(skipped, 11);
  // Scripts are stripped, NOT wrapped into sandboxed app blocks
  // the way the WordPress importer wraps them.
  assert.equal(doc.blocks.filter((b) => b.type === "app").length, 0);
  assert.equal(doc.blocks[1]?.text, "A paragraph with event handlers.");
  assert.match(doc.blocks[2]?.text ?? "", /Click this javascript link and this tracker link\./);
  assert.equal(doc.blocks[3]?.text, "Safe text after all the hostile content.");

  // Nothing hostile survives into the rendered document either.
  const rendered = renderSiteDocument(doc);
  assert.doesNotMatch(rendered, /<script/);
  assert.doesNotMatch(rendered, /<iframe/);
  assert.doesNotMatch(rendered, /javascript:/);
  assert.doesNotMatch(rendered, /alert\(/);
  assert.doesNotMatch(rendered, /onclick/);
  assert.doesNotMatch(rendered, /evil\.example/);
  assert.doesNotMatch(rendered, /tracker\.example/);
});

test("image-heavy page: allow-listed hosts kept, tracker/missing/SVG-data images skipped and counted", () => {
  const { doc, imported, skipped, skippedByReason } = importHtml(fixture("image-heavy.html"), {
    domain: "gallery.zine",
  });
  assert.equal(imported, 6);
  assert.equal(skipped, 3);
  assert.equal(skippedByReason["unsafeImageSrc"], 2);
  assert.equal(skippedByReason["missingImageSrc"], 1);
  const imgs = doc.blocks.filter((b) => b.type === "img");
  assert.equal(imgs.length, 5);
  assert.deepEqual(
    imgs.map((i) => i.alt),
    ["One", "Two", "Three", "Tiny inline", "Five inside a paragraph"],
  );
  assert.equal(imgs[0]?.src, "https://archive.org/download/item/one.webp");
  assert.equal(imgs[1]?.src, "https://raw.githubusercontent.com/alice/site/main/two.png");
  assert.equal(imgs[2]?.src, "https://github.com/alice/site/blob/main/three.png");
  // A data: image is emitted with its real bytes (see the renderer
  // note on safeImageSrc: the renderer does not accept data: yet).
  assert.match(imgs[3]?.src ?? "", /^data:image\/png;base64,/);
  assert.equal(imgs[4]?.src, "https://archive.org/download/item/five.webp");
  assert.equal(doc.blocks.some((b) => (b.src ?? "").includes("tracker.example")), false);
  assert.equal(doc.blocks.some((b) => (b.src ?? "").includes("svg+xml")), false);
});

test("malformed HTML: unclosed tags degrade gracefully and never throw", () => {
  let result: ReturnType<typeof importHtml> | undefined;
  assert.doesNotThrow(() => {
    result = importHtml(fixture("malformed.html"), { domain: "broken.zine" });
  });
  const { doc, imported, skipped } = result!;
  assert.equal(doc.title, "Broken Page");
  assert.deepEqual(
    doc.blocks.map((b) => b.type),
    ["hero", "p", "p", "list", "table", "p"],
  );
  assert.equal(imported, 6);
  assert.equal(skipped, 0);
  assert.equal(doc.blocks[0]?.type, "hero");
  assert.equal(doc.blocks[0]?.title, "Unclosed Heading");
  assert.equal(doc.blocks[1]?.text, "First paragraph with bold that never closes");
  assert.equal(doc.blocks[1]?.runs?.find((r) => r.text === "bold that never closes")?.format?.bold, true);
  assert.equal(doc.blocks[2]?.text, "Second paragraph");
  const list = doc.blocks[3]!;
  assert.deepEqual(
    (list.listItems ?? []).map((i) => i.text),
    ["One", "Two", "Three"],
  );
  const table = doc.blocks[4]!;
  assert.equal(table.headerRow, true);
  assert.deepEqual(
    (table.rows ?? []).map((row) => row.map((c) => c.text)),
    [
      ["Name", "Value"],
      ["Alpha", "1"],
      ["Beta", "2"],
    ],
  );
  assert.equal(doc.blocks[5]?.text, "Trailing paragraph after stray closes");
  assert.deepEqual(validateDocument(doc), []);
});

test("garbage input never throws: stray angle brackets, lone tags, non-HTML", () => {
  for (const junk of ["<<<>>><<p", "<div><span><p>oops", "not html at all <> <", "<h1", "</p></div>"]) {
    const { doc, imported } = importHtml(junk, { domain: "junk.zine" });
    assert.equal(doc.domain, "junk.zine");
    assert.ok(doc.title.length > 0);
    assert.ok(imported >= 0);
  }
  // A bare "<h1" with no ">" is literal text, not a tag.
  const stray = importHtml("<h1", { domain: "junk.zine" });
  assert.equal(stray.doc.blocks.length, 1);
  assert.equal(stray.doc.blocks[0]?.text, "<h1");
  // Close tags with nothing open are ignored: no blocks at all.
  const { doc } = importHtml("</p></div>", { domain: "junk.zine" });
  assert.deepEqual(doc.blocks, []);
});

test("empty document: empty-but-valid, with a clear note", () => {
  const { doc, imported, skipped, notes } = importHtml(fixture("empty.html"), {
    domain: "empty.zine",
  });
  assert.deepEqual(doc.blocks, []);
  assert.equal(doc.domain, "empty.zine");
  assert.equal(doc.title, "Imported HTML");
  assert.equal(imported, 0);
  assert.equal(skipped, 0);
  assert.match(notes.join(" "), /empty/i);
  const ws = importHtml("   \n  ", { domain: "empty.zine" });
  assert.deepEqual(ws.doc.blocks, []);
  assert.match(ws.notes.join(" "), /empty/i);
  const onlyScript = importHtml("<script>alert(1)</script>", { domain: "empty.zine" });
  assert.deepEqual(onlyScript.doc.blocks, []);
  assert.equal(onlyScript.skipped, 1);
  assert.match(onlyScript.notes.join(" "), /No importable content/i);
});

test("block cap: large pages stop at maxBlocks with a plain-language note", () => {
  const html = Array.from({ length: 10 }, (_, i) => `<p>Paragraph ${i + 1}</p>`).join("");
  const { doc, imported, skipped, skippedByReason, notes } = importHtml(html, {
    domain: "long.zine",
    maxBlocks: 3,
  });
  assert.equal(imported, 3);
  assert.equal(doc.blocks.length, 3);
  assert.equal(skippedByReason["truncatedBlocks"], 7);
  assert.equal(skipped, 7);
  assert.match(notes.join(" "), /Stopped after 3 blocks/);
  assert.match(notes.join(" "), /7 blocks? were left out/);
  assert.equal(DEFAULT_MAX_BLOCKS, 500);
  const uncapped = importHtml(html, { domain: "long.zine" });
  assert.equal(uncapped.imported, 10);
  assert.equal(uncapped.skipped, 0);
});

test("hero option: hero:false keeps every h1 as an h1 block", () => {
  const withHero = importHtml("<h1>First</h1><h1>Second</h1>", { domain: "h.zine" });
  assert.deepEqual(
    withHero.doc.blocks.map((b) => b.type),
    ["hero", "h1"],
  );
  assert.equal(withHero.doc.blocks[0]?.title, "First");
  const noHero = importHtml("<h1>First</h1><h1>Second</h1>", { domain: "h.zine", hero: false });
  assert.deepEqual(
    noHero.doc.blocks.map((b) => b.type),
    ["h1", "h1"],
  );
  assert.equal(noHero.doc.title, "First");
});

test("relative URLs resolve against baseUrl, and are unsafe without one", () => {
  const html = `<p><a href="/about">About</a></p><img src="/pic.webp" alt="Pic">`;
  const withBase = importHtml(html, {
    domain: "rel.zine",
    baseUrl: "https://archive.org/download/item/page",
  });
  assert.equal(withBase.doc.blocks[0]?.type, "link");
  assert.equal(withBase.doc.blocks[0]?.href, "https://archive.org/about");
  assert.equal(withBase.doc.blocks[1]?.type, "img");
  assert.equal(withBase.doc.blocks[1]?.src, "https://archive.org/pic.webp");
  assert.equal(withBase.skipped, 0);

  const noBase = importHtml(html, { domain: "rel.zine" });
  assert.equal(noBase.doc.blocks[0]?.type, "p");
  assert.equal(noBase.doc.blocks[0]?.text, "About");
  assert.equal(noBase.doc.blocks.length, 1);
  assert.equal(noBase.skippedByReason["unsafeLinkHref"], 1);
  assert.equal(noBase.skippedByReason["unsafeImageSrc"], 1);
});

test("video and audio: first safe source wins, poster kept, unsafe sources counted", () => {
  const { doc, skipped, skippedByReason } = importHtml(
    `<video poster="https://archive.org/download/item/poster.webp"><source src="https://archive.org/download/item/clip.mp4"></video>` +
      `<audio src="https://archive.org/download/item/song.mp3"></audio>` +
      `<video src="http://archive.org/download/item/old.mp4"></video>`,
    { domain: "media.zine" },
  );
  assert.deepEqual(
    doc.blocks.map((b) => b.type),
    ["video", "audio"],
  );
  assert.equal(doc.blocks[0]?.src, "https://archive.org/download/item/clip.mp4");
  assert.equal(doc.blocks[0]?.poster, "https://archive.org/download/item/poster.webp");
  assert.equal(doc.blocks[1]?.src, "https://archive.org/download/item/song.mp3");
  assert.equal(skipped, 1);
  assert.equal(skippedByReason["unsafeMediaSrc"], 1);
});

test("full-page fixture round-trips import → render via the shared renderer", () => {
  const { doc, imported, skipped } = importHtml(fixture("full-page.html"), {
    domain: "roundtrip.zine",
  });
  assert.equal(imported, 6);
  assert.equal(skipped, 0);
  const html = renderSiteDocument(doc);
  assert.match(html, /Round Trip/);
  assert.match(html, /Opening paragraph/);
  assert.match(html, /Quoted words travel well/);
  // The renderer escapes quotes in code text (&quot;).
  assert.match(html, /console\.log/);
  assert.match(html, /hello/);
  assert.match(html, /hero\.webp/);
  assert.match(html, /safe archive link/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /unsupported block/);
});

test("importHtmlFromUrl: injected fetch is used, never the network", async () => {
  const blog = fixture("blog-post.html");
  const ok = await importHtmlFromUrl("https://example.com/post", {
    domain: "fetched.zine",
    fetchFn: async () => ({ ok: true, status: 200, text: async () => blog }),
  });
  assert.equal(ok.doc.title, "My First Post");
  assert.equal(ok.imported, 7);
  assert.equal(ok.sourceUrl, "https://example.com/post");
  // Relative URLs in the fetched page resolve against the page URL.
  const rel = await importHtmlFromUrl("https://archive.org/download/item/page", {
    domain: "fetched.zine",
    fetchFn: async () => '<p><a href="/about">About</a></p>',
  });
  assert.equal(rel.doc.blocks[0]?.type, "link");
  assert.equal(rel.doc.blocks[0]?.href, "https://archive.org/about");

  const notFound = await importHtmlFromUrl("https://example.com/missing", {
    domain: "fetched.zine",
    fetchFn: async () => ({ ok: false, status: 404, text: async () => "" }),
  });
  assert.equal(notFound.imported, 0);
  assert.deepEqual(notFound.doc.blocks, []);
  assert.match(notFound.notes.join(" "), /404/);

  const noFetch = await importHtmlFromUrl("https://example.com/post", {
    domain: "fetched.zine",
  });
  assert.equal(noFetch.imported, 0);
  assert.match(noFetch.notes.join(" "), /No fetch function was provided/);

  const throwing = await importHtmlFromUrl("https://example.com/post", {
    domain: "fetched.zine",
    fetchFn: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(throwing.imported, 0);
  assert.match(throwing.notes.join(" "), /network down/);
});
