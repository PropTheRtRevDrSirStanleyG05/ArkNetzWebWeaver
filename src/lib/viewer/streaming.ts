// ArkNetzWebWeaver — personal streaming: series-grid / media-shelf (Phase 3b).
// Thread turn 20: an indie filmmaker/animator/educator launches their own
// Netflix on e.g. cinema.orion — $0/month, ad-free, algorithm-free.
// Catalog / hero carousel ~8 KB over the wire, posters ~15 KB WebP,
// 720p faststart MP4 with HTTP Range seeking (scrub a 2-hour movie while
// downloading only the seconds watched), Continue Watching in IndexedDB
// (episode-3: 14:22), private local My List, zero tracking servers.
//
// Rules this module enforces:
// - Click-to-play, NEVER autoplay: playRequest() always returns
//   autoplay: false and preload: "metadata".
// - Continue Watching and My List are LOCAL ONLY. They live in
//   IndexedDB-shaped stores injected here, are never synced, never
//   uploaded, and no function in this module performs any network fetch.
// - Range seeking is transport-agnostic: this module builds the exact
//   `Range: bytes=a-b` request headers and the resume logic; the caller
//   performs the fetch (mocked transport in tests).
// - Catalog size is accounted, not assumed: buildCatalog() reports its
//   exact byte size against the ~8 KB target.

export interface Episode {
  id: string; // e.g. "episode-3"
  title: string;
  /** IA hotlink, e.g. https://archive.org/download/<item>/<file>.mp4 */
  src: string;
  /** Length in seconds (7200 = a 2-hour movie). */
  durationSeconds: number;
  /** ~15 KB WebP poster hotlink (optional — series poster is the fallback). */
  poster?: string;
  synopsis?: string;
}

export interface Season {
  number: number;
  title?: string;
  episodes: Episode[];
}

export interface CastMember {
  name: string;
  role: string;
  note?: string;
}

export interface Series {
  id: string;
  title: string;
  description?: string;
  /** ~15 KB WebP poster hotlink. */
  poster?: string;
  seasons: Season[];
  cast?: CastMember[];
  /** Unix ms the series was last updated — hero ordering tiebreak. */
  updated?: number;
  /** Creator-flagged feature. Featured series lead the hero carousel. */
  featured?: boolean;
}

// --- Size accounting -------------------------------------------------------

export const CATALOG_TARGET_BYTES = 8 * 1024; // ~8 KB over the wire
export const POSTER_TARGET_BYTES = 15 * 1024; // ~15 KB WebP posters

export interface CatalogResult {
  json: string;
  bytes: number;
  seriesCount: number;
  episodeCount: number;
  withinTarget: boolean;
  overByBytes: number;
}

/** Serialise a catalog (the ~8 KB payload the reader downloads once and
 *  caches). Reports the ACTUAL byte size — never a claimed one. */
export function buildCatalog(series: Series[]): CatalogResult {
  const json = JSON.stringify(series);
  const bytes = new TextEncoder().encode(json).length;
  const episodeCount = series.reduce(
    (n, s) => n + s.seasons.reduce((m, season) => m + season.episodes.length, 0),
    0,
  );
  return {
    json,
    bytes,
    seriesCount: series.length,
    episodeCount,
    withinTarget: bytes <= CATALOG_TARGET_BYTES,
    overByBytes: Math.max(0, bytes - CATALOG_TARGET_BYTES),
  };
}

/** Poster budget check: is this poster's byte size within the ~15 KB
 *  target? Callers pass the real encoded size (measured after WebP
 *  encode), not a guess. */
export function checkPosterBudget(bytes: number, target = POSTER_TARGET_BYTES): { ok: boolean; bytes: number; target: number; overByBytes: number } {
  return { ok: bytes <= target, bytes, target, overByBytes: Math.max(0, bytes - target) };
}

// --- Seasons / episodes ----------------------------------------------------

export interface SeasonOption {
  value: number;
  label: string;
}

/** Season dropdown options, e.g. "Season 1 — 6 episodes". */
export function seasonOptions(series: Series): SeasonOption[] {
  return series.seasons.map((s) => ({
    value: s.number,
    label: `Season ${s.number}${s.title ? ` — ${s.title}` : ""} — ${s.episodes.length} episode${s.episodes.length === 1 ? "" : "s"}`,
  }));
}

export function episodesForSeason(series: Series, seasonNumber: number): Episode[] {
  return series.seasons.find((s) => s.number === seasonNumber)?.episodes ?? [];
}

export function findEpisode(seriesList: Series[], episodeId: string): { series: Series; season: Season; episode: Episode } | null {
  for (const series of seriesList) {
    for (const season of series.seasons) {
      const episode = season.episodes.find((e) => e.id === episodeId);
      if (episode) return { series, season, episode };
    }
  }
  return null;
}

