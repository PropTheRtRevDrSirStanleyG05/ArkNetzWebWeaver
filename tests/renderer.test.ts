// Tests: shared block renderer — the one renderer builder + reader share.
import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, installArknetzLinkInterceptor, isArknetzUrl, isSafeUrl, READER_CSS, renderBlock, renderSiteDocument } from "../src/lib/renderer.js";
import type { ArknetzLinkRoot } from "../src/lib/renderer.js";

test("escapeHtml neutralises script injection", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(renderBlock({ type: "p", text: "<img src=x onerror=alert(1)>" }), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
});

test("basic blocks render as semantic HTML", () => {
  assert.equal(renderBlock({ type: "h1", text: "Hello" }), "<h1>Hello</h1>");
  assert.equal(renderBlock({ type: "quote", text: "q" }), "<blockquote>q</blockquote>");
  assert.match(renderBlock({ type: "code", language: "ts", text: "const x=1" }), /<pre><code data-language="ts">/);
});

test("img/video/audio accept IA hotlinks and reject tracker / non-https URLs", () => {
  const ia = "https://archive.org/download/item/photo.webp";
  assert.match(renderBlock({ type: "img", src: ia, alt: "Sunset" }), /<img src="https:\/\/archive\.org\/download\/item\/photo\.webp"/);
  assert.match(renderBlock({ type: "img", src: "https://tracker.example/x.png" }), /blocked: unsafe source/);
  assert.match(renderBlock({ type: "video", src: "http://archive.org/download/item/v.mp4" }), /blocked: unsafe source/);
  assert.match(renderBlock({ type: "audio", src: ia }), /<audio/);
});

test("isSafeUrl allows arknetz: deep links and IA/raw hosts, nothing else", () => {
  assert.equal(isSafeUrl("arknetz://computers.edu"), true);
  assert.equal(isSafeUrl("https://raw.githubusercontent.com/a/b/main/site.json"), true);
  assert.equal(isSafeUrl("https://evil.example/x"), false);
  assert.equal(isSafeUrl("javascript:alert(1)"), false);
});

