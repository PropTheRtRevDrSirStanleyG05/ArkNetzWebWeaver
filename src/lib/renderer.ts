// ArkNetzWebWeaver — shared block renderer (reader + builder share this).
// This is the ONE renderer. The visual builder (next phase) must call
// renderBlock / renderSiteDocument from this module and never write its
// own renderer — that is how editor and reader stay identical (thread
// turn 19: "same TypeScript block renderer for editor and reader").
// Output is standard HTML5 + CSS3: semantic elements, CSS Custom
// Properties for the theme, no inline scripts, no raw HTML from blocks.
// Every text value is escaped; every URL is allow-listed to https: IA /
// raw.githubusercontent.com / the site's own domain, or arknetz: deep
// links. Unknown block types render as a visible placeholder, never as
// raw content and never silently dropped.

import type { BlockNode, SiteDocument } from "./types.js";
import { escapeHtml, isSafeUrl, renderInlineRuns } from "./inline.js";
import { plainText } from "./inline.js";
import { injectAppBridgeShim } from "./viewer/app-bridge.js";

export { escapeHtml, isSafeUrl };

/** True for an arknetz:// deep link — the app's own scheme, which must
 *  NEVER be loaded top-level in the WebView (WebKitGTK cannot load it
 *  and the whole app UI is replaced by an error page; T1, 2026-11-20).
 *  Such links are intercepted by installArknetzLinkInterceptor and
 *  routed through the shell's internal navigation instead. */
export function isArknetzUrl(href: string | null | undefined): href is string {
  return typeof href === "string" && href.startsWith("arknetz://");
}

/** Marker attribute for arknetz:// anchors, so the shell's delegated
 *  click handler (and a visual QA pass) can tell an internal link from
 *  an external one without parsing hrefs. Inline-run links
 *  (src/lib/inline.ts, not touched here) carry no marker — the handler
 *  matches on the href prefix, so they are intercepted too. */
function arknetzLinkAttrs(href: string): string {
  return isArknetzUrl(href) ? ` data-arknetz-link="true"` : "";
}

/** Minimal click-root shape: a real HTMLElement / Document satisfies
 *  it, and tests can pass a mock that records the listener. */
export interface ArknetzLinkRoot {
  addEventListener(type: "click", listener: (event: MouseEvent) => void): void;
  removeEventListener(type: "click", listener: (event: MouseEvent) => void): void;
}

/** True for an http(s):// link — an external web page, never an
 *  ArkNetz site. Clicking one must never top-level-navigate the app
 *  WebView away to it (5a, 2026-11-20: that destroyed the app UI just
 *  like an arknetz:// click did under T1); it opens externally. */
export function isExternalWebUrl(href: string | null | undefined): href is string {
  return typeof href === "string" && (href.startsWith("https://") || href.startsWith("http://"));
}

/** Options for the link interceptor. */
export interface ArknetzLinkInterceptorOptions {
  /** Where https:/http: clicks go. Defaults to window.open(href,
   *  "_blank", "noopener") — the same external-open idiom the OAuth
   *  sign-in and Save Page Now flows already use — when a window
   *  exists; tests inject a stub. */
  openExternal?: (href: string) => void;
}

/** Delegated interception for arknetz:// links (T1). Attach once to a
 *  container that outlives its content — the shell attaches it to the
 *  whole document, so it covers the reader, the editor preview, the
 *  docs sidebar, series grids and link blocks wherever they render.
 *  A click on an arknetz:// anchor never reaches the WebView as a
 *  top-level navigation: preventDefault() stops the load and `navigate`
 *  routes it through the registry resolver like a typed address.
 *  A click on an https:/http: anchor is likewise preventDefaulted and
 *  handed to `openExternal` instead of top-level-navigating the app
 *  WebView away to the external site (5a). Other links (mailto:, …)
 *  are left completely alone.
 *  Returns an uninstall function. */
