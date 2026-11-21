// ArkNetzWebWeaver — P2P chunked transfer over one data channel.
// Frame format (P2P-SPEC.md §4): [ type: u8 ][ payload ]. Type 0x01
// is a JSON control message; type 0x02 is a chunk frame:
// [ 0x02 ][ transferId: 16 bytes ][ index: u32 BE ][ data ≤ 16 KiB ].
// A transfer is: transfer-begin (with the SHA-256 of the whole
// payload), chunk frames in order, then transfer-done. A receiver
// that is missing chunks asks for them (transfer-missing, up to 3
// rounds); a payload that fails its hash check after retries is
// DISCARDED — a failed transfer never yields partial data.
//
// One TransferHub owns one channel. Adapters use it for both control
// messages and bulk transfers, so chunk frames and control JSON never
// collide on a channel.

import type { ControlMessage } from "./types.js";
import type { P2PChannel } from "./transport.js";

export const FRAME_JSON = 0x01;
export const FRAME_CHUNK = 0x02;
/** Max data bytes per chunk frame — under the SCTP message limit, so
 *  no frame is ever fragmented by the channel itself. */
export const TRANSFER_CHUNK_BYTES = 16 * 1024;
/** Max payload bytes per transfer, per kind (P2P-SPEC.md §4.4). */
export const TRANSFER_MAX_BYTES: Record<string, number> = {
  "site-bundle": 25 * 1024 * 1024,
  "mail-envelope": 10 * 1024 * 1024,
  "drive-chunk": 10 * 1024 * 1024 + 28,
  "collab-batch": 1024 * 1024,
};
/** Default cap when a kind is not listed above. */
export const TRANSFER_DEFAULT_MAX_BYTES = 1024 * 1024;
/** How many times the sender re-sends missing chunks. */
export const TRANSFER_MAX_RETRIES = 3;
/** How long the receiver waits for missing chunks before failing. */
export const TRANSFER_TIMEOUT_MS = 30_000;

export async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function encodeControlMessage(msg: ControlMessage): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(1 + json.length);
  out[0] = FRAME_JSON;
  out.set(json, 1);
  return out;
}

export function encodeChunkFrame(transferId: Uint8Array, index: number, data: Uint8Array): Uint8Array {
  if (transferId.length !== 16) throw new Error("transfer id must be 16 bytes");
  if (data.length > TRANSFER_CHUNK_BYTES) {
    throw new Error(`chunk data is ${data.length} bytes, max ${TRANSFER_CHUNK_BYTES}`);
  }
  const out = new Uint8Array(1 + 16 + 4 + data.length);
  out[0] = FRAME_CHUNK;
  out.set(transferId, 1);
  new DataView(out.buffer, out.byteOffset).setUint32(17, index, false);
  out.set(data, 21);
  return out;
}

export type DecodedFrame =
  | { type: "control"; message: ControlMessage }
  | { type: "chunk"; transferId: string; index: number; data: Uint8Array }
  | { type: "unknown"; reason: string };

function transferIdHex(id: Uint8Array): string {
  return [...id].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function decodeFrame(frame: Uint8Array): DecodedFrame {
  if (frame.length < 1) return { type: "unknown", reason: "empty frame" };
  if (frame[0] === FRAME_JSON) {
    try {
      const message = JSON.parse(new TextDecoder().decode(frame.subarray(1))) as ControlMessage;
      if (typeof message !== "object" || message === null || typeof message.t !== "string") {
        return { type: "unknown", reason: "control frame has no t field" };
      }
      return { type: "control", message };
    } catch {
      return { type: "unknown", reason: "control frame is not valid JSON" };
    }
  }
  if (frame[0] === FRAME_CHUNK) {
    if (frame.length < 21) return { type: "unknown", reason: "chunk frame too short" };
    const id = transferIdHex(frame.subarray(1, 17));
    const index = new DataView(frame.buffer, frame.byteOffset).getUint32(17, false);
    return { type: "chunk", transferId: id, index, data: frame.slice(21) };
  }
  return { type: "unknown", reason: `unknown frame type 0x${(frame[0] as number).toString(16)}` };
}

/** Token bucket for upload pacing (bytes per second). A bucket with
 *  rate 0 is unlimited. Pure arithmetic — testable without timers. */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly bytesPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = bytesPerSecond;
    this.lastRefillMs = this.now();
  }

  /** True when `bytes` can be spent now (and spends them). */
  trySpend(bytes: number): boolean {
    if (this.bytesPerSecond <= 0) return true;
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefillMs);
    this.tokens = Math.min(this.bytesPerSecond, this.tokens + (elapsed / 1000) * this.bytesPerSecond);
    this.lastRefillMs = now;
    if (this.tokens < bytes) return false;
    this.tokens -= bytes;
    return true;
  }

  /** Milliseconds until `bytes` can be spent (0 when spendable now). */
  waitMs(bytes: number): number {
    if (this.bytesPerSecond <= 0) return 0;
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefillMs);
    const available = Math.min(
      this.bytesPerSecond,
      this.tokens + (elapsed / 1000) * this.bytesPerSecond,
    );
    if (available >= bytes) return 0;
    return Math.ceil(((bytes - available) / this.bytesPerSecond) * 1000);
  }
}

