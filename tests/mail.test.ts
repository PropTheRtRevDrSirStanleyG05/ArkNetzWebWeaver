// Tests: protocol mail (Phase 1) — envelope crypto, contacts, lists,
// delivery payloads, inbox, compose, team inbox, mail UI.
// ALL network is mocked (injected fetch). No test ever hits real
// GitHub or the Internet Archive. X25519 keypairs are generated
// once in before() and shared across tests.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import {
  addressFingerprint,
  AES_KW_WRAPPED_KEY_BYTES,
  b64decode,
  generateMailKeypair,
  importPrivateKey,
  importPublicKey,
  newMessageId,
  newThreadId,
  openMail,
  openSealedBytes,
  sealBytesForRecipient,
  sealMail,
  unwrapContentKey,
  wrapContentKey,
  WRAPPED_KEY_ENTRY_BYTES,
  X25519_PUBLIC_KEY_BYTES,
  type EnvelopeRecipient,
} from "../src/lib/mail/crypto.js";
import {
  contactEntryJsonBytes,
  ContactsDirectory,
  contactsShardUrl,
  parseContactsShard,
  serialiseContactsShard,
  shardForAddress,
} from "../src/lib/mail/contacts.js";
import {
  buildLargeListOutbox,
  buildMailPointer,
  isLargeList,
  makePointerDeliveriesForKeys,
  MailListStore,
  openPointerMail,
  outboxPayloadRef,
  parseMailingList,
  parseMailLists,
  verifyPointerPayload,
} from "../src/lib/mail/lists.js";
import {
  buildCloseIssueCall,
  buildDeliverIssueCall,
  buildDeliverPointerCall,
  buildListInboxIssuesCall,
  inboxIssueUrl,
  inboxIssuesUrl,
  mailIssueBody,
  mailIssueTitle,
  MailDelivery,
  parseMailIssueBody,
  parsePointerIssueBody,
  type GithubApiFetch,
} from "../src/lib/mail/delivery.js";
import {
  buildMailArchiveRecord,
  createMemoryMailStore,
  Inbox,
  normaliseSubject,
  replyAllRecipients,
} from "../src/lib/mail/inbox.js";
import {
  buildMailFromDraft,
  createMemoryDraftStore,
  newDraft,
  replyDraft,
  restoreDraft,
  saveDraft,
  validateDraft,
  validateMailAddress,
} from "../src/lib/mail/compose.js";
import {
  createTeamInbox,
  gateTeamMailRead,
  gateTeamMailSend,
  openTeamKeyForMember,
  openTeamMail,
  teamPublicKey,
} from "../src/lib/mail/team-inbox.js";
import {
  composeViewModel,
  inboxViewModel,
  MAIL_ONLY_PROTOCOL_NOTICE,
  threadViewModel,
} from "../src/lib/mail/mail-ui.js";
import { OWNER_ROLE, WRITER_ROLE } from "../src/lib/roles.js";
import type {
  ContactEntry,
  EncryptedMailEnvelope,
  MailAddress,
  MailKeypair,
  MailPlaintext,
} from "../src/lib/mail/types.js";
import type { TeamRole } from "../src/lib/types.js";

const ALICE = "alice@computers.edu";
const BOB = "bob@computers.edu";
const CAROL = "carol@computers.edu";
const DAVE = "dave@computers.edu";
const TEAM = "contact@computers.edu";

let aliceKeys: MailKeypair;
let bobKeys: MailKeypair;
let carolKeys: MailKeypair;
let daveKeys: MailKeypair;
let contacts: ContactsDirectory;

function contactFor(keys: MailKeypair, displayName?: string): ContactEntry {
  return {
    address: keys.address,
    displayName,
    publicKeyJwk: keys.publicKeyJwk,
    updatedAt: 1,
  };
}

before(async () => {
  aliceKeys = await generateMailKeypair(ALICE);
  bobKeys = await generateMailKeypair(BOB);
  carolKeys = await generateMailKeypair(CAROL);
  daveKeys = await generateMailKeypair(DAVE);
  contacts = new ContactsDirectory([
    contactFor(aliceKeys, "Alice"),
    contactFor(bobKeys, "Bob"),
    contactFor(carolKeys, "Carol"),
    contactFor(daveKeys, "Dave"),
  ]);
});

async function resolveKey(address: MailAddress): Promise<ContactEntry | undefined> {
  return contacts.lookup(address);
}

async function recipientFor(keys: MailKeypair): Promise<EnvelopeRecipient> {
  return { address: keys.address, publicKey: keys.publicKey };
}

function plainMail(over: Partial<MailPlaintext> = {}): MailPlaintext {
  return {
    version: "arknetz-mail/1",
    messageId: newMessageId(),
    threadId: newThreadId(),
    from: ALICE,
    to: [BOB],
    cc: [],
    subject: "Hello from the protocol",
    body: "This is a test message sent entirely inside ArkNetz.",
    sentAt: Date.now(),
    attachments: [],
    ...over,
  };
}

async function sealFor(
  plain: MailPlaintext,
  keys: MailKeypair[],
  bcc: MailAddress[] = [],
): Promise<EncryptedMailEnvelope> {
  const recipients = await Promise.all(keys.map(recipientFor));
  return sealMail(plain, recipients, bcc);
}

// --- crypto: envelope round-trip ------------------------------------------

test("envelope encrypt/decrypt round-trip preserves subject, body, sender and thread", async () => {
  const plain = plainMail({ body: "Hello Bob, ".repeat(200) });
  const env = await sealFor(plain, [bobKeys]);
  assert.equal(env.version, "arknetz-mail/1");
  assert.equal(env.from, ALICE);
  assert.deepEqual(env.recipients, [BOB]);
  // Zstd compression: a repetitive body seals far smaller than raw.
  assert.ok(env.compressedBytes < plain.body.length / 2);
  const opened = await openMail(env, BOB, bobKeys.privateKey);
  assert.equal(opened.subject, plain.subject);
  assert.equal(opened.body, plain.body);
  assert.equal(opened.threadId, plain.threadId);
  assert.equal(opened.messageId, plain.messageId);
});

test("attachments survive the round-trip (Zstd-compressed, encrypted inside the envelope)", async () => {
  const data = new TextEncoder().encode("attachment contents ".repeat(100));
  const plain = plainMail({
    attachments: [{ filename: "notes.txt", mime: "text/plain", data }],
  });
  const env = await sealFor(plain, [bobKeys]);
  const opened = await openMail(env, BOB, bobKeys.privateKey);
  assert.equal(opened.attachments.length, 1);
  assert.equal(opened.attachments[0]!.filename, "notes.txt");
  assert.deepEqual(opened.attachments[0]!.data, data);
});

