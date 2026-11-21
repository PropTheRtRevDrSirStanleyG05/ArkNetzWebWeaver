// ArkNetzWebWeaver — sandboxed ["app", ...] postMessage save-state bridge.
// PROTOCOL.md §7: specified, NOT implemented — this module implements it.
//
// Threat model (thread turns 15, 21): an ["app", ...] block is arbitrary
// third-party HTML/JS. It runs ONLY inside
//   <iframe sandbox="allow-scripts allow-pointer-lock" referrerpolicy="no-referrer">
// with a strict CSP, as srcdoc, never injected into the main DOM — because
// app code that reached the main DOM could steal the GitHub OAuth token /
// IA S3 keys out of IndexedDB. The save bridge keeps that wall up:
//
//   * The iframe NEVER touches IndexedDB, localStorage, fetch, tokens or
//     keys. Its only capability is `window.ArkNetzSave` — { save, load,
//     delete, list } — which speaks to the parent via postMessage.
//   * The parent does every IndexedDB read/write itself, through an
//     injected AppSaveStore (memory in tests, IndexedDB in the browser).
//   * Every message is authenticated twice: (1) a per-iframe session id
//     (`sid`) that only that iframe's srcdoc knows — it is baked into the
//     srcdoc the parent generated, never a shared secret; (2) the
//     `event.source` object must be the iframe the parent created (first
//     valid message binds the source, later messages must match it).
//     srcdoc iframes have the opaque origin "null", so `event.origin` is
//     NEVER trusted as identity — a message is accepted only with origin
//     "null" AND a live sid AND the bound source. Anything else is
//     dropped silently (no reply — not even an acknowledgement).
//   * Saves are namespaced by domain: the bridge is bound to ONE domain
//     at construction, the store key is `domain + "\0" + slot`, and a
//     message carrying a different `domain` field is rejected. An app on
//     games.example can never read or write games.other's slots.
//   * Wire shape follows PROTOCOL.md §7 exactly, extended only where it
//     says PROPOSED: ops are "save" / "load" / "delete" / "list", replies
//     are "saved" / "loaded" / "deleted" / "listed" / "error", every
//     message carries `arknetz: 1` and a `requestId` the reply echoes so
//     the iframe can correlate concurrent calls. `delete` / `list` are
//     the fixed names for the ops §7 left PROPOSED.
//
//   App -> parent:
//     { arknetz: 1, op: "save",   slot: "slot-1", state: {...}, sid, requestId }
//     { arknetz: 1, op: "load",   slot: "slot-1", sid, requestId }
//     { arknetz: 1, op: "delete", slot: "slot-1", sid, requestId }
//     { arknetz: 1, op: "list",   sid, requestId }
//   Parent -> app:
//     { arknetz: 1, op: "saved",   slot, requestId }
//     { arknetz: 1, op: "loaded",  slot, state: {...} | null, requestId }
//     { arknetz: 1, op: "deleted", slot, requestId }
//     { arknetz: 1, op: "listed",  slots: ["slot-1", ...], requestId }
//     { arknetz: 1, op: "error",   requestId, error: "<code>", detail?: "..." }
//
// Limits: one slot's serialised JSON <= 64 KiB; <= 16 slots per domain;
// slot names ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$; state must be plain JSON
// (no functions / undefined / bigint / symbols / circular refs /
// __proto__ keys, max nesting depth 64). Oversize / malformed /
// unauthorised messages are rejected and write nothing.
//
// No network, no GitHub, no IA in this module. The store is injected;
// tests use the memory store. The IndexedDB store follows the
// cache.ts / search.ts store pattern (keyPath "key").

import { isValidDomain } from "../types.js";
import type { BlockNode, SiteDocument } from "../types.js";

/** Protocol version marker carried on every bridge message. */
export const APP_BRIDGE_VERSION = 1;

/** Max serialised JSON bytes per save slot. */
export const MAX_APP_SAVE_BYTES = 64 * 1024;

/** Max save slots per domain. */
export const MAX_APP_SAVE_SLOTS_PER_DOMAIN = 16;

/** Max nesting depth of a save state. */
export const MAX_APP_SAVE_DEPTH = 64;

