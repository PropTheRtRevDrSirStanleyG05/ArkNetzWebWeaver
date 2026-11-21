// ArkNetzWebWeaver — threaded comments (Phase 3a).
// Thread turn 37 + READINESS-PARITY §2: threaded comments via GitHub
// Discussions/Issues in the SITE OWNER'S repo (Giscus/Utterances model).
// Guests read free, signed-in users comment. Owners, teams with the
// `comments.moderate` flag, and the Root Master retain moderation.
//
// Storage model (two layers, both in the owner's repo):
//   1. WRITE path — one GitHub Issue (or Discussion) per comment thread.
//      The payload shapes below are the exact bodies the client posts
//      through the authenticated GitHub API. Writes are never anonymous.
//   2. READ path — guests must never need an API token, and routine reads
//      must never hit api.github.com (thread turn 11, 60/hr unauthenticated).
//      So the client ALSO keeps a rolled-up `comments.json` /
//      `comments.json.zst` mirror in the site repo and reads THAT via
//      raw.githubusercontent.com with the CachedFetcher ETag cache.
//      The mirror is rebuilt on Publish / on each moderation action; a
//      live Discussion read via the authenticated API is the fallback
//      when the mirror is stale, and is NOT implemented here — it needs
//      a real Discussions/Issues repo to verify against, which does not
//      exist yet (see the honest gaps in the test file header).
//
// This module is transport-injected and DOM-free: every network call goes
// through a caller-supplied fetcher, every render is a pure function
// returning safe HTML strings. The coordinator wires it into the shell UI.
//
// Depth rule (stated once, enforced in buildCommentTree): a thread is at
// most MAX_COMMENT_DEPTH levels deep — root comments are depth 0 and the
// deepest reply is depth 4 (5 levels total). A reply to a comment already
// at depth 4 is NOT dropped and NOT nested deeper: it is attached to that
// depth-4 ancestor as a sibling, with `flattened: true`, so the reply
// stays visible and the conversation stays readable. No comment is ever
// silently lost to the depth cap.

import { assertRawReadUrl, CachedFetcher } from "../cache.js";
import { isMasterUser } from "../auth.js";
import { RAW_GITHUB_BASE } from "../config.js";
import { decompressJson } from "../zstd.js";
import { can } from "../roles.js";
import type { TeamRole } from "../types.js";

/** Root comments are depth 0; the deepest reply is depth 4. */
export const MAX_COMMENT_DEPTH = 4;
/** Longest comment body the client accepts (chars). */
export const MAX_COMMENT_LENGTH = 5000;

export type CommentStatus = "visible" | "hidden" | "deleted";

export interface CommentAuthor {
  /** GitHub login of the author. */
  login: string;
  avatarUrl?: string;
}

export interface CommentReaction {
  emoji: string;
  /** GitHub logins that chose this emoji. One reaction per user per
   *  comment, so a login appears in at most one entry. */
  users: string[];
}

/** The emoji a commenter may pick. Kept small on purpose: the set is
 *  part of the wire format, so a fork must render the same reactions. */
export const ALLOWED_REACTIONS: readonly string[] = [
  "👍",
  "❤️",
  "🎉",
  "😄",
  "🤔",
  "👀",
  "🚀",
];

export interface Comment {
  id: string;
  /** Null for a root comment. */
  parentId: string | null;
  /** Domain the comment belongs to, e.g. "computers.edu". */
  domain: string;
  /** Page path inside the site, e.g. "blog/hello" or "index". */
  pagePath: string;
  author: CommentAuthor;
  /** Raw Markdown as the author wrote it. NEVER rendered as-is — always
   *  through renderCommentMarkdownToSafeHtml(). */
  body: string;
  createdAt: number; // unix seconds
  updatedAt?: number;
  status: CommentStatus;
  reactions: CommentReaction[];
  /** True when this comment was flattened by the depth cap (see above). */
  flattened?: boolean;
}

export interface ModerationAction {
  action: "hide" | "delete" | "restore" | "lock" | "unlock";
  by: string; // GitHub login of the moderator
  at: number; // unix seconds
  reason: string;
}

export interface CommentThread {
  id: string;
  domain: string;
  pagePath: string;
  /** Title shown above the thread, e.g. the page title. */
  title: string;
  locked: boolean;
  lockedReason?: string;
  comments: Comment[];
  moderationLog: ModerationAction[];
  /** GitHub Issue number backing this thread, when one exists. */
  issueNumber?: number;
  /** GitHub Discussion number backing this thread, when one exists. */
  discussionNumber?: number;
}

