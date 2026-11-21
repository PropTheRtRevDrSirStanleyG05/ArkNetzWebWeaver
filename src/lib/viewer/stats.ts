// ArkNetzWebWeaver — privacy-preserving site stats (Phase 3b).
// Thread turn 39, two mechanisms, both privacy-first:
//
// (a) Zero-effort built-in metrics: comment/reaction counts from the
//     site's GitHub Discussions/Issues, and media play counts from IA
//     (archive.org/metadata/<id>). These are public counts about the
//     site, not about any visitor — no visitor data is involved.
// (b) Anonymous view pings, OPT-IN, batched, zero IP logging: the
//     visitor app increments a LOCAL IndexedDB counter
//     {"page": "index", "day": "2026-11-15"}; once per day (or on close),
//     if the creator enabled Public View Counter, it submits ONE batched
//     ping as a GitHub Issue — `VIEW_PING: 2026-11-15 | index:1, about:1`.
//     A nightly stats.yml Action tallies the pings into stats.json.zst
//     (~400 bytes) and deletes the ping issues.
//
// Strict Offline / No-Telemetry Mode: a visitor setting that opts out
// entirely. When it is on, this module performs NO network fetch at all
// — no VIEW_PING, no IA play-count fetch, nothing. Every public
// function in this module takes the settings and honours them; tests
// prove it with a fetch that throws if called.
//
// All network goes through an injected fetch function (same shape as
// cache.ts's FetchFn) so tests mock it — this module never calls real
// GitHub or IA, and never creates issues itself: it only BUILDS the
// ping body; the caller (which owns the GitHub write path) submits it.

export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json?(): Promise<unknown>;
}>;

/** The stats.json.zst shape (decompressed JSON). Short keys keep the
 *  file near the thread's ~400-byte target for a typical small site. */
export interface SiteStats {
  /** Format version. */
  v: 1;
  domain: string;
  /** Unix ms of the last rollup. */
  updated: number;
  /** Views per page slug, e.g. { index: 12, about: 3 }. */
  views: Record<string, number>;
  /** Total views (sum of views), for the one-line display. */
  totalViews: number;
  /** Comment count from GitHub Discussions/Issues. 0 / absent = none yet. */
  comments?: number;
  /** Reaction count from GitHub Discussions/Issues. */
  reactions?: number;
  /** Media play count from IA metadata. */
  plays?: number;
}

export interface TelemetrySettings {
  /** Strict Offline / No-Telemetry Mode: visitor opts out entirely.
   *  When true, no VIEW_PING is recorded or sent and no IA play-count
   *  fetch happens — zero network from this module. */
  strictOffline: boolean;
  /** Creator-side switch: the site owner enabled the Public View Counter.
   *  A visitor ping is only built when this is true AND strictOffline
   *  is false. */
  publicViewCounter: boolean;
  /** Allow the (public, anonymous) IA play-count lookup. Off in strict
   *  mode regardless. */
  allowIaPlayCounts: boolean;
}

export function defaultTelemetrySettings(): TelemetrySettings {
  return { strictOffline: false, publicViewCounter: false, allowIaPlayCounts: true };
}

/** Coerce an unknown stored value back to valid settings: missing or
 *  non-boolean fields fall back to the defaults, so a corrupt or
 *  partial stored row can never turn telemetry on by accident. */
export function normalizeTelemetrySettings(value: unknown): TelemetrySettings {
  const defaults = defaultTelemetrySettings();
  if (!value || typeof value !== "object") return defaults;
  const v = value as Partial<TelemetrySettings>;
  return {
    strictOffline: typeof v.strictOffline === "boolean" ? v.strictOffline : defaults.strictOffline,
    publicViewCounter: typeof v.publicViewCounter === "boolean" ? v.publicViewCounter : defaults.publicViewCounter,
    allowIaPlayCounts: typeof v.allowIaPlayCounts === "boolean" ? v.allowIaPlayCounts : defaults.allowIaPlayCounts,
  };
}

