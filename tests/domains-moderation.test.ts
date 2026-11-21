// Tests: Phase 4a — custom domains + two-tier moderation.
// All network is mocked (injected fetch functions). No test ever
// hits real GitHub or the real registry.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  addDelegation,
  buildRegisterIssue,
  checkAvailabilityAgainstShard,
  checkDomainAvailability,
  claimStatusFor,
  createClaim,
  advanceClaim,
  approveClaim,
  fetchDelegations,
  findParentDomain,
  isSubdomainOf,
  isValidBackendTarget,
  normalizeDomain,
  parseDelegations,
  parseRegisterIssueBody,
  parseRegisterIssueTitle,
  parseShardBody,
  parseShardEntries,
  rejectClaim,
  registryShardUrl,
  registryShardZstUrl,
  removeDelegation,
  resolveDomainTarget,
  shardForDomain,
  submitClaim,
  validateDomain,
  DEFAULT_BANNED_WORDS,
  type DomainClaim,
} from "../src/lib/domains.js";
import type { RegistryEntry, SiteDocument } from "../src/lib/types.js";
import {
  MASTER_GITHUB_USER,
  applyModerationPatches,
  createModerationPatch,
  isRootMaster,
  masterAdminPanelData,
  moderationTierFor,
  parseModerationFile,
  parseSubModerationFile,
  resolveEffectivePatches,
  type ModerationPatch,
} from "../src/lib/moderation.js";
import { buildAdminPanelViewModel, buildPatchFormViewModel, moderationNoticeForSite, patchSummary } from "../src/lib/moderation-ui.js";
import { buildClaimViewModel, buildDelegationViewModel } from "../src/lib/domains-ui.js";
import { compressJson } from "../src/lib/zstd.js";

const MASTER = "PropTheRtRevDrSirStanleyG05";

function mockFetch(map: Record<string, { status: number; body: string }>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const r = map[url];
    if (!r) return { status: 404, text: async () => "" };
    return { status: r.status, text: async () => r.body };
  };
  return { fn, calls };
}

/** Fixture entry. Default shard is the domain's real SHA256 shard
 *  (first hex digit) — real registry entries always carry it, and the
 *  availability check now throws on a wrong-shard entry, so fixtures
 *  must be protocol-valid; pass an explicit wrong shard to test that
 *  path. */
function entry(
  domain: string,
  owner = "alice",
  shard = createHash("sha256").update(domain).digest("hex")[0] as string,
): RegistryEntry {
  return { domain, backend: `gh:${owner}/arknetz-site-${domain.replace(/\./g, "-")}`, shard, owner };
}

function siteDoc(): SiteDocument {
  return {
    domain: "computers.edu",
    title: "Computers",
    blocks: [
      { type: "p", id: "b1", text: "secret words", runs: [{ text: "secret words", format: { bold: true } }] },
      { type: "img", id: "b2", src: "https://archive.org/download/x/a.webp", alt: "a photo" },
      { type: "p", id: "b3", text: "keep me" },
    ],
  };
}

function textPatch(id: string, tier: ModerationPatch["authorTier"], author: string, replacement: string, createdAt = 1000): ModerationPatch {
  return createModerationPatch({
    id,
    target: { kind: "domain", domain: "computers.edu" },
    action: "replace-text",
    replacementText: replacement,
    reason: "offending text",
    author,
    authorTier: tier,
    createdAt,
  });
}

// ---------------------------------------------------------------------------
// Domain validation
// ---------------------------------------------------------------------------

test("validation accepts exact full strings: computers.edu, edu.orion.stanbeyond, alex.zine", () => {
  for (const d of ["computers.edu", "edu.orion.stanbeyond", "alex.zine", "a-b.c-d.zine"]) {
    const v = validateDomain(d);
    assert.equal(v.valid, true, d);
    assert.equal(v.domain, d);
  }
});

test("validation normalises case and surrounding whitespace, and a trailing dot", () => {
  assert.deepEqual(validateDomain("  Computers.EDU "), { valid: true, domain: "computers.edu" });
  assert.equal(validateDomain("alex.zine.").domain, "alex.zine");
  assert.equal(normalizeDomain("  Edu.Orion.Stanbeyond "), "edu.orion.stanbeyond");
});

test("validation rejects TLD-only claims — no TLD monopolies", () => {
  for (const d of ["edu", "zine", "com"]) {
    const v = validateDomain(d);
    assert.equal(v.valid, false, d);
    assert.equal(v.code, "tld_only");
    assert.match(v.reason ?? "", /top-level domain/);
  }
});

test("validation rejects bad labels: empty, double dot, leading hyphen, underscore, spaces inside", () => {
  assert.equal(validateDomain("").code, "empty");
  assert.equal(validateDomain("a..edu").code, "bad_label");
  assert.equal(validateDomain(".computers.edu").code, "bad_label");
  assert.equal(validateDomain("-bad.edu").code, "bad_label");
  assert.equal(validateDomain("bad_name.edu").code, "bad_label");
  assert.equal(validateDomain("bad name.edu").code, "bad_label");
  assert.equal(validateDomain("bad-.edu").code, "bad_label");
  const long = `${"a".repeat(64)}.edu`;
  assert.equal(validateDomain(long).code, "label_too_long");
  assert.equal(validateDomain(`${"a".repeat(250)}.edu`).code, "too_long");
});

