// Tests: Phase 3a — threaded comments + federated search.
// All network is mocked (injected fetch functions). No test ever hits
// real GitHub or the real Internet Archive.
//
// HONEST GAPS this battery cannot close (needs the real world):
// - The GitHub Issue/Discussion write path is payload-shaped only: no
//   real repo exists yet, so no test posts an Issue or reads a live
//   Discussion. buildCommentIssuePayload / parseCommentIssueBody prove
//   the shapes round-trip; the live post/read against a real repo is
//   still unverified.
// - The IndexedDB search store is only proven to throw cleanly in Node
//   (no indexedDB here); its real read/write path needs a browser or
//   Tauri webview to verify.
// - Directory shards do not exist on GitHub yet, so shard loading is
//   proven against mocked raw.githubusercontent.com responses only.
import test from "node:test";
import assert from "node:assert/strict";
import { CachedFetcher, createMemoryCacheStore } from "../src/lib/cache.js";
import { compressJson } from "../src/lib/zstd.js";
import {
  ALLOWED_REACTIONS,
  MAX_COMMENT_DEPTH,
  applyModeration,
  buildCommentDiscussionPayload,
  buildCommentIssuePayload,
  buildCommentTree,
  canComment,
  canModerate,
  canReadComments,
  commentsRawUrl,
  commentsZstUrl,
  exportCommentsArchive,
  fetchComments,
  flattenTree,
  newComment,
  parseCommentIssueBody,
  reactionCounts,
  renderCommentMarkdownToSafeHtml,
  threadReactionCount,
  toggleReaction,
  userReaction,
  validateCommentBody,
  visibleCommentCount,
  type Comment,
  type CommentThread,
  type ModerationContext,
} from "../src/lib/viewer/comments.js";
import {
  MAX_SEARCH_HISTORY,
  SearchHistory,
  LocalSearchIndex,
  buildNewlyUpdatedFeed,
  buildTrendingFeed,
  createIndexedDBSearchStore,
  createMemorySearchStore,
  createMetadataCard,
  DEFAULT_DIRECTORY_CATEGORIES,
  directoryCategoriesFromManifest,
  directoryShardRepoName,
  directoryShardUrl,
  directoryShardZstUrl,
  isCompactCard,
  loadDirectoryShard,
  loadDirectoryShards,
  loadDirectoryShardsFromManifest,
  loadSearchIndex,
  metadataCardByteSize,
  parseMetadataCard,
  saveSearchIndex,
  tokenize,
  type MetadataCard,
  type SiteActivity,
} from "../src/lib/viewer/search.js";
import { commentsPanelView, searchResultSummary, searchView } from "../src/lib/viewer/viewer-ui.js";
import { EDITOR_ROLE, OWNER_ROLE, VIEWER_ROLE, WRITER_ROLE } from "../src/lib/roles.js";
import type { TeamRole } from "../src/lib/types.js";

const MASTER = "PropTheRtRevDrSirStanleyG05";

function mockTextFetch(map: Record<string, { status: number; body: string; etag?: string }>) {
  return async (url: string) => {
    const r = map[url];
    if (!r) return { status: 404, headers: { get: () => null }, text: async () => "not found" };
    return {
      status: r.status,
      headers: { get: (n: string) => (n.toLowerCase() === "etag" ? (r.etag ?? null) : null) },
      text: async () => r.body,
    };
  };
}

function mockBytesFetch(map: Record<string, { status: number; bytes: Uint8Array }>) {
  return async (url: string) => {
    const r = map[url];
    if (!r) return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
    return { status: r.status, headers: { get: () => null }, arrayBuffer: async () => buf as ArrayBuffer };
  };
}

function comment(id: string, parentId: string | null, createdAt: number, body = "hello"): Comment {
  return {
    id,
    parentId,
    domain: "computers.edu",
    pagePath: "blog/hello",
    author: { login: "alice" },
    body,
    createdAt,
    status: "visible",
    reactions: [],
  };
}

function thread(comments: Comment[], locked = false): CommentThread {
  return {
    id: "t1",
    domain: "computers.edu",
    pagePath: "blog/hello",
    title: "Hello",
    locked,
    comments,
    moderationLog: [],
  };
}

