// Tests: Backends panel module (fix agent C, new panel 2) — lists every
// pluggable backend with linked status, mirror failover state, and the
// ToS-aware routing note. Wiring into panels.ts/app.ts is the
// integration pass; this file covers the module itself.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKENDS_PANEL_DESCRIPTION,
  BACKENDS_PANEL_ID,
  BACKENDS_PANEL_TITLE,
  mountBackendsPanel,
  renderBackendsPanelHtml,
} from "../src/lib/network/backends-panel.js";
import { BACKEND_PREFIXES } from "../src/lib/network/backends.js";

class FakeEl {
  #html = "";
  get innerHTML(): string {
    return this.#html;
  }
  set innerHTML(v: string) {
    this.#html = v;
  }
}

test("backends-panel: panel identity exports", () => {
  assert.equal(BACKENDS_PANEL_ID, "backends");
  assert.equal(BACKENDS_PANEL_TITLE, "Backends");
  assert.match(BACKENDS_PANEL_DESCRIPTION, /storage backend/);
});

test("backends-panel: lists all seven backends with linked status", () => {
  const html = renderBackendsPanelHtml({
    projectFlags: {},
    linked: { gh: "alice (GitHub)", ia: "alice@archive.org" },
  });
  for (const prefix of BACKEND_PREFIXES) {
    assert.match(html, new RegExp(`${prefix}:`), prefix);
  }
  assert.match(html, /GitHub/);
  assert.match(html, /Internet Archive/);
  assert.match(html, /Hugging Face Hub/);
  assert.match(html, /Wikimedia Commons/);
  assert.match(html, /IPFS \(Filebase\)/);
  assert.match(html, /Linked: alice \(GitHub\)/);
  assert.match(html, /Linked: alice@archive\.org/);
  assert.match(html, /Not linked — sign in in Accounts to link it\./);
});

test("backends-panel: hf: and wm: are not offered for a plain personal project, with reasons", () => {
  const html = renderBackendsPanelHtml({ projectFlags: {}, linked: {} });
  assert.match(html, /Not offered as an upload target/);
  assert.match(html, /Hugging Face Hub public repos must be useful to AI\/ML or open science/);
  assert.match(html, /Wikimedia Commons accepts only freely licensed/);
});

test("backends-panel: hf: is offered for an open dataset, wm: for educational work", () => {
  const open = renderBackendsPanelHtml({
    projectFlags: { isOpenDataset: true },
    linked: {},
  });
  assert.match(open, /Hugging Face Hub[\s\S]*Available as an upload target/);
  const edu = renderBackendsPanelHtml({
    projectFlags: { isEducational: true },
    linked: {},
  });
  assert.match(edu, /Wikimedia Commons[\s\S]*Available as an upload target/);
});

test("backends-panel: ToS-aware routing note is present", () => {
  const html = renderBackendsPanelHtml({ projectFlags: {}, linked: {} });
  assert.match(html, /only appear as upload targets for open, educational, or Creative Commons work/);
  assert.match(html, /Reads are never gated/);
  assert.match(html, /never uses a shared or master key/);
});

test("backends-panel: no mirror attempts yet is an honest empty state", () => {
  const html = renderBackendsPanelHtml({ projectFlags: {}, linked: {} });
  assert.match(html, /No site has loaded through mirrors yet/);
  assert.match(html, /tries each mirror in order, then the latest Wayback Machine snapshot/);
});

test("backends-panel: mirror attempts render the failover summary", () => {
  const html = renderBackendsPanelHtml({
    projectFlags: {},
    linked: {},
    lastMirrorAttempts: [
      { uri: "gh:alice/site/site.json.zst", url: "https://raw.githubusercontent.com/alice/site/main/site.json.zst", status: null, error: "Failed to fetch", ms: 120 },
      { uri: "gl:alice/site/site.json.zst", url: "https://gitlab.com/alice/site/-/raw/main/site.json.zst", status: 200, ms: 340 },
    ],
  });
  assert.match(html, /Loaded from gl:alice\/site\/site\.json\.zst after 1 mirror\(s\) failed/);
  assert.match(html, /Failed to fetch/);
  assert.doesNotMatch(html, /No site has loaded through mirrors yet/);
});

test("backends-panel: mount renders into the host element", () => {
  const root = new FakeEl();
  mountBackendsPanel(root as unknown as HTMLElement, { projectFlags: {}, linked: {} });
  assert.match(root.innerHTML, /Backends/);
  assert.match(root.innerHTML, /Storage backends/);
  assert.match(root.innerHTML, /Mirror failover/);
});