test("validation rejects banned words as whole labels, but not as substrings", () => {
  assert.equal(DEFAULT_BANNED_WORDS.includes("admin"), true);
  assert.equal(DEFAULT_BANNED_WORDS.includes("arknetz"), true);
  for (const d of ["admin.edu", "arknetz.zine", "support.computers.edu", "phishing.edu"]) {
    const v = validateDomain(d);
    assert.equal(v.valid, false, d);
    assert.equal(v.code, "banned_word");
  }
  // Substring is fine: the word must be a whole label.
  assert.equal(validateDomain("myadmin.edu").valid, true);
  assert.equal(validateDomain("arknetzwear.zine").valid, true);
});

// ---------------------------------------------------------------------------
// REGISTER Issue shape
// ---------------------------------------------------------------------------

test("buildRegisterIssue produces the REGISTER: title and a body with domain, claimant and Terms", () => {
  const issue = buildRegisterIssue("Computers.EDU", "alice", { acceptedTerms: true, requestedAt: 1794787200000 });
  assert.equal(issue.title, "REGISTER: computers.edu");
  assert.equal(issue.domain, "computers.edu");
  assert.equal(issue.claimant, "alice");
  assert.match(issue.body, /Domain: computers\.edu/);
  assert.match(issue.body, /Claimed by: @alice/);
  assert.match(issue.body, /Terms accepted: yes/);
  assert.match(issue.body, /Internet Archive Terms/);
});

test("buildRegisterIssue throws on an invalid domain or an empty claimant", () => {
  assert.throws(() => buildRegisterIssue("edu", "alice"), /top-level domain/);
  assert.throws(() => buildRegisterIssue("computers.edu", "  "), /no claimant/);
  assert.throws(() => buildRegisterIssue("admin.edu", "alice"), /reserved/);
});