export interface CommentTreeNode {
  comment: Comment;
  depth: number;
  children: CommentTreeNode[];
}

/** Who is asking to do something, and on whose site. */
export interface ModerationContext {
  /** Null = guest (not signed in). */
  viewerLogin: string | null;
  /** GitHub login that owns the site repo. */
  siteOwner: string;
  /** The viewer's team role on THIS site, if any. */
  role?: TeamRole;
}

export interface GateResult {
  allowed: boolean;
  /** Plain-language reason, shown in the UI when an action is blocked. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Reading: guests read free, no sign-in required.
// ---------------------------------------------------------------------------

/** Reading comments never needs a sign-in. Guests read free (thread
 *  turn 25/37). This is a function, not a constant, so the coordinator
 *  can call it in the same gating style as the write gates. */
export function canReadComments(_ctx: ModerationContext): GateResult {
  return { allowed: true, reason: "" };
}

/** Commenting needs a signed-in GitHub account, and the thread must not
 *  be locked. Guests see the sign-in prompt instead of a reply box. */
export function canComment(ctx: ModerationContext, thread: CommentThread): GateResult {
  if (!ctx.viewerLogin) {
    return {
      allowed: false,
      reason: "Sign in with GitHub to join the discussion — reading is free, commenting needs an account.",
    };
  }
  if (thread.locked) {
    return {
      allowed: false,
      reason: `This thread is locked${thread.lockedReason ? `: ${thread.lockedReason}` : ""}. No new replies can be added.`,
    };
  }
  return { allowed: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Moderation gating: Root Master > site owner > comments.moderate team.
// ---------------------------------------------------------------------------

/** True when the viewer may moderate THIS site's comments: the Root
 *  Master may moderate anywhere; the site owner may moderate their own
 *  site; a team member may moderate only with the `comments.moderate`
 *  flag on this site. A plain reader may never moderate. */
export function canModerate(ctx: ModerationContext): boolean {
  if (!ctx.viewerLogin) return false;
  if (isMasterUser(ctx.viewerLogin)) return true;
  if (ctx.viewerLogin === ctx.siteOwner) return true;
  if (ctx.role && can(ctx.role, "comments.moderate")) return true;
  return false;
}

export function gateModeration(ctx: ModerationContext): GateResult {
  if (canModerate(ctx)) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason: "Only the site owner, a team member with the comments.moderate flag, or the Root Master can moderate comments.",
  };
}

// ---------------------------------------------------------------------------
// Comment creation / validation
// ---------------------------------------------------------------------------

export function validateCommentBody(body: string): GateResult {
  if (!body || body.trim().length === 0) {
    return { allowed: false, reason: "A comment cannot be empty — write something first." };
  }
  if (body.length > MAX_COMMENT_LENGTH) {
    return {
      allowed: false,
      reason: `That comment is ${body.length} characters — the limit is ${MAX_COMMENT_LENGTH}. Shorten it and try again.`,
    };
  }
  return { allowed: true, reason: "" };
}

export function newComment(
  input: {
    id: string;
    parentId: string | null;
    domain: string;
    pagePath: string;
    authorLogin: string;
    body: string;
    createdAt?: number;
  },
): Comment {
  const check = validateCommentBody(input.body);
  if (!check.allowed) throw new Error(check.reason);
  return {
    id: input.id,
    parentId: input.parentId,
    domain: input.domain,
    pagePath: input.pagePath,
    author: { login: input.authorLogin },
    body: input.body,
    createdAt: input.createdAt ?? Math.floor(Date.now() / 1000),
    status: "visible",
    reactions: [],
  };
}

// ---------------------------------------------------------------------------
// Tree building (depth cap + orphan handling)
// ---------------------------------------------------------------------------

/** Build the nested reply tree. Rules, in order:
 *  1. Comments sort oldest-first within each level.
 *  2. A reply whose parent is missing (orphan — e.g. the parent was
 *     deleted before the mirror rebuilt) becomes a root comment rather
 *     than vanishing.
 *  3. Depth cap: a reply to a depth-4 comment attaches to that depth-4
 *     ancestor as a sibling, with `flattened: true`. Nothing is dropped.
 *  4. Deleted comments stay in the tree as placeholders ("Comment
 *     deleted") so their replies keep their place; the renderer shows
 *     the placeholder, never the deleted body. */
export function buildCommentTree(comments: Comment[]): CommentTreeNode[] {
  const byId = new Map<string, Comment>();
  for (const c of comments) byId.set(c.id, c);
  const sorted = [...comments].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const nodes = new Map<string, CommentTreeNode>();
  for (const c of sorted) {
    nodes.set(c.id, { comment: { ...c }, depth: 0, children: [] });
  }

  const roots: CommentTreeNode[] = [];
  for (const c of sorted) {
    const node = nodes.get(c.id) as CommentTreeNode;
    const parent = c.parentId ? nodes.get(c.parentId) : undefined;
    if (!parent) {
      // Root comment, or orphan whose parent is missing — keep it visible.
      node.depth = 0;
      roots.push(node);
      continue;
    }
    if (parent.depth >= MAX_COMMENT_DEPTH) {
      // Depth cap: attach to the depth-4 ancestor as a sibling.
      node.comment = { ...node.comment, flattened: true };
      node.depth = MAX_COMMENT_DEPTH;
      parent.children.push(node);
      continue;
    }
    node.depth = parent.depth + 1;
    parent.children.push(node);
  }
  return roots;
}

/** Every comment id in the tree, depth-first. Used to prove the depth
 *  cap never drops a comment. */
export function flattenTree(nodes: CommentTreeNode[]): Comment[] {
  const out: Comment[] = [];
  const walk = (ns: CommentTreeNode[]) => {
    for (const n of ns) {
      out.push(n.comment);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Count of visible (not hidden/deleted) comments in a thread. */
export function visibleCommentCount(thread: CommentThread): number {
  return thread.comments.filter((c) => c.status === "visible").length;
}

/** Total reaction count across a thread (for the Trending feed). */
export function threadReactionCount(thread: CommentThread): number {
  return thread.comments.reduce(
    (sum, c) => sum + c.reactions.reduce((s, r) => s + r.users.length, 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// Markdown -> SAFE HTML. Escape first, then render a small whitelisted
// subset: bold, italic, inline code, links, blockquotes, unordered lists.
// Raw HTML never survives: it is escaped before any rendering runs, so
// <script>, <img onerror=...>, <a onclick=...> and friends come out as
// harmless visible text. Links allow https://, http:// and arknetz://
// only — javascript:, data: and anything else renders as plain text.
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(escaped: string): string {
  // Inline code first, so * and _ inside code spans are not formatted.
  const codeSpans: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  // Bold (**text**) then italic (*text* / _text_).
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  // Links: [text](url) — allow-list the scheme.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    if (/^(https?:\/\/|arknetz:\/\/)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
    }
    return text; // disallowed scheme: plain text, no link at all
  });
  // Restore code spans (already escaped — they were escaped up front).
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codeSpans[Number(i)] ?? ""}</code>`);
  return out;
}

export function renderCommentMarkdownToSafeHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push(`<ul>${listItems.map((li) => `<li>${li}</li>`).join("")}</ul>`);
      listItems = [];
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^\s*$/.test(line)) {
      flushList();
      continue;
    }
    const listMatch = /^[-*]\s+(.+)$/.exec(line);
    if (listMatch) {
      listItems.push(renderInline(escapeHtml(listMatch[1] as string)));
      continue;
    }
    flushList();
    const quoteMatch = /^&gt;\s?(.*)$/.exec(escapeHtml(line));
    if (quoteMatch) {
      blocks.push(`<blockquote>${renderInline(quoteMatch[1] as string)}</blockquote>`);
      continue;
    }
    blocks.push(`<p>${renderInline(escapeHtml(line))}</p>`);
  }
  flushList();
  return blocks.join("");
}

// ---------------------------------------------------------------------------
// Reactions: one reaction per user per comment.
// ---------------------------------------------------------------------------

export function reactionCounts(comment: Comment): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of comment.reactions) out[r.emoji] = r.users.length;
  return out;
}

export function userReaction(comment: Comment, login: string): string | null {
  for (const r of comment.reactions) {
    if (r.users.includes(login)) return r.emoji;
  }
  return null;
}

/** Toggle a reaction. Same emoji again removes it; a different emoji
 *  replaces the user's previous one (one reaction per user per comment).
 *  Returns a NEW comment object; the input is not mutated. */
export function toggleReaction(comment: Comment, login: string, emoji: string): Comment {
  if (!ALLOWED_REACTIONS.includes(emoji)) {
    throw new Error(`"${emoji}" is not an allowed reaction — pick one of ${ALLOWED_REACTIONS.join(" ")}`);
  }
  const reactions = comment.reactions.map((r) => ({ emoji: r.emoji, users: [...r.users] }));
  const current = userReaction(comment, login);
  for (const r of reactions) {
    r.users = r.users.filter((u) => u !== login);
  }
  if (current !== emoji) {
    const entry = reactions.find((r) => r.emoji === emoji);
    if (entry) entry.users.push(login);
    else reactions.push({ emoji, users: [login] });
  }
  return {
    ...comment,
    reactions: reactions.filter((r) => r.users.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Moderation actions. Every action is recorded in the thread's
// moderationLog with who did it, when, and why — moderation is never
// silent. Client-side gating only: the matching server-side check is a
// GitHub Action on the site repo, which follows with the central repos.
// ---------------------------------------------------------------------------

export function applyModeration(
  thread: CommentThread,
  ctx: ModerationContext,
  action: ModerationAction["action"],
  commentId: string | null,
  reason: string,
  now?: number,
): CommentThread {
  const gate = gateModeration(ctx);
  if (!gate.allowed) throw new Error(gate.reason);
  if (!reason || reason.trim().length === 0) {
    throw new Error("A moderation action needs a reason — it is recorded in the moderation log.");
  }
  const at = now ?? Math.floor(Date.now() / 1000);
  const entry: ModerationAction = { action, by: ctx.viewerLogin as string, at, reason: reason.trim() };
  const comments = thread.comments.map((c) => {
    if (commentId === null || c.id !== commentId) return c;
    if (action === "hide") return { ...c, status: "hidden" as CommentStatus };
    if (action === "delete") return { ...c, status: "deleted" as CommentStatus };
    if (action === "restore") return { ...c, status: "visible" as CommentStatus };
    return c;
  });
  if (commentId !== null && !thread.comments.some((c) => c.id === commentId)) {
    throw new Error(`no comment with id "${commentId}" in this thread`);
  }
  return {
    ...thread,
    comments,
    locked: action === "lock" ? true : action === "unlock" ? false : thread.locked,
    lockedReason: action === "lock" ? reason.trim() : action === "unlock" ? undefined : thread.lockedReason,
    moderationLog: [...thread.moderationLog, entry],
  };
}

// ---------------------------------------------------------------------------
// GitHub Issues / Discussions payloads (write path) + raw read path.
// ---------------------------------------------------------------------------

export const COMMENT_ISSUE_LABEL = "arknetz-comment";
export const COMMENT_DISCUSSION_CATEGORY = "Comments";

/** Exact Issue payload for a new comment thread. One Issue per thread,
 *  in the site owner's repo, labelled so the client can find it again.
 *  The body carries the structured comment as JSON inside a fenced
 *  block, so the client can parse it back without guessing at prose. */
export function buildCommentIssuePayload(thread: CommentThread, comment: Comment): {
  title: string;
  body: string;
  labels: string[];
} {
  const stored = {
    version: 1,
    kind: "arknetz-comment",
    commentId: comment.id,
    threadId: thread.id,
    domain: thread.domain,
    pagePath: thread.pagePath,
    parentId: comment.parentId,
    author: comment.author.login,
    createdAt: comment.createdAt,
    body: comment.body,
  };
  return {
    title: `COMMENT: ${thread.domain} — ${thread.title}`,
    body: [
      `Comment on **${thread.domain}** / \`${thread.pagePath}\` by @${comment.author.login}.`,
      "",
      "```json",
      JSON.stringify(stored, null, 2),
      "```",
    ].join("\n"),
    labels: [COMMENT_ISSUE_LABEL, thread.domain],
  };
}

/** Parse a comment back out of an Issue body produced by
 *  buildCommentIssuePayload. Throws on a body that is not ours. */
export function parseCommentIssueBody(body: string): Comment {
  const match = /```json\s*([\s\S]*?)\s*```/.exec(body);
  if (!match) throw new Error("issue body has no arknetz-comment JSON block");
  let raw: unknown;
  try {
    raw = JSON.parse(match[1] as string);
  } catch {
    throw new Error("issue body arknetz-comment JSON block is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("issue comment payload is not an object");
  const p = raw as Record<string, unknown>;
  if (p.kind !== "arknetz-comment") throw new Error("issue body is not an arknetz-comment payload");
  if (typeof p.commentId !== "string" || typeof p.body !== "string" || typeof p.author !== "string") {
    throw new Error("issue comment payload is missing commentId, body or author");
  }
  return {
    id: p.commentId,
    parentId: typeof p.parentId === "string" ? p.parentId : null,
    domain: typeof p.domain === "string" ? p.domain : "",
    pagePath: typeof p.pagePath === "string" ? p.pagePath : "index",
    author: { login: p.author },
    body: p.body,
    createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
    status: "visible",
    reactions: [],
  };
}

/** Exact Discussion payload for a new comment thread (Giscus model:
 *  one Discussion per page, comments as replies). Same JSON block as
 *  the Issue payload so either store parses the same way. */
export function buildCommentDiscussionPayload(thread: CommentThread, comment: Comment): {
  title: string;
  body: string;
  category: string;
} {
  const issue = buildCommentIssuePayload(thread, comment);
  return { title: issue.title, body: issue.body, category: COMMENT_DISCUSSION_CATEGORY };
}

/** Raw read URL for the rolled-up comments mirror in a site repo:
 *  `comments.json.zst`, falling back to plain `comments.json`.
 *  The mirror is what guests read — zero API quota, ETag-cached. */
export function commentsRawUrl(owner: string, repo: string): string {
  return `${RAW_GITHUB_BASE}/${owner}/${repo}/main/comments.json`;
}

export function commentsZstUrl(owner: string, repo: string): string {
  return commentsRawUrl(owner, repo).replace(/\.json$/, ".json.zst");
}

export function parseCommentsFile(raw: unknown): CommentThread[] {
  if (typeof raw !== "object" || raw === null) throw new Error("comments file is not an object");
  const obj = raw as Record<string, unknown>;
  const list: unknown[] = Array.isArray(obj.threads) ? obj.threads : [];
  const threads: CommentThread[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) throw new Error("comments file has a thread that is not an object");
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || typeof t.domain !== "string" || !Array.isArray(t.comments)) {
      throw new Error("comments file thread is missing id, domain or comments");
    }
    threads.push({
      id: t.id,
      domain: t.domain,
      pagePath: typeof t.pagePath === "string" ? t.pagePath : "index",
      title: typeof t.title === "string" ? t.title : t.domain,
      locked: t.locked === true,
      lockedReason: typeof t.lockedReason === "string" ? t.lockedReason : undefined,
      comments: t.comments as Comment[],
      moderationLog: Array.isArray(t.moderationLog) ? (t.moderationLog as ModerationAction[]) : [],
      issueNumber: typeof t.issueNumber === "number" ? t.issueNumber : undefined,
      discussionNumber: typeof t.discussionNumber === "number" ? t.discussionNumber : undefined,
    });
  }
  return threads;
}

/** Fetch the comments mirror for a site repo: `.json.zst` first, plain
 *  `.json` on 404 — the same pattern as registry shards. A .zst that
 *  downloads but fails to decompress is corrupt and throws; it does NOT
 *  silently fall back. All network is through the injected fetcher. */
export async function fetchComments(owner: string, repo: string, fetcher: CachedFetcher): Promise<CommentThread[]> {
  const zstUrl = commentsZstUrl(owner, repo);
  assertRawReadUrl(zstUrl);
  const zst = await fetcher.fetchBytes(zstUrl);
  if (zst.bytes) return parseCommentsFile(await decompressJson(zst.bytes));
  const url = commentsRawUrl(owner, repo);
  assertRawReadUrl(url);
  const res = await fetcher.fetch(url);
  return parseCommentsFile(JSON.parse(res.body));
}

// ---------------------------------------------------------------------------
// Archive export: older threads -> comments-archive.json.zst shape.
// ---------------------------------------------------------------------------

export interface CommentsArchive {
  /** File this serialises to: comments-archive.json.zst (compressed with
   *  Zstd by the caller — see compressJson in zstd.ts). */
  file: "comments-archive.json.zst";
  version: 1;
  domain: string;
  exportedAt: number; // unix seconds
  /** Why these threads were archived, e.g. "older than 180 days". */
  reason: string;
  threads: CommentThread[];
}

/** Export threads whose last comment is older than `olderThanSeconds`
 *  (default 180 days). The returned archive is plain JSON — the caller
 *  compresses it to comments-archive.json.zst. Exporting never deletes
 *  the live threads; deletion from the repo is a separate, explicit step. */
export function exportCommentsArchive(
  domain: string,
  threads: CommentThread[],
  opts?: { olderThanSeconds?: number; now?: number; reason?: string },
): CommentsArchive {
  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const cutoff = opts?.olderThanSeconds ?? 180 * 24 * 3600;
  const old = threads.filter((t) => {
    if (t.comments.length === 0) return false;
    const last = Math.max(...t.comments.map((c) => c.createdAt));
    return now - last > cutoff;
  });
  return {
    file: "comments-archive.json.zst",
    version: 1,
    domain,
    exportedAt: now,
    reason: opts?.reason ?? `threads with no new comments for ${Math.round(cutoff / 86400)} days`,
    threads: old,
  };
}
