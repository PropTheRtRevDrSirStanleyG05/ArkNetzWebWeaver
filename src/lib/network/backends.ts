// ArkNetzWebWeaver — pluggable storage backends (thread turn 42).
// The storage layer is pluggable via URI prefixes, not hardcoded to
// GitHub / Internet Archive:
//   gh:   GitHub (default — identity, sites, mail, comments)
//   gl:   GitLab (backup mirror / secondary registry)
//   cb:   Codeberg (non-profit Forgejo mirror)
//   ia:   Internet Archive (default media; see src/lib/ia-media.ts for uploads)
//   hf:   Hugging Face Hub datasets (open datasets / AI / open-science ONLY)
//   wm:   Wikimedia Commons (freely licensed educational media ONLY)
//   ipfs: Filebase free IPFS tier (secondary fallback for small assets)
//
// Every client takes an injected fetch function: no test or module in this
// file ever touches the real network. Reads use each backend's public
// CDN/API shape. Writes are implemented where the REST shape is a
// documented public API (gh:/gl:/cb: contents APIs, hf: Hub upload API);
// ia:/wm:/ipfs: writes go through their own dedicated flows (IA S3,
// MediaWiki upload API, Filebase S3) and this layer refuses them loudly
// instead of guessing a shape.
//
// ToS-aware routing (turn 42): hf: and wm: are only offered as upload
// targets when the caller marks the project as an open dataset /
// educational resource / Creative Commons work. Enforced in code, not
// just in the UI — assertUploadAllowed() throws otherwise.
//
// Licence: MIT. No new dependencies.

export type BackendPrefix = "gh" | "gl" | "cb" | "ia" | "hf" | "wm" | "ipfs";

export const BACKEND_PREFIXES: BackendPrefix[] = [
  "gh",
  "gl",
  "cb",
  "ia",
  "hf",
  "wm",
  "ipfs",
];

/** Human-readable name + what the backend is for (UI copy lives here). */
export const BACKEND_INFO: Record<
  BackendPrefix,
  { label: string; role: string }
> = {
  gh: { label: "GitHub", role: "Default — identity, sites, mail, comments" },
  gl: { label: "GitLab", role: "Backup mirror / secondary registry" },
  cb: { label: "Codeberg", role: "Non-profit Forgejo mirror" },
  ia: { label: "Internet Archive", role: "Default media storage" },
  hf: {
    label: "Hugging Face Hub",
    role: "Open datasets, AI demos, research sites only",
  },
  wm: {
    label: "Wikimedia Commons",
    role: "Freely licensed educational media only",
  },
  ipfs: { label: "IPFS (Filebase)", role: "Secondary fallback for small assets" },
};

