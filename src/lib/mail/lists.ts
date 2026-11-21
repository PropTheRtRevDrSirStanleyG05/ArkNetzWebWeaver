// ArkNetzWebWeaver — protocol mail mailing lists (Phase 1).
// Thread turn 18: mailing lists live in mail_lists.json.zst, e.g.
// staff@computers.edu. Small groups (1-10) get payload + wrapped key
// per inbox; large lists (e.g. 50) store the payload once in the
// sender outbox / IA and drop a 120-byte pointer + wrapped key per
// inbox.
//
// This module owns list definitions, expansion, and the large-list
// pointer shape, plus the large-list OUTBOX WRITER (fix round 2,
// item 6): buildLargeListOutbox stores the sealed payload ONCE and
// produces one pointer delivery per recipient, and openPointerMail
// resolves a pointer back to the decrypted message. It does NOT send
// anything itself — delivery.ts (MailDelivery.deliverLargeList) does
// the storing + delivering, through the injected fetch/store.

import { addressFingerprint, openMail } from "./crypto.js";
import { sha256Hex } from "./delivery.js";
import {
  LARGE_LIST_THRESHOLD,
  type EncryptedMailEnvelope,
  type LargeListOutbox,
  type MailAddress,
  type MailPlaintext,
  type MailPointer,
  type MailingList,
  type PointerDelivery,
  type WrappedKeyEntry,
} from "./types.js";

/** Validate a mailing-list definition (parse-time, loud on bad data). */
export function parseMailingList(raw: unknown): MailingList {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("mailing list is not an object");
  }
  const l = raw as Record<string, unknown>;
  if (typeof l.address !== "string" || !l.address.includes("@")) {
    throw new Error(`mailing list has an invalid address: ${String(l.address)}`);
  }
  if (!Array.isArray(l.members)) {
    throw new Error(`mailing list ${l.address} has no members array`);
  }
  const members = (l.members as unknown[]).filter(
    (m): m is string => typeof m === "string" && m.includes("@"),
  );
  if (members.length !== (l.members as unknown[]).length) {
    throw new Error(`mailing list ${l.address} has invalid member addresses`);
  }
  return {
    address: l.address as MailAddress,
    name: typeof l.name === "string" ? l.name : (l.address as string),
    domain: typeof l.domain === "string" ? l.domain : (l.address as string).split("@")[1]!,
    members: [...new Set(members.map((m) => m.toLowerCase()))],
    owner: typeof l.owner === "string" ? l.owner : "",
    updatedAt: typeof l.updatedAt === "number" ? l.updatedAt : 0,
  };
}

/** Parse mail_lists.json.zst (decompressed): { lists: MailingList[] }. */
export function parseMailLists(raw: unknown): MailingList[] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("mail_lists file is not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.lists)) throw new Error("mail_lists file has no lists array");
  return obj.lists.map((l) => parseMailingList(l));
}

export function serialiseMailLists(lists: MailingList[]): unknown {
  return { version: "arknetz-mail-lists/1", updatedAt: Date.now(), lists };
}

/** In-memory list store. The app fills it from the site repo's
 *  mail_lists.json.zst (per domain) and the coordinator wires
 *  persistence later. */
export class MailListStore {
  private readonly byAddress = new Map<string, MailingList>();

  constructor(lists: MailingList[] = []) {
    for (const l of lists) this.add(l);
  }

  get size(): number {
    return this.byAddress.size;
  }

  add(list: MailingList): void {
    this.byAddress.set(list.address.toLowerCase(), parseMailingList(list));
  }

  remove(address: MailAddress): boolean {
    return this.byAddress.delete(address.toLowerCase());
  }

  lookup(address: MailAddress): MailingList | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  has(address: MailAddress): boolean {
    return this.byAddress.has(address.toLowerCase());
  }

  all(): MailingList[] {
    return [...this.byAddress.values()].sort((a, b) =>
      a.address.localeCompare(b.address),
    );
  }

  /** Expand one list address to its members (deduped, lowercased).
   *  Throws when the address is not a known list. */
  expand(address: MailAddress): MailAddress[] {
    const list = this.lookup(address);
    if (!list) throw new Error(`unknown mailing list: ${address}`);
    return [...list.members];
  }

