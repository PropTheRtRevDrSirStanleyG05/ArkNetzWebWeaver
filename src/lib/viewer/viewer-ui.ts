// ArkNetzWebWeaver — viewer view-models for comments + search (Phase 3a).
// PURE FUNCTIONS ONLY: no DOM access, no network, no IndexedDB here.
// Each function takes the module data (thread, index hits, feeds) and the
// viewer's context and returns plain view data — strings, booleans and
// small objects — that the coordinator wires into the shell DOM later.
// All user-facing copy lives in COPY below, in plain English, so the
// coordinator never invents wording at the call site.

import {
  buildCommentTree,
  canComment,
  canModerate,
  canReadComments,
  flattenTree,
  reactionCounts,
  renderCommentMarkdownToSafeHtml,
  userReaction,
  visibleCommentCount,
  type CommentThread,
  type CommentTreeNode,
  type ModerationContext,
} from "./comments.js";
import type { MetadataCard, SearchHit, TrendingEntry } from "./search.js";

export const COPY = {
  commentsTitle: "Comments",
  commentsEmpty: "No comments yet — be the first to say something.",
  commentsGuestRead: "You can read every comment without signing in.",
  commentsSignInPrompt: "Sign in with GitHub to join the discussion.",
  commentsLocked: "This thread is locked — no new replies can be added.",
  commentsDeletedPlaceholder: "Comment deleted.",
  commentsHiddenPlaceholder: "Comment hidden by a moderator.",
  commentsReplyLabel: "Reply",
  commentsFlattenedNote: "Moved up a level — this thread is already 5 replies deep.",
  commentsSignInButton: "Sign in with GitHub",
  commentsModerateHint: "You can moderate this thread: hide, delete or lock comments.",
  commentsArchiveNote: "Older threads are archived to comments-archive.json.zst so the live thread stays fast.",
  searchPlaceholder: "Search sites across the network…",
  searchEmptyQuery: "Type a word or two — search looks through site titles, tags and domains.",
  searchNoResults: "Nothing matched. Try a shorter word, or browse Trending and Newly Updated instead.",
  searchTrendingTitle: "Trending this week",
  searchTrendingEmpty: "No site has had comments or reactions in the last 7 days yet.",
  searchNewlyUpdatedTitle: "Newly updated",
  searchNewlyUpdatedEmpty: "No sites in the directory yet.",
  searchHistoryTitle: "Recent searches",
  searchHistoryEmpty: "Your recent searches will show here — they stay on this device and are never sent anywhere.",
  searchOfflineNote: "Searching your downloaded directory — results may be older than the live network.",
} as const;

// ---------------------------------------------------------------------------
// Comments panel view-model
// ---------------------------------------------------------------------------

export interface CommentView {
  id: string;
  parentId: string | null;
  depth: number;
  authorLogin: string;
  /** Safe HTML — already escaped and rendered, ready to set as innerHTML. */
  safeHtml: string;
  createdAt: number;
  status: "visible" | "hidden" | "deleted";
  /** Shown when status is hidden/deleted instead of safeHtml. */
  placeholder: string | null;
  flattened: boolean;
  reactions: Record<string, number>;
  myReaction: string | null;
  canModerateThis: boolean;
}

export interface CommentsPanelView {
  threadId: string;
  domain: string;
  pagePath: string;
  title: string;
  canRead: boolean;
  canComment: boolean;
  commentBlockedReason: string;
  canModerate: boolean;
  locked: boolean;
  lockedReason: string | null;
  totalCount: number;
  visibleCount: number;
  emptyCopy: string | null;
  signInPrompt: string | null;
  flattenedNote: string | null;
  comments: CommentView[];
}