function ctx(login: string | null, siteOwner = "alice", role?: TeamRole): ModerationContext {
  return role === undefined ? { viewerLogin: login, siteOwner } : { viewerLogin: login, siteOwner, role };
}

// ---------------------------------------------------------------------------
// Comment tree: nesting, orphans, depth cap
// ---------------------------------------------------------------------------

test("comment tree nests replies, sorts oldest-first, and keeps orphans as roots", () => {
  const root = comment("c1", null, 100);
  const reply = comment("c2", "c1", 102);
  const reply2 = comment("c3", "c1", 101);
  const orphan = comment("c4", "missing-parent", 103);
  const tree = buildCommentTree([reply, root, orphan, reply2]);
  assert.equal(tree.length, 2, "root + orphan");
  assert.equal(tree[0]?.comment.id, "c1");
  assert.equal(tree[0]?.children.length, 2);
  assert.equal(tree[0]?.children[0]?.comment.id, "c3", "older reply first");
  assert.equal(tree[0]?.children[0]?.depth, 1);
  assert.equal(tree[1]?.comment.id, "c4", "orphan kept as a root, not dropped");
});

test("depth cap: a chain of 8 replies stays at depth 4, nothing is dropped, deep replies are flattened", () => {
  const chain: Comment[] = [comment("c0", null, 100)];
  for (let i = 1; i < 8; i++) chain.push(comment(`c${i}`, `c${i - 1}`, 100 + i));
  const tree = buildCommentTree(chain);
  const flat = flattenTree(tree);
  assert.equal(flat.length, 8, "every comment survives the depth cap");
  const depths = new Map(flat.map((c) => [c.id, treeDepth(tree, c.id)]));
  assert.equal(Math.max(...depths.values()), MAX_COMMENT_DEPTH);
  assert.equal(MAX_COMMENT_DEPTH, 4);
  const deep = flat.filter((c) => c.flattened === true);
  assert.ok(deep.length > 0, "replies past the cap are marked flattened");
  assert.ok(deep.every((c) => (depths.get(c.id) ?? 0) === MAX_COMMENT_DEPTH));
  assert.equal(flat.find((c) => c.id === "c7")?.flattened, true);
});

function treeDepth(nodes: ReturnType<typeof buildCommentTree>, id: string): number {
  for (const n of nodes) {
    if (n.comment.id === id) return n.depth;
    const d = treeDepth(n.children, id);
    if (d >= 0) return d;
  }
  return -1;
}

test("deleted comments stay as placeholders so their replies keep their place", () => {
  const root = comment("c1", null, 100);
  root.status = "deleted";
  const reply = comment("c2", "c1", 101);
  const tree = buildCommentTree([root, reply]);
  assert.equal(tree[0]?.comment.status, "deleted");
  assert.equal(tree[0]?.children.length, 1, "replies to a deleted comment are kept");
  assert.equal(visibleCommentCount(thread([root, reply])), 1);
});

// ---------------------------------------------------------------------------
// Markdown sanitisation
// ---------------------------------------------------------------------------

test("markdown sanitisation: script tags, onerror handlers and javascript: links never survive", () => {
  const evil =
    `<script>alert("xss")</script>\n` +
    `<img src="x" onerror="alert(1)">\n` +
    `<a href="https://ok.example" onclick="steal()">click</a>\n` +
    `[evil](javascript:alert(1))\n` +
    `[good](https://example.com/page)`;
  const html = renderCommentMarkdownToSafeHtml(evil);
  assert.ok(!html.includes("<script"), "no script tag");
  // The words survive only as escaped visible text (e.g. onerror=&quot;…),
  // never as live markup: no real attribute quotes, no real tag.
  assert.ok(!html.includes('onerror="') && !html.includes("onerror='"), "no live onerror handler");
  assert.ok(!html.includes('onclick="') && !html.includes("onclick='"), "no live onclick handler");
  assert.ok(!html.includes("javascript:"), "no javascript: URL");
  assert.ok(html.includes("&lt;script&gt;"), "the script tag is shown as escaped text");
  assert.ok(html.includes("&lt;img"), "the img tag is shown as escaped text, never as a tag");
  assert.ok(html.includes('<a href="https://example.com/page"'), "good https link renders");
  assert.ok(!html.includes("<img"), "no raw img tag at all");
});