test("parseRegisterIssueTitle / parseRegisterIssueBody round-trip a built issue", () => {
  const issue = buildRegisterIssue("alex.zine", "bob", { acceptedTerms: true });
  assert.equal(parseRegisterIssueTitle(issue.title), "alex.zine");
  assert.deepEqual(parseRegisterIssueBody(issue.body), { domain: "alex.zine", claimant: "bob" });
  assert.equal(parseRegisterIssueTitle("Hello world"), null);
  assert.equal(parseRegisterIssueTitle("REGISTER: "), null);
  assert.equal(parseRegisterIssueBody("no fields here"), null);
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test("checkAvailabilityAgainstShard: free vs taken across map, record and array shapes", () => {
  const e = entry("computers.edu");
  assert.equal(checkAvailabilityAgainstShard("computers.edu", new Map([["computers.edu", e]])).available, false);
  assert.equal(checkAvailabilityAgainstShard("other.edu", new Map([["computers.edu", e]])).available, true);
  assert.equal(checkAvailabilityAgainstShard("computers.edu", { "computers.edu": e }).available, false);
  assert.equal(checkAvailabilityAgainstShard("computers.edu", [e]).available, false);
  const taken = checkAvailabilityAgainstShard("computers.edu", [e]);
  assert.match(taken.reason ?? "", /already registered to @alice/);
  assert.equal(taken.entry?.owner, "alice");
  assert.equal(checkAvailabilityAgainstShard("edu", [e]).available, false);
  assert.match(checkAvailabilityAgainstShard("edu", [e]).reason ?? "", /top-level domain/);
});

test("shardForDomain is deterministic and registryShardUrl points at the master account shard repo", async () => {
  const a = await shardForDomain("computers.edu");
  assert.match(a, /^[0-9a-f]$/);
  assert.equal(a, await shardForDomain("computers.edu"));
  assert.equal(a, await shardForDomain("COMPUTERS.EDU"));
  assert.equal(
    await registryShardUrl("computers.edu"),
    `https://raw.githubusercontent.com/${MASTER}/arknetz-registry-0${a}/main/registry.json`,
  );
});

test("parseShardBody accepts a map and an entries array, and throws on bad JSON", () => {
  const e = entry("computers.edu");
  assert.equal(parseShardBody(JSON.stringify({ "computers.edu": e })).get("computers.edu")?.owner, "alice");
  assert.equal(parseShardBody(JSON.stringify({ entries: [e] })).size, 1);
  assert.throws(() => parseShardBody("not json"), /not valid JSON/);
  assert.throws(() => parseShardBody("[]"), /not an object/);
});

test("checkDomainAvailability over mocked fetch: taken, free, missing shard (404), server error throws", async () => {
  const url = await registryShardUrl("computers.edu");
  const e = entry("computers.edu");
  const taken = mockFetch({ [url]: { status: 200, body: JSON.stringify({ "computers.edu": e }) } });
  const r1 = await checkDomainAvailability("computers.edu", taken.fn);
  assert.equal(r1.available, false);
  assert.match(r1.reason ?? "", /already registered/);
  const free = mockFetch({ [url]: { status: 200, body: JSON.stringify({}) } });
  assert.equal((await checkDomainAvailability("computers.edu", free.fn)).available, true);
  const missing = mockFetch({});
  assert.equal((await checkDomainAvailability("computers.edu", missing.fn)).available, true);
  const broken = mockFetch({ [url]: { status: 500, body: "boom" } });
  await assert.rejects(() => checkDomainAvailability("computers.edu", broken.fn), /HTTP 500/);
  const noCall = mockFetch({});
  await checkDomainAvailability("edu", noCall.fn);
  assert.equal(noCall.calls.length, 0, "an invalid domain must not fetch anything");
});

/** Mock fetch serving a .zst shard (bytes) and/or the plain mirror
 *  (text), tracking every URL hit. Anything unmapped 404s. */
function mockShardFetch(opts: {
  zst?: { status: number; bytes?: Uint8Array };
  plain?: { status: number; body?: string };
}) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    if (url.endsWith("registry.json.zst")) {
      const r = opts.zst;
      if (!r) return { status: 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      const bytes = r.bytes ?? new Uint8Array(0);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return { status: r.status, text: async () => "", arrayBuffer: async () => buf };
    }
    const r = opts.plain;
    if (!r) return { status: 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    return { status: r.status, text: async () => r.body ?? "", arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { fn, calls };
}

test("checkDomainAvailability reads the canonical registry.json.zst first and never fetches plain when .zst exists", async () => {
  const shard = await shardForDomain("computers.edu");
  const zstUrl = await registryShardZstUrl("computers.edu");
  assert.equal(
    zstUrl,
    `https://raw.githubusercontent.com/${MASTER}/arknetz-registry-0${shard}/main/registry.json.zst`,
  );
  const takenDoc = { "computers.edu": entry("computers.edu", "alice", shard) };
  const taken = mockShardFetch({ zst: { status: 200, bytes: await compressJson(takenDoc) } });
  const r1 = await checkDomainAvailability("computers.edu", taken.fn);
  assert.equal(r1.available, false);
  assert.match(r1.reason ?? "", /already registered to @alice/);
  assert.deepEqual(taken.calls, [zstUrl], "plain registry.json must not be fetched when .zst exists");
  const free = mockShardFetch({ zst: { status: 200, bytes: await compressJson({}) } });
  assert.equal((await checkDomainAvailability("other.edu", free.fn)).available, true);
});

test("checkDomainAvailability falls back to plain registry.json only when the .zst 404s", async () => {
  const shard = await shardForDomain("computers.edu");
  const plainUrl = await registryShardUrl("computers.edu");
  const e = entry("computers.edu", "alice", shard);
  const taken = mockShardFetch({ plain: { status: 200, body: JSON.stringify({ "computers.edu": e }) } });
  assert.equal((await checkDomainAvailability("computers.edu", taken.fn)).available, false);
  assert.deepEqual(taken.calls, [await registryShardZstUrl("computers.edu"), plainUrl]);
  const missing = mockShardFetch({});
  assert.equal((await checkDomainAvailability("computers.edu", missing.fn)).available, true);
});

test("checkDomainAvailability: a corrupt .zst throws and never falls back to a plain mirror that says free", async () => {
  const corrupt = mockShardFetch({
    zst: { status: 200, bytes: new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 9, 9, 9]) },
    plain: { status: 200, body: JSON.stringify({}) },
  });
  await assert.rejects(() => checkDomainAvailability("computers.edu", corrupt.fn), /Zstd|corrupt/i);
  assert.equal(corrupt.calls.length, 1, "the plain mirror must not be consulted after a corrupt .zst");
  const broken = mockShardFetch({ zst: { status: 500 } });
  await assert.rejects(() => checkDomainAvailability("computers.edu", broken.fn), /HTTP 500/);
});

test("checkDomainAvailability: an entry filed in the wrong shard throws loudly instead of reading as free or taken", async () => {
  const shard = await shardForDomain("computers.edu");
  const wrongShard = shard === "0" ? "1" : "0";
  const doc = { "computers.edu": entry("computers.edu", "alice", wrongShard) };
  const fetch = mockShardFetch({ zst: { status: 200, bytes: await compressJson(doc) } });
  await assert.rejects(() => checkDomainAvailability("computers.edu", fetch.fn), /wrong shard/);
});

test("checkDomainAvailability throws when the fetch cannot supply .zst bytes (text-only fetch)", async () => {
  const zstUrl = await registryShardZstUrl("computers.edu");
  const textOnly = async (url: string) => {
    assert.equal(url, zstUrl, "the .zst is fetched first");
    return { status: 200, text: async () => "not bytes" };
  };
  await assert.rejects(() => checkDomainAvailability("computers.edu", textOnly), /arrayBuffer/);
});

test("parseShardEntries accepts a decompressed .zst document in map and entries-array shapes", () => {
  const e = entry("computers.edu", "alice", "a");
  assert.equal(parseShardEntries({ "computers.edu": e }).get("computers.edu")?.owner, "alice");
  assert.equal(parseShardEntries({ entries: [e] }).size, 1);
  assert.throws(() => parseShardEntries([]), /not an object/);
});

// ---------------------------------------------------------------------------
// Sub-delegation
// ---------------------------------------------------------------------------

test("addDelegation delegates ai.computers.edu, reports overwrites, and never mutates the input", () => {
  const before = {};
  const first = addDelegation(before, "computers.edu", "ai.computers.edu", "gh:sarah/ai-blog");
  assert.equal(first.delegations["ai.computers.edu"], "gh:sarah/ai-blog");
  assert.equal(first.overwrote, false);
  assert.deepEqual(before, {}, "input map must be untouched");
  const second = addDelegation(first.delegations, "computers.edu", "AI.Computers.EDU", "gh:sarah/ai-blog-v2");
  assert.equal(second.overwrote, true);
  assert.equal(second.delegations["ai.computers.edu"], "gh:sarah/ai-blog-v2");
});

test("addDelegation rejects non-subdomains, bad targets and invalid subdomains", () => {
  assert.throws(() => addDelegation({}, "computers.edu", "computers.edu", "gh:sarah/x"), /not a subdomain/);
  assert.throws(() => addDelegation({}, "computers.edu", "other.edu", "gh:sarah/x"), /not a subdomain/);
  assert.throws(() => addDelegation({}, "computers.edu", "ai.computers.edu", "sarah/ai-blog"), /backend target/);
  assert.throws(() => addDelegation({}, "computers.edu", "bad_name.computers.edu", "gh:sarah/x"), /not a valid domain/);
  assert.equal(isValidBackendTarget("gh:sarah/ai-blog"), true);
  assert.equal(isValidBackendTarget("gl:sarah/ai-blog"), true);
  assert.equal(isValidBackendTarget("cb:sarah/ai-blog"), true);
  assert.equal(isValidBackendTarget("https://example.com/x"), false);
});

test("removeDelegation removes and reports, and is a no-op for unknown subdomains", () => {
  const map = { "ai.computers.edu": "gh:sarah/ai-blog" };
  const removed = removeDelegation(map, "ai.computers.edu");
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.delegations, {});
  assert.deepEqual(map, { "ai.computers.edu": "gh:sarah/ai-blog" }, "input untouched");
  assert.equal(removeDelegation(map, "nope.computers.edu").removed, false);
});

test("isSubdomainOf and findParentDomain pick the longest registered parent", () => {
  assert.equal(isSubdomainOf("ai.computers.edu", "computers.edu"), true);
  assert.equal(isSubdomainOf("computers.edu", "computers.edu"), false);
  assert.equal(isSubdomainOf("notcomputers.edu", "computers.edu"), false);
  assert.equal(findParentDomain("deep.ai.computers.edu", ["computers.edu", "ai.computers.edu"]), "ai.computers.edu");
  assert.equal(findParentDomain("other.edu", ["computers.edu"]), null);
});

test("resolveDomainTarget follows registry → parent → delegations → site", () => {
  const reg = entry("computers.edu");
  const direct = resolveDomainTarget("computers.edu", { registryEntry: reg });
  assert.equal(direct.via, "registry");
  assert.equal(direct.backend, reg.backend);
  const del = resolveDomainTarget("ai.computers.edu", {
    parentEntry: reg,
    delegations: { "ai.computers.edu": "gh:sarah/ai-blog" },
  });
  assert.equal(del.via, "parent-delegation");
  assert.equal(del.backend, "gh:sarah/ai-blog");
  assert.equal(del.parentDomain, "computers.edu");
  const bare = resolveDomainTarget("ai.computers.edu", {
    delegations: { "ai.computers.edu": "gh:sarah/ai-blog" },
  });
  assert.equal(bare.via, "delegation");
  assert.equal(resolveDomainTarget("nope.computers.edu", { parentEntry: reg, delegations: {} }).via, "unresolved");
  assert.equal(resolveDomainTarget("nope.computers.edu", { parentEntry: reg, delegations: {} }).backend, null);
});

test("parseDelegations validates targets and domains; fetchDelegations treats 404 as empty", async () => {
  const good = parseDelegations({
    version: "0.1.0",
    domain: "computers.edu",
    owner: "alice",
    delegations: { "ai.computers.edu": "gh:sarah/ai-blog" },
  });
  assert.equal(good.delegations["ai.computers.edu"], "gh:sarah/ai-blog");
  assert.throws(
    () => parseDelegations({ domain: "computers.edu", delegations: { "ai.computers.edu": "nope" } }),
    /invalid backend target/,
  );
  assert.throws(
    () => parseDelegations({ domain: "computers.edu", delegations: { "bad_name.computers.edu": "gh:sarah/x" } }),
    /not a valid domain/,
  );
  const missing = mockFetch({});
  const empty = await fetchDelegations("gh:alice/arknetz-site-computers-edu", missing.fn);
  assert.deepEqual(empty.delegations, {});
  assert.equal(missing.calls[0], "https://raw.githubusercontent.com/alice/arknetz-site-computers-edu/main/delegations.json");
  const hit = mockFetch({
    "https://raw.githubusercontent.com/alice/arknetz-site-computers-edu/main/delegations.json": {
      status: 200,
      body: JSON.stringify({ domain: "computers.edu", owner: "alice", delegations: { "ai.computers.edu": "gh:sarah/ai-blog" } }),
    },
  });
  assert.equal((await fetchDelegations("gh:alice/arknetz-site-computers-edu", hit.fn)).delegations["ai.computers.edu"], "gh:sarah/ai-blog");
});

// ---------------------------------------------------------------------------
// Claim state machine
// ---------------------------------------------------------------------------

test("claim state machine: unclaimed → pending → registered, with issue + backend recorded", () => {
  const now = 1794787200000;
  const claim = createClaim("computers.edu", "alice", now);
  assert.equal(claim.status, "unclaimed");
  const pending = submitClaim(claim, { acceptedTerms: true, issueNumber: 42, issueUrl: "https://example.invalid/42", now: now + 1000 });
  assert.equal(pending.status, "pending");
  assert.equal(pending.issueNumber, 42);
  assert.equal(claim.status, "unclaimed", "submit returns a new claim, it does not mutate");
  const registered = approveClaim(pending, entry("computers.edu"), now + 2000);
  assert.equal(registered.status, "registered");
  assert.equal(registered.backend, "gh:alice/arknetz-site-computers-edu");
  assert.equal(registered.owner, "alice");
});

test("submitClaim requires Terms acceptance and a single submission", () => {
  const claim = createClaim("alex.zine", "bob");
  assert.throws(() => submitClaim(claim, { acceptedTerms: false }), /Terms/);
  const pending = submitClaim(claim, { acceptedTerms: true });
  assert.throws(() => submitClaim(pending, { acceptedTerms: true }), /only an unclaimed domain/);
});

test("approveClaim only from pending and only with a matching entry; rejectClaim carries the reason", () => {
  const claim = createClaim("alex.zine", "bob");
  assert.throws(() => approveClaim(claim, entry("alex.zine", "bob")), /only a pending claim/);
  const pending = submitClaim(claim, { acceptedTerms: true });
  assert.throws(() => approveClaim(pending, entry("other.zine", "bob")), /registry entry for "other\.zine"/);
  const rejected = rejectClaim(pending, "already_registered", "It belongs to @alice.");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reasonCode, "already_registered");
  assert.match(rejected.reason ?? "", /already registered to someone else/);
  assert.match(rejected.reason ?? "", /belongs to @alice/);
  assert.throws(() => rejectClaim(rejected, "banned_word"), /only an unclaimed or pending claim/);
});

