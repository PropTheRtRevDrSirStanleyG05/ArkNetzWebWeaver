// Tests: Phase 3b — offline bundles, site stats, streaming.
// All network is mocked. No test ever hits real GitHub or IA.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ArknetzBundleError,
  BUNDLE_MANIFEST_PATH,
  BUNDLE_SITE_PATH,
  buildZip,
  bundleMediaUrl,
  bundleSummary,
  collectMediaRefs,
  crc32,
  openBundle,
  packSiteOffline,
  parseZip,
  renderOfflineSite,
} from "../src/lib/viewer/offline.js";
import {
  buildDailyViewPing,
  buildStatsYml,
  createMemoryPingStore,
  dayCounts,
  defaultTelemetrySettings,
  emptyStats,
  fetchIaPlayCount,
  fetchIssueCommentCounts,
  formatViewPing,
  parseStatsYml,
  parseViewPing,
  recordView,
  rollupPings,
  statsByteSize,
  statsSummary,
  todayString,
} from "../src/lib/viewer/stats.js";
import {
  addToMyList,
  buildCatalog,
  buildRangeRequest,
  checkFaststart,
  checkPosterBudget,
  continueWatchingList,
  createIndexedDBMyListStore,
  createIndexedDBProgressStore,
  createMemoryMyListStore,
  createMemoryProgressStore,
  episodesForSeason,
  findEpisode,
  formatTimestamp,
  heroCarouselOrder,
  isInMyList,
  isWatched,
  listMyList,
  markWatched,
  parseContentRange,
  parseTimestamp,
  playRequest,
  removeFromMyList,
  resumePosition,
  resumeRange,
  saveProgress,
  seasonOptions,
  seekPositionToByte,
} from "../src/lib/viewer/streaming.js";
import { offlineViewModel, statsViewModel, streamingViewModel } from "../src/lib/viewer/viewer2-ui.js";
import type { SiteDocument } from "../src/lib/types.js";
import type { Series } from "../src/lib/viewer/streaming.js";

const POSTER = "https://archive.org/download/demo-item/poster.webp";
const VIDEO = "https://archive.org/download/demo-item/episode-3.mp4";

function sampleDoc(): SiteDocument {
  return {
    domain: "cinema.orion",
    title: "Indie Cinema",
    blocks: [
      { type: "h1", text: "Welcome" },
      { type: "img", src: POSTER, alt: "Poster" },
      { type: "video", src: VIDEO, poster: POSTER },
    ],
  };
}

function sampleCatalog(): Series[] {
  return [
    {
      id: "s1",
      title: "Starlight",
      poster: POSTER,
      featured: true,
      updated: 1700000000000,
      seasons: [
        {
          number: 1,
          episodes: [
            { id: "episode-1", title: "Pilot", src: VIDEO, durationSeconds: 1800 },
            { id: "episode-2", title: "Second Light", src: VIDEO, durationSeconds: 1800 },
          ],
        },
        {
          number: 2,
          episodes: [{ id: "episode-3", title: "The Long Night", src: VIDEO, durationSeconds: 7200 }],
        },
      ],
      cast: [{ name: "Ada Vale", role: "Director", note: "Also wrote episode 3" }],
    },
    {
      id: "s2",
      title: "Quiet Fields",
      updated: 1690000000000,
      seasons: [{ number: 1, episodes: [{ id: "qf-1", title: "Sowing", src: VIDEO, durationSeconds: 1500 }] }],
    },
  ];
}

// A fetch that throws if called — proves zero-network behaviour.
function throwingFetch(): never {
  throw new Error("network was called — this test requires zero network");
}

// --- .arknetz bundles ------------------------------------------------------

