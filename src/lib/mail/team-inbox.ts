// ArkNetzWebWeaver — shared team inbox (Phase 1).
// Thread turn 17: a shared address such as contact@computers.edu uses
// a shared domain keypair, encrypted individually per authorised
// member. READINESS-PARITY.md §3: the team inbox honours the
// mail.read / mail.send role flags from team.json.zst.
//
// ENFORCEMENT NOTE (same as roles.ts): the gating in this module is
// client-side UI gating. A member without mail.read cannot open team
// mail through the app's UI; a member without mail.send cannot send
// from the team address through the app. The durable enforcement is
// the GitHub Action that validates commits to site.json.zst /
// team.json.zst — it follows with the central repos, and until it
// lands a determined user could bypass the client gate. The crypto
// below is NOT bypassable that way: without a sealed team key for
// their address, a member cannot decrypt team mail at all, whatever
// the UI says.
//
// TEAM-KEY SHARING SCHEME: the team private key (JWK JSON) is sealed
// per member with the hybrid primitive in crypto.ts (fresh AES-256-
// GCM key, X25519-wrapped per member). A member opens their sealed
// copy with their own private key, imports the team private key, and
// can then open any mail sealed to the team public key.

import { can } from "../roles.js";
import type { TeamRole } from "../types.js";
import {
  generateMailKeypair,
  importPrivateKey,
  importPublicKey,
  openMail,
  openSealedBytes,
  sealBytesForRecipient,
} from "./crypto.js";
import type { ContactEntry, WrappedKeyEntry } from "./types.js";
import {
  type EncryptedMailEnvelope,
  type MailAddress,
  type MailKeypair,
  type MailPlaintext,
  type TeamInbox,
} from "./types.js";

export type { TeamRole };

/** One sealed team-key bundle, as base64 JSON:
 *  { ivB64, ciphertextB64, wrappedKey } — the full output of
 *  sealBytesForRecipient, so a member record stays a single field. */
export interface SealedTeamKeyBundle {
  ivB64: string;
  ciphertextB64: string;
  wrappedKey: WrappedKeyEntry;
}

export function encodeSealedTeamKey(bundle: SealedTeamKeyBundle): string {
  return btoa(JSON.stringify(bundle));
}

export function decodeSealedTeamKey(encoded: string): SealedTeamKeyBundle {
  const parsed = JSON.parse(atob(encoded)) as Record<string, unknown>;
  if (
    typeof parsed.ivB64 !== "string" ||
    typeof parsed.ciphertextB64 !== "string" ||
    typeof parsed.wrappedKey !== "object" ||
    parsed.wrappedKey === null
  ) {
    throw new Error("sealed team key is malformed");
  }
  const wrappedKey = parsed.wrappedKey as Record<string, unknown>;
  if (
    typeof wrappedKey.fingerprint !== "string" ||
    typeof wrappedKey.wrappedKeyB64 !== "string" ||
    typeof wrappedKey.ephemeralPublicKeyB64 !== "string"
  ) {
    throw new Error("sealed team key has a malformed wrapped key");
  }
  return parsed as unknown as SealedTeamKeyBundle;
}

/** Seal a team private-key JWK for one member. */
export async function sealTeamKeyForMember(
  teamPrivateJwk: JsonWebKey,
  memberPublicKey: CryptoKey,
  memberAddress: MailAddress,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(teamPrivateJwk));
  const sealed = await sealBytesForRecipient(bytes, memberPublicKey, memberAddress);
  return encodeSealedTeamKey({
    ivB64: sealed.ivB64,
    ciphertextB64: sealed.ciphertextB64,
    wrappedKey: sealed.wrappedKey,
  });
}

/** Create a team inbox: generate the shared domain keypair and seal
 *  the private key for each founding member (each needs a published
 *  public key in the contacts directory). The returned TeamInbox is
 *  what gets published (e.g. in team.json.zst) — it contains NO
 *  cleartext private key. */
export async function createTeamInbox(
  address: MailAddress,
  domain: string,
  members: ContactEntry[],
): Promise<TeamInbox> {
  const teamKeys = await generateMailKeypair(address);
  const teamPrivateJwk = await crypto.subtle.exportKey("jwk", teamKeys.privateKey);
  const sealedMembers: TeamInbox["members"] = [];
  for (const member of members) {
    const memberPublic = await importPublicKey(member.publicKeyJwk);
    sealedMembers.push({
      address: member.address,
      sealedTeamKeyB64: await sealTeamKeyForMember(
        teamPrivateJwk,
        memberPublic,
        member.address,
      ),
    });
  }
  return {
    address,
    domain,
    publicKeyJwk: teamKeys.publicKeyJwk,
    members: sealedMembers,
    updatedAt: Date.now(),
  };
}

/** Open a member's sealed team key with their own private key, and
 *  return the imported team private CryptoKey. Throws when the member
 *  has no sealed key in this inbox (not authorised) or the seal does
 *  not open with their key. */
export async function openTeamKeyForMember(
  inbox: TeamInbox,
  memberAddress: MailAddress,
  memberPrivateKey: CryptoKey,
): Promise<CryptoKey> {
  const record = inbox.members.find(
    (m) => m.address.toLowerCase() === memberAddress.toLowerCase(),
  );
  if (!record) {
    throw new Error(`${memberAddress} is not an authorised member of ${inbox.address}`);
  }
  const bundle = decodeSealedTeamKey(record.sealedTeamKeyB64);
  const bytes = await openSealedBytes(bundle, memberAddress, memberPrivateKey);
  const jwk = JSON.parse(new TextDecoder().decode(bytes)) as JsonWebKey;
  return importPrivateKey(jwk);
}

/** Gate: may this role READ the team inbox? (mail.read flag.) */
export function gateTeamMailRead(role: TeamRole): { allowed: boolean; reason: string } {
  if (can(role, "mail.read")) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason: `Role "${role.name}" cannot read the team inbox — it lacks the mail.read flag.`,
  };
}

/** Gate: may this role SEND from the team address? (mail.send flag.) */
export function gateTeamMailSend(role: TeamRole): { allowed: boolean; reason: string } {
  if (can(role, "mail.send")) return { allowed: true, reason: "" };
  return {
    allowed: false,
    reason: `Role "${role.name}" cannot send from the team address — it lacks the mail.send flag.`,
  };
}

/** Open a message addressed to the team, as an authorised member:
 *  the member's role must carry mail.read AND their sealed team key
 *  must open. Returns the decrypted plaintext. */
export async function openTeamMail(
  envelope: EncryptedMailEnvelope,
  inbox: TeamInbox,
  memberAddress: MailAddress,
  memberPrivateKey: CryptoKey,
  role: TeamRole,
): Promise<MailPlaintext> {
  const gate = gateTeamMailRead(role);
  if (!gate.allowed) throw new Error(gate.reason);
  const teamPrivateKey = await openTeamKeyForMember(inbox, memberAddress, memberPrivateKey);
  return openMail(envelope, inbox.address, teamPrivateKey);
}

/** The public half of a team inbox, for senders addressing mail TO
 *  the team (senders never hold the private key). */
export async function teamPublicKey(
  inbox: TeamInbox,
): Promise<Pick<MailKeypair, "address" | "publicKey" | "publicKeyJwk">> {
  const publicKey = await importPublicKey(inbox.publicKeyJwk);
  return { address: inbox.address, publicKey, publicKeyJwk: inbox.publicKeyJwk };
}
