// app.ts — application wiring layer for ArkNetzWebWeaver.
//
// One place that constructs every phase service and lists every panel
// the shell shows. The shell (src/main.ts) only needs to call
// createArkNetzApp() once and mount the panels from APP_PANELS.
// No DOM is touched here: each phase exposes pure view-model functions
// and the shell wires them to elements.
//
// This file is the integration point for the pre-GitHub program:
// Phase 1 mail, Phase 2 ArkDrive, Phase 3a comments + search,
// Phase 3b offline + stats + streaming, Phase 4a domains + moderation,
// Phase 4b backends + Wayback + multi-account + ToS + PROTOCOL.md.
// Nothing here talks to real GitHub/IA: every service takes an injected
// fetch (default: the global fetch) and the tests inject mocks.
import { MASTER_GITHUB_USER } from "./config.js";
import { AccountKeyring, PROVIDER_PREFIX, createIndexedDBKeyringStore, createMemoryKeyringStore } from "./network/accounts.js";
import type { AccountProvider } from "./network/accounts.js";
import type { BackendPrefix, MirrorAttempt, ProjectFlags } from "./network/backends.js";
import { createVaultBackendClient } from "./drive/backends.js";
import type { DriveHttpFetch, VaultBackendClient } from "./drive/backends.js";
import { PooledDrive } from "./drive/pooled.js";
import type { PooledVault } from "./drive/pooled.js";
import { VaultManager } from "./drive/drive.js";
import type { VaultBackend as DriveVaultBackend } from "./drive/types.js";
import { MailDelivery } from "./mail/delivery.js";
import type { GithubApiFetch } from "./mail/delivery.js";
import { createIndexedDBDraftStore, createMemoryDraftStore } from "./mail/compose.js";
import { createIndexedDBMailStore, createMemoryMailStore, Inbox } from "./mail/inbox.js";
import type { MailStore } from "./mail/inbox.js";
import type { MailKeypair } from "./mail/types.js";
import { generateMailKeypair } from "./mail/crypto.js";
import { LocalSearchIndex, SearchHistory, createIndexedDBSearchStore, createMemorySearchStore, loadDirectoryShardsFromManifest } from "./viewer/search.js";
import type { DirectoryShard } from "./viewer/search.js";
import type { ProtocolManifest } from "./types.js";
import { CachedFetcher } from "./cache.js";
import { createMemoryPingStore, createIndexedDBTelemetrySettingsStore, createMemoryTelemetrySettingsStore, defaultTelemetrySettings, emptyStats } from "./viewer/stats.js";
import type { SiteStats, TelemetrySettings, TelemetrySettingsStore } from "./viewer/stats.js";
import { createIndexedDBMyListStore, createIndexedDBProgressStore, createMemoryMyListStore, createMemoryProgressStore } from "./viewer/streaming.js";
import type { DraftStore } from "./mail/compose.js";
import { P2PHost } from "./p2p/host.js";
import { createIndexedDBP2PStore, createMemoryP2PStore } from "./p2p/store.js";
import type { P2PSettings } from "./p2p/types.js";
import { defaultP2PSettings } from "./p2p/types.js";
import type { P2PPeerInfo } from "./p2p/host.js";
import type { P2PPeerRow } from "./p2p/panel.js";
import type { CollabP2PHook } from "./collab/session.js";
import { MediaCallController } from "./p2p/call-panel.js";
import type { CallsHost } from "./p2p/call-panel.js";
import { browserMediaDevices } from "./p2p/media-devices.js";
import { WebRtcMediaConnectionFactory } from "./p2p/media-connection.js";
import type { SearchIndexStore } from "./viewer/search.js";
import type { ViewPingStore } from "./viewer/stats.js";
import type { MyListStore, ProgressStore } from "./viewer/streaming.js";
import type { KeyringStore } from "./network/accounts.js";

export interface AppPanel {
  /** Stable id, also used as the nav button id suffix (`panel-<id>`). */
  id: string;
  /** Short title shown in the top nav. */
  title: string;
  /** One-line description for the nav / empty state. */
  description: string;
  /** Which phase module provides it. */
  module: string;
  /** True when the panel needs a signed-in GitHub account to do anything. */
  needsSignIn: boolean;
}