test("offline: pack/unpack round-trip preserves the document and cached media", () => {
  const doc = sampleDoc();
  const posterBytes = new TextEncoder().encode("fake-webp-bytes");
  const videoBytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const packed = packSiteOffline(doc, [
    { hotlink: POSTER, bytes: posterBytes, mime: "image/webp" },
    { hotlink: VIDEO, bytes: videoBytes, mime: "video/mp4" },
  ]);
  assert.equal(packed.filename, "cinema.orion.arknetz");
  assert.equal(packed.cachedCount, 2);
  assert.equal(packed.missingCount, 0);
  assert.ok(packed.totalBytes > 0);

  const opened = openBundle(packed.bytes);
  assert.deepEqual(opened.doc, doc);
  assert.equal(opened.manifest.domain, "cinema.orion");
  assert.equal(opened.manifest.format, "arknetz-bundle");
  assert.equal(opened.manifest.version, 1);
  assert.equal(opened.unavailable.length, 0);
  assert.equal(opened.mediaUrls.get(POSTER), bundleMediaUrl("cinema.orion", "assets/0.webp"));
  assert.equal(opened.mediaUrls.get(VIDEO), bundleMediaUrl("cinema.orion", "assets/1.mp4"));
  assert.deepEqual([...opened.files.get("assets/0.webp")!], [...posterBytes]);
});

test("offline: media without cached bytes is listed as missing with a reason, never a silent blank", () => {
  const packed = packSiteOffline(sampleDoc(), []);
  assert.equal(packed.cachedCount, 0);
  assert.equal(packed.missingCount, 2);
  const opened = openBundle(packed.bytes);
  assert.equal(opened.unavailable.length, 2);
  for (const u of opened.unavailable) {
    assert.ok(u.reason.length > 10, "missing media needs a plain-English reason");
  }
  const { html, unavailable } = renderOfflineSite(opened);
  assert.equal(unavailable.length, 2);
  // The original hotlinks stay in the HTML (reader can retry online);
  // the view model carries the reasons.
  assert.match(html, /archive\.org\/download\/demo-item/);
  const vm = offlineViewModel(opened);
  assert.equal(vm.missingMedia, 2);
  assert.equal(vm.missingList.length, 2);
});

test("offline: open with zero network — render uses only embedded bytes", () => {
  void throwingFetch; // no fetch exists in the offline path at all
  const packed = packSiteOffline(sampleDoc(), [
    { hotlink: POSTER, bytes: new TextEncoder().encode("webp"), mime: "image/webp" },
  ]);
  const opened = openBundle(packed.bytes);
  const { html } = renderOfflineSite(opened);
  // Cached poster is rewritten to the arknetz://offline/ URL the shell
  // resolves locally; the uncached video keeps its hotlink and is listed.
  assert.match(html, /arknetz:\/\/offline\/cinema\.orion\/assets\/0\.webp/);
  assert.equal(opened.unavailable.length, 1);
  assert.equal(opened.unavailable[0]!.hotlink, VIDEO);
  assert.equal(collectMediaRefs(sampleDoc()).length, 2);
  assert.match(bundleSummary(packed), /1 saved offline, 1 not included/);
});

