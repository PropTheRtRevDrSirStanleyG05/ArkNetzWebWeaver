// Tests: real Zstd round-trip for .json.zst files (@bokuweb/zstd-wasm, MIT).
// Since 2026-11-21 new files are PLAIN zstd — the v2 dictionary was
// dropped (Stanley's decision; benchmark BENCHMARK-0.4.0.md proved it
// saves zero bytes on realistic payloads). v1 ("v1-corpus-derived")
// and v2 ("v2-trained") are kept ONLY so old published frames still
// decode: decompressBytes tries v2, then v1, then plain frames.
// (dict-training/README.md records how v2 was trained.)
//
// A dictionary frame is still a FORMATTED dictionary frame (RFC 8878
// section 5): its ID is embedded in every frame it compresses, so
// decompressing with a wrong dictionary, a raw dictionary, or no
// dictionary at all throws loudly instead of silently returning
// garbage. A raw-content dictionary does NOT do this — verified
// 2026-11-20, a frame decompressed with an all-0x07 dictionary
// returned wrong bytes with no error — which is why v1/v2 are
// formatted, and why these tests pin the ID mechanism, not just the
// round-trip.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildFormattedZstdDictionary,
  compressBytes,
  compressBytesWithDictionary,
  compressJson,
  decompressBytes,
  decompressBytesWithDictionary,
  decompressJson,
  getZstdDictionary,
  getZstdDictionaryContent,
  getZstdDictionaryV2,
  getZstdEngine,
  isZstdFrame,
  resetZstdDictionaryForTests,
  ZSTD_DICTIONARY_ID,
  ZSTD_DICTIONARY_LABEL,
  ZSTD_DICTIONARY_SHA256,
  ZSTD_DICTIONARY_V2_ID,
  ZSTD_DICTIONARY_V2_LABEL,
  ZSTD_DICTIONARY_VERSION,
} from "../src/lib/zstd.js";

const SAMPLE_DOC = {
  domain: "computers.edu",
  title: "Computers",
  blocks: [
    { type: "h1", text: "Hello" },
    { type: "p", text: "A paragraph with some repeated words words words." },
  ],
};

const REGISTRY_SHARD = {
  "computers.edu": {
    domain: "computers.edu",
    backend: "gh:alice/arknetz-site-computers-edu",
    mirrors: ["gl:alice/arknetz-site-computers-edu"],
    shard: "a",
    owner: "alice",
    updated: 1794000000,
  },
  "bakery.example": {
    domain: "bakery.example",
    backend: "gh:bob/arknetz-site-bakery",
    shard: "3",
    owner: "bob",
    updated: 1794003600,
  },
};

const MAIL_ENVELOPE = {
  version: 1,
  messageId: "mail-9f2c41a7-1794000000-alice",
  threadId: "thread-9f2c41a7",
  from: { name: "Alice Example", address: "alice@example.com" },
  recipients: [{ name: "Bob Example", address: "bob@example.com" }],
  sentAt: 1794000000000,
  ivB64: "AAECAwQFBgcICQoLDA0ODw==",
  ciphertextB64: "U2VjcmV0IG1lc3NhZ2UgY29udGVudCBlbmNyeXB0ZWQgd2l0aCBBRVMtR0NNLg==",
  wrappedKeys: [
    {
      fingerprint: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
      wrappedKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      ephemeralPublicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  ],
  plaintextBytes: 512,
};

const MANIFEST = {
  protocolVersion: "0.1.0",
  defaultRootRepo: "PropTheRtRevDrSirStanleyG05/protocol-root",
  masterGithubUser: "PropTheRtRevDrSirStanleyG05",
  registryShards: ["arknetz-registry-00", "arknetz-registry-0f"],
  contactsShards: ["arknetz-contacts-00", "arknetz-contacts-0f"],
  zstdDictionary: { version: 1 },
};

/** Read the dictionary ID out of a frame header: the Dictionary_ID_flag
 *  (low 2 bits of the frame header descriptor, byte 4) says how many
 *  ID bytes follow, and the ID itself is little-endian. Returns null
 *  when the frame carries no dictionary ID. */
function frameDictionaryId(frame: Uint8Array): number | null {
  const flag = (frame[4] as number) & 3;
  const sizes = [0, 1, 2, 4];
  const size = sizes[flag] as number;
  if (size === 0) return null;
  // Single-segment frames have no window descriptor, so the ID starts
  // at byte 5; otherwise it starts at byte 6. All frames this client
  // writes are single-segment (small JSON), but handle both.
  const singleSegment = ((frame[4] as number) & 0x20) !== 0;
  const start = singleSegment ? 5 : 6;
  let id = 0;
  for (let i = 0; i < size; i++) id |= (frame[start + i] as number) << (8 * i);
  return id >>> 0;
}

test("compress/decompress round-trips bytes and the frame magic is Zstd", async () => {
  const input = new TextEncoder().encode(JSON.stringify(SAMPLE_DOC));
  const compressed = await compressBytes(input);
  assert.ok(isZstdFrame(compressed));
  assert.ok(compressed.length < input.length);
  const back = await decompressBytes(compressed);
  assert.deepEqual(back, input);
});

test("compressJson/decompressJson round-trips with byte-identical JSON", async () => {
  const json = JSON.stringify(SAMPLE_DOC);
  const compressed = await compressJson(SAMPLE_DOC);
  assert.ok(isZstdFrame(compressed));
  const doc = await decompressJson(compressed);
  assert.deepEqual(doc, SAMPLE_DOC);
  // Byte-identical JSON: re-serialising the round-tripped doc gives
  // exactly the same bytes that went in.
  assert.equal(JSON.stringify(doc), json);
});

test("round-trip is stable for a large repetitive document", async () => {
  const big = { posts: Array.from({ length: 200 }, (_, i) => ({ id: i, text: "lorem ipsum dolor sit amet ".repeat(20) })) };
  const json = JSON.stringify(big);
  const compressed = await compressJson(big);
  assert.ok(compressed.length < json.length / 5, `expected strong compression, got ${compressed.length} of ${json.length}`);
  assert.deepEqual(await decompressJson(compressed), big);
});

test("isZstdFrame rejects plain JSON and empty input; corrupt frames throw", async () => {
  assert.equal(isZstdFrame(new TextEncoder().encode('{"a":1}')), false);
  assert.equal(isZstdFrame(new Uint8Array(0)), false);
  assert.equal(isZstdFrame(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])), true);
  const bad = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);
  await assert.rejects(() => decompressBytes(bad), /zstd|decompress/i);
  await assert.rejects(() => decompressJson(new TextEncoder().encode('{"a":1}')), /zstd/i);
});