/** Telemetry-settings store (integration pass): the Stats panel's
 *  Strict Offline / Public View Counter toggles persist here. The app
 *  keeps a synchronous in-memory mirror of the current settings (the
 *  panel render/wire path is synchronous) and writes through to this
 *  store; `loadTelemetrySettings()` on the app re-reads it at startup.
 *  Telemetry settings are local-only and never leave the device. */
export interface TelemetrySettingsStore {
  get(): Promise<TelemetrySettings>;
  set(next: TelemetrySettings): Promise<void>;
}

export function createMemoryTelemetrySettingsStore(
  initial: TelemetrySettings = defaultTelemetrySettings(),
): TelemetrySettingsStore & { peek(): TelemetrySettings } {
  let current: TelemetrySettings = { ...initial };
  return {
    async get() {
      return { ...current };
    },
    async set(next) {
      current = { ...next };
    },
    peek() {
      return { ...current };
    },
  };
}

const TELEMETRY_DB = "arknetz-telemetry";
const TELEMETRY_STORE = "settings";
const TELEMETRY_KEY = "telemetry-settings";

/** IndexedDB-backed telemetry-settings store — same shape as the
 *  IA-account store (ia-settings.ts): one DB, one object store, one
 *  key. Throws when IndexedDB is unavailable, like every other
 *  IndexedDB store in the app. */