  /** Expand a mixed recipient list: list addresses expand in place,
   *  direct addresses pass through. Returns the expanded recipients
   *  plus the list addresses that were unknown (so the UI can report
   *  them instead of silently dropping mail). Sender is never a
   *  recipient of their own list mail. */
  expandRecipients(
    addresses: MailAddress[],
    sender: MailAddress,
  ): { recipients: MailAddress[]; unknownLists: MailAddress[] } {
    const recipients: string[] = [];
    const unknownLists: MailAddress[] = [];
    const seen = new Set<string>([sender.toLowerCase()]);
    for (const raw of addresses) {
      const addr = raw.trim().toLowerCase();
      if (!addr || seen.has(addr)) continue;
      const list = this.lookup(addr);
      if (list) {
        for (const m of list.members) {
          if (!seen.has(m)) {
            seen.add(m);
            recipients.push(m);
          }
        }
      } else if (addr.includes("@") && this.looksLikeListAddress(addr)) {
        unknownLists.push(raw);
      } else {
        seen.add(addr);
        recipients.push(addr);
      }
    }
    return { recipients, unknownLists };
  }

  /** Heuristic for the "unknown list" report: an address whose local
   *  part is a bare role/plural word (staff, team, all, everyone,
   *  members, announce) reads as a list address, not a person. A
   *  dotted personal name (alice.smith@) does not. */
  looksLikeListAddress(address: MailAddress): boolean {
    const local = address.split("@")[0] ?? "";
    return /^(staff|team|all|everyone|members|announce|announcements|dev|devs|mods|admins|support|info|contact|news|updates)$/.test(
      local,
    );
  }
}

/** Is this recipient count a "large list" (payload stored once +
 *  pointer per inbox)? */
export function isLargeList(recipientCount: number): boolean {
  return recipientCount >= LARGE_LIST_THRESHOLD;
}

/** Build the ~120-byte pointer for a sealed envelope, for large-list
 *  delivery. `payloadRef` names where the sealed payload lives, e.g.
 *  "gh:alice/mail-outbox#<messageId>". The payload hash is SHA-256
 *  over the envelope JSON so a recipient can verify the copy they
 *  fetch is the one the sender sealed. */
export async function buildMailPointer(
  envelope: EncryptedMailEnvelope,
  payloadRef: string,
): Promise<MailPointer> {
  const payloadJson = JSON.stringify(envelope);
  return {
    kind: "arknetz-mail-pointer/1",
    payloadRef,
    payloadSha256: await sha256Hex(payloadJson),
    payloadBytes: new TextEncoder().encode(payloadJson).length,
    messageId: envelope.messageId,
    threadId: envelope.threadId,
  };
}

/** Turn a sealed group envelope into one pointer delivery per
 *  recipient: the SAME pointer (payload stored once) + each
 *  recipient's own wrapped key from the envelope. The per-inbox Issue
 *  then carries the pointer JSON (~314 bytes with full-length ids)
 *  + one 72-byte wrapped key (base64 in the delivery JSON) instead
 *  of the whole ciphertext. Throws if a recipient has no
 *  wrapped key in the envelope (e.g. a list member added after the
 *  seal — re-seal instead of silently dropping them). */
export async function makePointerDeliveriesForKeys(
  envelope: EncryptedMailEnvelope,
  pointer: MailPointer,
  recipients: MailAddress[],
): Promise<PointerDelivery[]> {
  const byFingerprint = new Map<string, WrappedKeyEntry>(
    envelope.wrappedKeys.map((w) => [w.fingerprint, w]),
  );
  const out: PointerDelivery[] = [];
  for (const recipient of recipients) {
    const fingerprint = await addressFingerprint(recipient);
    const wrappedKey = byFingerprint.get(fingerprint);
    if (!wrappedKey) {
      throw new Error(
        `no wrapped key for ${recipient} in envelope ${envelope.messageId} — re-seal with them included`,
      );
    }
    out.push({ recipient, pointer, wrappedKey });
  }
  return out;
}

// --- large-list outbox writer (fix round 2, item 6) ----------------------

/** The payload reference for a large-list send: the sender's outbox
 *  location for this message, e.g. "gh:alice/mail-outbox#<messageId>".
 *  The outbox itself is the sender's repo (or IA object) that holds
 *  the single stored copy of the sealed payload; the pointer is what
 *  each recipient's inbox Issue carries. */
