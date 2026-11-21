// Tests: the Account Switcher Pill (D6 fix, pass 1) — the real
// top-bar control: Guest with zero accounts, a dropdown listing all
// keyring accounts, and switch wiring through the keyring. The
// keyring is mocked (plain data, no crypto); the switch function is
// injected and records its calls. No DOM library: a minimal fake
// element implementing the PillElement surface.
import test from "node:test";
import assert from "node:assert/strict";
import { AccountPill } from "../src/lib/network/account-pill.js";
import type { PillElement, PillKeyring } from "../src/lib/network/account-pill.js";
import { accountSwitcherPillView } from "../src/lib/network/accounts-ui.js";
import type { AccountProfile, AccountProvider, KeyringData } from "../src/lib/network/accounts.js";

class FakeEl implements PillElement {
  textContent = "";
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  onclick: ((e: unknown) => void) | null = null;
  attributes = new Map<string, string>();
  children: FakeEl[] = [];

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: PillElement): void {
    this.children.push(child as FakeEl);
  }

  removeAll(): void {
    this.children = [];
  }

  click(): void {
    this.onclick?.(null);
  }

  buttons(): FakeEl[] {
    return this.children.filter((c) => c.dataset.accountId !== undefined || c.textContent.startsWith("+"));
  }
}