export function createIndexedDBTelemetrySettingsStore(): TelemetrySettingsStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(TELEMETRY_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(TELEMETRY_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const withStore = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const r = fn(db.transaction(TELEMETRY_STORE, mode).objectStore(TELEMETRY_STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    async get() {
      const stored = await withStore("readonly", (s) => s.get(TELEMETRY_KEY));
      return normalizeTelemetrySettings(stored === undefined ? null : (stored as unknown));
    },
    async set(next) {
      await withStore("readwrite", (s) => s.put({ ...next }, TELEMETRY_KEY));
    },
  };
}

/** Compact byte size of a stats document — the number the UI reports
 *  against the ~400-byte target. */
export function statsByteSize(stats: SiteStats): number {
  return new TextEncoder().encode(JSON.stringify(stats)).length;
}

export function emptyStats(domain: string, updated = Date.now()): SiteStats {
  return { v: 1, domain, updated, views: {}, totalViews: 0 };
}

export function totalViewsOf(views: Record<string, number>): number {
  return Object.values(views).reduce((n, c) => n + c, 0);
}

// --- (a) Built-in public counts --------------------------------------------

/** Minimal shape of the comments source. The comments phase owns the
 *  real Discussions/Issues client; stats only needs these two numbers,
 *  so it defines its own minimal interface here and never imports
 *  another phase's files. */
export interface CommentCounts {
  comments: number;
  reactions: number;
}

/** Comment/reaction counts for one GitHub Issue (the discussion thread
 *  backing a site's comments). Reads the public issue JSON; mocked fetch
 *  in tests, never a real call in this module's own code path. */
export async function fetchIssueCommentCounts(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  issueNumber: number,
  settings: TelemetrySettings,
): Promise<CommentCounts> {
  void settings; // public counts about the site — no visitor telemetry.
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
  const res = await fetchFn(url, { headers: { "User-Agent": "ArkNetzWebWeaver/1.0" } });
  if (res.status !== 200) {
    throw new Error(`comment counts unavailable: GitHub returned HTTP ${res.status} for issue #${issueNumber}`);
  }
  const body = (await (res.json ? res.json() : JSON.parse(await res.text()))) as {
    comments?: number;
    reactions?: { total_count?: number };
  };
  return {
    comments: typeof body.comments === "number" ? body.comments : 0,
    reactions: typeof body.reactions?.total_count === "number" ? body.reactions.total_count : 0,
  };
}

/** IA play count for one item: GET archive.org/metadata/<id> and read
 *  its `downloads` field (IA's public lifetime download count). Returns
 *  null with a reason instead of throwing when IA is unreachable or the
 *  field is absent — a missing play count must never blank the page.
 *  In Strict Offline mode this returns { skipped: true } WITHOUT any
 *  fetch. */
export async function fetchIaPlayCount(
  fetchFn: FetchFn,
  itemId: string,
  settings: TelemetrySettings,
): Promise<{ plays: number | null; skipped: boolean; reason?: string }> {
  if (settings.strictOffline || !settings.allowIaPlayCounts) {
    return { plays: null, skipped: true, reason: settings.strictOffline ? "Strict Offline mode is on — no play-count fetch." : "IA play counts are disabled in settings." };
  }
  const url = `https://archive.org/metadata/${encodeURIComponent(itemId)}`;
  let res;
  try {
    res = await fetchFn(url, { headers: { "User-Agent": "ArkNetzWebWeaver/1.0" } });
  } catch (err) {
    return { plays: null, skipped: false, reason: `IA metadata fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status !== 200) {
    return { plays: null, skipped: false, reason: `archive.org returned HTTP ${res.status} for item "${itemId}"` };
  }
  const body = (await (res.json ? res.json() : JSON.parse(await res.text()))) as { downloads?: number };
  if (typeof body.downloads !== "number") {
    return { plays: null, skipped: false, reason: `IA metadata for "${itemId}" has no download count yet.` };
  }
  return { plays: body.downloads, skipped: false };
}

// --- (b) Anonymous batched VIEW_PINGs --------------------------------------

export type ViewPingStore = {
  /** Local counters, keyed "day|page", e.g. "2026-11-15|index" -> 3. */
  getAll(): Promise<Record<string, number>>;
  increment(day: string, page: string): Promise<void>;
  clearDay(day: string): Promise<void>;
};

export function createMemoryPingStore(): ViewPingStore {
  const map = new Map<string, number>();
  return {
    async getAll() {
      return Object.fromEntries(map);
    },
    async increment(day, page) {
      const key = `${day}|${page}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    },
    async clearDay(day) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${day}|`)) map.delete(key);
      }
    },
  };
}

/** Today's date as YYYY-MM-DD in the visitor's local timezone. */
export function todayString(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Record one anonymous view locally. No network, no identity — just a
 *  counter. In Strict Offline mode this is a no-op (nothing is recorded
 *  at all, so there is nothing to send later). */
export async function recordView(store: ViewPingStore, page: string, settings: TelemetrySettings, day = todayString()): Promise<boolean> {
  if (settings.strictOffline) return false;
  await store.increment(day, page);
  return true;
}

/** Per-day counts from the local store, e.g. { index: 1, about: 1 }. */
export async function dayCounts(store: ViewPingStore, day: string): Promise<Record<string, number>> {
  const all = await store.getAll();
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(all)) {
    const [d, page] = key.split("|");
    if (d === day && page) out[page] = count;
  }
  return out;
}

/** The exact batched ping body the thread specifies:
 *  `VIEW_PING: 2026-11-15 | index:1, about:1`
 *  Pages are sorted alphabetically so the body is deterministic. */
export function formatViewPing(day: string, counts: Record<string, number>): string {
  const parts = Object.keys(counts)
    .sort()
    .map((page) => `${page}:${counts[page]}`);
  return `VIEW_PING: ${day} | ${parts.join(", ")}`;
}

/** Parse a VIEW_PING body back into { day, counts }. Returns null when
 *  the body is not a VIEW_PING (the rollup ignores other issues). */
export function parseViewPing(body: string): { day: string; counts: Record<string, number> } | null {
  const m = /^VIEW_PING:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+)$/.exec(body.trim());
  if (!m) return null;
  const counts: Record<string, number> = {};
  for (const part of (m[2] ?? "").split(",")) {
    const [page, n] = part.trim().split(":");
    const count = Number(n);
    if (page && Number.isFinite(count) && count > 0) counts[page] = count;
  }
  return { day: m[1]!, counts };
}

/** Build the one batched ping for a day, or null when there is nothing
 *  to send (no views, Strict Offline, or the creator never enabled the
 *  Public View Counter). Callers submit the returned body as a GitHub
 *  Issue and then call clearDay — this module never creates issues. */
export async function buildDailyViewPing(
  store: ViewPingStore,
  day: string,
  settings: TelemetrySettings,
): Promise<string | null> {
  if (settings.strictOffline || !settings.publicViewCounter) return null;
  const counts = await dayCounts(store, day);
  if (Object.keys(counts).length === 0) return null;
  return formatViewPing(day, counts);
}

// --- Nightly rollup: stats.yml -> stats.json.zst ---------------------------

/** The nightly stats.yml shape (what the GitHub Action writes before
 *  compressing to stats.json.zst). Human-readable, one file per site. */
export function buildStatsYml(stats: SiteStats): string {
  const lines: string[] = [
    `domain: ${stats.domain}`,
    `updated: ${new Date(stats.updated).toISOString()}`,
    `total_views: ${stats.totalViews}`,
    "views:",
  ];
  for (const page of Object.keys(stats.views).sort()) {
    lines.push(`  ${page}: ${stats.views[page]}`);
  }
  if (stats.comments !== undefined) lines.push(`comments: ${stats.comments}`);
  if (stats.reactions !== undefined) lines.push(`reactions: ${stats.reactions}`);
  if (stats.plays !== undefined) lines.push(`plays: ${stats.plays}`);
  return lines.join("\n") + "\n";
}

/** Parse a stats.yml back (round-trip check for the Action's output). */
export function parseStatsYml(text: string): SiteStats {
  const stats: SiteStats = { v: 1, domain: "", updated: 0, views: {}, totalViews: 0 };
  let inViews = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "views:") {
      inViews = true;
      continue;
    }
    const m = /^(\s*)([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[2]!;
    const value = m[3]!;
    if (inViews && m[1]!.length > 0) {
      const n = Number(value);
      if (Number.isFinite(n)) stats.views[key] = n;
      continue;
    }
    inViews = false;
    if (key === "domain") stats.domain = value;
    else if (key === "updated") stats.updated = Date.parse(value) || 0;
    else if (key === "total_views") stats.totalViews = Number(value) || 0;
    else if (key === "comments") stats.comments = Number(value) || 0;
    else if (key === "reactions") stats.reactions = Number(value) || 0;
    else if (key === "plays") stats.plays = Number(value) || 0;
  }
  return stats;
}

export interface RollupResult {
  /** The new stats.json.zst content (decompressed JSON shape). */
  stats: SiteStats;
  /** Issue numbers the Action should delete after the rollup (the ping
   *  issues that were tallied). Callers supply the numbers alongside
   *  the bodies. */
  deleteIssueNumbers: number[];
  /** Ping bodies that were not VIEW_PINGs and were ignored. */
  ignored: number;
}

/** Nightly rollup: tally a batch of VIEW_PING issue bodies into the
 *  site's stats. Existing stats are carried forward (views accumulate);
 *  comment/reaction/play counts are refreshed by the caller afterwards
 *  via fetchIssueCommentCounts / fetchIaPlayCount. */
export function rollupPings(
  domain: string,
  pingIssues: Array<{ number: number; body: string }>,
  existing?: SiteStats,
  updated = Date.now(),
): RollupResult {
  const stats: SiteStats = existing
    ? { ...existing, views: { ...existing.views }, updated }
    : emptyStats(domain, updated);
  const deleteIssueNumbers: number[] = [];
  let ignored = 0;
  for (const issue of pingIssues) {
    const parsed = parseViewPing(issue.body);
    if (!parsed) {
      ignored++;
      continue;
    }
    for (const [page, count] of Object.entries(parsed.counts)) {
      stats.views[page] = (stats.views[page] ?? 0) + count;
    }
    deleteIssueNumbers.push(issue.number);
  }
  stats.totalViews = totalViewsOf(stats.views);
  return { stats, deleteIssueNumbers, ignored };
}

/** One-line plain-English summary for the stats panel. */
export function statsSummary(stats: SiteStats): string {
  const parts: string[] = [`${stats.totalViews} view${stats.totalViews === 1 ? "" : "s"}`];
  if (stats.comments !== undefined) parts.push(`${stats.comments} comment${stats.comments === 1 ? "" : "s"}`);
  if (stats.reactions !== undefined) parts.push(`${stats.reactions} reaction${stats.reactions === 1 ? "" : "s"}`);
  if (stats.plays !== undefined) parts.push(`${stats.plays} play${stats.plays === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
