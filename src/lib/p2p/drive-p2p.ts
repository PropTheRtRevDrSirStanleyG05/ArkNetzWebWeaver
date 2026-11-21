// ArkNetzWebWeaver — P2P ArkDrive adapter.
// Transfers STORED CHUNK BYTES ONLY (`iv | ciphertext` as packed by
// `packStoredChunk`) — a chunk never leaves a device unencrypted, and
// the vault key never leaves a device either. Each transfer is one
// chunk, verified by SHA-256 of the stored bytes against the hash the
// sender advertised, then decrypted and hash-verified locally by the
// existing `decryptChunk` on receipt. Two verification layers, same
// as a repo download.
//
// Scope: a user's OWN DEVICES first (phone ↔ laptop, same vault key),
// and peers they explicitly share a vault with. "Explicitly share"
// means the peer already holds the vault key through the existing
// out-of-band sharing — P2P never transmits a vault key, a
// passphrase, or a KDF parameter. A device that does not hold the
// vault key cannot open a received chunk, so a misdirected transfer
// is useless bytes, not a leak. Chunks for a vault the receiver has
// no key for are refused before transfer (the adapter checks the
// vault id against locally open vaults).

import type { P2PConnection } from "./transport.js";
import { TransferHub, sha256HexBytes } from "./transfer.js";
import { P2P_CHANNEL_LABELS } from "./types.js";

export interface DriveChunkReceived {
  vaultId: string;
  blobId: string;
  /** Stored bytes (iv | ciphertext), exactly as sent. The caller
   *  decrypts + verifies them with decryptChunk. */
  bytes: Uint8Array;
}

export interface DriveP2PCallbacks {
  /** A chunk arrived, passed its stored-bytes SHA-256 check, and is
   *  for a vault this device holds a key for. */
  onChunk: (chunk: DriveChunkReceived) => void;
  /** The channel closed — future transfers use the repo blobs. */
  onDrop: (reason: string) => void;
}

export class DriveP2P {
  private hub: TransferHub | null = null;

  /** Vault ids this device holds a key for (locally open vaults).
   *  Chunks for any other vault are refused before transfer. */
  constructor(
    private readonly knownVaultIds: ReadonlySet<string>,
    private readonly callbacks: DriveP2PCallbacks,
  ) {}

  /** Attach to a peer connection (creates the drive channel + hub). */
  attach(connection: P2PConnection): void {
    const channel = connection.createChannel(P2P_CHANNEL_LABELS.drive);
    this.hub = new TransferHub(channel);
    this.hub.onTransfer = (kind, payload) => {
      if (kind !== "drive-chunk") return;
      void this.handleChunk(payload);
    };
    channel.onclose = () => {
      this.hub?.detach();
      this.hub = null;
      this.callbacks.onDrop("channel closed");
    };
  }

  detach(): void {
    this.hub?.detach();
    this.hub = null;
  }

  /** The wire form of one chunk transfer: a small JSON header plus
   *  the stored bytes. The header is inside the verified payload, so
   *  a tampered header fails the transfer hash check. */
  static async packChunk(
    vaultId: string,
    blobId: string,
    storedBytes: Uint8Array,
  ): Promise<Uint8Array> {
    const header = new TextEncoder().encode(
      JSON.stringify({ vaultId, blobId, storedSha256: await sha256HexBytes(storedBytes) }),
    );
    const out = new Uint8Array(4 + header.length + storedBytes.length);
    new DataView(out.buffer).setUint32(0, header.length, false);
    out.set(header, 4);
    out.set(storedBytes, 4 + header.length);
    return out;
  }

  static unpackChunk(
    payload: Uint8Array,
  ): { vaultId: string; blobId: string; storedSha256: string; storedBytes: Uint8Array } | null {
    if (payload.length < 4) return null;
    const headerLen = new DataView(payload.buffer, payload.byteOffset).getUint32(0, false);
    if (headerLen <= 0 || 4 + headerLen > payload.length) return null;
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(
        new TextDecoder().decode(payload.subarray(4, 4 + headerLen)),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (
      typeof header.vaultId !== "string" ||
      typeof header.blobId !== "string" ||
      typeof header.storedSha256 !== "string"
    ) {
      return null;
    }
    return {
      vaultId: header.vaultId,
      blobId: header.blobId,
      storedSha256: header.storedSha256,
      storedBytes: payload.slice(4 + headerLen),
    };
  }

  private async handleChunk(payload: Uint8Array): Promise<void> {
    const unpacked = DriveP2P.unpackChunk(payload);
    if (!unpacked) return; // Malformed — rejected, never stored.
    if (!this.knownVaultIds.has(unpacked.vaultId)) return; // No key for this vault — refuse.
    const actual = await sha256HexBytes(unpacked.storedBytes);
    if (actual !== unpacked.storedSha256) return; // Tampered — discard.
    this.callbacks.onChunk({
      vaultId: unpacked.vaultId,
      blobId: unpacked.blobId,
      bytes: unpacked.storedBytes,
    });
  }

  /** Send one stored chunk to this peer. Resolves true when the peer
   *  acked the transfer, false on any failure — the caller then uses
   *  the repo blobs. The caller must have encrypted the chunk already
   *  (packStoredChunk) — this adapter never sees plaintext. */
  async sendChunk(vaultId: string, blobId: string, storedBytes: Uint8Array): Promise<boolean> {
    const hub = this.hub;
    if (!hub) return false;
    const payload = await DriveP2P.packChunk(vaultId, blobId, storedBytes);
    return hub.sendTransfer("drive-chunk", payload);
  }
}
