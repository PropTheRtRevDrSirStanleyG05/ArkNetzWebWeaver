// ArkNetzWebWeaver — team roles in the builder (thread turn 39).
// Client-side UI gating ONLY for v1.0: a role without pages.publish
// cannot Publish, without media.upload cannot attach media, without
// apps.embed cannot add an app block, and allowed_paths restricts which
// pages a role may edit. The matching server-side validation is a
// GitHub Action that checks commits to site.json.zst / team.json.zst —
// that follows with the central repos, and is recorded as a gap until
// it lands. A determined user can bypass client gating; the Action is
// the enforcement that cannot be bypassed.

import type { RoleFlag, TeamRole } from "./types.js";

export const ALL_ROLE_FLAGS: RoleFlag[] = [
  "pages.draft",
  "pages.publish",
  "allowed_paths",
  "apps.embed",
  "media.upload",
  "subdomains.manage",
  "moderation.sub",
  "comments.moderate",
  "mail.read",
  "mail.send",
  "stats.view",
  "team.manage",
];

export const OWNER_ROLE: TeamRole = { name: "owner", flags: [...ALL_ROLE_FLAGS] };

export const EDITOR_ROLE: TeamRole = {
  name: "editor",
  flags: ["pages.draft", "pages.publish", "media.upload", "comments.moderate", "stats.view"],
};

export const WRITER_ROLE: TeamRole = {
  name: "writer",
  flags: ["pages.draft", "media.upload", "allowed_paths"],
  allowedPaths: ["blog/*"],
};

export const VIEWER_ROLE: TeamRole = { name: "viewer", flags: ["stats.view"] };

export const PRESET_ROLES: TeamRole[] = [OWNER_ROLE, EDITOR_ROLE, WRITER_ROLE, VIEWER_ROLE];

export function presetRole(name: string): TeamRole | undefined {
  return PRESET_ROLES.find((r) => r.name === name);
}

export function can(role: TeamRole, flag: RoleFlag): boolean {
  return role.flags.includes(flag);
}

/** Path check for allowed_paths: "blog/*" matches "blog/hello" but not
 *  "about". A role with no allowedPaths (or without the allowed_paths
 *  flag) may edit every path. */
export function canEditPath(role: TeamRole, path: string): boolean {
  if (!role.flags.includes("allowed_paths")) return true;
  const patterns = role.allowedPaths ?? [];
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern.endsWith("/*")) return path.startsWith(pattern.slice(0, -1));
    return path === pattern;
  });
}

export interface GateResult {
  allowed: boolean;
  /** Plain-language reason, shown in the UI when an action is blocked. */
  reason: string;
}

export function gatePublish(role: TeamRole): GateResult {
  if (can(role, "pages.publish")) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason: `Role "${role.name}" cannot publish — it lacks the pages.publish flag. Save a draft instead, or ask an owner to publish.`,
  };
}

export function gateMediaUpload(role: TeamRole): GateResult {
  if (can(role, "media.upload")) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason: `Role "${role.name}" cannot attach media — it lacks the media.upload flag.`,
  };
}

export function gateAppEmbed(role: TeamRole): GateResult {
  if (can(role, "apps.embed")) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason: `Role "${role.name}" cannot embed HTML apps — it lacks the apps.embed flag.`,
  };
}

export function gateEditPath(role: TeamRole, path: string): GateResult {
  if (canEditPath(role, path)) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason: `Role "${role.name}" may only edit ${role.allowedPaths?.join(", ") ?? "its allowed paths"} — not "${path}".`,
  };
}