test("offline: validation errors — not a zip, plain zip, bad version, corrupt manifest, missing site.json, bad CRC", () => {
  const throwsCode = (bytes: Uint8Array, code: string) =>
    assert.throws(() => openBundle(bytes), (e: unknown) => e instanceof ArknetzBundleError && e.code === code);

  throwsCode(new TextEncoder().encode("hello world"), "not_a_zip");
  throwsCode(new Uint8Array([1, 2, 3]), "not_a_zip");
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);

  const packed = packSiteOffline(sampleDoc(), []);
  const files = parseZip(packed.bytes);
  const manifestBytes = files.get(BUNDLE_MANIFEST_PATH)!;
  const siteBytes = files.get(BUNDLE_SITE_PATH)!;
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { version: number; files: Array<{ path: string; bytes: number; crc32: number }> };
  const zipOf = (entries: Array<{ path: string; data: Uint8Array }>) =>
    buildZip(entries.map((e) => ({ ...e, crc: crc32(e.data) })));

  // Plain ZIP with no manifest at all.
  throwsCode(zipOf([{ path: BUNDLE_SITE_PATH, data: siteBytes }]), "not_an_arknetz_bundle");

  // Manifest version the app does not support.
  const v99 = { ...manifest, version: 99 };
  throwsCode(
    zipOf([
      { path: BUNDLE_MANIFEST_PATH, data: new TextEncoder().encode(JSON.stringify(v99)) },
      { path: BUNDLE_SITE_PATH, data: siteBytes },
    ]),
    "unsupported_manifest_version",
  );

  // Manifest present with a valid CRC but not valid JSON.
  throwsCode(
    zipOf([
      { path: BUNDLE_MANIFEST_PATH, data: new TextEncoder().encode("{not json") },
      { path: BUNDLE_SITE_PATH, data: siteBytes },
    ]),
    "manifest_corrupt",
  );

  // Manifest valid but site.json absent from the archive (and not listed
  // in manifest.files, so the missing-file check reports site_json_missing).
  const noSiteManifest = { ...manifest, files: [] };
  throwsCode(
    zipOf([{ path: BUNDLE_MANIFEST_PATH, data: new TextEncoder().encode(JSON.stringify(noSiteManifest)) }]),
    "site_json_missing",
  );

  // A file listed in the manifest whose bytes were tampered with.
  const tamperedSite = new Uint8Array(siteBytes);
  tamperedSite[10] = tamperedSite[10]! ^ 0xff;
  throwsCode(
    zipOf([
      { path: BUNDLE_MANIFEST_PATH, data: manifestBytes },
      { path: BUNDLE_SITE_PATH, data: tamperedSite },
    ]),
    "crc_mismatch",
  );

  // Corrupting a byte inside the packed archive also fails the CRC check.
  const corruptPacked = new Uint8Array(packed.bytes);
  corruptPacked[60] = corruptPacked[60]! ^ 0xff;
  assert.throws(() => openBundle(corruptPacked), (e: unknown) => e instanceof ArknetzBundleError && e.code === "crc_mismatch");
});

test("offline: truncated zip is rejected, not partially opened", () => {
  const packed = packSiteOffline(sampleDoc(), []);
  const cut = packed.bytes.slice(0, 40);
  assert.throws(() => openBundle(cut), (e: unknown) => e instanceof ArknetzBundleError);
});

// --- Stats -----------------------------------------------------------------

test("stats: VIEW_PING batching — local counters, one batched issue per day, exact format", async () => {
  const store = createMemoryPingStore();
  const settings = { ...defaultTelemetrySettings(), publicViewCounter: true };
  assert.equal(await recordView(store, "index", settings, "2026-11-15"), true);
  await recordView(store, "index", settings, "2026-11-15");
  await recordView(store, "about", settings, "2026-11-15");
  assert.deepEqual(await dayCounts(store, "2026-11-15"), { index: 2, about: 1 });
  const ping = await buildDailyViewPing(store, "2026-11-15", settings);
  assert.equal(ping, "VIEW_PING: 2026-11-15 | about:1, index:2");
  assert.equal(formatViewPing("2026-11-15", { index: 1, about: 1 }), "VIEW_PING: 2026-11-15 | about:1, index:1");
  assert.deepEqual(parseViewPing(ping!), { day: "2026-11-15", counts: { about: 1, index: 2 } });
  assert.equal(parseViewPing("hello world"), null);
  await store.clearDay("2026-11-15");
  assert.equal(await buildDailyViewPing(store, "2026-11-15", settings), null);
});

test("stats: Strict Offline mode — recordView is a no-op, no ping is built, IA fetch is skipped with zero network", async () => {
  const store = createMemoryPingStore();
  const strict = { strictOffline: true, publicViewCounter: true, allowIaPlayCounts: true };
  assert.equal(await recordView(store, "index", strict, "2026-11-15"), false);
  assert.deepEqual(await dayCounts(store, "2026-11-15"), {});
  assert.equal(await buildDailyViewPing(store, "2026-11-15", strict), null);
  const play = await fetchIaPlayCount(async () => throwingFetch(), "demo-item", strict);
  assert.equal(play.skipped, true);
  assert.equal(play.plays, null);
  // Counter disabled by the creator also yields no ping.
  const off = { ...defaultTelemetrySettings(), publicViewCounter: false };
  await recordView(store, "index", off, "2026-11-15");
  assert.equal(await buildDailyViewPing(store, "2026-11-15", off), null);
});