test("markdown renders the whitelisted subset: bold, italic, code, quote, list", () => {
  const html = renderCommentMarkdownToSafeHtml(
    "**bold** and *italic* and `code`\n> a quote\n- one\n- two",
  );
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>italic</em>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes("<blockquote>a quote</blockquote>"));
  assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

test("reactions: one per user per comment — toggle off, switch replaces", () => {
  let c = comment("c1", null, 100);
  c = toggleReaction(c, "alice", "👍");
  assert.deepEqual(reactionCounts(c), { "👍": 1 });
  assert.equal(userReaction(c, "alice"), "👍");
  c = toggleReaction(c, "alice", "❤️");
  assert.deepEqual(reactionCounts(c), { "❤️": 1 }, "switching emoji replaces, never adds a second");
  c = toggleReaction(c, "alice", "❤️");
  assert.deepEqual(reactionCounts(c), {}, "same emoji again removes it");
  c = toggleReaction(c, "alice", "👍");
  c = toggleReaction(c, "bob", "👍");
  assert.equal(reactionCounts(c)["👍"], 2);
  assert.throws(() => toggleReaction(c, "alice", "💩"), /not an allowed reaction/);
  assert.ok(ALLOWED_REACTIONS.includes("👍"));
});

// ---------------------------------------------------------------------------
// Moderation gating
// ---------------------------------------------------------------------------

test("moderation gating: comments.moderate required; Root Master can moderate anywhere; a plain reader cannot", () => {
  const guest = ctx(null);
  const reader = ctx("mallory", "alice", VIEWER_ROLE);
  const writer = ctx("bob", "alice", WRITER_ROLE);
  const editor = ctx("carol", "alice", EDITOR_ROLE); // editor role carries comments.moderate
  const owner = ctx("alice", "alice", OWNER_ROLE);
  const masterElsewhere = ctx(MASTER, "alice");
  assert.equal(canModerate(guest), false);
  assert.equal(canModerate(reader), false, "a plain reader cannot moderate");
  assert.equal(canModerate(writer), false, "writer role has no comments.moderate flag");
  assert.equal(canModerate(editor), true, "editor role has comments.moderate");
  assert.equal(canModerate(owner), true, "site owner moderates their own site");
  assert.equal(canModerate(masterElsewhere), true, "Root Master moderates anywhere");
  assert.equal(canReadComments(guest).allowed, true, "guests read free");
});

test("applyModeration records who, when and why; needs a reason; non-moderators are refused", () => {
  const t = thread([comment("c1", null, 100)]);
  const hidden = applyModeration(t, ctx("alice"), "hide", "c1", "spam link", 1700000000);
  assert.equal(hidden.comments[0]?.status, "hidden");
  assert.equal(hidden.moderationLog.length, 1);
  assert.deepEqual(hidden.moderationLog[0], { action: "hide", by: "alice", at: 1700000000, reason: "spam link" });
  const locked = applyModeration(hidden, ctx(MASTER, "alice"), "lock", null, "thread went off-topic", 1700000100);
  assert.equal(locked.locked, true);
  assert.equal(locked.lockedReason, "thread went off-topic");
  assert.equal(locked.moderationLog.length, 2);
  const unlocked = applyModeration(locked, ctx("alice"), "unlock", null, "cooled down", 1700000200);
  assert.equal(unlocked.locked, false);
  assert.throws(() => applyModeration(t, ctx("alice"), "hide", "c1", "   "), /needs a reason/);
  assert.throws(() => applyModeration(t, ctx("mallory", "alice", VIEWER_ROLE), "hide", "c1", "nope"), /Only the site owner/);
  assert.throws(() => applyModeration(t, ctx("alice"), "delete", "no-such-id", "gone"), /no comment with id/);
});

test("canComment: guests are told to sign in; a locked thread blocks even signed-in users", () => {
  const open = thread([]);
  assert.equal(canComment(ctx(null), open).allowed, false);
  assert.match(canComment(ctx(null), open).reason, /Sign in with GitHub/);
  assert.equal(canComment(ctx("alice"), open).allowed, true);
  const locked = thread([], true);
  locked.lockedReason = "under review";
  assert.equal(canComment(ctx("alice"), locked).allowed, false);
  assert.match(canComment(ctx("alice"), locked).reason, /under review/);
});

test("validateCommentBody rejects empty and over-long comments", () => {
  assert.equal(validateCommentBody("  ").allowed, false);
  assert.equal(validateCommentBody("x".repeat(5001)).allowed, false);
  assert.equal(validateCommentBody("hello").allowed, true);
  assert.throws(() => newComment({ id: "c1", parentId: null, domain: "a.zine", pagePath: "index", authorLogin: "alice", body: "" }), /cannot be empty/);
});

// ---------------------------------------------------------------------------
// Issue / Discussion payloads
// ---------------------------------------------------------------------------

test("comment Issue payload round-trips: build then parse recovers id, body, author and parent", () => {
  const t = thread([]);
  const c = comment("c9", "c1", 1700000000, "I **agree** with this.");
  const payload = buildCommentIssuePayload(t, c);
  assert.match(payload.title, /COMMENT: computers\.edu/);
  assert.ok(payload.labels.includes("arknetz-comment"));
  const back = parseCommentIssueBody(payload.body);
  assert.equal(back.id, "c9");
  assert.equal(back.parentId, "c1");
  assert.equal(back.author.login, "alice");
  assert.equal(back.body, "I **agree** with this.");
  assert.throws(() => parseCommentIssueBody("no json block here"), /no arknetz-comment JSON block/);
});

test("comment Discussion payload uses the Comments category and the same title as the Issue", () => {
  const t = thread([]);
  const c = comment("c1", null, 100, "first!");
  const disc = buildCommentDiscussionPayload(t, c);
  const issue = buildCommentIssuePayload(t, c);
  assert.equal(disc.category, "Comments");
  assert.equal(disc.title, issue.title);
  assert.equal(disc.body, issue.body);
});

// ---------------------------------------------------------------------------
// Comments mirror read path (mocked raw.githubusercontent.com)
// ---------------------------------------------------------------------------

test("comments mirror: plain comments.json loads via the raw CDN, .zst is tried first", async () => {
  const url = commentsRawUrl("alice", "arknetz-site-computers-edu");
  const zstUrl = commentsZstUrl("alice", "arknetz-site-computers-edu");
  assert.ok(url.startsWith("https://raw.githubusercontent.com/alice/arknetz-site-computers-edu/main/comments.json"));
  assert.ok(zstUrl.endsWith("comments.json.zst"));
  const body = JSON.stringify({ threads: [thread([comment("c1", null, 100)])] });
  const fetcher = new CachedFetcher(createMemoryCacheStore(), mockTextFetch({ [url]: { status: 200, body } }));
  const threads = await fetchComments("alice", "arknetz-site-computers-edu", fetcher);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.comments[0]?.id, "c1");
});

