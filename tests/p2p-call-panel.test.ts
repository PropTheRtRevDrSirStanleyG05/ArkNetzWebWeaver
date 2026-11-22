// Tests: media UI wiring — the Calls panel controller (1:1 + group
// calls over loopback pairs), the renderer (pure), the mount (fake
// DOM), the P2P settings media section, and the app/host integration.
// No real WebRTC, no real GitHub: loopback data pairs, fake media
// pairs, and mock fetches throughout. Real two-device WebRTC is
// still unverified by these tests — see INTEGRATION.md.
import test from "node:test";
import assert from "node:assert/strict";
import { createArkNetzApp } from "../src/lib/app.js";
import { renderPanelHtml } from "../src/lib/panels.js";
import { createPanelState } from "../src/lib/panels.js";
import { defaultP2PSettings, defaultMediaSettings } from "../src/lib/p2p/types.js";
import type { P2PSettings } from "../src/lib/p2p/types.js";
import { createMemoryP2PStore, normalizeP2PSettings } from "../src/lib/p2p/store.js";
import { P2PHost } from "../src/lib/p2p/host.js";
import type { P2PPeerInfo } from "../src/lib/p2p/host.js";
import { mountP2PPanel, renderP2PPanelHtml } from "../src/lib/p2p/panel.js";
import type { P2PPanelDeps } from "../src/lib/p2p/panel.js";
import {
  CALLS_MIXER_TRUST_COPY,
  CALLS_NO_PEERS_COPY,
  CALLS_NO_WEBRTC_COPY,
  CALLS_NO_VOLUNTEER_COPY,
  CALLS_OFF_COPY,
  CALLS_ONE_AT_A_TIME_COPY,
  MediaCallController,
  mountCallsPanel,
  renderCallsPanelHtml,
  type CallsHost,
  type CallsViewModel,
} from "../src/lib/p2p/call-panel.js";
import {
  CALL_NO_RELAY_NOTE,
  CALL_RELAYED_NOTE,
  MIXER_VOLUNTEER_NOTE,
  SCREEN_SHARE_ANDROID_NOTE,
  encodeMediaControl,
  MEDIA_CHANNEL_LABEL,
  type CallKind,
  type MediaControlMessage,
} from "../src/lib/p2p/media.js";
import {
  CallManager,
  type CallEvent,
  type CallSession,
  type RecorderFactory,
  type RecorderLike,
} from "../src/lib/p2p/call-session.js";
import {
  FakeMediaConnection,
  type MediaConnection,
  type MediaConnectionFactory,
} from "../src/lib/p2p/media-connection.js";
import { FakeMediaDevices } from "../src/lib/p2p/media-devices.js";
import { LoopbackConnectionFactory } from "../src/lib/p2p/transport.js";
import type { P2PConnection } from "../src/lib/p2p/transport.js";
import { generateMailKeypair } from "../src/lib/mail/crypto.js";
import type { MailAddress } from "../src/lib/mail/types.js";

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await flush(10);
  }
  assert.ok(fn(), "condition not met in time");
}