test("advanceClaim enforces legal moves and throws naming illegal ones", () => {
  const claim = createClaim("alex.zine", "bob");
  const pending = advanceClaim(claim, { type: "submit", acceptedTerms: true });
  assert.equal(pending.status, "pending");
  assert.throws(() => advanceClaim(claim, { type: "approve", entry: entry("alex.zine", "bob") }), /only a pending claim/);
  assert.throws(() => advanceClaim(pending, { type: "submit", acceptedTerms: true }), /only an unclaimed domain/);
  const done = advanceClaim(pending, { type: "approve", entry: entry("alex.zine", "bob") });
  assert.equal(done.status, "registered");
  assert.throws(() => advanceClaim(done, { type: "reject", code: "banned_word" }), /only an unclaimed or pending claim/);
});

test("claimStatusFor reads registered / pending / unclaimed from the facts on hand", () => {
  const e = entry("computers.edu");
  const pendingClaim: DomainClaim = { ...createClaim("alex.zine", "bob"), status: "pending" };
  assert.equal(claimStatusFor("computers.edu", [e], [pendingClaim]), "registered");
  assert.equal(claimStatusFor("alex.zine", [e], [pendingClaim]), "pending");
  assert.equal(claimStatusFor("free.zine", [e], [pendingClaim]), "unclaimed");
});