test("app blocks render only as a sandboxed iframe, never inline HTML", () => {
  const html = renderBlock({ type: "app", appSrcdoc: "<script>alert(1)</script>" });
  assert.match(html, /<iframe[^>]*sandbox="allow-scripts allow-pointer-lock"/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(renderBlock({ type: "app" }), /blocked: no safe source/);
});

test("cols and cards nest blocks", () => {
  const html = renderBlock({
    type: "cols",
    columns: [[{ type: "p", text: "left" }], [{ type: "p", text: "right" }]],
  });
  assert.match(html, /<div class="an-cols">/);
  assert.match(html, /left/);
  assert.match(html, /right/);
});

test("unknown block types render as a visible placeholder, never raw", () => {
  const html = renderBlock({ type: "mystery" as never, text: "<b>x</b>" });
  assert.match(html, /unsupported block: mystery/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test("renderSiteDocument includes title, nav, theme accent, and blocks", () => {
  const html = renderSiteDocument({
    domain: "a.zine",
    title: "My Zine",
    theme: { accent: "#ff0000" },
    nav: [{ label: "Home", href: "arknetz://a.zine" }],
    blocks: [{ type: "p", text: "Hello" }],
  });
  assert.match(html, /My Zine/);
  assert.match(html, /--an-accent:#ff0000/);
  assert.match(html, /<p>Hello<\/p>/);
  assert.match(html, /data-domain="a\.zine"/);
});

// T1 regression (2026-11-20): clicking an in-site nav link used to
// navigate the whole WebView top-level to arknetz://…, which WebKitGTK
// cannot load — the entire app UI was replaced by "The URL can't be
// shown" and only a relaunch recovered. arknetz:// anchors are marked
// and intercepted in the shell; the Rust on_navigation guard is the
// second line of defence.
test("renderer: arknetz:// anchors are marked data-arknetz-link, https ones are not", () => {
  const site = renderSiteDocument({
    domain: "welcome.arknetz",
    title: "Welcome",
    nav: [{ label: "Home", href: "arknetz://welcome.arknetz" }],
    blocks: [],
  });
  assert.match(site, /<a href="arknetz:\/\/welcome\.arknetz" data-arknetz-link="true">Home<\/a>/);
  const nav = renderBlock({ type: "nav", items: [{ type: "link", text: "About", href: "arknetz://welcome.arknetz/about" }] });
  assert.match(nav, /data-arknetz-link="true"/);
  const docs = renderBlock({ type: "docs-sidebar", items: [{ type: "link", text: "About", href: "arknetz://welcome.arknetz/about" }] });
  assert.match(docs, /data-arknetz-link="true"/);
  const link = renderBlock({ type: "link", href: "arknetz://welcome.arknetz/about", text: "About" });
  assert.match(link, /data-arknetz-link="true"/);
  const external = renderBlock({ type: "link", href: "https://archive.org/download/item/x", text: "IA" });
  assert.doesNotMatch(external, /data-arknetz-link/);
  assert.equal(isArknetzUrl("arknetz://welcome.arknetz/about"), true);
  assert.equal(isArknetzUrl("https://archive.org/download/item/x"), false);
  assert.equal(isArknetzUrl(null), false);
  assert.equal(isArknetzUrl(undefined), false);
});

test("renderer: installArknetzLinkInterceptor routes arknetz clicks internally, opens https: externally, leaves the rest alone", () => {
  const listeners = new Map<string, (e: MouseEvent) => void>();
  const root = {
    addEventListener: (type: string, fn: (e: MouseEvent) => void) => { listeners.set(type, fn); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  } as unknown as ArknetzLinkRoot;
  const navigated: string[] = [];
  const opened: string[] = [];
  const uninstall = installArknetzLinkInterceptor(root, (href) => { navigated.push(href); }, {
    openExternal: (href) => { opened.push(href); },
  });

  const clickOn = (href: string | null) => {
    let prevented = false;
    const anchor = href === null ? null : { getAttribute: (name: string) => (name === "href" ? href : null) };
    const event = {
      button: 0,
      target: { closest: () => anchor },
      preventDefault: () => { prevented = true; },
    } as unknown as MouseEvent;
    listeners.get("click")?.(event);
    return prevented;
  };

  assert.equal(clickOn("arknetz://welcome.arknetz/about"), true);
  assert.deepEqual(navigated, ["arknetz://welcome.arknetz/about"]);
  assert.deepEqual(opened, []);
  // 5a: an https: click is preventDefaulted and opened externally —
  // it must never top-level-navigate the app WebView away to the
  // external site (the T1 failure mode, for https:). arknetz:// stays
  // internal; mailto: and non-links are untouched.
  assert.equal(clickOn("https://archive.org/download/item/x"), true);
  assert.deepEqual(opened, ["https://archive.org/download/item/x"]);
  assert.deepEqual(navigated, ["arknetz://welcome.arknetz/about"]);
  assert.equal(clickOn("mailto:alice@computers.edu"), false);
  assert.equal(clickOn(null), false);
  assert.deepEqual(navigated, ["arknetz://welcome.arknetz/about"]);
  assert.deepEqual(opened, ["https://archive.org/download/item/x"]);
  // Middle-click is not intercepted.
  let prevented = false;
  const mid = {
    button: 1,
    target: { closest: () => ({ getAttribute: () => "arknetz://welcome.arknetz/about" }) },
    preventDefault: () => { prevented = true; },
  } as unknown as MouseEvent;
  listeners.get("click")?.(mid);
  assert.equal(prevented, false);
  assert.deepEqual(navigated, ["arknetz://welcome.arknetz/about"]);

  uninstall();
  assert.equal(listeners.has("click"), false);
});

// P7: an image block with no source must explain itself in plain
// language — "[image blocked: unsafe source]" with no reason was the
// whole message a user saw. A present-but-unsafe src still says so.
test("renderer: img with no source explains how to attach it; unsafe src still blocked", () => {
  const empty = renderBlock({ type: "img" });
  assert.match(empty, /Image not attached yet/);
  assert.match(empty, /attach a file/);
  assert.match(empty, /Internet Archive/);
  assert.doesNotMatch(empty, /\[image blocked/);
  assert.match(renderBlock({ type: "img", src: "" }), /Image not attached yet/);
  assert.match(renderBlock({ type: "img", src: "https://tracker.example/x.png" }), /blocked: unsafe source/);
});

// B7: reader code blocks scroll internally (overflow + max-width) so a
// long unbroken line cannot widen the page at 390px.
test("renderer: READER_CSS keeps pre blocks inside the reader width", () => {
  assert.match(READER_CSS, /pre\{[^}]*overflow:auto/);
  assert.match(READER_CSS, /pre\{[^}]*max-width:100%/);
});

// R3: at 390px the reader H1 ("Welcome to ArkNetzWebWeaver") broke
// mid-word with a dangling "r". Headings get an explicit break-word
// rule, and the H1 scales down below 480px so the whole word fits
// instead of breaking at the container edge.
test("renderer: READER_CSS scales the H1 down below 480px and gives headings break-word", () => {
  assert.match(READER_CSS, /\.an-site h1,\.an-site h2,\.an-site h3\{overflow-wrap:break-word\}/);
  assert.match(READER_CSS, /@media \(max-width:480px\)\{[\s\S]*?\.an-site h1\{font-size:1\.6rem\}/);
});