// --- Hero carousel ---------------------------------------------------------

export interface HeroItem {
  series: Series;
  reason: "featured" | "recently-updated";
}

/** Hero carousel ordering: featured series first (in catalog order),
 *  then the rest by most-recently-updated. Deterministic, no tracking
 *  signal involved — popularity never enters the order. */
export function heroCarouselOrder(seriesList: Series[], limit = 5): HeroItem[] {
  const featured = seriesList.filter((s) => s.featured).map((s) => ({ series: s, reason: "featured" as const }));
  const rest = seriesList
    .filter((s) => !s.featured)
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .map((s) => ({ series: s, reason: "recently-updated" as const }));
  return [...featured, ...rest].slice(0, limit);
}

// --- Time formatting -------------------------------------------------------

/** Seconds -> "14:22" (or "1:04:09" past an hour). */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "14:22" -> seconds. Returns null on malformed input: every part
 *  must be a non-empty run of digits (no fractions, no signs, no
 *  blanks — "14:", "1.5:30" and "-1:30" are all malformed), and
 *  seconds (and minutes in the h:mm:ss form) must be under 60, so
 *  "14:99" and "1:60:00" are rejected instead of silently meaning
 *  something else. Minutes in the mm:ss form are unbounded — a
 *  90-minute position is "90:00". */
export function parseTimestamp(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map((p) => Number(p));
  const seconds = nums[nums.length - 1] as number;
  if (seconds >= 60) return null;
  if (nums.length === 3) {
    const minutes = nums[1] as number;
    if (minutes >= 60) return null;
    return (nums[0] as number) * 3600 + minutes * 60 + seconds;
  }
  return (nums[0] as number) * 60 + seconds;
}

// --- Continue Watching (local IndexedDB-shaped store, never synced) --------

export interface WatchProgress {
  episodeId: string;
  positionSeconds: number;
  durationSeconds: number;
  watched: boolean;
  updatedAt: number; // unix ms — Continue Watching sort order
}

export interface ProgressStore {
  get(episodeId: string): Promise<WatchProgress | undefined>;
  put(progress: WatchProgress): Promise<void>;
  delete(episodeId: string): Promise<void>;
  getAll(): Promise<WatchProgress[]>;
}

export function createMemoryProgressStore(): ProgressStore {
  const map = new Map<string, WatchProgress>();
  return {
    async get(id) {
      return map.get(id);
    },
    async put(p) {
      map.set(p.episodeId, p);
    },
    async delete(id) {
      map.delete(id);
    },
    async getAll() {
      return [...map.values()];
    },
  };
}

/** Save a playback position. Positions past the end clamp to the end;
 *  within the last 10 seconds counts as watched (credits). */
export async function saveProgress(
  store: ProgressStore,
  episodeId: string,
  positionSeconds: number,
  durationSeconds: number,
  now = Date.now(),
): Promise<WatchProgress> {
  const position = Math.max(0, Math.min(positionSeconds, durationSeconds));
  const progress: WatchProgress = {
    episodeId,
    positionSeconds: position,
    durationSeconds,
    watched: durationSeconds > 0 && position >= durationSeconds - 10,
    updatedAt: now,
  };
  await store.put(progress);
  return progress;
}

/** Where playback resumes for an episode: the saved timestamp, e.g.
 *  episode-3 -> 14:22. Null when never watched. */
export async function resumePosition(
  store: ProgressStore,
  episodeId: string,
): Promise<{ positionSeconds: number; formatted: string; percent: number; remainingSeconds: number } | null> {
  const p = await store.get(episodeId);
  if (!p || p.watched) return null;
  return {
    positionSeconds: p.positionSeconds,
    formatted: formatTimestamp(p.positionSeconds),
    percent: p.durationSeconds > 0 ? Math.round((p.positionSeconds / p.durationSeconds) * 100) : 0,
    remainingSeconds: Math.max(0, p.durationSeconds - p.positionSeconds),
  };
}

export async function markWatched(store: ProgressStore, episodeId: string, durationSeconds: number, now = Date.now()): Promise<WatchProgress> {
  return saveProgress(store, episodeId, durationSeconds, durationSeconds, now);
}

export async function isWatched(store: ProgressStore, episodeId: string): Promise<boolean> {
  return (await store.get(episodeId))?.watched ?? false;
}

/** Continue Watching shelf: unfinished episodes, most recently watched
 *  first, each with its resume timestamp. Watched episodes never appear. */
