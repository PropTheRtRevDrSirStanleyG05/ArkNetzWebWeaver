// ArkNetzWebWeaver — REGISTER issue watcher (D3 fix, 2026-11-21).
// The pending-claim copy promises "this screen updates when the
// issue closes" — but before this module nothing ever looked at the
// REGISTER issue again after filing it. This watcher GETs the issue's
// state with the signed-in user's OWN token, through the same
// GithubFetchFn layer Publish / collab use, and reports the claim as
// registered when the issue closes.
//
// NOTE on the live workflow: the issue-based contract below is what
// the client was built against (see domains.ts / site-repo.ts), but
// the LIVE register.yml in the 16 registry shards is PR-based
// (Ed25519 pubkey + endpoint), and Stanley's ruling on that
// divergence is still pending. Under the live PR-based workflow a
// REGISTER issue can never resolve — the watcher will keep reporting
// "pending" until it is stopped, and a 404/401 stops it with a plain
// reason instead of spinning. The watcher is written against the
// issue-based contract on purpose; when the ruling lands, the
// resolution signal (issue close vs PR merge) is the one thing that
// changes.

import { GITHUB_API_BASE } from "./config.js";
import type { GithubFetchFn } from "./publish.js";
import type { DomainClaim } from "./domains.js";

/** How often the watcher re-reads the issue while a pending claim is
 *  shown. 30 s: the bot usually finishes in 5–10 s, so the screen
 *  updates within ~one interval of the close, without burning the
 *  5,000/hr authenticated rate limit on a claim nobody is watching. */
export const CLAIM_WATCH_POLL_MS = 30_000;

/** The repo + number a REGISTER issue URL points at. Parses the
 *  html_url the claim flow stored (e.g.
 *  https://github.com/PropTheRtRevDrSirStanleyG05/arknetz-registry-0a/issues/42).
 *  Null when the URL is not a GitHub issue URL. */
export function parseRegisterIssueUrl(
  url: string | undefined | null,
): { owner: string; repo: string; number: number } | null {
  if (!url) return null;
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[?#].*)?$/.exec(url.trim());
  if (!m) return null;
  return { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) };
}

export type IssueStateResult =
  | { ok: true; state: "open" | "closed" }
  /** HTTP error (or a network failure, status 0). Never throws. */
  | { ok: false; status: number; reason: string };

/** One authenticated GET of a REGISTER issue's state — the existing
 *  GitHub Issues read shape (same endpoint + headers the comments /
 *  stats read path uses), no new API invented. The token is the
 *  signed-in user's own; null refuses before any call. */
export async function fetchRegisterIssueState(
  fetchFn: GithubFetchFn,
  input: { owner: string; repo: string; number: number; token: string | null },
): Promise<IssueStateResult> {
  if (!input.token) {
    return { ok: false, status: 0, reason: "no GitHub token — sign in to watch the claim" };
  }
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(input.owner)}` +
    `/${encodeURIComponent(input.repo)}/issues/${input.number}`;
  let res: { status: number; json(): Promise<unknown>; text(): Promise<string> };
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ArkNetzWebWeaver/1.0",
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: `could not reach GitHub to check issue #${input.number}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, reason: `issue #${input.number} in ${input.owner}/${input.repo} was not found (404)` };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, reason: `GitHub refused the issue check (401) — the sign-in may have expired` };
  }
  if (res.status !== 200) {
    const detail = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      reason: `checking issue #${input.number} failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    };
  }
  const body = (await res.json()) as { state?: unknown };
  if (body.state !== "open" && body.state !== "closed") {
    return { ok: false, status: 200, reason: `issue #${input.number} returned no usable state` };
  }
  return { ok: true, state: body.state };
}

export interface ClaimWatcherCallbacks {
  /** The issue closed: the claim is registered. The watcher stops. */
  onResolved: (claim: DomainClaim) => void;
  /** Watching cannot continue (no issue URL, 404, 401). The watcher
   *  stops; the claim itself stays pending — the caller says so
   *  plainly instead of pretending it resolved. */
  onFailed: (claim: DomainClaim, reason: string) => void;
  /** A transient check failed (network, 5xx, rate limit). The
   *  watcher keeps polling; the caller may show the reason. */
  onError?: (claim: DomainClaim, reason: string) => void;
}

export interface ClaimWatcherDeps {
  fetchFn: GithubFetchFn;
  /** The signed-in user's own token, read fresh per check. */
  getToken: () => string | null;
  /** Poll interval ms (default CLAIM_WATCH_POLL_MS). */
  pollMs?: number;
  /** Timer injection (tests drive pollOnce by hand). */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}

/** Polls one pending claim's REGISTER issue until it closes, fails
 *  terminally, or is stopped. One watcher per pending claim; the
 *  shell starts it when the claim is shown and stops it when the
 *  panel/editor closes or the claim resolves. Never throws from
 *  pollOnce — every failure is a callback. */
export class ClaimWatcher {
  private readonly fetchFn: GithubFetchFn;
  private readonly getToken: () => string | null;
  private readonly pollMs: number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;
  private readonly callbacks: ClaimWatcherCallbacks;
  private claim: DomainClaim | null = null;
  private target: { owner: string; repo: string; number: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(deps: ClaimWatcherDeps, callbacks: ClaimWatcherCallbacks) {
    this.fetchFn = deps.fetchFn;
    this.getToken = deps.getToken;
    this.pollMs = deps.pollMs ?? CLAIM_WATCH_POLL_MS;
    this.setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((id) => clearInterval(id));
    this.callbacks = callbacks;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get watchedClaim(): DomainClaim | null {
    return this.claim;
  }

  /** Start watching a pending claim: one check now, then every
   *  pollMs. A claim with no usable issue URL fails at once (the
   *  watcher never spins on a claim it cannot check). Starting a
   *  second claim stops the first. */
  start(claim: DomainClaim): void {
    this.stop();
    this.claim = claim;
    this.target = parseRegisterIssueUrl(claim.issueUrl);
    if (!this.target) {
      this.claim = null;
      this.callbacks.onFailed(
        claim,
        "this claim has no REGISTER issue to watch — check the claim in the registry repo directly",
      );
      return;
    }
    this.timer = this.setIntervalFn(() => {
      void this.pollOnce();
    }, this.pollMs);
    void this.pollOnce();
  }

  /** Stop watching. Safe to call when not running. */
  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.claim = null;
    this.target = null;
  }

  /** One check of the watched issue. Safe to call by hand (tests)
   *  and from the timer. Never throws. */
  async pollOnce(): Promise<void> {
    const claim = this.claim;
    const target = this.target;
    if (!claim || !target || this.polling) return;
    this.polling = true;
    try {
      const result = await fetchRegisterIssueState(this.fetchFn, {
        ...target,
        token: this.getToken(),
      });
      if (!result.ok) {
        if (result.status === 404 || result.status === 401) {
          // Terminal: the issue is gone, or this token can no longer
          // read it. Stop — polling again would spin forever on the
          // same answer.
          const stopped = this.claim;
          this.stop();
          if (stopped) this.callbacks.onFailed(stopped, result.reason);
        } else {
          // Transient (network, 5xx, rate limit): keep polling.
          this.callbacks.onError?.(claim, result.reason);
        }
        return;
      }
      if (result.state === "closed") {
        this.stop();
        this.callbacks.onResolved(claim);
      }
      // "open" stays pending: nothing to do until the next poll.
    } finally {
      this.polling = false;
    }
  }
}
