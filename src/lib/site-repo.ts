// ArkNetzWebWeaver — per-domain site repos on GitHub.
// The claim flow's write side: create the site repo, file the
// REGISTER issue, and seed the starter site document.
//
// Everything here runs on the SIGNED-IN USER'S OWN runtime OAuth
// token (Bearer header, passed in per call — never stored here,
// never a shared/master token, never the connector). The token
// comes from the keyring / session in the shell (main.ts holds it
// as `githubToken` after the OAuth callback) and the coordinator
// passes it down. A missing token is a loud refusal at the
// orchestrator (domains.ts), never a silent fallback.
//
// API shapes (all mocked in tests — this module never hits real
// GitHub on its own):
//   POST /user/repos
//     { name: arknetz-site-<domain-slug>, private: false,
//       auto_init: true, description }            -> 201 { html_url }
//     422 "name already exists" -> GET the repo and reuse it.
//   POST /repos/{master}/arknetz-registry-0{shard}/issues
//     { title: "REGISTER: <domain>", body }       -> 201 { number, html_url }
//     The issue MUST land in the domain's hash-shard repo —
//     protocol/register.yml refuses a claim filed in the wrong shard.
//   GET  /repos/{owner}/{repo}/contents/site.json -> 200 { content (base64), sha } / 404
//   PUT  /repos/{owner}/{repo}/contents/site.json -> 201 { commit: { sha } }
//     The seed is plain JSON (not .zst): the reader tries
//     site.json.zst first and falls back to plain site.json on 404,
//     so a plain seed loads today and a later Publish (.zst) takes
//     over without any migration. An existing site.json is NEVER
//     overwritten — a reused repo keeps the site that is already there
//     and the editor opens that document instead.

import { GITHUB_API_BASE, MASTER_GITHUB_USER, registryShardRepo } from "./config.js";
import { validateDocument } from "./blocks.js";
import { parseSiteDocument, shardForDomain } from "./registry.js";
import { siteRepoName, type GithubFetchFn } from "./publish.js";
import type { RegisterIssue } from "./domains.js";
import type { RegistryEntry, SiteDocument } from "./types.js";

export const SITE_JSON_PATH = "site.json";

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ArkNetzWebWeaver/1.0",
  };
}

function b64encode(bytes: Uint8Array): string {
  // Chunked: btoa on a long string in one call overflows the stack
  // (same shape as publish.ts).
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function b64decode(content: string): string {
  const compact = content.replace(/\s+/g, "");
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Plain-English GitHub API failure for a write step. The HTTP
 *  status stays in the message (debuggable) but the sentence says
 *  what happened and what to do — never a bare status code. */
export function githubWriteError(
  status: number,
  action: string,
  detail = "",
): string {
  const snippet = detail ? ` GitHub said: ${detail.slice(0, 200)}` : "";
  switch (status) {
    case 401:
      return (
        `GitHub did not accept the sign-in token while trying to ${action} (HTTP 401). ` +
        `Sign in with GitHub again and retry — the token may have expired or been revoked.${snippet}`
      );
    case 403:
      return (
        `GitHub refused to ${action} (HTTP 403). The signed-in account needs the public_repo ` +
        `permission for this — sign out and sign in again with GitHub, making sure the OAuth ` +
        `authorisation is accepted, then retry.${snippet}`
      );
    case 404:
      return `GitHub could not find what was needed to ${action} (HTTP 404).${snippet}`;
    case 422:
      return `GitHub rejected the request to ${action} (HTTP 422) — the request was not acceptable as written.${snippet}`;
    default:
      return `GitHub returned HTTP ${status} while trying to ${action}.${snippet}`;
  }
}

async function readErrorDetail(res: { text(): Promise<string> }): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text) as { message?: unknown };
    return typeof body.message === "string" ? body.message : text;
  } catch {
    return text;
  }
}

export interface CreateSiteRepoInput {
  token: string;
  /** GitHub login of the signed-in user — the repo owner. */
  owner: string;
  /** Normalised domain, e.g. computers.edu. */
  domain: string;
  fetchFn: GithubFetchFn;
}

export interface CreatedSiteRepo {
  /** e.g. arknetz-site-computers-edu (publish.ts siteRepoName). */
  repo: string;
  /** e.g. https://github.com/alice/arknetz-site-computers-edu */
  url: string;
  /** True when the repo already existed and was reused, not created. */
  alreadyExisted: boolean;
}