export interface TransferHubOptions {
  /** Bytes per second of upload pacing (0 = unlimited). */
  uploadBytesPerSecond?: number;
  now?: () => number;
  /** Delay helper (injected in tests to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
}

interface IncomingTransfer {
  id: string;
  kind: string;
  totalBytes: number;
  totalChunks: number;
  sha256: string;
  chunks: Map<number, Uint8Array>;
  receivedBytes: number;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface OutgoingTransfer {
  id: string;
  kind: string;
  payload: Uint8Array;
  resolve: (ok: boolean) => void;
  retries: number;
}

/** Owns one channel: encodes/decodes frames, chunks outbound
 *  transfers, reassembles inbound ones, verifies SHA-256. Control
 *  messages that are not transfer bookkeeping are passed to
 *  `onControl`; verified payloads go to `onTransfer`. */
export class TransferHub {
  onControl: ((msg: ControlMessage) => void) | null = null;
  onTransfer: ((kind: string, payload: Uint8Array) => void) | null = null;
  /** Malformed frames / failed transfers are reported here, never
   *  thrown into the channel handler. */
  onError: ((err: Error) => void) | null = null;

  private readonly incoming = new Map<string, IncomingTransfer>();
  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly bucket: TokenBucket;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private transferCounter = 0;

  constructor(
    private readonly channel: P2PChannel,
    options: TransferHubOptions = {},
  ) {
    this.bucket = new TokenBucket(
      options.uploadBytesPerSecond ?? 0,
      options.now,
    );
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.channel.onmessage = (frame) => this.handleFrame(frame);
  }

  /** Detach from the channel (stops handling frames). In-flight
   *  transfers are failed, never left hanging. */
  detach(): void {
    this.channel.onmessage = null;
    for (const t of this.incoming.values()) {
      if (t.timer) clearTimeout(t.timer);
    }
    this.incoming.clear();
    for (const t of this.outgoing.values()) t.resolve(false);
    this.outgoing.clear();
  }

  /** Send a control message (not a transfer). Throws when the
   *  channel is not open — the caller decides whether that is a
   *  fallback trigger. */
  sendControl(msg: ControlMessage): void {
    this.channel.send(encodeControlMessage(msg));
  }

