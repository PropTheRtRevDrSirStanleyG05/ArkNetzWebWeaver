// Tests: real Publish — GitHub Contents API request shape, SHA
// handling, and exact missing-config errors. The GitHub API is fully
// mocked; no test ever touches real GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { publishSite, siteRepoName, PUBLISH_FILENAME } from "../src/lib/publish.js";
import type { GithubFetchFn } from "../src/lib/publish.js";
import { OWNER_ROLE, WRITER_ROLE } from "../src/lib/roles.js";
import { decompressJson } from "../src/lib/zstd.js";
import type { SiteDocument } from "../src/lib/types.js";

const DOC: SiteDocument = {
  domain: "computers.edu",
  title: "Computers",
  blocks: [
    { type: "h1", text: "Hello" },
    { type: "p", text: "A paragraph." },
  ],
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Mock GitHub: records every call, answers GET/PUT per scenario. */
function mockGitHub(scenario: "new" | "update" | "repo-missing" | "put-403"): { fetchFn: GithubFetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: GithubFetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === "GET") {
      if (scenario === "update") {
        return { status: 200, json: async () => ({ sha: "abc123oldsha", content: "" }), text: async () => "" };
      }
      if (scenario === "repo-missing") return { status: 404, json: async () => ({}), text: async () => "Not Found" };
      return { status: 404, json: async () => ({}), text: async () => "Not Found" };
    }
    // PUT
    if (scenario === "repo-missing") return { status: 404, json: async () => ({}), text: async () => "Not Found" };
    if (scenario === "put-403") return { status: 403, json: async () => ({}), text: async () => "Forbidden" };
    return { status: 201, json: async () => ({ commit: { sha: "def456newsha" } }), text: async () => "" };
  };
  return { fetchFn, calls };
}

test("siteRepoName derives the per-domain repo name", () => {
  assert.equal(siteRepoName("computers.edu"), "arknetz-site-computers-edu");
  assert.equal(siteRepoName("Edu.Orion.Stanbeyond"), "arknetz-site-edu-orion-stanbeyond");
});

test("new file: GET 404 then PUT without sha; body is base64 Zstd of the doc", async () => {
  const { fetchFn, calls } = mockGitHub("new");
  const result = await publishSite({ doc: DOC, role: OWNER_ROLE, token: "tok", owner: "stanley", repo: "arknetz-site-computers-edu", fetchFn });
  assert.deepEqual(result, {
    ok: true,
    repo: "arknetz-site-computers-edu",
    path: PUBLISH_FILENAME,
    commitSha: "def456newsha",
    bytes: new TextEncoder().encode(JSON.stringify(DOC, null, 2)).length,
    compressedBytes: result.ok ? result.compressedBytes : 0,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.url, "https://api.github.com/repos/stanley/arknetz-site-computers-edu/contents/site.json.zst");
  assert.equal(calls[0]?.headers.Authorization, "Bearer tok");
  assert.equal(calls[1]?.method, "PUT");
  const putBody = JSON.parse(calls[1]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(putBody.message, "Publish computers.edu (ArkNetzWebWeaver)");
  assert.equal(putBody.branch, "main");
  assert.equal("sha" in putBody, false, "create must not send a sha");
  // The uploaded content is real Zstd of the exact document JSON.
  const uploaded = Buffer.from(putBody.content as string, "base64");
  assert.deepEqual(await decompressJson(new Uint8Array(uploaded)), DOC);
});

test("existing file: PUT carries the existing SHA for the update", async () => {
  const { fetchFn, calls } = mockGitHub("update");
  const result = await publishSite({ doc: DOC, role: OWNER_ROLE, token: "tok", owner: "stanley", repo: "arknetz-site-computers-edu", fetchFn });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  const putBody = JSON.parse(calls[1]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(putBody.sha, "abc123oldsha");
});

test("no token: Publish says 'not signed in' and makes no calls", async () => {
  const { fetchFn, calls } = mockGitHub("new");
  const result = await publishSite({ doc: DOC, role: OWNER_ROLE, token: null, owner: "stanley", repo: "arknetz-site-computers-edu", fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /Not signed in/);
  assert.equal(calls.length, 0);
});

test("no repo: Publish says the site repo has not been created yet", async () => {
  const { fetchFn, calls } = mockGitHub("new");
  const result = await publishSite({ doc: DOC, role: OWNER_ROLE, token: "tok", owner: "stanley", repo: null, fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /not created yet/);
  assert.match(result.ok ? "" : result.reason, /arknetz-site-computers-edu/);
  assert.equal(calls.length, 0);
});

test("repo deleted on GitHub: PUT 404 becomes 'repo not found', not a generic error", async () => {
  const { fetchFn } = mockGitHub("repo-missing");
  const result = await publishSite({ doc: DOC, role: OWNER_ROLE, token: "tok", owner: "stanley", repo: "arknetz-site-computers-edu", fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /not found under stanley/);
  assert.match(result.ok ? "" : result.reason, /has not been created yet/);
});

test("PUT 403 surfaces the HTTP status; writer role cannot publish at all", async () => {
  const { fetchFn } = mockGitHub("put-403");
  const forbidden = await publishSite({ doc: DOC, role: OWNER_ROLE, token: "tok", owner: "stanley", repo: "arknetz-site-computers-edu", fetchFn });
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.ok ? "" : forbidden.reason, /HTTP 403/);
  const { fetchFn: f2, calls } = mockGitHub("new");
  const writer = await publishSite({ doc: DOC, role: WRITER_ROLE, token: "tok", owner: "stanley", repo: "arknetz-site-computers-edu", fetchFn: f2 });
  assert.equal(writer.ok, false);
  assert.match(writer.ok ? "" : writer.reason, /cannot publish/);
  assert.equal(calls.length, 0);
});