test("group mail: one ciphertext, one wrapped key per recipient, everyone can open it", async () => {
  const plain = plainMail({ to: [BOB, CAROL], cc: [DAVE] });
  const env = await sealFor(plain, [bobKeys, carolKeys, daveKeys]);
  assert.equal(env.wrappedKeys.length, 3);
  const fps = new Set(env.wrappedKeys.map((w) => w.fingerprint));
  assert.equal(fps.size, 3);
  // Each wrapped key is an X25519 encapsulation: a 32-byte ephemeral
  // public key + a 40-byte AES-KW-wrapped CEK = 72 bytes raw.
  for (const w of env.wrappedKeys) {
    assert.equal(b64decode(w.wrappedKeyB64).length, AES_KW_WRAPPED_KEY_BYTES);
    assert.equal(b64decode(w.wrappedKeyB64).length, 40);
    assert.equal(b64decode(w.ephemeralPublicKeyB64).length, X25519_PUBLIC_KEY_BYTES);
    assert.equal(b64decode(w.ephemeralPublicKeyB64).length, 32);
    assert.equal(
      b64decode(w.wrappedKeyB64).length + b64decode(w.ephemeralPublicKeyB64).length,
      WRAPPED_KEY_ENTRY_BYTES,
    );
  }
  // Ephemeral public keys are fresh per recipient (no reuse).
  const ephs = new Set(env.wrappedKeys.map((w) => w.ephemeralPublicKeyB64));
  assert.equal(ephs.size, 3);
  for (const [addr, keys] of [
    [BOB, bobKeys],
    [CAROL, carolKeys],
    [DAVE, daveKeys],
  ] as const) {
    const opened = await openMail(env, addr, keys.privateKey);
    assert.equal(opened.subject, plain.subject);
  }
});

test("BCC: BCC recipient can open it, but BCC is stripped from the inner header and the envelope", async () => {
  const plain = plainMail({ to: [BOB], cc: [] });
  const env = await sealFor(plain, [bobKeys, carolKeys], [CAROL]);
  // BCC address appears nowhere in cleartext.
  assert.ok(!env.recipients.includes(CAROL));
  assert.ok(!JSON.stringify(env).includes(CAROL));
  assert.equal(env.wrappedKeys.length, 2);
  // BCC recipient opens it fine…
  const asCarol = await openMail(env, CAROL, carolKeys.privateKey);
  assert.ok(!asCarol.to.includes(CAROL));
  assert.ok(!asCarol.cc.includes(CAROL));
  // …and neither can a To recipient learn about the BCC from the header.
  const asBob = await openMail(env, BOB, bobKeys.privateKey);
  assert.ok(!asBob.to.includes(CAROL));
  assert.ok(!asBob.cc.includes(CAROL));
  assert.ok(!JSON.stringify(asBob).includes(CAROL));
});

test("a non-recipient cannot open mail (no wrapped key for them)", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  await assert.rejects(() => openMail(env, DAVE, daveKeys.privateKey), /no wrapped key/);
});

test("a tampered ciphertext fails authentication instead of returning garbage", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  const bytes = Buffer.from(env.ciphertextB64, "base64");
  bytes[bytes.length - 1]! ^= 0xff;
  const tampered: EncryptedMailEnvelope = {
    ...env,
    ciphertextB64: bytes.toString("base64"),
  };
  await assert.rejects(
    () => openMail(tampered, BOB, bobKeys.privateKey),
    /failed authentication/,
  );
});

test("a wrapped key does not unwrap with the wrong private key", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  await assert.rejects(
    () => openMail(env, BOB, carolKeys.privateKey),
    /does not unwrap/,
  );
});

test("sealBytes/openSealedBytes round-trip; wrong recipient is refused by fingerprint", async () => {
  const sealed = await sealBytesForRecipient(
    new TextEncoder().encode("team secret"),
    bobKeys.publicKey,
    BOB,
  );
  const opened = await openSealedBytes(sealed, BOB, bobKeys.privateKey);
  assert.equal(new TextDecoder().decode(opened), "team secret");
  await assert.rejects(
    () => openSealedBytes(sealed, CAROL, carolKeys.privateKey),
    /not addressed to this recipient/,
  );
});

test("address fingerprints are deterministic and distinct; public JWK imports back", async () => {
  const a1 = await addressFingerprint(ALICE);
  const a2 = await addressFingerprint(ALICE);
  const b = await addressFingerprint(BOB);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(a1.length, 32);
  const imported = await importPublicKey(aliceKeys.publicKeyJwk);
  assert.equal(imported.type, "public");
  // A key sealed for the imported public key opens with the original private key.
  const sealed = await sealBytesForRecipient(
    new TextEncoder().encode("x"),
    imported,
    ALICE,
  );
  const opened = await openSealedBytes(sealed, ALICE, aliceKeys.privateKey);
  assert.equal(new TextDecoder().decode(opened), "x");
});

test("sealMail refuses a recipient who is in neither To/CC nor BCC", async () => {
  const plain = plainMail({ to: [BOB] });
  await assert.rejects(
    () => sealMail(plain, [{ address: DAVE, publicKey: daveKeys.publicKey }]),
    /neither To\/CC nor BCC/,
  );
});

// --- crypto: X25519 key-wrap construction (fix round 2, item 4) -----------

test("x25519: keypairs are OKP/X25519 with 32-byte public keys; JWK imports back both ways", async () => {
  const keys = await generateMailKeypair("zoe@computers.edu");
  assert.equal(keys.publicKeyJwk.kty, "OKP");
  assert.equal(keys.publicKeyJwk.crv, "X25519");
  // The public value is a 32-byte Curve25519 point (43 base64url chars).
  assert.equal(typeof keys.publicKeyJwk.x, "string");
  assert.equal(keys.publicKeyJwk.x!.length, 43);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  assert.equal(raw.length, 32);
  // The exported public JWK JSON is ~102 bytes (measured on Node
  // 24.22.1; other engines may add the same key_ops/ext fields, so
  // the test bounds it rather than asserting it byte-exact).
  assert.ok(JSON.stringify(keys.publicKeyJwk).length <= 128);
  const importedPub = await importPublicKey(keys.publicKeyJwk);
  assert.equal(importedPub.type, "public");
  const privJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const importedPriv = await importPrivateKey(privJwk);
  assert.equal(importedPriv.type, "private");
  // A key sealed for the imported public key opens with the imported
  // private key, and vice versa.
  const sealed = await sealBytesForRecipient(
    new TextEncoder().encode("x"),
    importedPub,
    "zoe@computers.edu",
  );
  const opened = await openSealedBytes(sealed, "zoe@computers.edu", importedPriv);
  assert.equal(new TextDecoder().decode(opened), "x");
  // A non-X25519 JWK is refused with a plain message.
  await assert.rejects(
    () => importPublicKey({ kty: "RSA", n: "AAAA", e: "AQAB" }),
    /not an X25519 key/,
  );
  await assert.rejects(
    () => importPrivateKey({ kty: "RSA", n: "AAAA", e: "AQAB", d: "AAAA" }),
    /not an X25519 key/,
  );
});