export interface ParsedBackendUri {
  prefix: BackendPrefix;
  /** Owner / namespace, e.g. "alice" in gh:alice/repo/path. Absent for wm:/ipfs:. */
  owner?: string;
  /** Repo / item name, e.g. "arknetz-site-computers-edu". Absent for wm:. */
  repo?: string;
  /** Path inside the repo/item, e.g. "main/site.json.zst" is NOT part of
   *  the URI — the branch is implied ("main") and path is the file path,
   *  e.g. "site.json.zst". May be "" when the URI names a repo only. */
  path: string;
  /** The URI exactly as given. */
  raw: string;
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** Parse a backend URI. Shapes:
 *  gh:owner/repo/path…  gl:owner/repo/path…  cb:owner/repo/path…
 *  ia:item/file…        hf:owner/repo/path…
 *  wm:File_Name.jpg     ipfs:<cid>/path…
 *  The branch is always "main" (implied, never in the URI). */
export function parseBackendUri(uri: string): ParsedBackendUri {
  const m = /^([a-z]+):(.*)$/.exec(uri);
  if (!m) fail(`invalid backend URI "${uri}" — expected "<prefix>:<rest>"`);
  const prefix = m[1] as string;
  const rest = m[2] as string;
  if (!BACKEND_PREFIXES.includes(prefix as BackendPrefix)) {
    fail(
      `unknown backend prefix "${prefix}" in "${uri}" — known prefixes: ${BACKEND_PREFIXES.join(", ")}`,
    );
  }
  if (!rest) fail(`backend URI "${uri}" has nothing after the prefix`);
  const p = prefix as BackendPrefix;
  if (p === "wm") {
    if (rest.includes("/")) {
      fail(`Wikimedia URI "${uri}" must be a single filename, e.g. wm:Sunset.jpg`);
    }
    return { prefix: p, path: rest, raw: uri };
  }
  if (p === "ipfs" || p === "ia") {
    // ipfs:<cid>/path… and ia:<item>/file… — the first segment is the
    // content address / item name, not an owner.
    const [first, ...pathParts] = rest.split("/");
    if (!first) {
      fail(
        p === "ipfs"
          ? `IPFS URI "${uri}" needs a CID, e.g. ipfs:<cid>/file`
          : `IA URI "${uri}" needs an item, e.g. ia:my-item/photo.webp`,
      );
    }
    return { prefix: p, repo: first, path: pathParts.join("/"), raw: uri };
  }
  const parts = rest.split("/");
  const owner = parts[0] as string;
  const repo = parts[1] as string;
  if (!owner || !repo) {
    fail(
      `backend URI "${uri}" needs "<owner>/<repo>", e.g. ${p}:alice/my-site/site.json.zst`,
    );
  }
  return { prefix: p, owner, repo, path: parts.slice(2).join("/"), raw: uri };
}

export function backendPrefixOf(uri: string): BackendPrefix {
  return parseBackendUri(uri).prefix;
}

// ---------------------------------------------------------------------------
// Transport (injected — never the real network in tests)
// ---------------------------------------------------------------------------

export interface NetworkResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface NetworkRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type NetworkFetch = (
  url: string,
  init?: NetworkRequestInit,
) => Promise<NetworkResponse>;

export interface BackendReadResult {
  body: string;
  url: string;
  status: number;
}

export interface BackendWriteOptions {
  /** Bearer / token auth for the backend API. Never logged. */
  token?: string;
  message?: string;
  /** Base64 of the current file, for gh:/cb: updates (prevents clobber). */
  sha?: string;
}

export interface Backend {
  prefix: BackendPrefix;
  /** Public read URL (CDN / raw shape) for a backend URI. */
  readUrl(uri: string): string;
  read(
    uri: string,
    fetchFn: NetworkFetch,
    opts?: { timeoutMs?: number },
  ): Promise<BackendReadResult>;
  /** Public list URL, or null when the backend has no list shape here. */
  listUrl(uri: string): string | null;
  list(uri: string, fetchFn: NetworkFetch): Promise<string[]>;
  /** Write endpoint URL, or null when writes are not supported by this layer. */
  writeUrl(uri: string): string | null;
  write(
    uri: string,
    body: string,
    fetchFn: NetworkFetch,
    opts?: BackendWriteOptions,
  ): Promise<{ url: string; status: number }>;
}

function readResponse(
  res: NetworkResponse,
  url: string,
): Promise<BackendReadResult> {
  return res.text().then((body) => {
    if (res.status !== 200) {
      throw new Error(`read ${url} failed with HTTP ${res.status}`);
    }
    return { body, url, status: res.status };
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
  onTimeout?: () => void,
): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Reject with the timeout first; the abort below is only cleanup
      // for the in-flight request, and a later rejection is ignored
      // once the promise has settled.
      reject(new Error(`request timed out after ${ms} ms`));
      onTimeout?.();
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("request aborted"));
    });
  });
}

function readWithTimeout(
  backend: { readUrl(u: string): string },
  uri: string,
  fetchFn: NetworkFetch,
  timeoutMs?: number,
): Promise<BackendReadResult> {
  const url = backend.readUrl(uri);
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const attempt = fetchFn(url, {
    headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
    signal: controller?.signal,
  }).then((res) => readResponse(res, url));
  return withTimeout(attempt, timeoutMs ?? 0, controller?.signal, () =>
    controller?.abort(),
  );
}