test("comments mirror: a real .zst payload decompresses (compressJson round-trip)", async () => {
  const zstUrl = commentsZstUrl("alice", "arknetz-site-computers-edu");
  const zstBytes = await compressJson({ threads: [thread([comment("c1", null, 100, "zst comment")])] });
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    mockTextFetch({}),
    mockBytesFetch({ [zstUrl]: { status: 200, bytes: zstBytes } }),
  );
  const threads = await fetchComments("alice", "arknetz-site-computers-edu", fetcher);
  assert.equal(threads[0]?.comments[0]?.body, "zst comment");
});

// ---------------------------------------------------------------------------
// Archive export
// ---------------------------------------------------------------------------

test("archive export shape: only threads older than the cutoff, with file/version/domain/reason", () => {
  const now = 1700000000;
  const oldThread = thread([comment("c1", null, now - 200 * 86400)]);
  oldThread.id = "old";
  const freshThread = thread([comment("c2", null, now - 5 * 86400)]);
  freshThread.id = "fresh";
  const archive = exportCommentsArchive("computers.edu", [oldThread, freshThread], { now });
  assert.equal(archive.file, "comments-archive.json.zst");
  assert.equal(archive.version, 1);
  assert.equal(archive.domain, "computers.edu");
  assert.equal(archive.exportedAt, now);
  assert.match(archive.reason, /180 days/);
  assert.deepEqual(archive.threads.map((t) => t.id), ["old"], "only the stale thread is archived");
});

// ---------------------------------------------------------------------------
// Metadata cards
// ---------------------------------------------------------------------------

