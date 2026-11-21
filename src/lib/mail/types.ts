// ArkNetzWebWeaver — protocol mail, types (Phase 1).
// Thread turns 16-18 + READINESS-PARITY.md §3: native encrypted protocol
// mail, user@custom.domain, protocol-native ONLY — no Gmail/SMTP bridge.
// Delivery is via gh:<user>/protocol-inbox Issues; the recipient decrypts
// locally and archives to IndexedDB or a private gh:<user>/mail-archive
// repo. This file is types + constants only; crypto lives in crypto.ts.
//
// ENVELOPE DESIGN (thread turn 18, as implemented here):
//   1. The plaintext (header + body + attachments) is JSON, Zstd-
//      compressed, then encrypted ONCE with a fresh random 32-byte
//      AES-256-GCM key.
//   2. That key is wrapped once per recipient with the recipient's
//      X25519 public key (fresh ephemeral encapsulation + HKDF +
//      AES-KW per recipient — see crypto.ts for the exact
//      construction; RSA-OAEP was replaced by X25519 in fix round 2).
//   3. To:/CC: live INSIDE the encrypted header, so Reply All works.
//      BCC recipients get a wrapped key but are STRIPPED from the inner
//      header — they never appear in what any other recipient decrypts.
//   4. Wrapped keys are keyed by a SHA-256 fingerprint of the recipient
//      address (first 32 hex chars), NOT by the address itself, so a
//      BCC address does not leak in the outer envelope. Honest caveat:
//      a fingerprint is a hash, not a secret — anyone who guesses an
//      address can confirm it was a recipient. The address itself is
//      never written in cleartext for BCC.
//
// SIZE NOTE (measured from real keys, fix round 2 — see crypto.ts):
//   one wrapped-key entry is 72 bytes raw (32-byte ephemeral X25519
//   public key + 40-byte AES-KW-wrapped 32-byte AES key); a published
//   X25519 public key is 32 bytes raw and its JWK JSON is 102 bytes.
//   A minimal contacts entry (address + JWK + updatedAt) is 165
//   bytes of JSON, i.e. 157.4 MiB per 1M users uncompressed — but
//   the shards are stored Zstd-compressed, and measured on 2,000 real
//   entries the compressed shard is 37.0 bytes/entry, i.e. ~35.3 MiB
//   per 1M in the stored .json.zst form, so the thread's "~40 MB per
//   1M" holds for the stored form. The thread's "~64 bytes" wrapped
//   key assumed the raw key bytes only (72 bytes once AES-KW's 8-byte
//   integrity value is counted). Nothing in this file depends on the
//   wrap algorithm — crypto.ts owns it.

/** Wire version for every mail object. Bump on any format change. */
export const MAIL_PROTOCOL_VERSION = "arknetz-mail/1";

/** A protocol mail address: local-part@custom.domain. Never a Gmail /
 *  Outlook / Yahoo address — mail is protocol-native only. */
export type MailAddress = string;

/** Max bytes for one attachment (v1.0 limit; GitHub file guidance is
 *  <25 MB per file, and mail payloads travel as ~1 KB Issues plus the
 *  sender's outbox copy — keep attachments modest). */
export const MAX_ATTACHMENT_BYTES = 10_000_000;
/** Max total attachment bytes on one message. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25_000_000;
/** A list at or above this size is a "large list": the payload is
 *  stored once and each inbox gets a ~120-byte pointer + wrapped key
 *  (thread turn 18, e.g. 50 recipients). */
export const LARGE_LIST_THRESHOLD = 50;
/** Max body characters for one message (v1.0; keeps Issues ~1 KB
 *  ciphertext for ordinary mail once compressed). */
export const MAX_BODY_CHARS = 200_000;

/** External providers mail can NEVER be sent to (protocol-native only).
 *  Compose rejects these with a plain-language reason. */
export const EXTERNAL_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "tutanota.com",
  "gmx.com",
  "aol.com",
];