test("x25519: wrap/unwrap round-trip; a tampered ephemeral key or wrapped key fails", async () => {
  const cek = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const entry = await wrapContentKey(cek, bobKeys.publicKey, BOB);
  const unwrapped = await unwrapContentKey(entry, BOB, bobKeys.privateKey);
  assert.equal(unwrapped.type, "secret");
  // Tamper with the ephemeral public key: the derived KEK changes,
  // so the AES-KW unwrap fails.
  const badEph = b64decode(entry.ephemeralPublicKeyB64);
  badEph[0]! ^= 0x01;
  const tamperedEph = {
    ...entry,
    ephemeralPublicKeyB64: Buffer.from(badEph).toString("base64"),
  };
  await assert.rejects(
    () => unwrapContentKey(tamperedEph, BOB, bobKeys.privateKey),
    /does not unwrap/,
  );
  // Tamper with the wrapped key itself: AES-KW authentication fails.
  const badWrap = b64decode(entry.wrappedKeyB64);
  badWrap[badWrap.length - 1]! ^= 0xff;
  const tamperedWrap = {
    ...entry,
    wrappedKeyB64: Buffer.from(badWrap).toString("base64"),
  };
  await assert.rejects(
    () => unwrapContentKey(tamperedWrap, BOB, bobKeys.privateKey),
    /does not unwrap/,
  );
  // The entry is for Bob, not Carol.
  await assert.rejects(
    () => unwrapContentKey(entry, CAROL, carolKeys.privateKey),
    /not addressed to this recipient/,
  );
  // Malformed entries are refused, not unwrapped.
  await assert.rejects(
    () => unwrapContentKey({ ...entry, ephemeralPublicKeyB64: "AAAA" }, BOB, bobKeys.privateKey),
    /malformed ephemeral/,
  );
  await assert.rejects(
    () => unwrapContentKey({ ...entry, wrappedKeyB64: "AAAA" }, BOB, bobKeys.privateKey),
    /malformed/,
  );
});

// --- contacts ---------------------------------------------------------------

test("contacts: add/lookup/remove are case-insensitive; missing lookups are undefined", () => {
  const dir = new ContactsDirectory([contactFor(aliceKeys, "Alice A")]);
  assert.equal(dir.lookup("ALICE@computers.edu")?.address, ALICE);
  assert.equal(dir.has(BOB), false);
  dir.add(contactFor(bobKeys));
  assert.equal(dir.size, 2);
  assert.equal(dir.remove(BOB), true);
  assert.equal(dir.lookup(BOB), undefined);
});

test("contacts: prefix search ranks address-prefix first, then name, then substring; limit caps", () => {
  const dir = new ContactsDirectory([
    contactFor(aliceKeys, "Alice Anderson"),
    contactFor(bobKeys, "Bobby"),
    contactFor(carolKeys, "Alice Cooper"),
    contactFor(daveKeys, "David"),
  ]);
  const byAddr = dir.search("ali");
  assert.equal(byAddr[0]!.address, ALICE);
  assert.equal(byAddr[1]!.address, CAROL);
  const byName = dir.search("bob");
  assert.equal(byName[0]!.address, BOB);
  assert.deepEqual(dir.search("zzz"), []);
  assert.equal(dir.search("a", 1).length, 1);
});

test("contacts: shard parse/serialise round-trip; an entry without an X25519 JWK throws", () => {
  const entries = [contactFor(aliceKeys), contactFor(bobKeys)];
  const shard = serialiseContactsShard("a", entries);
  const parsed = parseContactsShard(shard);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.publicKeyJwk.kty, "OKP");
  assert.equal(parsed[0]!.publicKeyJwk.crv, "X25519");
  assert.throws(
    () => parseContactsShard({ contacts: [{ address: "x@y.zz", publicKeyJwk: {} }] }),
    /no X25519 public-key JWK/,
  );
  // An old RSA-shaped JWK is rejected too (the directory is X25519-only).
  assert.throws(
    () =>
      parseContactsShard({
        contacts: [
          {
            address: "x@y.zz",
            publicKeyJwk: { kty: "RSA", n: "AAAA", e: "AQAB" },
          },
        ],
      }),
    /no X25519 public-key JWK/,
  );
});

test("contacts: shard key is one hex digit, deterministic; shard URL is under the master account", async () => {
  const s1 = await shardForAddress(ALICE);
  const s2 = await shardForAddress(ALICE);
  assert.equal(s1, s2);
  assert.match(s1, /^[0-9a-f]$/);
  const url = await contactsShardUrl(ALICE);
  assert.ok(url.startsWith("https://raw.githubusercontent.com/PropTheRtRevDrSirStanleyG05/arknetz-contacts-"));
  assert.ok(url.endsWith("/main/contacts.json"));
});

test("contacts: measured sizes — 32-byte X25519 keys, 165-byte JSON entries (fix round 2, item 4)", async () => {
  // A minimal entry (address + JWK + updatedAt) measured on Node
  // 24.22.1: 165 bytes of JSON. The raw public key alone is 32
  // bytes (32 MB per 1M users); the JSON framing is what keeps the
  // directory at 157.4 MiB per 1M uncompressed, not the thread's
  // ~40 MB (which assumed ~40 bytes/entry of raw binary packing).
  const minimal: ContactEntry = {
    address: ALICE,
    publicKeyJwk: aliceKeys.publicKeyJwk,
    updatedAt: 1,
  };
  const bytes = contactEntryJsonBytes(minimal);
  assert.equal(bytes, 165);
  assert.equal(bytes * 1_000_000, 165_000_000);
  // A full entry (display name + GitHub login) is bigger but in the
  // same order — nowhere near the RSA-era ~490 bytes.
  const full = contactFor(aliceKeys, "Alice");
  full.githubUser = "alice";
  const fullBytes = contactEntryJsonBytes(full);
  assert.ok(fullBytes > bytes && fullBytes < 250);
  assert.ok((fullBytes * 1_000_000) / 1_048_576 < 250);
  // The public key itself is 32 bytes raw.
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", aliceKeys.publicKey));
  assert.equal(raw.length, 32);
});

// --- mailing lists -----------------------------------------------------------

test("lists: parse dedupes members and lowercases; invalid members throw", () => {
  const list = parseMailingList({
    address: "staff@computers.edu",
    name: "Staff",
    domain: "computers.edu",
    members: [BOB, CAROL, BOB, "CAROL@computers.edu"],
    owner: ALICE,
    updatedAt: 1,
  });
  assert.deepEqual(list.members, [BOB, CAROL]);
  assert.throws(
    () =>
      parseMailingList({
        address: "staff@computers.edu",
        members: [BOB, "not-an-address"],
      }),
    /invalid member/,
  );
});

test("lists: expand a list address, expand mixed recipients, sender excluded, unknown list reported", () => {
  const store = new MailListStore([
    {
      address: "staff@computers.edu",
      name: "Staff",
      domain: "computers.edu",
      members: [ALICE, BOB, CAROL],
      owner: ALICE,
      updatedAt: 1,
    },
  ]);
  assert.deepEqual(store.expand("staff@computers.edu"), [ALICE, BOB, CAROL]);
  const { recipients, unknownLists } = store.expandRecipients(
    ["staff@computers.edu", DAVE, "all@computers.edu"],
    ALICE,
  );
  assert.deepEqual(recipients, [BOB, CAROL, DAVE]);
  assert.deepEqual(unknownLists, ["all@computers.edu"]);
  assert.throws(() => store.expand("nobody@computers.edu"), /unknown mailing list/);
});

