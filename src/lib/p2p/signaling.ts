// ArkNetzWebWeaver — P2P signaling over GitHub.
// There is no signaling server. Signaling messages travel as GitHub
// Issues in the recipient's `protocol-inbox` repo — the same repo, the
// same permissions, and the same Issue machinery as mail delivery
// (src/lib/mail/delivery.ts). Every signal is SEALED to the
// recipient's X25519 mail public key before it is posted, because an
// SDP offer and its ICE candidates contain the sender's IP addresses:
// posting them in cleartext would publish both peers' IPs to the
// world. A peer with no published mail public key cannot be signaled
// — the handshake refuses before any Issue is created, and the
// feature falls back to GitHub.
//
// All network goes through the injected fetch function (tests inject a
// mock; the app injects an authenticated GitHub API fetch). No real
// GitHub call is ever made by this module on its own.

import { GITHUB_API_BASE, RAW_GITHUB_BASE } from "../config.js";
import { siteRepoName } from "../publish.js";
import type { GithubFetchFn } from "../publish.js";
import {
  importPublicKey,
  openSealedBytes,
  sealBytesForRecipient,
} from "../mail/crypto.js";
import type { MailAddress, WrappedKeyEntry } from "../mail/types.js";
import { parsePeerAd } from "./identity.js";
import type { PeerAd } from "./types.js";
import {
  SIGNAL_KINDS,
  SIGNAL_VERSION,
  type SignalKind,
  type SignalMessage,
} from "./types.js";

/** Label marking signal Issues in the inbox. */
export const SIGNAL_ISSUE_LABEL = "arknetz-signal";
/** Fence language tag for the sealed signal envelope in an Issue body. */
export const SIGNAL_FENCE = "arknetz-signal";

/** Exact title for a signal Issue. The signalId makes it unique and
 *  lets the recipient dedupe re-deliveries. */
export function signalIssueTitle(signalId: string): string {
  return `ARKNETZ-SIGNAL ${signalId}`;
}

/** The sealed form of a signal message, as stored in the Issue body:
 *  the same envelope shape as sealBytesForRecipient returns. */
export interface SealedSignal {
  ivB64: string;
  ciphertextB64: string;
  wrappedKey: WrappedKeyEntry;
}

/** Exact body for a signal Issue: a human note + the sealed envelope
 *  inside a fenced block. Anything outside the fence is ignored on
 *  parse, so GitHub's rendering never corrupts the payload. The body
 *  deliberately does NOT name the peers, the session, or the signal
 *  kind — that information is inside the sealed envelope. */
export function signalIssueBody(sealed: SealedSignal): string {
  return [
    "Encrypted ArkNetz peer signal — open it in ArkNetzWebWeaver to process it.",
    "",
    "```arknetz-signal",
    JSON.stringify(sealed),
    "```",
    "",
    "This message is end-to-end encrypted. Only the intended recipient can read it.",
  ].join("\n");
}

/** Extract the sealed envelope from an Issue body. Null (not a throw)
 *  when the body has no arknetz-signal fence — the poller skips such
 *  Issues and counts them, instead of failing the whole pull. */
export function parseSignalIssueBody(body: string): SealedSignal | null {
  const m = /```arknetz-signal\s*\n([\s\S]*?)\n```/.exec(body);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]!) as Record<string, unknown>;
    if (
      typeof parsed.ivB64 !== "string" ||
      typeof parsed.ciphertextB64 !== "string" ||
      typeof parsed.wrappedKey !== "object" ||
      parsed.wrappedKey === null
    ) {
      return null;
    }
    return parsed as unknown as SealedSignal;
  } catch {
    return null;
  }
}

/** Validate a decrypted signal message. Throws with the exact problem
 *  — a corrupt signal is never acted on. */
export function parseSignalMessage(raw: unknown): SignalMessage {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("signal message is not an object");
  }
  const s = raw as Record<string, unknown>;
  if (s.v !== SIGNAL_VERSION) {
    throw new Error(
      `signal message has unsupported version ${String(s.v)} (this client knows v${SIGNAL_VERSION})`,
    );
  }
  if (typeof s.kind !== "string" || !(SIGNAL_KINDS as string[]).includes(s.kind)) {
    throw new Error(`signal message has an unknown kind: ${String(s.kind)}`);
  }
  const kind = s.kind as SignalKind;
  if (typeof s.signalId !== "string" || !s.signalId) {
    throw new Error("signal message has no signalId");
  }
  if (typeof s.sessionId !== "string" || !s.sessionId) {
    throw new Error("signal message has no sessionId");
  }
  if (typeof s.fromPeerId !== "string" || !s.fromPeerId) {
    throw new Error("signal message has no fromPeerId");
  }
  if (typeof s.toPeerId !== "string" || !s.toPeerId) {
    throw new Error("signal message has no toPeerId");
  }
  if (typeof s.fromAddress !== "string" || !s.fromAddress.includes("@")) {
    throw new Error("signal message has no fromAddress");
  }
  if ((kind === "offer" || kind === "answer") && typeof s.sdp !== "object") {
    throw new Error(`signal message kind ${kind} has no sdp`);
  }
  if (kind === "ice" && typeof s.candidate !== "object") {
    throw new Error("signal message kind ice has no candidate");
  }
  if (typeof s.sentAt !== "number") {
    throw new Error("signal message has no sentAt");
  }
  return raw as SignalMessage;
}