test("stats: IA play counts via archive.org/metadata/<id> (mocked) and comment counts (mocked)", async () => {
  const settings = defaultTelemetrySettings();
  const iaFetch = async (url: string) => {
    assert.equal(url, "https://archive.org/metadata/demo-item");
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ downloads: 41 }),
      json: async () => ({ downloads: 41 }),
    };
  };
  assert.deepEqual(await fetchIaPlayCount(iaFetch, "demo-item", settings), { plays: 41, skipped: false });
  const missing = await fetchIaPlayCount(
    async () => ({ status: 404, headers: { get: () => null }, text: async () => "{}", json: async () => ({}) }),
    "nope",
    settings,
  );
  assert.equal(missing.plays, null);
  assert.match(missing.reason ?? "", /HTTP 404/);

  const ghFetch = async (url: string) => {
    assert.equal(url, "https://api.github.com/repos/alice/site/issues/7");
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => "",
      json: async () => ({ comments: 3, reactions: { total_count: 5 } }),
    };
  };
  assert.deepEqual(await fetchIssueCommentCounts(ghFetch, "alice", "site", 7, settings), { comments: 3, reactions: 5 });
  assert.match(todayString(new Date(2026, 10, 15)), /^2026-11-15$/);
});

test("stats: nightly rollup — pings tallied, ping issues marked for deletion, stats.yml round-trips, ~400-byte shape", () => {
  const { stats, deleteIssueNumbers, ignored } = rollupPings("cinema.orion", [
    { number: 11, body: "VIEW_PING: 2026-11-15 | index:2, about:1" },
    { number: 12, body: "VIEW_PING: 2026-11-16 | index:1" },
    { number: 13, body: "please fix the typo on the about page" },
  ]);
  assert.deepEqual(deleteIssueNumbers, [11, 12]);
  assert.equal(ignored, 1);
  assert.deepEqual(stats.views, { index: 3, about: 1 });
  assert.equal(stats.totalViews, 4);
  // Rollup accumulates onto existing stats.
  const second = rollupPings("cinema.orion", [{ number: 14, body: "VIEW_PING: 2026-11-17 | index:1" }], stats);
  assert.equal(second.stats.views["index"], 4);

  const withCounts: typeof stats = { ...stats, comments: 3, reactions: 5, plays: 41 };
  const yml = buildStatsYml(withCounts);
  assert.match(yml, /domain: cinema\.orion/);
  assert.match(yml, /total_views: 4/);
  const parsed = parseStatsYml(yml);
  assert.equal(parsed.domain, "cinema.orion");
  assert.equal(parsed.totalViews, 4);
  assert.equal(parsed.comments, 3);
  assert.equal(parsed.plays, 41);
  assert.deepEqual(parsed.views, { index: 3, about: 1 });

  // Typical small-site stats stay near the ~400-byte target.
  const size = statsByteSize(withCounts);
  assert.ok(size < 400, `stats.json is ${size} bytes, expected under ~400`);
  assert.equal(statsSummary(withCounts), "4 views · 3 comments · 5 reactions · 41 plays");
  assert.equal(emptyStats("x.zine").totalViews, 0);
  const vm = statsViewModel(withCounts, defaultTelemetrySettings());
  assert.equal(vm.totalViews, 4);
  assert.ok(vm.notice !== null); // counter off by default
});

// --- Streaming -------------------------------------------------------------

