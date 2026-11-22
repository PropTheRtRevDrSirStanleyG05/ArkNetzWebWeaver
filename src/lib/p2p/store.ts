// ArkNetzWebWeaver — P2P settings + peer identity persistence (phase 2).
//
// One IndexedDB database, one object store, one key — the same shape
// as the telemetry-settings store (viewer/stats.ts) and the IA-account
// store (ia-settings.ts). The stored value is the P2P settings, this
// device's peer ID, and the user's own claimed domains (where the peer
// ad is published). Everything is per device: a phone and a laptop opt
// in independently, and each has its own peer ID.
//
// The peer ID identifies a DEVICE, never an account: it is a random
// 128-bit value, generated once per device and kept until the user
// rotates or resets it. A missing or malformed stored ID is replaced
// with a fresh one — never derived from a login or address.

import { generatePeerId, isValidPeerId } from "./identity.js";
import { defaultMediaSettings, defaultP2PSettings } from "./types.js";
import type { MediaSettings, P2PSettings } from "./types.js";

/** Everything P2P persists per device. */
export interface P2PPersistedState {
  settings: P2PSettings;
  /** This device's peer ID (32 hex chars). */
  peerId: string;
  /** The user's own claimed domains — the peer ad is published to
   *  the first one (and `serves` lists all of them). Empty = no ad
   *  can be published yet; P2P still works as a client. */
  ownDomains: string[];
}

export function defaultP2PPersistedState(): P2PPersistedState {
  return {
    settings: defaultP2PSettings(),
    peerId: generatePeerId(),
    ownDomains: [],
  };
}

/** Merge stored settings over the defaults, field by field, so an
 *  old stored shape (missing a flag) never enables something the
 *  user did not turn on. Unknown fields are dropped. */
export function normalizeP2PSettings(raw: unknown): P2PSettings {
  const d = defaultP2PSettings();
  if (typeof raw !== "object" || raw === null) return d;
  const s = raw as Record<string, unknown>;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof s[key] === "boolean" ? (s[key] as boolean) : fallback;
  const turnRaw =
    typeof s.turn === "object" && s.turn !== null ? (s.turn as Record<string, unknown>) : {};
  const mediaRaw =
    typeof s.media === "object" && s.media !== null ? (s.media as Record<string, unknown>) : {};
  const mediaBool = (key: string, fallback: boolean): boolean =>
    typeof mediaRaw[key] === "boolean" ? (mediaRaw[key] as boolean) : fallback;
  const media: MediaSettings = {
    enabled: mediaBool("enabled", defaultMediaSettings().enabled),
    voice: mediaBool("voice", defaultMediaSettings().voice),
    video: mediaBool("video", defaultMediaSettings().video),
    groups: mediaBool("groups", defaultMediaSettings().groups),
    screenShare: mediaBool("screenShare", defaultMediaSettings().screenShare),
    volunteerMixer: mediaBool("volunteerMixer", defaultMediaSettings().volunteerMixer),
  };
  return {
    enabled: bool("enabled", d.enabled),
    sites: bool("sites", d.sites),
    collab: bool("collab", d.collab),
    mail: bool("mail", d.mail),
    drive: bool("drive", d.drive),
    serveSites: bool("serveSites", d.serveSites),
    maxPeers:
      typeof s.maxPeers === "number" && Number.isFinite(s.maxPeers) && s.maxPeers > 0
        ? Math.floor(s.maxPeers)
        : d.maxPeers,
    maxUploadKBps:
      typeof s.maxUploadKBps === "number" && Number.isFinite(s.maxUploadKBps) && s.maxUploadKBps >= 0
        ? Math.floor(s.maxUploadKBps)
        : d.maxUploadKBps,
    turn: {
      enabled: typeof turnRaw.enabled === "boolean" ? turnRaw.enabled : d.turn.enabled,
      provider:
        turnRaw.provider === "metered-openrelay" ||
        turnRaw.provider === "cloudflare" ||
        turnRaw.provider === "custom" ||
        turnRaw.provider === "none"
          ? turnRaw.provider
          : d.turn.provider,
      apiKey: typeof turnRaw.apiKey === "string" ? turnRaw.apiKey : d.turn.apiKey,
      urls: Array.isArray(turnRaw.urls)
        ? (turnRaw.urls as unknown[]).filter((u): u is string => typeof u === "string")
        : d.turn.urls,
      useFreeTurn:
        typeof turnRaw.useFreeTurn === "boolean" ? turnRaw.useFreeTurn : d.turn.useFreeTurn,
      useOpenRelayDemo:
        typeof turnRaw.useOpenRelayDemo === "boolean"
          ? turnRaw.useOpenRelayDemo
          : d.turn.useOpenRelayDemo,
    },
    media,
  };
}

export function normalizeP2PPersistedState(raw: unknown): P2PPersistedState {
  const d = defaultP2PPersistedState();
  if (typeof raw !== "object" || raw === null) return d;
  const s = raw as Record<string, unknown>;
  return {
    settings: normalizeP2PSettings(s.settings),
    peerId:
      typeof s.peerId === "string" && isValidPeerId(s.peerId) ? s.peerId : generatePeerId(),
    ownDomains: Array.isArray(s.ownDomains)
      ? (s.ownDomains as unknown[])
          .filter((x): x is string => typeof x === "string" && x.length > 0)
          .map((x) => x.toLowerCase())
      : [],
  };
}

export interface P2PSettingsStore {
  get(): Promise<P2PPersistedState>;
  set(next: P2PPersistedState): Promise<void>;
}

/** In-memory store (tests, and the fallback when IndexedDB is
 *  unavailable). */
export function createMemoryP2PStore(
  initial: P2PPersistedState = defaultP2PPersistedState(),
): P2PSettingsStore & { peek(): P2PPersistedState } {
  let current: P2PPersistedState = {
    settings: { ...initial.settings, turn: { ...initial.settings.turn } },
    peerId: initial.peerId,
    ownDomains: [...initial.ownDomains],
  };
  return {
    async get() {
      return {
        settings: { ...current.settings, turn: { ...current.settings.turn }, media: { ...current.settings.media } },
        peerId: current.peerId,
        ownDomains: [...current.ownDomains],
      };
    },
    async set(next) {
      current = {
        settings: { ...next.settings, turn: { ...next.settings.turn }, media: { ...next.settings.media } },
        peerId: next.peerId,
        ownDomains: [...next.ownDomains],
      };
    },
    peek() {
      return {
        settings: { ...current.settings, turn: { ...current.settings.turn }, media: { ...current.settings.media } },
        peerId: current.peerId,
        ownDomains: [...current.ownDomains],
      };
    },
  };
}

const P2P_DB = "arknetz-p2p";
const P2P_STORE = "settings";
const P2P_KEY = "p2p-state";

/** IndexedDB-backed store — same shape as the telemetry-settings
 *  store. Throws when IndexedDB is unavailable, like every other
 *  IndexedDB store in the app. */
export function createIndexedDBP2PStore(): P2PSettingsStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(P2P_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(P2P_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const withStore = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const r = fn(db.transaction(P2P_STORE, mode).objectStore(P2P_STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    async get() {
      const stored = await withStore("readonly", (s) => s.get(P2P_KEY));
      return normalizeP2PPersistedState(stored === undefined ? null : (stored as unknown));
    },
    async set(next) {
      await withStore("readwrite", (s) => s.put(normalizeP2PPersistedState(next), P2P_KEY));
    },
  };
}