function unsupportedWrite(prefix: BackendPrefix, why: string): never {
  return fail(
    `write to ${prefix}: is not supported by the backend layer — ${why}`,
  );
}

// --- GitHub ---------------------------------------------------------------

const githubBackend: Backend = {
  prefix: "gh",
  readUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    if (prefixOf(uri) !== "gh") fail(`not a gh: URI: ${uri}`);
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`;
  },
  read(uri, fetchFn, opts) {
    return readWithTimeout(githubBackend, uri, fetchFn, opts?.timeoutMs);
  },
  listUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  },
  async list(uri, fetchFn) {
    const url = githubBackend.listUrl(uri) as string;
    const res = await fetchFn(url, {
      headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
    });
    if (res.status !== 200) {
      throw new Error(`list ${url} failed with HTTP ${res.status}`);
    }
    const raw = JSON.parse(await res.text()) as unknown;
    if (!Array.isArray(raw)) throw new Error(`list ${url} did not return an array`);
    return (raw as { name?: unknown }[])
      .map((e) => (typeof e.name === "string" ? e.name : ""))
      .filter(Boolean);
  },
  writeUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  },
  async write(uri, body, fetchFn, opts) {
    if (!opts?.token) {
      throw new Error("GitHub write needs an OAuth token — sign in first");
    }
    const url = githubBackend.writeUrl(uri) as string;
    const payload: Record<string, unknown> = {
      message: opts.message ?? `ArkNetzWebWeaver: update ${parseBackendUri(uri).path}`,
      content: b64encode(new TextEncoder().encode(body)),
    };
    if (opts.sha) payload.sha = opts.sha;
    const res = await fetchFn(url, {
      method: "PUT",
      headers: {
        "User-Agent": "ArkNetzWebWeaver/1.0",
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`GitHub write to ${url} failed with HTTP ${res.status}`);
    }
    return { url, status: res.status };
  },
};

// --- GitLab ---------------------------------------------------------------

function gitlabProject(owner: string | undefined, repo: string | undefined): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

const gitlabBackend: Backend = {
  prefix: "gl",
  readUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://gitlab.com/${owner}/${repo}/-/raw/main/${path}`;
  },
  read(uri, fetchFn, opts) {
    return readWithTimeout(gitlabBackend, uri, fetchFn, opts?.timeoutMs);
  },
  listUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://gitlab.com/api/v4/projects/${gitlabProject(owner, repo)}/repository/tree?path=${encodeURIComponent(path)}&ref=main`;
  },
  async list(uri, fetchFn) {
    const url = gitlabBackend.listUrl(uri) as string;
    const res = await fetchFn(url, {
      headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
    });
    if (res.status !== 200) {
      throw new Error(`list ${url} failed with HTTP ${res.status}`);
    }
    const raw = JSON.parse(await res.text()) as unknown;
    if (!Array.isArray(raw)) throw new Error(`list ${url} did not return an array`);
    return (raw as { name?: unknown }[])
      .map((e) => (typeof e.name === "string" ? e.name : ""))
      .filter(Boolean);
  },
  writeUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://gitlab.com/api/v4/projects/${gitlabProject(owner, repo)}/repository/files/${encodeURIComponent(path)}`;
  },
  async write(uri, body, fetchFn, opts) {
    if (!opts?.token) {
      throw new Error("GitLab write needs an OAuth token — sign in first");
    }
    const url = gitlabBackend.writeUrl(uri) as string;
    const res = await fetchFn(url, {
      method: "PUT",
      headers: {
        "User-Agent": "ArkNetzWebWeaver/1.0",
        "PRIVATE-TOKEN": opts.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        branch: "main",
        content: body,
        commit_message:
          opts.message ?? `ArkNetzWebWeaver: update ${parseBackendUri(uri).path}`,
      }),
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`GitLab write to ${url} failed with HTTP ${res.status}`);
    }
    return { url, status: res.status };
  },
};

// --- Codeberg (Forgejo) ---------------------------------------------------

