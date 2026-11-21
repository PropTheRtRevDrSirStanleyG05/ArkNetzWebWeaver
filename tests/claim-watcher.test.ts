// Tests: the REGISTER issue watcher (D3 fix, pass 1). The pending
// claim promises "this screen updates when the issue closes" — the
// watcher is what looks at the issue again. All GitHub calls go to
// a mocked fetch — no test touches real GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ClaimWatcher,
  fetchRegisterIssueState,
  parseRegisterIssueUrl,
} from "../src/lib/claim-watcher.js";
import type { GithubFetchFn } from "../src/lib/publish.js";
import type { DomainClaim } from "../src/lib/domains.js";

const ISSUE_URL =
  "https://github.com/PropTheRtRevDrSirStanleyG05/arknetz-registry-0a/issues/42";

function pendingClaim(issueUrl: string | null = ISSUE_URL): DomainClaim {
  return {
    domain: "computers.edu",
    claimant: "alice",
    status: "pending",
    issueNumber: 42,
    issueUrl: issueUrl ?? undefined,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

/** A fetch that answers the issue GET with a canned state/status and
 *  records every call (URL + auth header). */
function issueFetch(answer: { status: number; state?: string }): {
  fetchFn: GithubFetchFn;
  calls: Array<{ url: string; auth: string | undefined }>;
} {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchFn: GithubFetchFn = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return {
      status: answer.status,
      json: async () => ({ state: answer.state }),
      text: async () => (answer.status === 200 ? "" : `HTTP ${answer.status}`),
    };
  };
  return { fetchFn, calls };
}

test("parseRegisterIssueUrl: a REGISTER issue URL parses; anything else is null", () => {
  assert.deepEqual(parseRegisterIssueUrl(ISSUE_URL), {
    owner: "PropTheRtRevDrSirStanleyG05",
    repo: "arknetz-registry-0a",
    number: 42,
  });
  assert.deepEqual(
    parseRegisterIssueUrl("https://github.com/o/r/issues/7?x=1"),
    { owner: "o", repo: "r", number: 7 },
  );
  assert.equal(parseRegisterIssueUrl("https://github.com/o/r/pull/7"), null);
  assert.equal(parseRegisterIssueUrl("https://example.com/o/r/issues/7"), null);
  assert.equal(parseRegisterIssueUrl(""), null);
  assert.equal(parseRegisterIssueUrl(undefined), null);
});

test("fetchRegisterIssueState: open and closed read through the existing Issues GET, with the user's token", async () => {
  const { fetchFn, calls } = issueFetch({ status: 200, state: "open" });
  const open = await fetchRegisterIssueState(fetchFn, {
    owner: "PropTheRtRevDrSirStanleyG05",
    repo: "arknetz-registry-0a",
    number: 42,
    token: "tok-alice",
  });
  assert.deepEqual(open, { ok: true, state: "open" });
  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/PropTheRtRevDrSirStanleyG05/arknetz-registry-0a/issues/42",
  );
  assert.equal(calls[0]?.auth, "Bearer tok-alice");

  const closedFetch = issueFetch({ status: 200, state: "closed" });
  const closed = await fetchRegisterIssueState(closedFetch.fetchFn, {
    owner: "PropTheRtRevDrSirStanleyG05",
    repo: "arknetz-registry-0a",
    number: 42,
    token: "tok-alice",
  });
  assert.deepEqual(closed, { ok: true, state: "closed" });
});

