// Tests: Stats panel module (fix agent C, new panel 1) — renders from
// the existing stats service + view model, with honest empty states and
// working telemetry toggles. Wiring into panels.ts/app.ts is the
// integration pass; this file covers the module itself.
import test from "node:test";
import assert from "node:assert/strict";
import {
  STATS_PANEL_DESCRIPTION,
  STATS_PANEL_ID,
  STATS_PANEL_TITLE,
  mountStatsPanel,
  renderStatsPanelHtml,
} from "../src/lib/viewer/stats-panel.js";
import {
  defaultTelemetrySettings,
  emptyStats,
  type SiteStats,
  type TelemetrySettings,
} from "../src/lib/viewer/stats.js";

/** Minimal fake element (same shape as the wayback-ui tests use). */
class FakeEl {
  #html = "";
  #listeners = new Map<string, Array<() => void>>();
  #children = new Map<string, FakeEl>();

  constructor(public readonly id = "") {}

  get innerHTML(): string {
    return this.#html;
  }
  set innerHTML(v: string) {
    this.#html = v;
    this.#children.clear();
    for (const m of v.matchAll(/id="([^"]+)"/g)) {
      const childId = m[1]!;
      if (!this.#children.has(childId)) this.#children.set(childId, new FakeEl(childId));
    }
  }

  querySelector<T>(selector: string): T | null {
    const m = /^#([\w-]+)$/.exec(selector);
    if (!m) return null;
    const hit = this.#children.get(m[1]!);
    return (hit ?? null) as unknown as T | null;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }

  click(): void {
    for (const fn of this.#listeners.get("click") ?? []) fn();
  }
}

test("stats-panel: panel identity exports", () => {
  assert.equal(STATS_PANEL_ID, "stats");
  assert.equal(STATS_PANEL_TITLE, "Stats");
  assert.match(STATS_PANEL_DESCRIPTION, /Privacy-preserving/);
});

test("stats-panel: empty stats render honest empty states, not zeros dressed up", () => {
  const html = renderStatsPanelHtml({
    stats: emptyStats("cinema.orion"),
    settings: defaultTelemetrySettings(),
  });
  assert.match(html, /Stats/);
  assert.match(html, /No views recorded yet/);
  assert.match(html, /No comments yet/);
  assert.match(html, /No reactions yet/);
  assert.match(html, /No plays recorded yet/);
  assert.match(html, /Public View Counter/);
  assert.match(html, /Strict Offline \/ No-Telemetry Mode/);
  // Toggles start off, and say so.
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /Turn on the Public View Counter/);
  assert.match(html, /Turn on Strict Offline/);
});

test("stats-panel: real counts render per-page views and all three count kinds", () => {
  const stats: SiteStats = {
    v: 1,
    domain: "cinema.orion",
    updated: Date.now(),
    views: { index: 12, about: 3 },
    totalViews: 15,
    comments: 4,
    reactions: 9,
    plays: 41,
  };
  const html = renderStatsPanelHtml({ stats, settings: defaultTelemetrySettings() });
  assert.match(html, /15 views/);
  assert.match(html, /index — 12 views/);
  assert.match(html, /about — 3 views/);
  assert.match(html, /Comments — 4/);
  assert.match(html, /Reactions — 9/);
  assert.match(html, /Media plays — 41/);
  assert.doesNotMatch(html, /No views recorded yet/);
});

test("stats-panel: Strict Offline mode shows its notice and an on-state toggle", () => {
  const html = renderStatsPanelHtml({
    stats: emptyStats("cinema.orion"),
    settings: { ...defaultTelemetrySettings(), strictOffline: true },
  });
  assert.match(html, /Strict Offline mode is on/);
  assert.match(html, /Turn off Strict Offline/);
  assert.match(html, /aria-pressed="true"/);
});

test("stats-panel: mount binds both toggles — click flips the setting and re-renders", () => {
  const root = new FakeEl("root");
  const seen: TelemetrySettings[] = [];
  mountStatsPanel(root as unknown as HTMLElement, {
    stats: emptyStats("cinema.orion"),
    settings: defaultTelemetrySettings(),
    onSettingsChange: (next) => {
      seen.push(next);
    },
  });
  assert.match(root.innerHTML, /Turn on the Public View Counter/);

  root.querySelector<FakeEl>("#an-stats-toggle-view-counter")!.click();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.publicViewCounter, true);
  assert.match(root.innerHTML, /Turn off the Public View Counter/);

  root.querySelector<FakeEl>("#an-stats-toggle-strict-offline")!.click();
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.strictOffline, true);
  assert.equal(seen[1]?.publicViewCounter, true);
  assert.match(root.innerHTML, /Turn off Strict Offline/);
});