test("metadata card is ~150 bytes: a typical card fits the 200-byte budget", () => {
  const card = createMetadataCard({
    domain: "computers.edu",
    title: "Computers",
    tags: ["tech", "edu"],
    category: "tech",
    updated_timestamp: 1700000000,
  });
  const size = metadataCardByteSize(card);
  assert.ok(size <= 200, `typical card is ${size} bytes, over the 200-byte budget`);
  assert.ok(size >= 100, `typical card is ${size} bytes, suspiciously small`);
  assert.equal(isCompactCard(card), true);
  const huge = createMetadataCard({
    domain: "computers.edu",
    title: "A".repeat(300),
    tags: ["tech"],
    category: "tech",
    updated_timestamp: 1700000000,
  });
  assert.equal(isCompactCard(huge), false, "an oversized card is rejected, not truncated");
});

test("parseMetadataCard rejects a bad domain and a missing updated_timestamp", () => {
  assert.throws(() => parseMetadataCard({ domain: "bad", title: "t", tags: [], category: "tech", updated_timestamp: 1 }), /invalid domain/);
  assert.throws(
    () => parseMetadataCard({ domain: "a.zine", title: "t", tags: [], category: "tech" }),
    /updated_timestamp/,
  );
  assert.equal(parseMetadataCard({ domain: "a.zine", title: "t", tags: ["x"], category: "tech", updated_timestamp: 5 }).domain, "a.zine");
});

// ---------------------------------------------------------------------------
// Inverted index: tokenise, rank, prefix
// ---------------------------------------------------------------------------

function sampleCards(): MetadataCard[] {
  return [
    createMetadataCard({ domain: "computers.edu", title: "Computers and Code", tags: ["tech"], category: "tech", updated_timestamp: 100 }),
    createMetadataCard({ domain: "zine.example", title: "A Quiet Zine", tags: ["computers", "art"], category: "art", updated_timestamp: 200 }),
    createMetadataCard({ domain: "films.example", title: "Indie Films", tags: ["cinema"], category: "cinema", updated_timestamp: 300 }),
  ];
}

test("search ranking: a title hit beats a tag hit, which beats a domain hit", () => {
  const index = new LocalSearchIndex();
  index.addCards(sampleCards());
  const hits = index.search("computers");
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.card.domain, "computers.edu", "title hit (weight 3 x exact 2) outranks tag hit (weight 2 x exact 2)");
  assert.equal(hits[1]?.card.domain, "zine.example");
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
});

test("search prefix matching: 'comp' matches 'computers' before the word is finished", () => {
  const index = new LocalSearchIndex();
  index.addCards(sampleCards());
  const hits = index.search("comp");
  assert.ok(hits.some((h) => h.card.domain === "computers.edu"));
  assert.ok(hits.every((h) => h.matchedTerms.some((t) => t.startsWith("comp"))));
});

test("tokenize drops stopwords and single characters; empty queries return no hits", () => {
  assert.deepEqual(tokenize("The Computers of AI"), ["computers", "ai"]);
  const index = new LocalSearchIndex();
  index.addCards(sampleCards());
  assert.deepEqual(index.search(""), []);
  assert.deepEqual(index.search("the"), []);
  assert.deepEqual(index.search("zzz-no-match"), []);
});

test("search respects the category filter and the limit", () => {
  const index = new LocalSearchIndex();
  index.addCards(sampleCards());
  assert.deepEqual(index.search("computers", { category: "art" }).map((h) => h.card.domain), ["zine.example"]);
  assert.equal(index.search("computers", { limit: 1 }).length, 1);
});

test("index add/remove round-trip: removing a card removes its terms", () => {
  const index = new LocalSearchIndex();
  index.addCards(sampleCards());
  assert.equal(index.size, 3);
  index.removeCard("computers.edu");
  assert.equal(index.size, 2);
  assert.equal(index.search("computers").length, 1, "only the tag hit remains");
});

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

test("Trending orders by activity in the last 7 days; stale and zero activity are excluded", () => {
  const now = 1700000000;
  const cards = sampleCards();
  const activity: SiteActivity[] = [
    { domain: "computers.edu", comments: 2, reactions: 1, lastActivityAt: now - 3600 },
    { domain: "zine.example", comments: 10, reactions: 0, lastActivityAt: now - 8 * 86400 },
    { domain: "films.example", comments: 0, reactions: 0, lastActivityAt: now - 100 },
  ];
  const trending = buildTrendingFeed(cards, activity, now);
  assert.deepEqual(trending.map((t) => t.card.domain), ["computers.edu"]);
  assert.equal(trending[0]?.activityScore, 3);
  const busier: SiteActivity[] = [
    { domain: "computers.edu", comments: 2, reactions: 1, lastActivityAt: now - 3600 },
    { domain: "films.example", comments: 5, reactions: 5, lastActivityAt: now - 7200 },
  ];
  assert.deepEqual(buildTrendingFeed(cards, busier, now).map((t) => t.card.domain), ["films.example", "computers.edu"]);
});