const codebergBackend: Backend = {
  prefix: "cb",
  readUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://codeberg.org/${owner}/${repo}/raw/branch/main/${path}`;
  },
  read(uri, fetchFn, opts) {
    return readWithTimeout(codebergBackend, uri, fetchFn, opts?.timeoutMs);
  },
  listUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://codeberg.org/api/v1/repos/${owner}/${repo}/contents/${path}`;
  },
  async list(uri, fetchFn) {
    const url = codebergBackend.listUrl(uri) as string;
    const res = await fetchFn(url, {
      headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
    });
    if (res.status !== 200) {
      throw new Error(`list ${url} failed with HTTP ${res.status}`);
    }
    const raw = JSON.parse(await res.text()) as unknown;
    if (!Array.isArray(raw)) throw new Error(`list ${url} did not return an array`);
    return (raw as { name?: unknown }[])
      .map((e) => (typeof e.name === "string" ? e.name : ""))
      .filter(Boolean);
  },
  writeUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://codeberg.org/api/v1/repos/${owner}/${repo}/contents/${path}`;
  },
  async write(uri, body, fetchFn, opts) {
    if (!opts?.token) {
      throw new Error("Codeberg write needs an OAuth token — sign in first");
    }
    const url = codebergBackend.writeUrl(uri) as string;
    const payload: Record<string, unknown> = {
      message: opts.message ?? `ArkNetzWebWeaver: update ${parseBackendUri(uri).path}`,
      content: b64encode(new TextEncoder().encode(body)),
    };
    if (opts.sha) payload.sha = opts.sha;
    const res = await fetchFn(url, {
      method: "PUT",
      headers: {
        "User-Agent": "ArkNetzWebWeaver/1.0",
        Authorization: `token ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Codeberg write to ${url} failed with HTTP ${res.status}`);
    }
    return { url, status: res.status };
  },
};

// --- Internet Archive -----------------------------------------------------

const internetArchiveBackend: Backend = {
  prefix: "ia",
  readUrl(uri) {
    const { repo, path } = parseBackendUri(uri);
    return `https://archive.org/download/${repo}/${path}`;
  },
  read(uri, fetchFn, opts) {
    return readWithTimeout(internetArchiveBackend, uri, fetchFn, opts?.timeoutMs);
  },
  listUrl(uri) {
    const { repo } = parseBackendUri(uri);
    return `https://archive.org/metadata/${repo}`;
  },
  async list(uri, fetchFn) {
    const url = internetArchiveBackend.listUrl(uri) as string;
    const res = await fetchFn(url, {
      headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
    });
    if (res.status !== 200) {
      throw new Error(`list ${url} failed with HTTP ${res.status}`);
    }
    const raw = JSON.parse(await res.text()) as unknown as {
      files?: { name?: unknown }[];
    };
    if (!Array.isArray(raw.files)) return [];
    return raw.files
      .map((f) => (typeof f.name === "string" ? f.name : ""))
      .filter(Boolean);
  },
  writeUrl() {
    return null;
  },
  write() {
    return Promise.reject(
      new Error(
        "write to ia: is not supported by the backend layer — Internet Archive uploads use the IA S3 API with the user's own S3 keys (see src/lib/ia-media.ts), never a generic write",
      ),
    );
  },
};

// --- Hugging Face Hub ------------------------------------------------------
// Reads use the public resolve CDN for datasets. Writes use the real Hub
// shape, verified 2026-11-20 against the official Hub clients
// (huggingface_hub _commit_api.py, @huggingface/hub commit.ts — the SDKs
// ARE the contract, the Hub publishes no raw-HTTP reference):
//   1. POST /api/datasets/{repo}/preupload/{branch} with JSON
//      {"files":[{"path","size","sample": base64(first 512 bytes)}]} —
//      the server answers the uploadMode ("regular" | "lfs").
//   2. POST /api/datasets/{repo}/commit/{branch} with
//      Content-Type: application/x-ndjson — a header line, then one
//      {"key":"file","value":{"content": base64, "path",
//      "encoding":"base64"}} line per regular file.
// The LFS path (preupload says "lfs") is NOT implemented in this generic
// layer: its fetch shape carries string bodies only, and the LFS PUT
// needs raw bytes — the ArkDrive HuggingFaceVaultClient
// (src/lib/drive/huggingface.ts) implements the full LFS flow
// (batch -> presigned PUT -> commit lfsFile). If preupload ever says
// "lfs" here, write() fails loudly and says so instead of corrupting.
// NOT live-verified: no real upload has ever run against a live HF
// account with a real token, so server error bodies and the preupload
// size threshold that flips a file to LFS are still UNVERIFIED live.