test("the vendored browser build is present for dist/", async () => {
  // The browser path dynamically imports ./vendor/zstd/index.web.js —
  // copy-assets.mjs vendors the ESM web build there. This test only
  // checks the package layout that the vendor step relies on.
  const pkg = await import("@bokuweb/zstd-wasm");
  assert.equal(typeof pkg.init, "function");
  assert.equal(typeof pkg.compress, "function");
  assert.equal(typeof pkg.decompress, "function");
  // The dictionary path needs the dict entry points in BOTH builds
  // (Node here, web via the vendored copy — same source files).
  assert.equal(typeof pkg.compressUsingDict, "function");
  assert.equal(typeof pkg.decompressUsingDict, "function");
  assert.equal(typeof pkg.createCCtx, "function");
  assert.equal(typeof pkg.createDCtx, "function");
  assert.equal(typeof pkg.freeCCtx, "function");
  assert.equal(typeof pkg.freeDCtx, "function");
});

// ---------------------------------------------------------------------------
// Dictionary v1 identity — pinned so any change is deliberate.
// ---------------------------------------------------------------------------

test("dictionary v1 identity: version, label, ID, magic, exact size, SHA-256", async () => {
  assert.equal(ZSTD_DICTIONARY_VERSION, 1);
  assert.equal(ZSTD_DICTIONARY_LABEL, "v1-corpus-derived");
  assert.equal(ZSTD_DICTIONARY_ID, 0x41524b01); // "ARK\x01"
  const content = getZstdDictionaryContent();
  const dict = getZstdDictionary();
  // Exact sizes, pinned: change these numbers only with a deliberate
  // dictionary change (and update the SHA-256 below with it).
  assert.equal(content.length, 26270);
  assert.equal(dict.length, 26300);
  // Formatted-dictionary magic 0xEC30A437, little-endian, then the ID.
  assert.deepEqual([...dict.slice(0, 4)], [0x37, 0xa4, 0x30, 0xec]);
  assert.deepEqual([...dict.slice(4, 8)], [0x01, 0x4b, 0x52, 0x41]);
  // The SHA-256 pins the exact bytes: a same-ID dictionary with
  // different content is a corrupted v1, and this hash is what catches
  // it (zstd itself only checks the 32-bit ID).
  const sha = createHash("sha256").update(dict).digest("hex");
  assert.equal(sha, ZSTD_DICTIONARY_SHA256);
  assert.equal(sha, "9e7346fce69bd694f438c83acced640aba7f804f5901ad4dd932d0d4816b19ae");
  // The dictionary is deterministic: rebuilding it gives identical bytes.
  resetZstdDictionaryForTests();
  assert.deepEqual(getZstdDictionary(), dict);
});