test("Newly Updated orders by updated_timestamp, newest first", () => {
  const feed = buildNewlyUpdatedFeed(sampleCards());
  assert.deepEqual(feed.map((c) => c.domain), ["films.example", "zine.example", "computers.edu"]);
  assert.equal(buildNewlyUpdatedFeed(sampleCards(), 2).length, 2);
});

// ---------------------------------------------------------------------------
// Shard loading (mocked)
// ---------------------------------------------------------------------------

test("directory shard loads as plain JSON; .zst is tried first and decompresses", async () => {
  const url = directoryShardUrl("tech");
  const zstUrl = url.replace(/\.json$/, ".json.zst");
  assert.ok(url.startsWith("https://raw.githubusercontent.com/"));
  assert.ok(url.endsWith("directory-tech.json"));
  // Fix round 2, item 7: shards live in per-category repos
  // (REPO-TOPOLOGY.md §8), not in protocol-root.
  assert.equal(directoryShardRepoName("tech"), "arknetz-directory-tech");
  assert.equal(
    url,
    `https://raw.githubusercontent.com/${MASTER}/arknetz-directory-tech/main/directory-tech.json`,
  );
  assert.equal(
    directoryShardZstUrl("tech"),
    `https://raw.githubusercontent.com/${MASTER}/arknetz-directory-tech/main/directory-tech.json.zst`,
  );
  assert.equal(zstUrl, directoryShardZstUrl("tech"));
  assert.ok(!url.includes("protocol-root"), "must not fetch directory shards from protocol-root");
  assert.deepEqual(DEFAULT_DIRECTORY_CATEGORIES, ["tech", "cinema", "games"]);
  const shardBody = JSON.stringify({ category: "tech", version: 1, updated: 1700000000, cards: sampleCards() });
  const plain = await loadDirectoryShard(
    "tech",
    new CachedFetcher(createMemoryCacheStore(), mockTextFetch({ [url]: { status: 200, body: shardBody } })),
  );
  assert.equal(plain.category, "tech");
  assert.equal(plain.cards.length, 3);
  const zstBytes = await compressJson({ category: "tech", version: 1, updated: 1700000000, cards: sampleCards() });
  const zst = await loadDirectoryShard(
    "tech",
    new CachedFetcher(createMemoryCacheStore(), mockTextFetch({}), mockBytesFetch({ [zstUrl]: { status: 200, bytes: zstBytes } })),
  );
  assert.equal(zst.cards[0]?.domain, "computers.edu");
});

test("loadDirectoryShards skips a category with no shard (404) but throws on a corrupt shard", async () => {
  const shards = await loadDirectoryShards(
    ["tech", "no-such-category"],
    new CachedFetcher(
      createMemoryCacheStore(),
      mockTextFetch({
        [directoryShardUrl("tech")]: {
          status: 200,
          body: JSON.stringify({ category: "tech", version: 1, updated: 1, cards: sampleCards() }),
        },
      }),
    ),
  );
  assert.equal(shards.length, 1);
  assert.equal(shards[0]?.category, "tech");
  await assert.rejects(
    () =>
      loadDirectoryShards(
        ["tech"],
        new CachedFetcher(
          createMemoryCacheStore(),
          mockTextFetch({ [directoryShardUrl("tech")]: { status: 200, body: "{not json" } }),
        ),
      ),
    /JSON|not valid JSON/,
  );
});

test("directory shard URL rejects an invalid category slug instead of fetching a nonsense URL", async () => {
  assert.throws(() => directoryShardUrl("Tech News"), /invalid directory category/);
  assert.throws(() => directoryShardUrl("../protocol-root"), /invalid directory category/);
  assert.throws(() => directoryShardUrl(""), /invalid directory category/);
  await assert.rejects(
    () => loadDirectoryShard("bad category!", new CachedFetcher(createMemoryCacheStore(), mockTextFetch({}))),
    /invalid directory category/,
  );
});

