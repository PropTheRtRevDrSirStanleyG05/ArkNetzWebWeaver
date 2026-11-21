// Embed the trained dictionary v2 into src/lib/zstd.ts (fix round 3).
// The app has no bundler, so the dictionary bytes ride in the source
// as a base64 constant (like the v1 corpus text already does) — the
// browser build cannot read a .bin file off disk.
//   node dict-training/embed-dict-v2.mjs
// Reads dict-training/zstd-dictionary-v2.bin, verifies it is a
// formatted dictionary (magic 0xEC30A437) with ID 0x41524B02, and
// rewrites ZSTD_DICTIONARY_V2_BASE64 + ZSTD_DICTIONARY_V2_SHA256 in
// src/lib/zstd.ts. The test suite pins the SHA-256, so any change to
// the dictionary is a deliberate, recorded change.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const DICT_PATH = new URL("./zstd-dictionary-v2.bin", import.meta.url).pathname;
const ZSTD_TS = new URL("../src/lib/zstd.ts", import.meta.url).pathname;

const bytes = readFileSync(DICT_PATH);
if (bytes.length !== 32768) {
  throw new Error(`expected a 32768-byte dictionary, got ${bytes.length} — re-run ./dict-training/train.sh`);
}
if (bytes[0] !== 0x37 || bytes[1] !== 0xa4 || bytes[2] !== 0x30 || bytes[3] !== 0xec) {
  throw new Error("dictionary lacks the formatted-dictionary magic 0xEC30A437 — not a formatted dictionary");
}
const id = bytes.readUInt32LE(4);
if (id !== 0x41524b02) {
  throw new Error(`dictionary ID is 0x${id.toString(16)}, expected 0x41524b02 — re-run train.sh with --dictID=1095912194`);
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
const base64 = bytes.toString("base64");

let src = readFileSync(ZSTD_TS, "utf8");
const shaRe = /export const ZSTD_DICTIONARY_V2_SHA256 =\n  "[0-9a-f]{64}";|export const ZSTD_DICTIONARY_V2_SHA256 = "[0-9a-f]{64}";/;
if (!shaRe.test(src)) throw new Error("ZSTD_DICTIONARY_V2_SHA256 placeholder not found in src/lib/zstd.ts");
src = src.replace(shaRe, `export const ZSTD_DICTIONARY_V2_SHA256 = "${sha256}";`);
const b64Re = /export const ZSTD_DICTIONARY_V2_BASE64 = "[^"]*";/;
if (!b64Re.test(src)) throw new Error("ZSTD_DICTIONARY_V2_BASE64 placeholder not found in src/lib/zstd.ts");
src = src.replace(b64Re, `export const ZSTD_DICTIONARY_V2_BASE64 = "${base64}";`);
writeFileSync(ZSTD_TS, src);
console.log(`embedded dictionary v2: ${bytes.length} bytes, id 0x41524b02, sha256 ${sha256}`);