export async function continueWatchingList(
  store: ProgressStore,
  catalog: Series[],
): Promise<Array<{ series: Series; season: Season; episode: Episode; resume: { positionSeconds: number; formatted: string; percent: number } }>> {
  const all = (await store.getAll()).filter((p) => !p.watched && p.positionSeconds > 0);
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  const out: Array<{ series: Series; season: Season; episode: Episode; resume: { positionSeconds: number; formatted: string; percent: number } }> = [];
  for (const p of all) {
    const found = findEpisode(catalog, p.episodeId);
    if (!found) continue; // episode left the catalog — drop it, don't crash
    out.push({
      ...found,
      resume: {
        positionSeconds: p.positionSeconds,
        formatted: formatTimestamp(p.positionSeconds),
        percent: found.episode.durationSeconds > 0 ? Math.round((p.positionSeconds / found.episode.durationSeconds) * 100) : 0,
      },
    });
  }
  return out;
}

// --- My List (private, local only, never synced) ---------------------------

export interface MyListEntry {
  seriesId: string;
  addedAt: number;
  /** Marker: this list never leaves the device. */
  syncStatus: "local-only";
}

export interface MyListStore {
  get(seriesId: string): Promise<MyListEntry | undefined>;
  put(entry: MyListEntry): Promise<void>;
  delete(seriesId: string): Promise<void>;
  getAll(): Promise<MyListEntry[]>;
}

export function createMemoryMyListStore(): MyListStore {
  const map = new Map<string, MyListEntry>();
  return {
    async get(id) {
      return map.get(id);
    },
    async put(e) {
      map.set(e.seriesId, e);
    },
    async delete(id) {
      map.delete(id);
    },
    async getAll() {
      return [...map.values()];
    },
  };
}

export async function addToMyList(store: MyListStore, seriesId: string, now = Date.now()): Promise<MyListEntry> {
  const entry: MyListEntry = { seriesId, addedAt: now, syncStatus: "local-only" };
  await store.put(entry);
  return entry;
}

export async function removeFromMyList(store: MyListStore, seriesId: string): Promise<void> {
  await store.delete(seriesId);
}

export async function isInMyList(store: MyListStore, seriesId: string): Promise<boolean> {
  return (await store.get(seriesId)) !== undefined;
}

/** My List contents, most recently added first. Local only — there is
 *  no sync/export path by design. */
export async function listMyList(store: MyListStore, catalog: Series[]): Promise<Series[]> {
  const entries = (await store.getAll()).sort((a, b) => b.addedAt - a.addedAt);
  const byId = new Map(catalog.map((s) => [s.id, s]));
  return entries.map((e) => byId.get(e.seriesId)).filter((s): s is Series => s !== undefined);
}

// --- IndexedDB stores (hunt 5) -------------------------------------------
// The app used to wire the MEMORY stores even in the browser, so
// Continue Watching and My List vanished on every reload — while the
// Watch panel promised positions are "stored locally in IndexedDB".
// These are the real IndexedDB stores (same open/transaction shape
// as the mail draft store); app.ts picks them when useIndexedDB is
// on. Same privacy rule as the memory stores: local only, never
// synced, never uploaded.

const IDB_DB = "arknetz-streaming";
const IDB_PROGRESS_STORE = "progress";
const IDB_MYLIST_STORE = "mylist";

function openStreamingDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_PROGRESS_STORE, { keyPath: "episodeId" });
      req.result.createObjectStore(IDB_MYLIST_STORE, { keyPath: "seriesId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idbReq = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function idbWithStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openStreamingDb();
  try {
    return await fn(db.transaction(storeName, mode).objectStore(storeName));
  } finally {
    db.close();
  }
}

/** Continue Watching positions in IndexedDB — survives reloads. */
export function createIndexedDBProgressStore(): ProgressStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  return {
    async get(episodeId) {
      return idbWithStore(IDB_PROGRESS_STORE, "readonly", (s) =>
        idbReq(s.get(episodeId) as IDBRequest<WatchProgress | undefined>),
      );
    },
    async put(p) {
      await idbWithStore(IDB_PROGRESS_STORE, "readwrite", async (s) => {
        await idbReq(s.put(p) as unknown as IDBRequest<IDBValidKey>);
      });
    },
    async delete(episodeId) {
      await idbWithStore(IDB_PROGRESS_STORE, "readwrite", async (s) => {
        await idbReq(s.delete(episodeId) as unknown as IDBRequest<undefined>);
      });
    },
    async getAll() {
      return idbWithStore(IDB_PROGRESS_STORE, "readonly", (s) =>
        idbReq(s.getAll() as IDBRequest<WatchProgress[]>),
      );
    },
  };
}