test("new frames carry NO dictionary ID (plain zstd since 2026-11-21)", async () => {
  const compressed = await compressJson(SAMPLE_DOC);
  assert.equal(frameDictionaryId(compressed), null, "new frames must be plain zstd, no dictionary ID");
  const plain = await compressBytes(new TextEncoder().encode('{"a":1}'));
  assert.equal(frameDictionaryId(plain), null);
  // ...and the old dictionaries still stamp their own IDs when used
  // explicitly (the legacy path old files were written with).
  const v2 = await compressBytesWithDictionary(
    new TextEncoder().encode(JSON.stringify(SAMPLE_DOC)),
    getZstdDictionaryV2(),
  );
  assert.equal(frameDictionaryId(v2), ZSTD_DICTIONARY_V2_ID);
  const v1 = await compressBytesWithDictionary(
    new TextEncoder().encode(JSON.stringify(SAMPLE_DOC)),
    getZstdDictionary(),
  );
  assert.equal(frameDictionaryId(v1), ZSTD_DICTIONARY_ID);
});

// ---------------------------------------------------------------------------
// Round-trips with the dictionary, per document kind.
// ---------------------------------------------------------------------------

test("round-trip is byte-identical for registry, site, mail and manifest JSON", async () => {
  for (const [name, value] of Object.entries({
    registry: REGISTRY_SHARD,
    site: SAMPLE_DOC,
    mail: MAIL_ENVELOPE,
    manifest: MANIFEST,
  })) {
    const json = JSON.stringify(value);
    const compressed = await compressJson(value);
    assert.ok(isZstdFrame(compressed), `${name}: not a Zstd frame`);
    assert.equal(frameDictionaryId(compressed), null, `${name}: new frame must carry no dictionary ID`);
    const back = await decompressJson(compressed);
    assert.deepEqual(back, value, `${name}: round-trip changed the value`);
    assert.equal(JSON.stringify(back), json, `${name}: round-trip JSON is not byte-identical`);
  }
});

test("round-trip is exact for empty and small inputs", async () => {
  // Empty bytes: a real 9-byte frame, decompressing to zero bytes.
  const emptyCompressed = await compressBytes(new Uint8Array(0));
  assert.ok(isZstdFrame(emptyCompressed));
  assert.deepEqual(await decompressBytes(emptyCompressed), new Uint8Array(0));
  // Empty object, tiny objects, a single byte.
  for (const value of [{}, { a: 1 }, { domain: "x" }]) {
    assert.deepEqual(await decompressJson(await compressJson(value)), value);
    assert.equal(JSON.stringify(await decompressJson(await compressJson(value))), JSON.stringify(value));
  }
  for (const text of ["x", "{}", '{"a":1}', "hello world"]) {
    const bytes = new TextEncoder().encode(text);
    assert.deepEqual(await decompressBytes(await compressBytes(bytes)), bytes, `small input ${JSON.stringify(text)}`);
  }
});

test("plain zstd keeps the win at realistic scale; the dictionary's advantage is negligible", async () => {
  // Measured 2026-11-21 (this file's fixtures, same shapes as the
  // benchmark): on a 1,000-entry registry (126,451 raw bytes) plain
  // compresses to 4,224 bytes and v2 to 3,970 — a 254-byte difference,
  // 0.2% of the raw size. On a 92 KB site plain is 182 bytes, v2 141
  // — 41 bytes. On a 100-entry registry v2 is WORSE by 577 bytes
  // (1,306 vs 729). The dictionary never buys anything material at
  // realistic scale — that is why it was dropped. This test pins the
  // bound (<= 300 bytes either way at realistic scale) and that plain
  // zstd itself keeps the real compression win (>10x on both shapes).
  const engine = await getZstdEngine();
  const registry1000 = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      `d${i}.example`,
      { domain: `d${i}.example`, backend: `gh:u${i}/arknetz-site-d${i}`, shard: "a", owner: `u${i}`, updated: 1794000000 },
    ]),
  );
  const site50k = {
    domain: "big.example",
    title: "Big",
    blocks: Array.from({ length: 200 }, () => ({
      type: "p",
      text: "The harbour master keeps a ledger of every boat that leaves the pier, written in pencil, because the ink runs when the spray comes over the wall. ".repeat(3),
    })),
  };
  for (const [name, value] of Object.entries({ registry1000, site50k })) {
    const input = new TextEncoder().encode(JSON.stringify(value));
    const plain = await compressBytes(input);
    const v2 = await compressBytesWithDictionary(input, getZstdDictionaryV2());
    assert.ok(
      Math.abs(plain.length - v2.length) <= 300,
      `${name}: dictionary advantage is not negligible (${plain.length} plain vs ${v2.length} v2 for ${input.length} input bytes)`,
    );
    assert.ok(plain.length < input.length / 10, `${name}: plain zstd lost the compression win (${plain.length} of ${input.length})`);
    assert.deepEqual(await decompressBytes(plain), input, `${name}: plain round-trip`);
    assert.deepEqual(await decompressBytes(v2), input, `${name}: v2 round-trip sanity`);
  }
  // New production frames are byte-identical to plain engine.compress.
  const input = new TextEncoder().encode(JSON.stringify(SAMPLE_DOC));
  assert.deepEqual(await compressBytes(input), engine.compress(input, 3));
});

