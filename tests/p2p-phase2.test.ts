// Tests: P2P phase-2 wiring — the settings panel (render + mount),
// the collab session's P2P hook (poll slowing, op/cursor forwarding,
// team check via the host), the vault's P2P chunk import, the app's
// P2P accessors, and the host's mail fallback to the GitHub inbox
// when P2P is off. No real WebRTC, no real GitHub: loopback pairs,
// FakeGitHub, and mock fetches throughout.
import test from "node:test";
import assert from "node:assert/strict";
import { createArkNetzApp } from "../src/lib/app.js";
import { defaultP2PSettings } from "../src/lib/p2p/types.js";
import { P2P_RELAY_PRIVACY_NOTE } from "../src/lib/p2p/ice.js";
import { mountP2PPanel, renderP2PPanelHtml } from "../src/lib/p2p/panel.js";
import type { P2PPanelDeps } from "../src/lib/p2p/panel.js";
import { P2PHost } from "../src/lib/p2p/host.js";
import { createMemoryP2PStore } from "../src/lib/p2p/store.js";
import { LoopbackConnectionFactory } from "../src/lib/p2p/transport.js";
import { CollabRelay } from "../src/lib/collab/relay.js";
import { COLLAB_P2P_SLOW_POLL_MS, CollabSession } from "../src/lib/collab/session.js";
import type { CollabP2PHook, CollabP2PHookEvents } from "../src/lib/collab/session.js";
import { POLL_MS } from "../src/lib/collab/types.js";
import type { BlockOp, CursorPosition } from "../src/lib/collab/types.js";
import type { LocalSnapshot } from "../src/lib/collab/sync.js";
import { VaultManager } from "../src/lib/drive/drive.js";
import { blobPath } from "../src/lib/drive/types.js";
import type { VaultBackend } from "../src/lib/drive/types.js";
import type { VaultBackendClient } from "../src/lib/drive/backends.js";
import type { DriveHttpFetch } from "../src/lib/drive/backends.js";
import { generateMailKeypair } from "../src/lib/mail/crypto.js";
import { newDraft } from "../src/lib/mail/compose.js";
import { FakeGitHub } from "./collab-fake-github.js";

// ---------------------------------------------------------------------------
// Tiny fake DOM for the panel mount tests: mountP2PPanel only needs
// innerHTML + querySelector(#id) + addEventListener/click on buttons,
// inputs and selects. The fake re-parses ids + initial attributes on
// every innerHTML write (the mount re-renders in place on each toggle).
// ---------------------------------------------------------------------------

type FakeElKind = "button" | "input" | "select" | "other";

class FakeEl {
  readonly id: string;
  readonly kind: FakeElKind;
  disabled = false;
  checked = false;
  value = "";
  textContent = "";
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(id: string, tagHtml: string, label = "") {
    this.id = id;
    const tag = /<(button|input|select)\b/.exec(tagHtml)?.[1] ?? "other";
    this.kind = tag as FakeElKind;
    if (/\bdisabled\b/.test(tagHtml)) this.disabled = true;
    if (/\bchecked\b/.test(tagHtml)) this.checked = true;
    const value = /value="([^"]*)"/.exec(tagHtml)?.[1];
    if (value !== undefined) this.value = value;
    this.textContent = label;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click(): void {
    if (this.disabled) return;
    for (const fn of this.listeners.get("click") ?? []) fn();
  }

  change(): void {
    for (const fn of this.listeners.get("change") ?? []) fn();
  }
}

class FakeRoot {
  #html = "";
  #els = new Map<string, FakeEl>();

  get innerHTML(): string {
    return this.#html;
  }

  set innerHTML(v: string) {
    this.#html = v;
    this.#els = new Map();
    for (const m of v.matchAll(/<(?:button|input|select)\b[^>]*id="([^"]+)"[^>]*>/g)) {
      const id = m[1] as string;
      const start = m.index ?? 0;
      const tagEnd = v.indexOf(">", start);
      const tagHtml = v.slice(start, tagEnd + 1);
      // Button label: the text between this tag and its close.
      const label =
        m[0].startsWith("<button")
          ? (v.slice(tagEnd + 1).split("</button>")[0] ?? "")
          : "";
      this.#els.set(id, new FakeEl(id, tagHtml, label));
    }
  }

  querySelector(selector: string): FakeEl | null {
    if (!selector.startsWith("#")) return null;
    return this.#els.get(selector.slice(1)) ?? null;
  }
}

