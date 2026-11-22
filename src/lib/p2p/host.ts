// ArkNetzWebWeaver — P2P host (phase 2 integration).
//
// The one object that wires the phase-1 transport core (src/lib/p2p/)
// into the app: settings + peer identity persistence, the PeerManager,
// the SignalingClient (GitHub Issues), the four feature adapters, the
// signal poller, ad publishing, and the diagnostics the settings panel
// shows.
//
// Design rules (P2P-SPEC.md):
// - OFF by default; every surface is opted into separately.
// - GitHub stays the fallback and the source of truth: every method
//   here returns null/false on any P2P failure, and the caller uses
//   its GitHub path. A P2P failure is never a user-facing error.
// - No network of its own: GitHub API calls go through the injected
//   apiFetch, raw reads through the injected rawFetch, registry
//   resolution through the injected resolveRegistryEntry. Tests inject
//   mocks for all three; the shell injects the real ones.
// - No DOM, no IndexedDB directly — persistence is the injected
//   P2PSettingsStore (store.ts). No secret is ever stored here: the
//   GitHub token and the mail private key arrive per call / per
//   configureIdentity and live only in memory for this session.

import { contactsShardUrl } from "../registry.js";
import { contactsShardZstUrl } from "../mail/contacts.js";
import type { RegistryEntry } from "../types.js";
import { decompressJson } from "../zstd.js";
import { parseContactsShard } from "../mail/contacts.js";
import type { ContactEntry } from "../mail/types.js";
import { buildMailFromDraft } from "../mail/compose.js";
import type { MailDraft } from "../mail/compose.js";
import type { EncryptedMailEnvelope, MailAddress, MailKeypair } from "../mail/types.js";
import { MailDelivery } from "../mail/delivery.js";
import type { GithubApiFetch } from "../mail/delivery.js";
import { parseSiteDocument } from "../registry.js";
import type { SiteDocument } from "../types.js";
import { buildPeerAd, generatePeerId, PEER_AD_TTL_MS } from "./identity.js";
import { assembleIceServers, describeIcePath, loopbackDiagnostics } from "./ice.js";
import type { IceDiagnostics } from "./ice.js";
import { PeerManager } from "./peer-manager.js";
import type { PeerManagerEvent } from "./peer-manager.js";
import { SignalingClient } from "./signaling.js";
import { SiteSharing } from "./site-sharing.js";
import { P2PCollabSession } from "./collab-p2p.js";
import { MailP2P } from "./mail-p2p.js";
import { DriveP2P } from "./drive-p2p.js";
import type { DriveChunkReceived } from "./drive-p2p.js";
import {
  LoopbackConnectionFactory,
  WebRtcConnectionFactory,
} from "./transport.js";
import type { P2PConnection, P2PConnectionFactory } from "./transport.js";
import { defaultP2PSettings } from "./types.js";
import type { P2PSettings, PeerAd, SignalMessage } from "./types.js";
import type { P2PPersistedState, P2PSettingsStore } from "./store.js";
import { defaultP2PPersistedState } from "./store.js";
import { CallManager } from "./call-session.js";
import type { CallEvent, CallSession } from "./call-session.js";
import type { CallKind, MediaControlMessage } from "./media.js";
import { MEDIA_CHANNEL_LABEL, encodeMediaControl } from "./media.js";
import { browserMediaDevices, type MediaDevicesLike } from "./media-devices.js";
import { WebRtcMediaConnectionFactory, type MediaConnectionFactory } from "./media-connection.js";
import type { BlockOp, CursorPosition } from "../collab/types.js";
import type { CollabP2PHook, CollabP2PHookEvents } from "../collab/session.js";

/** The identity P2P needs. All of it is the user's own, supplied by
 *  the shell after sign-in + mail-keypair creation — never invented,
 *  never stored on disk by this host. */
export interface P2PIdentity {
  /** Protocol mail address, e.g. alice@example.arknetz. */
  address: MailAddress;
  /** Signed-in GitHub login. */
  githubLogin: string;
  /** The user's own GitHub OAuth token (sender side). */
  token: string;
  /** The user's mail private key (opens sealed signal Issues). */
  privateKey: CryptoKey;
}

/** Raw read (raw.githubusercontent.com): the shell injects the
 *  CachedFetcher's fetchBytes/text shape. */