/** Create the per-domain site repo under the signed-in user's own
 *  account (POST /user/repos, public_repo scope CAN create public
 *  repos). `auto_init` creates the README so `main` exists before
 *  the seed write. A 422 "name already exists" is NOT an error: the
 *  repo is fetched and reused — claiming again after a half-finished
 *  first attempt must not fail. Any other failure throws a
 *  plain-English error and creates nothing further. */
export async function createSiteRepo(input: CreateSiteRepoInput): Promise<CreatedSiteRepo> {
  const repo = siteRepoName(input.domain);
  const headers = githubHeaders(input.token);
  let res;
  try {
    res = await input.fetchFn(`${GITHUB_API_BASE}/user/repos`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: repo,
        description: `ArkNetzWebWeaver site for ${input.domain}`,
        private: false,
        auto_init: true,
      }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach GitHub to create the site repo ${repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 201) {
    const body = (await res.json()) as { html_url?: unknown };
    if (typeof body.html_url !== "string") {
      throw new Error(`GitHub created the site repo ${repo} but returned no URL — refusing to continue blindly`);
    }
    return { repo, url: body.html_url, alreadyExisted: false };
  }
  if (res.status === 422) {
    // Name already taken on this account: confirm it is really the
    // site repo (not someone else's name collision) and reuse it.
    let existing;
    try {
      existing = await input.fetchFn(
        `${GITHUB_API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(repo)}`,
        { method: "GET", headers },
      );
    } catch (err) {
      throw new Error(
        `GitHub said the site repo ${repo} already exists, but the follow-up check could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (existing.status === 200) {
      const body = (await existing.json()) as { html_url?: unknown };
      if (typeof body.html_url !== "string") {
        throw new Error(`GitHub confirmed the site repo ${repo} exists but returned no URL — refusing to continue blindly`);
      }
      return { repo, url: body.html_url, alreadyExisted: true };
    }
    const detail = await readErrorDetail(existing);
    throw new Error(
      githubWriteError(
        existing.status,
        `check the existing site repo ${repo}`,
        detail,
      ),
    );
  }
  const detail = await readErrorDetail(res);
  throw new Error(githubWriteError(res.status, `create the site repo ${repo}`, detail));
}

export interface OpenRegisterIssueInput {
  token: string;
  /** Built by buildRegisterIssue() in domains.ts — title is the
   *  machine contract (`REGISTER: <domain>`). */
  issue: RegisterIssue;
  fetchFn: GithubFetchFn;
}

export interface OpenedRegisterIssue {
  issueNumber: number;
  issueUrl: string;
  /** The shard repo the issue was filed in, e.g. arknetz-registry-0a. */
  shardRepo: string;
}

/** File the REGISTER issue in the domain's hash-shard registry repo
 *  under the master account — the ONLY repo register.yml accepts a
 *  claim in. Returns the issue number + URL. A non-201 throws a
 *  plain-English error; the site repo (if already created) is left
 *  in place and the caller reports that honestly. */
export async function openRegisterIssue(input: OpenRegisterIssueInput): Promise<OpenedRegisterIssue> {
  const shard = await shardForDomain(input.issue.domain);
  const shardRepo = registryShardRepo(shard);
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(MASTER_GITHUB_USER)}` +
    `/${encodeURIComponent(shardRepo)}/issues`;
  let res;
  try {
    res = await input.fetchFn(url, {
      method: "POST",
      headers: githubHeaders(input.token),
      body: JSON.stringify({ title: input.issue.title, body: input.issue.body }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach GitHub to file the claim for "${input.issue.domain}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status !== 201) {
    const detail = await readErrorDetail(res);
    throw new Error(
      githubWriteError(res.status, `file the REGISTER issue for "${input.issue.domain}" in ${shardRepo}`, detail),
    );
  }
  const body = (await res.json()) as { number?: unknown; html_url?: unknown };
  if (typeof body.number !== "number" || typeof body.html_url !== "string") {
    throw new Error(
      `GitHub accepted the REGISTER issue for "${input.issue.domain}" but returned no issue number or URL — refusing to continue blindly`,
    );
  }
  return { issueNumber: body.number, issueUrl: body.html_url, shardRepo };
}

/** The registry entry this claim WILL become once register.yml
 *  processes the issue — the exact shape register.yml commits
 *  (domain, backend gh:owner/repo, shard, owner). Returned with the
 *  claim result so the UI can show what is pending; it is NOT
 *  registered yet until the bot closes the issue. */
export async function registryEntryForClaim(
  domain: string,
  owner: string,
): Promise<RegistryEntry> {
  return {
    domain,
    backend: `gh:${owner}/${siteRepoName(domain)}`,
    shard: await shardForDomain(domain),
    owner,
  };
}

/** Minimal valid starter site: a hero, an h1 and a paragraph, on the
 *  claimed domain. Passes validateDocument() and parseSiteDocument()
 *  — the editor opens this, not the welcome demo. */
export function buildStarterSiteDocument(domain: string): SiteDocument {
  return {
    domain,
    title: domain,
    theme: { layout: "docs", accent: "#2563eb", font: "system-ui" },
    nav: [{ label: "Home", href: `arknetz://${domain}` }],
    blocks: [
      {
        type: "hero",
        title: `Welcome to ${domain}`,
        subtitle: "This is your new ArkNetzWebWeaver site. Start building — replace this hero with your own title.",
      },
      { type: "h1", text: `Hello from ${domain}` },
      {
        type: "p",
        text: `You claimed ${domain} and your site repo is ready. Edit this page in the builder, then Publish to put it live.`,
      },
    ],
  };
}

export interface SeedSiteRepoInput {
  token: string;
  owner: string;
  repo: string;
  /** The document to seed. Validated before any write. */
  doc: SiteDocument;
  fetchFn: GithubFetchFn;
}

export interface SeededSiteRepo {
  path: string;
  commitSha: string | null;
  /** The document now in the repo — the seeded doc, or the existing
   *  doc when the repo already had one (never overwritten). */
  doc: SiteDocument;
  /** True when the repo already had a site.json and it was kept. */
  alreadySeeded: boolean;
}

/** Seed site.json into the site repo via the Contents API. GETs
 *  first: an existing site.json means a reused repo already has a
 *  site — it is kept and returned as the document to open, never
 *  overwritten. Otherwise PUTs the document (base64 plain JSON).
 *  Throws a plain-English error on failure. */
export async function seedSiteRepo(input: SeedSiteRepoInput): Promise<SeededSiteRepo> {
  const problems = validateDocument(input.doc);
  if (problems.length > 0) {
    throw new Error(`Cannot seed the site repo — the starter document has ${problems.length} problem(s): ${problems[0]}`);
  }
  const headers = githubHeaders(input.token);
  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(input.owner)}` +
    `/${encodeURIComponent(input.repo)}/contents/${SITE_JSON_PATH}`;
  let getRes;
  try {
    getRes = await input.fetchFn(url, { method: "GET", headers });
  } catch (err) {
    throw new Error(
      `Could not reach GitHub to check the site repo ${input.repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (getRes.status === 200) {
    const body = (await getRes.json()) as { content?: unknown; encoding?: unknown };
    if (typeof body.content !== "string") {
      throw new Error(
        `The site repo ${input.repo} already has a ${SITE_JSON_PATH} but GitHub returned it without content — refusing to overwrite it blindly`,
      );
    }
    let existing: SiteDocument;
    try {
      existing = parseSiteDocument(JSON.parse(b64decode(body.content)));
    } catch (err) {
      throw new Error(
        `The site repo ${input.repo} already has a ${SITE_JSON_PATH} but it could not be read (${err instanceof Error ? err.message : String(err)}) — refusing to overwrite it`,
      );
    }
    return { path: SITE_JSON_PATH, commitSha: null, doc: existing, alreadySeeded: true };
  }
  if (getRes.status !== 404) {
    const detail = await readErrorDetail(getRes);
    throw new Error(
      githubWriteError(getRes.status, `check ${SITE_JSON_PATH} in the site repo ${input.repo}`, detail),
    );
  }

  const json = JSON.stringify(input.doc, null, 2);
  let putRes;
  try {
    putRes = await input.fetchFn(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `Seed starter site for ${input.doc.domain} (ArkNetzWebWeaver)`,
        content: b64encode(new TextEncoder().encode(json)),
        branch: "main",
      }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach GitHub to seed the site repo ${input.repo}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (putRes.status !== 200 && putRes.status !== 201) {
    const detail = await readErrorDetail(putRes);
    throw new Error(
      githubWriteError(putRes.status, `write ${SITE_JSON_PATH} in the site repo ${input.repo}`, detail),
    );
  }
  const putJson = (await putRes.json()) as { commit?: { sha?: string } };
  return {
    path: SITE_JSON_PATH,
    commitSha: typeof putJson.commit?.sha === "string" ? putJson.commit.sha : null,
    doc: input.doc,
    alreadySeeded: false,
  };
}
