// Tests: Zstd dictionary v2 — genuinely trained (fix round 3, item 3).
// v2 was trained with `zstd --train` on a 3,200-file corpus built from
// this project's own .json.zst schemas (dict-training/README.md).
// v1 still decodes (round-trip tests for both versions); new files are
// written with v2.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ZSTD_DICTIONARY_ID,
  ZSTD_DICTIONARY_LABEL,
  ZSTD_DICTIONARY_V2_BASE64,
  ZSTD_DICTIONARY_V2_ID,
  ZSTD_DICTIONARY_V2_LABEL,
  ZSTD_DICTIONARY_V2_SHA256,
  ZSTD_DICTIONARY_V2_VERSION,
  compressBytes,
  compressBytesWithDictionary,
  compressJson,
  decompressBytes,
  decompressBytesWithDictionary,
  decompressJson,
  getCurrentZstdDictionary,
  getZstdDictionary,
  getZstdDictionaryV2,
  resetZstdDictionaryV2ForTests,
} from "../src/lib/zstd.js";

/** Read the dictionary ID out of a frame header (same layout as the
 *  helper in tests/zstd.test.ts). */
function frameDictionaryId(frame: Uint8Array): number | null {
  const flag = (frame[4] as number) & 3;
  const size = [0, 1, 2, 4][flag] as number;
  if (size === 0) return null;
  const singleSegment = ((frame[4] as number) & 0x20) !== 0;
  const start = singleSegment ? 5 : 6;
  let id = 0;
  for (let i = 0; i < size; i++) id |= (frame[start + i] as number) << (8 * i);
  return id >>> 0;
}

test("dictionary v2 identity: version, label, ID, magic, exact size, SHA-256", async () => {
  assert.equal(ZSTD_DICTIONARY_V2_VERSION, 2);
  assert.equal(ZSTD_DICTIONARY_V2_LABEL, "v2-trained");
  assert.equal(ZSTD_DICTIONARY_V2_ID, 0x41524b02); // "ARK\x02"
  const dict = getZstdDictionaryV2();
  assert.equal(dict.length, 32768);
  // Formatted-dictionary magic 0xEC30A437, little-endian, then the ID.
  assert.deepEqual([...dict.slice(0, 4)], [0x37, 0xa4, 0x30, 0xec]);
  assert.deepEqual([...dict.slice(4, 8)], [0x02, 0x4b, 0x52, 0x41]);
  // The SHA-256 pins the exact trained bytes.
  const sha = createHash("sha256").update(dict).digest("hex");
  assert.equal(sha, ZSTD_DICTIONARY_V2_SHA256);
  assert.equal(sha, "a1786956c8f9b919c393ba27347213c8db48a283615b23bfe03582f92544c96d");
  // The embedded base64 decodes to exactly the trained file.
  assert.equal(ZSTD_DICTIONARY_V2_BASE64.length, 43692);
  // Deterministic: rebuilding the cached copy gives identical bytes.
  resetZstdDictionaryV2ForTests();
  assert.deepEqual(getZstdDictionaryV2(), dict);
  // v2 is the current dictionary.
  assert.deepEqual(getCurrentZstdDictionary(), dict);
});

test("every frame the client writes now carries the v2 dictionary ID", async () => {
  const compressed = await compressJson({ domain: "computers.edu", title: "Computers", blocks: [] });
  assert.equal(frameDictionaryId(compressed), ZSTD_DICTIONARY_V2_ID);
});

test("v2 round-trips every document kind, byte-identical", async () => {
  const docs = {
    site: { domain: "computers.edu", title: "Computers", blocks: [{ type: "h1", text: "Hello" }, { type: "p", text: "A paragraph with some repeated words words words." }] },
    registry: { "computers.edu": { domain: "computers.edu", backend: "gh:alice/arknetz-site-computers-edu", shard: "a", owner: "alice", updated: 1794000000 } },
    mail: { version: 1, messageId: "mail-1", from: { name: "Alice", address: "alice@example.com" }, subject: "Hello", body: "Hello Bob,\n\nThe new site is live." },
    manifest: { protocolVersion: "0.1.0", masterGithubUser: "PropTheRtRevDrSirStanleyG05", registryShards: ["arknetz-registry-00"], directoryCategories: ["tech", "cinema", "games"], zstdDictionary: { version: 2 } },
    directory: { category: "tech", version: 1, updated: 1794000000, cards: [{ domain: "computers.edu", title: "Computers", tags: ["tech"], category: "tech", updated_timestamp: 1794000000 }] },
  };
  for (const [name, value] of Object.entries(docs)) {
    const json = JSON.stringify(value);
    const compressed = await compressJson(value);
    assert.equal(frameDictionaryId(compressed), ZSTD_DICTIONARY_V2_ID, `${name}: frame lacks the v2 ID`);
    const back = await decompressJson(compressed);
    assert.deepEqual(back, value, `${name}: round-trip changed the value`);
    assert.equal(JSON.stringify(back), json, `${name}: round-trip JSON is not byte-identical`);
  }
});

