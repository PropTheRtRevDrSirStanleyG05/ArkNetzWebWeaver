// ArkNetzWebWeaver — protocol mail UI copy + view models (Phase 1).
// NO DOM here: pure functions returning view data. The coordinator
// wires these into the shell UI later. Copy is plain English, and the
// protocol-native boundary is stated plainly (READINESS-PARITY §3):
// ArkNetz mail cannot email Gmail/Outlook, and cannot receive from
// them — by design, not by accident.

import type { Thread } from "./inbox.js";
import type { StoredMail } from "./types.js";
import type { MailDraft } from "./compose.js";

/** The boundary notice, shown in the inbox and in compose. Worded
 *  once, here, so every surface says the same thing. */
export const MAIL_ONLY_PROTOCOL_NOTICE =
  "ArkNetz mail is protocol-native only: you can mail any ArkNetz address " +
  "(user@custom.domain), but you cannot email a Gmail, Outlook or other " +
  "outside address, and outside mail cannot reach you here. That is by " +
  "design — bridging to Gmail would need a paid relay and spam monitoring, " +
  "and keeping mail inside the protocol means zero spam from outside and " +
  "end-to-end encryption on every message.";

export const MAIL_DELIVERY_NOTICE =
  "Delivery is not instant: mail travels as an encrypted note in the " +
  "recipient's inbox and is picked up when they open ArkNetzWebWeaver. " +
  "Expect seconds to minutes, not a push notification.";

export const MAIL_PRIVACY_NOTICE =
  "Every message is end-to-end encrypted. Only the people you address it " +
  "to can read it — not the network, not the app, not anyone running a " +
  "registry. BCC recipients are never named in the message itself.";

export const MAIL_EMPTY_INBOX_COPY =
  "No mail yet. When someone mails your ArkNetz address, their encrypted " +
  "message appears here after you open the inbox.";

export const MAIL_NO_KEY_COPY =
  "This address has no published public key in the contacts directory, " +
  "so mail to them cannot be encrypted. Ask them to sign in once — " +
  "their key is published on first sign-in.";

export interface InboxRow {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  sentAt: number;
  sentAtLabel: string;
  unread: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  folder: string;
}

export interface InboxViewModel {
  rows: InboxRow[];
  totalCount: number;
  unreadCount: number;
  emptyCopy: string;
  notice: string;
}

export function formatSentAt(sentAt: number, now = Date.now()): string {
  const d = new Date(sentAt);
  const today = new Date(now).toDateString() === d.toDateString();
  if (today) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const thisYear = new Date(now).getFullYear() === d.getFullYear();
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

export function snippetOf(body: string, maxChars = 120): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

/** Inbox list view model: newest first, with unread counts and
 *  snippets. Sealed (never opened) messages show "(encrypted — open
 *  to read)" as the subject line instead of a guessed one. */
export function inboxViewModel(mails: StoredMail[]): InboxViewModel {
  const sorted = [...mails].sort((a, b) => b.envelope.sentAt - a.envelope.sentAt);
  return {
    rows: sorted.map((m) => ({
      messageId: m.envelope.messageId,
      threadId: m.envelope.threadId,
      from: m.envelope.from,
      subject: m.plaintext?.subject ?? "(encrypted — open to read)",
      snippet: m.plaintext ? snippetOf(m.plaintext.body) : "",
      sentAt: m.envelope.sentAt,
      sentAtLabel: formatSentAt(m.envelope.sentAt),
      unread: m.unread,
      hasAttachments: (m.plaintext?.attachments.length ?? 0) > 0,
      attachmentCount: m.plaintext?.attachments.length ?? 0,
      folder: m.folder,
    })),
    totalCount: mails.length,
    unreadCount: mails.filter((m) => m.unread).length,
    emptyCopy: MAIL_EMPTY_INBOX_COPY,
    notice: MAIL_ONLY_PROTOCOL_NOTICE,
  };
}

export interface ThreadViewModel {
  threadId: string;
  subject: string;
  participants: string[];
  unreadCount: number;
  messages: Array<{
    messageId: string;
    from: string;
    to: string[];
    cc: string[];
    sentAtLabel: string;
    body: string;
    attachments: Array<{ filename: string; mime: string; bytes: number }>;
    unread: boolean;
  }>;
}

export function threadViewModel(thread: Thread): ThreadViewModel {
  return {
    threadId: thread.threadId,
    subject: thread.subject,
    participants: thread.participants,
    unreadCount: thread.unreadCount,
    messages: thread.messages.map((m) => ({
      messageId: m.envelope.messageId,
      from: m.envelope.from,
      to: m.plaintext?.to ?? [],
      cc: m.plaintext?.cc ?? [],
      sentAtLabel: formatSentAt(m.envelope.sentAt),
      body: m.plaintext?.body ?? "",
      attachments: (m.plaintext?.attachments ?? []).map((a) => ({
        filename: a.filename,
        mime: a.mime,
        bytes: a.data.length,
      })),
      unread: m.unread,
    })),
  };
}

export interface ComposeViewModel {
  draftId: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: Array<{ filename: string; mime: string; bytes: number }>;
  errors: string[];
  canSend: boolean;
  notice: string;
  deliveryNotice: string;
}

/** Compose view model: draft fields as display strings + validation
 *  errors + whether Send is enabled. */
export function composeViewModel(
  draft: MailDraft,
  errors: string[],
): ComposeViewModel {
  return {
    draftId: draft.draftId,
    from: draft.from,
    to: draft.to.join(", "),
    cc: draft.cc.join(", "),
    bcc: draft.bcc.join(", "),
    subject: draft.subject,
    body: draft.body,
    attachments: draft.attachments.map((a) => ({
      filename: a.filename,
      mime: a.mime,
      bytes: a.data.length,
    })),
    errors,
    canSend: errors.length === 0,
    notice: MAIL_ONLY_PROTOCOL_NOTICE,
    deliveryNotice: MAIL_DELIVERY_NOTICE,
  };
}
