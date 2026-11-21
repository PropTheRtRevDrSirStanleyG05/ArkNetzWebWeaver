// ArkNetzWebWeaver — protocol mail compose (Phase 1).
// READINESS-PARITY.md §3 MUST: To, CC, BCC, Reply All, subject, body,
// attachments (Zstd compressed, encrypted), drafts saved locally.
//
// Address validation is for user@custom.domain: the local part and
// the domain must be well-formed (isValidDomain from types.ts), and
// external-provider domains (Gmail/Outlook/...) are rejected with a
// plain-language reason — mail is protocol-native only, and compose
// is where that boundary is enforced, not hidden.

import { isValidDomain } from "../types.js";
import {
  importPublicKey,
  newMessageId,
  newThreadId,
  sealMail,
  type EnvelopeRecipient,
} from "./crypto.js";
import { replyAllRecipients } from "./inbox.js";
import type { ContactEntry } from "./types.js";
import {
  EXTERNAL_MAIL_DOMAINS,
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_CHARS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  type EncryptedMailEnvelope,
  type MailAddress,
  type MailAttachment,
  type MailKeypair,
  type MailPlaintext,
} from "./types.js";

/** Validate one protocol mail address. Returns an error string, or
 *  null when the address is usable. */
export function validateMailAddress(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return "address is empty";
  if (trimmed !== trimmed.toLowerCase()) {
    return `address must be lowercase: ${trimmed}`;
  }
  const parts = trimmed.split("@");
  if (parts.length !== 2) return `address must be user@custom.domain: ${trimmed}`;
  const [local, domain] = parts as [string, string];
  if (!/^[a-z0-9._%+-]+$/.test(local) || local.length > 64) {
    return `invalid local part in address: ${trimmed}`;
  }
  if (!isValidDomain(domain)) {
    return `invalid domain in address: ${trimmed}`;
  }
  if (EXTERNAL_MAIL_DOMAINS.includes(domain)) {
    return (
      `cannot send to ${trimmed}: ArkNetz mail is protocol-native only ` +
      `and cannot email Gmail, Outlook or any other outside address. The recipient needs an ArkNetz address (user@custom.domain).`
    );
  }
  return null;
}

export interface MailDraft {
  draftId: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  attachments: MailAttachment[];
  /** Present when this draft is a reply (keeps the thread). */
  threadId?: string;
  /** Message id being replied to, when this is a reply. */
  inReplyTo?: string;
  updatedAt: number;
}

export function newDraft(from: MailAddress): MailDraft {
  return {
    draftId: `draft-${newMessageId()}`,
    from,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    attachments: [],
    updatedAt: Date.now(),
  };
}

/** Validate a whole draft for sending. Returns every problem found
 *  (empty list = sendable). */
export function validateDraft(draft: MailDraft): string[] {
  const errors: string[] = [];
  const fromError = validateMailAddress(draft.from);
  if (fromError) errors.push(`From: ${fromError}`);
  if (draft.to.length === 0 && draft.cc.length === 0 && draft.bcc.length === 0) {
    errors.push("Add at least one recipient (To, CC or BCC).");
  }
  const seen = new Set<string>();
  for (const [label, list] of [
    ["To", draft.to],
    ["CC", draft.cc],
    ["BCC", draft.bcc],
  ] as const) {
    for (const addr of list) {
      const err = validateMailAddress(addr);
      if (err) errors.push(`${label}: ${err}`);
      const lower = addr.toLowerCase();
      if (seen.has(lower)) errors.push(`${label}: ${addr} is listed more than once.`);
      seen.add(lower);
    }
  }
  if (!draft.subject.trim()) errors.push("Add a subject.");
  if (draft.body.length > MAX_BODY_CHARS) {
    errors.push(`Body is too long (${draft.body.length} chars, max ${MAX_BODY_CHARS}).`);
  }
  let total = 0;
  for (const a of draft.attachments) {
    if (a.data.length > MAX_ATTACHMENT_BYTES) {
      errors.push(
        `Attachment ${a.filename} is too large (${a.data.length} bytes, max ${MAX_ATTACHMENT_BYTES}).`,
      );
    }
    total += a.data.length;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    errors.push(
      `Attachments total ${total} bytes, over the ${MAX_TOTAL_ATTACHMENT_BYTES}-byte limit.`,
    );
  }
  return errors;
}

/** Draft store interface (autosave target). Memory store for tests;
 *  IndexedDB store for the app. */
export interface DraftStore {
  list(): Promise<MailDraft[]>;
  get(draftId: string): Promise<MailDraft | undefined>;
  put(draft: MailDraft): Promise<void>;
  remove(draftId: string): Promise<void>;
}

