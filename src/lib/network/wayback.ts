// ArkNetzWebWeaver — Wayback Machine integration (thread turn 44).
// One-click "Snapshot to Wayback Machine" / "Preserve Snapshot" on Publish
// or from Site Settings, a built-in "Time Machine" viewer over the free
// Wayback CDX API, and automatic read-only failover to the latest preserved
// .json.zst snapshot if the primary repo is deleted or unreachable.
//
// Hard rule from the thread: Wayback archives public https:// URLs ONLY.
// It does not crawl arknetz:// directly. Snapshots are therefore taken of
// the site's underlying public raw URLs (e.g. the raw.githubusercontent.com
// URL of site.json.zst, or the exported gh-pages static HTML mirror).
//
// All network goes through an injected fetch function — no test or module
// here ever touches the real Wayback Machine.
//
// Licence: MIT. No new dependencies.

import type { NetworkFetch, NetworkRequestInit, NetworkResponse } from "./backends.js";

export const WAYBACK_BASE = "https://web.archive.org";
export const WAYBACK_SAVE_BASE = "https://web.archive.org/save";
export const WAYBACK_CDX_BASE = "https://web.archive.org/cdx/search/cdx";

/** A single Wayback capture, as returned by the CDX API. */
export interface WaybackSnapshot {
  /** 14-digit capture time, e.g. "20261120120000". */
  timestamp: string;
  /** The original URL that was captured. */
  original: string;
  statuscode: number;
  mimetype: string;
  /** Digest of the captured body (when the CDX query asks for it). */
  digest?: string;
  /** Viewable replay URL: https://web.archive.org/web/<ts>/<original> */
  waybackUrl: string;
  /** Raw captured bytes, no Wayback toolbar rewriting:
   *  https://web.archive.org/web/<ts>id_/<original> — this is the URL
   *  the failover path fetches, so a preserved .json.zst comes back
   *  byte-identical. */
  idUrl: string;
}

/** Reject anything Wayback cannot archive: only public https:// URLs. */
export function assertArchivableUrl(url: string): void {
  if (url.startsWith("arknetz://")) {
    throw new Error(
      `Wayback Machine cannot archive "${url}" — it archives public https:// URLs only, never arknetz:// directly. Snapshot the site's underlying public raw URL instead (e.g. its raw.githubusercontent.com site.json.zst, or the exported gh-pages static HTML mirror).`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL — Wayback needs a public https:// URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Wayback Machine archives public https:// URLs only — "${url}" uses ${parsed.protocol}`,
    );
  }
}

/**
 * The exact Save Page Now request shape for a public raw URL.
 * Save Page Now is a POST to https://web.archive.org/save/<url>
 * (a plain GET to the same URL also triggers a capture in a browser,
 * but the POST is the documented programmatic shape).
 */
export function buildSavePageNowRequest(publicUrl: string): {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  /** What the caller does with the response: a 200 means the capture was
   *  accepted; the response body/headers carry the capture status. */
  note: string;
} {
  assertArchivableUrl(publicUrl);
  return {
    method: "POST",
    url: `${WAYBACK_SAVE_BASE}/${publicUrl}`,
    headers: {
      Accept: "application/json",
      "User-Agent": "ArkNetzWebWeaver/1.0",
    },
    note: "POST to Save Page Now. A 200 means the capture was accepted; the archived copy may take seconds to minutes to become readable via the CDX API.",
  };
}

/** GET link form of Save Page Now (for display / opening in a tab). */
export function savePageNowUrl(publicUrl: string): string {
  assertArchivableUrl(publicUrl);
  return `${WAYBACK_SAVE_BASE}/${publicUrl}`;
}

/**
 * Build the free Wayback CDX API query for every historical snapshot of
 * a URL. Output is JSON rows: [timestamp, original, statuscode, mimetype,
 * digest], first row a header. Only successful (200) captures are listed,
 * collapsed by digest so re-captures of identical bytes do not flood the
 * list.
 */