/** Every panel the shell must show, in nav order. */
export const APP_PANELS: readonly AppPanel[] = [
  { id: "browse", title: "Browse", description: "Guest browsing, tabs and bookmarks.", module: "shell", needsSignIn: false },
  { id: "builder", title: "Builder", description: "Visual site builder — live canvas, blocks, themes.", module: "editor", needsSignIn: true },
  { id: "mail", title: "Mail", description: "Protocol mail — inbox, compose, contacts, mailing lists. Protocol-native only; it cannot email Gmail or Outlook.", module: "mail", needsSignIn: true },
  { id: "drive", title: "ArkDrive", description: "Zero-knowledge encrypted cloud drive.", module: "drive", needsSignIn: true },
  { id: "search", title: "Search", description: "Federated local search over directory shards, Trending and Newly Updated.", module: "viewer/search", needsSignIn: false },
  { id: "comments", title: "Comments", description: "Threaded comments on the site you are reading. Guests read free.", module: "viewer/comments", needsSignIn: false },
  { id: "streaming", title: "Watch", description: "Series and films — Continue Watching, My List, season dropdowns.", module: "viewer/streaming", needsSignIn: false },
  { id: "offline", title: "Offline", description: "Save a site offline as a portable .arknetz bundle.", module: "viewer/offline", needsSignIn: false },
  { id: "stats", title: "Stats", description: "Privacy-preserving site stats — views, comments, reactions, media plays.", module: "viewer/stats", needsSignIn: false },
  { id: "domains", title: "Domains", description: "Claim an exact-string custom domain, manage sub-delegations.", module: "domains", needsSignIn: true },
  { id: "moderation", title: "Moderation", description: "Root Master admin panel and registrar sub-moderation. Hidden unless you are the Root Master.", module: "moderation", needsSignIn: true },
  { id: "accounts", title: "Accounts", description: "Switch accounts across every backend, per-site auto-binding, Root Registries.", module: "network/accounts", needsSignIn: false },
  { id: "wayback", title: "Time Machine", description: "Snapshot a site to the Wayback Machine and browse its history.", module: "network/wayback", needsSignIn: true },
  { id: "backends", title: "Backends", description: "Every storage backend ArkNetz can read and write — linked accounts, mirror failover, and ToS-aware upload routing.", module: "network/backends", needsSignIn: false },
  { id: "p2p", title: "P2P", description: "Optional peer-to-peer transport — faster site loads, live collab, mail and drive between your devices. Off by default; GitHub stays the fallback.", module: "p2p", needsSignIn: false },
  { id: "calls", title: "Calls", description: "Encrypted voice, video, screensharing, and group calls over P2P. Off by default; calls have no GitHub fallback.", module: "p2p", needsSignIn: false },
  { id: "settings", title: "Settings", description: "IA account linking, telemetry (Strict Offline mode), ToS acceptance, backends.", module: "network/tos", needsSignIn: false },
];

export function panelById(id: string): AppPanel | undefined {
  return APP_PANELS.find((p) => p.id === id);
}

/** Which panels a login may SEE in the nav (P5). Every panel is
 *  visible except Moderation, which is hidden entirely unless the
 *  active GitHub account is the Root Master — its own description
 *  says "Hidden unless you are the Root Master", and guests used to
 *  see the button anyway and land on a "only visible to the Root
 *  Master" note. Hiding the button is UI only; enforcement is still
 *  GitHub's 403 on the moderation repo, never this check. */
export function panelVisibleForLogin(panel: AppPanel, githubLogin: string | null | undefined): boolean {
  if (panel.id === "moderation") return githubLogin === MASTER_GITHUB_USER;
  return true;
}

/** The panels to show in the nav for a login, in registry order. */
export function visiblePanelsForLogin(
  panels: readonly AppPanel[],
  githubLogin: string | null | undefined,
): AppPanel[] {
  return panels.filter((p) => panelVisibleForLogin(p, githubLogin));
}

export interface ArkNetzAppOptions {
  /** Fetch implementation for GitHub/IA/backends. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Use IndexedDB stores instead of memory stores (browser/Tauri only). */
  useIndexedDB?: boolean;
  /** Master GitHub username for admin-badge detection. */
  masterGithubUser?: string;
}

