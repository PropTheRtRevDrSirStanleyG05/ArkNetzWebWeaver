// Tests: the zstd v2 dictionary drop (Stanley's decision 2026-11-21).
// Proves three things:
//   (a) new compression is PLAIN zstd — fresh frames carry no
//       dictionary ID and are byte-identical to engine.compress;
//   (b) old dictionary frames (v2 and v1) still decompress through
//       the built-in path — nothing already published breaks;
//   (c) the register.yml workflow text has no dictionary fetch and
//       no `-D` flag (plain `zstd -d` / `zstd` on canonical shards).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  compressBytes,
  compressBytesWithDictionary,
  compressJson,
  decompressBytes,
  getZstdDictionary,
  getZstdDictionaryV2,
  getZstdEngine,
  ZSTD_DICTIONARY_ID,
  ZSTD_DICTIONARY_V2_ID,
} from "../src/lib/zstd.js";

/** Read the dictionary ID out of a frame header (same layout as the
 *  helper in tests/zstd.test.ts). Returns null when the frame carries
 *  no dictionary ID. */
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

const DOC = {
  domain: "computers.edu",
  title: "Computers",
  blocks: [{ type: "h1", text: "Hello" }, { type: "p", text: "A paragraph." }],
};

test("(a) new frames are plain zstd: no dictionary ID, byte-identical to engine.compress", async () => {
  const engine = await getZstdEngine();
  for (const value of [DOC, { a: 1 }, { entries: [{ domain: "x.example", owner: "alice" }] }]) {
    const input = new TextEncoder().encode(JSON.stringify(value));
    const compressed = await compressBytes(input);
    assert.equal(frameDictionaryId(compressed), null, "fresh frame must carry no dictionary ID");
    assert.deepEqual(compressed, engine.compress(input, 3), "fresh frame must equal plain engine.compress");
  }
  const jsonFrame = await compressJson(DOC);
  assert.equal(frameDictionaryId(jsonFrame), null, "compressJson must also write plain frames");
});

test("(b) old dictionary frames still decompress: v2 and v1 fixtures", async () => {
  const input = new TextEncoder().encode(JSON.stringify(DOC));
  const v2Frame = await compressBytesWithDictionary(input, getZstdDictionaryV2());
  assert.equal(frameDictionaryId(v2Frame), ZSTD_DICTIONARY_V2_ID);
  assert.deepEqual(await decompressBytes(v2Frame), input, "old v2 frame must still decode");
  const v1Frame = await compressBytesWithDictionary(input, getZstdDictionary());
  assert.equal(frameDictionaryId(v1Frame), ZSTD_DICTIONARY_ID);
  assert.deepEqual(await decompressBytes(v1Frame), input, "old v1 frame must still decode");
  // A plain frame decodes too — the three formats coexist.
  const plainFrame = await compressBytes(input);
  assert.deepEqual(await decompressBytes(plainFrame), input);
});

test("(c) register.yml has no dictionary fetch and no -D flag", () => {
  // The client source of truth: protocol/register.yml next to tests/.
  const candidates: string[] = [
    new URL("../protocol/register.yml", import.meta.url).pathname,
  ];
  // Plus every seed copy, when this checkout has the seed tree next
  // to the client (tests/ -> build/ -> arknetzwebweaver/ -> seed).
  const seedRoot = new URL("../../../github-seed/", import.meta.url).pathname;
  if (existsSync(seedRoot)) {
    for (let i = 0; i < 16; i++) {
      candidates.push(`${seedRoot}arknetz-registry-${i.toString(16).padStart(2, "0")}/.github/workflows/register.yml`);
    }
    candidates.push(`${seedRoot}arknetz-actions/.github/workflows/register.yml`);
  }
  assert.ok(candidates.length >= 1, "no register.yml found to check");
  for (const path of candidates) {
    assert.ok(existsSync(path), `register.yml missing: ${path}`);
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes("zstd-dictionary"), `${path}: still fetches or names a zstd dictionary`);
    assert.ok(!text.includes("zstd-dictionary-v2.bin"), `${path}: still references the v2 dictionary file`);
    assert.ok(!/-D\s+zstd-dictionary/.test(text), `${path}: still uses -D with a dictionary`);
    assert.ok(!text.includes('"zstd", "-d", "-D"'), `${path}: still uses -D on decompress`);
    assert.ok(!text.includes('"zstd", "-q", "-D"'), `${path}: still uses -D on compress`);
    assert.ok(text.includes('["zstd", "-d", "-c", "registry.json.zst"]'), `${path}: availability check must use plain zstd -d`);
    assert.ok(text.includes('["zstd", "-q", "-f", "registry.json", "-o", "registry.json.zst"]'), `${path}: recompress must use plain zstd`);
  }
});