export function buildCdxUrl(
  publicUrl: string,
  opts?: { limit?: number; from?: string; to?: string },
): string {
  assertArchivableUrl(publicUrl);
  const url = new URL(WAYBACK_CDX_BASE);
  url.searchParams.set("url", publicUrl);
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", "timestamp,original,statuscode,mimetype,digest");
  url.searchParams.set("filter", "statuscode:200");
  url.searchParams.set("collapse", "digest");
  if (opts?.from) url.searchParams.set("from", opts.from);
  if (opts?.to) url.searchParams.set("to", opts.to);
  if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
  return url.toString();
}

export function waybackUrlFor(snapshot: Pick<WaybackSnapshot, "timestamp" | "original">): string {
  return `${WAYBACK_BASE}/web/${snapshot.timestamp}/${snapshot.original}`;
}

export function waybackIdUrlFor(snapshot: Pick<WaybackSnapshot, "timestamp" | "original">): string {
  return `${WAYBACK_BASE}/web/${snapshot.timestamp}id_/${snapshot.original}`;
}

/** Parse CDX JSON output into snapshots. The first row is the header
 *  and is skipped; rows are [timestamp, original, statuscode, mimetype,
 *  digest]. Malformed rows are skipped, never fatal. */
export function parseCdxJson(raw: unknown): WaybackSnapshot[] {
  if (!Array.isArray(raw)) {
    throw new Error("CDX response is not a JSON array");
  }
  const out: WaybackSnapshot[] = [];
  for (let i = 1; i < raw.length; i++) {
    const row = raw[i] as unknown;
    if (!Array.isArray(row) || row.length < 4) continue;
    const [timestamp, original, statuscode, mimetype, digest] = row as unknown[];
    if (typeof timestamp !== "string" || !/^\d{14}$/.test(timestamp)) continue;
    if (typeof original !== "string" || !original) continue;
    const snap: WaybackSnapshot = {
      timestamp,
      original,
      statuscode: typeof statuscode === "string" ? Number(statuscode) : Number(statuscode ?? 0),
      mimetype: typeof mimetype === "string" ? mimetype : "",
      waybackUrl: "",
      idUrl: "",
    };
    if (typeof digest === "string" && digest) snap.digest = digest;
    snap.waybackUrl = waybackUrlFor(snap);
    snap.idUrl = waybackIdUrlFor(snap);
    out.push(snap);
  }
  return out;
}

/** The newest snapshot, or null when there is none. */
export function latestSnapshot(snapshots: WaybackSnapshot[]): WaybackSnapshot | null {
  if (snapshots.length === 0) return null;
  let best = snapshots[0] as WaybackSnapshot;
  for (const s of snapshots) {
    if (s.timestamp > best.timestamp) best = s;
  }
  return best;
}