// ---------------------------------------------------------------------------
// Moderation: master detection, tiers, resolution order
// ---------------------------------------------------------------------------

test("isRootMaster only for PropTheRtRevDrSirStanleyG05; MASTER_GITHUB_USER constant matches", () => {
  assert.equal(MASTER_GITHUB_USER, MASTER);
  assert.equal(isRootMaster(MASTER), true);
  assert.equal(isRootMaster("stanbeyond"), false);
  assert.equal(isRootMaster("alice"), false);
  assert.equal(isRootMaster(null), false);
  assert.equal(moderationTierFor(MASTER, { isRegistrar: true }), "root-master");
  assert.equal(moderationTierFor("alice", { isRegistrar: true }), "parent-registrar");
  assert.equal(moderationTierFor("alice", {}), "post-author");
});

test("createModerationPatch validates reason and action payloads, and derives the master tier", () => {
  const p = createModerationPatch({
    target: { kind: "domain", domain: "computers.edu" },
    action: "replace-text",
    replacementText: "[removed]",
    reason: "spam",
    author: MASTER,
    createdAt: 1000,
  });
  assert.equal(p.authorTier, "root-master");
  assert.match(p.id, /^patch-1000-/);
  assert.throws(
    () => createModerationPatch({ target: { kind: "domain", domain: "computers.edu" }, action: "replace-text", reason: "x", author: "a" }),
    /replacementText/,
  );
  assert.throws(
    () => createModerationPatch({ target: { kind: "domain", domain: "computers.edu" }, action: "replace-media", reason: "x", author: "a" }),
    /replacementMedia/,
  );
  assert.throws(
    () => createModerationPatch({ target: { kind: "domain", domain: "computers.edu" }, action: "remove", reason: " ", author: "a" }),
    /needs a reason/,
  );
});

