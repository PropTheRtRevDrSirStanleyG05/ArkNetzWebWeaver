// ArkNetzWebWeaver — protocol mail delivery (Phase 1).
// Thread turn 16: delivery via gh:<user>/protocol-inbox Issues.
// Any authenticated user can drop an encrypted ~1 KB ciphertext into
// a recipient's inbox (as a GitHub Issue); they cannot delete others'
// mail. The recipient decrypts locally, moves the mail to IndexedDB
// or a private gh:<user>/mail-archive repo, then closes/deletes the
// inbox Issue, so the public inbox stays near 0 KB.
//
// INTERPRETATION NOTE: the thread writes the inbox as
// "gh:<user>/protocol-inbox" — read literally, that is a GitHub repo
// named `protocol-inbox` under the recipient's account. This module
// uses that reading (owner = recipient's GitHub login, repo =
// "protocol-inbox"; archive repo = "mail-archive"). If Stanley later
// decides protocol-inbox is a folder inside the per-user blog-data
// repo instead, only inboxRepoName() and the URL builders change.
//
// ISSUE FORMAT (v1.0 protocol choice — the thread fixed delivery via
// Issues and the ~1 KB ciphertext size, but not the exact title/body,
// so this file DEFINES it, versioned by MAIL_PROTOCOL_VERSION):
//   title: "ARKNETZ-MAIL <messageId>"
//   labels: ["arknetz-mail"]
//   body: a short human-readable note + the envelope JSON inside a
//     ```arknetz-mail fenced block. Anything outside the fence is
//     ignored on parse, so GitHub's rendering never corrupts the
//     payload.
// No network happens here except through the injected fetch function
// (tests inject a mock; the app injects an authenticated GitHub API
// fetch). No real GitHub call is ever made by this module on its own.

import { GITHUB_API_BASE } from "../config.js";
import {
  MAIL_PROTOCOL_VERSION,
  type EncryptedMailEnvelope,
  type LargeListOutbox,
  type MailAddress,
  type PointerDelivery,
} from "./types.js";

/** SHA-256 hex of a UTF-8 string (shared helper; lists.ts uses it
 *  for payload integrity hashes). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The recipient's inbox repo name (see interpretation note above). */
export function inboxRepoName(): string {
  return "protocol-inbox";
}

/** The recipient's private archive repo name. */
export function mailArchiveRepoName(): string {
  return "mail-archive";
}

export function inboxIssuesUrl(githubUser: string): string {
  return `${GITHUB_API_BASE}/repos/${githubUser}/${inboxRepoName()}/issues`;
}

export function inboxIssueUrl(githubUser: string, issueNumber: number): string {
  return `${inboxIssuesUrl(githubUser)}/${issueNumber}`;
}

/** Exact title for a mail Issue. The messageId makes it unique and
 *  lets the recipient dedupe re-deliveries. */
export function mailIssueTitle(messageId: string): string {
  return `ARKNETZ-MAIL ${messageId}`;
}

/** Exact body for a mail Issue: human note + fenced envelope JSON.
 *  The fence language tag `arknetz-mail` is the parse marker. */
export function mailIssueBody(envelope: EncryptedMailEnvelope): string {
  return [
    "Encrypted ArkNetz mail — open it in ArkNetzWebWeaver to decrypt it.",
    `From: ${envelope.from}`,
    `Message: ${envelope.messageId}`,
    "",
    "```arknetz-mail",
    JSON.stringify(envelope),
    "```",
    "",
    "This message is end-to-end encrypted. Only the intended recipient can read it.",
  ].join("\n");
}

/** Body for a large-list pointer delivery: same note, pointer JSON in
 *  the fence instead of the full envelope. */
export function pointerIssueBody(delivery: PointerDelivery): string {
  return [
    "Encrypted ArkNetz mail (mailing list) — open it in ArkNetzWebWeaver to decrypt it.",
    `Message: ${delivery.pointer.messageId}`,
    "",
    "```arknetz-mail-pointer",
    JSON.stringify(delivery),
    "```",
    "",
    "This message is end-to-end encrypted. Only the intended recipient can read it.",
  ].join("\n");
}

/** The exact GitHub API call that delivers one envelope to one
 *  recipient's inbox. The caller performs it with an authenticated
 *  fetch (token = the SENDER's GitHub token — any authenticated user
 *  may open an Issue in a public inbox repo). */
