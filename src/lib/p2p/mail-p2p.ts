// ArkNetzWebWeaver — P2P mail adapter.
// The sender seals the envelope EXACTLY as today (`sealMail` — Zstd
// + AES-256-GCM, X25519-wrapped CEK per recipient). The sealed
// envelope JSON is sent as one transfer over the data channel; the
// receiver validates it with the same checks as an inbox Issue and
// hands it to the normal inbox path (`openMail`). A malformed
// envelope is rejected, never stored.
//
// No delivery receipt is a failure: no ack within the transfer
// timeout, or no peer online, means the sender delivers via the Issue
// inbox exactly as today. OFFLINE RECIPIENTS ARE NOT A P2P CASE AT
// ALL: no peer, no channel — the Issue inbox is the delivery,
// unchanged. BCC is unchanged: the envelope carries wrapped keys by
// fingerprint only, and the P2P path never sees the BCC list, because
// the envelope never contains it.

import { MAIL_PROTOCOL_VERSION, type EncryptedMailEnvelope } from "../mail/types.js";
import type { P2PConnection } from "./transport.js";
import { TransferHub } from "./transfer.js";
import { P2P_CHANNEL_LABELS } from "./types.js";

export interface MailP2PCallbacks {
  /** A sealed envelope arrived and passed validation. The caller
   *  hands it to the normal inbox path (openMail). */
  onEnvelope: (envelope: EncryptedMailEnvelope) => void;
  /** The channel closed — future sends fall back to the inbox. */
  onDrop: (reason: string) => void;
}

/** Validate a received envelope the same way an inbox Issue is
 *  validated (delivery.ts parseMailIssueBody): version + messageId +
 *  ciphertext present. The caller still runs openMail, which
 *  re-checks everything cryptographically — this is only the
 *  structural gate. */
export function parseP2PEnvelope(raw: unknown): EncryptedMailEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (e.version !== MAIL_PROTOCOL_VERSION) return null;
  if (typeof e.messageId !== "string" || !e.messageId) return null;
  if (typeof e.ciphertextB64 !== "string" || !e.ciphertextB64) return null;
  return raw as EncryptedMailEnvelope;
}

export class MailP2P {
  private hub: TransferHub | null = null;

  constructor(private readonly callbacks: MailP2PCallbacks) {}

  /** Attach to a peer connection (creates the mail channel + hub). */
  attach(connection: P2PConnection): void {
    const channel = connection.createChannel(P2P_CHANNEL_LABELS.mail);
    this.hub = new TransferHub(channel);
    this.hub.onTransfer = (kind, payload) => {
      if (kind !== "mail-envelope") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return; // Not JSON — rejected, never stored.
      }
      const envelope = parseP2PEnvelope(parsed);
      if (envelope) this.callbacks.onEnvelope(envelope);
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

  /** Deliver one already-sealed envelope direct to this peer.
   *  Resolves true when the peer acked the transfer, false on any
   *  failure — the caller then delivers via the Issue inbox. */
  async deliver(envelope: EncryptedMailEnvelope): Promise<boolean> {
    const hub = this.hub;
    if (!hub) return false;
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    return hub.sendTransfer("mail-envelope", bytes);
  }
}