export interface ArkNetzApp {
  panels: readonly AppPanel[];
  /** Protocol-mail delivery client (GitHub Issues transport). */
  mailDelivery: MailDelivery;
  mailStore: MailStore;
  draftStore: DraftStore;
  /** Open a mail inbox once a keypair exists (generate with newMailKeypair). */
  openInbox: (keypair: MailKeypair) => Inbox;
  /** Generate a fresh mail keypair for an address. */
  newMailKeypair: (address: string) => Promise<MailKeypair>;
  /** Federated search index + history. */
  searchIndex: LocalSearchIndex;
  searchHistory: SearchHistory;
  /** Load the directory shards named by the protocol-root manifest (or
   *  the documented default when the manifest has no
   *  `directoryCategories` field) and index their cards into
   *  searchIndex. The shell calls this after fetching the manifest;
   *  with no central repos yet it loads nothing and the index stays
   *  empty. Returns the loaded shards. */
  loadDirectoryShards: (
    manifest: ProtocolManifest | null | undefined,
    fetcher: CachedFetcher,
  ) => Promise<DirectoryShard[]>;
  /** Privacy-preserving stats ping store. */
  pingStore: ViewPingStore;
  /** Telemetry-settings store (Stats panel toggles). The app keeps a
   *  synchronous in-memory mirror of the current settings because the
   *  panel render/wire path is synchronous; use the accessors below. */
  telemetrySettingsStore: TelemetrySettingsStore;
  /** Current telemetry settings (synchronous copy of the mirror). */
  getTelemetrySettings: () => TelemetrySettings;
  /** Update the settings: the mirror changes synchronously (so a
   *  panel re-render sees the new values immediately) and the store
   *  write happens in the background. */
  setTelemetrySettings: (next: TelemetrySettings) => void;
  /** Re-read the persisted settings into the mirror (call once at
   *  startup, before the panels mount). Returns the loaded settings. */
  loadTelemetrySettings: () => Promise<TelemetrySettings>;
  /** Rolled-up stats for a site. No stats.json.zst loader exists yet,
   *  so this honestly returns emptyStats(domain) until a site with
   *  stats is loaded — the Stats panel shows its empty states. */
  getSiteStats: (domain: string) => SiteStats;
  /** Project flags for ToS-aware upload routing. No project-flags
   *  source exists yet, so this returns {} (hf:/wm: not offered as
   *  upload targets) until one lands. */
  getProjectFlags: () => ProjectFlags;
  /** Linked-account label per backend prefix, built from the keyring:
   *  github→gh, gitlab→gl, codeberg→cb, internet_archive→ia,
   *  huggingface→hf, wikimedia→wm (profile label as value). ipfs has
   *  no account provider and is never linked. */
  getLinkedBackends: () => Partial<Record<BackendPrefix, string>>;
  /** Mirror attempts from the last site load. The resolver does not
   *  record attempts yet, so this returns [] until it does — the
   *  Backends panel shows its honest "no load yet" state. */
  getLastMirrorAttempts: () => MirrorAttempt[];
  /** Streaming progress + My List stores. */
  progressStore: ProgressStore;
  myListStore: MyListStore;
  /** Multi-account encrypted keyring. */
  keyring: AccountKeyring;
  /** Open an ArkDrive vault for a backend (throws for ia:/wm: by design). */
  openVault: (backend: DriveVaultBackend, token?: string) => VaultManager;
  /** Pooled view over already-open vaults. */
  pooledDrive: (vaults: PooledVault[]) => PooledDrive;
  /** True once a vault/account is usable; the shell uses this to decide which panels are live. */
  describeReadiness: () => { panels: number; signedInPanels: number; note: string };
  /** P2P host (phase 2): owns settings persistence, the peer
   *  manager, signaling, and the per-feature adapters. The shell
   *  wires identity (sign-in) and the registry resolver after
   *  construction; the host is inert (all-off) until then. */
  p2pHost: P2PHost;
  /** Current P2P settings (synchronous copy of the host's mirror). */
  getP2PSettings: () => P2PSettings;
  /** Update the P2P settings (persisted by the host's store). */
  setP2PSettings: (next: P2PSettings) => void;
  /** Re-read the persisted P2P settings + peer id into the host
   *  (call once at startup, before the P2P panel mounts). */
  loadP2PSettings: () => Promise<P2PSettings>;
  /** This device's peer id. */
  getP2PPeerId: () => string;
  /** Rotate the peer id (old id stops being advertised). */
  rotateP2PPeerId: () => Promise<string>;
  /** Reset the peer id and clear every P2P setting + TURN key. */
  resetP2PPeerId: () => Promise<string>;
  /** Currently connected peers with their diagnostics summaries. */
  getP2PConnectedPeers: () => Promise<P2PPeerRow[]>;
  /** ICE servers in effect right now (STUN always, TURN when on). */
  getP2PIceServers: () => string[];
  /** This device's protocol address, when the host knows one. */
  getP2PSelfAddress: () => string | null;
  /** The P2P collab hook for a domain, or null when P2P collab is
   *  off — the editor then runs relay-only. */
  getP2PCollabHook: (domain: string) => CollabP2PHook | null;
  /** The Calls panel controller (lazy singleton), or null where
   *  calls cannot run (no WebRTC here — Node, or a WebView without
   *  it). The panel reports that honestly instead of pretending.
   *  Null is also the state before the first call: the controller
   *  is created once, on first use, and survives panel switches. */
  getCallsController: () => MediaCallController | null;
}