export interface GithubApiCall {
  method: "POST" | "PATCH" | "GET";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Per-user key rule (fix round 3, 2026-11-20): mail is sent with
 *  the SENDER's own GitHub token. An empty/missing token throws before
 *  the call is built — mail never goes out under an empty `Bearer `
 *  header, and there is no shared mail token to fall back to. */
export function requireOwnMailToken(token: string, what: string): void {
  if (!token?.trim()) {
    throw new Error(
      `protocol mail ${what} needs your own GitHub token — sign in with your own GitHub account first. There is no shared mail token.`,
    );
  }
}

export function buildDeliverIssueCall(
  envelope: EncryptedMailEnvelope,
  recipientGithubUser: string,
  senderToken: string,
): GithubApiCall {
  requireOwnMailToken(senderToken, "deliver");
  return {
    method: "POST",
    url: inboxIssuesUrl(recipientGithubUser),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${senderToken}`,
      "User-Agent": "ArkNetzWebWeaver/1.0",
    },
    body: {
      title: mailIssueTitle(envelope.messageId),
      body: mailIssueBody(envelope),
      labels: ["arknetz-mail"],
    },
  };
}

/** The exact GitHub API call that delivers one large-list pointer to
 *  one recipient's inbox. */
export function buildDeliverPointerCall(
  delivery: PointerDelivery,
  recipientGithubUser: string,
  senderToken: string,
): GithubApiCall {
  requireOwnMailToken(senderToken, "deliver");
  return {
    method: "POST",
    url: inboxIssuesUrl(recipientGithubUser),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${senderToken}`,
      "User-Agent": "ArkNetzWebWeaver/1.0",
    },
    body: {
      title: mailIssueTitle(delivery.pointer.messageId),
      body: pointerIssueBody(delivery),
      labels: ["arknetz-mail"],
    },
  };
}

/** The exact GitHub API call that closes an inbox Issue after the
 *  recipient has archived the mail (the inbox stays near 0 KB). */
export function buildCloseIssueCall(
  githubUser: string,
  issueNumber: number,
  token: string,
): GithubApiCall {
  requireOwnMailToken(token, "close");
  return {
    method: "PATCH",
    url: inboxIssueUrl(githubUser, issueNumber),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ArkNetzWebWeaver/1.0",
    },
    body: { state: "closed" },
  };
}

/** The exact GitHub API call that lists open mail Issues (client pull
 *  on open — there is no push server, READINESS-PARITY §3). */
export function buildListInboxIssuesCall(
  githubUser: string,
  token: string,
): GithubApiCall {
  requireOwnMailToken(token, "inbox pull");
  return {
    method: "GET",
    url: `${inboxIssuesUrl(githubUser)}?labels=arknetz-mail&state=open&per_page=100`,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ArkNetzWebWeaver/1.0",
    },
  };
}

/** Extract the envelope JSON from an Issue body. Returns null (not a
 *  throw) when the body has no arknetz-mail fence — the poller skips
 *  such Issues and counts them, instead of failing the whole pull. */
export function parseMailIssueBody(body: string): EncryptedMailEnvelope | null {
  const m = /```arknetz-mail\s*\n([\s\S]*?)\n```/.exec(body);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]!) as Record<string, unknown>;
    if (parsed.version !== MAIL_PROTOCOL_VERSION) return null;
    if (typeof parsed.messageId !== "string" || typeof parsed.ciphertextB64 !== "string") {
      return null;
    }
    return parsed as unknown as EncryptedMailEnvelope;
  } catch {
    return null;
  }
}

/** Extract a pointer delivery from an Issue body (large-list mail). */
export function parsePointerIssueBody(body: string): PointerDelivery | null {
  const m = /```arknetz-mail-pointer\s*\n([\s\S]*?)\n```/.exec(body);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]!) as Record<string, unknown>;
    const pointer = parsed.pointer as Record<string, unknown> | undefined;
    if (!pointer || pointer.kind !== "arknetz-mail-pointer/1") return null;
    return parsed as unknown as PointerDelivery;
  } catch {
    return null;
  }
}

/** Where a large-list payload is stored, exactly once, before its
 *  pointers are delivered (injected — the app writes the sender's
 *  outbox copy via the GitHub Contents API to gh:<sender>/mail-outbox
 *  or to IA; tests inject a recording mock). `store` must be
 *  idempotent for the same payloadRef + payloadJson: a retry after a
 *  mid-send failure re-stores the identical bytes. */
export interface LargeListPayloadStore {
  store(payloadRef: string, payloadJson: string): Promise<void>;
}

/** Minimal GitHub API fetch shape (injected — mocked in tests). */
export type GithubApiFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** One pulled inbox Issue, parsed (or skipped with a reason). */
export interface PulledMail {
  issueNumber: number;
  envelope: EncryptedMailEnvelope | null;
  pointer: PointerDelivery | null;
  skippedReason?: string;
}

/** Delivery client: creates mail Issues and pulls the inbox. All
 *  network goes through the injected fetch; the token is supplied per
 *  call by the app (never stored here). */
export class MailDelivery {
  constructor(private readonly fetchFn: GithubApiFetch) {}

