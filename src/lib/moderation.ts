// ArkNetzWebWeaver — two-tier moderation (Phase 4a).
// Thread turns 9, 12: Root Master (Stanley) holds
// `moderation.json.zst` in the central repo and can edit/delete/redact
// any domain, subdomain or post globally — including a content
// override / redaction patch that replaces offending text/media at
// render time. Registrars (domain owners) hold
// `sub_moderation.json.zst` in their own site repo and control their
// subdomains/posts. Resolution order: Root Master → Parent Registrar
// → Post Author. A patch from a lower tier NEVER overrides a higher
// tier.
// Enforcement is GitHub repo write permissions, NOT secrets in the
// app: only the master's GitHub account can write to the central
// moderation repo, so a forced UI cannot bypass GitHub's 403 for
// anyone else. This module only decides what a patch does at render
// time and whether the admin panel is shown; it never grants write
// access by itself.
// This module imports nothing: the master username is hard-coded
// here as a named constant, deliberately, so the moderation decision
// does not depend on any other module. src/lib/config.ts owns the
// canonical MASTER_GITHUB_USER — keep the two in sync.

import type { BlockNode, RegistryEntry, SiteDocument } from "./types.js";
import { validateDomain } from "./domains.js";

/** Root Master GitHub login. Canonical owner: src/lib/config.ts
 *  (MASTER_GITHUB_USER). Duplicated here on purpose — see the header
 *  comment — so moderation.ts imports nothing. */
export const MASTER_GITHUB_USER = "PropTheRtRevDrSirStanleyG05";

/** Is this GitHub login the Root Master? The app only REVEALS the
 *  Master Admin Panel for this login; enforcement is GitHub's 403. */
export function isRootMaster(githubLogin: string | null | undefined): boolean {
  return githubLogin === MASTER_GITHUB_USER;
}

export type ModerationTier = "root-master" | "parent-registrar" | "post-author";

/** Higher number wins. Root Master (3) beats Parent Registrar (2)
 *  beats Post Author (1). */
export const TIER_RANK: Record<ModerationTier, number> = {
  "post-author": 1,
  "parent-registrar": 2,
  "root-master": 3,
};

export const TIER_LABELS: Record<ModerationTier, string> = {
  "root-master": "Root Master",
  "parent-registrar": "Parent Registrar",
  "post-author": "Post Author",
};

/** Which tier is this login acting at for a domain? The caller
 *  supplies whether the login is the domain's registrar (owner of
 *  the parent domain) or the post's author; the master check is done
 *  here and always wins. */
export function moderationTierFor(
  githubLogin: string | null | undefined,
  opts: { isRegistrar?: boolean; isAuthor?: boolean } = {},
): ModerationTier {
  if (isRootMaster(githubLogin)) return "root-master";
  if (opts.isRegistrar) return "parent-registrar";
  return "post-author";
}

// ---------------------------------------------------------------------------
// ModerationPatch + file shapes
// ---------------------------------------------------------------------------

export type PatchTargetKind = "domain" | "subdomain" | "post";

export type PatchAction = "replace-text" | "replace-media" | "remove";

export interface PatchTarget {
  kind: PatchTargetKind;
  /** The domain or subdomain the patch applies to. */
  domain: string;
  /** For kind "post": the id of the block/post it targets. When
   *  absent on a domain/subdomain patch, the patch applies to the
   *  whole site. */
  postId?: string;
  /** Alias for postId, accepted on input. */
  blockId?: string;
}

export interface ModerationPatch {
  id: string;
  target: PatchTarget;
  action: PatchAction;
  /** Required for "replace-text": the text readers see instead. */
  replacementText?: string;
  /** Required for "replace-media": the IA hotlink readers see instead. */
  replacementMedia?: string;
  /** Plain-English reason, shown to readers where content was changed. */
  reason: string;
  /** GitHub login that issued the patch. */
  author: string;
  authorTier: ModerationTier;
  /** Unix seconds. */
  createdAt: number;
}

export interface ModerationFile {
  version: string;
  updated?: number;
  patches: ModerationPatch[];
}

export interface SubModerationFile {
  version: string;
  /** The domain this file moderates. */
  domain: string;
  owner: string;
  updated?: number;
  patches: ModerationPatch[];
}

/** Build a patch, filling in the tier from the author when it is not
 *  given. Validates: a reason is required; replace-text needs
 *  replacementText; replace-media needs replacementMedia. The id is
 *  derived from author + time + target when not supplied, so two
 *  patches from the same author at different times never collide. */