/** Construct every phase service with shared stores. No network is used. */
export function createArkNetzApp(options: ArkNetzAppOptions = {}): ArkNetzApp {
  // NB: `globalThis.fetch` must NOT be stored bare. In browsers fetch
  // is a method on Window and calling the detached reference throws
  // "Failed to execute 'fetch' on 'Window': Illegal invocation" — which
  // is exactly what vault-open (and every other fetch-backed call
  // through this app object) did in a real browser, while Node's
  // unbound-safe fetch let all 388 unit tests pass. Wrap it so the
  // call is always a method call on globalThis. (Round 3 live QA,
  // 2026-11-20: caught by driving the built frontend in headless
  // Chrome; the vault-open status showed the raw TypeError.)
  const fetchFn = (options.fetchFn ??
    ((...args: [input: RequestInfo | URL, init?: RequestInit]) => globalThis.fetch(...args))) as unknown as GithubApiFetch;
  const useIdb = options.useIndexedDB === true;
  const mailStore: MailStore = useIdb ? createIndexedDBMailStore() : createMemoryMailStore();
  const draftStore: DraftStore = useIdb ? createIndexedDBDraftStore() : createMemoryDraftStore();
  const searchStore: SearchIndexStore = useIdb ? createIndexedDBSearchStore() : createMemorySearchStore();
  const keyringStore: KeyringStore = useIdb ? createIndexedDBKeyringStore() : createMemoryKeyringStore();

  const mailDelivery = new MailDelivery(fetchFn);
  const searchIndex = new LocalSearchIndex();
  const searchHistory = new SearchHistory(searchStore);
  const pingStore = createMemoryPingStore();
  const telemetrySettingsStore: TelemetrySettingsStore = useIdb
    ? createIndexedDBTelemetrySettingsStore()
    : createMemoryTelemetrySettingsStore();
  // Synchronous mirror of the telemetry settings (see the interface
  // note): the panel render/wire path cannot await a store read, so
  // reads serve the mirror and writes update it first, then persist.
  let currentTelemetrySettings: TelemetrySettings = defaultTelemetrySettings();
  // Hunt 5: these used to be memory stores unconditionally, so
  // Continue Watching and My List vanished on every reload while the
  // Watch panel promised IndexedDB storage. IndexedDB when the app
  // runs with it, memory otherwise (tests / Node).
  const progressStore = useIdb ? createIndexedDBProgressStore() : createMemoryProgressStore();
  const myListStore = useIdb ? createIndexedDBMyListStore() : createMemoryMyListStore();
  const keyring = new AccountKeyring(keyringStore, options.masterGithubUser);

  // P2P host (phase 2): per-device settings in IndexedDB when the
  // app runs with it, memory otherwise. The shell wires identity
  // (configureIdentity after sign-in) and the registry resolver
  // (setRegistryResolver) — until then the host is inert: all-off
  // settings, no connections, no ads. The raw fetch is the plain
  // global fetch (peer ads + contacts shards are public raw CDN
  // reads); the API fetch is the app's bound fetch.
  const p2pHost = new P2PHost({
    settingsStore: useIdb ? createIndexedDBP2PStore() : createMemoryP2PStore(),
    apiFetch: fetchFn,
    rawFetch: (...args: [input: RequestInfo | URL, init?: RequestInit]) => globalThis.fetch(...args),
  });

  // Provider -> backend prefix for the Backends panel's `linked` map.
  // accounts.ts already owns PROVIDER_PREFIX (provider -> "gh:" etc.);
  // strip the trailing colon. ipfs has no provider and never appears.
  const linkedBackends = (): Partial<Record<BackendPrefix, string>> => {
    const linked: Partial<Record<BackendPrefix, string>> = {};
    for (const profile of keyring.snapshot().profiles) {
      const prefix = PROVIDER_PREFIX[profile.provider as AccountProvider].replace(/:$/, "") as BackendPrefix;
      linked[prefix] = profile.label;
    }
    return linked;
  };

  // Calls controller (media UI phase): lazy singleton, created on
  // first use from the browser's media stack. In Node (no
  // RTCPeerConnection) or a WebView without WebRTC it stays null —
  // the Calls panel then reports that calls cannot run here.
  // The `callsHost` assignment is the structural conformance check:
  // P2PHost must satisfy CallsHost, or this does not compile.
  let callsController: MediaCallController | null = null;
  let callsControllerTried = false;
  const getCallsController = (): MediaCallController | null => {
    if (callsControllerTried) return callsController;
    callsControllerTried = true;
    try {
      if (
        typeof RTCPeerConnection === "undefined" ||
        typeof navigator === "undefined"
      ) {
        return null;
      }
      const callsHost: CallsHost = p2pHost;
      callsController = new MediaCallController({
        host: callsHost,
        devices: browserMediaDevices(),
        mediaFactory: new WebRtcMediaConnectionFactory(),
        userAgent: navigator.userAgent,
      });
    } catch {
      callsController = null;
    }
    return callsController;
  };

  return {
    panels: APP_PANELS,
    mailDelivery,
    mailStore,
    draftStore,
    openInbox: (keypair) => new Inbox(mailStore, keypair),
    newMailKeypair: (address) => generateMailKeypair(address),
    searchIndex,
    searchHistory,
    loadDirectoryShards: async (manifest, fetcher) => {
      const shards = await loadDirectoryShardsFromManifest(manifest, fetcher);
      for (const shard of shards) searchIndex.addCards(shard.cards);
      return shards;
    },
    pingStore,
    telemetrySettingsStore,
    getTelemetrySettings: () => ({ ...currentTelemetrySettings }),
    setTelemetrySettings: (next) => {
      currentTelemetrySettings = { ...next };
      // Persist in the background; a failed write must not throw out
      // of a synchronous toggle handler — the mirror already holds
      // the new value for this session.
      void telemetrySettingsStore.set(currentTelemetrySettings).catch(() => undefined);
    },
    loadTelemetrySettings: async () => {
      currentTelemetrySettings = await telemetrySettingsStore.get();
      return { ...currentTelemetrySettings };
    },
    getSiteStats: (domain) => emptyStats(domain),
    getProjectFlags: () => ({}),
    getLinkedBackends: linkedBackends,
    getLastMirrorAttempts: () => [],
    progressStore,
    myListStore,
    keyring,
    openVault: (backend, token) => {
      // Per-user key rule (fix round 3): `token` must be the vault
      // owner's own provider token — there is no shared/master token.
      // It is checked at first use inside the vault client, which
      // refuses loudly without it, so a missing token fails here at
      // vault.open() rather than as an ambiguous provider 401/404.
      const client: VaultBackendClient = createVaultBackendClient(backend as never, {
        token,
        fetchFn: fetchFn as unknown as DriveHttpFetch,
      });
      // Phase 2 P2P: a freshly uploaded chunk is offered to the
      // user's own online devices (best-effort; the repo blob is
      // the durable copy). The hook never throws into the upload.
      return new VaultManager(backend, client, {
        onChunkUploaded: (vaultId, blobId, storedBytes) => {
          void p2pHost.pushDriveChunk(vaultId, blobId, storedBytes).catch(() => undefined);
        },
      });
    },
    pooledDrive: (vaults) => new PooledDrive(vaults),
    p2pHost,
    getP2PSettings: () => p2pHost.getSettings(),
    setP2PSettings: (next) => p2pHost.setSettings(next),
    loadP2PSettings: async () => {
      const state = await p2pHost.load();
      return { ...state.settings, turn: { ...state.settings.turn } };
    },
    getP2PPeerId: () => p2pHost.getPeerId(),
    rotateP2PPeerId: () => p2pHost.rotatePeerId(),
    resetP2PPeerId: () => p2pHost.resetPeerId(),
    getP2PConnectedPeers: async () => {
      const peers: P2PPeerInfo[] = await p2pHost.connectedPeers();
      return peers.map((peer) => ({
        peerId: peer.peerId,
        address: peer.address,
        diagnostics: peer.diagnostics,
      }));
    },
    getP2PIceServers: () =>
      p2pHost.iceServersInEffect().sources.map((source) => source.label),
    getP2PSelfAddress: () => p2pHost.selfAddress,
    getP2PCollabHook: (domain) => {
      const settings = p2pHost.getSettings();
      if (!settings.enabled || !settings.collab) return null;
      return p2pHost.createCollabHook(domain);
    },
    getCallsController,
    describeReadiness: () => ({
      panels: APP_PANELS.length,
      signedInPanels: APP_PANELS.filter((p) => p.needsSignIn).length,
      note: "Mail, ArkDrive, domains, moderation and Wayback need a signed-in GitHub account and, for writes, real central repos — none exist yet, so those panels report what is missing instead of pretending to work.",
    }),
  };
}