test("lists: parseMailLists reads mail_lists.json.zst shape", () => {
  const lists = parseMailLists({
    lists: [
      {
        address: "staff@computers.edu",
        name: "Staff",
        domain: "computers.edu",
        members: [BOB],
        owner: ALICE,
        updatedAt: 1,
      },
    ],
  });
  assert.equal(lists.length, 1);
  assert.equal(lists[0]!.address, "staff@computers.edu");
});

test("lists: large-list threshold is 50 (49 is small, 50 is large)", () => {
  assert.equal(isLargeList(49), false);
  assert.equal(isLargeList(50), true);
});

test("lists: pointer delivery stores the payload once, one wrapped key per inbox", async () => {
  const members = [BOB, CAROL, DAVE];
  const env = await sealFor(plainMail({ to: members }), [bobKeys, carolKeys, daveKeys]);
  const pointer = await buildMailPointer(env, `gh:alice/mail-outbox#${env.messageId}`);
  assert.equal(pointer.kind, "arknetz-mail-pointer/1");
  assert.equal(pointer.messageId, env.messageId);
  assert.ok(pointer.payloadBytes > 0);
  // Pointer JSON is ~120 bytes of metadata plus the ref/hash — small.
  assert.ok(JSON.stringify(pointer).length < 400);
  const deliveries = await makePointerDeliveriesForKeys(env, pointer, members);
  assert.equal(deliveries.length, 3);
  assert.ok(deliveries.every((d) => d.pointer === pointer));
  const fps = new Set(deliveries.map((d) => d.wrappedKey.fingerprint));
  assert.equal(fps.size, 3);
  await assert.rejects(
    () => makePointerDeliveriesForKeys(env, pointer, ["stranger@computers.edu"]),
    /no wrapped key/,
  );
});

// --- large-list outbox writer (fix round 2, item 6) ------------------------

async function makeListUsers(n: number): Promise<MailKeypair[]> {
  const users: MailKeypair[] = [];
  for (let i = 0; i < n; i++) {
    users.push(await generateMailKeypair(`user${i}@computers.edu`));
  }
  return users;
}

test("writer: buildLargeListOutbox stores the payload once — one payloadJson, one shared pointer", async () => {
  const users = await makeListUsers(55);
  const members = users.map((u) => u.address);
  const plain = plainMail({ to: members, subject: "List announcement", body: "Hello list, ".repeat(50) });
  const env = await sealFor(plain, users);
  const outbox = await buildLargeListOutbox(
    env,
    outboxPayloadRef("alice", env.messageId),
    members,
  );
  assert.equal(outbox.recipientCount, 55);
  assert.equal(outbox.deliveries.length, 55);
  assert.equal(outbox.payloadRef, `gh:alice/mail-outbox#${env.messageId}`);
  // Exactly ONE stored payload: a single JSON string, and every
  // delivery shares the identical pointer object.
  assert.equal(outbox.payloadJson, JSON.stringify(env));
  assert.ok(outbox.deliveries.every((d) => d.pointer === outbox.pointer));
  assert.equal(outbox.pointer.payloadBytes, new TextEncoder().encode(outbox.payloadJson).length);
  assert.equal(outbox.pointer.messageId, env.messageId);
  // One wrapped key per recipient, all distinct fingerprints.
  const fps = new Set(outbox.deliveries.map((d) => d.wrappedKey.fingerprint));
  assert.equal(fps.size, 55);
  // The per-inbox delivery is small and constant-size: pointer JSON
  // plus one 72-byte wrapped key — far smaller than the payload, and
  // it carries no ciphertext at all.
  for (const d of outbox.deliveries) {
    assert.ok(!JSON.stringify(d).includes(env.ciphertextB64));
  }
  const deliveryBytes = new TextEncoder().encode(JSON.stringify(outbox.deliveries[0])).length;
  const payloadBytes = new TextEncoder().encode(outbox.payloadJson).length;
  assert.ok(deliveryBytes < payloadBytes);
  // Dedupes recipients instead of double-delivering.
  const dupes = await buildLargeListOutbox(env, outbox.payloadRef, [
    members[0]!,
    members[0]!.toUpperCase(),
    members[1]!,
  ]);
  assert.equal(dupes.recipientCount, 2);
  // Empty recipient list is refused.
  await assert.rejects(
    () => buildLargeListOutbox(env, outbox.payloadRef, []),
    /no recipients/,
  );
  // A member with no wrapped key in the envelope is refused, not dropped.
  await assert.rejects(
    () => buildLargeListOutbox(env, outbox.payloadRef, [...members, "stranger@computers.edu"]),
    /no wrapped key/,
  );
});

test("writer: every recipient resolves the pointer and decrypts; a non-recipient cannot", async () => {
  const users = await makeListUsers(55);
  const members = users.map((u) => u.address);
  const plain = plainMail({ to: members, subject: "List announcement", body: "Hello list." });
  const env = await sealFor(plain, users);
  const outbox = await buildLargeListOutbox(
    env,
    outboxPayloadRef("alice", env.messageId),
    members,
  );
  // Every one of the 55 recipients opens the same stored payload.
  for (let i = 0; i < users.length; i++) {
    const opened = await openPointerMail(
      outbox.deliveries[i]!,
      outbox.payloadJson,
      users[i]!.address,
      users[i]!.privateKey,
    );
    assert.equal(opened.subject, "List announcement");
    assert.equal(opened.body, "Hello list.");
    assert.equal(opened.messageId, env.messageId);
  }
  // A non-recipient holding someone else's delivery cannot open it:
  // the delivery is not addressed to them…
  const stranger = await generateMailKeypair("stranger@computers.edu");
  await assert.rejects(
    () => openPointerMail(outbox.deliveries[0]!, outbox.payloadJson, stranger.address, stranger.privateKey),
    /not addressed to/,
  );
  // …and a non-recipient with a delivery forged in their name still
  // has no wrapped key in the envelope.
  const forged = { ...outbox.deliveries[0]!, recipient: stranger.address };
  await assert.rejects(
    () => openPointerMail(forged, outbox.payloadJson, stranger.address, stranger.privateKey),
    /no wrapped key/,
  );
});

