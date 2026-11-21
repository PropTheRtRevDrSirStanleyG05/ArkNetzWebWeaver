// ArkNetzWebWeaver — collab relay over the GitHub Contents API.
//
// RELAY CHOICE (decided 2026-11-21): a `collab/<domain-slug>` BRANCH
// in the per-domain site repo, one state file per peer at
// `peers/<login>.json`, read and written through the Contents API
// with the user's OWN OAuth token (scope `public_repo`, the same
// scope Publish already uses). See src/lib/collab/README.md for the
// full rationale and the rejected alternative (GitHub Issues).
//
// Why this route works with the runtime token:
// - `public_repo` grants read/write on public repos, which is exactly
//   what the Contents API (GET/PUT/DELETE contents), the git-refs API
//   (create/delete branch) and the commit SHA guard need. Site repos
//   are public by design, so no wider scope is required.
// - Each peer writes ONLY its own file, so two peers never contend
//   for the same SHA: no write-write conflict is possible at the relay
//   layer. The SHA guard still applies per file (a stale SHA on your
//   own file returns 409 — the relay surfaces it, never overwrites
//   blindly).
// - Reads go through api.github.com, NEVER raw.githubusercontent.com:
//   the raw CDN caches branch content, so a poll could see minutes-old
//   state. API reads are fresh (and authenticated, 5,000/hr — a 5 s
//   poll with a handful of peers uses a few hundred per hour).
//
// What the relay does NOT do: it never touches `main` or
// `site.json.zst`. Collab state lives only on the collab branch until
// someone Publishes; Publish keeps its own SHA collision protection
// (see publish.ts) and still refuses on a stale SHA.

import { GITHUB_API_BASE } from "../config.js";
import { COLLAB_STATE_VERSION, parseCollabStateFile } from "./types.js";
import type { CollabStateFile } from "./types.js";
import { siteRepoName } from "../publish.js";
import type { GithubFetchFn } from "../publish.js";

export type CollabFetchFn = GithubFetchFn;

/** Branch name for a site's collab session. One session per site, so
 *  the name derives from the domain — any collaborator opening the
 *  same site joins the same branch, with no discovery step. */
export function collabBranchName(domain: string): string {
  const slug = domain.toLowerCase().replace(/\./g, "-");
  return `collab/${slug}`;
}

/** Path of a peer's state file inside the collab branch. */
export function collabPeerPath(login: string): string {
  return `peers/${sanitizeLogin(login)}.json`;
}