const huggingFaceBackend: Backend = {
  prefix: "hf",
  readUrl(uri) {
    const { owner, repo, path } = parseBackendUri(uri);
    return `https://huggingface.co/datasets/${owner}/${repo}/resolve/main/${path}`;
  },
  read(uri, fetchFn, opts) {
    return readWithTimeout(huggingFaceBackend, uri, fetchFn, opts?.timeoutMs);
  },
  listUrl(uri) {
    const { owner, repo } = parseBackendUri(uri);
    return `https://huggingface.co/api/datasets/${owner}/${repo}/tree/main`;
  },
  async list(uri, fetchFn) {
    const url = huggingFaceBackend.listUrl(uri) as string;
    const res = await fetchFn(url, {
      headers: { "User-Agent": "ArkNetzWebWeaver/1.0" },
    });
    if (res.status !== 200) {
      throw new Error(`list ${url} failed with HTTP ${res.status}`);
    }
    const raw = JSON.parse(await res.text()) as unknown;
    if (!Array.isArray(raw)) throw new Error(`list ${url} did not return an array`);
    return (raw as { path?: unknown }[])
      .map((e) => (typeof e.path === "string" ? e.path : ""))
      .filter(Boolean);
  },
  writeUrl(uri) {
    const { owner, repo } = parseBackendUri(uri);
    // Write is two steps (preupload, then commit); this is the first step.
    return `https://huggingface.co/api/datasets/${owner}/${repo}/preupload/main`;
  },
  async write(uri, body, fetchFn, opts) {
    if (!opts?.token) {
      throw new Error("Hugging Face write needs a Hub token — sign in first");
    }
    const { owner, repo, path } = parseBackendUri(uri);
    const bytes = new TextEncoder().encode(body);
    const base = `https://huggingface.co/api/datasets/${owner}/${repo}`;
    const auth = {
      "User-Agent": "ArkNetzWebWeaver/1.0",
      Authorization: `Bearer ${opts.token}`,
    };
    const fail = (status: number, what: string): Error => {
      if (status === 401 || status === 403) {
        return new Error(
          `Hugging Face ${what} failed with HTTP ${status} — the Hub token is missing, expired, or lacks write access to ${owner}/${repo}. Re-link the account and try again.`,
        );
      }
      if (status === 404) {
        return new Error(
          `Hugging Face ${what} failed with HTTP 404 — repo ${owner}/${repo} or branch main was not found. Check the vault URI and that the repo exists.`,
        );
      }
      if (status === 409) {
        return new Error(
          `Hugging Face ${what} failed with HTTP 409 — the repo changed while this commit was being made. Retry the operation.`,
        );
      }
      if (status === 429) {
        return new Error(
          `Hugging Face ${what} failed with HTTP 429 — Hugging Face is rate-limiting this account. Wait a few minutes and try again.`,
        );
      }
      return new Error(`Hugging Face ${what} failed with HTTP ${status}`);
    };
    // 1. Preupload — the Hub decides regular vs LFS.
    const pre = await fetchFn(`${base}/preupload/main`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path, size: bytes.length, sample: b64encode(bytes.subarray(0, 512)) }],
      }),
    });
    if (pre.status >= 400) throw fail(pre.status, `preparing upload of ${path} to ${owner}/${repo}`);
    const preBody = JSON.parse(await pre.text()) as {
      files?: Array<{ path?: string; uploadMode?: string }>;
    };
    const mode = Array.isArray(preBody?.files)
      ? preBody.files.find((f) => f.path === path)?.uploadMode
      : undefined;
    if (mode !== "regular" && mode !== "lfs") {
      throw new Error(
        `Hugging Face preupload for ${path} did not name an upload mode for this file`,
      );
    }
    if (mode === "lfs") {
      throw new Error(
        `Hugging Face asked for an LFS upload of ${path} — the generic backend layer cannot send the raw-byte LFS PUT (its fetch shape carries string bodies only). Use the ArkDrive Hugging Face vault client (src/lib/drive/huggingface.ts), which implements the full LFS flow.`,
      );
    }
    // 2. NDJSON commit with the regular file.
    const lines = [
      { key: "header", value: { summary: `ArkNetzWebWeaver: store ${path}`, description: "" } },
      { key: "file", value: { content: b64encode(bytes), path, encoding: "base64" } },
    ];
    const commit = await fetchFn(`${base}/commit/main`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/x-ndjson" },
      body: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    });
    if (commit.status >= 400) throw fail(commit.status, `committing ${path} in ${owner}/${repo}`);
    return { url: `${base}/commit/main`, status: commit.status };
  },
};

