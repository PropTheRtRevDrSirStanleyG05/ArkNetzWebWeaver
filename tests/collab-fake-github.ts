// Test helper (not a test file): an in-memory fake GitHub API that
// implements exactly the endpoints the collab relay and Publish use.
// No test ever touches real GitHub. Imported by collab-relay.test.ts
// and collab-editor.test.ts.
import type { GithubFetchFn } from "../src/lib/publish.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface StoredFile {
  content: string; // base64, as the Contents API stores it
  sha: string;
}

export class FakeGitHub {
  readonly calls: Call[] = [];
  /** When true, every call throws (offline simulation). */
  failAll = false;
  /** Fail the next N calls with a network error, then recover. */
  failNextCount = 0;
  private shaCounter = 0;
  /** repo -> branch -> path -> file */
  private readonly branches = new Map<string, Map<string, Map<string, StoredFile>>>();

  constructor() {
    // One site repo with a main branch holding site.json.zst, as a
    // published site would have.
    const main = new Map<string, StoredFile>();
    main.set("site.json.zst", { content: Buffer.from("e30=").toString("base64"), sha: "sitesha1" });
    const repo = new Map<string, Map<string, StoredFile>>();
    repo.set("main", main);
    this.branches.set("arknetz-site-computers-edu", repo);
  }

  private nextSha(): string {
    this.shaCounter += 1;
    return `fakesha${this.shaCounter}`;
  }

  private branchFiles(repo: string, branch: string): Map<string, StoredFile> | null {
    return this.branches.get(repo)?.get(branch) ?? null;
  }

  fetchFn: GithubFetchFn = async (url, init) => {
    this.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (this.failAll || this.failNextCount > 0) {
      if (this.failNextCount > 0) this.failNextCount -= 1;
      throw new Error("network down (fake)");
    }
    const u = new URL(url);
    const path = u.pathname;
    const ref = u.searchParams.get("ref") ?? "main";
    const repoMatch = /^\/repos\/[^/]+\/([^/]+)\/(.*)$/.exec(path);
    if (!repoMatch) return { status: 404, json: async () => ({}), text: async () => "Not Found" };
    const repo = repoMatch[1] as string;
    const rest = repoMatch[2] as string;

    const jsonRes = (status: number, body: unknown) => ({
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });

    // --- git refs -------------------------------------------------------
    const refMatch = /^git\/ref\/heads\/(.+)$/.exec(rest);
    if (refMatch && init.method === "GET") {
      const branch = refMatch[1] as string;
      const files = this.branchFiles(repo, branch);
      if (!files) return jsonRes(404, { message: "Not Found" });
      return jsonRes(200, { ref: `refs/heads/${branch}`, object: { sha: `commit-${branch}` } });
    }
    if (rest === "git/refs" && init.method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { ref?: string; sha?: string };
      const branch = (body.ref ?? "").replace(/^refs\/heads\//, "");
      const repoBranches = this.branches.get(repo);
      if (!repoBranches) return jsonRes(404, { message: "repo not found" });
      if (repoBranches.has(branch)) return jsonRes(422, { message: "Reference already exists" });
      // New branch starts as a copy of main's files.
      const main = repoBranches.get("main") ?? new Map();
      repoBranches.set(branch, new Map(main));
      return jsonRes(201, { ref: body.ref, object: { sha: body.sha } });
    }
    const delRefMatch = /^git\/refs\/heads\/(.+)$/.exec(rest);
    if (delRefMatch && init.method === "DELETE") {
      const branch = delRefMatch[1] as string;
      const deleted = this.branches.get(repo)?.delete(branch) ?? false;
      return jsonRes(deleted ? 204 : 404, deleted ? "" : { message: "Not Found" });
    }

    // --- contents -------------------------------------------------------
    const contentsMatch = /^contents\/(.+)$/.exec(rest);
    if (contentsMatch) {
      const filePath = decodeURIComponent(contentsMatch[1] as string);
      const files = this.branchFiles(repo, ref);
      if (!files) return jsonRes(404, { message: "branch not found" });
      if (init.method === "GET") {
        if (filePath === "peers") {
          const entries = [...files.keys()]
            .filter((p) => p.startsWith("peers/") && p.endsWith(".json"))
            .map((p) => ({ name: p.slice("peers/".length), sha: (files.get(p) as StoredFile).sha, type: "file" }));
          if (entries.length === 0) return jsonRes(404, { message: "Not Found" });
          return jsonRes(200, entries);
        }
        const file = files.get(filePath);
        if (!file) return jsonRes(404, { message: "Not Found" });
        return jsonRes(200, { name: filePath.split("/").pop(), sha: file.sha, content: file.content, encoding: "base64" });
      }
      if (init.method === "PUT") {
        const body = JSON.parse(init.body ?? "{}") as { content?: string; sha?: string; branch?: string };
        const targetBranch = body.branch ?? ref;
        const target = this.branchFiles(repo, targetBranch);
        if (!target) return jsonRes(404, { message: "branch not found" });
        const existing = target.get(filePath);
        if (body.sha) {
          if (!existing || existing.sha !== body.sha) {
            // Stale SHA: GitHub answers 409. This is the guard Publish
            // and the relay both rely on.
            return jsonRes(409, { message: "sha mismatch" });
          }
        }
        const sha = this.nextSha();
        target.set(filePath, { content: body.content ?? "", sha });
        return jsonRes(existing ? 200 : 201, { content: { sha }, commit: { sha: `commit-${sha}` } });
      }
      if (init.method === "DELETE") {
        const body = JSON.parse(init.body ?? "{}") as { sha?: string; branch?: string };
        const targetBranch = body.branch ?? ref;
        const target = this.branchFiles(repo, targetBranch);
        if (!target) return jsonRes(404, { message: "branch not found" });
        const existing = target.get(filePath);
        if (!existing || existing.sha !== body.sha) return jsonRes(409, { message: "sha mismatch" });
        target.delete(filePath);
        return jsonRes(200, { commit: { sha: this.nextSha() } });
      }
    }
    return jsonRes(404, { message: "Not Found" });
  };

  /** Read a stored file back (test introspection). */
  storedFile(repo: string, branch: string, path: string): StoredFile | undefined {
    return this.branchFiles(repo, branch)?.get(path);
  }

  hasBranch(repo: string, branch: string): boolean {
    return this.branchFiles(repo, branch) !== null;
  }

  putCalls(): Call[] {
    return this.calls.filter((c) => c.method === "PUT");
  }
}