export function sanitizeLogin(login: string): string {
  const clean = login.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!clean) throw new Error("collab: GitHub login is empty after sanitising");
  return clean;
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function b64decode(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface CollabRelayConfig {
  owner: string;
  /** Site repo name; defaults to siteRepoName(domain). */
  repo: string;
  domain: string;
  /** The acting user's OWN OAuth token. Null/empty = refuse before
   *  any network call (per-user keys rule — no shared/master token). */
  token: string | null;
  fetchFn: CollabFetchFn;
}

interface ContentsEntry {
  name: string;
  sha: string;
  type: string;
}

export class CollabRelay {
  readonly owner: string;
  readonly repo: string;
  readonly domain: string;
  readonly branch: string;
  private readonly token: string | null;
  private readonly fetchFn: CollabFetchFn;

  constructor(config: CollabRelayConfig) {
    if (!config.owner) throw new Error("collab relay needs a repo owner");
    if (!config.repo) throw new Error("collab relay needs a repo name");
    if (!config.domain) throw new Error("collab relay needs a domain");
    this.owner = config.owner;
    this.repo = config.repo;
    this.domain = config.domain;
    this.branch = collabBranchName(config.domain);
    this.token = config.token;
    this.fetchFn = config.fetchFn;
  }

  /** The site repo name for a domain (same rule as Publish). */
  static repoFor(domain: string): string {
    return siteRepoName(domain);
  }

  private headers(): Record<string, string> {
    if (!this.token) {
      throw new Error(
        "Collab needs your own GitHub token — sign in with GitHub first. " +
          "Collab never uses a shared or master token, so no relay call is made without one.",
      );
    }
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ArkNetzWebWeaver/1.0",
    };
  }

  private api(path: string): string {
    return `${GITHUB_API_BASE}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`;
  }

  private async call(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }> {
    let res;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`collab relay unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return res;
  }

  /** Create the collab branch from main if it does not exist yet.
   *  Returns true when the branch was created, false when it already
   *  existed. Throws loudly on any other failure — a session must
   *  never pretend it joined when the relay is unavailable. */
  async ensureBranch(): Promise<boolean> {
    const refUrl = this.api(`/git/ref/heads/${this.branch}`);
    const existing = await this.call(refUrl, "GET");
    if (existing.status === 200) return false;
    if (existing.status !== 404) {
      const text = await existing.text().catch(() => "");
      throw new Error(`collab relay: checking branch ${this.branch} failed with HTTP ${existing.status}: ${text.slice(0, 200)}`);
    }
    const main = await this.call(this.api("/git/ref/heads/main"), "GET");
    if (main.status !== 200) {
      const text = await main.text().catch(() => "");
      throw new Error(
        `collab relay: cannot branch from main — HTTP ${main.status}: ${text.slice(0, 200)}. ` +
          `The site repo ${this.repo} may not exist yet; Publish it once first.`,
      );
    }
    const mainJson = (await main.json()) as { object?: { sha?: unknown } };
    const sha = mainJson.object?.sha;
    if (typeof sha !== "string") throw new Error("collab relay: main has no commit SHA to branch from");
    const created = await this.call(this.api("/git/refs"), "POST", {
      ref: `refs/heads/${this.branch}`,
      sha,
    });
    if (created.status !== 201) {
      const text = await created.text().catch(() => "");
      throw new Error(`collab relay: creating branch ${this.branch} failed with HTTP ${created.status}: ${text.slice(0, 200)}`);
    }
    return true;
  }

  /** List the peer files currently on the branch. Empty when the
   *  branch has no `peers/` directory yet (nobody has joined). */
  async listPeers(): Promise<string[]> {
    const res = await this.call(
      this.api(`/contents/peers?ref=${encodeURIComponent(this.branch)}`),
      "GET",
    );
    if (res.status === 404) return [];
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(`collab relay: listing peers failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error("collab relay: peers listing is not an array");
    return (body as ContentsEntry[])
      .filter((e) => e.type === "file" && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""));
  }

  /** Read one peer's state file. Null when the peer has no file
   *  (never joined, or left gracefully). A file that downloads but
   *  fails validation throws — corrupt relay state is loud, never
   *  silently merged. */
  async readPeer(login: string): Promise<{ state: CollabStateFile; sha: string } | null> {
    const res = await this.call(
      this.api(`/contents/${collabPeerPath(login)}?ref=${encodeURIComponent(this.branch)}`),
      "GET",
    );
    if (res.status === 404) return null;
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(`collab relay: reading ${login}'s state failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { content?: unknown; sha?: unknown; encoding?: unknown };
    if (typeof body.content !== "string" || typeof body.sha !== "string") {
      throw new Error(`collab relay: ${login}'s state file has no content/SHA`);
    }
    const text = new TextDecoder().decode(b64decode(body.content));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`collab relay: ${login}'s state file is not valid JSON`);
    }
    return { state: parseCollabStateFile(parsed), sha: body.sha };
  }

  /** Read every peer's state file (skips peers whose file vanished
   *  between list and read — a peer leaving mid-poll). */
  async readAllPeers(): Promise<Array<{ login: string; state: CollabStateFile }>> {
    const logins = await this.listPeers();
    const out: Array<{ login: string; state: CollabStateFile }> = [];
    for (const login of logins) {
      const entry = await this.readPeer(login);
      if (entry) out.push({ login, state: entry.state });
    }
    return out;
  }

  /** Write my own state file. GETs the current SHA first (create
   *  when 404); a 409 means my file changed under me — the write is
   *  refused, never forced, and the caller re-reads and retries. */
  async writeOwn(state: CollabStateFile): Promise<string> {
    if (state.v !== COLLAB_STATE_VERSION) {
      throw new Error(`collab relay: refusing to write state version ${state.v}`);
    }
    const path = collabPeerPath(state.login);
    const url = this.api(`/contents/${path}`);
    const existing = await this.call(`${url}?ref=${encodeURIComponent(this.branch)}`, "GET");
    let sha: string | undefined;
    if (existing.status === 200) {
      const body = (await existing.json()) as { sha?: unknown };
      if (typeof body.sha !== "string") throw new Error("collab relay: own state file has no SHA to update");
      sha = body.sha;
    } else if (existing.status !== 404) {
      const text = await existing.text().catch(() => "");
      throw new Error(`collab relay: checking own state failed with HTTP ${existing.status}: ${text.slice(0, 200)}`);
    }
    const content = b64encode(new TextEncoder().encode(JSON.stringify(state)));
    const body: Record<string, unknown> = {
      message: `Collab heartbeat ${state.login} (${state.session})`,
      content,
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const res = await this.call(url, "PUT", body);
    if (res.status !== 200 && res.status !== 201) {
      if (res.status === 409) {
        throw new Error(
          "collab relay: own state file changed under this client (HTTP 409) — re-read and retry, never overwrite blindly",
        );
      }
      const text = await res.text().catch(() => "");
      throw new Error(`collab relay: writing own state failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { content?: { sha?: unknown } };
    const newSha = json.content?.sha;
    if (typeof newSha !== "string") throw new Error("collab relay: write accepted but returned no file SHA");
    return newSha;
  }

  /** Delete my own state file (graceful leave). No-op when the file
   *  is already gone. */
  async deleteOwn(login: string): Promise<boolean> {
    const path = collabPeerPath(login);
    const url = this.api(`/contents/${path}`);
    const existing = await this.call(`${url}?ref=${encodeURIComponent(this.branch)}`, "GET");
    if (existing.status === 404) return false;
    if (existing.status !== 200) {
      const text = await existing.text().catch(() => "");
      throw new Error(`collab relay: checking own state for delete failed with HTTP ${existing.status}: ${text.slice(0, 200)}`);
    }
    const body = (await existing.json()) as { sha?: unknown };
    if (typeof body.sha !== "string") throw new Error("collab relay: own state file has no SHA to delete");
    const res = await this.call(url, "DELETE", {
      message: `Collab leave ${login}`,
      sha: body.sha,
      branch: this.branch,
    });
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(`collab relay: deleting own state failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return true;
  }

  /** Delete the whole collab branch (last peer out). Best-effort for
   *  the caller: returns false when the branch was already gone. */
  async deleteBranch(): Promise<boolean> {
    const res = await this.call(this.api(`/git/refs/heads/${this.branch}`), "DELETE");
    if (res.status === 204 || res.status === 404) return res.status === 204;
    const text = await res.text().catch(() => "");
    throw new Error(`collab relay: deleting branch ${this.branch} failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}