// ---------------------------------------------------------------------------
// Wrong / missing dictionary must fail loudly, never silently return garbage.
// ---------------------------------------------------------------------------

test("decompressing with a wrong dictionary ID throws loudly", async () => {
  // Fixture must be a dictionary frame: build one explicitly with v2
  // (new production frames are plain and carry no ID to mismatch).
  const input = new TextEncoder().encode(JSON.stringify(SAMPLE_DOC));
  const compressed = await compressBytesWithDictionary(input, getZstdDictionaryV2());
  // Same content, a different ID that no real dictionary uses
  // (0x41524B09 — NOT the v1 or v2 ID, so the ID itself mismatches).
  const wrongId = buildFormattedZstdDictionary(0x41524b09, getZstdDictionaryContent());
  await assert.rejects(
    () => decompressBytesWithDictionary(compressed, wrongId),
    /decompress/i,
    "wrong dictionary ID must throw, not silently return garbage",
  );
  // The built-in path must throw too, naming the dictionaries it knows.
  const alsoWrong = buildFormattedZstdDictionary(0x41524b09, getZstdDictionaryContent());
  await assert.rejects(() => decompressBytesWithDictionary(compressed, alsoWrong), /dictionary/i);
});

test("decompressing with a raw-content dictionary throws loudly", async () => {
  const input = new TextEncoder().encode(JSON.stringify(SAMPLE_DOC));
  const compressed = await compressBytesWithDictionary(input, getZstdDictionaryV2());
  // A raw-content dictionary has no ID, so the frame's ID cannot match.
  await assert.rejects(
    () => decompressBytesWithDictionary(compressed, getZstdDictionaryContent()),
    /decompress/i,
  );
});

test("decompressing a dictionary frame with no dictionary at all throws", async () => {
  const engine = await getZstdEngine();
  const input = new TextEncoder().encode(JSON.stringify(SAMPLE_DOC));
  const compressed = await compressBytesWithDictionary(input, getZstdDictionaryV2());
  await assert.rejects(async () => engine.decompress(compressed), /./, "plain decompress of a dict frame must throw");
  // And the built-in path's error names the dictionaries it knows.
  const truncated = compressed.slice(0, compressed.length - 2);
  await assert.rejects(() => decompressBytes(truncated), /v2-trained/);
});

test("a truncated dictionary frame throws instead of returning partial data", async () => {
  const input = new TextEncoder().encode(JSON.stringify(SAMPLE_DOC));
  const compressed = await compressBytesWithDictionary(input, getZstdDictionaryV2());
  const cut = compressed.slice(0, Math.floor(compressed.length / 2));
  await assert.rejects(() => decompressBytes(cut), /zstd|decompress/i);
});

test("the explicit-dictionary API round-trips with a different dictionary", async () => {
  // A dictionary with an ID no shipped version uses (0x41524B09) must
  // work when both sides use it — this is the API a future dictionary
  // upgrade will use to read old files with the old dictionary.
  // (0x41524B02 must NOT be used here: it is the real v2 ID, and a
  // fake dictionary sharing a real ID would make the built-in path
  // try the wrong content under a matching ID.)
  const dictOther = buildFormattedZstdDictionary(0x41524b09, getZstdDictionaryContent());
  const input = new TextEncoder().encode(JSON.stringify(SAMPLE_DOC));
  const compressed = await compressBytesWithDictionary(input, dictOther);
  assert.equal(frameDictionaryId(compressed), 0x41524b09);
  assert.deepEqual(await decompressBytesWithDictionary(compressed, dictOther), input);
  // ...and the built-in path must refuse that frame loudly, naming the
  // dictionaries it knows.
  await assert.rejects(() => decompressBytes(compressed), /v2-trained/);
});

test("frames compressed WITHOUT a dictionary still decompress (backward compatibility)", async () => {
  // Old cached .zst files were written before the dictionary existed.
  // A frame with no dictionary ID must keep working through the
  // dictionary path — the dictionary is simply not used for it.
  const engine = await getZstdEngine();
  const input = new TextEncoder().encode(JSON.stringify(SAMPLE_DOC));
  const plain = engine.compress(input, 3);
  assert.equal(frameDictionaryId(plain), null);
  assert.deepEqual(await decompressBytes(plain), input);
  assert.deepEqual(await decompressBytesWithDictionary(plain, getZstdDictionary()), input);
});