const throwingFetch = (() => {
  throw new Error("no network in tests");
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Pairing media factory (same pattern as p2p-call-session.test.ts):
// when A creates a connection to B and B creates one to A, they
// become twins — the fake equivalent of ICE connecting them.
// ---------------------------------------------------------------------------

class PairingHub {
  private readonly pending = new Map<string, FakeMediaConnection>();
  create(selfPeerId: string, remotePeerId: string): FakeMediaConnection {
    const conn = new FakeMediaConnection(remotePeerId);
    const reverseKey = `${remotePeerId}->${selfPeerId}`;
    const twin = this.pending.get(reverseKey);
    if (twin) {
      this.pending.delete(reverseKey);
      conn.pairWith(twin);
    } else {
      this.pending.set(`${selfPeerId}->${remotePeerId}`, conn);
    }
    return conn;
  }
}

class PairingMediaFactory implements MediaConnectionFactory {
  constructor(
    private readonly selfPeerId: string,
    private readonly hub: PairingHub,
  ) {}
  createConnection(peerId: string, _config: RTCConfiguration): MediaConnection {
    return this.hub.create(this.selfPeerId, peerId);
  }
}

// ---------------------------------------------------------------------------
// Fake recorder (MediaRecorder does not exist in Node).
// ---------------------------------------------------------------------------

class FakeRecorder implements RecorderLike {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state: "inactive" | "recording" | "paused" = "inactive";
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
    this.state = "recording";
    this.ondataavailable?.({ data: new Blob(["fake-frame"]) });
  }
  stop(): void {
    this.stopped = true;
    this.state = "inactive";
    this.onstop?.();
  }
}

function fakeRecorderFactory(): RecorderFactory {
  return (_stream: MediaStream) => new FakeRecorder();
}

// ---------------------------------------------------------------------------
// Fake CallsHost: a real CallManager over loopback data connections,
// with the settings/peer list the controller reads.
// ---------------------------------------------------------------------------

function mediaOnSettings(overrides: Partial<P2PSettings["media"]> = {}): P2PSettings {
  const s = defaultP2PSettings();
  s.enabled = true;
  s.media = {
    ...defaultMediaSettings(),
    enabled: true,
    voice: true,
    video: true,
    groups: true,
    screenShare: true,
    volunteerMixer: false,
    ...overrides,
  };
  return s;
}

class FakeCallsHost implements CallsHost {
  readonly peerId: string;
  readonly devices = new FakeMediaDevices();
  readonly mediaFactory: PairingMediaFactory;
  readonly manager: CallManager;
  settings: P2PSettings;
  peers: P2PPeerInfo[] = [];
  connectToAddressResult: P2PConnection | null = null;
  private readonly connections = new Map<string, P2PConnection>();
  private incomingHandler: ((session: CallSession) => void) | null = null;
  private unhandledHandler: ((fromPeerId: string, message: MediaControlMessage) => void) | null = null;
  private sessionEventHandler: ((session: CallSession, event: CallEvent) => void) | null = null;

  constructor(selfPeerId: string, hub: PairingHub, settings?: P2PSettings) {
    this.peerId = selfPeerId;
    this.settings = settings ?? mediaOnSettings();
    this.mediaFactory = new PairingMediaFactory(selfPeerId, hub);
    this.manager = new CallManager({
      selfPeerId,
      selfAddress: `${selfPeerId}@example.arknetz`,
      devices: this.devices,
      mediaFactory: this.mediaFactory,
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      sendControl: (peerId, message) => {
        this.sendMediaControlTo(peerId, message);
      },
      onIncomingCall: (session) => {
        this.incomingHandler?.(session);
      },
      onUnhandledControl: (peerId, message) => {
        this.unhandledHandler?.(peerId, message);
      },
      onSessionEvent: (session, event) => {
        this.sessionEventHandler?.(session, event);
      },
    });
  }

  getCallManager(): CallManager | null {
    return this.manager;
  }
  getSettings(): P2PSettings {
    return {
      ...this.settings,
      turn: { ...this.settings.turn, urls: [...this.settings.turn.urls] },
      media: { ...this.settings.media },
    };
  }
  getPeerId(): string {
    return this.peerId;
  }
  get selfAddress(): string | null {
    return `${this.peerId}@example.arknetz`;
  }
  mediaAvailable(): boolean {
    return this.settings.enabled && this.settings.media.enabled;
  }
  mediaIceServers(): RTCIceServer[] {
    return [{ urls: "stun:stun.l.google.com:19302" }];
  }
  async connectedPeers(): Promise<P2PPeerInfo[]> {
    return [...this.peers];
  }
  async connectToAddress(_address: MailAddress): Promise<P2PConnection | null> {
    return this.connectToAddressResult;
  }
  startCallSession(peerId: string, address: string, kind: CallKind): CallSession | null {
    return this.manager.startCall(peerId, address, kind);
  }
  attachDataConnection(peerId: string, connection: P2PConnection): void {
    this.connections.set(peerId, connection);
    this.manager.attachConnection(connection);
  }
  sendMediaControlTo(peerId: string, message: MediaControlMessage): boolean {
    const connection = this.connections.get(peerId);
    if (!connection) return false;
    try {
      connection.createChannel(MEDIA_CHANNEL_LABEL).send(encodeMediaControl(message));
      return true;
    } catch {
      return false;
    }
  }
  broadcastMediaControl(message: MediaControlMessage): number {
    let sent = 0;
    for (const peerId of [...this.connections.keys()]) {
      if (this.sendMediaControlTo(peerId, message)) sent++;
    }
    return sent;
  }
  setIncomingCallHandler(fn: ((session: CallSession) => void) | null): void {
    this.incomingHandler = fn;
  }
  setUnhandledMediaHandler(
    fn: ((fromPeerId: string, message: MediaControlMessage) => void) | null,
  ): void {
    this.unhandledHandler = fn;
  }
  setSessionEventHandler(fn: ((session: CallSession, event: CallEvent) => void) | null): void {
    this.sessionEventHandler = fn;
  }
}

interface CallPeer {
  host: FakeCallsHost;
  controller: MediaCallController;
  downloads: string[];
}

function makeCallPeer(
  selfPeerId: string,
  hub: PairingHub,
  opts: { settings?: P2PSettings; userAgent?: string } = {},
): CallPeer {
  const host = new FakeCallsHost(selfPeerId, hub, opts.settings);
  const downloads: string[] = [];
  const controller = new MediaCallController({
    host,
    devices: host.devices,
    mediaFactory: host.mediaFactory,
    userAgent: opts.userAgent ?? "TestAgent/1.0",
    download: (_blob, filename) => {
      downloads.push(filename);
    },
    recorderFactory: fakeRecorderFactory(),
  });
  return { host, controller, downloads };
}

/** Two peers with a loopback data pair between them. */
function makePair(opts: { settingsA?: P2PSettings; settingsB?: P2PSettings } = {}): {
  a: CallPeer;
  b: CallPeer;
} {
  const hub = new PairingHub();
  const dataFactory = new LoopbackConnectionFactory();
  const [connA, connB] = dataFactory.createPair("peer-b", "peer-a");
  const a = makeCallPeer("peer-a", hub, { settings: opts.settingsA });
  const b = makeCallPeer("peer-b", hub, { settings: opts.settingsB });
  a.host.attachDataConnection("peer-b", connA);
  b.host.attachDataConnection("peer-a", connB);
  a.host.peers = [
    { peerId: "peer-b", address: "peer-b@example.arknetz", capabilities: [], connected: true, diagnostics: null },
  ];
  b.host.peers = [
    { peerId: "peer-a", address: "peer-a@example.arknetz", capabilities: [], connected: true, diagnostics: null },
  ];
  return { a, b };
}

/** N peers, every pair connected by a loopback data pair. */
function makeMesh(peerIds: string[], settingsFor?: (id: string) => P2PSettings): CallPeer[] {
  const hub = new PairingHub();
  const dataFactory = new LoopbackConnectionFactory();
  const peers = peerIds.map((id) =>
    makeCallPeer(id, hub, { settings: settingsFor?.(id) }),
  );
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) {
      const pi = peers[i]!;
      const pj = peers[j]!;
      const [connI, connJ] = dataFactory.createPair(pj.host.peerId, pi.host.peerId);
      pi.host.attachDataConnection(pj.host.peerId, connI);
      pj.host.attachDataConnection(pi.host.peerId, connJ);
      pi.host.peers.push({
        peerId: pj.host.peerId,
        address: `${pj.host.peerId}@example.arknetz`,
        capabilities: [],
        connected: true,
        diagnostics: null,
      });
      pj.host.peers.push({
        peerId: pi.host.peerId,
        address: `${pi.host.peerId}@example.arknetz`,
        capabilities: [],
        connected: true,
        diagnostics: null,
      });
    }
  }
  return peers;
}

async function endAll(peers: CallPeer[]): Promise<void> {
  for (const peer of peers) {
    peer.controller.endCall();
    peer.controller.leaveGroupCall();
  }
  await flush();
}

// ---------------------------------------------------------------------------
// Media settings: defaults, normalization, store round-trip.
// ---------------------------------------------------------------------------