/** My List in IndexedDB — survives reloads, still local-only. */
export function createIndexedDBMyListStore(): MyListStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  return {
    async get(seriesId) {
      return idbWithStore(IDB_MYLIST_STORE, "readonly", (s) =>
        idbReq(s.get(seriesId) as IDBRequest<MyListEntry | undefined>),
      );
    },
    async put(e) {
      await idbWithStore(IDB_MYLIST_STORE, "readwrite", async (s) => {
        await idbReq(s.put(e) as unknown as IDBRequest<IDBValidKey>);
      });
    },
    async delete(seriesId) {
      await idbWithStore(IDB_MYLIST_STORE, "readwrite", async (s) => {
        await idbReq(s.delete(seriesId) as unknown as IDBRequest<undefined>);
      });
    },
    async getAll() {
      return idbWithStore(IDB_MYLIST_STORE, "readonly", (s) =>
        idbReq(s.getAll() as IDBRequest<MyListEntry[]>),
      );
    },
  };
}

// --- Click-to-play + HTTP Range seeking ------------------------------------

export interface PlayRequest {
  episodeId: string;
  src: string;
  /** Never autoplay — the viewer always taps play. */
  autoplay: false;
  /** Only metadata is preloaded; the video bytes wait for the tap. */
  preload: "metadata";
  resumeFromSeconds: number | null;
  resumeLabel: string | null;
}

/** Build a click-to-play request: no autoplay, metadata preload only,
 *  resume position attached when the viewer has one. */
export async function playRequest(store: ProgressStore, episode: Episode): Promise<PlayRequest> {
  const resume = await resumePosition(store, episode.id);
  return {
    episodeId: episode.id,
    src: episode.src,
    autoplay: false,
    preload: "metadata",
    resumeFromSeconds: resume ? resume.positionSeconds : null,
    resumeLabel: resume ? `Resume at ${resume.formatted}` : null,
  };
}

export interface RangeRequest {
  url: string;
  method: "GET";
  headers: { Range: string };
}

/** The exact Range request header for bytes [start, end] (inclusive).
 *  Open-ended when end is omitted: `Range: bytes=1048576-`. */
export function buildRangeRequest(url: string, startByte: number, endByte?: number): RangeRequest {
  if (!Number.isInteger(startByte) || startByte < 0) {
    throw new Error(`invalid Range start byte: ${startByte}`);
  }
  if (endByte !== undefined && (!Number.isInteger(endByte) || endByte < startByte)) {
    throw new Error(`invalid Range end byte: ${endByte} (start ${startByte})`);
  }
  return {
    url,
    method: "GET",
    headers: { Range: endByte === undefined ? `bytes=${startByte}-` : `bytes=${startByte}-${endByte}` },
  };
}

export interface ContentRange {
  start: number;
  end: number;
  total: number;
}

/** Parse a `Content-Range: bytes 0-1048575/52428800` response header. */
export function parseContentRange(header: string | null): ContentRange | null {
  if (!header) return null;
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

/** Resume logic: given the total file size and how many bytes are
 *  already downloaded, build the next Range request (or null when the
 *  file is complete). */
export function resumeRange(url: string, totalBytes: number, downloadedBytes: number): RangeRequest | null {
  if (downloadedBytes >= totalBytes) return null;
  return buildRangeRequest(url, downloadedBytes);
}

/** Estimate the byte offset for a seek to `positionSeconds` in a file
 *  of known duration and size. This is a proportional estimate — exact
 *  seeking waits for the player's buffered ranges / moov index; the
 *  estimate is what the UI shows before metadata loads. */
export function seekPositionToByte(positionSeconds: number, durationSeconds: number, totalBytes: number): number {
  if (durationSeconds <= 0 || totalBytes <= 0) return 0;
  const clamped = Math.max(0, Math.min(positionSeconds, durationSeconds));
  return Math.floor((clamped / durationSeconds) * totalBytes);
}

/** Faststart check for a 720p MP4: the moov atom must come BEFORE the
 *  mdat atom (ffmpeg `-movflags +faststart`), otherwise the player must
 *  download the whole file before it can start. Callers pass the byte
 *  offsets found by scanning the file header. */
export function checkFaststart(moovOffset: number | null, mdatOffset: number | null): { faststart: boolean; reason: string } {
  if (moovOffset === null) return { faststart: false, reason: "No moov atom found — the MP4 header is missing or corrupt." };
  if (mdatOffset === null) return { faststart: false, reason: "No mdat atom found — the MP4 has no media data." };
  if (moovOffset < mdatOffset) {
    return { faststart: true, reason: "moov atom is before mdat — the video can start before the full file downloads." };
  }
  return { faststart: false, reason: "moov atom is after mdat — re-encode with -movflags +faststart so playback can start immediately." };
}
