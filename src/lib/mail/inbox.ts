// ArkNetzWebWeaver — protocol mail inbox (Phase 1).
// READINESS-PARITY.md §3 MUST: list, unread, search by sender /
// subject / date (and body), threaded conversations, open/decrypt
// locally, archive to IndexedDB or the private mail-archive repo,
// delete/close the inbox Issue so the public inbox stays near 0 KB.
//
// Storage is injected through the MailStore interface: the memory
// store is used in tests and as the offline fallback; the IndexedDB
// store is what the app wires in the browser. Threading groups by
// threadId first; messages with no threadId fall back to normalised
// subject + participant set, so mail sealed before thread ids existed
// still threads.

import { openMail } from "./crypto.js";
import { buildCloseIssueCall } from "./delivery.js";
import {
  type EncryptedMailEnvelope,
  type MailAddress,
  type MailArchiveRecord,
  type MailFolder,
  type MailKeypair,
  type MailPlaintext,
  type StoredMail,
} from "./types.js";

/** Minimal store interface for locally held mail. */
export interface MailStore {
  list(folder: MailFolder): Promise<StoredMail[]>;
  get(messageId: string): Promise<StoredMail | undefined>;
  put(mail: StoredMail): Promise<void>;
  remove(messageId: string): Promise<void>;
}

export function createMemoryMailStore(): MailStore {
  const map = new Map<string, StoredMail>();
  return {
    async list(folder) {
      return [...map.values()]
        .filter((m) => m.folder === folder)
        .sort((a, b) => b.receivedAt - a.receivedAt);
    },
    async get(messageId) {
      return map.get(messageId);
    },
    async put(mail) {
      map.set(mail.envelope.messageId, mail);
    },
    async remove(messageId) {
      map.delete(messageId);
    },
  };
}

const IDB_DB = "arknetz-mail";
const IDB_STORE = "messages";