test("writer: a tampered or wrong payload fails pointer verification before any decrypt", async () => {
  const users = await makeListUsers(3);
  const members = users.map((u) => u.address);
  const env = await sealFor(plainMail({ to: members }), users);
  const outbox = await buildLargeListOutbox(
    env,
    outboxPayloadRef("alice", env.messageId),
    members,
  );
  const delivery = outbox.deliveries[0]!;
  // Flip one character inside the stored payload (the hash catches
  // it before the ciphertext is even looked at).
  const tampered =
    outbox.payloadJson.slice(0, 100) +
    (outbox.payloadJson[100] === "a" ? "b" : "a") +
    outbox.payloadJson.slice(101);
  await assert.rejects(
    () => verifyPointerPayload(outbox.pointer, tampered),
    /hash mismatch/,
  );
  await assert.rejects(
    () => openPointerMail(delivery, tampered, users[0]!.address, users[0]!.privateKey),
    /hash mismatch/,
  );
  // A payload for a different message fails the messageId check.
  const other = await sealFor(plainMail({ to: members }), users);
  const otherJson = JSON.stringify(other);
  await assert.rejects(
    () => openPointerMail(delivery, otherJson, users[0]!.address, users[0]!.privateKey),
    /mismatch/,
  );
  // The honest payload verifies clean.
  await verifyPointerPayload(outbox.pointer, outbox.payloadJson);
});

test("writer: deliverLargeList stores the payload exactly once, then posts one pointer Issue per recipient", async () => {
  const users = await makeListUsers(55);
  const members = users.map((u) => u.address);
  const env = await sealFor(plainMail({ to: members, subject: "List announcement" }), users);
  const outbox = await buildLargeListOutbox(
    env,
    outboxPayloadRef("alice", env.messageId),
    members,
  );
  const stored: Array<{ ref: string; json: string }> = [];
  const payloadStore = {
    async store(ref: string, json: string): Promise<void> {
      stored.push({ ref, json });
    },
  };
  let nextIssue = 100;
  const { fetchFn, calls } = mockGithubFetch(async () => ({
    status: 201,
    payload: { number: nextIssue++ },
  }));
  const delivery = new MailDelivery(fetchFn);
  const githubUserFor = (address: MailAddress): string => {
    const i = members.indexOf(address);
    return `user${i}dev`;
  };
  const issueNumbers = await delivery.deliverLargeList(
    outbox,
    githubUserFor,
    "TOKEN-1",
    payloadStore,
  );
  // The payload was stored EXACTLY once, before any Issue was posted.
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.ref, outbox.payloadRef);
  assert.equal(stored[0]!.json, outbox.payloadJson);
  // One pointer Issue per recipient, each to that recipient's inbox.
  assert.equal(calls.length, 55);
  assert.equal(issueNumbers.length, 55);
  assert.deepEqual(issueNumbers, Array.from({ length: 55 }, (_, i) => 100 + i));
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, `https://api.github.com/repos/user${i}dev/protocol-inbox/issues`);
    const sent = JSON.parse(call.body!) as Record<string, unknown>;
    assert.equal(sent.title, `ARKNETZ-MAIL ${env.messageId}`);
    // The Issue carries the pointer fence, never the ciphertext.
    const parsed = parsePointerIssueBody(sent.body as string);
    assert.notEqual(parsed, null);
    assert.equal(parsed!.recipient, members[i]);
    assert.ok(!(sent.body as string).includes(env.ciphertextB64));
  }
  // A recipient with no known GitHub login aborts before anything
  // is stored or posted.
  stored.length = 0;
  const callsBefore = calls.length;
  await assert.rejects(
    () =>
      delivery.deliverLargeList(
        outbox,
        (address) => (address === members[0] ? undefined : githubUserFor(address)),
        "TOKEN-1",
        payloadStore,
      ),
    /no GitHub login known/,
  );
  assert.equal(stored.length, 0);
  assert.equal(calls.length, callsBefore);
});

test("writer: end-to-end — a pulled pointer Issue plus the fetched payload opens for the recipient", async () => {
  const users = await makeListUsers(3);
  const members = users.map((u) => u.address);
  const env = await sealFor(plainMail({ to: members, subject: "List note" }), users);
  const outbox = await buildLargeListOutbox(
    env,
    outboxPayloadRef("alice", env.messageId),
    members,
  );
  // Simulate the recipient's inbox pull: the pointer Issue arrives…
  const { fetchFn } = mockGithubFetch(async () => ({
    status: 200,
    payload: [
      {
        number: 7,
        body: [
          "```arknetz-mail-pointer",
          JSON.stringify(outbox.deliveries[1]),
          "```",
        ].join("\n"),
      },
    ],
  }));
  const delivery = new MailDelivery(fetchFn);
  const { pulled } = await delivery.pollInbox("user1dev", "TOKEN-1");
  assert.equal(pulled.length, 1);
  const pointer = pulled[0]!.pointer;
  assert.notEqual(pointer, null);
  // …and the recipient fetches the single stored payload and opens it.
  const opened = await openPointerMail(
    pointer!,
    outbox.payloadJson,
    users[1]!.address,
    users[1]!.privateKey,
  );
  assert.equal(opened.subject, "List note");
});

// --- delivery ---------------------------------------------------------------

test("delivery: deliver Issue call shape — POST, inbox repo, title, labels, fenced envelope", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  const call = buildDeliverIssueCall(env, "bobdev", "TOKEN-1");
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.github.com/repos/bobdev/protocol-inbox/issues");
  assert.equal(call.headers.Authorization, "Bearer TOKEN-1");
  const body = call.body as Record<string, unknown>;
  assert.equal(body.title, mailIssueTitle(env.messageId));
  assert.deepEqual(body.labels, ["arknetz-mail"]);
  assert.equal(parseMailIssueBody(body.body as string)?.messageId, env.messageId);
  assert.equal(inboxIssuesUrl("bobdev"), call.url);
  assert.equal(inboxIssueUrl("bobdev", 7), `${call.url}/7`);
});

test("delivery: close Issue call is a PATCH setting state closed", () => {
  const call = buildCloseIssueCall("bobdev", 12, "TOKEN-1");
  assert.equal(call.method, "PATCH");
  assert.equal(call.url, "https://api.github.com/repos/bobdev/protocol-inbox/issues/12");
  assert.deepEqual(call.body, { state: "closed" });
});

test("delivery: list-inbox call is a GET for open arknetz-mail issues", () => {
  const call = buildListInboxIssuesCall("bobdev", "TOKEN-1");
  assert.equal(call.method, "GET");
  assert.ok(call.url.includes("labels=arknetz-mail"));
  assert.ok(call.url.includes("state=open"));
});

test("delivery: parseMailIssueBody returns null for junk bodies and wrong versions", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  assert.equal(parseMailIssueBody("hello world"), null);
  assert.equal(parseMailIssueBody(mailIssueBody({ ...env, version: "other/9" as never })), null);
  assert.equal(
    parseMailIssueBody("```arknetz-mail\n{not json\n```"),
    null,
  );
  assert.equal(
    parsePointerIssueBody("```arknetz-mail-pointer\n{}\n```"),
    null,
  );
});

function mockGithubFetch(
  handler: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; payload: unknown }>,
): { fetchFn: GithubApiFetch; calls: Array<{ url: string; method: string; body?: string }> } {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFn: GithubApiFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const r = await handler(url, init);
    const text = JSON.stringify(r.payload);
    return { status: r.status, json: async () => r.payload, text: async () => text };
  };
  return { fetchFn, calls };
}