function panelDeps(overrides: Partial<P2PPanelDeps> = {}): P2PPanelDeps {
  return {
    settings: defaultP2PSettings(),
    peerId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    selfAddress: "alice@example.arknetz",
    connectedPeers: [],
    iceServersInEffect: ["STUN — Google", "STUN — Cloudflare"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Panel render
// ---------------------------------------------------------------------------

test("p2p-phase2: panel renders all-off by default, with the privacy note + diagnostics", () => {
  const html = renderP2PPanelHtml(panelDeps());
  assert.match(html, /Turn on peer-to-peer/);
  assert.match(html, /aria-pressed="false"/);
  // Every feature toggle is present and disabled while the master is off.
  for (const id of [
    "an-p2p-toggle-sites",
    "an-p2p-toggle-collab",
    "an-p2p-toggle-mail",
    "an-p2p-toggle-drive",
    "an-p2p-toggle-serve",
  ]) {
    assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`));
  }
  // The relay privacy note is verbatim.
  assert.ok(html.includes(P2P_RELAY_PRIVACY_NOTE));
  assert.match(html, /No P2P peers connected/);
  assert.match(html, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(html, /alice@example\.arknetz/);
  assert.match(html, /STUN — Google/);
  // TURN defaults: freeturn on, Open Relay demo off, no provider.
  assert.match(html, /id="an-p2p-turn-freeturn"[^>]*checked/);
  assert.doesNotMatch(html, /id="an-p2p-turn-openrelay-demo"[^>]*checked/);
  assert.match(html, /<option value="none" selected>/);
});

test("p2p-phase2: panel renders a connected peer's diagnostics line", () => {
  const html = renderP2PPanelHtml(
    panelDeps({
      settings: { ...defaultP2PSettings(), enabled: true, sites: true },
      connectedPeers: [
        {
          peerId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          address: "bob@example.arknetz",
          diagnostics: {
            path: "loopback",
            summary: "Loopback (test transport) — no network, no ICE, no relay.",
          },
        },
      ],
    }),
  );
  assert.match(html, /Turn off peer-to-peer/);
  assert.match(html, /bob@example\.arknetz/);
  assert.match(html, /Loopback \(test transport\)/);
  assert.doesNotMatch(html, /No P2P peers connected/);
  // Master on => feature toggles enabled.
  assert.doesNotMatch(html, /id="an-p2p-toggle-collab"[^>]*disabled/);
});

// ---------------------------------------------------------------------------
// Panel mount (fake DOM clicks)
// ---------------------------------------------------------------------------

test("p2p-phase2: mount toggles the master switch and flips a feature", () => {
  const seen: Array<ReturnType<typeof defaultP2PSettings>> = [];
  const root = new FakeRoot();
  mountP2PPanel(root as unknown as HTMLElement, {
    ...panelDeps(),
    onSettingsChange: (next) => seen.push(next),
  });
  const master = root.querySelector("#an-p2p-toggle-master");
  assert.ok(master);
  assert.equal(master.textContent, "Turn on peer-to-peer");
  master.click();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.enabled, true);
  // After the re-render the master button reads "Turn off…" and the
  // collab toggle is enabled and flippable.
  const masterAfter = root.querySelector("#an-p2p-toggle-master");
  assert.equal(masterAfter?.textContent, "Turn off peer-to-peer");
  const collab = root.querySelector("#an-p2p-toggle-collab");
  assert.ok(collab);
  assert.equal(collab.disabled, false);
  collab.click();
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.collab, true);
  assert.equal(seen[1]!.enabled, true);
  // A disabled feature toggle (master off) never fires.
  const root2 = new FakeRoot();
  const seen2: Array<ReturnType<typeof defaultP2PSettings>> = [];
  mountP2PPanel(root2 as unknown as HTMLElement, {
    ...panelDeps(),
    onSettingsChange: (next) => seen2.push(next),
  });
  root2.querySelector("#an-p2p-toggle-collab")?.click();
  assert.equal(seen2.length, 0);
});

test("p2p-phase2: mount TURN provider + key + freeturn checkbox report through onSettingsChange", () => {
  const seen: Array<ReturnType<typeof defaultP2PSettings>> = [];
  const root = new FakeRoot();
  mountP2PPanel(root as unknown as HTMLElement, {
    ...panelDeps({ settings: { ...defaultP2PSettings(), enabled: true } }),
    onSettingsChange: (next) => seen.push(next),
  });
  const turnBtn = root.querySelector("#an-p2p-toggle-turn");
  turnBtn?.click();
  assert.equal(seen[0]!.turn.enabled, true);
  const freeturn = root.querySelector("#an-p2p-turn-freeturn");
  assert.ok(freeturn);
  freeturn.checked = false;
  freeturn.change();
  assert.equal(seen[1]!.turn.useFreeTurn, false);
  const apiKey = root.querySelector("#an-p2p-turn-apikey");
  assert.ok(apiKey);
  apiKey.value = "my-own-metered-key";
  apiKey.change();
  assert.equal(seen[2]!.turn.apiKey, "my-own-metered-key");
  const urls = root.querySelector("#an-p2p-turn-urls");
  assert.ok(urls);
  urls.value = "turns:turn.example.org:5349, turn:turn2.example.org:3478";
  urls.change();
  assert.deepEqual(seen[3]!.turn.urls, ["turns:turn.example.org:5349", "turn:turn2.example.org:3478"]);
});

test("p2p-phase2: mount rotate + reset buttons call their handlers", () => {
  let rotated = 0;
  let reset = 0;
  const root = new FakeRoot();
  mountP2PPanel(root as unknown as HTMLElement, {
    ...panelDeps(),
    onRotatePeerId: () => {
      rotated += 1;
    },
    onResetPeerId: () => {
      reset += 1;
    },
  });
  root.querySelector("#an-p2p-rotate-id")?.click();
  root.querySelector("#an-p2p-reset-id")?.click();
  assert.equal(rotated, 1);
  assert.equal(reset, 1);
  // Reset re-renders the panel back to the all-off default.
  assert.match(root.innerHTML, /Turn on peer-to-peer/);
});

// ---------------------------------------------------------------------------
// Collab session + P2P hook
// ---------------------------------------------------------------------------

const DOMAIN = "computers.edu";
const OWNER = "alice";
const REPO = "arknetz-site-computers-edu";

function emptySnapshot(): LocalSnapshot {
  return { blocks: [], versions: new Map(), placement: new Map(), deleted: new Map() };
}

class StubHook implements CollabP2PHook {
  events: CollabP2PHookEvents | null = null;
  started = 0;
  stopped = 0;
  sentOps: BlockOp[] = [];
  sentCursors: Array<CursorPosition | null> = [];
  noted: string[][] = [];
  failStart = false;

  async start(sessionId: string, domain: string, events: CollabP2PHookEvents): Promise<void> {
    this.started += 1;
    if (this.failStart) throw new Error("p2p unavailable (stub)");
    this.events = events;
    void sessionId;
    void domain;
  }

  notePresence(logins: readonly string[]): void {
    this.noted.push([...logins]);
  }

  sendOps(ops: BlockOp[]): void {
    this.sentOps.push(...ops);
  }

  sendCursor(cursor: CursorPosition | null): void {
    this.sentCursors.push(cursor);
  }

  stop(): void {
    this.stopped += 1;
    this.events = null;
  }
}

async function makeSession(hook: CollabP2PHook, onP2POps?: (ops: BlockOp[]) => void): Promise<CollabSession> {
  const fake = new FakeGitHub();
  const session = new CollabSession({
    login: "alice",
    relay: new CollabRelay({ owner: OWNER, repo: REPO, domain: DOMAIN, token: "tok-alice", fetchFn: fake.fetchFn }),
    getLocalSnapshot: emptySnapshot,
    onRemoteStates: () => undefined,
    autoPoll: false,
    p2p: hook,
    onP2POps,
  });
  return session;
}

test("p2p-phase2: collab join starts the hook, slows the poll while P2P is live, restores on drop", async () => {
  const hook = new StubHook();
  const session = await makeSession(hook);
  await session.join();
  assert.equal(hook.started, 1);
  assert.equal(session.currentPollMs, POLL_MS);
  hook.events?.onConnected();
  assert.equal(session.currentPollMs, COLLAB_P2P_SLOW_POLL_MS);
  hook.events?.onDropped();
  assert.equal(session.currentPollMs, POLL_MS);
  await session.leave();
  assert.equal(hook.stopped, 1);
});

test("p2p-phase2: collab broadcastOps + setCursor ride the hook; remote P2P ops reach onP2POps", async () => {
  const received: BlockOp[] = [];
  const hook = new StubHook();
  const session = await makeSession(hook, (ops) => received.push(...ops));
  await session.join();
  const op: BlockOp = {
    kind: "upsert",
    opId: "op-1",
    baseUpdatedAt: 0,
    blockId: "b1",
    block: { type: "p", text: "hello", id: "b1" },
    updatedAt: 100,
    author: "alice",
  };
  await session.broadcastOps([op]);
  assert.deepEqual(hook.sentOps, [op]);
  session.setCursor({ blockId: "b1", start: 2, end: 2 });
  assert.deepEqual(hook.sentCursors, [{ blockId: "b1", start: 2, end: 2 }]);
  // Remote ops arriving over P2P flow into the session's apply path.
  const remoteOp: BlockOp = {
    kind: "upsert",
    opId: "op-2",
    baseUpdatedAt: 0,
    blockId: "b2",
    block: { type: "p", text: "from bob", id: "b2" },
    updatedAt: 200,
    author: "bob",
  };
  hook.events?.onOps([remoteOp]);
  assert.deepEqual(received, [remoteOp]);
  // Presence from the relay poll is noted to the hook (lazy connect).
  session.notePresence(["alice", "bob"]);
  assert.deepEqual(hook.noted, [["alice", "bob"]]);
  // setCursor fires a fire-and-forget relay write; let it settle
  // before leave() or its PUT races the delete (409 on the fake).
  await new Promise((r) => setTimeout(r, 20));
  await session.leave();
});

test("p2p-phase2: a hook that fails to start never breaks the relay join", async () => {
  const hook = new StubHook();
  hook.failStart = true;
  const session = await makeSession(hook);
  await session.join();
  assert.equal(session.joined, true);
  await session.leave();
  assert.equal(hook.stopped, 1);
});

// ---------------------------------------------------------------------------
// Vault chunk import (P2P drive receive side)
// ---------------------------------------------------------------------------

class MemoryClient implements VaultBackendClient {
  readonly kind: VaultBackend["kind"] = "gh";
  readonly repo = "alice/arknetz-vault";
  readonly branch = "main";
  readonly store = new Map<string, Uint8Array>();

  async putBlob(path: string, data: Uint8Array): Promise<void> {
    this.store.set(path, new Uint8Array(data));
  }

  async getBlob(path: string): Promise<Uint8Array | null> {
    const found = this.store.get(path);
    return found ? new Uint8Array(found) : null;
  }

  async deleteBlob(path: string): Promise<void> {
    this.store.delete(path);
  }

  async listBlobs(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

function vaultBackend(): VaultBackend {
  return { kind: "gh", uri: "gh:alice/arknetz-vault", repo: "alice/arknetz-vault", accountId: "acct-alice" };
}

test("p2p-phase2: vault importStoredChunk round-trips a chunk uploaded through the hook", async () => {
  const client = new MemoryClient();
  let captured: { vaultId: string; blobId: string; storedBytes: Uint8Array } | null = null;
  const manager = new VaultManager(vaultBackend(), client, {
    onChunkUploaded: (vaultId, blobId, storedBytes) => {
      captured = { vaultId, blobId, storedBytes };
    },
  });
  await manager.open("correct horse battery staple");
  const uploaded = await manager.uploadFile("notes.txt", new TextEncoder().encode("hello vault"), null, "text/plain");
  assert.ok(captured, "upload fires onChunkUploaded with the stored bytes");
  const { vaultId, blobId, storedBytes } = captured as NonNullable<typeof captured>;
  assert.equal(manager.vaultId, vaultId);

  // The uploaded chunk is already in the manifest, so re-importing
  // it dedups (stored:false) with the right hash.
  const dup = await manager.importStoredChunk(vaultId, blobId, storedBytes);
  assert.equal(dup.stored, false);
  assert.match(dup.hash, /^[0-9a-f]{64}$/);

  // Delete the file: the chunk record leaves the manifest (refCount
  // 0) and the blob leaves the repo, so the same bytes can now be
  // re-imported as new — the realistic P2P case (another device
  // still holds the chunk).
  const confirmation = await manager.prepareDelete(uploaded.file.id);
  await manager.confirmDelete({ ...confirmation, confirmed: true });
  const blobPathFor = blobPath(blobId);
  assert.equal(client.store.has(blobPathFor), false);
  const first = await manager.importStoredChunk(vaultId, blobId, storedBytes);
  assert.equal(first.stored, true);
  assert.equal(first.hash, dup.hash);
  assert.ok(client.store.has(blobPathFor), "import writes the blob to the repo");
  // And now it dedups again.
  const second = await manager.importStoredChunk(vaultId, blobId, storedBytes);
  assert.equal(second.stored, false);
  assert.equal(second.hash, first.hash);

  // Wrong vault: refused before any write.
  await assert.rejects(
    () => manager.importStoredChunk("vault-other", blobId, storedBytes),
    /different vault/,
  );
  // Tampered bytes: AES-GCM authentication fails, nothing is stored.
  const tampered = new Uint8Array(storedBytes);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
  client.store.delete(blobPathFor);
  await assert.rejects(() => manager.importStoredChunk(vaultId, blobId, tampered));
  assert.equal(client.store.has(blobPathFor), false);
});

// ---------------------------------------------------------------------------
// App accessors
// ---------------------------------------------------------------------------

test("p2p-phase2: app exposes the host with all-off defaults, persistence, rotation + reset", async () => {
  const app = createArkNetzApp();
  assert.ok(app.p2pHost);
  // The peer id is assigned by load() (fresh id when none is stored).
  await app.loadP2PSettings();
  assert.deepEqual(app.getP2PSettings(), defaultP2PSettings());
  assert.match(app.getP2PPeerId(), /^[0-9a-f]{32}$/);
  assert.equal(app.getP2PSelfAddress(), null);
  // Collab hook is null while P2P collab is off (relay-only).
  assert.equal(app.getP2PCollabHook("example.arknetz"), null);

  // Enable + persist through the memory store.
  app.setP2PSettings({ ...defaultP2PSettings(), enabled: true, collab: true, sites: true });
  const reloaded = await app.loadP2PSettings();
  assert.equal(reloaded.enabled, true);
  assert.equal(reloaded.collab, true);
  assert.ok(app.getP2PCollabHook("example.arknetz"), "hook exists once enabled + collab on");
  assert.ok(app.getP2PIceServers().length > 0);
  assert.ok(app.getP2PIceServers().some((label) => label.startsWith("STUN")));

  // Rotation changes the id; reset restores the all-off default.
  const before = app.getP2PPeerId();
  const rotated = await app.rotateP2PPeerId();
  assert.notEqual(rotated, before);
  assert.equal(app.getP2PPeerId(), rotated);
  await app.resetP2PPeerId();
  assert.deepEqual(app.getP2PSettings(), defaultP2PSettings());
  assert.notEqual(app.getP2PPeerId(), rotated);
});

// ---------------------------------------------------------------------------
// Host mail fallback (P2P off -> GitHub inbox Issue)
// ---------------------------------------------------------------------------

test("p2p-phase2: host sendDraft falls back to the GitHub inbox when P2P is off", async () => {
  const aliceKeys = await generateMailKeypair("alice@example.arknetz");
  const bobKeys = await generateMailKeypair("bob@example.arknetz");
  const bobJwk = await crypto.subtle.exportKey("jwk", bobKeys.publicKey);

  // Contacts shard: bob's public key + GitHub login. The .zst URL
  // 404s (no compressed shard in this test) so the host falls back
  // to the plain JSON shard — a 200 with plain JSON on the .zst URL
  // would fail Zstd decompression instead.
  const rawFetch = (async (url: string) => {
    if (url.endsWith(".zst")) {
      return { status: 404, text: async () => "not found", arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url.includes("contacts")) {
      const body = JSON.stringify([
        { address: "bob@example.arknetz", publicKeyJwk: bobJwk, githubUser: "bobdev" },
      ]);
      return { status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
    }
    return { status: 404, text: async () => "not found", arrayBuffer: async () => new ArrayBuffer(0) };
  }) as ConstructorParameters<typeof P2PHost>[0]["rawFetch"];

  const apiCalls: Array<{ url: string; method: string }> = [];
  const apiFetch = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    apiCalls.push({ url: String(url), method: init?.method ?? "GET" });
    return {
      status: 201,
      json: async () => ({ number: 7 }),
      text: async () => JSON.stringify({ number: 7 }),
    };
  }) as ConstructorParameters<typeof P2PHost>[0]["apiFetch"];

  const host = new P2PHost({
    settingsStore: createMemoryP2PStore(),
    apiFetch,
    rawFetch,
    factory: new LoopbackConnectionFactory(),
    autoStart: false,
  });
  await host.load();
  host.configureIdentity({
    address: "alice@example.arknetz",
    githubLogin: "alice",
    token: "TOKEN-ALICE",
    privateKey: aliceKeys.privateKey,
  });
  // P2P stays off (all-off defaults) — the send must use GitHub.
  const result = await host.sendDraft(
    {
      ...newDraft("alice@example.arknetz"),
      to: ["bob@example.arknetz"],
      subject: "hello",
      body: "hi bob",
    },
    aliceKeys,
  );
  assert.deepEqual(result.p2p, []);
  assert.deepEqual(result.github, ["bob@example.arknetz"]);
  assert.deepEqual(result.issueNumbers, [7]);
  assert.ok(apiCalls.some((c) => c.url.includes("/repos/bobdev/") && c.url.includes("/issues") && c.method === "POST"));
});