/** Slot names: start alphanum, then alphanum / _ / -. No dots, no
 *  slashes, no ".." — a slot name can never escape its domain namespace. */
export const APP_SAVE_SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Session ids issued by the parent: uuid or 32+ hex/base62 chars. */
export const APP_BRIDGE_SESSION_RE = /^[A-Za-z0-9-]{16,128}$/;

/** Correlation ids issued by the iframe shim: 1..128 chars, no spaces. */
export const APP_BRIDGE_REQUEST_RE = /^[A-Za-z0-9._-]{1,128}$/;

export type AppBridgeOp = "save" | "load" | "delete" | "list";
export const APP_BRIDGE_OPS: AppBridgeOp[] = ["save", "load", "delete", "list"];

export type AppBridgeReplyOp = "saved" | "loaded" | "deleted" | "listed" | "error";

/** Machine-readable rejection codes returned in `error` replies. */
export type AppBridgeErrorCode =
  | "bad_message"
  | "bad_op"
  | "bad_slot"
  | "bad_request_id"
  | "bad_domain"
  | "state_not_json"
  | "state_too_large"
  | "too_many_slots";

export interface AppBridgeRequest {
  arknetz: 1;
  op: AppBridgeOp;
  slot?: string;
  state?: unknown;
  sid: string;
  requestId: string;
  domain?: string;
}

export type AppBridgeReply =
  | { arknetz: 1; op: "saved"; slot: string; requestId: string }
  | { arknetz: 1; op: "loaded"; slot: string; state: unknown; requestId: string }
  | { arknetz: 1; op: "deleted"; slot: string; requestId: string }
  | { arknetz: 1; op: "listed"; slots: string[]; requestId: string }
  | { arknetz: 1; op: "error"; requestId: string | null; error: AppBridgeErrorCode; detail?: string };

/** The message event the parent receives, in DOM-shape. The bridge only
 *  reads `source`, `origin` and `data` — pass a real MessageEvent in the
 *  browser, a plain object with the same three fields in tests. */
export interface AppBridgeMessageEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

export function isValidSaveSlot(slot: unknown): slot is string {
  return typeof slot === "string" && APP_SAVE_SLOT_RE.test(slot);
}

export function isValidSessionId(sid: unknown): sid is string {
  return typeof sid === "string" && APP_BRIDGE_SESSION_RE.test(sid);
}

export function isValidRequestId(id: unknown): id is string {
  return typeof id === "string" && APP_BRIDGE_REQUEST_RE.test(id);
}

/** Byte length of a value's JSON serialisation (UTF-8). */
export function saveStateByteSize(state: unknown): number {
  return new TextEncoder().encode(JSON.stringify(state)).length;
}

/** Strict JSON-value check: plain objects / arrays / null / finite
 *  numbers / strings / booleans only. Rejects functions, undefined,
 *  bigint, symbols, circular refs, class instances, Date/RegExp/Map/...,
 *  `__proto__` keys, and nesting deeper than MAX_APP_SAVE_DEPTH. The
 *  store keeps the serialised string, so a hostile state can never
 *  smuggle a prototype or a live object into the parent. */
export function isJsonValue(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (t !== "object") return false;
  if (depth > MAX_APP_SAVE_DEPTH) return false;
  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) return false;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.every((v) => isJsonValue(v, depth + 1, seen));
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.entries(obj).every(
      ([k, v]) => k !== "__proto__" && k !== "constructor" && isJsonValue(v, depth + 1, seen),
    );
  } finally {
    seen.delete(obj);
  }
}

/** Validate the *shape* of an incoming message (after authentication).
 *  Returns the parsed request, or the error code + detail for an
 *  `error` reply. Authentication failures (bad sid / origin / source /
 *  domain mismatch against the bound domain) are NOT reported here —
 *  the bridge drops those silently, so this validator only runs on
 *  messages that already proved they came from a live session. */
