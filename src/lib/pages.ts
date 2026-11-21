// ArkNetzWebWeaver — sub-page resolution (hunt 4, benchmark finding 1).
// A site is a root document plus optional sub-pages (SiteDocument.pages,
// keyed by path slug). The reader resolves arknetz://domain/about to
// pages["about"] when the site carries one and falls back to the root
// document when it does not — an unknown slug lands on the site, never
// an error page (the pre-0.4.1 behaviour). The static export emits one
// file per nav entry from the same map, so reader and export agree.

import type { SiteDocument } from "./types.js";

/** The path slug of an arknetz:// address for `domain` ("" for the
 *  site root). "arknetz://welcome.arknetz/about" -> "about"; trailing
 *  slashes stripped; multi-segment paths kept whole
 *  ("blog/2026/post"). Anything that is not an arknetz:// address for
 *  this domain returns "" — it is not a sub-page of this site. */
export function pageSlugForAddress(address: string, domain: string): string {
  if (!address.startsWith("arknetz://")) return "";
  const rest = address.slice("arknetz://".length);
  const host = rest.split("/")[0] ?? "";
  if (host.toLowerCase() !== domain.toLowerCase()) return "";
  return rest.slice(host.length).replace(/^\/+/, "").replace(/\/+$/, "");
}

/** The document to show for a slug: the sub-page when the site
 *  carries one, the root document otherwise. */
export function sitePageForPath(doc: SiteDocument, slug: string): SiteDocument {
  if (!slug) return doc;
  return doc.pages?.[slug] ?? doc;
}