test("resolution order: master beats registrar beats author on the same text", () => {
  const master = textPatch("p-master", "root-master", MASTER, "[removed by master]", 1000);
  const registrar = textPatch("p-reg", "parent-registrar", "alice", "[removed by registrar]", 900);
  const author = textPatch("p-author", "post-author", "bob", "[removed by author]", 800);
  const { effective, superseded } = resolveEffectivePatches([author, registrar, master]);
  assert.deepEqual(effective.map((p) => p.id), ["p-master"]);
  assert.deepEqual(superseded.map((s) => s.patch.id).sort(), ["p-author", "p-reg"]);
  assert.equal(superseded.find((s) => s.patch.id === "p-reg")?.supersededBy.id, "p-master");
  const regOnly = resolveEffectivePatches([author, registrar]);
  assert.deepEqual(regOnly.effective.map((p) => p.id), ["p-reg"]);
});

test("different fields on the same target do not conflict; a removal beats both", () => {
  const text = textPatch("p-text", "parent-registrar", "alice", "[gone]", 1000);
  const media = createModerationPatch({
    id: "p-media",
    target: { kind: "domain", domain: "computers.edu" },
    action: "replace-media",
    replacementMedia: "https://archive.org/download/x/placeholder.webp",
    reason: "bad image",
    author: "alice",
    authorTier: "parent-registrar",
    createdAt: 1001,
  });
  assert.equal(resolveEffectivePatches([text, media]).effective.length, 2);
  const removal = createModerationPatch({
    id: "p-remove",
    target: { kind: "post", domain: "computers.edu", postId: "b1" },
    action: "remove",
    reason: "takedown",
    author: MASTER,
    createdAt: 1002,
  });
  const resolved = resolveEffectivePatches([text, media, removal]);
  assert.ok(resolved.effective.some((p) => p.id === "p-remove"));
});

// ---------------------------------------------------------------------------
// Moderation: applying patches (pure — original untouched)
// ---------------------------------------------------------------------------

test("applyModerationPatches replaces text site-wide and clears inline runs, original untouched", () => {
  const original = siteDoc();
  const snapshot = JSON.stringify(original);
  const { document, removed, changes } = applyModerationPatches(original, [
    textPatch("p1", "root-master", MASTER, "[This text was removed by moderation]"),
  ]);
  assert.equal(removed, false);
  assert.equal(JSON.stringify(original), snapshot, "the input document must never be mutated");
  assert.equal(document.blocks[0]?.text, "[This text was removed by moderation]");
  assert.equal(document.blocks[0]?.runs, undefined);
  assert.equal(document.blocks[2]?.text, "[This text was removed by moderation]");
  assert.equal(changes.filter((c) => c.status === "applied").length, 1);
  assert.match(changes[0]?.detail ?? "", /Root Master/);
});

test("applyModerationPatches replaces text on one post only when a postId is given", () => {
  const { document } = applyModerationPatches(siteDoc(), [
    createModerationPatch({
      id: "p1",
      target: { kind: "post", domain: "computers.edu", postId: "b1" },
      action: "replace-text",
      replacementText: "[redacted]",
      reason: "private data",
      author: "alice",
      authorTier: "parent-registrar",
      createdAt: 1000,
    }),
  ]);
  assert.equal(document.blocks[0]?.text, "[redacted]");
  assert.equal(document.blocks[2]?.text, "keep me");
});

test("applyModerationPatches replaces media src and reports not-applied when nothing matches", () => {
  const { document, changes } = applyModerationPatches(siteDoc(), [
    createModerationPatch({
      id: "m1",
      target: { kind: "domain", domain: "computers.edu" },
      action: "replace-media",
      replacementMedia: "https://archive.org/download/x/placeholder.webp",
      reason: "copyright",
      author: MASTER,
      createdAt: 1000,
    }),
  ]);
  assert.equal(document.blocks[1]?.src, "https://archive.org/download/x/placeholder.webp");
  assert.equal(document.blocks[0]?.text, "secret words");
  const none = applyModerationPatches(siteDoc(), [
    createModerationPatch({
      id: "m2",
      target: { kind: "post", domain: "computers.edu", postId: "missing" },
      action: "replace-media",
      replacementMedia: "https://archive.org/download/x/placeholder.webp",
      reason: "copyright",
      author: MASTER,
      createdAt: 1000,
    }),
  ]);
  assert.equal(none.changes[0]?.status, "not-applied");
});