export function createModerationPatch(input: {
  id?: string;
  target: PatchTarget;
  action: PatchAction;
  replacementText?: string;
  replacementMedia?: string;
  reason: string;
  author: string;
  authorTier?: ModerationTier;
  createdAt?: number;
}): ModerationPatch {
  const author = input.author.trim();
  if (!author) throw new Error("a moderation patch needs an author GitHub login");
  const reason = input.reason.trim();
  if (!reason) throw new Error("a moderation patch needs a reason — readers see it where content was changed");
  if (input.action === "replace-text" && !(input.replacementText ?? "").trim()) {
    throw new Error("a replace-text patch needs replacementText");
  }
  if (input.action === "replace-media" && !(input.replacementMedia ?? "").trim()) {
    throw new Error("a replace-media patch needs replacementMedia");
  }
  const targetDomain = input.target.domain.trim().toLowerCase();
  const v = validateDomain(targetDomain);
  if (!v.valid) throw new Error(`a moderation patch needs a valid target domain: ${v.reason ?? targetDomain}`);
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const authorTier =
    input.authorTier ?? moderationTierFor(author, {});
  const id =
    input.id ??
    `patch-${createdAt}-${author.replace(/[^a-z0-9-]/gi, "").toLowerCase()}-${targetDomain.replace(/\./g, "-")}`;
  return {
    id,
    target: {
      kind: input.target.kind,
      domain: targetDomain,
      postId: input.target.postId ?? input.target.blockId,
    },
    action: input.action,
    replacementText: input.replacementText,
    replacementMedia: input.replacementMedia,
    reason,
    author,
    authorTier,
    createdAt,
  };
}

export function parseModerationPatch(raw: unknown): ModerationPatch {
  if (typeof raw !== "object" || raw === null) throw new Error("moderation patch is not an object");
  const p = raw as Record<string, unknown>;
  const tier = p.authorTier;
  if (tier !== "root-master" && tier !== "parent-registrar" && tier !== "post-author") {
    throw new Error(`moderation patch has an invalid authorTier: ${String(tier)}`);
  }
  const action = p.action;
  if (action !== "replace-text" && action !== "replace-media" && action !== "remove") {
    throw new Error(`moderation patch has an invalid action: ${String(action)}`);
  }
  const target = p.target as Record<string, unknown> | undefined;
  if (!target || typeof target.domain !== "string") {
    throw new Error("moderation patch has no target domain");
  }
  const kind = target.kind;
  if (kind !== "domain" && kind !== "subdomain" && kind !== "post") {
    throw new Error(`moderation patch has an invalid target kind: ${String(kind)}`);
  }
  return createModerationPatch({
    id: typeof p.id === "string" ? p.id : undefined,
    target: {
      kind,
      domain: target.domain,
      postId: typeof target.postId === "string" ? target.postId : undefined,
      blockId: typeof target.blockId === "string" ? target.blockId : undefined,
    },
    action,
    replacementText: typeof p.replacementText === "string" ? p.replacementText : undefined,
    replacementMedia: typeof p.replacementMedia === "string" ? p.replacementMedia : undefined,
    reason: typeof p.reason === "string" ? p.reason : "",
    author: typeof p.author === "string" ? p.author : "",
    authorTier: tier,
    createdAt: typeof p.createdAt === "number" ? p.createdAt : undefined,
  });
}

/** Parse `moderation.json.zst` (decompressed JSON): the Root Master
 *  file. `{ version, patches: [...] }`. */
export function parseModerationFile(raw: unknown): ModerationFile {
  if (typeof raw !== "object" || raw === null) throw new Error("moderation file is not an object");
  const f = raw as Record<string, unknown>;
  if (!Array.isArray(f.patches)) throw new Error("moderation file has no patches array");
  return {
    version: typeof f.version === "string" ? f.version : "0.1.0",
    updated: typeof f.updated === "number" ? f.updated : undefined,
    patches: f.patches.map((p) => parseModerationPatch(p)),
  };
}

/** Parse `sub_moderation.json.zst` (decompressed JSON): a registrar's
 *  file in their own site repo. A sub-moderation file may never carry
 *  a root-master patch — a registrar cannot promote themselves; any
 *  such patch throws instead of being silently downgraded. */