test("call-panel: media settings default all off", () => {
  const media = defaultMediaSettings();
  assert.equal(media.enabled, false);
  assert.equal(media.voice, false);
  assert.equal(media.video, false);
  assert.equal(media.groups, false);
  assert.equal(media.screenShare, false);
  assert.equal(media.volunteerMixer, false);
  assert.equal(defaultP2PSettings().media.enabled, false);
});

test("call-panel: normalizeP2PSettings merges media booleans, old shapes default off", () => {
  const merged = normalizeP2PSettings({
    enabled: true,
    media: { enabled: true, voice: true },
  } as never);
  assert.equal(merged.media.enabled, true);
  assert.equal(merged.media.voice, true);
  assert.equal(merged.media.video, false);
  assert.equal(merged.media.groups, false);
  assert.equal(merged.media.volunteerMixer, false);
  const legacy = normalizeP2PSettings({ enabled: true } as never);
  assert.equal(legacy.media.enabled, false);
  assert.equal(legacy.media.volunteerMixer, false);
});

test("call-panel: memory store round-trips the media block", async () => {
  const store = createMemoryP2PStore();
  const settings = mediaOnSettings({ volunteerMixer: true });
  await store.set({ settings, peerId: "peer-a", ownDomains: [] });
  const back = await store.get();
  assert.equal(back.settings.media.enabled, true);
  assert.equal(back.settings.media.volunteerMixer, true);
});

// ---------------------------------------------------------------------------
// P2P settings panel: media section.
// ---------------------------------------------------------------------------

function p2pPanelDeps(overrides: Partial<P2PPanelDeps> = {}): P2PPanelDeps {
  return {
    settings: defaultP2PSettings(),
    peerId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    selfAddress: "alice@example.arknetz",
    connectedPeers: [],
    iceServersInEffect: ["STUN — Google"],
    ...overrides,
  };
}

test("call-panel: P2P panel renders the media section off by default, with the trust + relay notes", () => {
  const html = renderP2PPanelHtml(p2pPanelDeps());
  for (const id of [
    "an-p2p-toggle-media",
    "an-p2p-toggle-media-voice",
    "an-p2p-toggle-media-video",
    "an-p2p-toggle-media-groups",
    "an-p2p-toggle-media-screen",
    "an-p2p-toggle-media-mixer",
  ]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes(MIXER_VOLUNTEER_NOTE));
  assert.ok(html.includes(CALL_RELAYED_NOTE));
  assert.ok(html.includes(CALL_NO_RELAY_NOTE));
  assert.match(html, /Calls \(real-time media\)/);
});

test("call-panel: P2P panel media toggles persist (master + media on)", async () => {
  const seen: P2PSettings[] = [];
  const root = new FakePanelRoot();
  const deps = p2pPanelDeps({
    settings: mediaOnSettings({ volunteerMixer: false }),
    onSettingsChange: (next) => {
      seen.push(next);
    },
  });
  mountP2PPanel(root as unknown as HTMLElement, deps);
  const mixerBtn = root.querySelector("#an-p2p-toggle-media-mixer");
  assert.ok(mixerBtn, "mixer toggle present");
  mixerBtn!.click();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.media.volunteerMixer, true);
  assert.equal(seen[0]!.media.enabled, true);
  // The toggle re-rendered in place with the new state.
  assert.match(root.innerHTML, /Turn off volunteer as a group-call mixer/);
});

// ---------------------------------------------------------------------------
// Tiny fake DOM for the panel mount tests (extended from
// p2p-phase2.test.ts): the Calls mount needs querySelectorAll with
// attribute selectors, tag names, and input/change events.
// ---------------------------------------------------------------------------

class FakePanelEl {
  readonly tagName: string;
  readonly id: string;
  readonly attrs = new Map<string, string>();
  disabled = false;
  checked = false;
  value = "";
  textContent = "";
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string, attrText: string, label = "") {
    this.tagName = tagName.toUpperCase();
    for (const m of attrText.matchAll(/([\w-]+)="([^"]*)"/g)) {
      this.attrs.set(m[1] as string, m[2] as string);
    }
    this.id = this.attrs.get("id") ?? "";
    if (/\bdisabled\b/.test(attrText)) this.disabled = true;
    if (/\bchecked\b/.test(attrText)) this.checked = true;
    this.value = this.attrs.get("value") ?? "";
    this.textContent = label;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
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

  fireInput(): void {
    for (const fn of this.listeners.get("input") ?? []) fn();
  }
}

class FakePanelRoot {
  #html = "";
  #els: FakePanelEl[] = [];

  get innerHTML(): string {
    return this.#html;
  }