/** Mocked keyring: plain profile list + active map, no crypto. */
function mockKeyring(
  profiles: Array<{ provider: AccountProvider; id: string; label: string; username?: string }>,
  active: Partial<Record<AccountProvider, string>>,
  masterUser = "PropTheRtRevDrSirStanleyG05",
): { keyring: PillKeyring; data: KeyringData } {
  const data: KeyringData = {
    version: 1,
    profiles: profiles.map((p) => ({
      ...p,
      provider: p.provider,
      secretKind: "token" as const,
      encryptedSecret: "",
      createdAt: 1000,
    })),
    active: { ...active },
    bindings: {},
  };
  return {
    data,
    keyring: {
      snapshot: () => data,
      isMasterAdmin: () => {
        const gh = data.profiles.find((p) => p.provider === "github" && p.id === data.active.github);
        return gh?.username === masterUser;
      },
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function setupPill(opts: {
  profiles?: Array<{ provider: AccountProvider; id: string; label: string; username?: string }>;
  active?: Partial<Record<AccountProvider, string>>;
  switchImpl?: (provider: AccountProvider, id: string) => Promise<{ profile: AccountProfile; token: string | null }>;
}): {
  pill: AccountPill;
  pillEl: FakeEl;
  menuEl: FakeEl;
  switches: Array<{ provider: AccountProvider; id: string }>;
  added: string[];
  reported: string[];
  switchedTo: AccountProfile[];
  data: KeyringData;
} {
  const { keyring, data } = mockKeyring(opts.profiles ?? [], opts.active ?? {});
  const pillEl = new FakeEl();
  const menuEl = new FakeEl();
  menuEl.hidden = true;
  const switches: Array<{ provider: AccountProvider; id: string }> = [];
  const added: string[] = [];
  const reported: string[] = [];
  const switchedTo: AccountProfile[] = [];
  const switchAccount =
    opts.switchImpl ??
    (async (provider: AccountProvider, id: string) => {
      switches.push({ provider, id });
      data.active[provider] = id;
      const profile = data.profiles.find((p) => p.provider === provider && p.id === id) as AccountProfile;
      return { profile, token: provider === "github" ? `tok-${id}` : null };
    });
  const pill = new AccountPill(pillEl, menuEl, {
    keyring,
    switchAccount,
    onAddAccount: () => added.push("add"),
    onSwitched: (profile) => switchedTo.push(profile),
    reportStatus: (message) => reported.push(message),
    createElement: () => new FakeEl(),
  });
  pill.render();
  return { pill, pillEl, menuEl, switches, added, reported, switchedTo, data };
}

test("pill view-model: Guest with zero accounts, Master badge for the master", () => {
  const { data } = mockKeyring([], {});
  const view = accountSwitcherPillView(data, false);
  assert.equal(view.pillLabel, "Guest");
  assert.equal(view.signedInCount, 0);
  assert.match(view.emptyNote, /No accounts signed in/);
  assert.equal(view.masterBadgeVisible, false);
});

test("pill: zero accounts shows Guest; the menu shows the empty note and Add Another Account", () => {
  const { pill, pillEl, menuEl, added } = setupPill({});
  assert.equal(pillEl.textContent, "Guest");
  assert.equal(pill.isMenuOpen, false);
  assert.equal(menuEl.hidden, true);
  pillEl.click();
  assert.equal(pill.isMenuOpen, true);
  assert.equal(menuEl.hidden, false);
  assert.match(
    menuEl.children.map((c) => c.textContent).join(" "),
    /No accounts signed in/,
  );
  const add = menuEl.buttons().find((b) => b.textContent.startsWith("+ Add Another Account"));
  assert.ok(add, "Add Another Account is listed");
  add?.click();
  assert.deepEqual(added, ["add"]);
  assert.equal(pill.isMenuOpen, false, "choosing Add closes the menu");
});

test("pill: two GitHub accounts — the dropdown lists both, switching changes the active account and re-renders", async () => {
  const { pill, pillEl, menuEl, switches, switchedTo } = setupPill({
    profiles: [
      { provider: "github", id: "alice", label: "alice", username: "alice" },
      { provider: "github", id: "bob", label: "bob", username: "bob" },
    ],
    active: { github: "alice" },
  });
  assert.equal(pillEl.textContent, "alice");
  pillEl.click();
  const buttons = menuEl.buttons().filter((b) => b.dataset.accountId !== undefined);
  assert.equal(buttons.length, 2);
  const aliceBtn = buttons.find((b) => b.dataset.accountId === "alice");
  const bobBtn = buttons.find((b) => b.dataset.accountId === "bob");
  assert.equal(aliceBtn?.disabled, true, "the active account cannot be re-selected");
  assert.match(aliceBtn?.textContent ?? "", /\(active\)/);
  assert.equal(bobBtn?.disabled, false);
  bobBtn?.click();
  await flush();
  assert.deepEqual(switches, [{ provider: "github", id: "bob" }]);
  assert.deepEqual(switchedTo.map((p) => p.id), ["bob"]);
  assert.equal(pillEl.textContent, "bob", "the pill re-renders with the new active account");
  assert.equal(pill.isMenuOpen, false, "switching closes the menu");
  // The re-rendered menu now marks bob active.
  pillEl.click();
  const after = menuEl.buttons().filter((b) => b.dataset.accountId !== undefined);
  assert.equal(after.find((b) => b.dataset.accountId === "bob")?.disabled, true);
  assert.equal(after.find((b) => b.dataset.accountId === "alice")?.disabled, false);
});

test("pill: a failed switch reports the reason and changes nothing", async () => {
  const attempts: Array<{ provider: AccountProvider; id: string }> = [];
  const { pill, pillEl, menuEl, reported } = setupPill({
    profiles: [
      { provider: "github", id: "alice", label: "alice", username: "alice" },
      { provider: "github", id: "bob", label: "bob", username: "bob" },
    ],
    active: { github: "alice" },
    switchImpl: async (provider, id) => {
      attempts.push({ provider, id });
      throw new Error("keyring is locked — unlock it with your passphrase first");
    },
  });
  assert.equal(pillEl.textContent, "alice");
  pillEl.click();
  const bobBtn = menuEl.buttons().find((b) => b.dataset.accountId === "bob");
  bobBtn?.click();
  await flush();
  assert.deepEqual(attempts, [{ provider: "github", id: "bob" }], "the switch was attempted once");
  assert.equal(reported.length, 1);
  assert.match(reported[0] ?? "", /keyring is locked/);
  assert.equal(pillEl.textContent, "alice", "the pill still shows the old active account");
  assert.equal(pill.isMenuOpen, true, "the menu stays open after a failed switch");
});

test("pill: the master account shows the Root Master badge", () => {
  const { pillEl } = setupPill({
    profiles: [
      { provider: "github", id: "stanbeyond", label: "STANBEYOND (Master)", username: "PropTheRtRevDrSirStanleyG05" },
    ],
    active: { github: "stanbeyond" },
  });
  assert.equal(pillEl.textContent, "PropTheRtRevDrSirStanleyG05 · Root Master");
});

test("pill: switching a non-GitHub account goes through the same switch path", async () => {
  const { pillEl, menuEl, switches } = setupPill({
    profiles: [
      { provider: "github", id: "alice", label: "alice", username: "alice" },
      { provider: "internet_archive", id: "ia-one", label: "IA One" },
      { provider: "internet_archive", id: "ia-two", label: "IA Two" },
    ],
    active: { github: "alice", internet_archive: "ia-one" },
  });
  assert.equal(pillEl.textContent, "alice", "the pill shows the active GitHub account");
  pillEl.click();
  const iaTwo = menuEl.buttons().find((b) => b.dataset.accountId === "ia-two");
  assert.ok(iaTwo, "the IA section lists its accounts");
  iaTwo?.click();
  await flush();
  assert.deepEqual(switches, [{ provider: "internet_archive", id: "ia-two" }]);
  assert.equal(pillEl.textContent, "alice", "switching IA leaves the GitHub pill label alone");
});