  /** Send a payload as a chunked, verified transfer. Resolves true
   *  when the receiver acks ok, false on any failure (timeout,
   *  refusal, hash mismatch, channel closed). Never throws for a
   *  transfer failure — only for a channel that will not send at all
   *  (same contract as sendControl). */
  async sendTransfer(kind: string, payload: Uint8Array): Promise<boolean> {
    const max = TRANSFER_MAX_BYTES[kind] ?? TRANSFER_DEFAULT_MAX_BYTES;
    if (payload.length > max) {
      this.onError?.(
        new Error(`refusing ${kind} transfer of ${payload.length} bytes (max ${max})`),
      );
      return false;
    }
    this.transferCounter += 1;
    const idBytes = new Uint8Array(16);
    crypto.getRandomValues(idBytes);
    const id = transferIdHex(idBytes);
    const totalChunks = Math.max(1, Math.ceil(payload.length / TRANSFER_CHUNK_BYTES));
    const sha256 = await sha256HexBytes(payload);
    const transfer: OutgoingTransfer = {
      id,
      kind,
      payload,
      resolve: () => undefined,
      retries: 0,
    };
    const done = new Promise<boolean>((resolve) => {
      transfer.resolve = resolve;
    });
    this.outgoing.set(id, transfer);
    try {
      this.sendControl({
        t: "transfer-begin",
        id,
        kind,
        totalBytes: payload.length,
        totalChunks,
        sha256,
      });
    } catch (err) {
      this.outgoing.delete(id);
      throw err;
    }
    await this.sendChunks(id, payload, 0, totalChunks);
    // The receiver answers transfer-done (or transfer-missing). A
    // transfer with no answer resolves false on timeout.
    const timeout = setTimeout(() => {
      if (this.outgoing.has(id)) {
        this.outgoing.delete(id);
        transfer.resolve(false);
      }
    }, TRANSFER_TIMEOUT_MS);
    const ok = await done;
    clearTimeout(timeout);
    return ok;
  }

  private async sendChunks(
    id: string,
    payload: Uint8Array,
    fromIndex: number,
    totalChunks: number,
    only?: Set<number>,
  ): Promise<void> {
    const idBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      idBytes[i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
    }
    for (let index = fromIndex; index < totalChunks; index++) {
      if (only && !only.has(index)) continue;
      const start = index * TRANSFER_CHUNK_BYTES;
      const slice = payload.slice(start, Math.min(start + TRANSFER_CHUNK_BYTES, payload.length));
      // Pace uploads through the token bucket (no-op when unlimited).
      let wait = this.bucket.waitMs(slice.length);
      while (wait > 0) {
        await this.sleep(Math.min(wait, 100));
        wait = this.bucket.waitMs(slice.length);
      }
      this.bucket.trySpend(slice.length);
      this.channel.send(encodeChunkFrame(idBytes, index, slice));
    }
  }

  private handleFrame(frame: Uint8Array): void {
    const decoded = decodeFrame(frame);
    if (decoded.type === "unknown") {
      this.onError?.(new Error(`ignoring malformed P2P frame: ${decoded.reason}`));
      return;
    }
    if (decoded.type === "control") {
      this.handleControl(decoded.message);
      return;
    }
    this.handleChunk(decoded.transferId, decoded.index, decoded.data);
  }

  private handleControl(msg: ControlMessage): void {
    if (msg.t === "transfer-begin") {
      this.beginIncoming(msg);
      return;
    }
    if (msg.t === "transfer-missing") {
      const out = this.outgoing.get(msg.id);
      if (!out) return;
      if (out.retries >= TRANSFER_MAX_RETRIES) {
        this.outgoing.delete(msg.id);
        out.resolve(false);
        return;
      }
      out.retries += 1;
      const totalChunks = Math.max(1, Math.ceil(out.payload.length / TRANSFER_CHUNK_BYTES));
      void this.sendChunks(msg.id, out.payload, 0, totalChunks, new Set(msg.indexes)).catch(() => {
        this.outgoing.delete(msg.id);
        out.resolve(false);
      });
      return;
    }
    if (msg.t === "transfer-done") {
      const out = this.outgoing.get(msg.id);
      if (!out) return;
      this.outgoing.delete(msg.id);
      out.resolve(msg.ok);
      return;
    }
    this.onControl?.(msg);
  }