test("fetchRegisterIssueState: 404/401/500 and no token are results, never throws", async () => {
  const notFound = await fetchRegisterIssueState(issueFetch({ status: 404 }).fetchFn, {
    owner: "o",
    repo: "r",
    number: 42,
    token: "tok",
  });
  assert.equal(notFound.ok, false);
  if (!notFound.ok) assert.equal(notFound.status, 404);

  const denied = await fetchRegisterIssueState(issueFetch({ status: 401 }).fetchFn, {
    owner: "o",
    repo: "r",
    number: 42,
    token: "tok",
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 401);

  const server = await fetchRegisterIssueState(issueFetch({ status: 500 }).fetchFn, {
    owner: "o",
    repo: "r",
    number: 42,
    token: "tok",
  });
  assert.equal(server.ok, false);
  if (!server.ok) assert.equal(server.status, 500);

  const noToken = await fetchRegisterIssueState(issueFetch({ status: 200, state: "open" }).fetchFn, {
    owner: "o",
    repo: "r",
    number: 42,
    token: null,
  });
  assert.equal(noToken.ok, false);
  if (!noToken.ok) assert.equal(noToken.status, 0);

  const downFetch: GithubFetchFn = async () => {
    throw new Error("network down");
  };
  const down = await fetchRegisterIssueState(downFetch, {
    owner: "o",
    repo: "r",
    number: 42,
    token: "tok",
  });
  assert.equal(down.ok, false);
  if (!down.ok) assert.equal(down.status, 0);
});

// --- ClaimWatcher -----------------------------------------------------------

interface FakeTimers {
  setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;
  scheduled: Array<{ fn: () => void; ms: number; id: number }>;
  cleared: number[];
}

function fakeTimers(): FakeTimers {
  const scheduled: Array<{ fn: () => void; ms: number; id: number }> = [];
  const cleared: number[] = [];
  let nextId = 1;
  return {
    scheduled,
    cleared,
    setIntervalFn: (fn, ms) => {
      const id = nextId++;
      scheduled.push({ fn, ms, id });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: (id) => {
      cleared.push(id as unknown as number);
    },
  };
}

function watch(
  fetchFn: GithubFetchFn,
  timers: FakeTimers,
  events: { resolved: DomainClaim[]; failed: Array<{ claim: DomainClaim; reason: string }>; errors: string[] },
): ClaimWatcher {
  return new ClaimWatcher(
    { fetchFn, getToken: () => "tok-alice", ...timers },
    {
      onResolved: (claim) => events.resolved.push(claim),
      onFailed: (claim, reason) => events.failed.push({ claim, reason }),
      onError: (_claim, reason) => events.errors.push(reason),
    },
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("watcher: an open issue stays pending (keeps polling); a closed issue becomes registered and stops", async () => {
  const timers = fakeTimers();
  const events = { resolved: [] as DomainClaim[], failed: [] as Array<{ claim: DomainClaim; reason: string }>, errors: [] as string[] };
  const { fetchFn, calls } = issueFetch({ status: 200, state: "open" });
  const watcher = watch(fetchFn, timers, events);
  watcher.start(pendingClaim());
  await flush();
  assert.equal(watcher.running, true);
  assert.equal(calls.length, 1, "one check on start");
  assert.equal(events.resolved.length, 0);
  assert.equal(events.failed.length, 0);
  // A second poll, still open: still pending, still running.
  await watcher.pollOnce();
  assert.equal(calls.length, 2);
  assert.equal(watcher.running, true);
  assert.equal(events.resolved.length, 0);

  // The bot closes the issue: the next check resolves and stops.
  const closed = issueFetch({ status: 200, state: "closed" });
  const watcher2 = watch(closed.fetchFn, fakeTimers(), events);
  watcher2.start(pendingClaim());
  await flush();
  assert.deepEqual(events.resolved.map((c) => c.domain), ["computers.edu"]);
  assert.equal(watcher2.running, false, "resolved claims stop polling");
  assert.equal(closed.calls.length, 1, "no check after resolving");
  await watcher2.pollOnce();
  assert.equal(closed.calls.length, 1, "a stopped watcher never polls again");
  watcher.stop();
});

test("watcher: 404/401 stop without crashing and without spinning", async () => {
  for (const status of [404, 401]) {
    const timers = fakeTimers();
    const events = { resolved: [] as DomainClaim[], failed: [] as Array<{ claim: DomainClaim; reason: string }>, errors: [] as string[] };
    const { fetchFn, calls } = issueFetch({ status });
    const watcher = watch(fetchFn, timers, events);
    watcher.start(pendingClaim());
    await flush();
    assert.equal(events.failed.length, 1, `HTTP ${status} reports failure`);
    assert.match(events.failed[0]?.reason ?? "", new RegExp(String(status)));
    assert.equal(watcher.running, false, `HTTP ${status} stops the watcher`);
    assert.deepEqual(timers.cleared.length, 1, "the interval is cleared");
    await watcher.pollOnce();
    assert.equal(calls.length, 1, `no spinning after HTTP ${status}`);
  }
});

test("watcher: a transient failure keeps polling and reports the error", async () => {
  const timers = fakeTimers();
  const events = { resolved: [] as DomainClaim[], failed: [] as Array<{ claim: DomainClaim; reason: string }>, errors: [] as string[] };
  const { fetchFn, calls } = issueFetch({ status: 500 });
  const watcher = watch(fetchFn, timers, events);
  watcher.start(pendingClaim());
  await flush();
  assert.equal(events.failed.length, 0, "a 500 is not terminal");
  assert.equal(events.errors.length, 1);
  assert.equal(watcher.running, true, "still polling after a transient failure");
  await watcher.pollOnce();
  assert.equal(calls.length, 2, "the next poll still runs");
  watcher.stop();
});

test("watcher: a claim with no usable issue URL fails at once and never fetches", async () => {
  const timers = fakeTimers();
  const events = { resolved: [] as DomainClaim[], failed: [] as Array<{ claim: DomainClaim; reason: string }>, errors: [] as string[] };
  const { fetchFn, calls } = issueFetch({ status: 200, state: "open" });
  const watcher = watch(fetchFn, timers, events);
  watcher.start(pendingClaim(null));
  await flush();
  assert.equal(events.failed.length, 1);
  assert.equal(calls.length, 0, "no fetch without an issue to check");
  assert.equal(watcher.running, false);
  assert.equal(timers.scheduled.length, 0, "no interval scheduled");
});

test("watcher: stop() halts the interval; starting a second claim stops the first", async () => {
  const timers = fakeTimers();
  const events = { resolved: [] as DomainClaim[], failed: [] as Array<{ claim: DomainClaim; reason: string }>, errors: [] as string[] };
  const { fetchFn } = issueFetch({ status: 200, state: "open" });
  const watcher = watch(fetchFn, timers, events);
  watcher.start(pendingClaim());
  await flush();
  assert.equal(watcher.running, true);
  assert.equal(timers.scheduled.length, 1);
  watcher.start(pendingClaim("https://github.com/o/r/issues/9"));
  await flush();
  assert.deepEqual(timers.cleared, [1], "starting a second claim clears the first interval");
  assert.equal(watcher.running, true);
  watcher.stop();
  assert.equal(watcher.running, false);
  assert.deepEqual(timers.cleared, [1, 2]);
  assert.equal(watcher.watchedClaim, null);
});