/** One attachment, plaintext form (before the envelope seals it).
 *  `data` is the raw file bytes; the envelope Zstd-compresses the whole
 *  payload (so attachments are compressed) and AES-encrypts it (so
 *  they are encrypted). */
export interface MailAttachment {
  filename: string;
  mime: string;
  /** Raw bytes. Must be <= MAX_ATTACHMENT_BYTES. */
  data: Uint8Array;
}

/** The decrypted inner header + body. This is what the recipient sees
 *  after local decryption. BCC is deliberately absent: a BCC recipient
 *  is not listed here, and no other recipient can learn they were BCC'd
 *  from this object. */
export interface MailPlaintext {
  version: typeof MAIL_PROTOCOL_VERSION;
  messageId: string;
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  body: string;
  /** Unix milliseconds. */
  sentAt: number;
  attachments: MailAttachment[];
}

/** One wrapped per-message AES key. `fingerprint` is the first 32 hex
 *  chars of SHA-256(recipient address, lowercased) — see header note.
 *  The wrap is X25519 + HKDF + AES-KW (see crypto.ts): `wrappedKeyB64`
 *  is base64 of the 40-byte AES-KW-wrapped 32-byte AES key, and
 *  `ephemeralPublicKeyB64` is base64 of the 32-byte ephemeral X25519
 *  public key for this encapsulation — 72 bytes raw per entry. */
export interface WrappedKeyEntry {
  fingerprint: string;
  /** base64 of the AES-KW-wrapped 32-byte AES key (40 bytes raw). */
  wrappedKeyB64: string;
  /** base64 of the ephemeral X25519 public key (32 bytes raw). */
  ephemeralPublicKeyB64: string;
}

/** The sealed envelope: the ONLY thing that ever travels (in a GitHub
 *  Issue body) or is stored un-decrypted. `ciphertextB64` is the
 *  Zstd-compressed MailPlaintext JSON, AES-256-GCM encrypted. */
export interface EncryptedMailEnvelope {
  version: typeof MAIL_PROTOCOL_VERSION;
  messageId: string;
  threadId: string;
  from: MailAddress;
  /** To + CC addresses (public routing list — BCC is NOT here). */
  recipients: MailAddress[];
  /** Unix milliseconds. */
  sentAt: number;
  /** base64, 12-byte AES-GCM IV. */
  ivB64: string;
  /** base64 of the encrypted, compressed plaintext. */
  ciphertextB64: string;
  /** One entry per recipient (To + CC + BCC), by fingerprint. */
  wrappedKeys: WrappedKeyEntry[];
  /** Size of the compressed plaintext in bytes (for the UI + the
   *  "~1 KB ciphertext" expectation in the thread). */
  compressedBytes: number;
}

/** Large-list pointer (thread turn 18): the payload is stored ONCE
 *  (sender outbox / IA) and each inbox gets this ~120-byte pointer plus
 *  that recipient's wrapped key. The pointer itself is not secret —
 *  the wrapped key is. */
export interface MailPointer {
  kind: "arknetz-mail-pointer/1";
  /** Where the sealed payload lives, e.g.
   *  "gh:alice/mail-outbox#<messageId>" — resolved by the client. */
  payloadRef: string;
  /** SHA-256 hex of the sealed payload bytes (integrity check). */
  payloadSha256: string;
  /** Bytes of the sealed payload. */
  payloadBytes: number;
  messageId: string;
  threadId: string;
}

/** One per-inbox delivery for a large list: pointer + that recipient's
 *  wrapped key. This is what goes in the recipient's inbox Issue. */
export interface PointerDelivery {
  recipient: MailAddress;
  pointer: MailPointer;
  /** The recipient's wrapped AES key (same entry shape as the envelope). */
  wrappedKey: WrappedKeyEntry;
}

