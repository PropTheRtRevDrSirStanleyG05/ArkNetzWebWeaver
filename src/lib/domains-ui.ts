// ArkNetzWebWeaver — domain claim flow view-models (Phase 4a).
// Pure functions returning view data + plain-English copy. NO DOM
// edits here — the coordinator wires these view-models into the shell
// UI later. All copy is written for a non-technical site owner:
// what happened, what it means, what to do next.

import type { AvailabilityResult, DomainClaim } from "./domains.js";
import {
  REJECTION_REASONS,
  claimStatusFor,
  validateDomain,
  type ClaimStatus,
  type RejectionReasonCode,
  type ShardEntries,
} from "./domains.js";

export const CLAIM_COPY = {
  heading: "Claim a domain",
  intro:
    "Pick any exact domain name — for example computers.edu or alex.zine. " +
    "Domains are free, and there is no waiting period and no limit on how many you can claim. " +
    "Whole top-level domains (like edu on its own) are never claimed, so no one can monopolise one.",
  termsLabel:
    "I agree to the ArkNetzWebWeaver Terms, the GitHub Terms of Service, and the Internet Archive Terms of Use.",
  submitLabel: "Claim this domain",
  submittingLabel: "Filing your claim…",
  signedOutMessage: "Sign in with GitHub to claim a domain. Reading stays free without an account.",
  registeredHeading: "This domain is yours",
  pendingHeading: "Your claim is being processed",
  rejectedHeading: "This claim was refused",
  /** Shown the moment a claim is filed and the site opens: the
   *  editor is already on the new domain, and the registry entry is
   *  still pending until the register bot closes the issue. */
  siteOpenedHeading: "Your site is open — start building",
  siteOpenedPendingNote:
    "Your claim is filed and waiting for the register bot — usually 5 to 10 seconds. " +
    "Your site is already open in the editor, so start building now; the domain shows as registered once the bot closes the issue.",
} as const;

/** View-model for the moment a claim lands and the editor opens on
 *  the claimed domain. Says plainly that the claim is pending (the
 *  bot has not processed it yet) while the site is already editable. */
export interface SiteOpenedViewModel {
  heading: string;
  message: string;
  domain: string;
  repo: string;
  repoUrl: string;
  issueUrl: string;
  pendingNote: string;
  /** True when the site repo already existed (a retry, or a repo the
   *  user already had) and was reused. */
  reusedRepo: boolean;
  /** True when the repo already had a site and that site was kept. */
  keptExistingSite: boolean;
}

export function buildSiteOpenedViewModel(opened: {
  domain: string;
  repo: string;
  repoUrl: string;
  issueUrl: string;
  alreadyExistedRepo: boolean;
  alreadySeeded: boolean;
}): SiteOpenedViewModel {
  const kept = opened.alreadySeeded;
  return {
    heading: CLAIM_COPY.siteOpenedHeading,
    message: kept
      ? `"${opened.domain}" is claimed and your existing site in ${opened.repo} is open in the editor — nothing was overwritten.`
      : `"${opened.domain}" is claimed and a starter site is open in the editor. Replace the hero with your own title and start writing.`,
    domain: opened.domain,
    repo: opened.repo,
    repoUrl: opened.repoUrl,
    issueUrl: opened.issueUrl,
    pendingNote: CLAIM_COPY.siteOpenedPendingNote,
    reusedRepo: opened.alreadyExistedRepo,
    keptExistingSite: kept,
  };
}

export interface ClaimStep {
  step: number;
  title: string;
  description: string;
}

/** The four steps a user sees, in order. */
export function claimSteps(): ClaimStep[] {
  return [
    {
      step: 1,
      title: "Pick a domain",
      description: "Type the exact domain you want, for example computers.edu.",
    },
    {
      step: 2,
      title: "Accept the Terms",
      description:
        "One tick box: the ArkNetzWebWeaver Terms, GitHub's Terms and the Internet Archive's Terms.",
    },
    {
      step: 3,
      title: "We file your claim",
      description:
        "The app opens a REGISTER issue for you. The free register bot checks the name and writes it into the registry — usually in 5 to 10 seconds.",
    },
    {
      step: 4,
      title: "Start building",
      description:
        "Your site opens in the editor right away, on the domain you just claimed — while the register bot files the domain in the background (usually 5 to 10 seconds).",
    },
  ];
}