export function installArknetzLinkInterceptor(
  root: ArknetzLinkRoot,
  navigate: (href: string) => void,
  options?: ArknetzLinkInterceptorOptions,
): () => void {
  const openExternal = options?.openExternal ?? ((href: string): void => {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(href, "_blank", "noopener");
    }
  });
  const onClick = (event: MouseEvent): void => {
    if (typeof event.button === "number" && event.button !== 0) return;
    const target = event.target as unknown as {
      closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null;
    } | null;
    const anchor = target?.closest?.("a[href]") ?? null;
    const href = anchor?.getAttribute("href") ?? null;
    if (isArknetzUrl(href)) {
      event.preventDefault();
      navigate(href);
      return;
    }
    if (isExternalWebUrl(href)) {
      event.preventDefault();
      openExternal(href);
    }
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

/** Options for rendering. `appBridgeToken` / `appBridgeTokens` carry the
 *  per-iframe save-bridge session id(s) issued by an AppSaveBridge
 *  (src/lib/viewer/app-bridge.ts) for this site's domain. When present,
 *  an ["app", ...] srcdoc gets the bridge shim + CSP meta injected; when
 *  absent the app renders exactly as before, with no save API — the
 *  renderer never invents a session id, because only the bridge (which
 *  owns the store and the session registry) may issue one. Tokens are
 *  looked up by block id first, then the single-token fallback. */
export interface RenderOptions {
  appBridgeToken?: string;
  appBridgeTokens?: ReadonlyMap<string, string>;
}

function appBridgeTokenFor(block: BlockNode, options?: RenderOptions): string | undefined {
  if (!options) return undefined;
  if (block.id && options.appBridgeTokens?.has(block.id)) return options.appBridgeTokens.get(block.id);
  return options.appBridgeToken;
}

/** Render a block's text field: inline runs when the block carries
 *  formatting, plain escaped text otherwise. */
function renderText(block: BlockNode): string {
  if (block.runs && block.runs.length > 0) return renderInlineRuns(block.runs);
  return escapeHtml(block.text ?? "");
}

/** Plain text of a block (runs or text), for diffs and summaries. */
export function blockPlainText(block: BlockNode): string {
  return block.runs && block.runs.length > 0 ? plainText(block.runs) : (block.text ?? "");
}

function safeSrc(src: string | undefined): string | null {
  if (!src) return null;
  return isSafeUrl(src) ? src : null;
}

export function visibilityClasses(block: BlockNode): string {
  const v = block.visibleOn;
  if (!v || v.length === 3) return "";
  const hidden: string[] = [];
  if (!v.includes("desktop")) hidden.push("an-hide-desktop");
  if (!v.includes("tablet")) hidden.push("an-hide-tablet");
  if (!v.includes("mobile")) hidden.push("an-hide-mobile");
  return hidden.join(" ");
}

/** The shared renderer: editor and reader both call this, never a fork. */
export function renderBlock(block: BlockNode, options?: RenderOptions): string {
  const html = renderBlockInner(block, options);
  const cls = visibilityClasses(block);
  return cls ? `<div class="${cls}">${html}</div>` : html;
}

function renderBlockInner(block: BlockNode, options?: RenderOptions): string {
  switch (block.type) {
    case "h1":
      return `<h1>${renderText(block)}</h1>`;
    case "h2":
      return `<h2>${renderText(block)}</h2>`;
    case "h3":
      return `<h3>${renderText(block)}</h3>`;
    case "p":
      return `<p>${renderText(block)}</p>`;
    case "quote":
      return `<blockquote>${renderText(block)}</blockquote>`;
    case "code":
      return `<pre><code${block.language ? ` data-language="${escapeHtml(block.language)}"` : ""}>${escapeHtml(block.text ?? "")}</code></pre>`;
    case "link": {
      const href = safeSrc(block.href) ?? "#";
      return `<p><a href="${escapeHtml(href)}"${arknetzLinkAttrs(href)} rel="noopener">${renderText(block) || escapeHtml(block.href ?? "")}</a></p>`;
    }
    case "hero":
      return `<section class="an-hero"><h1>${escapeHtml(block.title ?? block.text ?? "")}</h1>${block.subtitle ? `<p class="an-subtitle">${escapeHtml(block.subtitle)}</p>` : ""}</section>`;
    case "nav": {
      const items = (block.items ?? [])
        .map((i) => {
          const href = safeSrc(i.href) ?? "#";
          return `<a href="${escapeHtml(href)}"${arknetzLinkAttrs(href)}>${escapeHtml(i.text ?? "")}</a>`;
        })
        .join("");
      return `<nav class="an-nav">${items}</nav>`;
    }
    case "cols": {
      const cols = (block.columns ?? [])
        .map((col) => `<div class="an-col">${col.map((b) => renderBlock(b, options)).join("")}</div>`)
        .join("");
      return `<div class="an-cols">${cols}</div>`;
    }
    case "cards": {
      const cards = (block.items ?? [])
        .map((i) => `<article class="an-card">${renderBlock(i, options)}</article>`)
        .join("");
      return `<div class="an-cards">${cards}</div>`;
    }
    case "series-grid": {
      const items = (block.items ?? [])
        .map((i) => `<article class="an-card">${renderBlock(i, options)}</article>`)
        .join("");
      return `<section class="an-series"><h2>${escapeHtml(block.title ?? "Series")}</h2><div class="an-cards">${items}</div></section>`;
    }
    case "img": {
      // No source at all: plain language, not a bare "[blocked]". The
      // block is empty because nothing was attached yet — the fix is to
      // attach a file or link an IA account, and the message says so.
      if (!block.src) {
        return `<p class="an-blocked">Image not attached yet — attach a file, or link an Internet Archive account in Settings so it can be uploaded stealthily and embedded as a hotlink.</p>`;
      }
      const src = safeSrc(block.src);
      if (!src) return `<p class="an-blocked">[image blocked: unsafe source]</p>`;
      const focal = block.focalPoint
        ? ` style="object-position:${block.focalPoint.x}% ${block.focalPoint.y}%"`
        : "";
      const alt = block.decorative ? "" : (block.alt ?? "");
      const caption = block.caption ?? (block.decorative ? "" : (block.alt ?? ""));
      const aria = block.decorative ? ` aria-hidden="true"` : "";
      return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"${focal}${aria}>${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
    }
    case "video": {
      const src = safeSrc(block.src);
      if (!src) return `<p class="an-blocked">[video blocked: unsafe source]</p>`;
      const poster = safeSrc(block.poster);
      return `<video src="${escapeHtml(src)}" controls preload="metadata"${poster ? ` poster="${escapeHtml(poster)}"` : ""}></video>`;
    }
    case "docs-sidebar": {
      const items = (block.items ?? [])
        .map((i) => {
          const href = safeSrc(i.href) ?? "#";
          return `<li><a href="${escapeHtml(href)}"${arknetzLinkAttrs(href)}>${escapeHtml(i.text ?? "")}</a></li>`;
        })
        .join("");
      return `<aside class="an-docs-sidebar"><ul>${items}</ul></aside>`;
    }
    case "gallery": {
      const items = (block.items ?? [])
        .map((i) => renderBlockInner(i, options))
        .join("");
      return `<div class="an-gallery">${items}</div>`;
    }
    case "audio": {
      const src = safeSrc(block.src);
      if (!src) return `<p class="an-blocked">[audio blocked: unsafe source]</p>`;
      return `<audio src="${escapeHtml(src)}" controls preload="metadata"></audio>`;
    }
    case "app": {
      // Sandboxed HTML app/game, thread turn 15: NEVER injected into the
      // main DOM. Sandboxed iframe only, no top navigation, no popups.
      // Cap ~150 KB is enforced at publish time (builder phase), not here.
      // Save bridge (PROTOCOL.md §7, src/lib/viewer/app-bridge.ts): when
      // the caller passed a per-iframe session id, the shim + CSP meta
      // are injected into the srcdoc so the app gets window.ArkNetzSave
      // (save/load/delete/list via postMessage only). Without a session
      // id there is no shim and no save API. URL-sourced apps (appSrc)
      // never get a shim — the bridge serves srcdoc iframes only, whose
      // origin is the opaque "null" the bridge authenticates against.
      if (block.appSrcdoc) {
        const token = appBridgeTokenFor(block, options);
        const srcdoc = token ? injectAppBridgeShim(block.appSrcdoc, token) : block.appSrcdoc;
        return `<iframe class="an-app" sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer" srcdoc="${escapeHtml(srcdoc)}"></iframe>`;
      }
      const src = safeSrc(block.appSrc);
      if (!src) return `<p class="an-blocked">[app blocked: no safe source]</p>`;
      return `<iframe class="an-app" sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer" src="${escapeHtml(src)}"></iframe>`;
    }
    default:
      return `<p class="an-unknown">[unsupported block: ${escapeHtml((block as BlockNode).type)}]</p>`;
  }
}

export const READER_CSS = `
:root{--an-accent:#2563eb;--an-fg:#111827;--an-bg:#ffffff;--an-muted:#6b7280}
.an-site{max-width:720px;margin:0 auto;padding:1.5rem;font-family:system-ui,sans-serif;color:var(--an-fg);background:var(--an-bg);line-height:1.6}
.an-site h1{font-size:2rem;line-height:1.2}.an-site h2{font-size:1.5rem}.an-site h3{font-size:1.25rem}
.an-site h1,.an-site h2,.an-site h3{overflow-wrap:break-word}
.an-hero{padding:2rem 0;border-bottom:1px solid #e5e7eb;margin-bottom:1rem}
.an-subtitle{color:var(--an-muted);font-size:1.125rem}
.an-nav{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
.an-nav a{color:var(--an-accent);text-decoration:none}
.an-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem}
.an-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem}
.an-card{border:1px solid #e5e7eb;border-radius:8px;padding:1rem}
.an-site img{max-width:100%;height:auto;border-radius:8px}
.an-site video,.an-site audio{max-width:100%}
.an-app{width:100%;min-height:320px;border:1px solid #e5e7eb;border-radius:8px}
.an-blocked,.an-unknown{color:var(--an-muted);font-style:italic}
.an-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.75rem}
.an-gallery figure{margin:0}
.an-docs-sidebar{border-right:1px solid #e5e7eb;padding-right:1rem}
.an-docs-sidebar ul{list-style:none;padding:0;margin:0}
@media (max-width:480px){.an-hide-mobile{display:none}.an-site h1{font-size:1.6rem}}
@media (min-width:481px) and (max-width:900px){.an-hide-tablet{display:none}}
@media (min-width:901px){.an-hide-desktop{display:none}}
blockquote{border-left:3px solid var(--an-accent);margin:1rem 0;padding-left:1rem;color:var(--an-muted)}
pre{background:#f3f4f6;padding:1rem;border-radius:8px;overflow:auto;max-width:100%;box-sizing:border-box}
.an-site pre code{white-space:pre}
.an-site{min-width:0;overflow-wrap:break-word}
`;

export function renderSiteDocument(site: SiteDocument, options?: RenderOptions): string {
  const accent = site.theme?.accent ?? "#2563eb";
  const header = (site.header ?? []).map((b) => renderBlock(b, options)).join("\n");
  const footer = (site.footer ?? []).map((b) => renderBlock(b, options)).join("\n");
  const nav = (site.nav ?? [])
    .map((n) => {
      const href = isSafeUrl(n.href) ? n.href : "#";
      return `<a href="${escapeHtml(href)}"${arknetzLinkAttrs(href)}>${escapeHtml(n.label)}</a>`;
    })
    .join("");
  const body = site.blocks.map((b) => renderBlock(b, options)).join("\n");
  const css = READER_CSS.replace("#2563eb", accent);
  return `<article class="an-site" style="--an-accent:${escapeHtml(accent)}" data-domain="${escapeHtml(site.domain)}">
<style>${css}</style>
${nav ? `<nav class="an-nav">${nav}</nav>` : ""}
${header}
<h1 class="an-title">${escapeHtml(site.title)}</h1>
${body}
${footer ? `<footer>${footer}</footer>` : ""}
</article>`;
}