  private beginIncoming(msg: Extract<ControlMessage, { t: "transfer-begin" }>): void {
    const max = TRANSFER_MAX_BYTES[msg.kind] ?? TRANSFER_DEFAULT_MAX_BYTES;
    if (msg.totalBytes > max) {
      this.onError?.(
        new Error(
          `refusing incoming ${msg.kind} transfer of ${msg.totalBytes} bytes (max ${max})`,
        ),
      );
      try {
        this.sendControl({ t: "transfer-done", id: msg.id, ok: false, reason: "oversize" });
      } catch {
        // Channel already gone — nothing to tell.
      }
      return;
    }
    if (msg.totalChunks <= 0 || msg.totalChunks > Math.ceil(max / TRANSFER_CHUNK_BYTES) + 1) {
      this.onError?.(new Error(`refusing incoming transfer with implausible chunk count ${msg.totalChunks}`));
      return;
    }
    const existing = this.incoming.get(msg.id);
    if (existing?.timer) clearTimeout(existing.timer);
    const transfer: IncomingTransfer = {
      id: msg.id,
      kind: msg.kind,
      totalBytes: msg.totalBytes,
      totalChunks: msg.totalChunks,
      sha256: msg.sha256,
      chunks: new Map(),
      receivedBytes: 0,
      retries: 0,
      timer: null,
    };
    transfer.timer = setTimeout(() => this.failIncoming(msg.id, "timeout"), TRANSFER_TIMEOUT_MS);
    this.incoming.set(msg.id, transfer);
    // Empty payload (0 bytes, 1 chunk of length 0): the sender sends
    // one empty chunk frame; handleChunk completes it. A payload of
    // exactly 0 bytes still gets totalChunks 1 from the sender.
    if (msg.totalBytes === 0) {
      void this.finishIncoming(transfer);
    }
  }

  private handleChunk(transferId: string, index: number, data: Uint8Array): void {
    const transfer = this.incoming.get(transferId);
    if (!transfer) return; // Chunk for an unknown/finished transfer: ignore.
    if (index >= transfer.totalChunks) return;
    if (transfer.chunks.has(index)) return; // Duplicate: ignore.
    transfer.chunks.set(index, data);
    transfer.receivedBytes += data.length;
    if (transfer.chunks.size === transfer.totalChunks) {
      void this.finishIncoming(transfer);
      return;
    }
    // The last chunk arrived but some are missing: the sender has
    // sent everything, so the gap is a real loss — ask for the
    // missing indexes now instead of waiting for the timeout.
    if (index === transfer.totalChunks - 1) {
      void this.finishIncoming(transfer);
    }
  }

  private async finishIncoming(transfer: IncomingTransfer): Promise<void> {
    if (transfer.timer) clearTimeout(transfer.timer);
    // Missing indexes (should not happen when size == total, but the
    // check is cheap and the retry path is the same).
    const missing: number[] = [];
    for (let i = 0; i < transfer.totalChunks; i++) {
      if (!transfer.chunks.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      if (transfer.retries >= TRANSFER_MAX_RETRIES) {
        this.failIncoming(transfer.id, "missing chunks after retries");
        return;
      }
      transfer.retries += 1;
      transfer.timer = setTimeout(() => this.failIncoming(transfer.id, "timeout"), TRANSFER_TIMEOUT_MS);
      try {
        this.sendControl({ t: "transfer-missing", id: transfer.id, indexes: missing });
      } catch {
        this.failIncoming(transfer.id, "channel closed during retry");
      }
      return;
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < transfer.totalChunks; i++) {
      const chunk = transfer.chunks.get(i) as Uint8Array;
      parts.push(chunk);
      total += chunk.length;
    }
    const payload = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      payload.set(part, offset);
      offset += part.length;
    }
    const actual = await sha256HexBytes(payload);
    this.incoming.delete(transfer.id);
    if (actual !== transfer.sha256) {
      this.onError?.(
        new Error(
          `P2P transfer ${transfer.id} failed its SHA-256 check (expected ${transfer.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — discarding the bytes`,
        ),
      );
      try {
        this.sendControl({ t: "transfer-done", id: transfer.id, ok: false, reason: "hash-mismatch" });
      } catch {
        // Channel already gone.
      }
      return;
    }
    try {
      this.sendControl({ t: "transfer-done", id: transfer.id, ok: true });
    } catch {
      // The ack is best-effort; the payload is already verified.
    }
    this.onTransfer?.(transfer.kind, payload);
  }

  private failIncoming(id: string, reason: string): void {
    const transfer = this.incoming.get(id);
    if (!transfer) return;
    if (transfer.timer) clearTimeout(transfer.timer);
    this.incoming.delete(id);
    this.onError?.(new Error(`P2P transfer ${id} failed: ${reason}`));
    try {
      this.sendControl({ t: "transfer-done", id, ok: false, reason });
    } catch {
      // Channel already gone.
    }
  }
}