/** The assembled output of the large-list outbox writer
 *  (lists.buildLargeListOutbox): the sealed payload stored ONCE, plus
 *  one pointer delivery per recipient inbox. `payloadJson` is the
 *  single stored copy of the sealed envelope — every delivery shares
 *  the SAME `pointer` object, so the payload is never duplicated.
 *  delivery.MailDelivery.deliverLargeList stores this payload once
 *  and then delivers the pointers. */
export interface LargeListOutbox {
  /** The pointer every delivery shares (payload stored once). */
  pointer: MailPointer;
  /** Where the sealed payload lives, e.g.
   *  "gh:alice/mail-outbox#<messageId>" — resolved by the client. */
  payloadRef: string;
  /** The single stored copy: JSON.stringify of the sealed envelope. */
  payloadJson: string;
  /** One pointer delivery per recipient (pointer + wrapped key). */
  deliveries: PointerDelivery[];
  /** Recipient count (== deliveries.length). */
  recipientCount: number;
}

/** A mailing list, as stored in mail_lists.json.zst (thread turn 18),
 *  e.g. staff@computers.edu. */
export interface MailingList {
  /** List address, e.g. "staff@computers.edu". */
  address: MailAddress;
  name: string;
  /** Domain that owns the list, e.g. "computers.edu". */
  domain: string;
  members: MailAddress[];
  owner: MailAddress;
  updatedAt: number;
}

/** One entry in the global contacts directory (contacts.json.zst
 *  shards in protocol-root — see contacts.ts for the measured size:
 *  165 bytes of JSON per entry, 157.4 MiB per 1M users uncompressed,
 *  from the 32-byte X25519 public keys). */
export interface ContactEntry {
  address: MailAddress;
  displayName?: string;
  /** X25519 public key as a JWK (kty "OKP", crv "X25519", x).
   *  Published openly: anyone may encrypt TO this address with it. */
  publicKeyJwk: JsonWebKey;
  /** GitHub login that owns the address, when known. */
  githubUser?: string;
  updatedAt: number;
}

/** A user's own mail keypair (private key NEVER leaves the device;
 *  the public half is what gets published in the contacts directory). */
export interface MailKeypair {
  address: MailAddress;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** Exported public JWK, for publishing. */
  publicKeyJwk: JsonWebKey;
}

/** Shared team inbox (thread turn 17): one address such as
 *  contact@computers.edu, one shared domain keypair, encrypted
 *  individually per authorised member. */
export interface TeamInbox {
  address: MailAddress;
  domain: string;
  /** Shared domain public key (JWK) — senders encrypt to the team
   *  with this; any authorised member can open it. */
  publicKeyJwk: JsonWebKey;
  /** Per member: their address + the team PRIVATE key sealed for them
   *  (hybrid seal, see crypto.sealBytesForRecipient). */
  members: Array<{
    address: MailAddress;
    /** base64 of the sealed team private-key JWK JSON. */
    sealedTeamKeyB64: string;
  }>;
  updatedAt: number;
}

/** Folders a message can live in locally. */
export type MailFolder = "inbox" | "sent" | "archive";

/** One message as stored locally (IndexedDB or memory store). */
export interface StoredMail {
  envelope: EncryptedMailEnvelope;
  /** Filled in when the message has been decrypted locally. */
  plaintext?: MailPlaintext;
  folder: MailFolder;
  unread: boolean;
  /** GitHub Issue number in the recipient's protocol-inbox, while the
   *  message still lives there (cleared once archived/deleted). */
  issueNumber?: number;
  receivedAt: number;
  archivedAt?: number;
}

/** Shape of one record in the private mail-archive repo
 *  (gh:<user>/mail-archive, mail-archive.json.zst): the sealed envelope
 *  plus just enough metadata to list it without decrypting. */
export interface MailArchiveRecord {
  messageId: string;
  threadId: string;
  from: MailAddress;
  subject: string;
  sentAt: number;
  archivedAt: number;
  envelope: EncryptedMailEnvelope;
}