test("delivery: MailDelivery.deliver posts one Issue and returns its number", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  const { fetchFn, calls } = mockGithubFetch(async () => ({
    status: 201,
    payload: { number: 42 },
  }));
  const delivery = new MailDelivery(fetchFn);
  const n = await delivery.deliver(env, "bobdev", "TOKEN-1");
  assert.equal(n, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
  assert.equal(sent.title, mailIssueTitle(env.messageId));
});

test("delivery: pollInbox parses mail + pointer issues and skips junk without failing", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  const pointerEnv = await sealFor(plainMail({ to: [BOB, CAROL] }), [bobKeys, carolKeys]);
  const pointer = await buildMailPointer(pointerEnv, "gh:alice/mail-outbox#x");
  const deliveries = await makePointerDeliveriesForKeys(pointerEnv, pointer, [BOB]);
  const { fetchFn } = mockGithubFetch(async () => ({
    status: 200,
    payload: [
      { number: 1, body: mailIssueBody(env) },
      {
        number: 2,
        body: [
          "```arknetz-mail-pointer",
          JSON.stringify(deliveries[0]),
          "```",
        ].join("\n"),
      },
      { number: 3, body: "just a normal issue, not mail" },
    ],
  }));
  const delivery = new MailDelivery(fetchFn);
  const { pulled, skipped } = await delivery.pollInbox("bobdev", "TOKEN-1");
  assert.equal(pulled.length, 3);
  assert.equal(skipped, 1);
  assert.equal(pulled[0]!.envelope?.messageId, env.messageId);
  assert.equal(pulled[1]!.pointer?.recipient, BOB);
  assert.equal(pulled[2]!.skippedReason, "no parseable arknetz-mail fence in Issue body");
});

test("delivery: pollInbox throws on a non-200 pull; closeDelivered PATCHes the issue", async () => {
  const { fetchFn, calls } = mockGithubFetch(async (url) => {
    if (url.includes("/issues?")) return { status: 403, payload: { message: "forbidden" } };
    return { status: 200, payload: {} };
  });
  const delivery = new MailDelivery(fetchFn);
  await assert.rejects(() => delivery.pollInbox("bobdev", "TOKEN-1"), /403/);
  await delivery.closeDelivered("bobdev", 9, "TOKEN-1");
  assert.equal(calls[calls.length - 1]!.method, "PATCH");
  assert.ok(calls[calls.length - 1]!.url.endsWith("/issues/9"));
});

test("delivery: pointer Issue call shape carries the pointer fence, not the ciphertext", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  const pointer = await buildMailPointer(env, "gh:alice/mail-outbox#x");
  const deliveries = await makePointerDeliveriesForKeys(env, pointer, [BOB]);
  const call = buildDeliverPointerCall(deliveries[0]!, "bobdev", "TOKEN-1");
  const body = call.body as Record<string, unknown>;
  assert.ok((body.body as string).includes("arknetz-mail-pointer"));
  assert.ok(!(body.body as string).includes(env.ciphertextB64));
  assert.notEqual(parsePointerIssueBody(body.body as string), null);
});


// --- per-user keys (fix round 3, 2026-11-20) -------------------------------
// Mail goes out under the SENDER's own GitHub token. An empty token
// must throw before any call is built — never an empty `Bearer `
// header, never a shared mail token.

test("per-user keys: mail call builders refuse an empty sender token", () => {
  assert.throws(() => buildDeliverIssueCall({} as never, "bobdev", ""), /own GitHub token|sign in/i);
  assert.throws(() => buildDeliverIssueCall({} as never, "bobdev", "   "), /own GitHub token|sign in/i);
  assert.throws(() => buildDeliverPointerCall({} as never, "bobdev", ""), /own GitHub token|sign in/i);
  assert.throws(() => buildCloseIssueCall("bobdev", 12, ""), /own GitHub token|sign in/i);
  assert.throws(() => buildListInboxIssuesCall("bobdev", ""), /own GitHub token|sign in/i);
});

test("per-user keys: MailDelivery.deliver/pollInbox refuse an empty token and make no network call", async () => {
  const env = await sealFor(plainMail(), [bobKeys]);
  let calls = 0;
  const { fetchFn } = mockGithubFetch(async () => {
    calls++;
    return { status: 201, payload: { number: 42 } };
  });
  const delivery = new MailDelivery(fetchFn);
  await assert.rejects(() => delivery.deliver(env, "bobdev", ""), /own GitHub token|sign in/i);
  await assert.rejects(() => delivery.pollInbox("bobdev", ""), /own GitHub token|sign in/i);
  await assert.rejects(() => delivery.closeDelivered("bobdev", 9, ""), /own GitHub token|sign in/i);
  assert.equal(calls, 0, "no GitHub call may happen without the sender's own token");
});

// --- inbox ------------------------------------------------------------------

async function bobInboxWithMail(): Promise<{ inbox: Inbox; env: EncryptedMailEnvelope }> {
  const store = createMemoryMailStore();
  const inbox = new Inbox(store, bobKeys);
  const env = await sealFor(
    plainMail({ sentAt: Date.parse("2026-11-20T10:00:00Z") }),
    [bobKeys],
  );
  await inbox.receive(env, 101);
  return { inbox, env };
}

test("inbox: receive stores unread; open decrypts locally and marks read", async () => {
  const { inbox, env } = await bobInboxWithMail();
  assert.equal(await inbox.unreadCount(), 1);
  const plain = await inbox.open(env.messageId);
  assert.equal(plain.subject, "Hello from the protocol");
  assert.equal(await inbox.unreadCount(), 0);
  // Second open returns the cached plaintext without re-decrypting.
  assert.equal((await inbox.open(env.messageId)).body, plain.body);
});

test("inbox: opening mail sealed for someone else throws (not for you)", async () => {
  const store = createMemoryMailStore();
  const inbox = new Inbox(store, bobKeys);
  // Mail to Alice, sealed only for Alice, lands in Bob's local store
  // (e.g. a mis-delivered pull) — Bob cannot open it.
  const env = await sealFor(plainMail({ from: CAROL, to: [ALICE] }), [aliceKeys]);
  await inbox.receive(env, 5);
  await assert.rejects(() => inbox.open(env.messageId), /no wrapped key/);
});

test("inbox: search by sender, subject, body and date; unread-only filter", async () => {
  const { inbox } = await bobInboxWithMail();
  const env2 = await sealFor(
    plainMail({
      from: CAROL,
      subject: "Budget numbers",
      body: "The quarterly budget is attached.",
      sentAt: Date.parse("2026-11-21T09:00:00Z"),
    }),
    [bobKeys],
  );
  await inbox.receive(env2, 102);
  // Open the second message so its body is searchable (sealed bodies
  // cannot be searched); the first stays unread.
  await inbox.open(env2.messageId);
  assert.equal((await inbox.search({ query: "carol@" })).length, 1);
  assert.equal((await inbox.search({ query: "budget" })).length, 1);
  assert.equal((await inbox.search({ query: "quarterly" })).length, 1);
  assert.equal((await inbox.search({ date: "2026-11-20" })).length, 1);
  assert.equal((await inbox.search({ date: "2026-11-21" })).length, 1);
  assert.equal((await inbox.search({ unreadOnly: true })).length, 1);
  await inbox.markRead(env2.messageId, false);
  assert.equal((await inbox.search({ unreadOnly: true })).length, 2);
  assert.equal((await inbox.search({ sentAfter: Date.parse("2026-11-21T00:00:00Z") })).length, 1);
});

