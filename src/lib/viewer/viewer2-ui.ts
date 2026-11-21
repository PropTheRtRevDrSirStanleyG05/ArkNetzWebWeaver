// ArkNetzWebWeaver — Phase 3b view models (viewer2-ui).
// Pure functions returning view data + plain-English copy for the
// offline / stats / streaming UI. NO DOM edits here — the coordinator
// wires these view models into the shell DOM later. Every string a
// visitor sees is written here, in plain English, so the UI copy stays
// consistent and reviewable in one place.

import type { OpenedBundle, PackedBundle } from "./offline.js";
import { bundleSummary } from "./offline.js";
import type { SiteStats, TelemetrySettings } from "./stats.js";
import { statsSummary } from "./stats.js";
import type { Series } from "./streaming.js";
import { continueWatchingList, heroCarouselOrder, listMyList, seasonOptions } from "./streaming.js";
import type { MyListStore, ProgressStore } from "./streaming.js";

export const OFFLINE_COPY = {
  saveButton: "Save site offline",
  saveHint: "Downloads this site into one portable .arknetz file you can open with no internet — on a plane, in a rural area, or from a USB stick.",
  openButton: "Open offline bundle",
  openHint: "Pick a .arknetz file. It opens right here, with no internet needed.",
  missingMediaTitle: "Some media is not in this bundle",
  missingMediaHint: "These files were not downloaded when the bundle was saved. Connect to the internet and save the site again to include them.",
  savedTitle: "Saved for offline",
  shareHint: "Share the .arknetz file over USB, Bluetooth, or Discord — anyone with ArkNetzWebWeaver can open it.",
} as const;

export const STATS_COPY = {
  title: "Site stats",
  optInTitle: "Public view counter",
  optInHint: "When on, your app sends one anonymous count per day — just page names and numbers, like “index: 3”. No IP address, no identity, nothing about you.",
  strictOfflineTitle: "Strict Offline / No-Telemetry Mode",
  strictOfflineHint: "When on, this app sends nothing at all: no view counts, no play counts, no network requests from stats. The site still works fully offline.",
  noStatsYet: "No stats yet — the first nightly count will appear here.",
  rollupNote: "Counts are tallied once a night into a tiny stats file (about 400 bytes).",
} as const;

export const STREAMING_COPY = {
  title: "Watch",
  heroLabel: "Featured",
  continueWatchingTitle: "Continue Watching",
  myListTitle: "My List",
  myListHint: "Saved only on this device. It is never uploaded or synced anywhere.",
  playButton: "Play",
  resumePrefix: "Resume at",
  watchedLabel: "Watched",
  seasonLabel: "Season",
  noContinueWatching: "Nothing in progress yet — start an episode and it will wait for you here.",
  emptyMyList: "Your list is empty. Add a series to keep it here, on this device only.",
  clickToPlayHint: "Tap play to start. Videos never start by themselves.",
} as const;

export interface UiAction {
  id: string;
  label: string;
  hint?: string;
}

export interface OfflineViewModel {
  title: string;
  domain: string;
  summary: string;
  cachedMedia: number;
  missingMedia: number;
  totalBytes: number | null;
  missingList: Array<{ hotlink: string; reason: string }>;
  actions: UiAction[];
  copy: typeof OFFLINE_COPY;
}

export function offlineViewModel(bundle: PackedBundle | OpenedBundle): OfflineViewModel {
  const manifest = bundle.manifest;
  const cached = manifest.media.filter((m) => m.status === "cached").length;
  const missing = manifest.media.length - cached;
  const unavailable =
    "unavailable" in bundle
      ? bundle.unavailable
      : manifest.media.filter((m) => m.status === "missing").map((m) => ({ hotlink: m.hotlink, reason: m.reason ?? "Not included in this bundle." }));
  return {
    title: manifest.title,
    domain: manifest.domain,
    summary: bundleSummary(bundle),
    cachedMedia: cached,
    missingMedia: missing,
    totalBytes: "totalBytes" in bundle ? bundle.totalBytes : null,
    missingList: unavailable,
    actions: [
      { id: "save-offline", label: OFFLINE_COPY.saveButton, hint: OFFLINE_COPY.saveHint },
      { id: "open-offline", label: OFFLINE_COPY.openButton, hint: OFFLINE_COPY.openHint },
    ],
    copy: OFFLINE_COPY,
  };
}