test("loadDirectoryShard throws on a wrong-category shard and on a corrupt .zst — never silently indexes", async () => {
  const wrong = JSON.stringify({ category: "games", version: 1, updated: 1, cards: sampleCards() });
  await assert.rejects(
    () =>
      loadDirectoryShard(
        "tech",
        new CachedFetcher(createMemoryCacheStore(), mockTextFetch({ [directoryShardUrl("tech")]: { status: 200, body: wrong } })),
      ),
    /wrong shard/,
  );
  const corrupt = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 9, 9, 9]);
  await assert.rejects(
    () =>
      loadDirectoryShard(
        "tech",
        new CachedFetcher(
          createMemoryCacheStore(),
          mockTextFetch({}),
          mockBytesFetch({ [directoryShardZstUrl("tech")]: { status: 200, bytes: corrupt } }),
        ),
      ),
    /Zstd|corrupt/i,
  );
});

// ---------------------------------------------------------------------------
// Index persistence + search history (local only)
// ---------------------------------------------------------------------------

test("search index saves and loads through the memory store (serialize round-trip)", async () => {
  const store = createMemorySearchStore();
  const index = new LocalSearchIndex();
  index.addCards(sampleCards());
  await saveSearchIndex(index, store);
  const loaded = await loadSearchIndex(store);
  assert.equal(loaded.size, 3);
  assert.equal(loaded.search("computers")[0]?.card.domain, "computers.edu");
  assert.equal((await loadSearchIndex(createMemorySearchStore())).size, 0, "empty store loads an empty index");
});

test("search history is local-only: records, dedupes, caps at 20, clears", async () => {
  const history = new SearchHistory(createMemorySearchStore());
  await history.record("Computers");
  await history.record("films");
  await history.record("computers");
  assert.deepEqual(await history.list(), ["computers", "films"], "re-recording moves the query to the top, no duplicate");
  for (let i = 0; i < 25; i++) await history.record(`q${i}`);
  assert.equal((await history.list()).length, MAX_SEARCH_HISTORY);
  assert.equal(MAX_SEARCH_HISTORY, 20);
  await history.clear();
  assert.deepEqual(await history.list(), []);
});

test("IndexedDB search store throws cleanly where IndexedDB does not exist (Node)", () => {
  assert.throws(() => createIndexedDBSearchStore(), /IndexedDB is not available/);
});

// ---------------------------------------------------------------------------
// Viewer view-models (pure functions, no DOM)
// ---------------------------------------------------------------------------

test("comments panel view-model: guest reads but cannot comment; moderator flag and placeholders show", () => {
  const deleted = comment("c1", null, 100, "gone");
  deleted.status = "deleted";
  const t = thread([deleted, comment("c2", "c1", 101, "**hi**")]);
  const guestView = commentsPanelView(t, ctx(null));
  assert.equal(guestView.canRead, true);
  assert.equal(guestView.canComment, false);
  assert.ok(guestView.signInPrompt?.includes("Sign in with GitHub"));
  assert.equal(guestView.comments[0]?.placeholder, "Comment deleted.");
  assert.equal(guestView.comments[0]?.safeHtml, "");
  assert.ok(guestView.comments[1]?.safeHtml.includes("<strong>hi</strong>"));
  assert.equal(guestView.totalCount, 2);
  assert.equal(guestView.visibleCount, 1);
  const modView = commentsPanelView(t, ctx("alice"));
  assert.equal(modView.canModerate, true);
  assert.equal(modView.comments[1]?.canModerateThis, true);
  const emptyView = commentsPanelView(thread([]), ctx("alice"));
  assert.equal(emptyView.emptyCopy, "No comments yet — be the first to say something.");
});