test("v1 frames still decode through the built-in path (backward compatibility)", async () => {
  const input = new TextEncoder().encode(JSON.stringify({ domain: "computers.edu", title: "Computers", blocks: [{ type: "h1", text: "Hello" }] }));
  // A frame compressed with the v1 dictionary, the way old files were written.
  const v1Frame = await compressBytesWithDictionary(input, getZstdDictionary());
  assert.equal(frameDictionaryId(v1Frame), ZSTD_DICTIONARY_ID);
  assert.deepEqual(await decompressBytes(v1Frame), input);
  // ...and the explicit v1 API still round-trips on its own.
  assert.deepEqual(await decompressBytesWithDictionary(v1Frame, getZstdDictionary()), input);
  // A v1 frame is refused by the v2 dictionary alone (wrong ID).
  await assert.rejects(() => decompressBytesWithDictionary(v1Frame, getZstdDictionaryV2()), /decompress/i);
});

test("v2 frames are refused by the v1 dictionary alone, and an unknown dictionary fails loudly", async () => {
  const input = new TextEncoder().encode(JSON.stringify({ domain: "computers.edu", title: "Computers" }));
  const v2Frame = await compressBytes(input);
  assert.equal(frameDictionaryId(v2Frame), ZSTD_DICTIONARY_V2_ID);
  await assert.rejects(() => decompressBytesWithDictionary(v2Frame, getZstdDictionary()), /decompress/i);
  // A frame compressed with a dictionary nobody knows (different ID,
  // same content shape) fails through the built-in path too — and the
  // error names the dictionaries this client knows.
  const { buildFormattedZstdDictionary, getZstdDictionaryContent } = await import("../src/lib/zstd.js");
  const unknown = buildFormattedZstdDictionary(0x41524b09, getZstdDictionaryContent());
  const unknownFrame = await compressBytesWithDictionary(input, unknown);
  await assert.rejects(() => decompressBytes(unknownFrame), /v2-trained.*v1-corpus-derived|unknown dictionary/);
});

