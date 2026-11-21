// ArkNetzWebWeaver — Terms of Service module (thread turn 33).
// Pass-through ToS: ArkNetzWebWeaver adds no separate legal regime of its
// own. Users must comply with the GitHub Terms of Service / Acceptable Use
// and the Internet Archive Terms of Use, keep their own copyright, and bear
// sole legal responsibility for what they publish. Registrars and the Root
// Master hold takedown authority.
//
// This module carries SHORT PLAIN-ENGLISH SUMMARIES plus links to the real
// documents — never invented legal text. The summaries are not the terms;
// the links are.
//
// Behaviour (turn 33):
// - Guests see a passive Acceptable Use notice (footer / about modal).
// - First-time creators get a one-click acceptance checkbox before their
//   first domain claim or publish, with a timestamped acceptance flag.
// - Acceptance is required before a first publish / claim can proceed:
//   gateFirstAction() returns the exact missing-acceptance reason.
//
// Licence: MIT. No new dependencies.

export const TOS_VERSION = "1.0.0";
export const GITHUB_TOS_URL =
  "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service";
export const GITHUB_ACCEPTABLE_USE_URL =
  "https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies";
export const IA_TERMS_URL = "https://archive.org/about/terms.php";

export interface TosSummary {
  title: string;
  /** Short plain-English summary — not legal text. */
  summary: string[];
  url: string;
}

export const GITHUB_TOS_SUMMARY: TosSummary = {
  title: "GitHub Terms of Service",
  summary: [
    "Your sites, posts and mail live in GitHub repos, so GitHub's rules apply to them.",
    "No malware, phishing, crypto-mining, or automated scraping; do not use Git repos as a raw binary CDN.",
    "You keep copyright in what you publish and you are solely responsible for it.",
    "GitHub can remove content that breaks its terms; the Root Master and registrars can also take down content on this network.",
  ],
  url: GITHUB_TOS_URL,
};

export const IA_TERMS_SUMMARY: TosSummary = {
  title: "Internet Archive Terms of Use",
  summary: [
    "All media (images, audio, video) lives on the Internet Archive, so its terms apply to every upload.",
    "Only upload media you own the copyright to or have permission to share — no illegal content, no spam, no abusive upload floods.",
    "Access is provided for scholarship and research purposes; uploads are preservation, not a private cloud drive.",
    "The Archive may remove items that break its terms.",
  ],
  url: IA_TERMS_URL,
};

export const TOS_SUMMARIES: TosSummary[] = [GITHUB_TOS_SUMMARY, IA_TERMS_SUMMARY];

/** Passive Acceptable Use notice for guests (footer / about modal). */
export function guestAcceptableUseNotice(): string {
  return (
    "ArkNetzWebWeaver is a free, open web. Be kind: no illegal content, no spam, " +
    "no malware or phishing, and only share media you have the right to share. " +
    "Sites here follow the GitHub Terms of Service and the Internet Archive Terms of Use. " +
    `GitHub terms: ${GITHUB_TOS_URL} — Internet Archive terms: ${IA_TERMS_URL}`
  );
}

/** The one-click checkbox label shown to first-time creators. */
export function creatorAcceptanceLabel(): string {
  return "I agree to the ArkNetzWebWeaver Terms, GitHub ToS, and Internet Archive Terms";
}

/** Full copy block for the acceptance dialog: label + summaries + links. */
export function creatorAcceptanceCopy(): {
  label: string;
  note: string;
  summaries: TosSummary[];
} {
  return {
    label: creatorAcceptanceLabel(),
    note: "One click, once per account. Your acceptance is stored with the date and time, on your own device, so the app knows you have agreed before your first domain claim or publish.",
    summaries: TOS_SUMMARIES,
  };
}

// ---------------------------------------------------------------------------
// Timestamped acceptance flag, stored per account
// ---------------------------------------------------------------------------

export type TosAction = "first-sign-in" | "domain-claim" | "publish";

export const TOS_ACTION_LABEL: Record<TosAction, string> = {
  "first-sign-in": "first sign-in",
  "domain-claim": "first domain claim",
  publish: "first publish",
};

export interface TosAcceptance {
  accountId: string;
  action: TosAction;
  /** ISO 8601 timestamp of acceptance, e.g. "2026-11-20T15:00:00.000Z". */
  acceptedAt: string;
  tosVersion: string;
}

export interface TosStore {
  getAcceptance(accountId: string): Promise<TosAcceptance | null>;
  setAcceptance(acceptance: TosAcceptance): Promise<void>;
}

export function createMemoryTosStore(): TosStore & {
  peek(accountId: string): TosAcceptance | null;
} {
  const map = new Map<string, TosAcceptance>();
  return {
    async getAcceptance(accountId) {
      return map.get(accountId) ?? null;
    },
    async setAcceptance(acceptance) {
      map.set(acceptance.accountId, acceptance);
    },
    peek(accountId) {
      return map.get(accountId) ?? null;
    },
  };
}

/** Record a creator's one-click acceptance, timestamped, per account. */
export async function recordAcceptance(
  store: TosStore,
  accountId: string,
  action: TosAction,
  now: Date = new Date(),
): Promise<TosAcceptance> {
  if (!accountId) throw new Error("an account id is required to record ToS acceptance");
  const acceptance: TosAcceptance = {
    accountId,
    action,
    acceptedAt: now.toISOString(),
    tosVersion: TOS_VERSION,
  };
  await store.setAcceptance(acceptance);
  return acceptance;
}

export async function hasAccepted(
  store: TosStore,
  accountId: string,
): Promise<TosAcceptance | null> {
  return store.getAcceptance(accountId);
}

/**
 * Human-readable form of a stored acceptance timestamp (P2 fix).
 * The raw ISO value stays in storage untouched (acceptedAt is the
 * record); only the display is localised, e.g. "Nov 21, 2026, 3:13 AM"
 * instead of "2026-11-21T03:13:38.872Z". An unparseable value is
 * returned as-is rather than throwing.
 */
export function formatAcceptanceDate(acceptedAt: string): string {
  const d = new Date(acceptedAt);
  if (Number.isNaN(d.getTime())) return acceptedAt;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** The status line shown after acceptance: human date, same wording. */
export function tosAcceptanceStatusLine(acceptance: TosAcceptance): string {
  return `Accepted ${formatAcceptanceDate(acceptance.acceptedAt)} — recorded on this device.`;
}

export type TosGateResult =
  | { allowed: true; acceptance: TosAcceptance }
  | {
      allowed: false;
      reason: "tos_acceptance_missing";
      message: string;
      action: TosAction;
    };

/**
 * Gate: a first publish / domain claim / sign-in may proceed only after
 * the account has accepted the terms. Returns the exact missing-acceptance
 * reason when it has not — the caller shows the checkbox, never a
 * generic "permission denied".
 */
export async function gateFirstAction(
  store: TosStore,
  accountId: string,
  action: TosAction,
): Promise<TosGateResult> {
  const acceptance = await store.getAcceptance(accountId);
  if (acceptance) return { allowed: true, acceptance };
  return {
    allowed: false,
    reason: "tos_acceptance_missing",
    action,
    message:
      `ToS acceptance required before your ${TOS_ACTION_LABEL[action]}: ` +
      `tick "${creatorAcceptanceLabel()}" first. ` +
      `Your acceptance is stored with the date and time, on your own device.`,
  };
}