/** Human-readable capture time, e.g. "2026-11-20 12:00 UTC". */
export function snapshotDisplayDate(snapshot: WaybackSnapshot): string {
  const t = snapshot.timestamp;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)} UTC`;
}

/** The Tauri shell's invoke bridge, when the app runs inside Tauri
 *  (window.__TAURI__ with withGlobalTauri). Null in a plain browser
 *  or in tests that do not install a mock. Mirrors auth.ts. */
type TauriCore = {
  core: { invoke(cmd: string, args?: unknown): Promise<unknown> };
};

function tauriCore(): TauriCore["core"] | null {
  const tauri = (globalThis as unknown as { __TAURI__?: TauriCore }).__TAURI__;
  return tauri?.core ?? null;
}

/** Result shape of the Rust `wayback_fetch` command (lib.rs). */
interface WaybackFetchResult {
  status: number;
  body?: string | null;
  error?: string | null;
}

/**
 * Fetch for web.archive.org URLs that works inside the Tauri WebView.
 * Hunt 5 (P1): web.archive.org/cdx sends no Access-Control-Allow-Origin
 * header, so a plain window.fetch from the app origin is CORS-blocked
 * in the WebView even though the device is online — every Time Machine
 * lookup failed with a bare "Failed to fetch". In Tauri the GET goes
 * through the Rust `wayback_fetch` command (reqwest, no CORS; the host
 * is restricted to web.archive.org server-side). Outside Tauri this is
 * the plain global fetch, so tests and plain browsers are unchanged.
 * The returned object is only the NetworkResponse shape listSnapshots
 * and fetchLatestSnapshot use (status + text()); headers are empty,
 * and the User-Agent header listSnapshots asks for is dropped on the
 * Rust path — the CDX API does not need it.
 */
export async function waybackFetch(
  url: string,
  init?: NetworkRequestInit,
): Promise<NetworkResponse> {
  const core = tauriCore();
  if (!core) {
    return globalThis.fetch(url, init);
  }
  const result = (await core.invoke("wayback_fetch", { url })) as WaybackFetchResult;
  if (typeof result.error === "string" && result.error) {
    throw new Error(result.error);
  }
  const body = typeof result.body === "string" ? result.body : "";
  return {
    status: result.status,
    headers: { get: (_name: string) => null },
    text: async () => body,
  };
}

/** Query the CDX API and list every historical snapshot for a URL. */
export async function listSnapshots(
  publicUrl: string,
  fetchFn: NetworkFetch,
  opts?: { limit?: number; from?: string; to?: string },
): Promise<WaybackSnapshot[]> {
  const url = buildCdxUrl(publicUrl, opts);
  const res = await fetchFn(url, {
    headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
  });
  if (res.status !== 200) {
    throw new Error(`Wayback CDX query failed with HTTP ${res.status}`);
  }
  return parseCdxJson(JSON.parse(await res.text()));
}

/** Fetch the newest preserved snapshot's raw bytes (via the id_ URL). */
export async function fetchLatestSnapshot(
  publicUrl: string,
  fetchFn: NetworkFetch,
): Promise<{ snapshot: WaybackSnapshot; body: string; status: number }> {
  const snapshots = await listSnapshots(publicUrl, fetchFn);
  const snapshot = latestSnapshot(snapshots);
  if (!snapshot) {
    throw new Error(`no Wayback Machine snapshot exists for ${publicUrl}`);
  }
  const res = await fetchFn(snapshot.idUrl, {
    headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
  });
  if (res.status !== 200) {
    throw new Error(
      `Wayback snapshot ${snapshot.timestamp} for ${publicUrl} failed with HTTP ${res.status}`,
    );
  }
  return { snapshot, body: await res.text(), status: res.status };
}

/**
 * Snapshot a public raw URL to the Wayback Machine (Save Page Now).
 * Returns the request that was sent and the HTTP status that came back.
 * The caller decides what to do with a non-200 (Wayback may rate-limit
 * or reject a URL); this function reports, never retries silently.
 */
export async function snapshotToWayback(
  publicUrl: string,
  fetchFn: NetworkFetch,
): Promise<{ request: ReturnType<typeof buildSavePageNowRequest>; status: number }> {
  const request = buildSavePageNowRequest(publicUrl);
  const res = await fetchFn(request.url, {
    method: request.method,
    headers: request.headers,
  });
  return { request, status: res.status };
}

export interface FailoverFetchResult {
  body: string;
  fromWayback: boolean;
  status: number;
  /** Present only when the body came from Wayback. */
  snapshot?: WaybackSnapshot;
}

/**
 * Automatic read-only failover (thread turn 44): fetch the primary URL;
 * on any failure (thrown error, or a non-200 status such as 404 when the
 * repo was deleted) fall back to the latest preserved .json.zst snapshot
 * from the Wayback Machine, fetched via its <timestamp>id_/ URL so the
 * bytes come back un-rewritten. The result says where the body came from
 * so the UI can label it "restored from Wayback snapshot <date>".
 * Throws only when BOTH the primary and Wayback fail, with both reasons.
 */
export async function fetchWithWaybackFailover(
  primaryUrl: string,
  fetchFn: NetworkFetch,
): Promise<FailoverFetchResult> {
  let primaryError: unknown = null;
  try {
    const res = await fetchFn(primaryUrl, {
      headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
    });
    if (res.status === 200) {
      return { body: await res.text(), fromWayback: false, status: 200 };
    }
    primaryError = new Error(`primary fetch failed with HTTP ${res.status}`);
  } catch (err) {
    primaryError = err;
  }
  try {
    const { snapshot, body, status } = await fetchLatestSnapshot(primaryUrl, fetchFn);
    return { body, fromWayback: true, status, snapshot };
  } catch (waybackError) {
    throw new Error(
      `primary fetch failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}) and Wayback failover failed (${waybackError instanceof Error ? waybackError.message : String(waybackError)}) — no copy of ${primaryUrl} is reachable`,
    );
  }
}
