// ArkNetzWebWeaver — Master Admin Panel + moderation view-models
// (Phase 4a). Pure functions returning view data + plain-English
// copy. NO DOM edits here — the coordinator wires these view-models
// into the shell UI later.
// The panel is hidden ENTIRELY when the active account is not the
// Root Master: the view-model says visible: false and carries no
// domain or patch rows, so the shell has nothing to render.

import type { ModerationChange, ModerationPatch, ModerationTier } from "./moderation.js";
import {
  TIER_LABELS,
  isRootMaster,
  masterAdminPanelData,
  type AdminPanelDomainRow,
} from "./moderation.js";
import type { RegistryEntry } from "./types.js";

export const ADMIN_COPY = {
  heading: "Master Admin Panel",
  intro:
    "You are signed in as the Root Master. You can redact or remove any domain, subdomain or post " +
    "on this network. Changes apply at render time — readers see the replacement, never the original. " +
    "Your authority here comes from GitHub: only your account can write to the central moderation repo.",
  hiddenMessage:
    "The Master Admin Panel is only visible to the Root Master. Switch to the master account to see it.",
  emptyDomains: "No domains are registered yet.",
  emptyPatches: "No moderation patches have been issued yet.",
  patchHeading: "Issue a moderation patch",
  patchIntro:
    "Pick what to change and why. Readers see your reason where the content was changed. " +
    "A Root Master patch always wins over a registrar's or author's patch on the same content.",
} as const;

export interface AdminPanelViewModel {
  /** False for everyone except the Root Master — render nothing. */
  visible: boolean;
  isMaster: boolean;
  heading: string;
  intro: string;
  /** Empty when hidden — the shell must not render rows it cannot see. */
  domains: AdminPanelDomainRow[];
  patches: AdminPanelPatchRow[];
  totalPatches: number;
  emptyMessage: string;
}

export interface AdminPanelPatchRow {
  id: string;
  summary: string;
  tier: ModerationTier;
  tierLabel: string;
  author: string;
  reason: string;
  createdAt: number;
}

/** One plain-English line describing a patch, for the panel list. */
export function patchSummary(patch: ModerationPatch): string {
  const target =
    patch.target.kind === "post" && patch.target.postId
      ? `post ${patch.target.postId} on ${patch.target.domain}`
      : patch.target.domain;
  switch (patch.action) {
    case "replace-text":
      return `Replace text on ${target} with "${patch.replacementText ?? ""}"`;
    case "replace-media":
      return `Replace media on ${target} with ${patch.replacementMedia ?? ""}`;
    case "remove":
      return patch.target.kind === "post"
        ? `Remove ${target}`
        : `Remove the whole site ${target}`;
  }
}

export function buildAdminPanelViewModel(
  activeGithubLogin: string | null | undefined,
  entries: RegistryEntry[],
  patches: ModerationPatch[],
): AdminPanelViewModel {
  if (!isRootMaster(activeGithubLogin)) {
    return {
      visible: false,
      isMaster: false,
      heading: ADMIN_COPY.heading,
      intro: ADMIN_COPY.hiddenMessage,
      domains: [],
      patches: [],
      totalPatches: 0,
      emptyMessage: ADMIN_COPY.hiddenMessage,
    };
  }
  const data = masterAdminPanelData(activeGithubLogin, entries, patches);
  // masterAdminPanelData returns non-null exactly when isRootMaster.
  const rows: AdminPanelPatchRow[] = (data?.patches ?? []).map((p) => ({
    id: p.id,
    summary: patchSummary(p),
    tier: p.authorTier,
    tierLabel: TIER_LABELS[p.authorTier],
    author: p.author,
    reason: p.reason,
    createdAt: p.createdAt,
  }));
  return {
    visible: true,
    isMaster: true,
    heading: ADMIN_COPY.heading,
    intro: ADMIN_COPY.intro,
    domains: data?.domains ?? [],
    patches: rows,
    totalPatches: data?.totalPatches ?? 0,
    emptyMessage:
      (data?.domains.length ?? 0) === 0 ? ADMIN_COPY.emptyDomains : ADMIN_COPY.emptyPatches,
  };
}

export interface PatchFormViewModel {
  targetDomain: string;
  targetPostId?: string;
  heading: string;
  intro: string;
  actions: { action: ModerationPatch["action"]; label: string; hint: string }[];
  submitLabel: string;
  warning: string;
  canSubmit: boolean;
  /** Shown when the form cannot be used (e.g. not the master). */
  blockedReason?: string;
}

/** View-model for the "issue a patch" form. Only the Root Master
 *  gets a submittable form here; a registrar's sub-moderation form
 *  lives in their own site repo and is a later phase. */
export function buildPatchFormViewModel(
  activeGithubLogin: string | null | undefined,
  targetDomain: string,
  targetPostId?: string,
): PatchFormViewModel {
  const domain = targetDomain.trim().toLowerCase();
  if (!isRootMaster(activeGithubLogin)) {
    return {
      targetDomain: domain,
      targetPostId,
      heading: ADMIN_COPY.patchHeading,
      intro: ADMIN_COPY.hiddenMessage,
      actions: [],
      submitLabel: "",
      warning: "",
      canSubmit: false,
      blockedReason: "Only the Root Master can issue a moderation patch from this panel.",
    };
  }
  return {
    targetDomain: domain,
    targetPostId,
    heading: ADMIN_COPY.patchHeading,
    intro: targetPostId
      ? `Patching post ${targetPostId} on ${domain}. ${ADMIN_COPY.patchIntro}`
      : `Patching ${domain}. ${ADMIN_COPY.patchIntro}`,
    actions: [
      {
        action: "replace-text",
        label: "Replace text",
        hint: "Readers see your replacement text instead of the original.",
      },
      {
        action: "replace-media",
        label: "Replace media",
        hint: "Readers see your replacement image, video or audio instead of the original.",
      },
      {
        action: "remove",
        label: "Remove",
        hint: "Removes the post — or the whole site, when no post is named. This cannot be undone from here; re-issue the content to restore it.",
      },
    ],
    submitLabel: "Issue patch",
    warning:
      "This applies to every reader immediately on their next visit. The original content stays in the site's Git history — a patch changes what is shown, not what was published.",
    canSubmit: true,
  };
}

/** Reader-facing notice lines for a moderated page, from the changes
 *  applyModerationPatches reported. Only applied changes are shown;
 *  superseded / not-applied patches are admin bookkeeping, not reader
 *  news. Returns [] when nothing visible changed. */
export function moderationNoticeForSite(changes: ModerationChange[]): string[] {
  return changes
    .filter((c) => c.status === "applied")
    .map((c) => c.detail);
}
