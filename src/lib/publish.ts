// ArkNetzWebWeaver — real Publish to GitHub.
// Replaces the publish-preview stub: Publish now actually commits
// site.json.zst to the user's per-domain site repo via the GitHub
// Contents API. Batched on Publish only — never a commit per keystroke.
//   GET  /repos/{owner}/{repo}/contents/site.json.zst   -> existing SHA
//        (404 = new file, no SHA needed)
//   PUT  /repos/{owner}/{repo}/contents/site.json.zst   -> { message,
//        content: base64(zstd(site.json)), sha? }
// Auth is the OAuth token from src/lib/auth.ts (Bearer header, never
// logged, never stored in the repo). The repo is NOT created here —
// repos are created by the parent after this is verified; if the repo
// or the token is missing, Publish says exactly what is missing instead
// of pretending it published. Tests mock the GitHub API — this module
// never hits real GitHub in tests, and this task creates no real repos.

import { GITHUB_API_BASE } from "./config.js";
import { gateAppEmbed, gatePublish } from "./roles.js";
import { validateDocument } from "./blocks.js";
import { compressJson } from "./zstd.js";
import type { SiteDocument, TeamRole } from "./types.js";

export const PUBLISH_FILENAME = "site.json.zst";

/** Per-domain site repo name, e.g. computers.edu ->
 *  arknetz-site-computers-edu (thread + REPO-TOPOLOGY.md). */
export function siteRepoName(domain: string): string {
  const slug = domain.toLowerCase().replace(/\./g, "-");
  return `arknetz-site-${slug}`;
}

export type GithubFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface PublishInput {
  doc: SiteDocument;
  role: TeamRole;
  /** OAuth token from the GitHub sign-in flow. Null = not signed in. */
  token: string | null;
  /** Repo owner (GitHub login). */
  owner: string;
  /** Target repo name. Null = the site repo has not been created yet. */
  repo: string | null;
  fetchFn: GithubFetchFn;
}

export type PublishResult =
  | {
      ok: true;
      repo: string;
      path: string;
      commitSha: string;
      bytes: number;
      compressedBytes: number;
    }
  | { ok: false; reason: string };

function b64encode(bytes: Uint8Array): string {
  // Chunked: btoa on a 10 MB string in one call overflows the stack.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function contentsUrl(owner: string, repo: string): string {
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${PUBLISH_FILENAME}`;
}

export async function publishSite(input: PublishInput): Promise<PublishResult> {
  const { doc, role } = input;
  const publishGate = gatePublish(role);
  if (!publishGate.allowed) return { ok: false, reason: publishGate.reason };
  if (doc.blocks.some((b) => b.type === "app")) {
    const gate = gateAppEmbed(role);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
  }
  const problems = validateDocument(doc);
  if (problems.length > 0) {
    return { ok: false, reason: `Cannot publish — document has ${problems.length} problem(s): ${problems[0]}` };
  }
  if (!input.token) {
    return {
      ok: false,
      reason:
        "Not signed in — Publish needs a GitHub token. Sign in with GitHub first (the OAuth App must exist; until it does, sign-in stops loudly and Publish cannot run).",
    };
  }
  if (!input.repo) {
    return {
      ok: false,
      reason:
        `Site repo not created yet — expected ${siteRepoName(doc.domain)} under ${input.owner}. ` +
        "Repos are created by the publisher after the build is verified; this build does not create repos. Nothing was published.",
    };
  }

  const json = JSON.stringify(doc, null, 2);
  const bytes = new TextEncoder().encode(json).length;
  let compressed: Uint8Array;
  try {
    compressed = await compressJson(doc);
  } catch (err) {
    return { ok: false, reason: `Publish failed — Zstd compression failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const url = contentsUrl(input.owner, input.repo);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ArkNetzWebWeaver/1.0",
  };

  // Existing file? Its SHA is required for an update; 404 means create.
  let existingSha: string | undefined;
  let getRes;
  try {
    getRes = await input.fetchFn(url, { method: "GET", headers });
  } catch (err) {
    return { ok: false, reason: `Publish failed — could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (getRes.status === 200) {
    const body = (await getRes.json()) as Record<string, unknown>;
    if (typeof body.sha !== "string") {
      return { ok: false, reason: "Publish failed — GitHub returned a file without a SHA; refusing to overwrite blindly" };
    }
    existingSha = body.sha;
  } else if (getRes.status !== 404) {
    const text = await getRes.text().catch(() => "");
    return { ok: false, reason: `Publish failed — GitHub returned HTTP ${getRes.status} checking ${PUBLISH_FILENAME}: ${text.slice(0, 200)}` };
  }

  const putBody: Record<string, unknown> = {
    message: `Publish ${doc.domain} (ArkNetzWebWeaver)`,
    content: b64encode(compressed),
    branch: "main",
  };
  if (existingSha) putBody.sha = existingSha;

  let putRes;
  try {
    putRes = await input.fetchFn(url, { method: "PUT", headers, body: JSON.stringify(putBody) });
  } catch (err) {
    return { ok: false, reason: `Publish failed — could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (putRes.status !== 200 && putRes.status !== 201) {
    if (putRes.status === 404) {
      return {
        ok: false,
        reason:
          `Site repo ${input.repo} not found under ${input.owner} — the repo has not been created yet. ` +
          "Repos are created by the publisher after the build is verified; this build does not create repos. Nothing was published.",
      };
    }
    const text = await putRes.text().catch(() => "");
    return { ok: false, reason: `Publish failed — GitHub returned HTTP ${putRes.status} writing ${PUBLISH_FILENAME}: ${text.slice(0, 200)}` };
  }
  const putJson = (await putRes.json()) as { commit?: { sha?: string } };
  const commitSha = putJson.commit?.sha;
  if (typeof commitSha !== "string") {
    return { ok: false, reason: "Publish failed — GitHub accepted the write but returned no commit SHA" };
  }
  return {
    ok: true,
    repo: input.repo,
    path: PUBLISH_FILENAME,
    commitSha,
    bytes,
    compressedBytes: compressed.length,
  };
}