export function parseSubModerationFile(raw: unknown): SubModerationFile {
  if (typeof raw !== "object" || raw === null) throw new Error("sub-moderation file is not an object");
  const f = raw as Record<string, unknown>;
  if (typeof f.domain !== "string" || !validateDomain(f.domain).valid) {
    throw new Error(`sub-moderation file has an invalid domain: ${String(f.domain)}`);
  }
  if (!Array.isArray(f.patches)) throw new Error("sub-moderation file has no patches array");
  const patches = f.patches.map((p) => parseModerationPatch(p));
  for (const patch of patches) {
    if (patch.authorTier === "root-master") {
      throw new Error(
        `sub-moderation file for ${f.domain} carries a root-master patch (${patch.id}) — registrars cannot issue root-master patches`,
      );
    }
  }
  return {
    version: typeof f.version === "string" ? f.version : "0.1.0",
    domain: (f.domain as string).toLowerCase(),
    owner: typeof f.owner === "string" ? f.owner : "",
    updated: typeof f.updated === "number" ? f.updated : undefined,
    patches,
  };
}

// ---------------------------------------------------------------------------
// Resolution order: Root Master → Parent Registrar → Post Author
// ---------------------------------------------------------------------------

/** The field a patch controls, for conflict detection: text, media,
 *  or the whole target (remove). A "remove" patch conflicts with
 *  everything on the same target. */
function patchField(patch: ModerationPatch): "text" | "media" | "whole" {
  if (patch.action === "remove") return "whole";
  return patch.action === "replace-text" ? "text" : "media";
}

/** Scope key: which content a patch touches. Two patches conflict
 *  only when they share a scope key AND a field (a whole-target
 *  removal conflicts with every field on that target). */
function patchScopeKey(patch: ModerationPatch): string {
  const post = patch.target.postId ?? "";
  return `${patch.target.domain}|${post}`;
}

export interface ResolvedPatches {
  /** Patches that take effect, highest tier first. */
  effective: ModerationPatch[];
  /** Patches beaten by a higher-tier patch on the same content. */
  superseded: { patch: ModerationPatch; supersededBy: ModerationPatch }[];
}

/** Resolve a mixed pile of patches (root + registrar + author) into
 *  the ones that actually apply. Sort is tier first, then oldest
 *  first within a tier (an older master patch is not re-litigated by
 *  a newer registrar patch). A lower-tier patch on content a
 *  higher-tier patch already covers is superseded, never applied. */
export function resolveEffectivePatches(patches: ModerationPatch[]): ResolvedPatches {
  const sorted = [...patches].sort((a, b) => {
    const tier = TIER_RANK[b.authorTier] - TIER_RANK[a.authorTier];
    if (tier !== 0) return tier;
    return a.createdAt - b.createdAt;
  });
  const effective: ModerationPatch[] = [];
  const superseded: { patch: ModerationPatch; supersededBy: ModerationPatch }[] = [];
  // Claimed (scope, field) pairs. "whole" claims every field.
  const claimed = new Map<string, ModerationPatch>();
  for (const patch of sorted) {
    const scope = patchScopeKey(patch);
    const field = patchField(patch);
    const wholeKey = `${scope}|whole`;
    const fieldKey = `${scope}|${field}`;
    const blocker = claimed.get(wholeKey) ?? claimed.get(fieldKey);
    if (blocker) {
      superseded.push({ patch, supersededBy: blocker });
      continue;
    }
    effective.push(patch);
    claimed.set(fieldKey, patch);
    if (field === "whole") claimed.set(wholeKey, patch);
  }
  return { effective, superseded };
}

// ---------------------------------------------------------------------------
// Applying patches at render time (pure — never mutates the original)
// ---------------------------------------------------------------------------

export interface ModerationChange {
  patchId: string;
  tier: ModerationTier;
  action: PatchAction;
  targetDomain: string;
  postId?: string;
  /** "applied" | "superseded" | "not-applied" (nothing matched). */
  status: "applied" | "superseded" | "not-applied";
  /** Plain-English description of what changed, for the reader notice. */
  detail: string;
  /** Present when status is not "applied". */
  reason?: string;
}

export interface ModeratedDocument {
  /** The document to render. A deep copy — the input is untouched. */
  document: SiteDocument;
  /** True when a domain/subdomain removal patch applied. */
  removed: boolean;
  changes: ModerationChange[];
}

function cloneDocument(site: SiteDocument): SiteDocument {
  return JSON.parse(JSON.stringify(site)) as SiteDocument;
}

function isTextBlock(block: BlockNode): boolean {
  return ["h1", "h2", "h3", "p", "quote", "link", "hero"].includes(block.type);
}