test("inbox: threading groups a reply with the original; Reply All keeps the thread", async () => {
  const store = createMemoryMailStore();
  const inbox = new Inbox(store, bobKeys);
  const original = plainMail({ to: [BOB, CAROL] });
  const env1 = await sealFor(original, [bobKeys, carolKeys]);
  await inbox.receive(env1, 201);
  const opened = await inbox.open(env1.messageId);
  // Bob replies-all: draft keeps the thread, then it is sealed and received back.
  const draft = replyDraft(opened, BOB, true);
  draft.body = "Replying to everyone.";
  const replyEnv = await buildMailFromDraft(draft, bobKeys, resolveKey);
  assert.equal(replyEnv.threadId, original.threadId);
  await inbox.receive(replyEnv, 202);
  const threads = await inbox.threads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.messages.length, 2);
  assert.equal(threads[0]!.subject, original.subject);
  assert.ok(threads[0]!.participants.includes(ALICE));
});

test("inbox: reply-all recipients exclude the replier and never include BCC", () => {
  const plain = plainMail({ from: ALICE, to: [BOB, CAROL], cc: [DAVE] });
  const { to, cc } = replyAllRecipients(plain, BOB);
  assert.deepEqual(to, [ALICE, CAROL]);
  assert.deepEqual(cc, [DAVE]);
  assert.equal(normaliseSubject("Re:  Hello World "), "hello world");
});

test("inbox: archive moves to the archive folder and returns the mail-archive record", async () => {
  const { inbox, env } = await bobInboxWithMail();
  const record = await inbox.archive(env.messageId);
  assert.equal(record.messageId, env.messageId);
  assert.equal(record.subject, "Hello from the protocol");
  assert.equal(record.envelope.messageId, env.messageId);
  assert.equal((await inbox.list("inbox")).length, 0);
  assert.equal((await inbox.list("archive")).length, 1);
  assert.equal(buildMailArchiveRecord((await inbox.list("archive"))[0]!).messageId, env.messageId);
});

test("inbox: delete removes locally and returns the exact close-Issue call", async () => {
  const { inbox, env } = await bobInboxWithMail();
  const { closeCall } = await inbox.delete(env.messageId, "bobdev", "TOKEN-1");
  assert.notEqual(closeCall, null);
  assert.equal(closeCall!.method, "PATCH");
  assert.equal(closeCall!.url, "https://api.github.com/repos/bobdev/protocol-inbox/issues/101");
  assert.deepEqual(closeCall!.body, { state: "closed" });
  assert.equal((await inbox.list("inbox")).length, 0);
  // No Issue number -> no close call.
  const store = createMemoryMailStore();
  const inbox2 = new Inbox(store, bobKeys);
  const env2 = await sealFor(plainMail(), [bobKeys]);
  await inbox2.receive(env2);
  const noCall = await inbox2.delete(env2.messageId, "bobdev", "TOKEN-1");
  assert.equal(noCall.closeCall, null);
});

// --- compose ----------------------------------------------------------------

test("compose: address validation — good, malformed, uppercase, external provider", () => {
  assert.equal(validateMailAddress("alice@computers.edu"), null);
  assert.equal(validateMailAddress("a.b-c_d@sub.example.org"), null);
  assert.match(validateMailAddress("not-an-address") ?? "", /user@custom\.domain/);
  assert.match(validateMailAddress("Alice@computers.edu") ?? "", /lowercase/);
  assert.match(validateMailAddress("x@-bad-.com") ?? "", /invalid domain/);
  const gmail = validateMailAddress("friend@gmail.com") ?? "";
  assert.match(gmail, /protocol-native only/);
  assert.match(gmail, /cannot email Gmail, Outlook/);
  assert.match(validateMailAddress("friend@outlook.com") ?? "", /protocol-native only/);
});

test("compose: draft validation catches no recipients, duplicates, oversize attachments, long body", () => {
  const d0 = newDraft(ALICE);
  assert.ok(validateDraft(d0).some((e) => e.includes("at least one recipient")));
  const d1 = newDraft(ALICE);
  d1.to = [BOB, BOB];
  d1.subject = "s";
  assert.ok(validateDraft(d1).some((e) => e.includes("more than once")));
  const d2 = newDraft(ALICE);
  d2.to = [BOB];
  d2.subject = "s";
  d2.attachments = [
    { filename: "big.bin", mime: "application/octet-stream", data: new Uint8Array(10_000_001) },
  ];
  assert.ok(validateDraft(d2).some((e) => e.includes("too large")));
  const d3 = newDraft(ALICE);
  d3.to = [BOB];
  d3.subject = "s";
  d3.body = "x".repeat(200_001);
  assert.ok(validateDraft(d3).some((e) => e.includes("too long")));
  const d4 = newDraft(ALICE);
  d4.to = [BOB];
  d4.subject = "s";
  d4.body = "fine";
  assert.deepEqual(validateDraft(d4), []);
});

test("compose: drafts autosave to the store and restore on reopen", async () => {
  const store = createMemoryDraftStore();
  const draft = newDraft(ALICE);
  draft.to = [BOB];
  draft.subject = "Draft subject";
  const saved = await saveDraft(store, draft);
  assert.equal(saved.draftId, draft.draftId);
  const restored = await restoreDraft(store, draft.draftId);
  assert.equal(restored?.subject, "Draft subject");
  assert.deepEqual(restored?.to, [BOB]);
  assert.equal((await store.list()).length, 1);
  assert.equal(await restoreDraft(store, "draft-nope"), undefined);
});

test("compose: buildMailFromDraft seals so every recipient can open it; BCC stays hidden", async () => {
  const draft = newDraft(ALICE);
  draft.to = [BOB];
  draft.cc = [DAVE];
  draft.bcc = [CAROL];
  draft.subject = "Group update";
  draft.body = "Hello all.";
  draft.attachments = [
    { filename: "a.txt", mime: "text/plain", data: new TextEncoder().encode("hi") },
  ];
  const env = await buildMailFromDraft(draft, aliceKeys, resolveKey);
  assert.equal(env.recipients.length, 2);
  for (const [addr, keys] of [
    [BOB, bobKeys],
    [DAVE, daveKeys],
    [CAROL, carolKeys],
  ] as const) {
    const opened = await openMail(env, addr, keys.privateKey);
    assert.equal(opened.subject, "Group update");
    assert.equal(opened.attachments.length, 1);
    assert.ok(!opened.to.includes(CAROL));
  }
});

