// ArkNetzWebWeaver — WordPress WXR import (builder phase).
// One-click import: a .xml export from WordPress is parsed in-browser
// and mapped to semantic blocks. Content carries over, code does not:
// PHP themes/plugins never carry over (same as EmDash), <script> and
// custom HTML widgets are wrapped into sandboxed ["app", ...] blocks
// instead of being discarded. Media URLs are kept as-is for now and
// re-pointed at IA hotlinks by the media migration step (the editor
// re-uploads them through the stealth IA module on Publish).
//
// The parser is a small hand-rolled XML reader for the WXR subset
// (rss > channel > item), not a dependency: it works in Node (tests)
// and in the browser, where DOMParser would also work. It handles
// CDATA, entities, and namespaced tags (content:encoded, wp:post_type).

import { newBlockId } from "./blocks.js";
import type { BlockNode, SiteDocument } from "./types.js";

export interface WxrPost {
  title: string;
  slug: string;
  type: string; // "post" | "page" | "attachment" | ...
  status: string;
  content: string; // raw HTML from content:encoded
  categories: string[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTag(xml: string, tag: string): string {
  // Matches <tag>…</tag> and <tag><![CDATA[…]]></tag>, case-insensitive.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  let body = m[1] as string;
  const cdata = body.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) body = cdata[1] as string;
  return decodeEntities(body.trim());
}

function extractAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    let body = m[1] as string;
    const cdata = body.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdata) body = cdata[1] as string;
    out.push(decodeEntities(body.trim()));
  }
  return out;
}

/** Parse a WXR file into posts/pages. Attachments and drafts are kept
 *  in the list but flagged by type/status so the caller can skip them. */
export function parseWxr(xml: string): WxrPost[] {
  const posts: WxrPost[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  for (const m of xml.matchAll(itemRe)) {
    const item = m[1] as string;
    posts.push({
      title: extractTag(item, "title"),
      slug: extractTag(item, "wp:post_name") || extractTag(item, "link").split("/").filter(Boolean).pop() || "post",
      type: extractTag(item, "wp:post_type") || "post",
      status: extractTag(item, "wp:status") || "publish",
      content: extractTag(item, "content:encoded"),
      categories: extractAllTags(item, "category"),
    });
  }
  return posts;
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Map one post's HTML to semantic blocks. Unknown tags become
 *  paragraphs; <script> and <iframe> become sandboxed app blocks. */
export function htmlToBlocks(html: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  // Split on block-level tags, keeping them.
  const re = /<(h1|h2|h3|p|blockquote|pre|ul|ol|img|figure|video|audio|script|iframe|div)[^>]*>([\s\S]*?)<\/\1>|<(img|hr)[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  const pushText = (raw: string) => {
    const text = stripTags(raw);
    if (text) blocks.push({ type: "p", text, id: newBlockId() });
  };
  while ((m = re.exec(html)) !== null) {
    if (m.index > lastEnd) pushText(html.slice(lastEnd, m.index));
    const tag = (m[1] ?? m[3] ?? "").toLowerCase();
    const inner = m[2] ?? "";
    const whole = m[0] as string;
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
        blocks.push({ type: tag, text: stripTags(inner), id: newBlockId() });
        break;
      case "blockquote":
        blocks.push({ type: "quote", text: stripTags(inner), id: newBlockId() });
        break;
      case "pre": {
        const lang = whole.match(/language-([a-z0-9]+)/i)?.[1];
        blocks.push({ type: "code", language: lang ?? "text", text: stripTags(inner), id: newBlockId() });
        break;
      }
      case "ul":
      case "ol":
        for (const li of inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
          blocks.push({ type: "p", text: `• ${stripTags(li[1] as string)}`, id: newBlockId() });
        }
        break;
      case "img": {
        const src = whole.match(/src="([^"]+)"/)?.[1] ?? "";
        const alt = whole.match(/alt="([^"]*)"/)?.[1] ?? "";
        if (src) blocks.push({ type: "img", src, alt, id: newBlockId() });
        break;
      }
      case "figure": {
        const src = inner.match(/src="([^"]+)"/)?.[1] ?? "";
        const alt = inner.match(/alt="([^"]*)"/)?.[1] ?? "";
        const caption = stripTags(inner.replace(/<img[^>]*>/gi, ""));
        if (src) blocks.push({ type: "img", src, alt, caption: caption || undefined, id: newBlockId() });
        break;
      }
      case "video":
      case "audio": {
        const src = inner.match(/src="([^"]+)"/)?.[1] ?? whole.match(/src="([^"]+)"/)?.[1] ?? "";
        if (src) blocks.push({ type: tag, src, id: newBlockId() });
        break;
      }
      case "script":
      case "iframe":
        // Scripts / embeds are wrapped, never executed and never dropped.
        blocks.push({ type: "app", appSrcdoc: inner.trim().slice(0, 150 * 1024), id: newBlockId() });
        break;
      case "hr":
        break;
      default:
        pushText(inner);
        break;
    }
    lastEnd = re.lastIndex;
  }
  if (lastEnd < html.length) pushText(html.slice(lastEnd));
  return blocks;
}

/** Import a whole WXR file into a SiteDocument. Only published posts
 *  and pages are imported; attachments, drafts and revisions are
 *  skipped and counted in the report. */
export function importWxr(xml: string, domain: string): { doc: SiteDocument; imported: number; skipped: number } {
  const posts = parseWxr(xml);
  const blocks: BlockNode[] = [];
  let imported = 0;
  let skipped = 0;
  for (const post of posts) {
    if (post.type === "attachment" || post.status !== "publish") {
      skipped += 1;
      continue;
    }
    imported += 1;
    if (post.title) blocks.push({ type: "h1", text: post.title, id: newBlockId() });
    blocks.push(...htmlToBlocks(post.content));
  }
  return {
    doc: {
      domain,
      title: `Imported from WordPress (${imported} post${imported === 1 ? "" : "s"})`,
      theme: { layout: "blog", accent: "#2563eb", font: "system-ui" },
      nav: [{ label: "Home", href: `arknetz://${domain}` }],
      blocks,
    },
    imported,
    skipped,
  };
}