export function outboxPayloadRef(senderGithubUser: string, messageId: string): string {
  return `gh:${senderGithubUser}/mail-outbox#${messageId}`;
}

/** THE WRITER: turn a sealed envelope for a large recipient set into
 *  the outbox write — the sealed payload stored ONCE (one
 *  `payloadJson` string) plus one pointer delivery per recipient.
 *  Every delivery shares the SAME `pointer` object (identity, not a
 *  copy), so there is exactly one payload to store and the per-inbox
 *  cost is one pointer + one wrapped key, not one ciphertext. The
 *  caller stores `payloadJson` at `payloadRef` exactly once (see
 *  MailDelivery.deliverLargeList, which enforces the once) and then
 *  delivers each pointer. Recipients are deduped (case-insensitive);
 *  a recipient with no wrapped key in the envelope throws instead of
 *  being silently dropped — re-seal with them included. Intended for
 *  recipient counts at or above LARGE_LIST_THRESHOLD (50); smaller
 *  groups go through direct envelope delivery instead. */
export async function buildLargeListOutbox(
  envelope: EncryptedMailEnvelope,
  payloadRef: string,
  recipients: MailAddress[],
): Promise<LargeListOutbox> {
  if (recipients.length === 0) {
    throw new Error("cannot build a large-list outbox with no recipients");
  }
  const seen = new Set<string>();
  const unique: MailAddress[] = [];
  for (const recipient of recipients) {
    const lower = recipient.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(recipient);
    }
  }
  const payloadJson = JSON.stringify(envelope);
  const pointer = await buildMailPointer(envelope, payloadRef);
  const deliveries = await makePointerDeliveriesForKeys(envelope, pointer, unique);
  return {
    pointer,
    payloadRef,
    payloadJson,
    deliveries,
    recipientCount: unique.length,
  };
}

/** Verify a fetched payload against its pointer before trusting it:
 *  the byte length and the SHA-256 must both match the pointer, or
 *  the stored copy is not the one the sender sealed (wrong object,
 *  truncated fetch, or tampering). Throws with a plain message on
 *  any mismatch. */
export async function verifyPointerPayload(
  pointer: MailPointer,
  payloadJson: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(payloadJson);
  if (bytes.length !== pointer.payloadBytes) {
    throw new Error(
      `pointer payload size mismatch for ${pointer.messageId}: pointer says ${pointer.payloadBytes} bytes, fetched payload is ${bytes.length}`,
    );
  }
  const hash = await sha256Hex(payloadJson);
  if (hash !== pointer.payloadSha256) {
    throw new Error(
      `pointer payload hash mismatch for ${pointer.messageId} — the fetched payload is not the one the sender sealed`,
    );
  }
}

/** Resolve a pointer delivery: verify the fetched payload against
 *  the pointer (hash + size + messageId), then open it for the
 *  recipient. `payloadJson` is the stored payload fetched from
 *  `delivery.pointer.payloadRef` (sender outbox / IA). Throws when
 *  the delivery is not addressed to this recipient, when the payload
 *  fails verification, or when the recipient has no wrapped key in
 *  the envelope (non-recipient) — never a partial plaintext. */
export async function openPointerMail(
  delivery: PointerDelivery,
  payloadJson: string,
  recipientAddress: MailAddress,
  recipientPrivateKey: CryptoKey,
): Promise<MailPlaintext> {
  if (delivery.recipient.toLowerCase() !== recipientAddress.toLowerCase()) {
    throw new Error(
      `pointer delivery is not addressed to ${recipientAddress} (it is for ${delivery.recipient})`,
    );
  }
  await verifyPointerPayload(delivery.pointer, payloadJson);
  let envelope: EncryptedMailEnvelope;
  try {
    envelope = JSON.parse(payloadJson) as EncryptedMailEnvelope;
  } catch {
    throw new Error("stored mail payload is not valid JSON — refusing it");
  }
  if (envelope.messageId !== delivery.pointer.messageId) {
    throw new Error(
      "stored mail payload messageId does not match the pointer — refusing it",
    );
  }
  return openMail(envelope, recipientAddress, recipientPrivateKey);
}