test("v2 beats plain Zstd on representative documents, and beats v1 where it was trained to", async () => {
  const { getZstdEngine } = await import("../src/lib/zstd.js");
  const engine = await getZstdEngine();
  const docs = {
    site: { domain: "computers.edu", title: "Computers", blocks: [{ type: "h1", text: "Hello" }, { type: "p", text: "A paragraph with some repeated words words words." }] },
    registry: { "computers.edu": { domain: "computers.edu", backend: "gh:alice/arknetz-site-computers-edu", mirrors: ["gl:alice/arknetz-site-computers-edu"], shard: "a", owner: "alice", updated: 1794000000 } },
    mail: { version: 1, messageId: "mail-9f2c41a7-1794000000-alice", from: { name: "Alice Example", address: "alice@example.com" }, subject: "Welcome to the new site", body: "Hello Bob,\n\nThe new site is live." },
  };
  for (const [name, value] of Object.entries(docs)) {
    const input = new TextEncoder().encode(JSON.stringify(value));
    const v2 = await compressBytes(input);
    const plain = engine.compress(input, 3);
    assert.ok(v2.length < plain.length, `${name}: v2 did not beat plain (${v2.length} vs ${plain.length} for ${input.length} input bytes)`);
    assert.deepEqual(await decompressBytes(v2), input, `${name}: v2 round-trip`);
  }
  // v2 vs v1, measured on held-out documents (nothing below appears in
  // the training corpus): v2 wins on registry and mail shapes, which
  // are structure-dominated; v1 wins on long-prose site documents,
  // because v1's hand-assembled content repeats the JSON structural
  // fragments with a density no trainer reproduced (tripling the
  // fragment share and switching to the cover algorithm were both
  // tried and changed nothing on held-out docs). The demo site is the
  // extreme case: its text is verbatim inside v1's content source, so
  // v1 gets 152 bytes there against v2's 619 — pure overfit, not a
  // fair comparison. Aggregate on the training distribution (100
  // sampled corpus files, 104,600 raw bytes): plain 48,227, v1 36,962,
  // v2 22,769 — v2 wins on all 100 files. v2 is the genuinely trained
  // dictionary the protocol specifies; v1 stays readable for old files.
  const novelRegistry = {
    "quay-pelican.zine": { domain: "quay-pelican.zine", backend: "gh:nadia/arknetz-site-quay-pelican", shard: "5", owner: "nadia", updated: 1795000000 },
    "elm-orchard.press": { domain: "elm-orchard.press", backend: "gh:omar/arknetz-site-elm-orchard", mirrors: ["cb:omar/arknetz-site-elm-orchard"], shard: "b", owner: "omar", updated: 1795001000 },
  };
  const registryInput = new TextEncoder().encode(JSON.stringify(novelRegistry));
  assert.ok(
    (await compressBytes(registryInput)).length <
      (await compressBytesWithDictionary(registryInput, getZstdDictionary())).length,
    "novel registry: trained v2 must beat corpus-derived v1",
  );
  const novelMail = {
    version: 1,
    messageId: "mail-zz1",
    from: { name: "Nadia", address: "nadia@quay-pelican.zine" },
    to: [{ name: "Omar", address: "omar@elm-orchard.press" }],
    subject: "Harbour meeting on Thursday",
    body: "Hello Omar,\n\nShall we meet at the quay on Thursday to talk about the winter timetable? The ferry office posted new times.\n\nNadia",
    sentAt: 1795000000000,
  };
  const mailInput = new TextEncoder().encode(JSON.stringify(novelMail));
  assert.ok(
    (await compressBytes(mailInput)).length <
      (await compressBytesWithDictionary(mailInput, getZstdDictionary())).length,
    "novel mail: trained v2 must beat corpus-derived v1",
  );
  // Long-prose site document (held out): v2 still beats plain by a
  // wide margin, even though v1's denser structural fragments win
  // this shape (497 vs 574 in-app). Assert the plain win, not a v1
  // win the measurement does not support.
  const bigSite = {
    domain: "harbour-lantern.example",
    title: "The Harbour Lantern",
    theme: { layout: "blog", accent: "#0e7490", font: "system-ui" },
    nav: [
      { label: "Home", href: "arknetz://harbour-lantern.example" },
      { label: "Journeys", href: "arknetz://harbour-lantern.example/journeys" },
    ],
    blocks: [
      { type: "hero", title: "The Harbour Lantern", subtitle: "A logbook of ferries, fog, and the small boats that carry people between the islands when the weather allows." },
      { type: "h1", text: "The ferry timetable is a suggestion" },
      { type: "p", text: "The harbour master keeps a ledger of every boat that leaves the pier, written in pencil, because the ink runs when the spray comes over the wall. The morning ferry leaves when the tide turns, not when the clock says so, and everyone on the island knows to listen for the horn instead of watching the time." },
      { type: "p", text: "Fog is the real timetable here. When it rolls in from the east, the boats wait, the gulls go quiet, and the lantern burns even at noon. The keeper says the fog has its own calendar, and after thirty years he has stopped arguing with it." },
      { type: "img", src: "https://archive.org/download/harbour-photos/pier.jpg", alt: "The stone pier in morning fog", caption: "The pier at first light, before the fog lifts." },
      { type: "quote", text: "The boats leave when the tide turns, not when the clock says so." },
    ],
    version: "1",
    updated: 1794020000,
  };
  const bigInput = new TextEncoder().encode(JSON.stringify(bigSite));
  const bigV2 = await compressBytes(bigInput);
  const bigPlain = engine.compress(bigInput, 3);
  assert.ok(bigV2.length < bigPlain.length, `big site: v2 did not beat plain (${bigV2.length} vs ${bigPlain.length} for ${bigInput.length} input bytes)`);
  assert.deepEqual(await decompressBytes(bigV2), bigInput, "big site: v2 round-trip");
  // The v1 label is still what it was — the old dictionary was not silently replaced.
  assert.equal(ZSTD_DICTIONARY_LABEL, "v1-corpus-derived");
});