test("search view-model: empty query and no-results copy, plus a readable result summary", () => {
  const index = new LocalSearchIndex();
  index.addCards(sampleCards());
  const empty = searchView({ query: "  ", hits: [], trending: [], newlyUpdated: [], history: [] });
  assert.equal(empty.emptyCopy, "Type a word or two — search looks through site titles, tags and domains.");
  const none = searchView({ query: "zzz", hits: [], trending: [], newlyUpdated: [], history: ["zzz"] });
  assert.match(none.emptyCopy ?? "", /Nothing matched/);
  const hits = index.search("computers");
  const view = searchView({ query: "computers", hits, trending: [], newlyUpdated: [], history: [], offline: true });
  assert.equal(view.resultCount, 2);
  assert.equal(view.offlineNote, "Searching your downloaded directory — results may be older than the live network.");
  const firstResult = view.results[0];
  assert.ok(firstResult);
  assert.equal(
    searchResultSummary(firstResult),
    "Computers and Code — computers.edu · tech · tech",
  );
});

test("thread reaction count feeds Trending: comments + reactions across a thread", () => {
  let c = comment("c1", null, 100);
  c = toggleReaction(c, "alice", "👍");
  c = toggleReaction(c, "bob", "❤️");
  const t = thread([c, comment("c2", null, 101)]);
  assert.equal(threadReactionCount(t), 2);
});

// ---------------------------------------------------------------------------
// Manifest-discoverable directory categories (fix round 3, item 4).
// ---------------------------------------------------------------------------

test("directoryCategoriesFromManifest uses the manifest list, falls back to the default, rejects bad lists", () => {
  assert.deepEqual(directoryCategoriesFromManifest({ directoryCategories: ["music", "travel"] } as never), ["music", "travel"]);
  assert.deepEqual(directoryCategoriesFromManifest({} as never), ["tech", "cinema", "games"]);
  assert.deepEqual(directoryCategoriesFromManifest(null), ["tech", "cinema", "games"]);
  assert.deepEqual(directoryCategoriesFromManifest(undefined), ["tech", "cinema", "games"]);
  assert.throws(() => directoryCategoriesFromManifest({ directoryCategories: [] } as never), /non-empty array/);
  assert.throws(() => directoryCategoriesFromManifest({ directoryCategories: "tech" } as never), /non-empty array/);
  assert.throws(() => directoryCategoriesFromManifest({ directoryCategories: ["Tech News"] } as never), /invalid directory category/);
  assert.throws(() => directoryCategoriesFromManifest({ directoryCategories: ["tech", "../x"] } as never), /invalid directory category/);
  // The returned list is a copy: mutating it must not mutate the manifest.
  const manifest = { directoryCategories: ["music"] } as never;
  const list = directoryCategoriesFromManifest(manifest);
  list.push("evil");
  assert.deepEqual(directoryCategoriesFromManifest(manifest), ["music"]);
});

test("loadDirectoryShardsFromManifest loads a category the default list never named", async () => {
  const musicCard = createMetadataCard({ domain: "songs.example", title: "Kitchen Sessions", tags: ["music"], category: "music", updated_timestamp: 400 });
  const musicUrl = directoryShardUrl("music");
  const musicZst = directoryShardZstUrl("music");
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    mockTextFetch({
      [musicUrl]: { status: 200, body: JSON.stringify({ category: "music", version: 1, updated: 1, cards: [musicCard] }) },
    }),
    mockBytesFetch({ [musicZst]: { status: 200, bytes: await compressJson({ category: "music", version: 1, updated: 1, cards: [musicCard] }) } }),
  );
  // The manifest names "music" (not in the default tech/cinema/games):
  // search must load it instead of the default list.
  const shards = await loadDirectoryShardsFromManifest({ directoryCategories: ["music"] } as never, fetcher);
  assert.equal(shards.length, 1);
  assert.equal(shards[0]?.category, "music");
  assert.equal(shards[0]?.cards[0]?.domain, "songs.example");
});

test("loadDirectoryShardsFromManifest falls back to the default list when the manifest has no field", async () => {
  const techUrl = directoryShardUrl("tech");
  const fetcher = new CachedFetcher(
    createMemoryCacheStore(),
    mockTextFetch({
      [techUrl]: { status: 200, body: JSON.stringify({ category: "tech", version: 1, updated: 1, cards: sampleCards().filter((c) => c.category === "tech") }) },
    }),
  );
  const shards = await loadDirectoryShardsFromManifest({} as never, fetcher);
  assert.equal(shards.length, 1);
  assert.equal(shards[0]?.category, "tech");
  // Null manifest (nothing fetched yet) behaves the same.
  const shards2 = await loadDirectoryShardsFromManifest(null, fetcher);
  assert.equal(shards2.length, 1);
});