export interface StatsViewModel {
  summary: string;
  totalViews: number;
  perPage: Array<{ page: string; views: number }>;
  comments: number | null;
  reactions: number | null;
  plays: number | null;
  strictOffline: boolean;
  publicViewCounter: boolean;
  notice: string | null;
  actions: UiAction[];
  copy: typeof STATS_COPY;
}

export function statsViewModel(stats: SiteStats, settings: TelemetrySettings): StatsViewModel {
  const notice = settings.strictOffline
    ? "Strict Offline mode is on — no view counts or play counts are collected or fetched."
    : !settings.publicViewCounter
      ? "The public view counter is off — turn it on to share anonymous daily counts."
      : null;
  return {
    summary: stats.totalViews === 0 && stats.comments === undefined && stats.plays === undefined ? STATS_COPY.noStatsYet : statsSummary(stats),
    totalViews: stats.totalViews,
    perPage: Object.keys(stats.views)
      .sort()
      .map((page) => ({ page, views: stats.views[page]! })),
    comments: stats.comments ?? null,
    reactions: stats.reactions ?? null,
    plays: stats.plays ?? null,
    strictOffline: settings.strictOffline,
    publicViewCounter: settings.publicViewCounter,
    notice,
    actions: [
      { id: "toggle-view-counter", label: STATS_COPY.optInTitle, hint: STATS_COPY.optInHint },
      { id: "toggle-strict-offline", label: STATS_COPY.strictOfflineTitle, hint: STATS_COPY.strictOfflineHint },
    ],
    copy: STATS_COPY,
  };
}

export interface StreamingViewModel {
  hero: Array<{ seriesId: string; title: string; poster: string | null; reason: string; label: string }>;
  seriesRows: Array<{ seriesId: string; title: string; poster: string | null; seasons: ReturnType<typeof seasonOptions> }>;
  continueWatching: Array<{ seriesId: string; seriesTitle: string; episodeId: string; episodeTitle: string; resumeLabel: string; percent: number }>;
  myList: Array<{ seriesId: string; title: string; poster: string | null }>;
  copy: typeof STREAMING_COPY;
}

export async function streamingViewModel(
  catalog: Series[],
  progressStore: ProgressStore,
  myListStore: MyListStore,
): Promise<StreamingViewModel> {
  const hero = heroCarouselOrder(catalog).map((h) => ({
    seriesId: h.series.id,
    title: h.series.title,
    poster: h.series.poster ?? null,
    reason: h.reason,
    label: h.reason === "featured" ? STREAMING_COPY.heroLabel : "Recently updated",
  }));
  const seriesRows = catalog.map((s) => ({
    seriesId: s.id,
    title: s.title,
    poster: s.poster ?? null,
    seasons: seasonOptions(s),
  }));
  const cw = await continueWatchingList(progressStore, catalog);
  const myListSeries = await listMyList(myListStore, catalog);
  return {
    hero,
    seriesRows,
    continueWatching: cw.map((c) => ({
      seriesId: c.series.id,
      seriesTitle: c.series.title,
      episodeId: c.episode.id,
      episodeTitle: c.episode.title,
      resumeLabel: `${STREAMING_COPY.resumePrefix} ${c.resume.formatted}`,
      percent: c.resume.percent,
    })),
    myList: myListSeries.map((s) => ({ seriesId: s.id, title: s.title, poster: s.poster ?? null })),
    copy: STREAMING_COPY,
  };
}