// --- Wikimedia Commons ----------------------------------------------------

const wikimediaBackend: Backend = {
  prefix: "wm",
  readUrl(uri) {
    const { path } = parseBackendUri(uri);
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(path)}`;
  },
  read(uri, fetchFn, opts) {
    return readWithTimeout(wikimediaBackend, uri, fetchFn, opts?.timeoutMs);
  },
  listUrl() {
    return null;
  },
  list() {
    return Promise.reject(
      new Error(
        "list for wm: is not supported — Wikimedia Commons files are addressed one by one (wm:<filename>); use the MediaWiki API to search Commons",
      ),
    );
  },
  writeUrl() {
    return null;
  },
  write() {
    return Promise.reject(
      new Error(
        "write to wm: is not supported by the backend layer — Wikimedia Commons uploads use the MediaWiki upload API with an account session and a freely licensed file; the client must not silently upload arbitrary files there",
      ),
    );
  },
};

// --- IPFS via Filebase ----------------------------------------------------

export const FILEBASE_GATEWAY = "https://ipfs.filebase.io/ipfs";

const ipfsBackend: Backend = {
  prefix: "ipfs",
  readUrl(uri) {
    const { repo, path } = parseBackendUri(uri);
    return path
      ? `${FILEBASE_GATEWAY}/${repo}/${path}`
      : `${FILEBASE_GATEWAY}/${repo}`;
  },
  read(uri, fetchFn, opts) {
    return readWithTimeout(ipfsBackend, uri, fetchFn, opts?.timeoutMs);
  },
  listUrl() {
    return null;
  },
  list() {
    return Promise.reject(
      new Error(
        "list for ipfs: is not supported — an IPFS CID is content-addressed, not a browsable directory; pin the exact CIDs you need",
      ),
    );
  },
  writeUrl() {
    return null;
  },
  write() {
    return Promise.reject(
      new Error(
        "write to ipfs: is not supported by the backend layer — Filebase uploads use its S3-compatible API with the user's own keys; pin through that API, then reference the returned CID as ipfs:<cid>",
      ),
    );
  },
};

export const BACKENDS: Record<BackendPrefix, Backend> = {
  gh: githubBackend,
  gl: gitlabBackend,
  cb: codebergBackend,
  ia: internetArchiveBackend,
  hf: huggingFaceBackend,
  wm: wikimediaBackend,
  ipfs: ipfsBackend,
};

export function backendFor(uri: string): Backend {
  return BACKENDS[parseBackendUri(uri).prefix];
}

function prefixOf(uri: string): BackendPrefix {
  return parseBackendUri(uri).prefix;
}

/** Read one URI through its backend. */
export function readBackendUri(
  uri: string,
  fetchFn: NetworkFetch,
  opts?: { timeoutMs?: number },
): Promise<BackendReadResult> {
  return backendFor(uri).read(uri, fetchFn, opts);
}

// ---------------------------------------------------------------------------
// ToS-aware routing (thread turn 42)
// ---------------------------------------------------------------------------

export interface ProjectFlags {
  /** The project is an open dataset / open-science resource. */
  isOpenDataset?: boolean;
  /** The project is an educational resource. */
  isEducational?: boolean;
  /** The work is released under a Creative Commons licence. */
  isCreativeCommons?: boolean;
}

/**
 * Throws unless the backend may be used as an UPLOAD target for this
 * project. Reads are never gated — any backend may be read. Only hf:
 * and wm: are gated, because their Terms of Service restrict what may
 * be uploaded (see PROTOCOL.md §ToS).
 */
export function assertUploadAllowed(
  prefix: BackendPrefix,
  flags: ProjectFlags,
): void {
  if (prefix === "hf" && !flags.isOpenDataset) {
    throw new Error(
      "upload to hf: refused — Hugging Face Hub public repos must be useful to AI/ML or open science, not arbitrary personal files. Mark the project as an open dataset / open-science resource to use Hugging Face as an upload target.",
    );
  }
  if (
    prefix === "wm" &&
    !flags.isEducational &&
    !flags.isCreativeCommons
  ) {
    throw new Error(
      "upload to wm: refused — Wikimedia Commons accepts only freely licensed (CC-BY / CC-BY-SA / Public Domain) educational or encyclopedic media. Mark the project as an educational resource or a Creative Commons work to use Wikimedia Commons as an upload target.",
    );
  }
}

/** Upload targets the client may OFFER for this project (UI + API agree). */
export function uploadTargetsFor(flags: ProjectFlags): {
  prefix: BackendPrefix;
  offered: boolean;
  reason?: string;
}[] {
  return (Object.keys(BACKENDS) as BackendPrefix[]).map((prefix) => {
    try {
      assertUploadAllowed(prefix, flags);
      return { prefix, offered: true };
    } catch (err) {
      return {
        prefix,
        offered: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Mirror failover (thread turn 42)
// ---------------------------------------------------------------------------

export interface MirrorAttempt {
  uri: string;
  url: string;
  status: number | null;
  error?: string;
  ms: number;
}

export interface MirrorReadResult {
  result: BackendReadResult;
  /** The URI that finally answered. */
  uri: string;
  attempts: MirrorAttempt[];
}

/**
 * Try URIs in order until one reads successfully. A failure is any
 * thrown error, a timeout, or a non-200 status. Each mirror gets its own
 * per-mirror timeout (default 5000 ms); the whole call fails only when
 * every mirror has failed, with the last error in the message.
 */
export async function readWithMirrors(
  uris: string[],
  fetchFn: NetworkFetch,
  opts?: { perMirrorTimeoutMs?: number },
): Promise<MirrorReadResult> {
  if (uris.length === 0) throw new Error("readWithMirrors needs at least one URI");
  const timeoutMs = opts?.perMirrorTimeoutMs ?? 5000;
  const attempts: MirrorAttempt[] = [];
  let lastError: unknown = null;
  for (const uri of uris) {
    const started = Date.now();
    const url = backendFor(uri).readUrl(uri);
    try {
      const result = await backendFor(uri).read(uri, fetchFn, {
        timeoutMs,
      });
      attempts.push({ uri, url, status: result.status, ms: Date.now() - started });
      return { result, uri, attempts };
    } catch (err) {
      lastError = err;
      attempts.push({
        uri,
        url,
        status: null,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
    }
  }
  throw new Error(
    `all ${uris.length} mirror(s) failed for ${uris[0]}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** Convenience: read a registry entry's backend + mirrors in order. */
export function readRegistryEntry(
  entry: { backend: string; mirrors?: string[] },
  fetchFn: NetworkFetch,
  opts?: { perMirrorTimeoutMs?: number },
): Promise<MirrorReadResult> {
  return readWithMirrors([entry.backend, ...(entry.mirrors ?? [])], fetchFn, opts);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function b64encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