export interface DomainClaimViewModel {
  /** What the user typed. */
  input: string;
  /** Normalised domain (lowercase, trimmed), or "" when blank. */
  normalizedDomain: string;
  valid: boolean;
  /** Plain-English problem, when invalid. */
  error?: string;
  status: ClaimStatus;
  heading: string;
  /** Plain-English message for the current state. */
  message: string;
  /** Label for the primary button, or "" when there is no next action. */
  nextActionLabel: string;
  /** May the claim be submitted right now? */
  canSubmit: boolean;
  /** Is the user signed in? (Claiming needs GitHub sign-in.) */
  signedIn: boolean;
  termsAccepted: boolean;
  steps: ClaimStep[];
  /** The REGISTER issue title the app will file, when submittable. */
  issueTitle?: string;
}

/** Plain-English availability message for an availability result. */
export function availabilityMessage(availability: AvailabilityResult): string {
  if (availability.available) {
    return `"${availability.domain}" is available — no one has claimed it yet.`;
  }
  return availability.reason ?? `"${availability.domain}" is not available.`;
}

/** Plain-English message for a rejection code, with optional detail. */
export function rejectionMessage(code: RejectionReasonCode, detail?: string): string {
  const base = REJECTION_REASONS[code];
  return detail ? `${base} ${detail}` : base;
}

/** Build the claim screen's view-model from the typed input, the
 *  shard facts and the claim (if any) for this domain. */
export function buildClaimViewModel(
  input: string,
  opts: {
    signedIn: boolean;
    termsAccepted: boolean;
    shard?: ShardEntries;
    pendingClaims?: DomainClaim[];
    claim?: DomainClaim;
    availability?: AvailabilityResult;
  },
): DomainClaimViewModel {
  const validation = validateDomain(input);
  const normalizedDomain = validation.domain;
  const status: ClaimStatus = opts.claim
    ? opts.claim.status
    : opts.shard
      ? claimStatusFor(input, opts.shard, opts.pendingClaims ?? [])
      : "unclaimed";
  const steps = claimSteps();

  if (!opts.signedIn) {
    return {
      input,
      normalizedDomain,
      valid: validation.valid,
      error: validation.valid ? undefined : validation.reason,
      status,
      heading: CLAIM_COPY.heading,
      message: CLAIM_COPY.signedOutMessage,
      nextActionLabel: "Sign in with GitHub",
      canSubmit: false,
      signedIn: false,
      termsAccepted: opts.termsAccepted,
      steps,
    };
  }
  if (!validation.valid) {
    return {
      input,
      normalizedDomain,
      valid: false,
      error: validation.reason,
      status: "unclaimed",
      heading: CLAIM_COPY.heading,
      message: validation.reason ?? "That domain cannot be claimed.",
      nextActionLabel: "",
      canSubmit: false,
      signedIn: true,
      termsAccepted: opts.termsAccepted,
      steps,
    };
  }
  if (opts.availability && !opts.availability.available) {
    return {
      input,
      normalizedDomain,
      valid: true,
      status: "registered",
      heading: CLAIM_COPY.registeredHeading,
      message: opts.availability.reason ?? `"${normalizedDomain}" is already registered.`,
      nextActionLabel: "Try a different domain",
      canSubmit: false,
      signedIn: true,
      termsAccepted: opts.termsAccepted,
      steps,
    };
  }
  if (status === "pending" || opts.claim?.status === "pending") {
    return {
      input,
      normalizedDomain,
      valid: true,
      status: "pending",
      heading: CLAIM_COPY.pendingHeading,
      message:
        `Your claim for "${normalizedDomain}" is being processed. The register bot usually ` +
        `finishes in 5 to 10 seconds — this screen updates when the issue closes.`,
      nextActionLabel: "",
      canSubmit: false,
      signedIn: true,
      termsAccepted: opts.termsAccepted,
      steps,
    };
  }
  if (status === "rejected" || opts.claim?.status === "rejected") {
    const claim = opts.claim;
    return {
      input,
      normalizedDomain,
      valid: true,
      status: "rejected",
      heading: CLAIM_COPY.rejectedHeading,
      message: claim?.reason ?? "This claim was refused.",
      nextActionLabel: "Try a different domain",
      canSubmit: false,
      signedIn: true,
      termsAccepted: opts.termsAccepted,
      steps,
    };
  }
  if (status === "registered") {
    return {
      input,
      normalizedDomain,
      valid: true,
      status: "registered",
      heading: CLAIM_COPY.registeredHeading,
      message: `"${normalizedDomain}" is registered. Open the builder to start building your site.`,
      nextActionLabel: "Open the builder",
      canSubmit: false,
      signedIn: true,
      termsAccepted: opts.termsAccepted,
      steps,
    };
  }
  if (!opts.termsAccepted) {
    return {
      input,
      normalizedDomain,
      valid: true,
      status: "unclaimed",
      heading: CLAIM_COPY.heading,
      message: `"${normalizedDomain}" is available. Accept the Terms below, then claim it — it takes a few seconds.`,
      nextActionLabel: CLAIM_COPY.submitLabel,
      canSubmit: false,
      signedIn: true,
      termsAccepted: false,
      steps,
      issueTitle: `REGISTER: ${normalizedDomain}`,
    };
  }
  return {
    input,
    normalizedDomain,
    valid: true,
    status: "unclaimed",
    heading: CLAIM_COPY.heading,
    message: `"${normalizedDomain}" is available. Claim it now — the register bot usually finishes in 5 to 10 seconds.`,
    nextActionLabel: CLAIM_COPY.submitLabel,
    canSubmit: true,
    signedIn: true,
    termsAccepted: true,
    steps,
    issueTitle: `REGISTER: ${normalizedDomain}`,
  };
}