  set innerHTML(v: string) {
    this.#html = v;
    this.#els = [];
    for (const m of v.matchAll(/<(\w+)((?:\s+[\w-]+="[^"]*")*)\s*\/?>/g)) {
      const tag = m[1] as string;
      const attrText = m[2] ?? "";
      const start = m.index ?? 0;
      const tagEnd = v.indexOf(">", start);
      const label =
        tag === "button" ? (v.slice(tagEnd + 1).split("</button>")[0] ?? "") : "";
      this.#els.push(new FakePanelEl(tag, attrText, label));
    }
  }

  querySelector(selector: string): FakePanelEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakePanelEl[] {
    const sel = selector.trim();
    // #id
    if (sel.startsWith("#")) {
      const id = sel.slice(1);
      return this.#els.filter((el) => el.id === id);
    }
    // tag[attr="value"]:checked, [attr="value"], [attr], tag[attr]
    const m = /^(?:(\w+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?(?::checked)?$/.exec(sel);
    if (!m) return [];
    const [, tag, attr, val] = m as unknown as [string, string | undefined, string | undefined, string | undefined];
    const wantChecked = sel.endsWith(":checked");
    return this.#els.filter((el) => {
      if (tag && el.tagName !== tag.toUpperCase()) return false;
      if (attr) {
        const got = el.getAttribute(attr);
        if (got === null) return false;
        if (val !== undefined && got !== val) return false;
      }
      if (wantChecked && !el.checked) return false;
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Renderer (pure) — every state the panel can be in.
// ---------------------------------------------------------------------------

function baseVm(overrides: Partial<CallsViewModel> = {}): CallsViewModel {
  return {
    available: true,
    mediaOn: true,
    groupsOn: true,
    voiceOn: true,
    videoOn: true,
    screenShareOn: true,
    selfAddress: "alice@example.arknetz",
    peers: [],
    callAddressDraft: "",
    incoming: null,
    active: null,
    group: null,
    groupInvite: null,
    screenShareSupported: true,
    screenShareNote: null,
    lastError: null,
    ...overrides,
  };
}

test("call-panel: renderer with no identity says sign in, not 'no WebRTC'", () => {
  // A controller exists only where WebRTC exists (the panel
  // returns CALLS_NO_WEBRTC_COPY outright when there is no
  // controller), so available:false inside the renderer means
  // "no P2P identity yet" — a guest — not "no WebRTC". Headless
  // Chrome HAS WebRTC and still hit this branch in the
  // screenshot pass.
  const html = renderCallsPanelHtml(baseVm({ available: false }));
  assert.ok(html.includes("Sign in with GitHub"));
  assert.ok(!html.includes(CALLS_NO_WEBRTC_COPY));
});

test("call-panel: renderer reports calls-off and no-identity honestly", () => {
  assert.ok(renderCallsPanelHtml(baseVm({ mediaOn: false })).includes(CALLS_OFF_COPY));
  assert.ok(
    renderCallsPanelHtml(baseVm({ selfAddress: null })).includes("Sign in with GitHub"),
  );
});

test("call-panel: renderer idle state lists peers with call buttons + group boxes, or the no-peers note", () => {
  const withPeers = renderCallsPanelHtml(
    baseVm({
      peers: [
        { peerId: "peer-b", address: "bob@example.arknetz" },
        { peerId: "peer-c", address: "carol@example.arknetz" },
      ],
    }),
  );
  assert.match(withPeers, /bob@example\.arknetz/);
  assert.match(withPeers, /data-action="call-voice"/);
  assert.match(withPeers, /data-action="call-video"/);
  assert.match(withPeers, /name="group-peer"/);
  assert.match(withPeers, /data-action="start-group"/);
  assert.match(withPeers, /Call by address/);
  const noPeers = renderCallsPanelHtml(baseVm({ peers: [] }));
  assert.ok(noPeers.includes(CALLS_NO_PEERS_COPY));
});

test("call-panel: renderer ringing state shows accept/decline", () => {
  const html = renderCallsPanelHtml(
    baseVm({ incoming: { callId: "call-1", kind: "video", fromAddress: "bob@example.arknetz" } }),
  );
  assert.match(html, /Incoming video call/);
  assert.match(html, /bob@example\.arknetz/);
  assert.match(html, /data-action="accept-call"/);
  assert.match(html, /data-action="decline-call"/);
});

test("call-panel: renderer active call shows controls, diagnostics, relay note, and recording consent gating", () => {
  const html = renderCallsPanelHtml(
    baseVm({
      active: {
        callId: "call-1",
        kind: "video",
        peerAddress: "bob@example.arknetz",
        state: "connected",
        muted: false,
        videoEnabled: true,
        sharingScreen: false,
        remoteMuted: false,
        remoteVideoOn: true,
        remoteSharingScreen: false,
        qualityMode: "full",
        diagnostics: "Direct (host)",
        relayed: false,
        hasRemoteVideo: true,
        hasRemoteAudio: true,
        hasLocalVideo: true,
        myConsent: false,
        remoteConsent: false,
        canRecord: false,
        recording: false,
        remoteRecording: false,
      },
    }),
  );
  for (const action of [
    "toggle-mute",
    "toggle-video",
    "switch-camera",
    "start-screen",
    "leave-call",
    "pip",
  ]) {
    assert.ok(html.includes(`data-action="${action}"`), action);
  }
  assert.match(html, /Direct \(host\)/);
  assert.match(html, /I consent to this call being recorded/);
  // Record is disabled until everyone consents — silence is never consent.
  assert.match(html, /data-action="start-recording"[^>]*disabled/);
  assert.doesNotMatch(html, /Recording — this call is being recorded/);
});

test("call-panel: renderer active call shows the recording indicator and relay note when relayed", () => {
  const html = renderCallsPanelHtml(
    baseVm({
      active: {
        callId: "call-1",
        kind: "voice",
        peerAddress: "bob@example.arknetz",
        state: "connected",
        muted: false,
        videoEnabled: false,
        sharingScreen: false,
        remoteMuted: false,
        remoteVideoOn: false,
        remoteSharingScreen: false,
        qualityMode: "audio-only",
        diagnostics: "Relayed through freeturn.net",
        relayed: true,
        hasRemoteVideo: false,
        hasRemoteAudio: true,
        hasLocalVideo: false,
        myConsent: true,
        remoteConsent: true,
        canRecord: true,
        recording: true,
        remoteRecording: true,
      },
    }),
  );
  assert.match(html, /Recording — this call is being recorded/);
  assert.ok(html.includes(CALL_RELAYED_NOTE));
  assert.match(html, /data-action="stop-recording"/);
});

test("call-panel: renderer group call names the mixer with the trust note, never as blind", () => {
  const html = renderCallsPanelHtml(
    baseVm({
      group: {
        groupId: "abc123",
        mode: "mixer",
        mixerPeerId: "peer-f",
        isMixer: false,
        participants: [
          { peerId: "peer-a", address: "alice@example.arknetz", volunteer: false, isSelf: true, isMixer: false, hasVideo: false },
          { peerId: "peer-f", address: "fran@example.arknetz", volunteer: true, isSelf: false, isMixer: true, hasVideo: true },
        ],
        noVolunteer: false,
        mixerLost: null,
      },
    }),
  );
  assert.match(html, /routed through a volunteer mixer \(peer-f\)/);
  assert.ok(html.includes(CALLS_MIXER_TRUST_COPY));
  assert.doesNotMatch(html, /blind/i);
  assert.doesNotMatch(html, /cannot decrypt/i);
  assert.match(html, /fran@example\.arknetz.*mixer/s);
});

test("call-panel: renderer group call shows the no-volunteer notice in mesh past the threshold", () => {
  const html = renderCallsPanelHtml(
    baseVm({
      group: {
        groupId: "abc123",
        mode: "mesh",
        mixerPeerId: null,
        isMixer: false,
        participants: [],
        noVolunteer: true,
        mixerLost: null,
      },
    }),
  );
  assert.ok(html.includes(CALLS_NO_VOLUNTEER_COPY));
});

test("call-panel: renderer Android screen share is disabled with the stub reason in plain words", () => {
  const html = renderCallsPanelHtml(
    baseVm({
      screenShareSupported: false,
      screenShareNote: SCREEN_SHARE_ANDROID_NOTE,
      active: {
        callId: "call-1",
        kind: "video",
        peerAddress: "bob@example.arknetz",
        state: "connected",
        muted: false,
        videoEnabled: true,
        sharingScreen: false,
        remoteMuted: false,
        remoteVideoOn: true,
        remoteSharingScreen: false,
        qualityMode: "full",
        diagnostics: null,
        relayed: false,
        hasRemoteVideo: true,
        hasRemoteAudio: true,
        hasLocalVideo: true,
        myConsent: false,
        remoteConsent: false,
        canRecord: false,
        recording: false,
        remoteRecording: false,
      },
    }),
  );
  assert.match(html, /data-action="start-screen"[^>]*disabled/);
  assert.ok(html.includes(SCREEN_SHARE_ANDROID_NOTE));
});

// ---------------------------------------------------------------------------
// Controller: 1:1 calls over a loopback pair.
// ---------------------------------------------------------------------------

test("call-panel: 1:1 voice call invite → accept → connected, tracks flow", async () => {
  const { a, b } = makePair();
  try {
    await a.controller.refreshPeers();
    const started = a.controller.startCall("peer-b", "peer-b@example.arknetz", "voice");
    await waitFor(() => b.controller.viewModel().incoming !== null);
    assert.equal(b.controller.viewModel().incoming?.fromAddress, "peer-a@example.arknetz");
    assert.equal(b.controller.viewModel().incoming?.kind, "voice");
    const accepted = await b.controller.acceptIncoming();
    assert.equal(accepted, true);
    assert.equal(await started, true);
    await waitFor(() => a.controller.viewModel().active?.state === "connected");
    await waitFor(() => b.controller.viewModel().active?.state === "connected");
    assert.equal(a.controller.viewModel().active?.peerAddress, "peer-b@example.arknetz");
    // Each side received the other's audio track.
    await flush(50);
    assert.ok(a.controller.remoteAudio !== null);
    assert.ok(b.controller.remoteAudio !== null);
    // Diagnostics arrive on the first stats poll (2 s cadence).
    await waitFor(
      () => (a.controller.viewModel().active?.diagnostics ?? "") !== "",
      5000,
    );
    assert.match(a.controller.viewModel().active?.diagnostics ?? "", /Connection path|Direct|Relayed|host|srflx/);
  } finally {
    await endAll([a, b]);
  }
});

test("call-panel: 1:1 decline ends the call on both sides", async () => {
  const { a, b } = makePair();
  try {
    const started = a.controller.startCall("peer-b", "peer-b@example.arknetz", "video");
    await waitFor(() => b.controller.viewModel().incoming !== null);
    b.controller.declineIncoming();
    await flush(50);
    assert.equal(b.controller.viewModel().incoming, null);
    assert.equal(b.controller.viewModel().active, null);
    await waitFor(() => a.controller.viewModel().active === null);
    assert.equal(await started, false);
  } finally {
    await endAll([a, b]);
  }
});

test("call-panel: mute and video toggles flip the session and reach the remote side", async () => {
  const { a, b } = makePair();
  try {
    void a.controller.startCall("peer-b", "peer-b@example.arknetz", "video");
    await waitFor(() => b.controller.viewModel().incoming !== null);
    await b.controller.acceptIncoming();
    await waitFor(() => a.controller.viewModel().active?.state === "connected");
    a.controller.toggleMute();
    assert.equal(a.controller.viewModel().active?.muted, true);
    await waitFor(() => b.controller.viewModel().active?.remoteMuted === true);
    a.controller.toggleVideo();
    assert.equal(a.controller.viewModel().active?.videoEnabled, false);
    await waitFor(() => b.controller.viewModel().active?.remoteVideoOn === false);
  } finally {
    await endAll([a, b]);
  }
});

test("call-panel: startCall refuses when media is off or a call is already live", async () => {
  const offSettings = mediaOnSettings();
  offSettings.media.enabled = false;
  const { a, b } = makePair({ settingsA: offSettings });
  try {
    assert.equal(await a.controller.startCall("peer-b", "peer-b@example.arknetz", "voice"), false);
    assert.equal(a.controller.viewModel().lastError, CALLS_OFF_COPY);
    assert.equal(a.controller.viewModel().available, true);
  } finally {
    await endAll([a, b]);
  }
  const pair2 = makePair();
  try {
    void pair2.a.controller.startCall("peer-b", "peer-b@example.arknetz", "voice");
    await waitFor(() => pair2.b.controller.viewModel().incoming !== null);
    await pair2.b.controller.acceptIncoming();
    await waitFor(() => pair2.a.controller.viewModel().active?.state === "connected");
    assert.equal(
      await pair2.a.controller.startCall("peer-b", "peer-b@example.arknetz", "voice"),
      false,
    );
    assert.equal(pair2.a.controller.viewModel().lastError, CALLS_ONE_AT_A_TIME_COPY);
  } finally {
    await endAll([pair2.a, pair2.b]);
  }
});

test("call-panel: call by address connects first, then calls; offline peer is unreachable, not a missed call", async () => {
  const hub = new PairingHub();
  const dataFactory = new LoopbackConnectionFactory();
  const [connA, connB] = dataFactory.createPair("peer-b", "peer-a");
  const a = makeCallPeer("peer-a", hub);
  const b = makeCallPeer("peer-b", hub);
  a.host.attachDataConnection("peer-b", connA);
  b.host.attachDataConnection("peer-a", connB);
  try {
    // A bad address is refused before any network use.
    assert.equal(await a.controller.callAddress("not-an-address", "voice"), false);
    assert.match(a.controller.viewModel().lastError ?? "", /Enter a protocol address/);
    // No connection for the address: unreachable, not a missed call.
    assert.equal(await a.controller.callAddress("nobody@example.arknetz", "voice"), false);
    assert.match(a.controller.viewModel().lastError ?? "", /Could not reach nobody@example\.arknetz/);
    // With a connection for the address, the call goes through.
    a.host.connectToAddressResult = connA;
    void a.controller.callAddress("peer-b@example.arknetz", "voice");
    await waitFor(() => b.controller.viewModel().incoming !== null);
    await b.controller.acceptIncoming();
    await waitFor(() => a.controller.viewModel().active?.state === "connected");
    assert.equal(a.controller.viewModel().active?.peerAddress, "peer-b@example.arknetz");
  } finally {
    await endAll([a, b]);
  }
});

// ---------------------------------------------------------------------------
// Controller: recording (consent-gated, visible on both sides).
// ---------------------------------------------------------------------------

test("call-panel: recording needs both consents, shows on both sides, stops when consent is withdrawn", async () => {
  const { a, b } = makePair();
  try {
    void a.controller.startCall("peer-b", "peer-b@example.arknetz", "voice");
    await waitFor(() => b.controller.viewModel().incoming !== null);
    await b.controller.acceptIncoming();
    await waitFor(() => a.controller.viewModel().active?.state === "connected");
    // Neither side has consented: recording refuses.
    assert.equal(a.controller.startRecording(), false);
    assert.equal(a.controller.viewModel().active?.canRecord, false);
    // A consents; B has not — still refused (silence is never consent).
    a.controller.toggleRecordingConsent();
    await flush(50);
    assert.equal(a.controller.viewModel().active?.canRecord, false);
    // B consents: now it records.
    b.controller.toggleRecordingConsent();
    await waitFor(() => a.controller.viewModel().active?.canRecord === true);
    assert.equal(a.controller.startRecording(), true);
    assert.equal(a.controller.viewModel().active?.recording, true);
    await waitFor(() => b.controller.viewModel().active?.remoteRecording === true);
    // B withdraws consent mid-recording: A stops immediately and downloads.
    b.controller.toggleRecordingConsent();
    await waitFor(() => a.controller.viewModel().active?.recording === false);
    assert.equal(a.downloads.length, 1);
    assert.match(a.downloads[0]!, /\.webm$/);
    await waitFor(() => b.controller.viewModel().active?.remoteRecording === false);
  } finally {
    await endAll([a, b]);
  }
});

// ---------------------------------------------------------------------------
// Controller: screen share (desktop works, Android is an honest stub).
// ---------------------------------------------------------------------------

test("call-panel: desktop screen share starts and the remote side sees it", async () => {
  const { a, b } = makePair();
  try {
    void a.controller.startCall("peer-b", "peer-b@example.arknetz", "video");
    await waitFor(() => b.controller.viewModel().incoming !== null);
    await b.controller.acceptIncoming();
    await waitFor(() => a.controller.viewModel().active?.state === "connected");
    assert.equal(await a.controller.startScreenShare(), true);
    await waitFor(() => b.controller.viewModel().active?.remoteSharingScreen === true);
    assert.equal(a.controller.viewModel().active?.sharingScreen, true);
    await a.controller.stopScreenShare();
    await waitFor(() => b.controller.viewModel().active?.remoteSharingScreen === false);
  } finally {
    await endAll([a, b]);
  }
});

test("call-panel: Android screen share refuses with the stub reason, never a fake", async () => {
  const hub = new PairingHub();
  const dataFactory = new LoopbackConnectionFactory();
  const [connA, connB] = dataFactory.createPair("peer-b", "peer-a");
  const a = makeCallPeer("peer-a", hub, {
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36",
  });
  const b = makeCallPeer("peer-b", hub);
  a.host.attachDataConnection("peer-b", connA);
  b.host.attachDataConnection("peer-a", connB);
  a.host.peers = [
    { peerId: "peer-b", address: "peer-b@example.arknetz", capabilities: [], connected: true, diagnostics: null },
  ];
  b.host.peers = [
    { peerId: "peer-a", address: "peer-a@example.arknetz", capabilities: [], connected: true, diagnostics: null },
  ];
  try {
    assert.equal(a.controller.viewModel().screenShareSupported, false);
    assert.ok(a.controller.viewModel().screenShareNote?.includes("MediaProjection"));
    void a.controller.startCall("peer-b", "peer-b@example.arknetz", "video");
    await waitFor(() => b.controller.viewModel().incoming !== null);
    await b.controller.acceptIncoming();
    await waitFor(() => a.controller.viewModel().active?.state === "connected");
    assert.equal(await a.controller.startScreenShare(), false);
    assert.match(a.controller.viewModel().lastError ?? "", /MediaProjection/);
  } finally {
    await endAll([a, b]);
  }
});

// ---------------------------------------------------------------------------
// Controller: group calls — invite/join, mesh legs, mixer election.
// ---------------------------------------------------------------------------

test("call-panel: group invite → join → mesh, remote video flows both ways", async () => {
  const peers = makeMesh(["peer-a", "peer-b"]);
  const [a, b] = peers as [CallPeer, CallPeer];
  try {
    assert.equal(await a!.controller.startGroupCall(["peer-b"]), true);
    await waitFor(() => b!.controller.viewModel().groupInvite !== null);
    assert.equal(b!.controller.viewModel().groupInvite?.fromAddress, "peer-a@example.arknetz");
    assert.equal(await b!.controller.joinGroupCall(), true);
    await waitFor(() => a!.controller.viewModel().group?.participants.length === 2);
    await waitFor(() => b!.controller.viewModel().group?.participants.length === 2);
    assert.equal(a!.controller.viewModel().group?.mode, "mesh");
    assert.equal(a!.controller.viewModel().group?.mixerPeerId, null);
    // Mesh legs negotiated: each side sees the other's video tile.
    await waitFor(() => a!.controller.groupVideoTrack("peer-b") !== null, 3000);
    await waitFor(() => b!.controller.groupVideoTrack("peer-a") !== null, 3000);
  } finally {
    await endAll(peers);
  }
});

test("call-panel: group decline leaves the inviter's group unchanged", async () => {
  const peers = makeMesh(["peer-a", "peer-b"]);
  const [a, b] = peers as [CallPeer, CallPeer];
  try {
    assert.equal(await a!.controller.startGroupCall(["peer-b"]), true);
    await waitFor(() => b!.controller.viewModel().groupInvite !== null);
    b!.controller.declineGroupInvite();
    await flush(50);
    assert.equal(b!.controller.viewModel().groupInvite, null);
    assert.equal(b!.controller.viewModel().group, null);
    assert.equal(a!.controller.viewModel().group?.participants.length, 1);
  } finally {
    await endAll(peers);
  }
});

test("call-panel: 6-person group elects the volunteer mixer and names them in the UI", async () => {
  const ids = ["peer-a", "peer-b", "peer-c", "peer-d", "peer-e", "peer-f"];
  const peers = makeMesh(ids, (id) =>
    mediaOnSettings({ volunteerMixer: id === "peer-a" }),
  );
  const [a] = peers as [CallPeer];
  try {
    assert.equal(
      await a!.controller.startGroupCall(["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]),
      true,
    );
    for (const peer of peers.slice(1)) {
      await waitFor(() => peer.controller.viewModel().groupInvite !== null, 3000);
      assert.equal(await peer.controller.joinGroupCall(), true);
    }
    for (const peer of peers) {
      await waitFor(
        () =>
          peer.controller.viewModel().group?.mode === "mixer" &&
          peer.controller.viewModel().group?.mixerPeerId === "peer-a",
        5000,
      );
      assert.equal(peer.controller.viewModel().group?.participants.length, 6);
    }
    // The mixer banner names peer-a on every participant's view.
    for (const peer of peers) {
      const html = renderCallsPanelHtml(peer.controller.viewModel());
      assert.match(html, /routed through a volunteer mixer \(peer-a\)/);
      assert.ok(html.includes(CALLS_MIXER_TRUST_COPY));
    }
    // The mixer keeps a leg to everyone; a non-mixer holds only the mixer leg.
    assert.equal(peers[0]!.controller.viewModel().group?.isMixer, true);
    assert.equal(peers[1]!.controller.viewModel().group?.isMixer, false);
  } finally {
    await endAll(peers);
  }
});

test("call-panel: 6-person group with no volunteer stays in mesh and says so", async () => {
  const ids = ["peer-a", "peer-b", "peer-c", "peer-d", "peer-e", "peer-f"];
  const peers = makeMesh(ids);
  const [a] = peers as [CallPeer];
  try {
    assert.equal(
      await a!.controller.startGroupCall(["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]),
      true,
    );
    for (const peer of peers.slice(1)) {
      await waitFor(() => peer.controller.viewModel().groupInvite !== null, 3000);
      assert.equal(await peer.controller.joinGroupCall(), true);
    }
    for (const peer of peers) {
      await waitFor(
        () =>
          peer.controller.viewModel().group?.mode === "mesh" &&
          peer.controller.viewModel().group?.noVolunteer === true,
        5000,
      );
    }
    const html = renderCallsPanelHtml(peers[0]!.controller.viewModel());
    assert.ok(html.includes(CALLS_NO_VOLUNTEER_COPY));
  } finally {
    await endAll(peers);
  }
});

test("call-panel: mixer leaving mid-call re-elects the next volunteer while still above 5", async () => {
  const ids = ["peer-a", "peer-b", "peer-c", "peer-d", "peer-e", "peer-f", "peer-g"];
  const peers = makeMesh(ids, (id) =>
    mediaOnSettings({ volunteerMixer: id === "peer-a" || id === "peer-b" }),
  );
  const [a, b] = peers as [CallPeer, CallPeer];
  try {
    assert.equal(
      await a!.controller.startGroupCall(["peer-b", "peer-c", "peer-d", "peer-e", "peer-f", "peer-g"]),
      true,
    );
    for (const peer of peers.slice(1)) {
      await waitFor(() => peer.controller.viewModel().groupInvite !== null, 3000);
      assert.equal(await peer.controller.joinGroupCall(), true);
    }
    for (const peer of peers) {
      await waitFor(
        () => peer.controller.viewModel().group?.mixerPeerId === "peer-a",
        5000,
      );
    }
    a!.controller.leaveGroupCall();
    // 6 remain: peer-b (the other volunteer, longest-joined remaining) is re-elected.
    for (const peer of peers.slice(1)) {
      await waitFor(
        () =>
          peer.controller.viewModel().group?.mixerPeerId === "peer-b" &&
          peer.controller.viewModel().group?.participants.length === 6,
        5000,
      );
    }
    assert.equal(b!.controller.viewModel().group?.isMixer, true);
    const html = renderCallsPanelHtml(b!.controller.viewModel());
    assert.match(html, /routed through a volunteer mixer \(peer-b\)/);
  } finally {
    await endAll(peers);
  }
});

test("call-panel: group shrinking to 5 falls back to mesh (MEDIA-SPEC.md §6.1)", async () => {
  const ids = ["peer-a", "peer-b", "peer-c", "peer-d", "peer-e", "peer-f"];
  const peers = makeMesh(ids, (id) =>
    mediaOnSettings({ volunteerMixer: id === "peer-a" }),
  );
  const [a] = peers as [CallPeer];
  try {
    assert.equal(
      await a!.controller.startGroupCall(["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]),
      true,
    );
    for (const peer of peers.slice(1)) {
      await waitFor(() => peer.controller.viewModel().groupInvite !== null, 3000);
      assert.equal(await peer.controller.joinGroupCall(), true);
    }
    for (const peer of peers) {
      await waitFor(
        () => peer.controller.viewModel().group?.mixerPeerId === "peer-a",
        5000,
      );
    }
    // A non-mixer member leaves: 5 remain, back to mesh.
    peers[5]!.controller.leaveGroupCall();
    for (const peer of peers.slice(0, 5)) {
      await waitFor(
        () =>
          peer.controller.viewModel().group?.mode === "mesh" &&
          peer.controller.viewModel().group?.mixerPeerId === null &&
          peer.controller.viewModel().group?.participants.length === 5,
        5000,
      );
    }
  } finally {
    await endAll(peers);
  }
});

// ---------------------------------------------------------------------------
// Host integration: configureIdentity creates the CallManager;
// app in Node reports calls unavailable honestly.
// ---------------------------------------------------------------------------

test("call-panel: P2PHost configureIdentity creates the CallManager; mediaAvailable follows the media switch", async () => {
  const hub = new PairingHub();
  const keys = await generateMailKeypair("alice@example.arknetz");
  const host = new P2PHost({
    settingsStore: createMemoryP2PStore(),
    apiFetch: throwingFetch as never,
    rawFetch: throwingFetch as never,
    factory: new LoopbackConnectionFactory(),
    mediaDevices: new FakeMediaDevices(),
    mediaFactory: new PairingMediaFactory("peer-a", hub),
    autoStart: false,
  });
  await host.load();
  assert.equal(host.getCallManager(), null);
  host.configureIdentity({
    address: "alice@example.arknetz",
    githubLogin: "alice",
    token: "test-token",
    privateKey: keys.privateKey,
  });
  assert.ok(host.getCallManager());
  assert.equal(host.mediaAvailable(), false);
  host.setSettings(mediaOnSettings());
  assert.equal(host.mediaAvailable(), true);
  const off = mediaOnSettings();
  off.media.enabled = false;
  host.setSettings(off);
  assert.equal(host.mediaAvailable(), false);
  // Reset clears every P2P setting, media included.
  host.setSettings(mediaOnSettings({ volunteerMixer: true }));
  await host.resetPeerId();
  assert.equal(host.getSettings().media.enabled, false);
  assert.equal(host.getSettings().media.volunteerMixer, false);
});

test("call-panel: app in Node has no calls controller and the panel says so", async () => {
  const app = createArkNetzApp({ fetchFn: throwingFetch });
  assert.equal(app.getCallsController(), null);
  assert.ok(app.panels.some((p) => p.id === "calls"));
  const html = await renderPanelHtml(app, "calls", createPanelState(), {
    getCurrentDoc: () => {
      throw new Error("no doc in this test");
    },
    showReader: () => undefined,
    showEditor: () => undefined,
  });
  assert.ok(html.includes(CALLS_NO_WEBRTC_COPY));
});

// ---------------------------------------------------------------------------
// Mount (fake DOM): buttons drive the real controller.
// ---------------------------------------------------------------------------

test("call-panel: mount renders the idle panel; Voice button starts a call", async () => {
  const { a, b } = makePair();
  try {
    const root = new FakePanelRoot();
    mountCallsPanel(root as unknown as HTMLElement, a.controller);
    await flush(50);
    assert.match(root.innerHTML, /Call a connected peer/);
    assert.match(root.innerHTML, /peer-b@example\.arknetz/);
    const voiceBtn = root.querySelector('[data-action="call-voice"]');
    assert.ok(voiceBtn, "voice button present");
    voiceBtn!.click();
    await waitFor(() => b.controller.viewModel().incoming !== null);
    await b.controller.acceptIncoming();
    await waitFor(() => a.controller.viewModel().active?.state === "connected");
    assert.match(root.innerHTML, /Video call|Voice call/);
    assert.match(root.innerHTML, /data-action="leave-call"/);
  } finally {
    await endAll([a, b]);
  }
});

test("call-panel: mount incoming ring answers from the Answer button", async () => {
  const { a, b } = makePair();
  try {
    const rootB = new FakePanelRoot();
    mountCallsPanel(rootB as unknown as HTMLElement, b.controller);
    void a.controller.startCall("peer-b", "peer-b@example.arknetz", "voice");
    await waitFor(() => rootB.innerHTML.includes('data-action="accept-call"'));
    const accept = rootB.querySelector('[data-action="accept-call"]');
    assert.ok(accept, "accept button present");
    accept!.click();
    await waitFor(() => b.controller.viewModel().active?.state === "connected");
    await waitFor(() => a.controller.viewModel().active?.state === "connected");
  } finally {
    await endAll([a, b]);
  }
});

test("call-panel: mount group checkboxes + start button start a group call", async () => {
  const peers = makeMesh(["peer-a", "peer-b"]);
  const [a, b] = peers as [CallPeer, CallPeer];
  try {
    const root = new FakePanelRoot();
    mountCallsPanel(root as unknown as HTMLElement, a!.controller);
    await flush(50);
    const box = root.querySelectorAll('input[name="group-peer"]')[0];
    assert.ok(box, "group checkbox present");
    box!.checked = true;
    const start = root.querySelector('[data-action="start-group"]');
    assert.ok(start, "start-group button present");
    start!.click();
    await waitFor(() => b!.controller.viewModel().groupInvite !== null);
    assert.equal(await b!.controller.joinGroupCall(), true);
    await waitFor(() => a!.controller.viewModel().group?.participants.length === 2);
    assert.match(root.innerHTML, /Group call/);
  } finally {
    await endAll(peers);
  }
});

test("call-panel: mount call-by-address keeps the draft across re-renders", async () => {
  const { a, b } = makePair();
  try {
    const root = new FakePanelRoot();
    mountCallsPanel(root as unknown as HTMLElement, a.controller);
    await flush(50);
    const input = root.querySelector('[data-input="call-address"]');
    assert.ok(input, "address input present");
    input!.value = "carol@example.arknetz";
    input!.fireInput();
    assert.equal(a.controller.callAddressDraft, "carol@example.arknetz");
    // A re-render (a peer-list refresh that actually changes the
    // list) must not wipe the draft.
    a.host.peers.push({
      peerId: "peer-c",
      address: "carol@example.arknetz",
      capabilities: [],
      connected: true,
      diagnostics: null,
    });
    await a.controller.refreshPeers();
    assert.match(root.innerHTML, /carol@example\.arknetz/);
  } finally {
    await endAll([a, b]);
  }
});