test("applyModerationPatches removes one post and leaves the rest; a missing post is not-applied", () => {
  const original = siteDoc();
  const snapshot = JSON.stringify(original);
  const { document, removed } = applyModerationPatches(original, [
    createModerationPatch({
      id: "r1",
      target: { kind: "post", domain: "computers.edu", postId: "b1" },
      action: "remove",
      reason: "takedown",
      author: MASTER,
      createdAt: 1000,
    }),
  ]);
  assert.equal(removed, false);
  assert.equal(JSON.stringify(original), snapshot);
  assert.deepEqual(document.blocks.map((b) => b.id), ["b2", "b3"]);
  const missing = applyModerationPatches(siteDoc(), [
    createModerationPatch({
      id: "r2",
      target: { kind: "post", domain: "computers.edu", postId: "nope" },
      action: "remove",
      reason: "takedown",
      author: MASTER,
      createdAt: 1000,
    }),
  ]);
  assert.equal(missing.document.blocks.length, 3);
  assert.equal(missing.changes[0]?.status, "not-applied");
});

test("applyModerationPatches removes a whole domain: placeholder document, removed true", () => {
  const { document, removed, changes } = applyModerationPatches(siteDoc(), [
    createModerationPatch({
      id: "d1",
      target: { kind: "domain", domain: "computers.edu" },
      action: "remove",
      reason: "illegal content",
      author: MASTER,
      createdAt: 1000,
    }),
  ]);
  assert.equal(removed, true);
  assert.deepEqual(document.blocks, []);
  assert.match(document.title, /removed by moderation/);
  assert.equal(changes.filter((c) => c.status === "applied").length, 1);
});

test("a patch for another domain does not apply to this site", () => {
  const { document, changes } = applyModerationPatches(siteDoc(), [
    textPatch("p-other", "root-master", MASTER, "[gone]"),
  ]);
  // textPatch targets computers.edu, so retarget it to another domain:
  const other = applyModerationPatches(siteDoc(), [
    createModerationPatch({
      id: "p-other",
      target: { kind: "domain", domain: "alex.zine" },
      action: "replace-text",
      replacementText: "[gone]",
      reason: "x",
      author: MASTER,
      createdAt: 1000,
    }),
  ]);
  assert.equal(other.document.blocks[0]?.text, "secret words");
  assert.equal(other.changes[0]?.status, "not-applied");
  assert.equal(document.blocks[0]?.text, "[gone]", "sanity: the computers.edu patch does apply");
  void changes;
});

test("parseModerationFile accepts a master file; parseSubModerationFile rejects root-master patches", () => {
  const master = textPatch("p1", "root-master", MASTER, "[gone]", 1000);
  const file = parseModerationFile({ version: "0.1.0", patches: [master] });
  assert.equal(file.patches.length, 1);
  assert.throws(() => parseModerationFile({ patches: [{ ...master, authorTier: "superuser" }] }), /invalid authorTier/);
  assert.throws(() => parseModerationFile({}), /no patches array/);
  const sub = parseSubModerationFile({
    version: "0.1.0",
    domain: "computers.edu",
    owner: "alice",
    patches: [textPatch("p2", "parent-registrar", "alice", "[gone]", 1000)],
  });
  assert.equal(sub.patches.length, 1);
  assert.throws(
    () => parseSubModerationFile({ domain: "computers.edu", owner: "alice", patches: [master] }),
    /cannot issue root-master patches/,
  );
});

test("masterAdminPanelData is null for non-master accounts and lists domains for the master", () => {
  const entries = [entry("computers.edu"), entry("alex.zine", "bob")];
  const patches = [textPatch("p1", "root-master", MASTER, "[gone]", 1000)];
  assert.equal(masterAdminPanelData("alice", entries, patches), null);
  assert.equal(masterAdminPanelData(null, entries, patches), null);
  const data = masterAdminPanelData(MASTER, entries, patches);
  assert.equal(data?.visible, true);
  assert.equal(data?.domains.length, 2);
  assert.equal(data?.domains[0]?.patchCount, 1);
  assert.equal(data?.domains[1]?.patchCount, 0);
  assert.equal(data?.totalPatches, 1);
});

// ---------------------------------------------------------------------------
// UI view-models (pure — no DOM)
// ---------------------------------------------------------------------------

test("domains-ui: claim view-model for signed-out, invalid, available, terms and taken states", () => {
  const signedOut = buildClaimViewModel("computers.edu", { signedIn: false, termsAccepted: false });
  assert.equal(signedOut.canSubmit, false);
  assert.match(signedOut.message, /Sign in with GitHub/);
  const invalid = buildClaimViewModel("edu", { signedIn: true, termsAccepted: true });
  assert.equal(invalid.valid, false);
  assert.match(invalid.message, /top-level domain/);
  const noTerms = buildClaimViewModel("computers.edu", { signedIn: true, termsAccepted: false, shard: [] });
  assert.equal(noTerms.canSubmit, false);
  assert.equal(noTerms.issueTitle, "REGISTER: computers.edu");
  const ready = buildClaimViewModel("computers.edu", { signedIn: true, termsAccepted: true, shard: [] });
  assert.equal(ready.canSubmit, true);
  assert.equal(ready.nextActionLabel, "Claim this domain");
  const taken = buildClaimViewModel("computers.edu", {
    signedIn: true,
    termsAccepted: true,
    availability: { domain: "computers.edu", available: false, shard: "a", reason: '"computers.edu" is already registered to @alice.' },
  });
  assert.equal(taken.canSubmit, false);
  assert.match(taken.message, /already registered/);
  const pending = buildClaimViewModel("alex.zine", {
    signedIn: true,
    termsAccepted: true,
    claim: { ...createClaim("alex.zine", "bob"), status: "pending" },
  });
  assert.equal(pending.status, "pending");
  assert.match(pending.message, /being processed/);
});