export function createMemoryDraftStore(): DraftStore {
  const map = new Map<string, MailDraft>();
  return {
    async list() {
      return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(draftId) {
      return map.get(draftId);
    },
    async put(draft) {
      map.set(draft.draftId, draft);
    },
    async remove(draftId) {
      map.delete(draftId);
    },
  };
}

const IDB_DB = "arknetz-mail";
const IDB_DRAFT_STORE = "drafts";

export function createIndexedDBDraftStore(): DraftStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_DRAFT_STORE, { keyPath: "draftId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const withStore = async <T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => Promise<T>,
  ): Promise<T> => {
    const db = await open();
    try {
      return await fn(db.transaction(IDB_DRAFT_STORE, mode).objectStore(IDB_DRAFT_STORE));
    } finally {
      db.close();
    }
  };
  const req = <T>(r: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  return {
    async list() {
      const rows = await withStore("readonly", (s) =>
        req(s.getAll() as IDBRequest<MailDraft[]>),
      );
      return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(draftId) {
      return withStore("readonly", (s) => req(s.get(draftId) as IDBRequest<MailDraft | undefined>));
    },
    async put(draft) {
      await withStore("readwrite", async (s) => {
        await req(s.put(draft) as unknown as IDBRequest<IDBValidKey>);
      });
    },
    async remove(draftId) {
      await withStore("readwrite", async (s) => {
        await req(s.delete(draftId) as unknown as IDBRequest<undefined>);
      });
    },
  };
}

/** Autosave a draft (call on every edit — the store write is cheap
 *  and local; the coordinator debounces the calls). Returns the
 *  saved draft with an updated timestamp. */
export async function saveDraft(store: DraftStore, draft: MailDraft): Promise<MailDraft> {
  const saved: MailDraft = { ...draft, updatedAt: Date.now() };
  await store.put(saved);
  return saved;
}

/** Restore a draft on reopen (returns undefined when it is gone). */
export async function restoreDraft(
  store: DraftStore,
  draftId: string,
): Promise<MailDraft | undefined> {
  return store.get(draftId);
}

/** Start a reply draft from a decrypted message (keeps the thread;
 *  subject gets a single "Re: " prefix). */
export function replyDraft(
  original: MailPlaintext,
  replier: MailAddress,
  replyAll: boolean,
): MailDraft {
  const draft = newDraft(replier);
  draft.threadId = original.threadId;
  draft.inReplyTo = original.messageId;
  draft.subject = original.subject.toLowerCase().startsWith("re:")
    ? original.subject
    : `Re: ${original.subject}`;
  if (replyAll) {
    const { to, cc } = replyAllRecipients(original, replier);
    draft.to = to;
    draft.cc = cc;
  } else {
    draft.to = [original.from];
  }
  draft.body = `\n\n— On ${new Date(original.sentAt).toLocaleString()}, ${original.from} wrote:\n${original.body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}\n`;
  return draft;
}

/** Seal a validated draft into an envelope. `resolveKey` maps each
 *  recipient address to its published public key (contacts directory);
 *  a recipient with no published key is a hard error — the mail is
 *  NOT sent half-encrypted. The sender is NOT a recipient (their own
 *  copy goes to Sent by storing the sealed envelope locally). BCC
 *  recipients get a wrapped key but are stripped from the plaintext
 *  header — sealMail enforces the split. */
export async function buildMailFromDraft(
  draft: MailDraft,
  senderKeypair: MailKeypair,
  resolveKey: (address: MailAddress) => Promise<ContactEntry | undefined>,
  sentAt = Date.now(),
): Promise<EncryptedMailEnvelope> {
  const errors = validateDraft(draft);
  if (errors.length > 0) {
    throw new Error(`cannot send draft: ${errors.join(" ")}`);
  }
  const allRecipients = [...draft.to, ...draft.cc, ...draft.bcc];
  const recipients: EnvelopeRecipient[] = [];
  for (const address of allRecipients) {
    const contact = await resolveKey(address);
    if (!contact) {
      throw new Error(
        `no public key for ${address} in the contacts directory — cannot encrypt mail to them`,
      );
    }
    recipients.push({
      address,
      publicKey: await importPublicKey(contact.publicKeyJwk),
    });
  }
  const plain: MailPlaintext = {
    version: "arknetz-mail/1",
    messageId: newMessageId(),
    threadId: draft.threadId ?? newThreadId(),
    from: draft.from,
    to: [...draft.to],
    cc: [...draft.cc],
    subject: draft.subject.trim(),
    body: draft.body,
    sentAt,
    attachments: draft.attachments.map((a) => ({ ...a })),
  };
  if (senderKeypair.address.toLowerCase() !== draft.from.toLowerCase()) {
    throw new Error(
      `draft From (${draft.from}) does not match the signing-in account (${senderKeypair.address})`,
    );
  }
  return sealMail(plain, recipients, [...draft.bcc]);
}