export type P2PRawFetch = (
  url: string,
) => Promise<{
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface P2PHostOptions {
  settingsStore: P2PSettingsStore;
  /** GitHub API fetch (authenticated calls pass the token in headers). */
  apiFetch: GithubApiFetch;
  /** Raw-content fetch for ads + contacts shards. */
  rawFetch: P2PRawFetch;
  /** Registry resolution (the shell passes resolver.resolve). The
   *  app shell owns the resolver, so this is optional at
   *  construction: the shell calls setRegistryResolver() once it
   *  exists. Until then every registry lookup fails closed (the
   *  call sites catch and fall back to GitHub). */
  resolveRegistryEntry?: (domain: string) => Promise<RegistryEntry>;
  /** Connection factory. Defaults to WebRTC (throws in environments
   *  without RTCPeerConnection — the host then reports P2P
   *  unavailable and the GitHub path is used). Tests inject the
   *  loopback factory. */
  factory?: P2PConnectionFactory;
  /** Media devices + media connection factory for calls. Defaults
   *  to the browser's (browserMediaDevices() throws in Node, so the
   *  host then reports calls unavailable — the GitHub paths are
   *  unaffected). Tests inject the fakes. */
  mediaDevices?: MediaDevicesLike;
  mediaFactory?: MediaConnectionFactory;
  /** Clock injection (tests). */
  now?: () => number;
  /** Event sink (tests / diagnostics). */
  onEvent?: (event: PeerManagerEvent) => void;
  /** False = do not start timers (tests drive the host by hand). */
  autoStart?: boolean;
}

/** How often the signal inbox is polled while P2P is on. */
export const P2P_SIGNAL_POLL_MS = 30_000;
/** How often my own ad is republished while P2P is on. */
export const P2P_AD_REPUBLISH_MS = 15 * 60_000;
/** How often silent peers are checked. */
export const P2P_SILENCE_CHECK_MS = 60_000;
/** Relay poll while a P2P collab channel is live: 6x slower than
 *  the 5 s default — the branch stays the convergence safety net,
 *  it just stops being the hot path. */
export const P2P_COLLAB_SLOW_POLL_MS = 30_000;

interface PeerAdapters {
  site: SiteSharing;
  mail: MailP2P | null;
  drive: DriveP2P;
}

export interface P2PPeerInfo {
  peerId: string;
  address: string;
  capabilities: string[];
  connected: boolean;
  diagnostics: IceDiagnostics | null;
}

export interface P2PMailSendResult {
  /** Recipients reached direct over P2P. */
  p2p: MailAddress[];
  /** Recipients reached via their Issue inbox (fallback / offline). */
  github: MailAddress[];
  /** Issue numbers created by the fallback path, in delivery order. */
  issueNumbers: number[];
}

export class P2PHost {
  private readonly store: P2PSettingsStore;
  private readonly apiFetch: GithubApiFetch;
  private readonly rawFetch: P2PRawFetch;
  private resolveRegistryEntry: (domain: string) => Promise<RegistryEntry>;
  private readonly factory: P2PConnectionFactory;
  private readonly now: () => number;
  private readonly onEvent?: (event: PeerManagerEvent) => void;
  private readonly autoStart: boolean;
  private readonly signaling: SignalingClient;
  private readonly mailDelivery: MailDelivery;

  private settings: P2PSettings = defaultP2PSettings();
  private peerId = "";
  private ownDomains: string[] = [];
  private identity: P2PIdentity | null = null;
  private manager: PeerManager | null = null;
  /** 1:1 call routing (media UI phase). Created in
   *  configureIdentity when the media stack exists here — null in
   *  Node (no media devices) and before sign-in. The Calls panel
   *  reads it through mediaAvailable()/getCallManager(). */
  private callManager: CallManager | null = null;
  private readonly mediaDevicesOpt?: MediaDevicesLike;
  private readonly mediaFactoryOpt?: MediaConnectionFactory;
  /** Handlers the Calls panel registers (stored here so they
   *  survive the CallManager being created after sign-in). */
  private incomingCallHandler: ((session: CallSession) => void) | null = null;
  private unhandledMediaHandler:
    | ((fromPeerId: string, message: MediaControlMessage) => void)
    | null = null;
  /** Per-session call events for the Calls panel (state, tracks,
   *  consent, recording activity). */
  private sessionEventHandler:
    | ((session: CallSession, event: CallEvent) => void)
    | null = null;
  private readonly adapters = new Map<string, PeerAdapters>();
  private readonly contactCache = new Map<string, ContactEntry | null>();
  private knownVaultIds = new Set<string>();
  private driveChunkSink: ((chunk: DriveChunkReceived) => Promise<void>) | null = null;
  private mailEnvelopeHandler: ((envelope: EncryptedMailEnvelope) => Promise<void>) | null = null;
  private getCachedBundle: ((domain: string) => Promise<Uint8Array | null>) | null = null;
  private signalTimer: ReturnType<typeof setInterval> | null = null;
  private adTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: P2PHostOptions) {
    this.store = options.settingsStore;
    this.apiFetch = options.apiFetch;
    this.rawFetch = options.rawFetch;
    this.resolveRegistryEntry =
      options.resolveRegistryEntry ??
      (async () => {
        throw new Error("no registry resolver configured for P2P");
      });
    this.factory = options.factory ?? new WebRtcConnectionFactory();
    this.mediaDevicesOpt = options.mediaDevices;
    this.mediaFactoryOpt = options.mediaFactory;
    this.now = options.now ?? (() => Date.now());
    this.onEvent = options.onEvent;
    this.autoStart = options.autoStart ?? true;
    this.signaling = new SignalingClient(this.apiFetch, (address) =>
      this.resolveContactPublicKey(address),
    );
    this.mailDelivery = new MailDelivery(this.apiFetch);
  }

  /** Wire the shell's registry resolver after construction (the
   *  app owns the resolver; the host is built before it). Until
   *  this is called, peer-ad lookups fall back to GitHub. */
  setRegistryResolver(fn: (domain: string) => Promise<RegistryEntry>): void {
    this.resolveRegistryEntry = fn;
  }

  /** Load persisted settings + peer ID + own domains. Call once at
   *  startup, before the settings panel mounts. */
  async load(): Promise<P2PPersistedState> {
    const state = await this.store.get();
    this.settings = state.settings;
    this.peerId = state.peerId;
    this.ownDomains = [...state.ownDomains];
    return {
      settings: { ...this.settings, turn: { ...this.settings.turn }, media: { ...this.settings.media } },
      peerId: this.peerId,
      ownDomains: [...this.ownDomains],
    };
  }

  private async persist(): Promise<void> {
    try {
      await this.store.set({
        settings: { ...this.settings, turn: { ...this.settings.turn }, media: { ...this.settings.media } },
        peerId: this.peerId,
        ownDomains: [...this.ownDomains],
      });
    } catch {
      // A failed persist must not throw out of a toggle handler —
      // the in-memory state already holds the new values for this
      // session (same pattern as the telemetry settings mirror).
    }
  }

  getSettings(): P2PSettings {
    return { ...this.settings, turn: { ...this.settings.turn }, media: { ...this.settings.media } };
  }

  getPeerId(): string {
    return this.peerId;
  }

  /** This device's protocol address ("user@domain") once identity
   *  is configured; null before sign-in / before a domain is known. */
  get selfAddress(): string | null {
    return this.identity?.address ?? null;
  }

  getOwnDomains(): string[] {
    return [...this.ownDomains];
  }

  /** True when P2P can run at all right now: master switch on AND
   *  identity configured AND WebRTC available in this environment. */
  get available(): boolean {
    return (
      this.settings.enabled &&
      this.identity !== null &&
      typeof RTCPeerConnection !== "undefined"
    );
  }

  /** Replace settings (the settings panel calls this). Turning the
   *  master switch off closes every connection at once; changing the
   *  TURN config recreates the manager (relay config is read at
   *  construction), which also drops connections — the panel says so.
   *  Turning media off ends every live call; turning it on attaches
   *  the call manager to the connections that already exist. */
  setSettings(next: P2PSettings): void {
    const turnChanged =
      JSON.stringify(next.turn) !== JSON.stringify(this.settings.turn);
    const wasEnabled = this.settings.enabled;
    const mediaWasEnabled = this.settings.media.enabled;
    this.settings = { ...next, turn: { ...next.turn }, media: { ...next.media } };
    void this.persist();
    if (this.manager) {
      if (turnChanged) {
        this.recreateManager();
      } else {
        this.manager.setSettings(this.settings);
      }
    }
    if (wasEnabled && !next.enabled) {
      this.stopTimers();
    } else if (!wasEnabled && next.enabled && this.identity) {
      this.maybeStart();
      void this.publishAd().catch(() => undefined);
    }
    if (this.callManager) {
      if (mediaWasEnabled && !next.media.enabled) {
        this.callManager.closeAll("media disabled");
        for (const peerId of [...this.adapters.keys()]) {
          this.callManager.detachConnection(peerId);
        }
      } else if (!mediaWasEnabled && next.media.enabled && this.manager) {
        for (const [peerId, peer] of this.manager.peers) {
          const connection = peer.connection;
          if (connection && connection.state === "connected") {
            this.callManager.attachConnection(connection);
          }
        }
      }
    }
  }

  /** New peer ID (rotation): drops every connection, republishes the
   *  ad under the new ID. Peers re-discover the new ad on next fetch. */
  async rotatePeerId(): Promise<string> {
    this.peerId = generatePeerId();
    await this.persist();
    this.recreateManager();
    if (this.settings.enabled && this.identity) {
      await this.publishAd().catch(() => undefined);
    }
    return this.peerId;
  }

  /** Full P2P reset: new peer ID + all flags off + connections
   *  dropped. The stored TURN apiKey is wiped too — a reset means
   *  "forget everything P2P knows about this device". */
  async resetPeerId(): Promise<string> {
    this.peerId = generatePeerId();
    this.settings = defaultP2PSettings();
    this.ownDomains = [];
    await this.persist();
    this.recreateManager();
    this.stopTimers();
    return this.peerId;
  }

  /** Record a claimed domain (the claim flow calls this): the peer ad
   *  is published to the first own domain and `serves` lists all of
   *  them. */
  async addOwnDomain(domain: string): Promise<void> {
    const d = domain.toLowerCase();
    if (!this.ownDomains.includes(d)) {
      this.ownDomains.push(d);
      await this.persist();
    }
    if (this.settings.enabled && this.identity) {
      await this.publishAd().catch(() => undefined);
    }
  }

  /** Configure (or re-configure) the identity after sign-in and
   *  mail-keypair creation. Creates the PeerManager on first call.
   *  Also creates the CallManager when the media stack exists on
   *  this device — in Node (no media devices) it stays null and
   *  mediaAvailable() is false, which the Calls panel reports
   *  honestly instead of pretending calls work. */
  configureIdentity(identity: P2PIdentity): void {
    this.identity = { ...identity };
    if (!this.manager) this.createManager();
    if (!this.callManager) {
      try {
        const devices = this.mediaDevicesOpt ?? browserMediaDevices();
        const mediaFactory = this.mediaFactoryOpt ?? new WebRtcMediaConnectionFactory();
        this.callManager = new CallManager({
          selfPeerId: this.peerId,
          selfAddress: identity.address,
          devices,
          mediaFactory,
          iceServers: this.mediaIceServers(),
          sendControl: (peerId, message) => {
            this.sendMediaControlTo(peerId, message);
          },
          onIncomingCall: (session) => {
            this.incomingCallHandler?.(session);
          },
          onUnhandledControl: (peerId, message) => {
            this.unhandledMediaHandler?.(peerId, message);
          },
          onSessionEvent: (session, event) => {
            this.sessionEventHandler?.(session, event);
          },
        });
      } catch {
        // No media stack here (Node, or a WebView without WebRTC):
        // calls are unavailable, everything else is unaffected.
        this.callManager = null;
      }
    }
    this.maybeStart();
  }

  // -- calls (media UI phase) -------------------------------------------

  /** The 1:1 call router, or null when calls cannot run here. */
  getCallManager(): CallManager | null {
    return this.callManager;
  }

  /** True when a call can be placed right now: identity configured,
   *  media stack present, master switch + media switch on. */
  mediaAvailable(): boolean {
    return (
      this.callManager !== null &&
      this.identity !== null &&
      this.settings.enabled &&
      this.settings.media.enabled
    );
  }

  /** ICE servers for media peer connections (same assembly as the
   *  data transport: STUN always, TURN when enabled). */
  mediaIceServers(): RTCIceServer[] {
    return assembleIceServers(this.getSettings(), this.ownTurnServers()).iceServers;
  }

  /** The Calls panel registers its ringing-call handler here (stored
   *  so it survives the CallManager being created after sign-in). */
  setIncomingCallHandler(
    handler: ((session: CallSession) => void) | null,
  ): void {
    this.incomingCallHandler = handler;
  }

  /** The group-call negotiator registers here: media control no 1:1
   *  session owns (group/mixer control, group media legs). */
  setUnhandledMediaHandler(
    handler: ((fromPeerId: string, message: MediaControlMessage) => void) | null,
  ): void {
    this.unhandledMediaHandler = handler;
  }

  /** The Calls panel registers here: every event of every 1:1
   *  session, with the session attached (state, remote tracks,
   *  consent, recording activity). */
  setSessionEventHandler(
    handler: ((session: CallSession, event: CallEvent) => void) | null,
  ): void {
    this.sessionEventHandler = handler;
  }

  /** Send one media control message to a connected peer (over the
   *  `arknetz/media` channel of its data connection). False when
   *  there is no connection to that peer — the caller falls back
   *  (a call to an offline peer is not a call). */
  sendMediaControlTo(peerId: string, message: MediaControlMessage): boolean {
    const connection = this.manager?.connectionFor(peerId);
    if (!connection) return false;
    try {
      const channel = connection.createChannel(MEDIA_CHANNEL_LABEL);
      channel.send(encodeMediaControl(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Broadcast one media control message to every connected peer
   *  (group/mixer control). Returns how many peers received it. */
  broadcastMediaControl(message: MediaControlMessage): number {
    if (!this.manager) return 0;
    let sent = 0;
    for (const peerId of [...this.manager.peers.keys()]) {
      if (this.sendMediaControlTo(peerId, message)) sent++;
    }
    return sent;
  }

  /** Create (but do not start) a 1:1 call session to a connected
   *  peer. Null when calls are off or the peer is not connected —
   *  the caller then reports the peer unreachable. The caller
   *  awaits `session.start()`. */
  startCallSession(
    peerId: string,
    address: string,
    kind: CallKind,
  ): CallSession | null {
    if (!this.callManager || !this.mediaAvailable()) return null;
    if (!this.manager?.isConnected(peerId)) return null;
    return this.callManager.startCall(peerId, address, kind);
  }

  /** The mail envelope handler: the shell sets this when a mail
   *  keypair exists — inbound P2P envelopes are handed to the normal
   *  inbox path (openInbox(keypair).receive). Until it is set, the
   *  mail adapter is not attached, so no envelope is ever acked and
   *  then lost. */
  setMailEnvelopeHandler(
    handler: ((envelope: EncryptedMailEnvelope) => Promise<void>) | null,
  ): void {
    this.mailEnvelopeHandler = handler;
    // Attach/detach the mail adapter on live connections to match.
    for (const [peerId, ad] of this.adapters) {
      const connection = this.manager?.connectionFor(peerId);
      if (!connection) continue;
      if (handler && !ad.mail) {
        ad.mail = this.createMailAdapter();
        ad.mail.attach(connection);
      } else if (!handler && ad.mail) {
        ad.mail.detach();
        ad.mail = null;
      }
    }
  }

  /** Where inbound drive chunks go: the shell sets this when a vault
   *  is open — the sink decrypts + verifies + stores the chunk in
   *  that vault. Until it is set, inbound chunks are refused (the
   *  DriveP2P adapter still checks knownVaultIds first). */
  setDriveChunkSink(
    sink: ((chunk: DriveChunkReceived) => Promise<void>) | null,
  ): void {
    this.driveChunkSink = sink;
  }

  setKnownVaultIds(ids: ReadonlySet<string>): void {
    this.knownVaultIds = new Set(ids);
  }

  /** Serve-side bundle lookup: the shell injects the reader's cache
   *  (a bundle already in IndexedDB). Null = serve nothing. Serving
   *  never fetches from the CDN on someone else's behalf. */
  setCachedBundleProvider(
    provider: ((domain: string) => Promise<Uint8Array | null>) | null,
  ): void {
    this.getCachedBundle = provider;
  }

  /** Start the background timers (signal poll, ad republish, silence
   *  check). No-op until the master switch is on and identity is
   *  configured. Safe to call repeatedly. */
  start(): void {
    this.started = true;
    this.maybeStart();
  }

  stop(): void {
    this.started = false;
    this.stopTimers();
  }

  private maybeStart(): void {
    if (!this.started && !this.autoStart) return;
    if (!this.settings.enabled || !this.identity) return;
    if (this.signalTimer) return;
    this.signalTimer = setInterval(() => {
      void this.pollSignalsOnce().catch(() => undefined);
    }, P2P_SIGNAL_POLL_MS);
    this.adTimer = setInterval(() => {
      void this.publishAd().catch(() => undefined);
    }, P2P_AD_REPUBLISH_MS);
    this.silenceTimer = setInterval(() => {
      this.manager?.checkSilence();
    }, P2P_SILENCE_CHECK_MS);
  }

  private stopTimers(): void {
    if (this.signalTimer !== null) clearInterval(this.signalTimer);
    if (this.adTimer !== null) clearInterval(this.adTimer);
    if (this.silenceTimer !== null) clearInterval(this.silenceTimer);
    this.signalTimer = null;
    this.adTimer = null;
    this.silenceTimer = null;
  }

  // -- contacts directory ----------------------------------------------

  /** Resolve one address to its contacts-directory entry (public key
   *  + GitHub login). Null = no entry published. Results are cached
   *  for the life of this host (contacts change rarely; a restart
   *  re-reads them). */
  async resolveContactEntry(address: MailAddress): Promise<ContactEntry | null> {
    const key = address.toLowerCase();
    if (this.contactCache.has(key)) return this.contactCache.get(key) ?? null;
    let entry: ContactEntry | null = null;
    try {
      const zstUrl = await contactsShardZstUrl(address as MailAddress);
      const zst = await this.rawFetch(zstUrl);
      if (zst.status === 200) {
        const bytes = new Uint8Array(await zst.arrayBuffer());
        const entries = parseContactsShard(await decompressJson(bytes));
        entry = entries.find((e) => e.address.toLowerCase() === key) ?? null;
      } else {
        const url = await contactsShardUrl(address as MailAddress);
        const res = await this.rawFetch(url);
        if (res.status === 200) {
          const entries = parseContactsShard(JSON.parse(await res.text()));
          entry = entries.find((e) => e.address.toLowerCase() === key) ?? null;
        }
      }
    } catch {
      entry = null;
    }
    this.contactCache.set(key, entry);
    return entry;
  }

  private async resolveContactPublicKey(address: MailAddress): Promise<JsonWebKey | null> {
    const entry = await this.resolveContactEntry(address);
    return entry?.publicKeyJwk ?? null;
  }

  /** Public contact lookup (the shell's send fallback seals with
   *  this): the contacts directory entry for an address, or null.
   *  Cached per address for the session. */
  async resolveContact(address: MailAddress): Promise<ContactEntry | null> {
    return this.resolveContactEntry(address);
  }

  // -- peer discovery + connection --------------------------------------

  /** Fetch a peer's ad for an address: resolve the domain through
   *  the registry, fetch peer-ad.json from that site repo, validate
   *  it (domain + owner pinned to the repo) and check the ad's
   *  address matches. Null on any failure — the caller falls back to
   *  GitHub. Note the honest limit: a peer whose mail domain they do
   *  not own has no site repo of their own to host an ad in, so they
   *  cannot be discovered this way yet (see INTEGRATION.md). */
  async fetchAdForAddress(address: MailAddress): Promise<PeerAd | null> {
    const parts = address.split("@");
    if (parts.length !== 2) return null;
    const domain = parts[1] as string;
    let owner: string;
    const contact = await this.resolveContactEntry(address);
    if (contact?.githubUser) {
      owner = contact.githubUser;
    } else {
      try {
        owner = (await this.resolveRegistryEntry(domain)).owner;
      } catch {
        return null;
      }
    }
    let ad: PeerAd | null;
    try {
      ad = await this.signaling.fetchAd(owner, domain);
    } catch {
      return null;
    }
    if (!ad || ad.address.toLowerCase() !== address.toLowerCase()) return null;
    return ad;
  }

  /** Connect to a peer by address (discovery + handshake + adapter
   *  attach). Null on any failure — never throws for a connection
   *  failure. */
  async connectToAddress(address: MailAddress): Promise<P2PConnection | null> {
    if (!this.settings.enabled || !this.identity) return null;
    const ad = await this.fetchAdForAddress(address);
    if (!ad) return null;
    return this.connectToAd(ad);
  }

  /** Connect to a peer whose ad is already known. */
  async connectToAd(ad: PeerAd): Promise<P2PConnection | null> {
    if (!this.settings.enabled || !this.identity || !this.manager) return null;
    if (this.manager.isConnected(ad.peerId)) {
      return this.manager.connectionFor(ad.peerId);
    }
    let ok = false;
    try {
      ok = await this.manager.connectToPeer(ad);
    } catch {
      ok = false;
    }
    if (!ok) return null;
    const connection = this.manager.connectionFor(ad.peerId);
    if (!connection) return null;
    this.attachAdapters(ad.peerId, ad, connection);
    return connection;
  }

  private ownTurnServers(): RTCIceServer[] {
    // Per-user TURN: only "custom" yields a static entry today.
    // Metered/Cloudflare keys are exchanged for short-lived
    // credentials via their APIs (phase-2 wiring point in ice.ts);
    // a bare API key is never fabricated into a TURN entry.
    if (this.settings.turn.provider === "custom" && this.settings.turn.urls.length > 0) {
      return [{ urls: [...this.settings.turn.urls] }];
    }
    return [];
  }

  private createManager(): void {
    if (!this.identity) return;
    const identity = this.identity;
    this.manager = new PeerManager({
      settings: this.getSettings(),
      selfPeerId: this.peerId,
      selfAddress: identity.address,
      factory: this.factory,
      ownTurnServers: this.ownTurnServers(),
      now: this.now,
      onEvent: (event) => {
        if (event.type === "peer-connected") {
          const peer = this.manager?.peers.get(event.peerId);
          const connection = this.manager?.connectionFor(event.peerId);
          if (peer && connection) this.attachAdapters(event.peerId, peer.ad, connection);
        } else if (event.type === "peer-disconnected") {
          // Drop the adapters AND the call router for the dead
          // connection — a stale CallManager entry would keep
          // routing invites at a peer that is gone.
          this.detachAdapters(event.peerId);
          this.callManager?.detachConnection(event.peerId);
        }
        this.onEvent?.(event);
      },
      sendSignal: async (message: SignalMessage) => {
        await this.sendSignal(message);
      },
    });
  }

  private recreateManager(): void {
    if (this.manager) {
      for (const peerId of [...this.adapters.keys()]) {
        this.manager.disconnect(peerId, "P2P settings changed");
      }
      this.adapters.clear();
      // Calls end with the connections (peer ID rotated or TURN
      // changed): end the sessions first, then detach the router.
      this.callManager?.closeAll("p2p reset");
      for (const peerId of [...this.manager.peers.keys()]) {
        this.callManager?.detachConnection(peerId);
      }
    }
    this.manager = null;
    if (this.identity) this.createManager();
  }

  /** Seal + post one signal toward its peer, via the recipient's
   *  inbox. The recipient's GitHub login comes from their contacts
   *  entry (or the registry for their domain). Throws when the
   *  recipient cannot be signaled — the manager treats that as a
   *  handshake failure and the feature falls back to GitHub. */
  private async sendSignal(message: SignalMessage): Promise<void> {
    const identity = this.identity;
    if (!identity) throw new Error("P2P identity is not configured");
    const peer = this.manager?.peers.get(message.toPeerId);
    const address = peer?.ad.address as MailAddress | undefined;
    if (!address) throw new Error(`cannot signal unknown peer ${message.toPeerId}`);
    const contact = await this.resolveContactEntry(address);
    const githubUser =
      contact?.githubUser ??
      (await this.resolveRegistryEntry((address.split("@")[1] as string))).owner;
    await this.signaling.sendSignal(message, address, githubUser, identity.token);
  }

  private myAd(): PeerAd | null {
    if (!this.identity || this.ownDomains.length === 0) return null;
    const capabilities: PeerAd["capabilities"] = [];
    if (this.settings.sites) capabilities.push("site");
    if (this.settings.collab) capabilities.push("collab");
    if (this.settings.mail) capabilities.push("mail");
    if (this.settings.drive) capabilities.push("drive");
    const turnUrls =
      this.settings.turn.provider === "custom" ? [...this.settings.turn.urls] : undefined;
    return buildPeerAd({
      peerId: this.peerId,
      address: this.identity.address,
      domain: this.ownDomains[0] as string,
      owner: this.identity.githubLogin,
      capabilities,
      serves: [...this.ownDomains],
      turnUrls,
      now: this.now(),
    });
  }

  /** Publish (or republish) my peer ad to my first own domain's site
   *  repo. False when there is nothing to publish (P2P off, no
   *  identity, or no claimed domain) — the host still works as a
   *  client in that case. */
  async publishAd(): Promise<boolean> {
    const identity = this.identity;
    const ad = this.myAd();
    if (!identity || !ad) return false;
    try {
      await this.signaling.publishAd(ad, identity.githubLogin, ad.domain, identity.token);
      return true;
    } catch {
      return false;
    }
  }

  /** Poll my inbox for sealed signal Issues, route each one to the
   *  peer manager, close the ones that were processed. This is the
   *  inbox poller's P2P half: the mail panel's render path and the
   *  30 s timer both call it. Returns counts; never throws for a
   *  poll failure (the next poll retries). */
  async pollSignalsOnce(): Promise<{ polled: number; skipped: number }> {
    const identity = this.identity;
    if (!identity || !this.settings.enabled || !this.manager) return { polled: 0, skipped: 0 };
    let pulled;
    try {
      pulled = await this.signaling.pollSignals(
        identity.githubLogin,
        identity.token,
        identity.address,
        identity.privateKey,
      );
    } catch {
      return { polled: 0, skipped: 0 };
    }
    let processed = 0;
    for (const item of pulled.pulled) {
      if (!item.signal) continue;
      await this.manager.handleSignal(item.signal);
      processed++;
      try {
        await this.signaling.closeSignal(
          identity.githubLogin,
          item.issueNumber,
          identity.token,
        );
      } catch {
        // A close failure leaves the Issue open; the next poll
        // re-processes it (signalIds dedupe in the manager).
      }
    }
    return { polled: processed, skipped: pulled.skipped };
  }

  // -- adapters -----------------------------------------------------------

  private createMailAdapter(): MailP2P {
    return new MailP2P({
      onEnvelope: (envelope) => {
        if (this.mailEnvelopeHandler) {
          void this.mailEnvelopeHandler(envelope).catch(() => undefined);
        }
      },
      onDrop: () => undefined,
    });
  }

  private attachAdapters(peerId: string, ad: PeerAd, connection: P2PConnection): void {
    if (this.adapters.has(peerId)) return;
    const site = new SiteSharing({
      selfAd: this.myAd(),
      serveSites: this.settings.serveSites,
      getCachedBundle: this.getCachedBundle ?? undefined,
    });
    site.attach(connection);
    const drive = new DriveP2P(new Set(this.knownVaultIds), {
      onChunk: (chunk) => {
        if (this.driveChunkSink) {
          void this.driveChunkSink(chunk).catch(() => undefined);
        }
      },
      onDrop: () => undefined,
    });
    drive.attach(connection);
    const adapters: PeerAdapters = {
      site,
      mail: null,
      drive,
    };
    if (this.mailEnvelopeHandler) {
      adapters.mail = this.createMailAdapter();
      adapters.mail.attach(connection);
    }
    this.adapters.set(peerId, adapters);
    // Calls ride the same connection: attach the call router when
    // media is on (it opens the arknetz/media channel). When media
    // is off the channel is never opened — no invite can arrive.
    if (
      this.callManager &&
      this.settings.enabled &&
      this.settings.media.enabled
    ) {
      this.callManager.attachConnection(connection);
    }
  }

  private detachAdapters(peerId: string): void {
    const adapters = this.adapters.get(peerId);
    if (!adapters) return;
    adapters.site.detach();
    adapters.mail?.detach();
    adapters.drive.detach();
    this.adapters.delete(peerId);
  }

  /** Connected peers, for the settings panel / diagnostics. */
  async connectedPeers(): Promise<P2PPeerInfo[]> {
    if (!this.manager) return [];
    const out: P2PPeerInfo[] = [];
    for (const [peerId, peer] of this.manager.peers) {
      const connection = peer.connection;
      if (!connection || connection.state !== "connected") continue;
      let diagnostics: IceDiagnostics | null = null;
      const maybeDiagnostics = (
        connection as unknown as { diagnostics?: () => Promise<IceDiagnostics> }
      ).diagnostics;
      if (typeof maybeDiagnostics === "function") {
        try {
          diagnostics = await maybeDiagnostics.call(connection);
        } catch {
          diagnostics = describeIcePath({});
        }
      } else if (connection.state === "connected") {
        diagnostics = loopbackDiagnostics();
      }
      out.push({
        peerId,
        address: peer.ad.address,
        capabilities: [...peer.ad.capabilities],
        connected: true,
        diagnostics,
      });
    }
    return out;
  }

  /** The ICE servers in effect right now (for the settings panel's
   *  "what is active" list). */
  iceServersInEffect(): ReturnType<typeof assembleIceServers> {
    return assembleIceServers(this.getSettings(), this.ownTurnServers());
  }

  // -- site reader ---------------------------------------------------------

  /** Try a peer first, then the CDN. Returns the parsed site document
   *  or null when P2P could not serve it — the caller then loads from
   *  the CDN exactly as before. Never throws for a P2P failure. */
  async loadSiteViaPeer(
    domain: string,
    resolveEntry: (domain: string) => Promise<RegistryEntry>,
  ): Promise<SiteDocument | null> {
    if (!this.settings.enabled || !this.settings.sites || !this.identity) return null;
    let entry: RegistryEntry;
    try {
      entry = await resolveEntry(domain);
    } catch {
      return null;
    }
    let ad: PeerAd | null;
    try {
      ad = await this.signaling.fetchAd(entry.owner, domain);
    } catch {
      return null;
    }
    if (!ad || !ad.capabilities.includes("site") || !ad.serves.includes(domain.toLowerCase())) {
      return null;
    }
    const connection = await this.connectToAd(ad);
    if (!connection) return null;
    const adapters = this.adapters.get(ad.peerId);
    if (!adapters) return null;
    let result;
    try {
      result = await adapters.site.fetchFromPeer(domain);
    } catch {
      return null;
    }
    if (!result) return null;
    try {
      return parseSiteDocument(await decompressJson(result.bytes));
    } catch {
      return null;
    }
  }

  // -- mail ----------------------------------------------------------------

  /** Deliver one sealed envelope: P2P first when the recipient is an
   *  online peer with the mail capability, otherwise the Issue inbox.
   *  Returns which path carried it. */
  async deliverMail(
    envelope: EncryptedMailEnvelope,
    recipientAddress: MailAddress,
  ): Promise<{ via: "p2p" | "github"; issueNumber?: number }> {
    const identity = this.identity;
    if (!identity) throw new Error("P2P mail needs a signed-in identity");
    const contact = await this.resolveContactEntry(recipientAddress);
    const githubUser =
      contact?.githubUser ??
      (await this.resolveRegistryEntry(recipientAddress.split("@")[1] as string)).owner;
    if (this.settings.enabled && this.settings.mail) {
      const connection = await this.connectToAddress(recipientAddress);
      if (connection) {
        const peerId = [...this.adapters.keys()].find(
          (id) => this.manager?.connectionFor(id) === connection,
        );
        const adapters = peerId ? this.adapters.get(peerId) : undefined;
        if (adapters?.mail) {
          const ok = await adapters.mail.deliver(envelope).catch(() => false);
          if (ok) return { via: "p2p" };
        }
      }
    }
    const issueNumber = await this.mailDelivery.deliver(envelope, githubUser, identity.token);
    return { via: "github", issueNumber };
  }

  /** Seal a validated draft and deliver it to every recipient: P2P
   *  where the recipient is online, Issue inbox otherwise. The
   *  envelope is sealed once (same bytes to every path). */
  async sendDraft(draft: MailDraft, keypair: MailKeypair): Promise<P2PMailSendResult> {
    const envelope = await buildMailFromDraft(draft, keypair, (address) =>
      this.resolveContactEntry(address).then((e) => e ?? undefined),
    );
    const result: P2PMailSendResult = { p2p: [], github: [], issueNumbers: [] };
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
    for (const address of recipients) {
      const delivered = await this.deliverMail(envelope, address);
      if (delivered.via === "p2p") result.p2p.push(address);
      else {
        result.github.push(address);
        if (delivered.issueNumber !== undefined) result.issueNumbers.push(delivered.issueNumber);
      }
    }
    return result;
  }

  // -- drive ---------------------------------------------------------------

  /** Push one stored chunk to every connected own-device peer with
   *  the drive capability (same GitHub login as me — my phone,
   *  my laptop). Returns how many peers acked. The repo blobs stay
   *  the durable copy: a failed push changes nothing. */
  async pushDriveChunk(
    vaultId: string,
    blobId: string,
    storedBytes: Uint8Array,
  ): Promise<number> {
    if (!this.settings.enabled || !this.settings.drive || !this.identity || !this.manager) {
      return 0;
    }
    let acked = 0;
    for (const [peerId, peer] of this.manager.peers) {
      if (peer.ad.owner !== this.identity.githubLogin) continue;
      if (!peer.ad.capabilities.includes("drive")) continue;
      if (peer.connection?.state !== "connected") continue;
      const adapters = this.adapters.get(peerId);
      if (!adapters) continue;
      const ok = await adapters.drive.sendChunk(vaultId, blobId, storedBytes).catch(() => false);
      if (ok) acked++;
    }
    return acked;
  }

  // -- collab hook -----------------------------------------------------------

  /** Build the collab hook for one session (one site). The editor
   *  passes it to CollabSession; the session calls start() on join,
   *  notePresence() as peers appear, and stop() on leave. */
  createCollabHook(domain: string): CollabP2PHook {
    const sessions = new Map<string, P2PCollabSession>();
    let sessionId = "";
    let teamLogins = new Set<string>();
    let events: CollabP2PHookEvents | null = null;
    let connectedCount = 0;

    const attachForPeer = async (peerId: string): Promise<void> => {
      const connection = this.manager?.connectionFor(peerId);
      if (!connection || sessions.has(peerId)) return;
      const session = new P2PCollabSession(sessionId, this.identity?.githubLogin ?? "", teamLogins, {
        // Remote ops/cursors flow straight into the editor session's
        // own apply path (via the events the session passed to
        // start()) — the hook never applies them itself.
        onOps: (ops) => events?.onOps(ops),
        onCursor: (login, cursor) => events?.onCursor(login, cursor),
        onDrop: () => {
          sessions.delete(peerId);
          connectedCount = Math.max(0, connectedCount - 1);
          if (connectedCount === 0) events?.onDropped();
        },
      });
      session.attach(connection);
      sessions.set(peerId, session);
      connectedCount++;
      events?.onConnected();
    };

    return {
      start: async (id, _domain, ev) => {
        sessionId = id;
        events = ev;
      },
      notePresence: (logins) => {
        for (const login of logins) {
          if (login === this.identity?.githubLogin) continue;
          teamLogins.add(login);
          // Connect lazily, in the background: a failed connect is
          // not an error — the relay poll carries these peers.
          void (async () => {
            if (!this.settings.enabled || !this.settings.collab) return;
            const address = `${login}@${domain}` as MailAddress;
            const connection = await this.connectToAddress(address);
            if (!connection) return;
            const peerId = [...this.adapters.keys()].find(
              (pid) => this.manager?.connectionFor(pid) === connection,
            );
            if (peerId) await attachForPeer(peerId);
          })().catch(() => undefined);
        }
      },
      sendOps: (ops: BlockOp[]) => {
        for (const session of sessions.values()) session.sendOps(ops);
      },
      sendCursor: (cursor: CursorPosition | null) => {
        for (const session of sessions.values()) session.sendCursor(cursor);
      },
      stop: () => {
        for (const session of sessions.values()) session.detach("left");
        sessions.clear();
        connectedCount = 0;
        events = null;
      },
    };
  }
}