  private async run(call: GithubApiCall): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchFn(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `GitHub API ${call.method} ${call.url} failed with HTTP ${res.status}: ${String(text).slice(0, 200)}`,
      );
    }
    return { status: res.status, json };
  }

  /** Deliver one sealed envelope to one recipient's inbox Issue.
   *  Returns the created Issue number. */
  async deliver(
    envelope: EncryptedMailEnvelope,
    recipientGithubUser: string,
    senderToken: string,
  ): Promise<number> {
    const { json } = await this.run(
      buildDeliverIssueCall(envelope, recipientGithubUser, senderToken),
    );
    const issue = json as Record<string, unknown>;
    if (typeof issue.number !== "number") {
      throw new Error("GitHub did not return an Issue number for the delivered mail");
    }
    return issue.number;
  }

  /** Deliver one large-list pointer to one recipient's inbox Issue. */
  async deliverPointer(
    delivery: PointerDelivery,
    recipientGithubUser: string,
    senderToken: string,
  ): Promise<number> {
    const { json } = await this.run(
      buildDeliverPointerCall(delivery, recipientGithubUser, senderToken),
    );
    const issue = json as Record<string, unknown>;
    if (typeof issue.number !== "number") {
      throw new Error("GitHub did not return an Issue number for the delivered mail pointer");
    }
    return issue.number;
  }

  /** THE LARGE-LIST SEND (fix round 2, item 6): store the sealed
   *  payload ONCE, then deliver one pointer per recipient inbox.
   *  `resolveGithubUser` maps each recipient address to the GitHub
   *  login that owns their protocol-inbox repo — a recipient with no
   *  known login throws before anything is stored, so a send never
   *  half-starts. Ordering is store-then-deliver: the payload is in
   *  place before the first pointer can be resolved, and a retry
   *  after a mid-send failure re-stores the identical bytes
   *  (idempotent store) and re-delivers only the pointers the caller
   *  retries — recipients dedupe re-delivered pointers by messageId.
   *  Returns the created Issue number per recipient, in delivery
   *  order. */
  async deliverLargeList(
    outbox: LargeListOutbox,
    resolveGithubUser: (address: MailAddress) => string | undefined,
    senderToken: string,
    payloadStore: LargeListPayloadStore,
  ): Promise<number[]> {
    const githubUsers = outbox.deliveries.map((d) => {
      const user = resolveGithubUser(d.recipient);
      if (!user) {
        throw new Error(
          `no GitHub login known for ${d.recipient} — cannot deliver their mail pointer`,
        );
      }
      return user;
    });
    // Store exactly once, before any pointer goes out.
    await payloadStore.store(outbox.payloadRef, outbox.payloadJson);
    const issueNumbers: number[] = [];
    for (let i = 0; i < outbox.deliveries.length; i++) {
      issueNumbers.push(
        await this.deliverPointer(outbox.deliveries[i]!, githubUsers[i]!, senderToken),
      );
    }
    return issueNumbers;
  }

  /** Close an inbox Issue after its mail was archived (inbox stays
   *  near 0 KB). */
  async closeDelivered(
    githubUser: string,
    issueNumber: number,
    token: string,
  ): Promise<void> {
    await this.run(buildCloseIssueCall(githubUser, issueNumber, token));
  }

  /** Pull the inbox: list open mail Issues and parse each one.
   *  Issues without a parseable envelope are reported as skipped —
   *  one bad Issue never blocks the rest of the inbox. This is the
   *  v1.0 "pull on open" model: no push server exists. */
  async pollInbox(
    githubUser: string,
    token: string,
  ): Promise<{ pulled: PulledMail[]; skipped: number }> {
    const call = buildListInboxIssuesCall(githubUser, token);
    const res = await this.fetchFn(call.url, {
      method: call.method,
      headers: call.headers,
    });
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `GitHub inbox pull failed with HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const issues = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(issues)) throw new Error("GitHub inbox pull returned no issue list");
    const pulled: PulledMail[] = [];
    let skipped = 0;
    for (const issue of issues) {
      const number = typeof issue.number === "number" ? issue.number : -1;
      const body = typeof issue.body === "string" ? issue.body : "";
      const envelope = parseMailIssueBody(body);
      if (envelope) {
        pulled.push({ issueNumber: number, envelope, pointer: null });
        continue;
      }
      const pointer = parsePointerIssueBody(body);
      if (pointer) {
        pulled.push({ issueNumber: number, envelope: null, pointer });
        continue;
      }
      skipped++;
      pulled.push({
        issueNumber: number,
        envelope: null,
        pointer: null,
        skippedReason: "no parseable arknetz-mail fence in Issue body",
      });
    }
    return { pulled, skipped };
  }
}