function commentView(node: CommentTreeNode, ctx: ModerationContext): CommentView {
  const c = node.comment;
  const placeholder =
    c.status === "deleted"
      ? COPY.commentsDeletedPlaceholder
      : c.status === "hidden"
        ? COPY.commentsHiddenPlaceholder
        : null;
  return {
    id: c.id,
    parentId: c.parentId,
    depth: node.depth,
    authorLogin: c.author.login,
    safeHtml: placeholder === null ? renderCommentMarkdownToSafeHtml(c.body) : "",
    createdAt: c.createdAt,
    status: c.status,
    placeholder,
    flattened: c.flattened === true,
    reactions: reactionCounts(c),
    myReaction: ctx.viewerLogin ? userReaction(c, ctx.viewerLogin) : null,
    canModerateThis: canModerate(ctx),
  };
}

export function commentsPanelView(thread: CommentThread, ctx: ModerationContext): CommentsPanelView {
  const tree = buildCommentTree(thread.comments);
  const flat = flattenTree(tree);
  const commentGate = canComment(ctx, thread);
  const readGate = canReadComments(ctx);
  return {
    threadId: thread.id,
    domain: thread.domain,
    pagePath: thread.pagePath,
    title: thread.title,
    canRead: readGate.allowed,
    canComment: commentGate.allowed,
    commentBlockedReason: commentGate.allowed ? "" : commentGate.reason,
    canModerate: canModerate(ctx),
    locked: thread.locked,
    lockedReason: thread.locked ? (thread.lockedReason ?? null) : null,
    totalCount: thread.comments.length,
    visibleCount: visibleCommentCount(thread),
    emptyCopy: thread.comments.length === 0 ? COPY.commentsEmpty : null,
    signInPrompt: !ctx.viewerLogin ? COPY.commentsSignInPrompt : null,
    flattenedNote: flat.some((c) => c.flattened === true) ? COPY.commentsFlattenedNote : null,
    comments: walkViews(tree, ctx),
  };
}

function walkViews(nodes: CommentTreeNode[], ctx: ModerationContext): CommentView[] {
  const out: CommentView[] = [];
  for (const n of nodes) {
    out.push(commentView(n, ctx));
    out.push(...walkViews(n.children, ctx));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search UI view-model
// ---------------------------------------------------------------------------

export interface SearchResultView {
  domain: string;
  title: string;
  tags: string[];
  category: string;
  updatedAt: number;
  score: number;
  matchedTerms: string[];
}

export interface SearchView {
  query: string;
  hasQuery: boolean;
  results: SearchResultView[];
  resultCount: number;
  emptyCopy: string | null;
  trending: TrendingEntry[];
  newlyUpdated: MetadataCard[];
  history: string[];
  offlineNote: string | null;
}

export function searchView(input: {
  query: string;
  hits: SearchHit[];
  trending: TrendingEntry[];
  newlyUpdated: MetadataCard[];
  history: string[];
  /** True when the results come from the locally cached directory
   *  because the network shards could not be refreshed. */
  offline?: boolean;
}): SearchView {
  const query = input.query.trim();
  const hasQuery = query.length > 0;
  return {
    query,
    hasQuery,
    results: input.hits.map((h) => ({
      domain: h.card.domain,
      title: h.card.title,
      tags: h.card.tags,
      category: h.card.category,
      updatedAt: h.card.updated_timestamp,
      score: h.score,
      matchedTerms: h.matchedTerms,
    })),
    resultCount: input.hits.length,
    emptyCopy: !hasQuery
      ? COPY.searchEmptyQuery
      : input.hits.length === 0
        ? COPY.searchNoResults
        : null,
    trending: input.trending,
    newlyUpdated: input.newlyUpdated,
    history: input.history,
    offlineNote: input.offline === true ? COPY.searchOfflineNote : null,
  };
}

/** One-line summary for a search result, e.g. "Computers — computers.edu · tech". */
export function searchResultSummary(view: SearchResultView): string {
  const tags = view.tags.length > 0 ? ` · ${view.tags.join(", ")}` : "";
  return `${view.title} — ${view.domain} · ${view.category}${tags}`;
}