function isMediaBlock(block: BlockNode): boolean {
  return ["img", "video", "audio"].includes(block.type);
}

function collectBlocks(site: SiteDocument): BlockNode[] {
  return [...(site.header ?? []), ...site.blocks, ...(site.footer ?? [])];
}

/** Apply patches to a site document at render time. Pure function:
 *  the input document is never mutated (it is deep-cloned first).
 *  Returns the redacted document plus a list of what changed, so the
 *  reader can be told — e.g. "[This text was removed by moderation]".
 *  A whole-domain removal returns an empty placeholder document and
 *  removed: true. */
export function applyModerationPatches(
  site: SiteDocument,
  patches: ModerationPatch[],
): ModeratedDocument {
  const { effective, superseded } = resolveEffectivePatches(patches);
  const changes: ModerationChange[] = superseded.map(({ patch, supersededBy }) => ({
    patchId: patch.id,
    tier: patch.authorTier,
    action: patch.action,
    targetDomain: patch.target.domain,
    postId: patch.target.postId,
    status: "superseded" as const,
    detail: `${TIER_LABELS[patch.authorTier]} patch ${patch.id} was superseded by ${TIER_LABELS[supersededBy.authorTier]} patch ${supersededBy.id}.`,
    reason: `A higher-tier patch already covers this content.`,
  }));

  const doc = cloneDocument(site);

  // Whole-domain / whole-subdomain removal wins over everything else
  // on this site. Only a patch whose target domain matches this site
  // (or is its parent — a registrar removing a subdomain they own is
  // expressed with the subdomain as the target domain) applies here.
  const domainRemoval = effective.find(
    (p) =>
      p.action === "remove" &&
      p.target.kind !== "post" &&
      !p.target.postId &&
      (p.target.domain === doc.domain || doc.domain.endsWith(`.${p.target.domain}`)),
  );
  if (domainRemoval) {
    const removedDoc: SiteDocument = {
      ...doc,
      title: "[This site was removed by moderation]",
      header: [],
      blocks: [],
      footer: [],
      nav: [],
    };
    changes.push({
      patchId: domainRemoval.id,
      tier: domainRemoval.authorTier,
      action: "remove",
      targetDomain: domainRemoval.target.domain,
      status: "applied",
      detail: `This site was removed by ${TIER_LABELS[domainRemoval.authorTier]} moderation: ${domainRemoval.reason}`,
    });
    // Every other effective patch is moot once the site is gone.
    for (const p of effective) {
      if (p.id === domainRemoval.id) continue;
      changes.push({
        patchId: p.id,
        tier: p.authorTier,
        action: p.action,
        targetDomain: p.target.domain,
        postId: p.target.postId,
        status: "not-applied",
        detail: `Patch ${p.id} did not apply — the site was removed.`,
        reason: "The site was removed by a higher-priority removal patch.",
      });
    }
    return { document: removedDoc, removed: true, changes };
  }

  const appliesToSite = (p: ModerationPatch): boolean =>
    p.target.domain === doc.domain || doc.domain.endsWith(`.${p.target.domain}`);

  for (const patch of effective) {
    if (!appliesToSite(patch)) {
      changes.push({
        patchId: patch.id,
        tier: patch.authorTier,
        action: patch.action,
        targetDomain: patch.target.domain,
        postId: patch.target.postId,
        status: "not-applied",
        detail: `Patch ${patch.id} targets ${patch.target.domain}, not this site (${doc.domain}).`,
        reason: "The patch targets a different domain.",
      });
      continue;
    }
    const postId = patch.target.postId;
    const inScope = (block: BlockNode): boolean =>
      !postId || block.id === postId;
    const scoped = collectBlocks(doc).filter(inScope);

    if (patch.action === "remove") {
      // Post removal: drop the matching block(s) from header, body
      // and footer. A "remove" with no postId on a post target, or
      // with no matching block, applies to nothing.
      if (!postId) {
        changes.push({
          patchId: patch.id,
          tier: patch.authorTier,
          action: "remove",
          targetDomain: patch.target.domain,
          status: "not-applied",
          detail: `Removal patch ${patch.id} names no post, so nothing was removed.`,
          reason: "A post removal must name the post to remove.",
        });
        continue;
      }
      const before = collectBlocks(doc).length;
      const drop = (blocks: BlockNode[] | undefined): BlockNode[] =>
        (blocks ?? []).filter((b) => b.id !== postId);
      doc.header = drop(doc.header);
      doc.blocks = drop(doc.blocks);
      doc.footer = drop(doc.footer);
      const removedCount = before - collectBlocks(doc).length;
      if (removedCount === 0) {
        changes.push({
          patchId: patch.id,
          tier: patch.authorTier,
          action: "remove",
          targetDomain: patch.target.domain,
          postId,
          status: "not-applied",
          detail: `Removal patch ${patch.id} matched no post — nothing was removed.`,
          reason: `No post with id "${postId}" exists on this site.`,
        });
      } else {
        changes.push({
          patchId: patch.id,
          tier: patch.authorTier,
          action: "remove",
          targetDomain: patch.target.domain,
          postId,
          status: "applied",
          detail: `A post was removed by ${TIER_LABELS[patch.authorTier]} moderation: ${patch.reason}`,
        });
      }
      continue;
    }

    if (patch.action === "replace-text") {
      const targets = scoped.filter(isTextBlock);
      if (targets.length === 0) {
        changes.push({
          patchId: patch.id,
          tier: patch.authorTier,
          action: "replace-text",
          targetDomain: patch.target.domain,
          postId,
          status: "not-applied",
          detail: `Text patch ${patch.id} matched no text on this site.`,
          reason: postId ? `No text block with id "${postId}" exists here.` : "This site has no text blocks to replace.",
        });
        continue;
      }
      for (const block of targets) {
        block.text = patch.replacementText ?? "";
        // Inline runs would re-introduce the removed wording.
        delete block.runs;
        if (block.type === "hero") block.title = patch.replacementText ?? "";
      }
      changes.push({
        patchId: patch.id,
        tier: patch.authorTier,
        action: "replace-text",
        targetDomain: patch.target.domain,
        postId,
        status: "applied",
        detail:
          `Text was replaced by ${TIER_LABELS[patch.authorTier]} moderation: ${patch.reason} ` +
          `(replacement: "${patch.replacementText ?? ""}")`,
      });
      continue;
    }

    // replace-media
    const targets = scoped.filter(isMediaBlock);
    if (targets.length === 0) {
      changes.push({
        patchId: patch.id,
        tier: patch.authorTier,
        action: "replace-media",
        targetDomain: patch.target.domain,
        postId,
        status: "not-applied",
        detail: `Media patch ${patch.id} matched no image, video or audio on this site.`,
        reason: postId ? `No media block with id "${postId}" exists here.` : "This site has no media blocks to replace.",
      });
      continue;
    }
    for (const block of targets) {
      block.src = patch.replacementMedia ?? "";
      if (block.type === "video") block.poster = undefined;
    }
    changes.push({
      patchId: patch.id,
      tier: patch.authorTier,
      action: "replace-media",
      targetDomain: patch.target.domain,
      postId,
      status: "applied",
      detail: `Media was replaced by ${TIER_LABELS[patch.authorTier]} moderation: ${patch.reason}`,
    });
  }

  return { document: doc, removed: false, changes };
}