export function validateAppBridgeMessage(
  data: unknown,
  boundDomain: string,
): { ok: true; request: AppBridgeRequest } | { ok: false; error: AppBridgeErrorCode; detail: string; requestId: string | null } {
  const requestId =
    typeof data === "object" && data !== null && isValidRequestId((data as Record<string, unknown>).requestId)
      ? ((data as Record<string, unknown>).requestId as string)
      : null;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "bad_message", detail: "message is not an object", requestId };
  }
  const msg = data as Record<string, unknown>;
  if (msg.arknetz !== 1) {
    return { ok: false, error: "bad_message", detail: "missing arknetz: 1 marker", requestId };
  }
  if (typeof msg.op !== "string" || !(APP_BRIDGE_OPS as string[]).includes(msg.op)) {
    return { ok: false, error: "bad_op", detail: `unknown op ${JSON.stringify(msg.op)}`, requestId };
  }
  const op = msg.op as AppBridgeOp;
  if (msg.domain !== undefined && msg.domain !== boundDomain) {
    return { ok: false, error: "bad_domain", detail: "message domain does not match this site", requestId };
  }
  if (!isValidRequestId(msg.requestId)) {
    return { ok: false, error: "bad_request_id", detail: "requestId missing or malformed", requestId: null };
  }
  if (op !== "list") {
    if (!isValidSaveSlot(msg.slot)) {
      return { ok: false, error: "bad_slot", detail: `invalid slot ${JSON.stringify(msg.slot)}`, requestId: msg.requestId as string };
    }
  } else if (msg.slot !== undefined && !isValidSaveSlot(msg.slot)) {
    return { ok: false, error: "bad_slot", detail: `invalid slot ${JSON.stringify(msg.slot)}`, requestId: msg.requestId as string };
  }
  if (op === "save") {
    if (msg.state === undefined || !isJsonValue(msg.state)) {
      return { ok: false, error: "state_not_json", detail: "state is not a plain JSON value", requestId: msg.requestId as string };
    }
    if (saveStateByteSize(msg.state) > MAX_APP_SAVE_BYTES) {
      return {
        ok: false,
        error: "state_too_large",
        detail: `state exceeds ${MAX_APP_SAVE_BYTES} bytes`,
        requestId: msg.requestId as string,
      };
    }
  }
  return {
    ok: true,
    request: {
      arknetz: 1,
      op,
      slot: typeof msg.slot === "string" ? msg.slot : undefined,
      state: msg.state,
      sid: msg.sid as string,
      requestId: msg.requestId as string,
      domain: typeof msg.domain === "string" ? msg.domain : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Store: per-domain save slots. The store key is `domain + "\0" + slot`,
// so two domains can never collide even with the same slot name. State
// is kept as its serialised JSON string — load returns the parsed value,
// which is byte-identical to what was saved (JSON round-trip).
// ---------------------------------------------------------------------------

export interface AppSaveStore {
  /** Serialised JSON string for the slot, or undefined when absent. */
  get(domain: string, slot: string): Promise<string | undefined>;
  put(domain: string, slot: string, stateJson: string): Promise<void>;
  delete(domain: string, slot: string): Promise<void>;
  /** Slot names stored for this domain, sorted. */
  list(domain: string): Promise<string[]>;
}

export function createMemoryAppSaveStore(): AppSaveStore {
  const map = new Map<string, string>();
  const key = (domain: string, slot: string) => `${domain}\0${slot}`;
  return {
    async get(domain, slot) {
      return map.get(key(domain, slot));
    },
    async put(domain, slot, stateJson) {
      map.set(key(domain, slot), stateJson);
    },
    async delete(domain, slot) {
      map.delete(key(domain, slot));
    },
    async list(domain) {
      const prefix = `${domain}\0`;
      const slots: string[] = [];
      for (const k of map.keys()) {
        if (k.startsWith(prefix)) slots.push(k.slice(prefix.length));
      }
      return slots.sort();
    },
  };
}

const IDB_DB = "arknetz-app-saves";
const IDB_STORE = "saves";

interface AppSaveRow {
  key: string;
  domain: string;
  slot: string;
  state: string;
  updatedAt: number;
}

/** Browser/IndexedDB store for app save slots. The iframe never sees
 *  this object — only the parent bridge calls it, and only for the
 *  bridge's bound domain. */
export function createIndexedDBAppSaveStore(): AppSaveStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const tx = async (mode: IDBTransactionMode) => {
    const db = await open();
    return { db, store: db.transaction(IDB_STORE, mode).objectStore(IDB_STORE) };
  };
  const rowKey = (domain: string, slot: string) => `${domain}\0${slot}`;
  return {
    async get(domain, slot) {
      const { db, store } = await tx("readonly");
      try {
        const row = await new Promise<AppSaveRow | undefined>((resolve, reject) => {
          const r = store.get(rowKey(domain, slot));
          r.onsuccess = () => resolve(r.result as AppSaveRow | undefined);
          r.onerror = () => reject(r.error);
        });
        return row?.state;
      } finally {
        db.close();
      }
    },
    async put(domain, slot, stateJson) {
      const { db, store } = await tx("readwrite");
      try {
        const row: AppSaveRow = { key: rowKey(domain, slot), domain, slot, state: stateJson, updatedAt: Date.now() };
        await new Promise<void>((resolve, reject) => {
          const r = store.put(row);
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
    async delete(domain, slot) {
      const { db, store } = await tx("readwrite");
      try {
        await new Promise<void>((resolve, reject) => {
          const r = store.delete(rowKey(domain, slot));
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } finally {
        db.close();
      }
    },
    async list(domain) {
      const { db, store } = await tx("readonly");
      try {
        const rows = await new Promise<AppSaveRow[]>((resolve, reject) => {
          const r = store.getAll();
          r.onsuccess = () => resolve((r.result as AppSaveRow[]) ?? []);
          r.onerror = () => reject(r.error);
        });
        return rows
          .filter((row) => row.domain === domain)
          .map((row) => row.slot)
          .sort();
      } finally {
        db.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge: one bridge per site domain. The viewer creates one session per
// app iframe (createSession -> sid, baked into that iframe's srcdoc by
// the renderer) and routes window "message" events to handleMessage.
// ---------------------------------------------------------------------------

export interface AppSaveSession {
  sid: string;
  /** Bound on the first valid message from this session; later messages
   *  must come from the same source object. Null until bound. */
  source: unknown;
}

export function createAppSaveSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class AppSaveBridge {
  readonly domain: string;
  private readonly store: AppSaveStore;
  private readonly sessions = new Map<string, AppSaveSession>();

  constructor(store: AppSaveStore, domain: string) {
    if (!isValidDomain(domain)) throw new Error(`invalid app-bridge domain ${JSON.stringify(domain)}`);
    this.store = store;
    this.domain = domain;
  }

  /** Issue a per-iframe session id. The caller bakes it into that
   *  iframe's srcdoc (via renderBlock's appBridgeToken option) and
   *  nowhere else. One session per iframe — never share a sid between
   *  iframes, and revoke it when the iframe is removed. */
  createSession(): string {
    const sid = createAppSaveSessionId();
    this.sessions.set(sid, { sid, source: null });
    return sid;
  }

  /** Bind a session to a known iframe source up front (when the shell
   *  already has iframe.contentWindow). Optional — the first valid
   *  message binds the source automatically. */
  bindSession(sid: string, source: unknown): boolean {
    const session = this.sessions.get(sid);
    if (!session) return false;
    session.source = source;
    return true;
  }

  revokeSession(sid: string): boolean {
    return this.sessions.delete(sid);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(sid: string): boolean {
    return this.sessions.has(sid);
  }

  /** Handle one incoming message event. Returns the reply to post back
   *  to `event.source`, or null when the message must be dropped
   *  silently (unknown/revoked session, wrong origin, wrong source,
   *  wrong domain). A returned `error` reply means the message WAS
   *  authenticated but its payload was invalid — and nothing was
   *  written. Replies never contain the sid, a token, a key, or any
   *  store other than this domain's save slots. */
  async handleMessage(event: AppBridgeMessageEvent): Promise<AppBridgeReply | null> {
    if (!event || typeof event !== "object") return null;
    // srcdoc iframes have the opaque origin "null". Origin is checked
    // but never trusted on its own — it is one of three checks.
    if (event.origin !== "null") return null;
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const msg = data as Record<string, unknown>;
    if (msg.arknetz !== 1) return null;
    if (!isValidSessionId(msg.sid)) return null;
    const session = this.sessions.get(msg.sid as string);
    if (!session) return null; // unknown or revoked session: silent drop
    if (msg.domain !== undefined && msg.domain !== this.domain) return null;
    if (session.source === null) {
      session.source = event.source; // first valid message binds the source
    } else if (session.source !== event.source) {
      return null; // a different window reusing this session's sid
    }

    const validated = validateAppBridgeMessage(data, this.domain);
    if (!validated.ok) {
      return { arknetz: 1, op: "error", requestId: validated.requestId, error: validated.error, detail: validated.detail };
    }
    const req = validated.request;
    const requestId = req.requestId;

    switch (req.op) {
      case "save": {
        const slot = req.slot as string;
        const existing = await this.store.get(this.domain, slot);
        if (existing === undefined) {
          const slots = await this.store.list(this.domain);
          if (slots.length >= MAX_APP_SAVE_SLOTS_PER_DOMAIN) {
            return {
              arknetz: 1,
              op: "error",
              requestId,
              error: "too_many_slots",
              detail: `domain already has ${MAX_APP_SAVE_SLOTS_PER_DOMAIN} save slots`,
            };
          }
        }
        await this.store.put(this.domain, slot, JSON.stringify(req.state));
        return { arknetz: 1, op: "saved", slot, requestId };
      }
      case "load": {
        const slot = req.slot as string;
        const raw = await this.store.get(this.domain, slot);
        return { arknetz: 1, op: "loaded", slot, state: raw === undefined ? null : (JSON.parse(raw) as unknown), requestId };
      }
      case "delete": {
        await this.store.delete(this.domain, req.slot as string);
        return { arknetz: 1, op: "deleted", slot: req.slot as string, requestId };
      }
      case "list": {
        return { arknetz: 1, op: "listed", slots: await this.store.list(this.domain), requestId };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Iframe side: the client shim + srcdoc injection. The shim is the ONLY
// code the sandboxed app ever sees from the parent. It exposes exactly
// one object, `window.ArkNetzSave` = { save, load, delete, list } — no
// IndexedDB, no storage, no fetch, no token/key material on the object
// (the session id lives in a closure, never as a property the app can
// read back or pass on). The shim's own source contains no reference to
// indexedDB / localStorage / sessionStorage / fetch / cookies / OAuth.
// ---------------------------------------------------------------------------

/** Methods on the iframe-facing `window.ArkNetzSave` object. */
export const APP_BRIDGE_CLIENT_METHODS = ["save", "load", "delete", "list"] as const;

/** Strict CSP for the app srcdoc, per PROTOCOL.md §7 (default-src 'none';
 *  scripts/styles inline only; images from data:/blob:/IA/raw GitHub).
 *  postMessage is not gated by CSP, so the bridge keeps working under it. */
export const APP_SRCDOC_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https://archive.org https://raw.githubusercontent.com";

/** Build the client shim script for one session id. Throws on a
 *  malformed sid so a bad id can never be baked into a srcdoc. */
export function buildAppBridgeShim(sid: string): string {
  if (!isValidSessionId(sid)) throw new Error("invalid app-bridge session id");
  const safeSid = JSON.stringify(sid);
  return (
    `<script>(function(){var sid=${safeSid};var pending={};var seq=0;` +
    `function req(op,slot,state){return new Promise(function(res,rej){` +
    `var id="r"+(++seq)+"-"+Math.random().toString(36).slice(2);` +
    `pending[id]={res:res,rej:rej};` +
    `window.parent.postMessage({arknetz:1,op:op,slot:slot,state:state,sid:sid,requestId:id},"*");` +
    `setTimeout(function(){if(pending[id]){delete pending[id];rej(new Error("ArkNetz save timed out"));}},10000);});}` +
    `window.addEventListener("message",function(e){var d=e.data;` +
    `if(!d||d.arknetz!==1||!d.requestId||!pending[d.requestId])return;` +
    `var p=pending[d.requestId];delete pending[d.requestId];` +
    `if(d.op==="error")p.rej(new Error(d.error||"save bridge error"));` +
    `else if(d.op==="loaded")p.res(d.state===undefined?null:d.state);` +
    `else if(d.op==="listed")p.res(d.slots||[]);else p.res(true);});` +
    `window.ArkNetzSave={save:function(slot,state){return req("save",slot,state);},` +
    `load:function(slot){return req("load",slot);},` +
    `delete:function(slot){return req("delete",slot);},` +
    `list:function(){return req("list");}};})();</script>`
  );
}

/** Inject the bridge shim + CSP meta into an app srcdoc bundle. The
 *  shim goes just before </body> (or </html>, or at the end for a
 *  fragment); the CSP meta goes into <head> when one exists. Returns the
 *  new srcdoc. The ~150 KB app cap (blocks.ts) is measured on the
 *  author's bundle, before this ~1.4 KB shim is added. */
export function injectAppBridgeShim(srcdoc: string, sid: string): string {
  const shim = buildAppBridgeShim(sid);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${APP_SRCDOC_CSP}">`;
  let out = srcdoc;
  const headClose = out.search(/<\/head\s*>/i);
  if (headClose !== -1) out = out.slice(0, headClose) + cspMeta + out.slice(headClose);
  else if (/<!doctype html/i.test(out)) out = out.replace(/<!doctype html[^>]*>/i, (m) => `${m}<head>${cspMeta}</head>`);
  const bodyClose = out.search(/<\/body\s*>/i);
  if (bodyClose !== -1) out = out.slice(0, bodyClose) + shim + out.slice(bodyClose);
  else {
    const htmlClose = out.search(/<\/html\s*>/i);
    if (htmlClose !== -1) out = out.slice(0, htmlClose) + shim + out.slice(htmlClose);
    else out = out + shim;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parent-side DOM wiring (thin adapter; the shell owns the window).
// The listener only forwards events to bridge.handleMessage and posts
// the reply back to the iframe's own window object — targetOrigin "*"
// is correct here because the destination is a specific window, not a
// URL, and a srcdoc iframe's origin is opaque ("null") so no narrower
// origin can be named. Returns an uninstall function.
// ---------------------------------------------------------------------------

export interface AppBridgeWindowLike {
  addEventListener(type: "message", listener: (event: AppBridgeMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: AppBridgeMessageEvent) => void): void;
}

export interface AppBridgeReplyTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** Shell wiring helper: issue one save-bridge session per sandboxed app
 *  block in a site document, keyed by block id for the renderer's
 *  `appBridgeTokens` option. Only blocks that can actually carry a
 *  session get one: type "app", an inline srcdoc (URL-sourced apps get
 *  no shim — they can use their own origin's storage), and a block id
 *  (id-less blocks cannot be keyed, and one session id must never be
 *  handed to two iframes). Walks header/footer/blocks and nested
 *  items/columns. The caller revokes the returned sessions when the
 *  site is re-rendered or navigated away from. */
export function createAppBridgeTokensForSite(
  bridge: AppSaveBridge,
  site: SiteDocument,
): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  const walk = (blocks: BlockNode[] | undefined): void => {
    for (const block of blocks ?? []) {
      if (block.type === "app" && block.appSrcdoc && block.id && !tokens.has(block.id)) {
        tokens.set(block.id, bridge.createSession());
      }
      walk(block.items);
      for (const col of block.columns ?? []) walk(col);
    }
  };
  walk(site.header);
  walk(site.blocks);
  walk(site.footer);
  return tokens;
}

export function installAppBridgeListener(
  bridge: AppSaveBridge,
  win: AppBridgeWindowLike,
  replyTo: (event: AppBridgeMessageEvent) => AppBridgeReplyTarget | null,
): () => void {
  const listener = (event: AppBridgeMessageEvent): void => {
    void bridge.handleMessage(event).then((reply) => {
      if (reply === null) return;
      replyTo(event)?.postMessage(reply, "*");
    });
  };
  win.addEventListener("message", listener);
  return () => win.removeEventListener("message", listener);
}