test("streaming: Continue Watching save/resume/mark-watched, episode-3 at 14:22", async () => {
  const store = createMemoryProgressStore();
  assert.equal(await resumePosition(store, "episode-3"), null);
  const saved = await saveProgress(store, "episode-3", 862, 7200, 1700000000000);
  assert.equal(saved.watched, false);
  const resume = await resumePosition(store, "episode-3");
  assert.deepEqual(resume, { positionSeconds: 862, formatted: "14:22", percent: 12, remainingSeconds: 6338 });
  assert.equal(formatTimestamp(862), "14:22");
  assert.equal(formatTimestamp(3661), "1:01:01");
  assert.equal(parseTimestamp("14:22"), 862);
  assert.equal(parseTimestamp("1:01:01"), 3661);
  assert.equal(parseTimestamp("nope"), null);
  // Hunt 5: the old parser accepted junk — "14:99" (99 seconds),
  // "1.5:30" (fractional minutes), "14:" (empty seconds), "1:60:00"
  // (60 minutes in h:mm:ss) and "-1:30" all parsed as real times.
  assert.equal(parseTimestamp("14:99"), null);
  assert.equal(parseTimestamp("1.5:30"), null);
  assert.equal(parseTimestamp("14:"), null);
  assert.equal(parseTimestamp(":22"), null);
  assert.equal(parseTimestamp("1:60:00"), null);
  assert.equal(parseTimestamp("1:02:60"), null);
  assert.equal(parseTimestamp("-1:30"), null);
  assert.equal(parseTimestamp("1:2:3:4"), null);
  // Minutes in mm:ss stay unbounded — a 90-minute position is real.
  assert.equal(parseTimestamp("90:00"), 5400);

  const catalog = sampleCatalog();
  const list = await continueWatchingList(store, catalog);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.episode.id, "episode-3");
  assert.equal(list[0]!.resume.formatted, "14:22");

  await markWatched(store, "episode-3", 7200);
  assert.equal(await isWatched(store, "episode-3"), true);
  assert.equal(await resumePosition(store, "episode-3"), null);
  assert.deepEqual(await continueWatchingList(store, catalog), []);
  // Saving past the end clamps; last-10-seconds counts as watched.
  const nearEnd = await saveProgress(store, "episode-1", 1795, 1800);
  assert.equal(nearEnd.watched, true);
});

test("streaming: My List is local-only — add/remove, never synced, no network", async () => {
  const store = createMemoryMyListStore();
  const catalog = sampleCatalog();
  assert.deepEqual(await listMyList(store, catalog), []);
  const entry = await addToMyList(store, "s1");
  assert.equal(entry.syncStatus, "local-only");
  assert.equal(await isInMyList(store, "s1"), true);
  assert.deepEqual((await listMyList(store, catalog)).map((s) => s.id), ["s1"]);
  await removeFromMyList(store, "s1");
  assert.equal(await isInMyList(store, "s1"), false);
  // No fetch exists in the My List path; the store is memory-only here.
  const found = findEpisode(catalog, "episode-3");
  assert.equal(found?.series.id, "s1");
  assert.equal(found?.season.number, 2);
  assert.equal(findEpisode(catalog, "missing"), null);
});

test("streaming: IndexedDB progress + My List stores throw cleanly where IndexedDB does not exist (Node)", () => {
  // Hunt 5: the app used to wire the MEMORY stores even in the
  // browser, so Continue Watching and My List vanished on every
  // reload. The IndexedDB stores exist now (app.ts picks them when
  // useIndexedDB is on); their real read/write path needs a browser
  // — here they must fail loudly, never silently fall back to memory.
  assert.throws(() => createIndexedDBProgressStore(), /IndexedDB is not available/);
  assert.throws(() => createIndexedDBMyListStore(), /IndexedDB is not available/);
});

