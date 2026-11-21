// Domain claim that actually opens the site (2026-11-21).
// End-to-end claim flow with a mocked GitHub API — no real network:
//   claim -> site repo created -> REGISTER issue opened in the right
//   shard repo -> starter site seeded -> onSiteOpened fires.
// Plus the refusal paths: not signed in, repo already exists,
// API failure, and domain validation.
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  SIGN_IN_TO_CLAIM_MESSAGE,
  claimDomainAndOpenSite,
  shardForDomain,
  validateDomain,
} from "../src/lib/domains.js";
import {
  buildStarterSiteDocument,
  createSiteRepo,
  githubWriteError,
  openRegisterIssue,
  registryEntryForClaim,
  seedSiteRepo,
} from "../src/lib/site-repo.js";
import { buildRegisterIssue } from "../src/lib/domains.js";
import { validateDocument } from "../src/lib/blocks.js";
import { parseSiteDocument } from "../src/lib/registry.js";
import { MASTER_GITHUB_USER, registryShardRepo } from "../src/lib/config.js";
import { buildSiteOpenedViewModel, claimSteps } from "../src/lib/domains-ui.js";
import type { GithubFetchFn } from "../src/lib/publish.js";

const TOKEN = "gho_test-token";
const LOGIN = "alice";
const DOMAIN = "computers.edu";
const REPO = "arknetz-site-computers-edu";
const REPO_URL = `https://github.com/${LOGIN}/${REPO}`;

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A mock GitHub API: routes are matched in order; every call is
 *  recorded so tests can assert exactly what was (and was not) sent. */
function mockGithub(
  routes: Array<{
    method: string;
    match: (url: string) => boolean;
    status: number;
    body: unknown;
  }>,
): { fetchFn: GithubFetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: GithubFetchFn = async (url, init) => {
    let body: unknown;
    try {
      body = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init.body;
    }
    calls.push({ method: init.method, url, headers: init.headers, body });
    const route = routes.find((r) => r.method === init.method && r.match(url));
    if (!route) throw new Error(`mock GitHub: unexpected ${init.method} ${url}`);
    return jsonResponse(route.status, route.body);
  };
  return { fetchFn, calls };
}

function isCreateRepo(url: string): boolean {
  return url === "https://api.github.com/user/repos";
}
function isIssuePost(shardRepo: string): (url: string) => boolean {
  return (url) =>
    url ===
    `https://api.github.com/repos/${MASTER_GITHUB_USER}/${shardRepo}/issues`;
}
function isContents(url: string): boolean {
  return url === `https://api.github.com/repos/${LOGIN}/${REPO}/contents/site.json`;
}
function isRepoGet(url: string): boolean {
  return url === `https://api.github.com/repos/${LOGIN}/${REPO}`;
}

/** The happy-path route set: repo create 201, issue 201, seed GET
 *  404 then PUT 201. `shardRepo` is the domain's real shard repo. */
function happyRoutes(shardRepo: string) {
  return [
    { method: "POST", match: isCreateRepo, status: 201, body: { html_url: REPO_URL } },
    {
      method: "POST",
      match: isIssuePost(shardRepo),
      status: 201,
      body: { number: 42, html_url: `https://github.com/${MASTER_GITHUB_USER}/${shardRepo}/issues/42` },
    },
    { method: "GET", match: isContents, status: 404, body: { message: "Not Found" } },
    { method: "PUT", match: isContents, status: 201, body: { commit: { sha: "abc123" } } },
  ];
}