test("compose: buildMailFromDraft fails without a published key, and on From mismatch", async () => {
  const draft = newDraft(ALICE);
  draft.to = ["ghost@computers.edu"];
  draft.subject = "s";
  await assert.rejects(
    () => buildMailFromDraft(draft, aliceKeys, resolveKey),
    /no public key/,
  );
  const draft2 = newDraft(BOB);
  draft2.to = [CAROL];
  draft2.subject = "s";
  await assert.rejects(
    () => buildMailFromDraft(draft2, aliceKeys, resolveKey),
    /does not match/,
  );
});

test("compose: replyDraft keeps the thread, prefixes Re: once, quotes the original", () => {
  const original = plainMail({ subject: "Budget", body: "Line one\nLine two" });
  const reply = replyDraft(original, BOB, false);
  assert.equal(reply.threadId, original.threadId);
  assert.equal(reply.inReplyTo, original.messageId);
  assert.equal(reply.subject, "Re: Budget");
  assert.deepEqual(reply.to, [ALICE]);
  assert.ok(reply.body.includes("> Line one"));
  const reply2 = replyDraft({ ...original, subject: "Re: Budget" }, BOB, false);
  assert.equal(reply2.subject, "Re: Budget");
});

// --- team inbox ---------------------------------------------------------------

test("team: createTeamInbox seals the team key per member and publishes no cleartext private key", async () => {
  const inbox = await createTeamInbox(TEAM, "computers.edu", [
    contactFor(aliceKeys),
    contactFor(bobKeys),
  ]);
  assert.equal(inbox.address, TEAM);
  assert.equal(inbox.members.length, 2);
  assert.equal(inbox.publicKeyJwk.kty, "OKP");
  assert.equal(inbox.publicKeyJwk.crv, "X25519");
  const dumped = JSON.stringify(inbox);
  // The private JWK's "d" parameter must not appear anywhere. (Base64
  // cannot contain a double-quote, so it cannot hide inside a sealed blob.)
  assert.ok(!dumped.includes('"d":'));
  // Each member can open their sealed team key.
  const aliceTeamKey = await openTeamKeyForMember(inbox, ALICE, aliceKeys.privateKey);
  assert.equal(aliceTeamKey.type, "private");
});

test("team: mail.read / mail.send gates deny correctly and name the missing flag", () => {
  const reader: TeamRole = { name: "reader", flags: ["mail.read"] };
  const writerNoMail: TeamRole = { name: "writer", flags: ["pages.draft"] };
  assert.equal(gateTeamMailRead(reader).allowed, true);
  assert.equal(gateTeamMailSend(reader).allowed, false);
  assert.match(gateTeamMailSend(reader).reason, /mail\.send/);
  assert.equal(gateTeamMailRead(writerNoMail).allowed, false);
  assert.match(gateTeamMailRead(writerNoMail).reason, /mail\.read/);
  assert.equal(gateTeamMailRead(OWNER_ROLE).allowed, true);
  assert.equal(gateTeamMailSend(OWNER_ROLE).allowed, true);
  assert.equal(gateTeamMailRead(WRITER_ROLE).allowed, false);
});

test("team: an authorised member with mail.read opens team mail; without the flag they are refused", async () => {
  const inbox = await createTeamInbox(TEAM, "computers.edu", [contactFor(aliceKeys)]);
  const pub = await teamPublicKey(inbox);
  const plain = plainMail({ from: DAVE, to: [TEAM], subject: "Support request" });
  const env = await sealMail(plain, [{ address: TEAM, publicKey: pub.publicKey }]);
  const reader: TeamRole = { name: "support", flags: ["mail.read", "mail.send"] };
  const opened = await openTeamMail(env, inbox, ALICE, aliceKeys.privateKey, reader);
  assert.equal(opened.subject, "Support request");
  const noRead: TeamRole = { name: "writer", flags: ["pages.draft"] };
  await assert.rejects(
    () => openTeamMail(env, inbox, ALICE, aliceKeys.privateKey, noRead),
    /mail\.read/,
  );
  await assert.rejects(
    () => openTeamMail(env, inbox, BOB, bobKeys.privateKey, reader),
    /not an authorised member/,
  );
});

// --- mail UI ------------------------------------------------------------------

test("mail-ui: inbox view model sorts newest first, counts unread, hides sealed subjects", async () => {
  const store = createMemoryMailStore();
  const inbox = new Inbox(store, bobKeys);
  const env1 = await sealFor(plainMail({ sentAt: 1000 }), [bobKeys]);
  const env2 = await sealFor(
    plainMail({ from: CAROL, subject: "Later mail", sentAt: 2000 }),
    [bobKeys],
  );
  await inbox.receive(env1, 1);
  await inbox.receive(env2, 2);
  const vm = inboxViewModel(await inbox.list());
  assert.equal(vm.totalCount, 2);
  assert.equal(vm.unreadCount, 2);
  // Sealed messages show the placeholder subject until opened.
  assert.equal(vm.rows[0]!.subject, "(encrypted — open to read)");
  assert.ok(vm.notice.includes("protocol-native only"));
  assert.ok(vm.notice.includes("Gmail"));
  await inbox.open(env2.messageId);
  const vm2 = inboxViewModel(await inbox.list());
  assert.equal(vm2.rows[0]!.subject, "Later mail");
  assert.equal(vm2.unreadCount, 1);
});

test("mail-ui: compose view model enables Send only when there are no errors", () => {
  const draft = newDraft(ALICE);
  draft.to = [BOB];
  draft.subject = "Hi";
  const ok = composeViewModel(draft, validateDraft(draft));
  assert.equal(ok.canSend, true);
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.notice.includes("protocol-native only"));
  const bad = composeViewModel(draft, ["Add at least one recipient (To, CC or BCC)."]);
  assert.equal(bad.canSend, false);
  assert.equal(bad.errors.length, 1);
});

test("mail-ui: thread view model maps messages with attachments and unread flags", async () => {
  const store = createMemoryMailStore();
  const inbox = new Inbox(store, bobKeys);
  const env = await sealFor(
    plainMail({
      attachments: [{ filename: "f.txt", mime: "text/plain", data: new TextEncoder().encode("x") }],
    }),
    [bobKeys],
  );
  await inbox.receive(env, 1);
  await inbox.open(env.messageId);
  const threads = await inbox.threads();
  const vm = threadViewModel(threads[0]!);
  assert.equal(vm.subject, "Hello from the protocol");
  assert.equal(vm.messages.length, 1);
  assert.equal(vm.messages[0]!.attachments[0]!.filename, "f.txt");
  assert.equal(vm.messages[0]!.attachments[0]!.bytes, 1);
});

test("mail-ui: the protocol-only notice states the boundary plainly", () => {
  assert.ok(MAIL_ONLY_PROTOCOL_NOTICE.includes("cannot email a Gmail"));
  assert.ok(MAIL_ONLY_PROTOCOL_NOTICE.includes("user@custom.domain"));
});