/** View-model for the sub-delegation screen: what the owner sees
 *  when they point `ai.computers.edu` at someone else's site repo. */
export interface DelegationViewModel {
  parentDomain: string;
  subdomain: string;
  target: string;
  valid: boolean;
  error?: string;
  heading: string;
  message: string;
  canSave: boolean;
}

export function buildDelegationViewModel(
  parentDomain: string,
  subdomainInput: string,
  targetInput: string,
): DelegationViewModel {
  const sub = validateDomain(subdomainInput);
  const parent = parentDomain.trim().toLowerCase();
  const target = targetInput.trim();
  if (!sub.valid) {
    return {
      parentDomain: parent,
      subdomain: sub.domain,
      target,
      valid: false,
      error: sub.reason,
      heading: "Delegate a subdomain",
      message: sub.reason ?? "That subdomain cannot be delegated.",
      canSave: false,
    };
  }
  if (sub.domain === parent || !sub.domain.endsWith(`.${parent}`)) {
    return {
      parentDomain: parent,
      subdomain: sub.domain,
      target,
      valid: false,
      error: `"${sub.domain}" is not a subdomain of "${parent}".`,
      heading: "Delegate a subdomain",
      message: `Only subdomains of "${parent}" can be delegated from here — for example ai.${parent}.`,
      canSave: false,
    };
  }
  if (!/^(gh|gl|cb):[^/\s]+\/[^/\s]+$/.test(target)) {
    return {
      parentDomain: parent,
      subdomain: sub.domain,
      target,
      valid: false,
      error: `"${target}" is not a site address like gh:sarah/ai-blog.`,
      heading: "Delegate a subdomain",
      message: "Point the subdomain at a site repo, for example gh:sarah/ai-blog.",
      canSave: false,
    };
  }
  return {
    parentDomain: parent,
    subdomain: sub.domain,
    target,
    valid: true,
    heading: "Delegate a subdomain",
    message: `"${sub.domain}" will show the site at ${target}. You can change or remove this later.`,
    canSave: true,
  };
}