test("happy path: claim -> repo created -> issue opened -> seeded -> onSiteOpened fires", async () => {
  const shard = await shardForDomain(DOMAIN);
  const shardRepo = registryShardRepo(shard);
  const { fetchFn, calls } = mockGithub(happyRoutes(shardRepo));
  const opened: unknown[] = [];
  const result = await claimDomainAndOpenSite({
    domainInput: DOMAIN,
    token: TOKEN,
    login: LOGIN,
    acceptedTerms: true,
    fetchFn,
    onSiteOpened: (o) => opened.push(o),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.domain, DOMAIN);
  assert.equal(result.repo, REPO);
  assert.equal(result.repoUrl, REPO_URL);
  assert.equal(result.issueUrl, `https://github.com/${MASTER_GITHUB_USER}/${shardRepo}/issues/42`);
  assert.equal(result.claim.status, "pending");
  assert.equal(result.claim.issueNumber, 42);
  assert.equal(result.claim.domain, DOMAIN);
  assert.equal(result.claim.claimant, LOGIN);
  assert.equal(result.alreadyExistedRepo, false);
  assert.equal(result.alreadySeeded, false);
  // The registry entry is the exact shape register.yml commits —
  // but it is NOT live yet: the claim is pending until the bot
  // processes the issue.
  assert.deepEqual(result.registryEntry, {
    domain: DOMAIN,
    backend: `gh:${LOGIN}/${REPO}`,
    shard,
    owner: LOGIN,
  });

  // onSiteOpened fired exactly once, with the right domain + repo,
  // and the opened document is the starter (hero + h1 + p).
  assert.equal(opened.length, 1);
  const openedSite = opened[0] as typeof result;
  assert.equal(openedSite.domain, DOMAIN);
  assert.equal(openedSite.repo, REPO);
  assert.equal(openedSite.doc.domain, DOMAIN);
  assert.deepEqual(
    openedSite.doc.blocks.map((b) => b.type),
    ["hero", "h1", "p"],
  );
  assert.deepEqual(result.doc, openedSite.doc);

  // Call order + payloads: repo create, then issue, then seed GET, then PUT.
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [
      "POST https://api.github.com/user/repos",
      `POST https://api.github.com/repos/${MASTER_GITHUB_USER}/${shardRepo}/issues`,
      `GET https://api.github.com/repos/${LOGIN}/${REPO}/contents/site.json`,
      `PUT https://api.github.com/repos/${LOGIN}/${REPO}/contents/site.json`,
    ],
  );
  const createCall = calls[0] as RecordedCall;
  assert.equal(createCall.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(createCall.body, {
    name: REPO,
    description: `ArkNetzWebWeaver site for ${DOMAIN}`,
    private: false,
    auto_init: true,
  });
  const issueCall = calls[1] as RecordedCall;
  const issueBody = issueCall.body as { title: string; body: string };
  assert.equal(issueBody.title, `REGISTER: ${DOMAIN}`);
  assert.match(issueBody.body, new RegExp(`Claimed by: @${LOGIN}`));
  assert.match(issueBody.body, /Terms accepted: yes/);
  // The seeded file is the starter document, base64 plain JSON.
  const putCall = calls[3] as RecordedCall;
  const putBody = putCall.body as { content: string; message: string; branch: string };
  assert.equal(putBody.branch, "main");
  const seeded = parseSiteDocument(
    JSON.parse(Buffer.from(putBody.content, "base64").toString("utf8")),
  );
  assert.equal(seeded.domain, DOMAIN);
  assert.deepEqual(
    seeded.blocks.map((b) => b.type),
    ["hero", "h1", "p"],
  );
  assert.deepEqual(validateDocument(seeded), []);
});

test("not signed in: exact refusal, no GitHub calls, hook never fires", async () => {
  for (const signedOut of [
    { token: null, login: LOGIN },
    { token: TOKEN, login: null },
    { token: null, login: null },
  ]) {
    const { fetchFn, calls } = mockGithub([]);
    let fired = false;
    const result = await claimDomainAndOpenSite({
      domainInput: DOMAIN,
      token: signedOut.token,
      login: signedOut.login,
      acceptedTerms: true,
      fetchFn,
      onSiteOpened: () => {
        fired = true;
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.reason, SIGN_IN_TO_CLAIM_MESSAGE);
    assert.equal(result.reason, "Sign in with GitHub first to claim a domain");
    assert.equal(result.stage, "not_signed_in");
    assert.equal(calls.length, 0, "no GitHub call may happen while signed out");
    assert.equal(fired, false);
  }
});

test("repo already exists: 422 -> GET confirms -> reused, claim continues", async () => {
  const shard = await shardForDomain(DOMAIN);
  const shardRepo = registryShardRepo(shard);
  const { fetchFn, calls } = mockGithub([
    {
      method: "POST",
      match: isCreateRepo,
      status: 422,
      body: { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] },
    },
    { method: "GET", match: isRepoGet, status: 200, body: { html_url: REPO_URL } },
    {
      method: "POST",
      match: isIssuePost(shardRepo),
      status: 201,
      body: { number: 7, html_url: `https://github.com/${MASTER_GITHUB_USER}/${shardRepo}/issues/7` },
    },
    { method: "GET", match: isContents, status: 404, body: { message: "Not Found" } },
    { method: "PUT", match: isContents, status: 201, body: { commit: { sha: "def456" } } },
  ]);
  const opened: unknown[] = [];
  const result = await claimDomainAndOpenSite({
    domainInput: DOMAIN,
    token: TOKEN,
    login: LOGIN,
    acceptedTerms: true,
    fetchFn,
    onSiteOpened: (o) => opened.push(o),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.alreadyExistedRepo, true);
  assert.equal(result.repoUrl, REPO_URL);
  assert.equal(result.claim.issueNumber, 7);
  assert.equal(opened.length, 1);
  assert.equal(calls.filter((c) => c.method === "POST" && isCreateRepo(c.url)).length, 1);
});

test("reused repo with an existing site: site.json is kept, never overwritten", async () => {
  const shard = await shardForDomain(DOMAIN);
  const shardRepo = registryShardRepo(shard);
  const existingDoc = {
    domain: DOMAIN,
    title: "My real site",
    blocks: [{ type: "h1", text: "Already mine" }],
  };
  const { fetchFn, calls } = mockGithub([
    {
      method: "POST",
      match: isCreateRepo,
      status: 422,
      body: { message: "name already exists on this account" },
    },
    { method: "GET", match: isRepoGet, status: 200, body: { html_url: REPO_URL } },
    {
      method: "POST",
      match: isIssuePost(shardRepo),
      status: 201,
      body: { number: 8, html_url: `https://github.com/${MASTER_GITHUB_USER}/${shardRepo}/issues/8` },
    },
    {
      method: "GET",
      match: isContents,
      status: 200,
      body: {
        content: Buffer.from(JSON.stringify(existingDoc)).toString("base64"),
        encoding: "base64",
        sha: "existing-sha",
      },
    },
  ]);
  const opened: unknown[] = [];
  const result = await claimDomainAndOpenSite({
    domainInput: DOMAIN,
    token: TOKEN,
    login: LOGIN,
    acceptedTerms: true,
    fetchFn,
    onSiteOpened: (o) => opened.push(o),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.alreadySeeded, true);
  assert.equal(result.doc.title, "My real site");
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "existing site.json must not be overwritten");
  assert.equal(opened.length, 1);
});

test("repo creation 403: plain-language error, nothing further created", async () => {
  const { fetchFn, calls } = mockGithub([
    {
      method: "POST",
      match: isCreateRepo,
      status: 403,
      body: { message: "Resource not accessible by integration" },
    },
  ]);
  let fired = false;
  const result = await claimDomainAndOpenSite({
    domainInput: DOMAIN,
    token: TOKEN,
    login: LOGIN,
    acceptedTerms: true,
    fetchFn,
    onSiteOpened: () => {
      fired = true;
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "create_repo");
  assert.match(result.reason, /GitHub refused to create the site repo/);
  assert.match(result.reason, /HTTP 403/);
  assert.match(result.reason, /public_repo/);
  assert.equal(calls.length, 1, "only the repo create was attempted");
  assert.equal(fired, false);
});

test("issue creation fails: repo exists but claim is not filed, seed never runs", async () => {
  const shard = await shardForDomain(DOMAIN);
  const shardRepo = registryShardRepo(shard);
  const { fetchFn, calls } = mockGithub([
    { method: "POST", match: isCreateRepo, status: 201, body: { html_url: REPO_URL } },
    {
      method: "POST",
      match: isIssuePost(shardRepo),
      status: 500,
      body: { message: "Internal Server Error" },
    },
  ]);
  let fired = false;
  const result = await claimDomainAndOpenSite({
    domainInput: DOMAIN,
    token: TOKEN,
    login: LOGIN,
    acceptedTerms: true,
    fetchFn,
    onSiteOpened: () => {
      fired = true;
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "register_issue");
  assert.match(result.reason, new RegExp(`The site repo ${REPO} was created`));
  assert.match(result.reason, /could not be filed/);
  assert.match(result.reason, /Nothing is registered yet/);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  assert.equal(fired, false);
});

test("seed failure: repo + issue already exist and the reason says so", async () => {
  const shard = await shardForDomain(DOMAIN);
  const shardRepo = registryShardRepo(shard);
  const { fetchFn, calls } = mockGithub([
    { method: "POST", match: isCreateRepo, status: 201, body: { html_url: REPO_URL } },
    {
      method: "POST",
      match: isIssuePost(shardRepo),
      status: 201,
      body: { number: 9, html_url: `https://github.com/${MASTER_GITHUB_USER}/${shardRepo}/issues/9` },
    },
    { method: "GET", match: isContents, status: 404, body: { message: "Not Found" } },
    { method: "PUT", match: isContents, status: 422, body: { message: "Invalid request." } },
  ]);
  let fired = false;
  const result = await claimDomainAndOpenSite({
    domainInput: DOMAIN,
    token: TOKEN,
    login: LOGIN,
    acceptedTerms: true,
    fetchFn,
    onSiteOpened: () => {
      fired = true;
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "seed_site");
  assert.match(result.reason, new RegExp(`The site repo ${REPO} was created`));
  assert.match(result.reason, /claim for "computers\.edu" was filed/);
  assert.match(result.reason, /still pending with the register bot/);
  assert.equal(calls.length, 4);
  assert.equal(fired, false);
});

test("domain validation still rejects TLD-only and reserved words before any API call", async () => {
  for (const bad of ["edu", "admin.edu", "my..edu", ""]) {
    const { fetchFn, calls } = mockGithub([]);
    let fired = false;
    const result = await claimDomainAndOpenSite({
      domainInput: bad,
      token: TOKEN,
      login: LOGIN,
      acceptedTerms: true,
      fetchFn,
      onSiteOpened: () => {
        fired = true;
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.stage, "validation");
    assert.equal(calls.length, 0);
    assert.equal(fired, false);
  }
  assert.equal(validateDomain("edu").code, "tld_only");
  assert.equal(validateDomain("admin.edu").code, "banned_word");
});

test("terms not accepted: refused before any API call", async () => {
  const { fetchFn, calls } = mockGithub([]);
  const result = await claimDomainAndOpenSite({
    domainInput: DOMAIN,
    token: TOKEN,
    login: LOGIN,
    acceptedTerms: false,
    fetchFn,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, "terms");
  assert.match(result.reason, /Terms/);
  assert.equal(calls.length, 0);
});

test("starter document is a minimal valid SiteDocument (hero + h1 + p)", () => {
  const doc = buildStarterSiteDocument(DOMAIN);
  assert.equal(doc.domain, DOMAIN);
  assert.deepEqual(
    doc.blocks.map((b) => b.type),
    ["hero", "h1", "p"],
  );
  assert.deepEqual(validateDocument(doc), []);
  assert.deepEqual(parseSiteDocument(JSON.parse(JSON.stringify(doc))).domain, DOMAIN);
});

test("registry entry shape matches what register.yml commits", async () => {
  const shard = await shardForDomain(DOMAIN);
  assert.deepEqual(await registryEntryForClaim(DOMAIN, LOGIN), {
    domain: DOMAIN,
    backend: `gh:${LOGIN}/${REPO}`,
    shard,
    owner: LOGIN,
  });
});

test("site-repo helpers: createSiteRepo reuse + openRegisterIssue + seed validation", async () => {
  // createSiteRepo reuses an existing repo on 422.
  const { fetchFn } = mockGithub([
    { method: "POST", match: isCreateRepo, status: 422, body: { message: "name already exists" } },
    { method: "GET", match: isRepoGet, status: 200, body: { html_url: REPO_URL } },
  ]);
  assert.deepEqual(await createSiteRepo({ token: TOKEN, owner: LOGIN, domain: DOMAIN, fetchFn }), {
    repo: REPO,
    url: REPO_URL,
    alreadyExisted: true,
  });

  // openRegisterIssue files in the domain's shard repo, with the
  // REGISTER title from the existing builder.
  const shard = await shardForDomain(DOMAIN);
  const shardRepo = registryShardRepo(shard);
  const { fetchFn: issueFetch } = mockGithub([
    {
      method: "POST",
      match: isIssuePost(shardRepo),
      status: 201,
      body: { number: 11, html_url: `https://github.com/${MASTER_GITHUB_USER}/${shardRepo}/issues/11` },
    },
  ]);
  assert.deepEqual(
    await openRegisterIssue({
      token: TOKEN,
      issue: buildRegisterIssue(DOMAIN, LOGIN, { acceptedTerms: true }),
      fetchFn: issueFetch,
    }),
    {
      issueNumber: 11,
      issueUrl: `https://github.com/${MASTER_GITHUB_USER}/${shardRepo}/issues/11`,
      shardRepo,
    },
  );

  // seedSiteRepo refuses an invalid document before any write.
  const { fetchFn: seedFetch, calls } = mockGithub([]);
  await assert.rejects(
    () =>
      seedSiteRepo({
        token: TOKEN,
        owner: LOGIN,
        repo: REPO,
        doc: { domain: "", title: "", blocks: [] },
        fetchFn: seedFetch,
      }),
    /starter document has/,
  );
  assert.equal(calls.length, 0);

  // Plain-language GitHub errors name the status and the remedy.
  assert.match(githubWriteError(401, "create the site repo x"), /HTTP 401/);
  assert.match(githubWriteError(401, "create the site repo x"), /Sign in with GitHub again/);
  assert.match(githubWriteError(403, "create the site repo x"), /public_repo/);
});

test("site-opened view-model says the claim is pending while the site is editable", () => {
  const vm = buildSiteOpenedViewModel({
    domain: DOMAIN,
    repo: REPO,
    repoUrl: REPO_URL,
    issueUrl: `https://github.com/${MASTER_GITHUB_USER}/arknetz-registry-00/issues/42`,
    alreadyExistedRepo: false,
    alreadySeeded: false,
  });
  assert.equal(vm.heading, "Your site is open — start building");
  assert.match(vm.message, /computers\.edu/);
  assert.match(vm.pendingNote, /waiting for the register bot/);
  assert.match(vm.pendingNote, /5 to 10 seconds/);
  assert.equal(vm.reusedRepo, false);
  assert.equal(vm.keptExistingSite, false);

  const kept = buildSiteOpenedViewModel({
    domain: DOMAIN,
    repo: REPO,
    repoUrl: REPO_URL,
    issueUrl: "https://example.invalid/1",
    alreadyExistedRepo: true,
    alreadySeeded: true,
  });
  assert.equal(kept.keptExistingSite, true);
  assert.match(kept.message, /nothing was overwritten/);

  // Step 4 of the claim steps now says the editor opens right away.
  const step4 = claimSteps()[3] as { title: string; description: string };
  assert.match(step4.description, /opens in the editor right away/);
});
