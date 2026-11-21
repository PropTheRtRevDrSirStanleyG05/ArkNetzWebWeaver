// ArkNetzWebWeaver — Account Switcher Pill controller (D6 fix,
// 2026-11-21). The pill view-model (accountSwitcherPillView in
// accounts-ui.ts) existed, but there was no pill element, no
// dropdown, and no switch wiring — the Accounts panel told users to
// "switch from the pill in the top bar" and the control was not
// there. This controller renders the real pill into the top bar and
// wires it to the keyring's switch logic.
//
// DOM-light by design: the shell passes the pill button, the menu
// container, and a createElement factory, so tests drive it with a
// fake DOM and a mocked keyring. Switching itself is injected
// (`switchAccount`) — the controller never touches tokens or the
// session; the shell owns that (reveal the token, switchAll, update
// the session, re-render panels).

import { accountSwitcherPillView } from "./accounts-ui.js";
import type { AccountKeyring, AccountProfile, AccountProvider } from "./accounts.js";

/** What the pill needs from the keyring: a snapshot for the
 *  view-model plus the master check for the badge. */
export interface PillKeyring {
  snapshot(): ReturnType<AccountKeyring["snapshot"]>;
  isMasterAdmin(): boolean;
}

/** Minimal element surface the controller uses (real DOM or the test
 *  fake). */
export interface PillElement {
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  onclick: ((e: unknown) => void) | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: PillElement): void;
  removeAll?(): void;
}

export interface AccountPillDeps {
  keyring: PillKeyring;
  /** Switch the active account. Must persist the switch and return
   *  the switched profile (plus the session token for GitHub, null
   *  otherwise). Throws on failure — the pill reports it and switches
   *  nothing. */
  switchAccount: (
    provider: AccountProvider,
    id: string,
  ) => Promise<{ profile: AccountProfile; token: string | null }>;
  /** "+ Add Another Account" — the shell starts GitHub sign-in. */
  onAddAccount: () => void;
  /** Called after a successful switch (the shell refreshes the
   *  session status + panels). */
  onSwitched?: (profile: AccountProfile) => void;
  /** Plain-English switch failure, shown in the shell's status strip. */
  reportStatus?: (message: string) => void;
  createElement: (tag: string) => PillElement;
}

/** The top-bar Account Switcher Pill: a button showing the active
 *  account (or "Guest") and a dropdown listing every keyring account
 *  with a switch action. Works with zero accounts (Guest + the empty
 *  note) and with many. */
export class AccountPill {
  private readonly pill: PillElement;
  private readonly menu: PillElement;
  private readonly deps: AccountPillDeps;
  private menuOpen = false;

  constructor(pill: PillElement, menu: PillElement, deps: AccountPillDeps) {
    this.pill = pill;
    this.menu = menu;
    this.deps = deps;
    this.pill.onclick = () => this.toggleMenu();
  }

  get isMenuOpen(): boolean {
    return this.menuOpen;
  }

  /** Re-render the pill label + dropdown from the keyring. Call after
   *  sign-in, sign-out, unlock, and every switch. */
  render(): void {
    const view = accountSwitcherPillView(
      this.deps.keyring.snapshot(),
      this.deps.keyring.isMasterAdmin(),
    );
    this.pill.textContent = view.masterBadgeVisible
      ? `${view.pillLabel} · ${view.masterBadgeLabel}`
      : view.pillLabel;
    this.pill.setAttribute("aria-expanded", String(this.menuOpen));
    this.rebuildMenu(view);
  }

  /** Open/close the dropdown. */
  toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
    this.menu.hidden = !this.menuOpen;
    this.pill.setAttribute("aria-expanded", String(this.menuOpen));
  }

  closeMenu(): void {
    this.menuOpen = false;
    this.menu.hidden = true;
    this.pill.setAttribute("aria-expanded", "false");
  }

  private clearMenu(): void {
    if (typeof this.menu.removeAll === "function") this.menu.removeAll();
    else this.menu.textContent = "";
  }

  private rebuildMenu(
    view: ReturnType<typeof accountSwitcherPillView>,
  ): void {
    this.clearMenu();
    const create = this.deps.createElement;
    if (view.signedInCount === 0) {
      const note = create("p");
      note.textContent = view.emptyNote;
      this.menu.appendChild(note);
    }
    for (const section of view.sections) {
      if (section.accounts.length === 0) continue;
      const heading = create("p");
      heading.textContent = section.providerLabel;
      this.menu.appendChild(heading);
      for (const account of section.accounts) {
        const btn = create("button");
        btn.textContent = account.isActive
          ? `${section.prefix}${account.label} (active)`
          : `${section.prefix}${account.label}`;
        btn.disabled = account.isActive;
        btn.dataset.provider = section.provider;
        btn.dataset.accountId = account.id;
        btn.onclick = () => void this.switchTo(section.provider, account.id);
        this.menu.appendChild(btn);
      }
    }
    const add = create("button");
    add.textContent = view.addAccountLabel;
    add.onclick = () => {
      this.closeMenu();
      this.deps.onAddAccount();
    };
    this.menu.appendChild(add);
  }

  private async switchTo(provider: AccountProvider, id: string): Promise<void> {
    let switched: { profile: AccountProfile; token: string | null };
    try {
      switched = await this.deps.switchAccount(provider, id);
    } catch (err) {
      // A failed switch changes nothing: the active account, the
      // pill label, and the session all stay as they were. The
      // reason (e.g. keyring locked) is reported, never swallowed.
      this.deps.reportStatus?.(
        `Could not switch accounts: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.closeMenu();
    this.render();
    this.deps.onSwitched?.(switched.profile);
  }
}
