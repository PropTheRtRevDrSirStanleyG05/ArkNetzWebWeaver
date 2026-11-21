// ArkNetzWebWeaver — Account Switcher Pill + Root Registries view models.
// Pure functions returning view data. NO DOM here — the coordinator wires
// these into the shell UI later. All copy is plain English.
//
// Covers (thread turns 40, 45):
// - the top-bar Account Switcher Pill (dropdown organised by backend,
//   avatar/username, one-click Switch, "+ Add Another Account"),
// - the Root Registries settings list (primary default + optional
//   secondary community registries),
// - the per-site binding display (which accounts a site is bound to),
// - the ToS acceptance UI state.
//
// Licence: MIT. No new dependencies.

import type {
  AccountProfile,
  AccountProvider,
  KeyringData,
  SiteBinding,
} from "./accounts.js";
import { ACCOUNT_PROVIDERS, PROVIDER_LABEL } from "./accounts.js";
import {
  creatorAcceptanceCopy,
  formatAcceptanceDate,
  guestAcceptableUseNotice,
  type TosAcceptance,
} from "./tos.js";

export interface SwitcherAccountView {
  id: string;
  label: string;
  username?: string;
  avatar?: string;
  isActive: boolean;
}

export interface SwitcherSectionView {
  provider: AccountProvider;
  providerLabel: string;
  prefix: string;
  accounts: SwitcherAccountView[];
}

export interface AccountSwitcherPillView {
  /** Label on the pill itself, e.g. "STANBEYOND (Master)" or "Guest". */
  pillLabel: string;
  /** True when the active GitHub account is the Root Master. */
  masterBadgeVisible: boolean;
  masterBadgeLabel: string;
  sections: SwitcherSectionView[];
  addAccountLabel: string;
  signedInCount: number;
  /** Shown when nothing is signed in at all. */
  emptyNote: string;
}

const PROVIDER_PREFIX_VIEW: Record<AccountProvider, string> = {
  github: "gh:",
  gitlab: "gl:",
  codeberg: "cb:",
  internet_archive: "ia:",
  huggingface: "hf:",
  wikimedia: "wm:",
};

/**
 * View model for the top-bar Account Switcher Pill from a keyring
 * snapshot. The pill shows the active GitHub account (or "Guest"); the
 * dropdown lists every provider section with its signed-in accounts.
 */
export function accountSwitcherPillView(
  keyring: Pick<KeyringData, "profiles" | "active">,
  isMasterAdmin: boolean,
): AccountSwitcherPillView {
  const activeGithub = keyring.profiles.find(
    (p) => p.provider === "github" && p.id === keyring.active.github,
  );
  const sections: SwitcherSectionView[] = ACCOUNT_PROVIDERS.map((provider) => ({
    provider,
    providerLabel: PROVIDER_LABEL[provider],
    prefix: PROVIDER_PREFIX_VIEW[provider],
    accounts: keyring.profiles
      .filter((p) => p.provider === provider)
      .map((p) => ({
        id: p.id,
        label: p.label,
        username: p.username,
        avatar: p.avatar,
        isActive: keyring.active[provider] === p.id,
      })),
  }));
  return {
    pillLabel: activeGithub
      ? (activeGithub.username ?? activeGithub.label)
      : "Guest",
    masterBadgeVisible: isMasterAdmin,
    masterBadgeLabel: isMasterAdmin ? "Root Master" : "",
    sections,
    addAccountLabel: "+ Add Another Account",
    signedInCount: keyring.profiles.length,
    emptyNote:
      keyring.profiles.length === 0
        ? "No accounts signed in. Browsing works as a guest; sign in to claim a domain, publish, or send mail."
        : "",
  };
}

export interface RootRegistryView {
  repo: string;
  isPrimary: boolean;
  label: string;
}

export interface RootRegistriesView {
  primary: RootRegistryView;
  secondaries: RootRegistryView[];
  addLabel: string;
  note: string;
}

/**
 * View model for the Settings "Root Registries" list (thread turn 40):
 * one primary (the default root, whose sites the client sees first)
 * plus optional secondary community registries, without fragmenting the
 * main web. A fork points its primary at its own registry, or keeps the
 * default and still sees Stanley's sites.
 */
export function rootRegistriesView(
  primaryRepo: string,
  secondaryRepos: string[],
): RootRegistriesView {
  return {
    primary: {
      repo: primaryRepo,
      isPrimary: true,
      label: "Primary registry — sites here are the main web you browse",
    },
    secondaries: secondaryRepos.map((repo) => ({
      repo,
      isPrimary: false,
      label: "Secondary community registry — its sites are listed alongside the primary",
    })),
    addLabel: "+ Add a community registry",
    note: "A fork can point its primary at its own registry and still add this one as a secondary, so its users keep seeing sites made on the main network.",
  };
}

export interface SiteBindingRowView {
  provider: AccountProvider;
  providerLabel: string;
  boundAccountLabel: string | null;
  /** True when the site is bound to an account that is not signed in. */
  missing: boolean;
  hint: string;
}

export interface SiteBindingView {
  domain: string;
  rows: SiteBindingRowView[];
  bound: boolean;
  note: string;
}

/** View model for a site's auto-binding: which account owns it per backend. */
export function siteBindingView(
  domain: string,
  binding: SiteBinding | undefined,
  profiles: AccountProfile[],
): SiteBindingView {
  const rows: SiteBindingRowView[] = ACCOUNT_PROVIDERS.map((provider) => {
    const boundId = binding?.accounts[provider];
    if (!boundId) {
      return {
        provider,
        providerLabel: PROVIDER_LABEL[provider],
        boundAccountLabel: null,
        missing: false,
        hint: "Not bound — the active account will be used.",
      };
    }
    const account = profiles.find(
      (p) => p.provider === provider && p.id === boundId,
    );
    if (!account) {
      return {
        provider,
        providerLabel: PROVIDER_LABEL[provider],
        boundAccountLabel: boundId,
        missing: true,
        hint: `Bound to "${boundId}", which is not signed in. Add that account, or rebind the site.`,
      };
    }
    return {
      provider,
      providerLabel: PROVIDER_LABEL[provider],
      boundAccountLabel: account.label,
      missing: false,
      hint: `Opens with ${account.label} — commits and uploads go to that account.`,
    };
  });
  return {
    domain,
    rows,
    bound: !!binding && Object.keys(binding.accounts).length > 0,
    note: "Each site remembers which accounts own it, so a post never goes to the wrong account.",
  };
}

export interface TosAcceptanceView {
  label: string;
  note: string;
  summaries: ReturnType<typeof creatorAcceptanceCopy>["summaries"];
  accepted: boolean;
  acceptedAt: string | null;
  /** Human-readable form of acceptedAt for display (P2 fix) — the raw
   *  ISO value stays in acceptedAt / storage. Null when not accepted. */
  acceptedAtDisplay: string | null;
  guestNotice: string;
}

/** View model for the ToS acceptance UI (checkbox + summaries). */
export function tosAcceptanceView(
  acceptance: TosAcceptance | null,
): TosAcceptanceView {
  const copy = creatorAcceptanceCopy();
  return {
    label: copy.label,
    note: copy.note,
    summaries: copy.summaries,
    accepted: !!acceptance,
    acceptedAt: acceptance ? acceptance.acceptedAt : null,
    acceptedAtDisplay: acceptance
      ? formatAcceptanceDate(acceptance.acceptedAt)
      : null,
    guestNotice: guestAcceptableUseNotice(),
  };
}