/** Seal one signal message for one recipient. The recipient's public
 *  key comes from the contacts directory (injected resolver) — a
 *  recipient with no published key cannot be signaled, and this
 *  throws before anything is posted. */
export async function sealSignal(
  message: SignalMessage,
  recipientAddress: MailAddress,
  recipientPublicKeyJwk: JsonWebKey,
): Promise<SealedSignal> {
  const publicKey = await importPublicKey(recipientPublicKeyJwk);
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  return sealBytesForRecipient(bytes, publicKey, recipientAddress);
}

/** Open a sealed signal with the recipient's private mail key.
 *  Throws when the envelope is not for this recipient or the
 *  ciphertext fails authentication — never a partial message. */
export async function openSignal(
  sealed: SealedSignal,
  recipientAddress: MailAddress,
  recipientPrivateKey: CryptoKey,
): Promise<SignalMessage> {
  const bytes = await openSealedBytes(sealed, recipientAddress, recipientPrivateKey);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("signal payload is not valid JSON — refusing it");
  }
  return parseSignalMessage(parsed);
}

/** The exact GitHub API call that posts one sealed signal to one
 *  recipient's inbox. The caller performs it with an authenticated
 *  fetch (token = the SENDER's GitHub token). */
export interface SignalApiCall {
  method: "POST" | "PATCH" | "GET" | "PUT";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export function buildSendSignalCall(
  sealed: SealedSignal,
  signalId: string,
  recipientGithubUser: string,
  senderToken: string,
): SignalApiCall {
  if (!senderToken?.trim()) {
    throw new Error(
      "P2P signaling needs your own GitHub token — sign in with your own GitHub account first. There is no shared signaling token.",
    );
  }
  return {
    method: "POST",
    url: `${GITHUB_API_BASE}/repos/${recipientGithubUser}/protocol-inbox/issues`,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${senderToken}`,
      "User-Agent": "ArkNetzWebWeaver/1.0",
    },
    body: {
      title: signalIssueTitle(signalId),
      body: signalIssueBody(sealed),
      labels: [SIGNAL_ISSUE_LABEL],
    },
  };
}

export function buildListSignalIssuesCall(githubUser: string, token: string): SignalApiCall {
  if (!token?.trim()) {
    throw new Error(
      "P2P signaling needs your own GitHub token — sign in with your own GitHub account first.",
    );
  }
  return {
    method: "GET",
    url: `${GITHUB_API_BASE}/repos/${githubUser}/protocol-inbox/issues?labels=${SIGNAL_ISSUE_LABEL}&state=open&per_page=100`,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ArkNetzWebWeaver/1.0",
    },
  };
}

export function buildCloseSignalIssueCall(
  githubUser: string,
  issueNumber: number,
  token: string,
): SignalApiCall {
  if (!token?.trim()) {
    throw new Error(
      "P2P signaling needs your own GitHub token — sign in with your own GitHub account first.",
    );
  }
  return {
    method: "PATCH",
    url: `${GITHUB_API_BASE}/repos/${githubUser}/protocol-inbox/issues/${issueNumber}`,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ArkNetzWebWeaver/1.0",
    },
    body: { state: "closed" },
  };
}

/** Resolves a mail address to its published X25519 public key JWK
 *  (contacts directory). Null = no key published for this address. */
export type ResolveContactPublicKey = (
  address: MailAddress,
) => Promise<JsonWebKey | null>;

/** One pulled signal Issue, parsed (or skipped with a reason). */
export interface PulledSignal {
  issueNumber: number;
  signal: SignalMessage | null;
  skippedReason?: string;
}

/** Signaling client: publishes/fetches peer ads and exchanges sealed
 *  signals through GitHub Issues. All network goes through the
 *  injected fetch; tokens are supplied per call by the app (never
 *  stored here). */
export class SignalingClient {
  constructor(
    private readonly fetchFn: GithubFetchFn,
    private readonly resolveContactPublicKey: ResolveContactPublicKey,
  ) {}

  private async run(call: SignalApiCall): Promise<{ status: number; json: unknown; text: string }> {
    let res;
    try {
      res = await this.fetchFn(call.url, {
        method: call.method,
        headers: call.headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
      });
    } catch (err) {
      throw new Error(
        `P2P signaling unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  }

  private async runOk(
    call: SignalApiCall,
    what: string,
  ): Promise<{ status: number; json: unknown }> {
    const { status, json, text } = await this.run(call);
    if (status < 200 || status >= 300) {
      throw new Error(
        `P2P signaling ${what} failed with HTTP ${status}: ${String(text).slice(0, 200)}`,
      );
    }
    return { status, json };
  }

  /** Fetch a peer's ad from their site repo (raw read, public).
   *  Null when the peer has no ad (404) — that means "no P2P", not
   *  an error. A downloaded ad that fails validation throws. */
  async fetchAd(owner: string, domain: string): Promise<PeerAd | null> {
    const url = `${RAW_GITHUB_BASE}/${owner}/${siteRepoName(domain)}/main/peer-ad.json`;
    const res = await this.fetchFn(url, { method: "GET", headers: {} });
    if (res.status === 404) return null;
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(`fetching peer ad for ${domain} failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`peer ad for ${domain} is not valid JSON`);
    }
    return parsePeerAd(parsed, { domain, owner });
  }

  /** Publish my ad to my site repo (Contents API, own token). The ad
   *  is public by design — it contains no secret. Creates the file
   *  when missing, updates it when present (SHA guard, same as the
   *  collab relay: a stale SHA returns 409 and the caller retries). */
  async publishAd(
    ad: PeerAd,
    owner: string,
    domain: string,
    token: string,
  ): Promise<string> {
    if (!token?.trim()) {
      throw new Error(
        "publishing a peer ad needs your own GitHub token — sign in with your own GitHub account first.",
      );
    }
    const repo = siteRepoName(domain);
    const path = "peer-ad.json";
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ArkNetzWebWeaver/1.0",
    };
    const existing = await this.fetchFn(url, { method: "GET", headers });
    let sha: string | undefined;
    if (existing.status === 200) {
      const body = (await existing.json()) as { sha?: unknown };
      if (typeof body.sha !== "string") {
        throw new Error("peer ad file has no SHA to update");
      }
      sha = body.sha;
    } else if (existing.status !== 404) {
      const text = await existing.text().catch(() => "");
      throw new Error(`checking peer ad failed with HTTP ${existing.status}: ${text.slice(0, 200)}`);
    }
    const content = btoa(
      String.fromCharCode(
        ...new TextEncoder().encode(JSON.stringify(ad)),
      ),
    );
    const body: Record<string, unknown> = {
      message: `Publish peer ad ${ad.peerId.slice(0, 8)}… (${ad.domain})`,
      content,
      branch: "main",
    };
    if (sha) body.sha = sha;
    const res = await this.runOk(
      { method: "PUT", url, headers, body },
      "publishing peer ad",
    );
    const json = res.json as { content?: { sha?: unknown } };
    const newSha = json.content?.sha;
    if (typeof newSha !== "string") {
      throw new Error("peer ad publish accepted but returned no file SHA");
    }
    return newSha;
  }

  /** Seal + post one signal to a peer's inbox. Returns the created
   *  Issue number. Throws before any network call when the recipient
   *  has no published mail public key (cannot be signaled) or the
   *  sender has no token. */
  async sendSignal(
    message: SignalMessage,
    recipientAddress: MailAddress,
    recipientGithubUser: string,
    senderToken: string,
  ): Promise<number> {
    const jwk = await this.resolveContactPublicKey(recipientAddress);
    if (!jwk) {
      throw new Error(
        `cannot signal ${recipientAddress}: no mail public key published in the contacts directory — the peer cannot be reached over P2P, use the GitHub path instead`,
      );
    }
    const sealed = await sealSignal(message, recipientAddress, jwk);
    const { json } = await this.runOk(
      buildSendSignalCall(sealed, message.signalId, recipientGithubUser, senderToken),
      "sending signal",
    );
    const issue = json as Record<string, unknown>;
    if (typeof issue.number !== "number") {
      throw new Error("GitHub did not return an Issue number for the signal");
    }
    return issue.number;
  }

  /** Poll my inbox for open signal Issues and open each one. Issues
   *  that fail to open are reported as skipped — one bad Issue never
   *  blocks the rest. The caller closes processed Issues with
   *  closeSignal(). */
  async pollSignals(
    githubUser: string,
    token: string,
    ownAddress: MailAddress,
    ownPrivateKey: CryptoKey,
  ): Promise<{ pulled: PulledSignal[]; skipped: number }> {
    const call = buildListSignalIssuesCall(githubUser, token);
    const res = await this.fetchFn(call.url, { method: call.method, headers: call.headers });
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(`P2P signal poll failed with HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const issues = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(issues)) throw new Error("P2P signal poll returned no issue list");
    const pulled: PulledSignal[] = [];
    let skipped = 0;
    for (const issue of issues) {
      const number = typeof issue.number === "number" ? issue.number : -1;
      const body = typeof issue.body === "string" ? issue.body : "";
      const sealed = parseSignalIssueBody(body);
      if (!sealed) {
        skipped++;
        pulled.push({
          issueNumber: number,
          signal: null,
          skippedReason: "no parseable arknetz-signal fence in Issue body",
        });
        continue;
      }
      try {
        const signal = await openSignal(sealed, ownAddress, ownPrivateKey);
        pulled.push({ issueNumber: number, signal });
      } catch (err) {
        skipped++;
        pulled.push({
          issueNumber: number,
          signal: null,
          skippedReason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { pulled, skipped };
  }

  /** Close a processed signal Issue (inbox stays near 0 KB). */
  async closeSignal(githubUser: string, issueNumber: number, token: string): Promise<void> {
    await this.runOk(
      buildCloseSignalIssueCall(githubUser, issueNumber, token),
      "closing signal Issue",
    );
  }
}