export function createIndexedDBMailStore(): MailStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(IDB_STORE, {
          keyPath: "messageId",
        });
        store.createIndex("folder", "folder", { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const record = (m: StoredMail): Record<string, unknown> => ({
    ...m,
    messageId: m.envelope.messageId,
  });
  const unrecord = (r: Record<string, unknown>): StoredMail => {
    const { messageId: _messageId, ...rest } = r;
    return rest as unknown as StoredMail;
  };
  return {
    async list(folder) {
      const db = await open();
      try {
        const store = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE);
        const index = store.index("folder");
        const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
          const req = index.getAll(folder);
          req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
          req.onerror = () => reject(req.error);
        });
        return rows
          .map(unrecord)
          .sort((a, b) => b.receivedAt - a.receivedAt);
      } finally {
        db.close();
      }
    },
    async get(messageId) {
      const db = await open();
      try {
        const store = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE);
        const row = await new Promise<Record<string, unknown> | undefined>(
          (resolve, reject) => {
            const req = store.get(messageId);
            req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
            req.onerror = () => reject(req.error);
          },
        );
        return row ? unrecord(row) : undefined;
      } finally {
        db.close();
      }
    },
    async put(mail) {
      const db = await open();
      try {
        const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
        await new Promise<void>((resolve, reject) => {
          const req = store.put(record(mail));
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    async remove(messageId) {
      const db = await open();
      try {
        const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
        await new Promise<void>((resolve, reject) => {
          const req = store.delete(messageId);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

/** Normalise a subject for threading fallback: strip Re:/Fwd: etc.,
 *  collapse whitespace, lowercase. */
export function normaliseSubject(subject: string): string {
  return subject
    .replace(/^(re|fwd|fw)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Thread key for a message: its threadId when present, else
 *  normalised subject + sorted participant set. */
export function threadKeyFor(mail: StoredMail): string {
  const plain = mail.plaintext;
  if (plain?.threadId) return `id:${plain.threadId}`;
  if (mail.envelope.threadId) return `id:${mail.envelope.threadId}`;
  const subject = normaliseSubject(plain?.subject ?? "");
  const participants = [
    ...(plain ? [plain.from, ...plain.to, ...plain.cc] : [mail.envelope.from]),
  ]
    .map((a) => a.toLowerCase())
    .sort()
    .join(",");
  return `subj:${subject}|${participants}`;
}

export interface Thread {
  threadId: string;
  subject: string;
  participants: MailAddress[];
  messages: StoredMail[];
  unreadCount: number;
  latestAt: number;
}

export interface InboxQuery {
  folder?: MailFolder;
  /** Free text matched against sender, subject, body, and date. */
  query?: string;
  unreadOnly?: boolean;
  /** ISO date (YYYY-MM-DD) — matches messages sent on that day. */
  date?: string;
  /** Unix ms range, inclusive. */
  sentAfter?: number;
  sentBefore?: number;
}

/** Build the Reply All recipient lists for a decrypted message, from
 *  the perspective of `replier`. The replier is removed from To/CC;
 *  everyone else stays. BCC never appears here — it was stripped from
 *  the inner header at seal time, so a replier cannot leak it. */
export function replyAllRecipients(
  plain: MailPlaintext,
  replier: MailAddress,
): { to: MailAddress[]; cc: MailAddress[] } {
  const me = replier.toLowerCase();
  const to = [plain.from, ...plain.to].filter((a) => a.toLowerCase() !== me);
  const cc = plain.cc.filter((a) => a.toLowerCase() !== me);
  return { to: [...new Set(to)], cc: [...new Set(cc)] };
}

/** Build the mail-archive repo record for one stored message (the
 *  shape that gets Zstd-compressed into mail-archive.json.zst in
 *  gh:<user>/mail-archive). The envelope stays sealed — the archive
 *  never holds a decrypted copy. Throws when the message was never
 *  decrypted (no subject to index by). */
export function buildMailArchiveRecord(
  mail: StoredMail,
  archivedAt = Date.now(),
): MailArchiveRecord {
  if (!mail.plaintext) {
    throw new Error(
      `cannot archive ${mail.envelope.messageId} before decrypting it — open it first`,
    );
  }
  return {
    messageId: mail.envelope.messageId,
    threadId: mail.envelope.threadId,
    from: mail.envelope.from,
    subject: mail.plaintext.subject,
    sentAt: mail.envelope.sentAt,
    archivedAt,
    envelope: mail.envelope,
  };
}

/** The inbox: list / search / thread / open / archive / delete over a
 *  MailStore. Decryption needs the owner's keypair and happens only
 *  here, locally — envelopes are never decrypted anywhere else. */
export class Inbox {
  constructor(
    private readonly store: MailStore,
    private readonly keypair: MailKeypair,
  ) {}

  /** Receive a sealed envelope (from a poll): store it unread in the
   *  inbox, WITHOUT decrypting — decryption happens on open, so a
   *  bulk pull never blocks on crypto. */
  async receive(
    envelope: EncryptedMailEnvelope,
    issueNumber?: number,
  ): Promise<StoredMail> {
    const existing = await this.store.get(envelope.messageId);
    if (existing) return existing;
    const mail: StoredMail = {
      envelope,
      folder: "inbox",
      unread: true,
      issueNumber,
      receivedAt: Date.now(),
    };
    await this.store.put(mail);
    return mail;
  }

  /** Open a message: decrypt locally with the owner's private key,
   *  store the plaintext, mark read. Throws when the envelope is not
   *  for this owner (see crypto.openMail). */
  async open(messageId: string): Promise<MailPlaintext> {
    const mail = await this.store.get(messageId);
    if (!mail) throw new Error(`no such message in the local store: ${messageId}`);
    if (mail.plaintext) {
      if (mail.unread) {
        mail.unread = false;
        await this.store.put(mail);
      }
      return mail.plaintext;
    }
    const plain = await openMail(
      mail.envelope,
      this.keypair.address,
      this.keypair.privateKey,
    );
    mail.plaintext = plain;
    mail.unread = false;
    await this.store.put(mail);
    return plain;
  }

  async list(folder: MailFolder = "inbox"): Promise<StoredMail[]> {
    return this.store.list(folder);
  }

  async unreadCount(folder: MailFolder = "inbox"): Promise<number> {
    return (await this.store.list(folder)).filter((m) => m.unread).length;
  }

  async markRead(messageId: string, read = true): Promise<void> {
    const mail = await this.store.get(messageId);
    if (!mail) throw new Error(`no such message in the local store: ${messageId}`);
    mail.unread = !read;
    await this.store.put(mail);
  }

  /** Search the local store. Matches sender, subject, body (only for
   *  messages already decrypted — sealed bodies cannot be searched),
   *  and date (YYYY-MM-DD, or a sentAfter/sentBefore range). */
  async search(q: InboxQuery): Promise<StoredMail[]> {
    const folder = q.folder ?? "inbox";
    let mails = await this.store.list(folder);
    if (q.unreadOnly) mails = mails.filter((m) => m.unread);
    if (typeof q.sentAfter === "number") {
      mails = mails.filter((m) => m.envelope.sentAt >= (q.sentAfter as number));
    }
    if (typeof q.sentBefore === "number") {
      mails = mails.filter((m) => m.envelope.sentAt <= (q.sentBefore as number));
    }
    if (q.date) {
      mails = mails.filter(
        (m) => new Date(m.envelope.sentAt).toISOString().slice(0, 10) === q.date,
      );
    }
    const query = (q.query ?? "").trim().toLowerCase();
    if (query) {
      mails = mails.filter((m) => {
        const hay = [
          m.envelope.from,
          m.plaintext?.subject ?? "",
          m.plaintext?.body ?? "",
          ...(m.plaintext ? [...m.plaintext.to, ...m.plaintext.cc] : []),
          new Date(m.envelope.sentAt).toISOString().slice(0, 10),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(query);
      });
    }
    return mails;
  }

  /** Threaded conversations in a folder, newest message first inside
   *  each thread, threads ordered by latest message. */
  async threads(folder: MailFolder = "inbox"): Promise<Thread[]> {
    const mails = await this.store.list(folder);
    const byKey = new Map<string, StoredMail[]>();
    for (const m of mails) {
      const key = threadKeyFor(m);
      const list = byKey.get(key) ?? [];
      list.push(m);
      byKey.set(key, list);
    }
    const out: Thread[] = [];
    for (const [key, messages] of byKey) {
      messages.sort((a, b) => a.envelope.sentAt - b.envelope.sentAt);
      const first = messages[0]!;
      const participants = [...new Set(messages.flatMap((m) => [m.envelope.from]))];
      out.push({
        threadId: first.plaintext?.threadId ?? first.envelope.threadId ?? key,
        subject: first.plaintext?.subject ?? "(no subject)",
        participants,
        messages,
        unreadCount: messages.filter((m) => m.unread).length,
        latestAt: messages[messages.length - 1]!.envelope.sentAt,
      });
    }
    out.sort((a, b) => b.latestAt - a.latestAt);
    return out;
  }

  /** Archive a message: move it to the archive folder locally and
   *  return its mail-archive repo record (the coordinator commits
   *  that record to gh:<user>/mail-archive). The inbox Issue is NOT
   *  closed here — call delete() after the archive commit lands, or
   *  pass closeIssue to close it in the same step. */
  async archive(messageId: string): Promise<MailArchiveRecord> {
    const mail = await this.store.get(messageId);
    if (!mail) throw new Error(`no such message in the local store: ${messageId}`);
    if (!mail.plaintext) await this.open(messageId);
    const stored = await this.store.get(messageId);
    if (!stored) throw new Error(`message vanished while archiving: ${messageId}`);
    const record = buildMailArchiveRecord(stored);
    stored.folder = "archive";
    stored.archivedAt = record.archivedAt;
    await this.store.put(stored);
    return record;
  }

  /** Delete a message locally and return the exact GitHub API call
   *  that closes its inbox Issue (when it still has one). The caller
   *  performs the call — this module never calls GitHub itself. When
   *  the message has no Issue number (already archived from local
   *  storage), closeCall is null. */
  async delete(
    messageId: string,
    githubUser?: string,
    token?: string,
  ): Promise<{ closeCall: ReturnType<typeof buildCloseIssueCall> | null }> {
    const mail = await this.store.get(messageId);
    if (!mail) throw new Error(`no such message in the local store: ${messageId}`);
    let closeCall: ReturnType<typeof buildCloseIssueCall> | null = null;
    if (mail.issueNumber !== undefined && githubUser && token) {
      closeCall = buildCloseIssueCall(githubUser, mail.issueNumber, token);
    }
    await this.store.remove(messageId);
    return { closeCall };
  }
}