// ---------------------------------------------------------------------------
// Master Admin Panel view-model (core data — the UI copy lives in
// moderation-ui.ts; the coordinator wires the DOM later)
// ---------------------------------------------------------------------------

export interface AdminPanelDomainRow {
  domain: string;
  owner: string;
  backend: string;
  patchCount: number;
}

export interface MasterAdminPanelData {
  visible: true;
  isMaster: true;
  heading: string;
  domains: AdminPanelDomainRow[];
  patches: ModerationPatch[];
  totalPatches: number;
}

/** The Master Admin Panel's data — or null when the active account
 *  is not the Root Master. The panel is hidden ENTIRELY for anyone
 *  else (no empty shell, no disabled buttons): callers must treat
 *  null as "render nothing". */
export function masterAdminPanelData(
  activeGithubLogin: string | null | undefined,
  entries: RegistryEntry[],
  patches: ModerationPatch[],
): MasterAdminPanelData | null {
  if (!isRootMaster(activeGithubLogin)) return null;
  const domains: AdminPanelDomainRow[] = entries.map((e) => ({
    domain: e.domain,
    owner: e.owner,
    backend: e.backend,
    patchCount: patches.filter((p) => p.target.domain === e.domain).length,
  }));
  return {
    visible: true,
    isMaster: true,
    heading: "Master Admin Panel",
    domains,
    patches: [...patches].sort((a, b) => b.createdAt - a.createdAt),
    totalPatches: patches.length,
  };
}