test("domains-ui: delegation view-model accepts a good delegation and refuses the rest", () => {
  const good = buildDelegationViewModel("computers.edu", "ai.computers.edu", "gh:sarah/ai-blog");
  assert.equal(good.canSave, true);
  assert.match(good.message, /will show the site at gh:sarah\/ai-blog/);
  assert.equal(buildDelegationViewModel("computers.edu", "other.edu", "gh:sarah/x").canSave, false);
  assert.equal(buildDelegationViewModel("computers.edu", "ai.computers.edu", "sarah/x").canSave, false);
});

test("moderation-ui: admin panel hidden entirely for non-master, shown for the master", () => {
  const entries = [entry("computers.edu")];
  const patches = [textPatch("p1", "root-master", MASTER, "[gone]", 1000)];
  const hidden = buildAdminPanelViewModel("alice", entries, patches);
  assert.equal(hidden.visible, false);
  assert.deepEqual(hidden.domains, []);
  assert.deepEqual(hidden.patches, []);
  const shown = buildAdminPanelViewModel(MASTER, entries, patches);
  assert.equal(shown.visible, true);
  assert.equal(shown.domains.length, 1);
  assert.equal(shown.patches.length, 1);
  assert.match(shown.patches[0]?.summary ?? "", /Replace text on computers\.edu/);
  assert.equal(patchSummary(patches[0] as ModerationPatch), 'Replace text on computers.edu with "[gone]"');
});

test("moderation-ui: patch form blocked for non-master, submittable for the master; notices only list applied changes", () => {
  const blocked = buildPatchFormViewModel("alice", "computers.edu");
  assert.equal(blocked.canSubmit, false);
  assert.match(blocked.blockedReason ?? "", /Only the Root Master/);
  const open = buildPatchFormViewModel(MASTER, "computers.edu", "b1");
  assert.equal(open.canSubmit, true);
  assert.equal(open.actions.length, 3);
  const { changes } = applyModerationPatches(siteDoc(), [
    textPatch("p1", "root-master", MASTER, "[gone]", 1000),
    textPatch("p2", "parent-registrar", "alice", "[other]", 900),
  ]);
  const notices = moderationNoticeForSite(changes);
  assert.equal(notices.length, 1, "only the applied master patch is reader news; the superseded one is not");
  assert.match(notices[0] ?? "", /Root Master/);
  assert.deepEqual(moderationNoticeForSite([]), []);
});

// ---------------------------------------------------------------------------
// protocol/register.yml — hand-rolled YAML shape check (no YAML dep)
// ---------------------------------------------------------------------------

test("protocol/register.yml is valid-shaped YAML with the expected jobs and steps", () => {
  const yml = readFileSync(new URL("../protocol/register.yml", import.meta.url), "utf8");
  assert.ok(!yml.includes("\t"), "YAML must not contain tabs");
  assert.match(yml, /^name: Register domain/m);
  assert.match(yml, /^on:\n  issues:\n    types: \[opened\]/m);
  assert.match(yml, /permissions:\n  contents: write\n  issues: write/);
  assert.match(yml, /^jobs:\n  register:/m);
  assert.match(yml, /if: startsWith\(github\.event\.issue\.title, 'REGISTER:'\)/);
  assert.match(yml, /uses: actions\/checkout@v4/);
  assert.match(yml, /uses: actions\/github-script@v7/);
  const stepNames = [...yml.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1]);
  assert.ok(stepNames.length >= 6, `expected at least 6 named steps, got ${stepNames.length}: ${stepNames.join(" | ")}`);
  assert.ok(stepNames.some((s) => /Parse the REGISTER issue/.test(s as string)));
  assert.ok(stepNames.some((s) => /Commit the new registry entry/.test(s as string)));
  assert.ok(stepNames.some((s) => /Confirm and close/.test(s as string)));
  // The workflow enforces the same rules as domains.ts: TLD-only and
  // banned words are rejected, the shard is recompressed with zstd.
  assert.match(yml, /top-level domain/);
  assert.match(yml, /"admin", "root"/);
  assert.match(yml, /zstd.*registry\.json.*registry\.json\.zst/);
  assert.match(yml, /git commit -m "Register /); // commit message carries the domain
  // No per-user limit and no account-age gate may be ENFORCED by the
  // template: there must be no lookup of a user's account creation
  // date and no per-user domain cap. (The header comment documents
  // that both were rejected by Stanley — that prose is not enforcement.)
  assert.doesNotMatch(yml, /created_at/i);
  assert.doesNotMatch(yml, /max.?domains|domains.?per.?user/i);
});