test("streaming: Range headers, resume logic, seek estimate, faststart check", () => {
  const url = VIDEO;
  assert.deepEqual(buildRangeRequest(url, 0), { url, method: "GET", headers: { Range: "bytes=0-" } });
  assert.deepEqual(buildRangeRequest(url, 1048576, 2097151).headers, { Range: "bytes=1048576-2097151" });
  assert.throws(() => buildRangeRequest(url, -1), /invalid Range start/);
  assert.throws(() => buildRangeRequest(url, 100, 50), /invalid Range end/);

  assert.deepEqual(parseContentRange("bytes 0-1048575/52428800"), { start: 0, end: 1048575, total: 52428800 });
  assert.equal(parseContentRange(null), null);
  assert.equal(parseContentRange("garbage"), null);

  // Resume after a dropped connection at 1 MiB of a 50 MiB file.
  const resumed = resumeRange(url, 52428800, 1048576);
  assert.deepEqual(resumed?.headers, { Range: "bytes=1048576-" });
  assert.equal(resumeRange(url, 100, 100), null); // complete

  // Seek to 14:22 in a 2-hour, 50 MiB file: proportional estimate.
  assert.equal(seekPositionToByte(862, 7200, 52428800), Math.floor((862 / 7200) * 52428800));
  assert.equal(seekPositionToByte(0, 7200, 52428800), 0);
  assert.equal(seekPositionToByte(99999, 7200, 52428800), 52428800);

  assert.equal(checkFaststart(24, 1000).faststart, true);
  assert.equal(checkFaststart(1000, 24).faststart, false);
  assert.match(checkFaststart(1000, 24).reason, /faststart/);
  assert.equal(checkFaststart(null, 100).faststart, false);
});

test("streaming: click-to-play never autoplays; catalog and poster size accounting", async () => {
  const store = createMemoryProgressStore();
  const catalog = sampleCatalog();
  const ep = findEpisode(catalog, "episode-3")!.episode;
  const req = await playRequest(store, ep);
  assert.equal(req.autoplay, false);
  assert.equal(req.preload, "metadata");
  assert.equal(req.resumeFromSeconds, null);
  assert.equal(req.resumeLabel, null);
  await saveProgress(store, "episode-3", 862, 7200);
  const req2 = await playRequest(store, ep);
  assert.equal(req2.resumeFromSeconds, 862);
  assert.equal(req2.resumeLabel, "Resume at 14:22");

  const built = buildCatalog(catalog);
  assert.equal(built.seriesCount, 2);
  assert.equal(built.episodeCount, 4);
  assert.ok(built.bytes > 0);
  assert.equal(built.withinTarget, built.bytes <= 8 * 1024);
  assert.equal(built.overByBytes, Math.max(0, built.bytes - 8192));
  // A realistic small catalog (2 series, 4 episodes) fits the ~8 KB target.
  assert.ok(built.bytes <= 8192, `catalog is ${built.bytes} bytes, target ~8 KB`);

  assert.equal(checkPosterBudget(15 * 1024).ok, true);
  assert.equal(checkPosterBudget(15360).ok, true);
  const over = checkPosterBudget(20000);
  assert.equal(over.ok, false);
  assert.equal(over.overByBytes, 20000 - 15360);

  const hero = heroCarouselOrder(catalog);
  assert.equal(hero[0]!.series.id, "s1"); // featured first
  assert.equal(hero[0]!.reason, "featured");
  assert.equal(hero[1]!.reason, "recently-updated");
  assert.deepEqual(seasonOptions(catalog[0]!), [
    { value: 1, label: "Season 1 — 2 episodes" },
    { value: 2, label: "Season 2 — 1 episode" },
  ]);
  assert.equal(episodesForSeason(catalog[0]!, 2).length, 1);
  assert.deepEqual(episodesForSeason(catalog[0]!, 99), []);
});

// --- View models -----------------------------------------------------------

test("viewer2-ui: streaming + offline view models are pure data, no DOM", async () => {
  const catalog = sampleCatalog();
  const progress = createMemoryProgressStore();
  const myList = createMemoryMyListStore();
  await saveProgress(progress, "episode-3", 862, 7200);
  await addToMyList(myList, "s2");
  const vm = await streamingViewModel(catalog, progress, myList);
  assert.equal(vm.hero[0]!.seriesId, "s1");
  assert.equal(vm.continueWatching.length, 1);
  assert.equal(vm.continueWatching[0]!.resumeLabel, "Resume at 14:22");
  assert.equal(vm.myList[0]!.seriesId, "s2");
  assert.match(vm.copy.myListHint, /never uploaded/);

  const packed = packSiteOffline(sampleDoc(), []);
  const ovm = offlineViewModel(packed);
  assert.equal(ovm.domain, "cinema.orion");
  assert.equal(ovm.missingMedia, 2);
  assert.equal(ovm.actions[0]!.label, "Save site offline");
});
