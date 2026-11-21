// Tests: sub-page resolution (hunt 4) — the reader and the export
// must agree on which document a sub-page address shows.
import test from "node:test";
import assert from "node:assert/strict";
import { pageSlugForAddress, sitePageForPath } from "../src/lib/pages.js";
import { DEMO_ABOUT, DEMO_SITE } from "../src/lib/sample.js";
import type { SiteDocument } from "../src/lib/types.js";

test("pageSlugForAddress extracts the slug only for this domain", () => {
  assert.equal(pageSlugForAddress("arknetz://welcome.arknetz/about", "welcome.arknetz"), "about");
  assert.equal(pageSlugForAddress("arknetz://welcome.arknetz/about/", "welcome.arknetz"), "about");
  assert.equal(pageSlugForAddress("arknetz://welcome.arknetz", "welcome.arknetz"), "");
  assert.equal(pageSlugForAddress("arknetz://welcome.arknetz/", "welcome.arknetz"), "");
  assert.equal(pageSlugForAddress("arknetz://welcome.arknetz/blog/2026/post", "welcome.arknetz"), "blog/2026/post");
  assert.equal(pageSlugForAddress("arknetz://other.arknetz/about", "welcome.arknetz"), "");
  assert.equal(pageSlugForAddress("https://welcome.arknetz/about", "welcome.arknetz"), "");
  assert.equal(pageSlugForAddress("home", "welcome.arknetz"), "");
});

test("sitePageForPath returns the sub-page when the site carries one", () => {
  assert.equal(sitePageForPath(DEMO_SITE, "about"), DEMO_ABOUT);
  assert.equal(sitePageForPath(DEMO_SITE, "about").title, "About the protocol");
});

test("sitePageForPath falls back to the root for unknown slugs and the root", () => {
  assert.equal(sitePageForPath(DEMO_SITE, ""), DEMO_SITE);
  assert.equal(sitePageForPath(DEMO_SITE, "nope"), DEMO_SITE);
  const single: SiteDocument = { domain: "x.zine", title: "X", blocks: [] };
  assert.equal(sitePageForPath(single, "about"), single);
});

test("demo site carries its about page (reader and export share it)", () => {
  assert.ok(DEMO_SITE.pages);
  assert.equal(DEMO_SITE.pages!["about"]?.title, "About the protocol");
  assert.ok((DEMO_SITE.pages!["about"]?.blocks.length ?? 0) > 2);
});
