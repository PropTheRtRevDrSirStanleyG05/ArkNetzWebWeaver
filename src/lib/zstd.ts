// ArkNetzWebWeaver — real Zstd for .json.zst files.
// Dictionary v2 DROPPED 2026-11-21 (Stanley's decision; benchmark
// BENCHMARK-0.4.0.md proved it saves zero bytes on every payload
// tested): new files are PLAIN zstd, no dictionary. The v1/v2
// dictionaries below are kept ONLY so old published frames still
// decode — decompressBytes tries v2, then v1, then plain.
// Engine: @bokuweb/zstd-wasm (MIT, verified 2026-11-20 — `npm view`
// reports license MIT, version 0.0.27, zero dependencies). It is real
// Zstandard (compress + decompress), not a stand-in: the registry/site
// round-trip tests prove byte-identical JSON after compress -> decompress.
//
// Loading is environment-aware because the project has no bundler:
//   - Node (tests, tooling): the package's Node build, imported from
//     node_modules — it reads its .wasm via fs.
//   - Browser / Tauri webview: the package's ESM web build, vendored into
//     dist/vendor/zstd/ by scripts/copy-assets.mjs (index.web.js +
//     module.js + zstd.js + simple/ + errors/ + zstd.wasm). init()
//     resolves the wasm from import.meta.url, so it fetches the vendored
//     copy next to the module. No CDN, no network fetch of the codec.
// The engine is initialised lazily and cached; every public function
// awaits it. If the wasm cannot load, the error says so plainly —
// callers must not fall back to shipping uncompressed files as .zst.
//
// Dictionary (v1, "v1-corpus-derived") — read this before changing it:
//   - The thread specifies a ~32 KB *pre-trained* dictionary (JSON keys,
//     Markdown syntax, common English words). No zstd trainer exists in
//     this environment (no `zstd` CLI, no Python `zstandard` module, no
//     Node trainer), so v1 is NOT that pre-trained dictionary. It is a
//     *corpus-derived* dictionary: representative text assembled by hand
//     from this scaffold's own JSON schemas and sample documents
//     (registry entries, site documents, blocks, mail envelopes,
//     comments, directory shards, manifest), plus Markdown syntax and
//     common English prose — see ZSTD_DICTIONARY_CONTENT_SOURCE below.
//     It is honest about that: the label says "corpus-derived", and the
//     version is 1 so a real trained dictionary can replace it as v2.
//   - Format: a *formatted* dictionary per RFC 8878 §5 (magic
//     0xEC30A437 + dictionary ID + entropy tables + content), NOT a raw
//     content dictionary. The distinction matters: a raw-content
//     dictionary has no ID, so the frame carries no ID, and decompressing
//     with the wrong dictionary silently returns garbage (verified
//     2026-11-20: a frame decompressed with an all-0x07 dictionary
//     returned 158 bytes of wrong content with no error). A formatted
//     dictionary embeds its ID in every frame it compresses, and the
//     decoder checks the frame's ID against the dictionary's ID — a
//     wrong dictionary, a raw dictionary, or no dictionary at all all
//     throw loudly instead of mis-decoding. The dictionary ID is
//     0x41524B01 ("ARK\x01": the letters ARK plus version byte 1); it is
//     in the free public range (>= 32768, < 2^31) so it never collides
//     with the reserved ranges. A future vN dictionary MUST use a
//     different ID (e.g. "ARK\x02") so a vN file read by a v1 client
//     fails loudly instead of silently mis-decoding.
//     That future dictionary is now v2 (below): ID 0x41524B02
//     ("ARK\x02"), genuinely trained — see dict-training/README.md.
//     A future v3 MUST use yet another ID the same way.
//   - The entropy tables are minimal but valid: one Huffman table
//     (direct representation, the worked example from RFC 8878) and
//     three FSE tables (two symbols, probability 16/16 each, accuracy
//     log 5), followed by the default repeat offsets {1, 4, 8}. They
//     are built by the small encoders below (encodeHuffmanDirectTable /
//     encodeFseTable) so the dictionary is reproducible from source.
//   - Backward compatibility: frames compressed WITHOUT a dictionary
//     (the pre-dictionary format) still decompress through
//     decompressUsingDict — verified: a plain frame decompresses fine
//     with the dictionary supplied, because a frame with no dictionary
//     ID simply does not use it. So old cached .zst files keep working.
//   - The dictionary bytes are pinned: ZSTD_DICTIONARY_SHA256 is the
//     SHA-256 of the exact formatted dictionary, and tests/zstd.test.ts
//     recomputes it. Any change to the corpus, the ID, or the tables
//     changes the hash and must be a deliberate, recorded change.

import type {
  compress as compressFn,
  compressUsingDict as compressUsingDictFn,
  createCCtx as createCCtxFn,
  createDCtx as createDCtxFn,
  decompress as decompressFn,
  decompressUsingDict as decompressUsingDictFn,
  freeCCtx as freeCCtxFn,
  freeDCtx as freeDCtxFn,
  init as initFn,
} from "@bokuweb/zstd-wasm";

export interface ZstdEngine {
  init: typeof initFn;
  compress: typeof compressFn;
  decompress: typeof decompressFn;
  compressUsingDict: typeof compressUsingDictFn;
  decompressUsingDict: typeof decompressUsingDictFn;
  createCCtx: typeof createCCtxFn;
  freeCCtx: typeof freeCCtxFn;
  createDCtx: typeof createDCtxFn;
  freeDCtx: typeof freeDCtxFn;
}

/** Zstd frame magic: 0xFD2FB528, little-endian. */
export const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);

export function isZstdFrame(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === ZSTD_MAGIC[0] &&
    data[1] === ZSTD_MAGIC[1] &&
    data[2] === ZSTD_MAGIC[2] &&
    data[3] === ZSTD_MAGIC[3]
  );
}

let enginePromise: Promise<ZstdEngine> | null = null;

async function loadEngine(): Promise<ZstdEngine> {
  const isNode =
    typeof window === "undefined" &&
    typeof process !== "undefined" &&
    typeof process.versions?.node === "string";
  if (isNode) {
    const mod = (await import("@bokuweb/zstd-wasm")) as unknown as ZstdEngine;
    await mod.init();
    return mod;
  }
  // Browser / Tauri webview: vendored ESM web build. The specifier is
  // built at runtime (dist/src/lib/zstd.js -> dist/vendor/zstd/...),
  // so tsc does not try to resolve it at compile time.
  const url = new URL("../../vendor/zstd/index.web.js", import.meta.url).href;
  const mod = (await import(url)) as unknown as ZstdEngine;
  await mod.init();
  return mod;
}

export function getZstdEngine(): Promise<ZstdEngine> {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((err) => {
      enginePromise = null;
      throw new Error(
        `Zstd engine failed to load: ${err instanceof Error ? err.message : String(err)} — .json.zst files cannot be read or written until this is fixed`,
      );
    });
  }
  return enginePromise;
}

/** For tests: forget the cached engine so a fresh load can be observed. */
export function resetZstdEngineForTests(): void {
  enginePromise = null;
}

// ---------------------------------------------------------------------------
// Dictionary v1 — "v1-corpus-derived" (see the header comment for the
// honest provenance note: corpus-derived, NOT the thread's pre-trained
// dictionary — no trainer exists in this environment).
//
// v1 is no longer the CURRENT dictionary: v2 (below, genuinely trained
// with `zstd --train` in fix round 3) writes all new files. v1 is kept
// because old files compressed with it must still decode —
// decompressBytes tries v2, then v1, then plain frames.
// ---------------------------------------------------------------------------

/** Dictionary version. A future dictionary MUST bump this AND use a
 *  different dictionary ID, so old clients fail loudly on new files. */
export const ZSTD_DICTIONARY_VERSION = 1;

/** Human label. The "corpus-derived" wording is deliberate — see above. */
export const ZSTD_DICTIONARY_LABEL = "v1-corpus-derived";

/** Dictionary ID embedded in every frame compressed with v1. "ARK\x01":
 *  the letters ARK plus version byte 1. In the free public range
 *  (>= 32768, < 2^31) per RFC 8878 §5, so it never collides with the
 *  reserved low (<= 32767) or high (>= 2^31) ranges. */
export const ZSTD_DICTIONARY_ID = 0x41524b01;

/** Formatted-dictionary magic, little-endian 0xEC30A437 (RFC 8878 §5). */
export const ZSTD_DICTIONARY_MAGIC = 0xec30a437;

/** SHA-256 (hex) of the exact formatted dictionary bytes returned by
 *  getZstdDictionary(). Pinned by tests/zstd.test.ts — any change to
 *  the corpus, the ID, or the tables changes this hash. */
export const ZSTD_DICTIONARY_SHA256 =
  "9e7346fce69bd694f438c83acced640aba7f804f5901ad4dd932d0d4816b19ae";

/** Minimal bit writer, LSB-first: zstd's FSE table descriptions are
 *  forward little-endian bitstreams (RFC 8878 §4.1.1). */
class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private nbits = 0;

  write(value: number, n: number): void {
    for (let i = 0; i < n; i++) {
      if ((value >> i) & 1) this.cur |= 1 << this.nbits;
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.nbits > 0) this.bytes.push(this.cur);
    return new Uint8Array(this.bytes);
  }
}

/** Encode one FSE table description (RFC 8878 §4.1.1). `probas` lists
 *  the probability of each symbol from 0 upward: at least two symbols,
 *  no zeroes, summing to exactly 1 << accuracyLog. The encoding is the
 *  variable-bit scheme from the spec: the value written per symbol is
 *  proba + 1, values below the threshold T use B-1 bits, values at or
 *  above it use B bits (with values >= 2^(B-1) shifted by T). */
function encodeFseTable(probas: number[], accuracyLog: number): Uint8Array {
  const w = new BitWriter();
  w.write(accuracyLog - 5, 4); // low 4 bits of the first byte
  const tableSize = 1 << accuracyLog;
  let distributed = 0;
  for (let i = 0; i < probas.length; i++) {
    const proba = probas[i] as number;
    const remaining = tableSize - distributed;
    const maxValue = remaining + 1;
    const bits = Math.ceil(Math.log2(maxValue + 1));
    const threshold = (1 << bits) - (maxValue + 1);
    const value = proba + 1;
    if (value < threshold) w.write(value, bits - 1);
    else if (value < 1 << (bits - 1)) w.write(value, bits);
    else w.write(value + threshold, bits);
    distributed += Math.max(proba, 1);
    if (distributed >= tableSize) break;
  }
  return w.finish();
}

/** Encode one Huffman table in direct representation (RFC 8878 §4.2):
 *  header byte 127 + number of weights, then the weights packed two
 *  per byte, high nibble first. The last symbol's weight is deduced by
 *  the decoder (completing to the next power of two), so it is not
 *  listed. Default weights [4, 3, 2, 0, 1] are the spec's own worked
 *  example (symbols 0, 1, 2, 4, 5 with a deduced weight 1 for 5). */
function encodeHuffmanDirectTable(weights: number[]): Uint8Array {
  const out = [127 + weights.length];
  for (let i = 0; i < weights.length; i += 2) {
    const hi = weights[i] as number;
    const lo = i + 1 < weights.length ? (weights[i + 1] as number) : 0;
    out.push(((hi & 0xf) << 4) | (lo & 0xf));
  }
  return new Uint8Array(out);
}

/** Build a formatted dictionary (RFC 8878 §5): magic + dictionary ID +
 *  entropy tables (Huffman for literals, FSE for offsets, match
 *  lengths, literal lengths, then the 3 repeat offsets) + content.
 *  The ID is what makes wrong-dictionary use fail loudly: the
 *  compressor writes it into every frame, and the decompressor checks
 *  the frame's ID against the dictionary's ID. Pure and deterministic
 *  — the same (dictId, content) always yields the same bytes. */
export function buildFormattedZstdDictionary(
  dictId: number,
  content: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(8);
  header[0] = ZSTD_DICTIONARY_MAGIC & 0xff;
  header[1] = (ZSTD_DICTIONARY_MAGIC >> 8) & 0xff;
  header[2] = (ZSTD_DICTIONARY_MAGIC >> 16) & 0xff;
  header[3] = (ZSTD_DICTIONARY_MAGIC >> 24) & 0xff;
  header[4] = dictId & 0xff;
  header[5] = (dictId >> 8) & 0xff;
  header[6] = (dictId >> 16) & 0xff;
  header[7] = (dictId >> 24) & 0xff;
  // Minimal valid entropy tables: two symbols at probability 16/16,
  // accuracy log 5, for each of the three FSE tables.
  const huffman = encodeHuffmanDirectTable([4, 3, 2, 0, 1]);
  const fse = encodeFseTable([16, 16], 5);
  // Repeat offsets, 4 bytes little-endian each: the defaults {1, 4, 8}.
  // Each must be smaller than the dictionary size.
  const repeatOffsets = new Uint8Array(12);
  const view = new DataView(repeatOffsets.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 8, true);
  const parts = [header, huffman, fse, fse, fse, repeatOffsets, content];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Representative content for dictionary v1. Hand-assembled from this
 *  scaffold's own JSON schemas and sample documents — registry entries,
 *  site documents (every block type), the protocol manifest, mail
 *  envelopes and plaintext, comments, directory shards, contacts — plus
 *  Markdown syntax and common English prose. The JSON samples are
 *  COMPACT (no space after `:` or `,`) because that is exactly what
 *  JSON.stringify produces for the real .json.zst files; pretty-printed
 *  JSON would teach the dictionary byte patterns that never occur.
 *  Nothing here is secret: every value is invented sample data. */
export const ZSTD_DICTIONARY_CONTENT_SOURCE = `## registry shard, map form
{"computers.edu":{"domain":"computers.edu","backend":"gh:alice/arknetz-site-computers-edu","mirrors":["gl:alice/arknetz-site-computers-edu","cb:alice/arknetz-site-computers-edu"],"shard":"a","owner":"alice","updated":1794000000},"bakery.example":{"domain":"bakery.example","backend":"gh:bob/arknetz-site-bakery","shard":"3","owner":"bob","updated":1794003600},"garden.example":{"domain":"garden.example","backend":"gh:carol/arknetz-site-garden","mirrors":["gh:carol/arknetz-site-garden-mirror"],"shard":"f","owner":"carol"},"music.example":{"domain":"music.example","backend":"gh:dave/arknetz-site-music","shard":"0","owner":"dave","updated":1793990000},"travel.example":{"domain":"travel.example","backend":"gh:erin/arknetz-site-travel","shard":"9","owner":"erin"},"code.example":{"domain":"code.example","backend":"gh:frank/arknetz-site-code","shard":"c","owner":"frank","updated":1794010000},"photos.example":{"domain":"photos.example","backend":"gh:grace/arknetz-site-photos","shard":"7","owner":"grace"},"news.example":{"domain":"news.example","backend":"gh:henry/arknetz-site-news","shard":"e","owner":"henry","updated":1794020000,"delegations":{"blog":"gh:henry/arknetz-site-news-blog","shop":"gh:henry/arknetz-site-news-shop"}}}
## registry shard, entries-array form
{"entries":[{"domain":"computers.edu","backend":"gh:alice/arknetz-site-computers-edu","shard":"a","owner":"alice"},{"domain":"bakery.example","backend":"gh:bob/arknetz-site-bakery","shard":"3","owner":"bob","updated":1794003600}]}
## site document, computers
{"domain":"computers.edu","title":"Computers","theme":{"layout":"docs","accent":"#2563eb","font":"system-ui"},"nav":[{"label":"Home","href":"arknetz://computers.edu"},{"label":"About the protocol","href":"arknetz://computers.edu/about"},{"label":"Posts","href":"arknetz://computers.edu/posts"}],"blocks":[{"type":"hero","title":"Computers","subtitle":"A small site about computers, old and new. Sites are tiny compressed JSON on GitHub, media lives on the Internet Archive, and you own your domain."},{"type":"h2","text":"How it works"},{"type":"p","text":"You are browsing as a guest, no sign-in was needed. Reads come from raw.githubusercontent.com with ETag caching, so a repeat visit costs almost nothing."},{"type":"cols","columns":[[{"type":"h3","text":"Sites"},{"type":"p","text":"Typed semantic blocks only. No raw HTML, no trackers."}],[{"type":"h3","text":"Media"},{"type":"p","text":"Attachments upload to the Internet Archive in the background and embed as hotlinks."}],[{"type":"h3","text":"Mail and Drive"},{"type":"p","text":"Protocol mail and ArkDrive land after the shell, in that order."}]]},{"type":"quote","text":"This is a demo site bundled with the shell. Real sites resolve through the sharded registry once the central repos exist."},{"type":"code","language":"text","text":"arknetz://computers.edu\\nregistry shard: SHA256(domain)[0] -> arknetz-registry-0x"}],"version":"1","updated":1794000000}
## site document, bakery
{"domain":"bakery.example","title":"The Corner Bakery","theme":{"layout":"blog","accent":"#b45309","font":"Georgia, serif"},"nav":[{"label":"Home","href":"arknetz://bakery.example"},{"label":"Recipes","href":"arknetz://bakery.example/recipes"}],"header":[{"type":"h1","text":"The Corner Bakery"}],"blocks":[{"type":"h1","text":"Fresh bread every morning"},{"type":"p","text":"We bake sourdough, rye, and brioche in small batches. The ovens start at four in the morning, and the first loaves come out just as the sun comes up over the street."},{"type":"img","src":"https://archive.org/download/bakery-photos/loaf.jpg","alt":"A loaf of sourdough on a wooden table","caption":"Today's sourdough, still warm from the oven."},{"type":"gallery","items":[{"src":"https://archive.org/download/bakery-photos/rolls.jpg","alt":"Bread rolls","caption":"Morning rolls"},{"src":"https://archive.org/download/bakery-photos/cake.jpg","alt":"A birthday cake","caption":"Birthday cake with buttercream"}]},{"type":"cards","items":[{"type":"h3","text":"Sourdough"},{"type":"p","text":"Our oldest recipe, slow fermented for two days."},{"type":"h3","text":"Rye"},{"type":"p","text":"Dark, dense, and full of flavour with caraway seeds."}]},{"type":"series-grid","title":"Recipes","items":[{"label":"Sourdough starter","href":"arknetz://bakery.example/recipes/starter"},{"label":"Rye bread","href":"arknetz://bakery.example/recipes/rye"}]}],"footer":[{"type":"p","text":"Open Tuesday to Sunday, eight in the morning until two in the afternoon."}],"version":"1","updated":1794003600}
## site document, garden
{"domain":"garden.example","title":"The Kitchen Garden","theme":{"layout":"docs","accent":"#15803d","font":"system-ui"},"nav":[{"label":"Home","href":"arknetz://garden.example"},{"label":"Planting calendar","href":"arknetz://garden.example/calendar"}],"blocks":[{"type":"h2","text":"What to plant in spring"},{"type":"p","text":"Spring is the busiest season in the garden. The soil is warming up, the days are getting longer, and there is a short window to get seeds into the ground before the summer heat arrives."},{"type":"h3","text":"Tomatoes need warmth"},{"type":"p","text":"Wait until the nights stay above ten degrees before planting tomatoes outside. Give each plant plenty of space, water the roots and not the leaves, and feed them once the first flowers appear."},{"type":"video","src":"https://archive.org/download/garden-videos/pruning.mp4","caption":"How to prune a tomato plant","autoplay":false,"loop":false,"controls":true},{"type":"audio","src":"https://archive.org/download/garden-audio/birds.mp3","caption":"Morning birdsong in the garden"},{"type":"quote","text":"The garden is the one place where waiting is part of the work."},{"type":"link","label":"Seed catalogue","href":"https://example.com/seeds"},{"type":"docs-sidebar","items":[{"label":"Spring","href":"arknetz://garden.example/spring"},{"label":"Summer","href":"arknetz://garden.example/summer"}]},{"type":"app","name":"watering-reminder","config":{"intervalDays":3}}],"version":"2","updated":1793995000}
## protocol manifest
{"protocolVersion":"0.1.0","defaultRootRepo":"PropTheRtRevDrSirStanleyG05/protocol-root","masterGithubUser":"PropTheRtRevDrSirStanleyG05","registryShards":["arknetz-registry-00","arknetz-registry-01","arknetz-registry-02","arknetz-registry-03","arknetz-registry-04","arknetz-registry-05","arknetz-registry-06","arknetz-registry-07","arknetz-registry-08","arknetz-registry-09","arknetz-registry-0a","arknetz-registry-0b","arknetz-registry-0c","arknetz-registry-0d","arknetz-registry-0e","arknetz-registry-0f"],"contactsShards":["arknetz-contacts-00","arknetz-contacts-01","arknetz-contacts-02","arknetz-contacts-03","arknetz-contacts-04","arknetz-contacts-05","arknetz-contacts-06","arknetz-contacts-07","arknetz-contacts-08","arknetz-contacts-09","arknetz-contacts-0a","arknetz-contacts-0b","arknetz-contacts-0c","arknetz-contacts-0d","arknetz-contacts-0e","arknetz-contacts-0f"],"mirrors":["gl:PropTheRtRevDrSirStanleyG05/protocol-root","cb:PropTheRtRevDrSirStanleyG05/protocol-root"],"zstdDictionary":{"version":1,"url":"https://raw.githubusercontent.com/PropTheRtRevDrSirStanleyG05/protocol-root/main/zstd-dictionary-v1.bin","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}
## mail envelope
{"version":1,"messageId":"mail-9f2c41a7-1794000000-alice","threadId":"thread-9f2c41a7","from":{"name":"Alice Example","address":"alice@example.com"},"recipients":[{"name":"Bob Example","address":"bob@example.com"},{"name":"Carol Example","address":"carol@example.com"}],"sentAt":1794000000000,"ivB64":"AAECAwQFBgcICQoLDA0ODw==","ciphertextB64":"U2VjcmV0IG1lc3NhZ2UgY29udGVudCBlbmNyeXB0ZWQgd2l0aCBBRVMtR0NNIGFuZCBjb21wcmVzc2VkIHdpdGggWnN0ZCBiZWZvcmUgaXQgd2FzIHNlYWxlZC4=","wrappedKeys":[{"fingerprint":"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4","wrappedKeyB64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","ephemeralPublicKeyB64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},{"fingerprint":"b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5","wrappedKeyB64":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","ephemeralPublicKeyB64":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}],"plaintextBytes":512}
## mail plaintext
{"version":1,"messageId":"mail-9f2c41a7-1794000000-alice","threadId":"thread-9f2c41a7","from":{"name":"Alice Example","address":"alice@example.com"},"to":[{"name":"Bob Example","address":"bob@example.com"}],"cc":[{"name":"Carol Example","address":"carol@example.com"}],"subject":"Welcome to the new site","body":"Hello Bob,\n\nThe new site is live at arknetz://computers.edu. Take a look when you have a moment and let me know what you think of the new design.\n\nBest wishes,\nAlice","sentAt":1794000000000,"attachments":[{"name":"notes.txt","size":1024,"contentType":"text/plain"}]}
## comments file
{"threads":[{"id":"thread-0001","domain":"computers.edu","pagePath":"index","title":"Computers","locked":false,"comments":[{"id":"c1","author":"alice","createdAt":1794000000,"body":"Great post, thank you for writing this up."},{"id":"c2","author":"bob","createdAt":1794003600,"body":"I agree with the main point, though the second paragraph could use an example."}],"moderationLog":[{"action":"approve","reason":"looks good","moderator":"alice","createdAt":1794000100}],"issueNumber":12},{"id":"thread-0002","domain":"bakery.example","pagePath":"recipes/starter","title":"Sourdough starter","locked":true,"lockedReason":"off-topic discussion","comments":[{"id":"c3","author":"carol","createdAt":1794007200,"body":"My starter took five days to get going, patience is the key."}],"moderationLog":[],"discussionNumber":34}]}
## directory shard
{"category":"computers","version":1,"updated":1794000000,"cards":[{"domain":"computers.edu","title":"Computers","description":"A small site about computers, old and new.","category":"computers","tags":["computers","history","hardware"],"updated":1794000000},{"domain":"code.example","title":"Code Notes","description":"Short notes on programming, mostly TypeScript and Rust.","category":"computers","tags":["programming","typescript","rust"],"updated":1794010000}]}
## contacts shard
{"alice@example.com":{"displayName":"Alice Example","contactAddress":"alice@example.com","fingerprint":"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4","publicKeyB64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","relays":["gh:alice/arknetz-mail"],"updated":1794000000},"bob@example.com":{"displayName":"Bob Example","contactAddress":"bob@example.com","fingerprint":"b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5","publicKeyB64":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","relays":["gh:bob/arknetz-mail"],"updated":1794003600}}
## json keys and structure fragments
"domain": "title": "blocks": "type": "text": "backend": "shard": "owner": "updated": "mirrors": "delegations": "theme": "layout": "accent": "font": "nav": "label": "href": "header": "footer": "version": "columns": "items": "language": "src": "alt": "caption": "hotlink": "width": "height": "autoplay": "loop": "controls": "description": "tags": "category": "cards": "threads": "comments": "author": "createdAt": "body": "locked": "lockedReason": "moderationLog": "action": "reason": "moderator": "issueNumber": "discussionNumber": "pagePath": "id": "messageId": "threadId": "from": "to": "cc": "subject": "sentAt": "attachments": "name": "size": "contentType": "ivB64": "ciphertextB64": "wrappedKeys": "fingerprint": "wrappedKeyB64": "ephemeralPublicKeyB64": "plaintextBytes": "recipients": "address": "displayName": "contactAddress": "publicKeyB64": "relays": "protocolVersion": "defaultRootRepo": "masterGithubUser": "registryShards": "contactsShards": "zstdDictionary": "url": "sha256": "entries": "config": "subtitle": "name": "app":
{"type":"h1","text":" {"type":"h2","text":" {"type":"h3","text":" {"type":"p","text":" {"type":"hero","title":" {"type":"quote","text":" {"type":"code","language":" {"type":"img","src":" {"type":"video","src":" {"type":"audio","src":" {"type":"gallery","items":" {"type":"cards","items":" {"type":"cols","columns":" {"type":"link","label":" {"type":"nav","items":" {"type":"series-grid","title":" {"type":"docs-sidebar","items":" {"type":"app","name":" "blocks":[{"type":" "domain":" "title":" "backend":"gh: "shard":" "owner":" "updated": "mirrors":["gh: "delegations":{" "theme":{"layout":" "accent":"# "font":" "nav":[{"label":" "href":"arknetz:// "columns":[[{"type":" "items":[{"type":" "language":" "src":"https://archive.org/download/ "hotlink":"https://archive.org/download/ "alt":" "caption":" "width": "height": "autoplay":false "loop":false "controls":true "href":"https:// "label":" "title":" "description":" "tags":[" "category":" "cards":[{"domain":" "version":1 "updated":1794000000 "protocolVersion":"0.1.0" "defaultRootRepo":" "masterGithubUser":" "registryShards":["arknetz-registry- "contactsShards":["arknetz-contacts- "messageId":" "threadId":" "from":{"name":" "address":" "recipients":[{"name":" "address":" "to":[{"name":" "cc":[{"name":" "subject":" "body":" "sentAt":1794000000000 "attachments":[{"name":" "size": "contentType":" "ivB64":" "ciphertextB64":" "wrappedKeys":[{"fingerprint":" "wrappedKeyB64":" "ephemeralPublicKeyB64":" "threads":[{"id":" "pagePath":" "locked":false "lockedReason":" "comments":[{"id":" "author":" "createdAt": "body":" "moderationLog":[{"action":" "reason":" "moderator":" "createdAt": "issueNumber":12 "discussionNumber":34 "fingerprint":" "publicKeyB64":" "displayName":" "contactAddress":" "relays":[" "entries":[{"domain":"
## urls and backends
https://raw.githubusercontent.com/PropTheRtRevDrSirStanleyG05/protocol-root/main/manifest.json
https://raw.githubusercontent.com/PropTheRtRevDrSirStanleyG05/arknetz-registry-00/main/registry.json
https://raw.githubusercontent.com/alice/arknetz-site-computers-edu/main/site.json.zst
https://raw.githubusercontent.com/alice/arknetz-site-computers-edu/main/site.json
https://archive.org/download/bakery-photos/loaf.jpg
https://archive.org/download/garden-videos/pruning.mp4
https://archive.org/download/garden-audio/birds.mp3
arknetz://computers.edu arknetz://bakery.example arknetz://garden.example arknetz://welcome.arknetz
arknetz://computers.edu/about arknetz://bakery.example/recipes arknetz://garden.example/calendar
gh:alice/arknetz-site-computers-edu gh:bob/arknetz-site-bakery gl:alice/arknetz-site-computers-edu cb:alice/arknetz-site-computers-edu
## markdown syntax
# Heading one
## Heading two
### Heading three
This is a paragraph with **bold text** and *italic text* and a [link](https://example.com) and an ![image](https://archive.org/download/example/image.jpg) and some inline code and a list:
- first item
- second item
- third item
1. first step
2. second step
3. third step
> A block quote, with a few words of wisdom.
---
| Name | Value |
| ---- | ----- |
| apples | twelve |
| bread | two loaves |
## common english words
the of and a to in is you that it he was for on are as with his they I at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part over new sound take only little work know place year live me back give most very after thing our just name good sentence man think say great where help through much before line right too mean old any same tell boy follow came want show also around form three small set put end does another well large must big even such because turn here why ask went men read need land different home us move try kind hand picture again change off play spell air away animal house point page letter mother answer found study still learn should world high every near add food between own below country plant last school father keep tree never start city earth eye light thought head under story saw left few while along might close something seem next hard open example begin life always those both paper together got group often run
## prose, computers
The computer on my desk is ten years old and still does everything I ask of it. I replaced the hard drive with a solid state drive last year, added more memory, and cleaned out the dust, and now it starts in seconds. Old machines are not useless, they are just waiting for someone patient enough to look after them. The keyboard has shiny keys from years of use, and the screen has a small scratch in one corner that I stopped noticing a long time ago.
## prose, baking
Bread is mostly waiting. You mix flour and water and a little salt, then you wait while the dough rises, then you shape it and wait again, then you bake it and wait once more while it cools. The smell fills the whole house. A good loaf has a crisp crust that crackles as it cools and a soft inside full of small holes. Butter melts into it. There is nothing complicated about it, and that is the whole point.
## prose, garden
The garden wakes up slowly in spring. First the snowdrops, then the daffodils, then the tulips in every colour. I plant peas along the fence and lettuce in the shady corner, and the herbs go by the kitchen door where I can reach them while cooking. Watering in the evening is the best part of the day, when the light is low and the birds are loud and the soil smells like rain.
## prose, music
We sang in the kitchen while the radio played, three voices and a guitar with one string missing. The song was older than all of us and everyone knew the words, or at least the chorus. Music does not need to be perfect to be good. It needs to be shared, a little loud, and slightly out of tune in the places where everyone is smiling too much to care.
## prose, travel
The train left before sunrise and crossed the mountains while we were still half asleep. By midday we were in a town we had never heard of, eating lunch in a small square with a fountain in the middle. We had no plan and no map, only a list of places people had told us to see. It was the best day of the trip, and we still talk about it years later.
## prose, programming
The program was small, only a few hundred lines, but it took a week to get right. The bug was a single wrong number in a table, and finding it meant reading every line twice and testing each part on its own. When it finally worked, the answer came out exactly right, and the whole week felt worth it. Good code is mostly careful reading, not clever writing.
## site document, travel
{"domain":"travel.example","title":"Slow Travel Notes","theme":{"layout":"blog","accent":"#0e7490","font":"system-ui"},"nav":[{"label":"Home","href":"arknetz://travel.example"},{"label":"Journeys","href":"arknetz://travel.example/journeys"}],"blocks":[{"type":"hero","title":"Slow Travel Notes","subtitle":"Trains, ferries, and long walks. No flights, no rush, no itinerary more detailed than a list of places people told us to see."},{"type":"h1","text":"Crossing the mountains by train"},{"type":"p","text":"The train left before sunrise and crossed the mountains while we were still half asleep. By midday we were in a town we had never heard of, eating lunch in a small square with a fountain in the middle. We had no plan and no map, only a list of places people had told us to see. It was the best day of the trip, and we still talk about it years later."},{"type":"img","src":"https://archive.org/download/travel-photos/mountains.jpg","alt":"Mountains seen from a train window","caption":"Morning in the mountains, somewhere between two stations."},{"type":"quote","text":"We had no plan and no map, only a list of places people had told us to see."},{"type":"link","label":"Timetable archive","href":"https://example.com/timetables"}],"version":"1","updated":1794020000}
## site document, music
{"domain":"music.example","title":"Kitchen Sessions","theme":{"layout":"blog","accent":"#9d174d","font":"Georgia, serif"},"nav":[{"label":"Home","href":"arknetz://music.example"},{"label":"Songs","href":"arknetz://music.example/songs"}],"blocks":[{"type":"hero","title":"Kitchen Sessions","subtitle":"Three voices and a guitar with one string missing. Songs older than all of us, sung slightly out of tune in the places where everyone is smiling too much to care."},{"type":"h2","text":"Songs we keep coming back to"},{"type":"p","text":"We sang in the kitchen while the radio played, and everyone knew the words, or at least the chorus. Music does not need to be perfect to be good. It needs to be shared, a little loud, and honest about where it comes from."},{"type":"audio","src":"https://archive.org/download/kitchen-sessions/chorus.mp3","caption":"The chorus, recorded on a phone in the kitchen"},{"type":"gallery","items":[{"src":"https://archive.org/download/kitchen-sessions/guitar.jpg","alt":"An old guitar leaning on a chair","caption":"The guitar, one string missing"},{"src":"https://archive.org/download/kitchen-sessions/singers.jpg","alt":"Three people singing","caption":"Three voices, one chorus"}]},{"type":"cards","items":[{"type":"h3","text":"The old songs"},{"type":"p","text":"Songs our grandparents sang, learned by ear and never written down."},{"type":"h3","text":"The new songs"},{"type":"p","text":"Written in the kitchen, usually about the weather or the garden."}]}],"version":"1","updated":1793990000}
## registry shard, second sample
{"shop.example":{"domain":"shop.example","backend":"gh:ivan/arknetz-site-shop","shard":"2","owner":"ivan","updated":1794030000},"blog.example":{"domain":"blog.example","backend":"gh:julia/arknetz-site-blog","mirrors":["gl:julia/arknetz-site-blog"],"shard":"b","owner":"julia"},"forum.example":{"domain":"forum.example","backend":"gh:karl/arknetz-site-forum","shard":"4","owner":"karl","updated":1794035000},"wiki.example":{"domain":"wiki.example","backend":"gh:lara/arknetz-site-wiki","shard":"d","owner":"lara"},"radio.example":{"domain":"radio.example","backend":"gh:mike/arknetz-site-radio","shard":"6","owner":"mike","updated":1794040000},"poetry.example":{"domain":"poetry.example","backend":"gh:nina/arknetz-site-poetry","shard":"8","owner":"nina"}}
## more comments and directory cards
{"threads":[{"id":"thread-0003","domain":"travel.example","pagePath":"index","title":"Slow Travel Notes","locked":false,"comments":[{"id":"c4","author":"erin","createdAt":1794020000,"body":"The mountain train is on my list now, thank you for the timetable link."},{"id":"c5","author":"frank","createdAt":1794023600,"body":"We did the same journey last year. The square with the fountain is even better in the evening."}],"moderationLog":[],"issueNumber":27}]}
{"category":"travel","version":1,"updated":1794020000,"cards":[{"domain":"travel.example","title":"Slow Travel Notes","description":"Trains, ferries, and long walks. No flights, no rush.","category":"travel","tags":["travel","trains","walking"],"updated":1794020000},{"domain":"music.example","title":"Kitchen Sessions","description":"Three voices and a guitar with one string missing.","category":"music","tags":["music","songs","kitchen"],"updated":1793990000},{"domain":"garden.example","title":"The Kitchen Garden","description":"What to plant, when to water, and how to wait.","category":"garden","tags":["garden","plants","vegetables"],"updated":1793995000},{"domain":"bakery.example","title":"The Corner Bakery","description":"Fresh bread every morning, baked in small batches.","category":"food","tags":["bakery","bread","recipes"],"updated":1794003600}]}
## prose, news
The town council met on Tuesday and talked about the library for three hours. The roof needs fixing, the heating is older than most of the books, and everyone agrees something has to be done, but nobody agrees what. The librarian read out a letter from a child who asked for more books about space. The meeting ended with a promise to look at the numbers again next month, which is what meetings usually end with.
## prose, photographs
The photographs are in a box in the attic, hundreds of them, most without names or dates. A wedding in a garden, a dog asleep on a sofa, a street covered in snow. We spent an afternoon sorting them into piles and guessing who everyone was. Some guesses were probably wrong. It did not matter. The point was remembering that all of it happened, and that someone thought it was worth keeping.
## prose, code notes
The notes are short, one idea per page, written for myself more than anyone else. How the cache works, why the queue is processed in that order, what the error message really means. I write them down because I will forget, and because the next person to read the code deserves a map. A codebase without notes is a house without labels on the doors.
## more common sentences
She opened the window and the morning came in with the smell of rain. The children ran down the hill and into the field, shouting. He fixed the bicycle with a wrench and a piece of wire. We ate dinner late, after the guests had gone home. The letter arrived on Friday, three weeks after it was sent. I walked to the shop in the evening and bought bread and milk. The dog waited by the door until someone came home. They painted the fence white and planted roses along the wall. The meeting started on time for once, and finished early. She put the kettle on and made tea for everyone. The old bridge was closed for repairs, so we took the long way round. He read the same page three times before it made sense. The snow fell all night and covered the garden. We found the key under the mat, exactly where she said it would be. The train was late, so we waited on the platform and talked. I wrote the number on the back of my hand so I would not forget it. The cat slept in the sunniest spot in the whole house. They sang the last song twice because nobody wanted to leave. The shop on the corner sells everything, or almost everything. She kept the ticket from the first concert in a drawer. The river was high after the rain, and the bridge was closed. We counted the stars until the clouds came in. He mended the chair with glue and a clamp and a lot of patience. The garden was full of bees, and the air smelled of lavender.
`;

/** The content bytes of the dictionary (the corpus text above, UTF-8).
 *  Kept separate from the formatted dictionary so tests can report the
 *  content size and the total size independently. */
export function getZstdDictionaryContent(): Uint8Array {
  return new TextEncoder().encode(ZSTD_DICTIONARY_CONTENT_SOURCE);
}

let cachedDictionary: Uint8Array | null = null;

/** The built-in v1 dictionary, formatted per RFC 8878 §5 (magic + ID +
 *  entropy tables + content). Built once and cached. Callers MUST NOT
 *  mutate the returned bytes — compress/decompress copy them into the
 *  wasm heap, they never write into them. */
export function getZstdDictionary(): Uint8Array {
  if (!cachedDictionary) {
    cachedDictionary = buildFormattedZstdDictionary(
      ZSTD_DICTIONARY_ID,
      getZstdDictionaryContent(),
    );
  }
  return cachedDictionary;
}

/** For tests: forget the cached dictionary so a fresh build is used. */
export function resetZstdDictionaryForTests(): void {
  cachedDictionary = null;
}

// ---------------------------------------------------------------------------
// Dictionary v2 — "v2-trained" (fix round 3, item 3).
// Genuinely TRAINED with `zstd --train` (zstd CLI 1.5.5) on a 3,200-file
// corpus built from this project's own .json.zst schemas — see
// dict-training/README.md for the exact command, corpus stats, and
// measured compression. The trainer output is a formatted dictionary
// (RFC 8878 §5) like v1's, so the same ID mechanism applies: the ID
// 0x41524B02 ("ARK\x02") is embedded in every frame compressed with
// v2, and a v1 client reading a v2 frame fails loudly on the ID
// mismatch instead of silently mis-decoding.
// The bytes ride in the source as base64 (this project has no bundler,
// so a .bin file cannot be loaded by the browser build) — written by
// dict-training/embed-dict-v2.mjs, which verifies the magic + ID
// before embedding. Never hand-edit the base64: regenerate it.
// ---------------------------------------------------------------------------

/** Dictionary version. v2 is the LEGACY decode dictionary: new files
 *  are NOT written with it (plain zstd since 2026-11-21). */
export const ZSTD_DICTIONARY_V2_VERSION = 2;

/** Human label. "trained" is literal this time — see above. */
export const ZSTD_DICTIONARY_V2_LABEL = "v2-trained";

/** Dictionary ID embedded in every frame compressed with v2. "ARK\x02":
 *  the letters ARK plus version byte 2, same free public range as v1. */
export const ZSTD_DICTIONARY_V2_ID = 0x41524b02;

/** SHA-256 (hex) of the exact trained dictionary bytes returned by
 *  getZstdDictionaryV2(). Pinned by tests/zstd-dict-v2.test.ts — any
 *  change to the dictionary changes this hash and must be a deliberate,
 *  recorded change (re-run dict-training/train.sh + embed-dict-v2.mjs). */
export const ZSTD_DICTIONARY_V2_SHA256 = "a1786956c8f9b919c393ba27347213c8db48a283615b23bfe03582f92544c96d";

/** The trained dictionary bytes, base64 (see embed-dict-v2.mjs). */
export const ZSTD_DICTIONARY_V2_BASE64 = "N6Qw7AJLUkEzEMiTpAP///////+XEhoRatYSAi1pzQJ9JKWUBFILw7Z9fR82PxGRSilTSiml25qR3J0xIwEAAACIQ+IReWhOqV8BBGAAiBEZTR8nISUaCiUSiTTLchilkEHIGELAmBESAAIEAAAAhBo0kCFmEAAAAAAAAIABAAAAAAEAAAAEAAAACAAAAC1zaXRlLW11c2ljZXJhIiwiY3JlYXRlZEF0IjoxNzk0NzI1Mzc0LCJib2R5IjoiTWlzdHkgc3RhdGlvbiBjYXJyaWVzIHRoZSBldmVuaW5nIGJlbGwgbmVhciB0aGUgb2xkIGJyaWRnZS4gV2UgcGxhbnRzIHRoZSBnb2xkZW4gZmVycnkgbmVhciB0aGUgb2xkIGJyaWRnZSBiZWZvcmUgYSBib3Jyb3dlZCBsYWRkZXIgY2xlYW5zIHdpZGUuIFRoZSB0ZWFyb29tIHNpbmdzIHRoZSBvbGQgbWFwLCBhbmQgdGhlIG5vdGVib29rIHdhbGtzIGJ5IHRoZSBraXRjaGVuIGRvb3IuIn0seyJpZCI6ImMyIiwiYXV0aG9yIjoiaGVucnkiLCJjcmVhdGVkQXQiOjE3OTQxMTE1MDksImJvZHkiOiJXZSBjb3VudHMgdGhlIGdlbnRsZSB2aW5leWFyZCBhdCB0aGUgZW5kIG9mIHRoZSBsYW5lIGJlZm9yZSB0aGUgcml2ZXIgcm9hZCBsaXN0ZW5zIGhvbGxvdy4gVGhlIGJha2VyeSBmb2xsb3dzIGEgbGV0dGVyLCBhbmQgdGhlIG1hcmtldCB3YWl0cyBhdCB0aGUgZW5kIG9mIHRoZSBsYW5lLiBMYXRlIG9yY2hhcmQgZ2F0aGVycyBhIGxldHRlciBwYXN0IHRoZSBtaWxsIHBvbmQuIn1dLCJtImFya25ldHo6Ly9zY2llbmNlLXN0YXJzLmluay9wb3N0cyJ9XSwiYmxvY2tzIjpbeyJ0eXBlIjoiaGVybyIsInRpdGxlIjoiQSB5ZWFyIG9mIGJyZWFkIiwic3VidGl0bGUiOiJCaWN5Y2xlIHJlbWVtYmVycyBzb2Z0IGNoYXBlbCB1bmRlciB0aGUgYXBwbGUgdHJlZSwgd2hpbGUgdGhlIHNvZnQgYmFrZXJ5IHdhdGNoZXMgdGhlIG5ldyByb29mLiBXZSB3YXRjaGVzIHRoZSBzb2Z0IGxhbnRlcm4gdW5kZXIgdGhlIGFwcGxlIHRyZWUgYmVmb3JlIGEgYm9ycm93ZWQgbGFkZGVyIHNpbmdzIGNhbG0uIFJvdW5kIGJpY3ljbGUgZ3Jvd3MgdGhlIHJpdmVyIHJvYWQgYWNyb3NzIHRoZSBtZWFkb3cuIn0seyJ0eXBlIjoiaDIiLCJ0ZXh0IjoiRmVycnkgd2FpdHMgc21hbGwgYmluZGVyeSBwYXN0IHRoZSBtaWxsIHBvbmQsIHdoaWxlIHRoZSBuYXJyb3cgZ3JlZW5ob3VzZSBjYXJyaWVzIHRoZSByaXZlciByb2FkLiBFYXJseSBxdWF5IGNvdW50cyBhIHBvdCBvZiB0ZWEgYXJvdW5kIHRoZSBtYXJrZXQgc3F1YXJlLiBUaGUgbWVhZG93IHNpbmdzIHRoZSBlaW5nIGJlbGwgYWNyb3NzIHRoZSBtZWFkb3cuIFZpbmV5YXJkIHdyaXRlcyBzdGVlcCBib2F0eWFyZCBiZWhpbmQgdGhlIGNoYXBlbCwgd2hpbGUgdGhlIG9sZCBmb3Jlc3QgbWVldHMgdGhlIHRvb2wgY2hlc3QuIn1dLCJ2ZXJzaW9uIjoiMSIsInVwZGF0ZWQiOjE3OTQxNzA2Njd9eyJ1bWFyQGxpYnJhcnktc3RhcnMuZWR1Ijp7ImRpc3BsYXlOYW1lIjoiVW1hciBFeGFtcGxlIiwiY29udGFjdEFkZHJlc3MiOiJ1bWFyQGxpYnJhcnktc3RhcnMuZWR1IiwiZmluZ2VycHJpbnQiOiJhZTNiZWYwYjMyMjEwNWQwOWIyODVkNTJhMzYwMzJkZDlhZDNmMGM5IiwicHVibGljS2V5QjY0IjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQT0iLCJyZWxheXMiOlsiZ2g6dW1hci9hcmtuZXR6LW1haWwiXSwidXBkYXRlZCI6MTc5NDQ5MTU5OH0sImZyYW5rQGhhcmJvdXItYm9va3MuaW5rIjp7ImRpc3BsYXlOYW1lIjoiRnJhbmsgRXhhbXBsZSIsImNvbnRhY3RBZGRyZXNzIjoiZnJhbmtAaGFyYm91ci1ib29rcy5pbmsiLCJmaW5ndmlzaXRzIGdyZWVuLiBUaGUgcXVheSByZW1lbWJlcnMgYSBzaGVsZiBvZiBqYXJzLCBhbmQgdGhlIGNoYXBlbCBncm93cyBiZXR3ZWVuIHRoZSB0YWxsIGhlZGdlcy4iLCJjYXRlZ29yeSI6ImNvZGUiLCJ0YWdzIjpbImNvZGUiLCJzY2llbmNlIiwibWFwcyJdLCJ1cGRhdGVkIjoxNzk0MDE1NTk2fSx7ImRvbWFpbiI6InN0YXJzLWhhcmJvdXIuZWR1IiwidGl0bGUiOiJXYWxraW5nIHdpdGggdGVhIiwiZGVzY3JpcHRpb24iOiJTbG93IG9yY2hhcmQgd2F0Y2hlcyB0aGUgdG9vbCBjaGVzdCBwYXN0IHRoZSBtaWxsIHBvbmQuIFRoZSBjaGFwZWwgc2luZ3MgdGhlIHRvb2wgY2hlc3QsIGFuZCB0aGUgcml2ZXIgcmVhZHMgYmVzaWRlIHRoZSBzdGF0aW9uLiBQbGFpbiBicmlkZ2UgdGVuZHMgdGhlIGZpcnN0IGxpZ2h0IGluc2lkZSB0aGUgZ3JlZW5ob3VzZS4iLCJjYXRlZ29yeSI6ImNvZGUiLCJ0YWdzIjpbImNvZGUiLCJjeWNsZXMiLCJjbG91ZHMiXSwidXBkYXRlZCI6MTc5NDQzNjQ1N31dfXsiZG9tYWluIjoiY3ljbGVzLWNyYWZ0LTgwNS5leGFtIHRlYS4ifSx7InR5cGUiOiJpbWciLCJzcmMiOiJodHRwczovL2FyY2hpdmUub3JnL2Rvd25sb2FkL2NvZGUtcGhvdG9zL3JhZGlvLmpwZyIsImFsdCI6IkEgcGhvdG9ncmFwaCBvZiBjbG91ZHMiLCJjYXB0aW9uIjoiV2Ugd2VsY29tZXMgdGhlIHByb3VkIG1pbGwgYWxvbmcgdGhlIHJpdmVyIGJlZm9yZSBhIGJhc2tldCBvZiBhcHBsZXMgbGlzdGVucyBlYXJseS4gUml2ZXIgYnVpbGRzIG1pc3R5IGJvYXR5YXJkIGluIHRoZSBiYWNrIHJvb20sIHdoaWxlIHRoZSBzd2VldCB2aW5leWFyZCBwYWludHMgYSBib3Jyb3dlZCBsYWRkZXIuIFdlIHdyaXRlcyB0aGUgcXVpZXQgbWVhZG93IGluc2lkZSB0aGUgZ3JlZW5ob3VzZSBiZWZvcmUgdGhlIGhhcnZlc3QgbWVldHMgcXVpZXQuIn1dLCJ2ZXJzaW9uIjoiMSIsInVwZGF0ZWQiOjE3OTQzNzg4OTl9eyJ0YXJhQGtpdGNoZW4tY29kZS5ibG9nIjp7ImRpc3BsYXlOYW1lIjoiVGFyYSBFeGFtcGxlIiwiY29udGFjdEFkZHJlc3MiOiJ0YXJhQGtpdGNoZW4tY29kZS5ibG9nIiwiZmluZ2VycHJpbnQiOiJiZXJyeSBncmFuYXJ5IHJlYWRzIHRoZSBuZXcgcm9vZiBiZWhpbmQgdGhlIGNoYXBlbC4gVGVhcm9vbSBsaXN0ZW5zIHByb3VkIG1pbGwgYmVzaWRlIHRoZSBzdGF0aW9uLCB3aGlsZSB0aGUgaG9sbG93IGdyYW5hcnkgY3Jvc3NlcyBhIHBvdCBvZiB0ZWEuIEhhcmJvdXIgbWVuZHMgbGF0ZSBraXRjaGVuIGFjcm9zcyB0aGUgbWVhZG93LCB3aGlsZSB0aGUgbWVycnkgbGlicmFyeSB2aXNpdHMgdGhlIG1vcm5pbmcuIiwiY2F0ZWdvcnkiOiJnYW1lcyIsInRhZ3MiOlsicG9ldHJ5IiwiY29va2luZyIsImxvY2FsIGhpc3RvcnkiXSwidXBkYXRlZCI6MTc5NDcwMDY4OH0seyJkb21haW4iOiJmaWxtcy1ib29rcy5hcnQiLCJ0aXRsZSI6IkhvdyB0byBzdGFydCBsb2NhbCBoaXN0b3J5IiwiZGVzY3JpcHRpb24iOiJIYXJib3VyIHJlcGFpcnMgbWlzdHkgbGFudGVybiB1bmRlciB0aGUgZWF2ZXMsIHdoaWxlIHRoZSBzdGVlcCBmb3Jlc3Qgd2VsY29tZXMgdGhlIGxhc3QgdHJhaW4uIE9sZCBsaWJyYXJ5IGNvdW50cyB0aGUgd2ludGVyIHN0b3JlIGluIHRoW3siZG9tYWluIjoicGhvdG9zLWNvbXBhc3MuZWR1IiwidGl0bGUiOiJFdmVyeWRheSBoYW5kIHRvb2xzIiwiZGVzY3JpcHRpb24iOiJUaGUgZmVycnkgd2FpdHMgdGhlIGZlc3RpdmFsIGJhbm5lciwgYW5kIHRoZSBtYXJrZXQgdGVhY2hlcyBpbiB0aGUgYmFjayByb29tLiBUaGUgZ2FyZGVuIG1lZXRzIHRoZSB0aWRlLCBhbmQgdGhlIHF1YXkgcmVhZHMgcGFzdCB0aGUgbWlsbCBwb25kLiBXZSB3YXRjaGVzIHRoZSBvbGQgZ2FyZGVuIGluIHRoZSByZWFkaW5nIHJvb20gYmVmb3JlIHRoZSBoYXJ2ZXN0IGJha2VzIGJ1c3kuIiwiY2F0ZWdvcnkiOiJtdXNpYyIsInRhZ3MiOlsid29ya3Nob3AiLCJoaXN0b3J5IiwiYmljeWNsZSByZXBhaXIiXSwidXBkYXRlZCI6MTc5NDUxNjA3Nn0seyJkb21haW4iOiJib29rcy1waG90b3MuaW5rIiwidGl0bGUiOiJXYWxraW5nIHdpdGggc2hvcnQgc3RvcmllcyIsImRlc2NyaXB0aW9uIjoiU3RhdGlvbiB0ZW5kcyB0YWxsIHF1YXkgb24gdGhlIHRvcCBzaGVsZiwgd2hpbGUgdGhlIGJ1c3kgcml2ZXIgY291bnRzdXNpYy1icmVhZC0yMTg0LnppbmUiLCJ0aXRsZSI6IlRoZSBmZXJtZW50YXRpb24iLCJkZXNjcmlwdGlvbiI6IkNoYXBlbCB2aXNpdHMgcHJvdWQgbWVhZG93IGFsb25nIHRoZSBjbGlmZiBwYXRoLCB3aGlsZSB0aGUgc2hhcnAgbm90ZWJvb2sgZm9sbG93cyB0aGUgbW9ybmluZy4gVGhlIG1hcmtldCB3YXRjaGVzIGEgcG90IG9mIHRlYSwgYW5kIHRoZSBncmFuYXJ5IHdhdGNoZXMgb24gdGhlIHRvcCBzaGVsZi4gVGhlIGNvbXBhc3MgYnVpbGRzIGEgcG90IG9mIHRlYSwgYW5kIHRoZSB3b3Jrc2hvcCBsaXN0ZW5zIG92ZXIgdGhlIGhhcmJvdXIgd2FsbC4iLCJjYXRlZ29yeSI6ImdhcmRlbiIsInRhZ3MiOlsicGhvdG9zIiwia2l0Y2hlbiIsIndpbGRmbG93ZXJzIl0sInVwZGF0ZWQiOjE3OTQ4MTI4NTR9XX17InRocmVhZHMiOlt7ImlkIjoidGhyZWFkLTAwNzAiLCJkb21haW4iOiJoYXJib3VyLWN5Y2xlcy5hcnQiLCJwYWdlUGF0aCI6InJlY2lwZXMvc3RhcnRlciIsInRpdGxlIjoiRXZlcnlkYXkgY2xvdWRzIiwibG9ja2VkIjp0cnVlLCJjb21tYXJpc2ggcmVjb3JkcyBvcGVucyBvbGQuIFBhdGllbnQgYm9hdHlhcmQgbWVuZHMgYSBsZXR0ZXIgYWxvbmcgdGhlIHJpdmVyLiJ9XSwidmVyc2lvbiI6IjIiLCJ1cGRhdGVkIjoxNzk0MDU4NzUzfSJ0eXBlIjoiYXVkaW8iLCJzcmMiOiJnYW1lcy1tZWFkb3cuemluZSIsImRpcmVjdG9yeUNhdGVnb3JpZXMiOlsiInR5cGUiOiJpbWciLCJzcmMiOiJzdGFycy1jb2RlLmVkdSIsImFsdCI6ImNvZGUtZmlsbXMuemluZSIsInR5cGUiOiJnYWxsZXJ5IiwiaXRlbXMiOiJraXRjaGVuLWhpc3RvcnkiLCJ0eXBlIjoiYXBwIiwibmFtZSI6InJpdmVycy10cmF2ZWwuemluZSIsInRpdGxlIjoidHJhaW5zLWJyZWFkLmVkdSIsImNhdGVnb3J5IjoibGlicmFyeS1tdXNpYy5lZHUiLCJjYXRlZ29yeSI6ImN5Y2xlcy1oYXJ2ZXN0LnppbmUiLCJmb250Ijoicml2ZXJzLWhhcnZlc3QuZXhhbXBsZSIsImFsdCI6ImNyYWZ0LWJvb2tzLnppbmUiLCJ0aHJlYWRzIjpbeyJpZCI6ImNyYWZ0LWtpdGNoZW4uZWR1IiwibWVzc2FnZUlkIjoia2l0Y2hlbi1zdGFycy56aW5laW5nIiwiYm9keSI6IkhlbGxvIGxhcmEsXG5cblRhbGwga2l0Y2hlbiBwYWludHMgdGhlIGxhc3QgdHJhaW4gcGFzdCB0aGUgbWlsbCBwb25kLiBPbGQgYXJjaGl2ZSBvcGVucyBhIGxldHRlciBiZXNpZGUgdGhlIHN0YXRpb24uIFRoZSB3b3Jrc2hvcCBrZWVwcyBhIGxldHRlciwgYW5kIHRoZSBiaW5kZXJ5IGJha2VzIGFjcm9zcyB0aGUgbWVhZG93LlxuXG5GZXJyeSB0ZW5kcyB3YXJtIGdyYW5hcnkgYWxvbmcgdGhlIGNsaWZmIHBhdGgsIHdoaWxlIHRoZSBzd2VldCBiYWtlcnkgcmVwYWlycyB0aGUgZmlyc3QgbGlnaHQuIFRoZSBsYW50ZXJuIGNvdW50cyBhIGxldHRlciwgYW5kIHRoZSBicmlkZ2UgcGFpbnRzIGFjcm9zcyB0aGUgbWVhZG93LiBTbWFsbCBicmlkZ2Ugc2luZ3MgdGhlIHRpZGUgYWNyb3NzIHRoZSBtZWFkb3cuXG5cbkJlc3Qgd2lzaGVzLFxubWlrZSIsInNlbnRBdCI6MTc5NDEwNjc5MTAwMCwiYXR0YWNobWVudHMiOlt7Im5hbWUiOiJub3Rlcy50eHQiLCJzaXplIjozNDIwLCJjb250ZW50VHlwZSI6InRleHQvcGxhaW4ifV19IHN0ZWVwIG9yY2hhcmQgZm9sbG93cyB0aGUgZXZlbmluZyBiZWxsLiBCb2F0eWFyZCBjb3VudHMgbGF0ZSBncmVlbmhvdXNlIGJlc2lkZSB0aGUgc3RhdGlvbiwgd2hpbGUgdGhlIHJvdW5kIG1lYWRvdyB3ZWxjb21lcyB0aGUgcGFyaXNoIHJlY29yZHMuIFdlIHdyaXRlcyB0aGUgcGF0aWVudCBmZXJyeSBiZXNpZGUgdGhlIHN0YXRpb24gYmVmb3JlIHRoZSBmaXJzdCBsaWdodCBjb3VudHMgc2hhcnAuIn0seyJ0eXBlIjoicXVvdGUiLCJ0ZXh0IjoiTGlicmFyeSByZW1lbWJlcnMgZ2VudGxlIGdhcmRlbiBhbG9uZyB0aGUgY2xpZmYgcGF0aCwgd2hpbGUgdGhlIGdyZWVuIHZpbmV5YXJkIHJlcGFpcnMgdGhlIGxhc3QgdHJhaW4uIENoYXBlbCB3YWxrcyBuYXJyb3cgY29tcGFzcyBpbiB0aGUgcmVhZGluZyByb29tLCB3aGlsZSB0aGUgbGF0ZSBzdGF0aW9uIGNhcnJpZXMgYSBwb3Qgb2YgdGVhLiBLaXRjaGVuIHZpc2l0cyBtaXN0eSBvYnNlcnZhdG9yeSBvbiB0aGUgdG9wIHNoZWxmLCB3aGlsZSB0aGUgZWFybHkgaGFyYm91ciBzaW5ncyBhIGJhbWFpbiI6InN0dWRpby10cmF2ZWwuYXJ0IiwidGl0bGUiOiJUaGUgc3RhciBjaGFydHMiLCJkZXNjcmlwdGlvbiI6IlJpdmVyIHBsYW50cyBidXN5IHRlYXJvb20gaW4gdGhlIHJlYWRpbmcgcm9vbSwgd2hpbGUgdGhlIHByb3VkIGdhcmRlbiBiYWtlcyB0aGUgZmlyc3QgbGlnaHQuIFdlIGNsZWFucyB0aGUgc3RlZXAgcml2ZXIgdW5kZXIgdGhlIGFwcGxlIHRyZWUgYmVmb3JlIHRoZSBmZXN0aXZhbCBiYW5uZXIgcmVwYWlycyBsYXRlLiBNaXN0eSBvYnNlcnZhdG9yeSBsaWdodHMgdGhlIG5ldyByb29mIGluIHRoZSByZWFkaW5nIHJvb20uIiwiY2F0ZWdvcnkiOiJmb29kIiwidGFncyI6WyJjb2RlIiwibGlicmFyeSIsInNvbmdzIl0sInVwZGF0ZWQiOjE3OTQ3NDQ5OTB9LHsiZG9tYWluIjoibXVzaWMtcG9ldHJ5LmV4YW1wbGUiLCJ0aXRsZSI6IkV2ZXJ5ZGF5IGJpY3ljbGUgcmVwYWlyIiwiZGVzY3JpcHRpb24iOiJTbG93IG9ic2VydmF0b3J5IGNvdW50cyB0aGUgcml2ZXIgcm9hZCBhbG9uZyB0aGUgcml2ZXIuIE9sZCBhcmNoaXZlIGxpZ2h0cml2ZXIgcm9hZC4gVGhlIGNoYXBlbCB3YWl0cyB0aGUgZmlyc3QgbGlnaHQsIGFuZCB0aGUgY2hhcGVsIHdyaXRlcyBuZWFyIHRoZSBvbGQgYnJpZGdlLiJ9LHsidHlwZSI6ImxpbmsiLCJsYWJlbCI6IlRpbWV0YWJsZSIsImhyZWYiOiJhcmtuZXR6Oi8vbGFudGVybi1jcmFmdC56aW5lL2FyY2hpdmUifSx7InR5cGUiOiJoMyIsInRleHQiOiJXZSBnYXRoZXJzIHRoZSBtZXJyeSBub3RlYm9vayBpbiB0aGUgYmFjayByb29tIGJlZm9yZSB0aGUgbGFzdCB0cmFpbiBwbGFudHMgb2xkLiBXZSBvcGVucyB0aGUgcm91Z2ggbWlsbCBpbiB0aGUgcmVhZGluZyByb29tIGJlZm9yZSB0aGUgdG9vbCBjaGVzdCBncm93cyBtaXN0eS4gVGhlIGFyY2hpdmUgZ2F0aGVycyB0aGUgZXZlbmluZyBiZWxsLCBhbmQgdGhlIHN0dWRpbyBidWlsZHMgYnkgdGhlIGtpdGNoZW4gZG9vci4ifSx7InR5cGUiOiJoMyIsInRleHQiOiJUaGUgbWVhZG93IHBhaW50cyBhIHBvdCBvZiB0ZWEsIGFuZCB0aGUgbGlicmFyeSBsaWdodHMgdW5kZXIgdGhlIGVhdmVzLiBXZSBjbG9zdHlhcmQuIFRoZSBoYXJib3VyIHJlYWRzIGEgYmFza2V0IG9mIGFwcGxlcywgYW5kIHRoZSBib2F0eWFyZCB3cml0ZXMgaW4gdGhlIHJlYWRpbmcgcm9vbS4gQ2FsbSBtYXJrZXQgY2FycmllcyB0aGUgZXZlbmluZyBiZWxsIG92ZXIgdGhlIGhhcmJvdXIgd2FsbC4iXSxbInAiLCJCcmlkZ2Ugd2Fsa3Mgb2xkIG1hcmtldCBvdmVyIHRoZSBoYXJib3VyIHdhbGwsIHdoaWxlIHRoZSByb3VnaCBraXRjaGVuIGtlZXBzIGEgYmFza2V0IG9mIGFwcGxlcy4gTG9uZWx5IHN0YXRpb24gYnVpbGRzIHRoZSBtb3JuaW5nIG9uIHRoZSB0b3Agc2hlbGYuIEJpY3ljbGUgZ2F0aGVycyBxdWlldCBzdGF0aW9uIGF0IHRoZSBlbmQgb2YgdGhlIGxhbmUsIHdoaWxlIHRoZSBjYWxtIGZvcmVzdCBtZWV0cyB0aGUgc3VtbWVyIHJhaW4uIl1dfV19eyJ6b2VAbGlicmFyeS1tYXJrZXQtMTc1MC5zaXRlIjp7ImRpc3BsYXlOYW1lIjoiWm9lIEV4YW1wbGUiLCJjb250YWN0QWRkcmVzcyI6InpvZUBsaWJyYXJ5LW1hcmtldC0xNzUwLnNpdGUiLCJmaW5nZXJwcmludCI6IjdjYWdzIjpbImhhcnZlc3QiLCJzdGFycyIsInRyYWlucyJdLCJ1cGRhdGVkIjoxNzk0MjU0ODM2fSx7ImRvbWFpbiI6IndvcmtzaG9wLWNvZGUuc2l0ZSIsInRpdGxlIjoiVGhlIGhhbmQgdG9vbHMiLCJkZXNjcmlwdGlvbiI6Ik1lYWRvdyB3cml0ZXMgc3dlZXQgdGVhcm9vbSBhY3Jvc3MgdGhlIG1lYWRvdywgd2hpbGUgdGhlIHN0ZWVwIG5vdGVib29rIGNsZWFucyB0aGUgdG9vbCBjaGVzdC4gTmFycm93IGFyY2hpdmUga2VlcHMgdGhlIHBhcmlzaCByZWNvcmRzIGJ5IHRoZSBraXRjaGVuIGRvb3IuIFdlIG9wZW5zIHRoZSBxdWlldCBsaWJyYXJ5IHBhc3QgdGhlIG1pbGwgcG9uZCBiZWZvcmUgdGhlIHdpbnRlciBzdG9yZSBjb3VudHMgbmFycm93LiIsImNhdGVnb3J5IjoiY2luZW1hIiwidGFncyI6WyJnYXJkZW4iLCJjeWNsZXMiLCJub3RlYm9va3MiXSwidXBkYXRlZCI6MTc5NDE5NTE0OX1dfXsiYmxvZy5icmVhZC1jb29raW5nLnByZXNzIjoiZ2g6eXVzdWYvYXJrbmV0ei1zaXRlLWJsb2ctYnJlYWQtY29va2luZy1wcmVzcyIsInNob3AuYnJlbyI6W3sibmFtZSI6ImFsaWNlIEV4YW1wbGUiLCJhZGRyZXNzIjoiYWxpY2VAZXhhbXBsZS5jb20ifV0sInN1YmplY3QiOiJQaG90b3MgZnJvbSB0aGUgdHJpcCIsImJvZHkiOiJIZWxsbyBhbGljZSxcblxuVGhlIGhhcmJvdXIgcmVtZW1iZXJzIHRoZSBvbGQgbWFwLCBhbmQgdGhlIGJha2VyeSBnYXRoZXJzIHVuZGVyIHRoZSBhcHBsZSB0cmVlLiBXZSBjYXJyaWVzIHRoZSBuYXJyb3cgYmluZGVyeSBiZXNpZGUgdGhlIHN0YXRpb24gYmVmb3JlIGEgYm9ycm93ZWQgbGFkZGVyIGdyb3dzIGdyZWVuLiBXZSBjbGVhbnMgdGhlIGVhcmx5IHRlYXJvb20gYXJvdW5kIHRoZSBtYXJrZXQgc3F1YXJlIGJlZm9yZSBhIGxldHRlciBtZWV0cyBwbGFpbi5cblxuQ2hhcGVsIG1lZXRzIHNvZnQgZ3JlZW5ob3VzZSBhcm91bmQgdGhlIG1hcmtldCBzcXVhcmUsIHdoaWxlIHRoZSBwYXRpZW50IG1pbGwgd2Fsa3MgYSBzaGVsZiBvZiBqYXJzLiBUaGUgZ3JlZW5ob3VzZSBwYWludHMgdGhlIGZpcnN0IGxpZ2h0LCBhbmQgdGhlIGhhcmJvdXIgd2Fsa3MgYWJvdmUgZSIsImJhY2tlbmQiOiJnaDptaWtlL2Fya25ldHotc2l0ZS1raXRjaGVuLW1lYWRvdy1zaXRlIiwic2hhcmQiOiI4Iiwib3duZXIiOiJtaWtlIiwidXBkYXRlZCI6MTc5NDA0OTQ2Nn0seyJkb21haW4iOiJjb21wYXNzLWdhbWVzLmluayIsImJhY2tlbmQiOiJnaDpjYXJvbC9hcmtuZXR6LXNpdGUtY29tcGFzcy1nYW1lcy1pbmsiLCJzaGFyZCI6ImYiLCJvd25lciI6ImNhcm9sIn0seyJkb21haW4iOiJyYWRpby1nYXJkZW4uemluZSIsImJhY2tlbmQiOiJnaDpkYXZlL2Fya25ldHotc2l0ZS1yYWRpby1nYXJkZW4temluZSIsInNoYXJkIjoiZiIsIm93bmVyIjoiZGF2ZSIsInVwZGF0ZWQiOjE3OTQxNjgxNDZ9XX17ImRvbWFpbiI6InBvZXRyeS1tZWFkb3cuaW5rIiwidGl0bGUiOiJTbWFsbCBjb2RlIiwidGhlbWUiOnsibGF5b3V0IjoicG9ydGZvbGlvIiwiYWNjZW50IjoiI2I0NTMwOSIsImZvbnQiOiJHZW9yZ2lhLCBzZXJpZiJ9LCJuYXYiOlt7ImxhYmVsIjoiSG9tZSIsImhyZWYiOiJhcmtuZXR6Oi8vcG9ldHJ5LW1lYWRvdy5pbmsifSx7ImxhZm9yZSB0aGUgaGFydmVzdCB2aXNpdHMgc3dlZXQuIENoYXBlbCBrZWVwcyBjYWxtIHdvcmtzaG9wIGJldHdlZW4gdGhlIHRhbGwgaGVkZ2VzLCB3aGlsZSB0aGUgbWlzdHkgaGFyYm91ciB0ZWFjaGVzIHRoZSByaXZlciByb2FkLiBTbG93IGJyaWRnZSBwYWludHMgdGhlIGV2ZW5pbmcgYmVsbCBhbG9uZyB0aGUgcml2ZXIuIn0seyJ0eXBlIjoiY29kZSIsImxhbmd1YWdlIjoidHlwZXNjcmlwdCIsInRleHQiOiJhcmtuZXR6Oi8vcml2ZXJzLWN5Y2xlcy5ibG9nXG5yZWdpc3RyeSBzaGFyZDogU0hBMjU2KGRvbWFpbilbMF0ifSx7InR5cGUiOiJpbWciLCJzcmMiOiJodHRwczovL2FyY2hpdmUub3JnL2Rvd25sb2FkL2FuY2hvci1waG90b3Mvd29ya3Nob3AuanBnIiwiYWx0IjoiQSBwaG90b2dyYXBoIG9mIHNvbmdzIiwiY2FwdGlvbiI6IldlIHBsYW50cyB0aGUgc3RlZXAgYnJpZGdlIGluIHRoZSBiYWNrIHJvb20gYmVmb3JlIGEgc2hlbGYgb2YgamFycyB0ZWFjaGVzIGdvbGRlbi4gS2l0Y2hlbiByZXBhaXJzIHBhdGllbnQgZ2FyZGVuIG9uIHRoIiwiaGFyYm91ciIsImZlcm1lbnRhdGlvbiJdLCJ1cGRhdGVkIjoxNzk0MTc5MzU0fSx7ImRvbWFpbiI6ImFuY2hvci1tZWFkb3cuYmxvZyIsInRpdGxlIjoiRXZlcnlkYXkgYnJlYWQiLCJkZXNjcmlwdGlvbiI6IkJyaWRnZSBrZWVwcyBzaGFycCBiaW5kZXJ5IG9uIHRoZSB0b3Agc2hlbGYsIHdoaWxlIHRoZSBicmlnaHQgbGFudGVybiByZW1lbWJlcnMgdGhlIHdpbnRlciBzdG9yZS4gQmljeWNsZSB3cml0ZXMgbGF0ZSBicmlkZ2Ugb24gdGhlIHRvcCBzaGVsZiwgd2hpbGUgdGhlIGdvbGRlbiBvYnNlcnZhdG9yeSBiYWtlcyB0aGUgbmV3IHJvb2YuIFdlIGJ1aWxkcyB0aGUgd2FybSBzdHVkaW8gYWxvbmcgdGhlIHJpdmVyIGJlZm9yZSB0aGUgZmlyc3QgbGlnaHQgd2F0Y2hlcyByb3VnaC4iLCJjYXRlZ29yeSI6ImdhcmRlbiIsInRhZ3MiOlsiYW5jaG9yIiwicml2ZXJzIiwibGlicmFyaWVzIl0sInVwZGF0ZWQiOjE3OTQ2OTQ3MjR9LHsiZG9tYWluIjoidHJhdmVsLXBob3Rvcy5wcmVzcyIsInRpdGxlIjoiTm90ZXMgb24gY2xvdWRzIiwiZGVzcGUiOiJxdW90ZSIsInRleHQiOiJQcm91ZCBmb3Jlc3QgcmVwYWlycyBhIGxldHRlciBieSB0aGUga2l0Y2hlbiBkb29yLiBTdGF0aW9uIHdhaXRzIHJvdWdoIGZlcnJ5IGFib3ZlIHRoZSBib2F0eWFyZCwgd2hpbGUgdGhlIHBsYWluIG9ic2VydmF0b3J5IHBhaW50cyB0aGUgcGFyaXNoIHJlY29yZHMuIFNvZnQgaGFyYm91ciBiYWtlcyBhIHNoZWxmIG9mIGphcnMgaW5zaWRlIHRoZSBncmVlbmhvdXNlLiJ9LHsidHlwZSI6InAiLCJ0ZXh0IjoiVGhlIHJpdmVyIHZpc2l0cyB0aGUgZmlyc3QgbGlnaHQsIGFuZCB0aGUgYm9hdHlhcmQgYmFrZXMgYWxvbmcgdGhlIHJpdmVyLiBUaGUgcml2ZXIgY3Jvc3NlcyB0aGUgcml2ZXIgcm9hZCwgYW5kIHRoZSB2aW5leWFyZCB0ZWFjaGVzIG9uIHRoZSB0b3Agc2hlbGYuIEJ1c3kgZmVycnkgcmVtZW1iZXJzIHRoZSBzZWVkIG9yZGVyIGFib3ZlIHRoZSBib2F0eWFyZC4ifSx7InR5cGUiOiJpbWciLCJzcmMiOiJodHRwczovL2FyY2hpdmUub3JnL2Rvd25sb2FkL2Nvb2tpbmctcGhvdG9zL2dhbWVzLmpwZyIsaGUgbWVhZG93LiBCaWN5Y2xlIGNyb3NzZXMgbWVycnkgbWFya2V0IG5lYXIgdGhlIG9sZCBicmlkZ2UsIHdoaWxlIHRoZSBlYXJseSBraXRjaGVuIGNsb3NlcyBhIGJvcnJvd2VkIGxhZGRlci4iXV19LHsiaWQiOiJwb3N0LTIiLCJ0IjoiU21hbGwgaGFuZCB0b29scyIsImQiOjE3OTQxNDA1ODcsImIiOltbInAiLCJXZSBvcGVucyB0aGUgcHJvdWQgb3JjaGFyZCB1bmRlciB0aGUgYXBwbGUgdHJlZSBiZWZvcmUgdGhlIHN1bW1lciByYWluIHdhaXRzIHRhbGwuIFdlIHJlcGFpcnMgdGhlIHN3ZWV0IGhhcmJvdXIgaW5zaWRlIHRoZSBncmVlbmhvdXNlIGJlZm9yZSB0aGUgcml2ZXIgcm9hZCB3YWl0cyBvbGQuIFRoZSB3b3Jrc2hvcCBsaWdodHMgYSBib3Jyb3dlZCBsYWRkZXIsIGFuZCB0aGUgbWFya2V0IGNhcnJpZXMgbmVhciB0aGUgb2xkIGJyaWRnZS4iXSxbInAiLCJXZSB0ZW5kcyB0aGUgc3RlZXAgdGVhcm9vbSBhbG9uZyB0aGUgY2xpZmYgcGF0aCBiZWZvcmUgdGhlIG9sZCBtYXAgd2F0Y2hlcyBwcm91ZC4gVGhlIGJpbmRlcnkgcGFpbnRzcmtldCBtZW5kcyB0aGUgZXZlbmluZyBiZWxsIG9uIHRoZSB0b3Agc2hlbGYuIFRoZSB0ZWFyb29tIG1lbmRzIHRoZSBmaXJzdCBsaWdodCwgYW5kIHRoZSB3b3Jrc2hvcCBiYWtlcyBwYXN0IHRoZSBtaWxsIHBvbmQuIl0sWyJwIiwiTWlzdHkgYnJpZGdlIGNsb3NlcyB0aGUgbW9ybmluZyBiZW5lYXRoIHRoZSBzdGFpcnMuIFN0dXJkeSBhcmNoaXZlIGdyb3dzIHRoZSBvbGQgbWFwIG92ZXIgdGhlIGhhcmJvdXIgd2FsbC4gV2UgZ3Jvd3MgdGhlIGdvbGRlbiBzdHVkaW8gb24gdGhlIHRvcCBzaGVsZiBiZWZvcmUgYSBib3Jyb3dlZCBsYWRkZXIgdmlzaXRzIHByb3VkLiJdXX1dfXsiZW50cmllcyI6W3siZG9tYWluIjoibGlicmFyeS1sYW50ZXJuLmV4YW1wbGUiLCJiYWNrZW5kIjoiZ2g6aXZhbi9hcmtuZXR6LXNpdGUtbGlicmFyeS1sYW50ZXJuLWV4YW1wbGUiLCJzaGFyZCI6IjYiLCJvd25lciI6Iml2YW4iLCJ1cGRhdGVkIjoxNzk0NzQwMjMxfSx7ImRvbWFpbiI6InBob3Rvcy1yaXZlcnMuYmxvZyIsImJhY2tlbmQiOiJnaDpzYW0vYXJrbmV0MzM2MC5lZHUiLCJ0aXRsZSI6IkEgeWVhciBvZiBzb25ncyIsImRlc2NyaXB0aW9uIjoiV2UgbGlnaHRzIHRoZSB3YXJtIGxpYnJhcnkgYmV0d2VlbiB0aGUgdGFsbCBoZWRnZXMgYmVmb3JlIHRoZSBuZXcgcm9vZiBjcm9zc2VzIHF1aWV0LiBUaGUgcXVheSBjcm9zc2VzIGEgYm9ycm93ZWQgbGFkZGVyLCBhbmQgdGhlIG9ic2VydmF0b3J5IHdhbGtzIG92ZXIgdGhlIGhhcmJvdXIgd2FsbC4gT2JzZXJ2YXRvcnkgbGlnaHRzIHNvZnQgZ2FyZGVuIGFib3ZlIHRoZSBib2F0eWFyZCwgd2hpbGUgdGhlIGNhbG0gb2JzZXJ2YXRvcnkgbGlnaHRzIHRoZSBzZWVkIG9yZGVyLiIsImNhdGVnb3J5IjoidGVjaCIsInRhZ3MiOlsicG9ldHJ5IiwiaGFydmVzdCIsInNob3J0IHN0b3JpZXMiXSwidXBkYXRlZCI6MTc5NDU1MzAwNX0seyJkb21haW4iOiJmaWxtcy1nYXJkZW4uemluZSIsInRpdGxlIjoiSG93IHRvIHN0YXJ0IGNvZGUiLCJkZXNjcmlwdGlvbiI6IldlIGJ1aWxkcyB0aGUgbWVycnkgdmluZXlhcmQgb3ZlciB0aGUgaGFyYm91ciB3YWxsIGJlZm9ydGhlIGFwcGxlIHRyZWUsIHdoaWxlIHRoZSBicmlnaHQgYXJjaGl2ZSBjYXJyaWVzIHRoZSBmaXJzdCBsaWdodC4gVGhlIHRlYXJvb20gcmVhZHMgYSBwb3Qgb2YgdGVhLCBhbmQgdGhlIG1pbGwgcGxhbnRzIGFjcm9zcyB0aGUgbWVhZG93LiBXZSBrZWVwcyB0aGUgcm91bmQgc3R1ZGlvIGluIHRoZSByZWFkaW5nIHJvb20gYmVmb3JlIHRoZSByaXZlciByb2FkIHdhdGNoZXMgc21hbGwuIiwiY2F0ZWdvcnkiOiJnYW1lcyIsInRhZ3MiOlsibGlicmFyeSIsImdhcmRlbiIsInNvbmdzIl0sInVwZGF0ZWQiOjE3OTQ1MzgwMzd9LHsiZG9tYWluIjoiY29kZS1waG90b3Muc2l0ZSIsInRpdGxlIjoiRXZlcnlkYXkgZ2FyZGVucyIsImRlc2NyaXB0aW9uIjoiR3JlZW4gbm90ZWJvb2sgY291bnRzIGEgbGV0dGVyIG9uIHRoZSB0b3Agc2hlbGYuIFN3ZWV0IGdhcmRlbiBnYXRoZXJzIGEgcG90IG9mIHRlYSBhYm92ZSB0aGUgYm9hdHlhcmQuIFdlIGZvbGxvd3MgdGhlIG5hcnJvdyBmb3Jlc3QgYXQgdGhlIGVuZCBvZiB0aGUgbGFuZSBiZWZvcmUgYSBzaGVsImFya25ldHo6Ly9jeWNsZXMtYW5jaG9yLmJsb2cvcG9zdHMifV0sImJsb2NrcyI6W3sidHlwZSI6Imhlcm8iLCJ0aXRsZSI6IkV2ZXJ5ZGF5IHRyYWlucyIsInN1YnRpdGxlIjoiUXVpZXQgZ2FyZGVuIGxpc3RlbnMgdGhlIGhhcnZlc3QgcGFzdCB0aGUgbWlsbCBwb25kLiBXZSB3YWxrcyB0aGUgc2hhcnAgcXVheSBpbiB0aGUgcmVhZGluZyByb29tIGJlZm9yZSB0aGUgbW9ybmluZyByZWFkcyBicmlnaHQuIFRoZSBraXRjaGVuIHdhaXRzIHRoZSB3aW50ZXIgc3RvcmUsIGFuZCB0aGUgbm90ZWJvb2sgY291bnRzIHVuZGVyIHRoZSBlYXZlcy4ifSx7InR5cGUiOiJxdW90ZSIsInRleHQiOiJXZSBrZWVwcyB0aGUgZ29sZGVuIGJha2VyeSBuZWFyIHRoZSBvbGQgYnJpZGdlIGJlZm9yZSBhIGJvcnJvd2VkIGxhZGRlciBwYWludHMgc3dlZXQuIExhbnRlcm4gbGlzdGVucyBzdGVlcCB3b3Jrc2hvcCBvbiB0aGUgdG9wIHNoZWxmLCB3aGlsZSB0aGUgc2hhcnAgbGlicmFyeSBsaXN0ZW5zIHRoZSBsYXN0IHRyYWluLiBUaGUgd29ya3Nob3AgcGxhbnRzbWVhZG93IHBhaW50cyB0aGUgb2xkIG1hcCwgYW5kIHRoZSBmZXJyeSBncm93cyBhbG9uZyB0aGUgY2xpZmYgcGF0aC4gV2lkZSBnYXJkZW4gYnVpbGRzIHRoZSB0aWRlIHBhc3QgdGhlIG1pbGwgcG9uZC5cblxuV2Ugb3BlbnMgdGhlIGxvbmVseSB3b3Jrc2hvcCBiZXR3ZWVuIHRoZSB0YWxsIGhlZGdlcyBiZWZvcmUgdGhlIGZpcnN0IGxpZ2h0IGNyb3NzZXMgbGF0ZS4gU21hbGwgY29tcGFzcyBmb2xsb3dzIHRoZSBldmVuaW5nIGJlbGwgYXJvdW5kIHRoZSBtYXJrZXQgc3F1YXJlLiBXZSBzaW5ncyB0aGUgc2xvdyBiYWtlcnkgYXJvdW5kIHRoZSBtYXJrZXQgc3F1YXJlIGJlZm9yZSBhIHBvdCBvZiB0ZWEgYmFrZXMgd2lkZS5cblxuQmVzdCB3aXNoZXMsXG5wcml5YSIsInNlbnRBdCI6MTc5NDU4NDMxNzAwMCwiYXR0YWNobWVudHMiOltdfXsiZG9tYWluIjoic3RhcnMtY3JhZnQuc2l0ZSIsInRpdGxlIjoiVGhlIHF1aWV0IGFydCBvZiBwaG90b2dyYXBocyIsInRoZW1lIjp7ImxheW91dCI6ImRvY3MiLCJhY2NlbnQiOiIjOWQxNzRkIiwiZm9uZSB0YWxsIGhlZGdlcy4gUGxhaW4gZ3JlZW5ob3VzZSB3YWl0cyB0aGUgZmVzdGl2YWwgYmFubmVyIGluIHRoZSByZWFkaW5nIHJvb20uIEJvYXR5YXJkIHdlbGNvbWVzIG1lcnJ5IGZvcmVzdCBhcm91bmQgdGhlIG1hcmtldCBzcXVhcmUsIHdoaWxlIHRoZSBzb2Z0IGZvcmVzdCB0ZWFjaGVzIGEgYmFza2V0IG9mIGFwcGxlcy4ifSx7ImlkIjoiYzIiLCJhdXRob3IiOiJncmFjZSIsImNyZWF0ZWRBdCI6MTc5NDAwOTMzOCwiYm9keSI6Ik9yY2hhcmQgY291bnRzIGdlbnRsZSBhcmNoaXZlIGJlbmVhdGggdGhlIHN0YWlycywgd2hpbGUgdGhlIGhvbGxvdyB2aW5leWFyZCBsaWdodHMgYSBsZXR0ZXIuIEFyY2hpdmUgd2Fsa3Mgc21hbGwgcml2ZXIgYWxvbmcgdGhlIHJpdmVyLCB3aGlsZSB0aGUgYnVzeSBvYnNlcnZhdG9yeSBtZWV0cyB0aGUgcml2ZXIgcm9hZC4gS2l0Y2hlbiBjb3VudHMgc2hhcnAgbm90ZWJvb2sgaW5zaWRlIHRoZSBncmVlbmhvdXNlLCB3aGlsZSB0aGUgd2lkZSBvcmNoYXJkIGdyb3dzIHRoZSB3aW50ZXIgc3RvcmUuIn1dLCJtLmluayI6eyJkb21haW4iOiJ3b3Jrc2hvcC1oaXN0b3J5LmluayIsImJhY2tlbmQiOiJnaDp1bWFyL2Fya25ldHotc2l0ZS13b3Jrc2hvcC1oaXN0b3J5LWluayIsInNoYXJkIjoiYiIsIm93bmVyIjoidW1hciIsInVwZGF0ZWQiOjE3OTQ1MTYwNjJ9LCJnYXJkZW4ta2l0Y2hlbi5lZHUiOnsiZG9tYWluIjoiZ2FyZGVuLWtpdGNoZW4uZWR1IiwiYmFja2VuZCI6ImdoOmdyYWNlL2Fya25ldHotc2l0ZS1nYXJkZW4ta2l0Y2hlbi1lZHUiLCJtaXJyb3JzIjpbImNiOmdyYWNlL2Fya25ldHotc2l0ZS1nYXJkZW4ta2l0Y2hlbi1lZHUtbWlycm9yIl0sInNoYXJkIjoiYyIsIm93bmVyIjoiZ3JhY2UiLCJ1cGRhdGVkIjoxNzk0MjU5NDM0fSwibWVhZG93LWxhbnRlcm4uYmxvZyI6eyJkb21haW4iOiJtZWFkb3ctbGFudGVybi5ibG9nIiwiYmFja2VuZCI6ImdoOnl1c3VmL2Fya25ldHotc2l0ZS1tZWFkb3ctbGFudGVybi1ibG9nIiwic2hhcmQiOiI2Iiwib3duZXIiOiJ5dXN1ZiIsInVwZGF0ZWQiOjE3OTQyNDY1NjJ9LCJnYXJkZW4tdHJhdmVsLnppbmUidyB0byBzdGFydCB3aWxkZmxvd2VycyIsInN1YnRpdGxlIjoiR3JlZW5ob3VzZSBjbG9zZXMgaG9sbG93IGtpdGNoZW4gYWxvbmcgdGhlIGNsaWZmIHBhdGgsIHdoaWxlIHRoZSB3YXJtIHN0dWRpbyByZWFkcyBhIGxldHRlci4gQmljeWNsZSBrZWVwcyBuYXJyb3cga2l0Y2hlbiBhbG9uZyB0aGUgY2xpZmYgcGF0aCwgd2hpbGUgdGhlIHN3ZWV0IHN0YXRpb24gY2xvc2VzIHRoZSBoYXJ2ZXN0LiBUaGUgZ3JhbmFyeSBnYXRoZXJzIHRoZSByaXZlciByb2FkLCBhbmQgdGhlIHJpdmVyIHdhaXRzIGFsb25nIHRoZSBjbGlmZiBwYXRoLiJ9LHsidHlwZSI6ImxpbmsiLCJsYWJlbCI6IlRoZSBhcmNoaXZlIiwiaHJlZiI6ImFya25ldHo6Ly9yYWRpby1waG90b3MuZWR1L2FyY2hpdmUifSx7InR5cGUiOiJsaW5rIiwibGFiZWwiOiJUaGUgYXJjaGl2ZSIsImhyZWYiOiJodHRwczovL2FyY2hpdmUub3JnL2Rvd25sb2FkL2V4YW1wbGUvZmlsZS5qcGcifSx7InR5cGUiOiJoMiIsInRleHQiOiJXZSByZW1lbWJlcnMgdGhlIGJyaWdodCBiaW5kZXJ5IGJlbmVhNDAxZjg3NjE1ZjdiODA3ZmNjOGNhZCIsIndyYXBwZWRLZXlCNjQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE9IiwiZXBoZW1lcmFsUHVibGljS2V5QjY0IjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQT0ifV0sInBsYWludGV4dEJ5dGVzIjoxNTQ2fXsiZW50cmllcyI6W3siZG9tYWluIjoiYm9va3MtdHJhaW5zLmVkdSIsImJhY2tlbmQiOiJnaDp0YXJhL2Fya25ldHotc2l0ZS1ib29rcy10cmFpbnMtZWR1Iiwic2hhcmQiOiJiIiwib3duZXIiOiJ0YXJhIiwidXBkYXRlZCI6MTc5NDc1NzI1M30seyJkb21haW4iOiJwaG90b3MtaGFydmVzdC5hcnQiLCJiYWNrZW5kIjoiZ2g6ZnJhbmsvYXJrbmV0ei1zaXRlLXBob3Rvcy1oYXJ2ZXN0LWFydCIsInNoYXJkIjoiYiIsIm93bmVyIjoiZnJhbmsiLCJ1cGRhdGVkIjoxNzk0NzQ5OTY1fSx7ImRvbWFpbiI6ImtpdGNoZW4tYnJlYWQtMjcwMi5pbmsiLCJiYWNrZW5kIjoiZ2g6eGVuYS9hcmtuZXR6LXNpdGUta2l0Y2hlL3BhcnQtMiJ9LHsibGFiZWwiOiJ0cmFpbnMgcGFydCAzIiwiaHJlZiI6ImFya25ldHo6Ly9oYXJib3VyLWFuY2hvci5leGFtcGxlL3BhcnQtMyJ9XX1dLCJ2ZXJzaW9uIjoiMSIsInVwZGF0ZWQiOjE3OTQ1NTY4MDd9eyJ2ZXJzaW9uIjoxLCJtZXNzYWdlSWQiOiJtYWlsLTJjN2YwNGI2LTE3OTQ3NDcxMjgtaXZhbiIsInRocmVhZElkIjoidGhyZWFkLTcxNDdkNTEzIiwiZnJvbSI6eyJuYW1lIjoiaXZhbiBFeGFtcGxlIiwiYWRkcmVzcyI6Iml2YW5AZXhhbXBsZS5jb20ifSwidG8iOlt7Im5hbWUiOiJ2ZXJhIEV4YW1wbGUiLCJhZGRyZXNzIjoidmVyYUBleGFtcGxlLmNvbSJ9XSwic3ViamVjdCI6Ik5vdGVzIG9uIGhhbmQgdG9vbHMiLCJib2R5IjoiSGVsbG8gdmVyYSxcblxuQmljeWNsZSBiYWtlcyBtZXJyeSBicmlkZ2UgYXJvdW5kIHRoZSBtYXJrZXQgc3F1YXJlLCB3aGlsZSB0aGUgc29mdCBjb21wYXNzIG1lbmRzIHRoZSBtb3JuaW5nLiBXZSBidWlsZHMgdGhlIGxvbmVseSBiaWN5Y2xlIHVuZGVyIHRoZSBlYXZlcyBiZWZvcmUgYSBiYXNraXNpdHMgc3RlZXAuIFdlIHBsYW50cyB0aGUgYnVzeSBvYnNlcnZhdG9yeSBpbiB0aGUgYmFjayByb29tIGJlZm9yZSB0aGUgbW9ybmluZyBvcGVucyBzdHVyZHkuIFRoZSBib2F0eWFyZCB0ZW5kcyB0aGUgcml2ZXIgcm9hZCwgYW5kIHRoZSBhcmNoaXZlIGtlZXBzIGJ5IHRoZSBraXRjaGVuIGRvb3IuIiwiY2F0ZWdvcnkiOiJtdXNpYyIsInRhZ3MiOlsiZ2FtZXMiLCJnYW1lcyIsIm5vdGVib29rcyJdLCJ1cGRhdGVkIjoxNzk0NjA4ODM1fSx7ImRvbWFpbiI6ImNvb2tpbmctcml2ZXJzLnNpdGUiLCJ0aXRsZSI6IlRoZSBxdWlldCBhcnQgb2YgZ2FyZGVucyIsImRlc2NyaXB0aW9uIjoiQ2FsbSB2aW5leWFyZCByZWFkcyB0aGUgZmVzdGl2YWwgYmFubmVyIGJlaGluZCB0aGUgY2hhcGVsLiBUZWFyb29tIGNyb3NzZXMgcm91bmQgb3JjaGFyZCBhcm91bmQgdGhlIG1hcmtldCBzcXVhcmUsIHdoaWxlIHRoZSBsYXRlIG1pbGwgY3Jvc3NlcyB0aGUgc2VlZCBvcmRlci4gVGhlIG1pbGwgZ2F0aGVycyBhIHBvdCBvZiB0ZWEsIGFuZCB0aGUgZm9yZXN0eUcwNSIsImF0IjoxNzk0ODEzODA0fV19eyJlbnRyaWVzIjpbeyJkb21haW4iOiJhbmNob3ItbGFudGVybi5zaXRlIiwiYmFja2VuZCI6ImdoOmFsaWNlL2Fya25ldHotc2l0ZS1hbmNob3ItbGFudGVybi1zaXRlIiwic2hhcmQiOiI4Iiwib3duZXIiOiJhbGljZSJ9LHsiZG9tYWluIjoiZ2FyZGVuLXBvZXRyeS5ibG9nIiwiYmFja2VuZCI6ImdoOmVyaW4vYXJrbmV0ei1zaXRlLWdhcmRlbi1wb2V0cnktYmxvZyIsInNoYXJkIjoiYiIsIm93bmVyIjoiZXJpbiJ9LHsiZG9tYWluIjoicmFkaW8ta2l0Y2hlbi5pbmsiLCJiYWNrZW5kIjoiZ2g6cXVpbm4vYXJrbmV0ei1zaXRlLXJhZGlvLWtpdGNoZW4taW5rIiwic2hhcmQiOiI2Iiwib3duZXIiOiJxdWlubiIsInVwZGF0ZWQiOjE3OTQ4MDk3NjF9LHsiZG9tYWluIjoibWFya2V0LWhpc3Rvcnkuc2l0ZSIsImJhY2tlbmQiOiJnaDpjYXJvbC9hcmtuZXR6LXNpdGUtbWFya2V0LWhpc3Rvcnktc2l0ZSIsInNoYXJkIjoiNSIsIm93bmVyIjoiY2Fyb2wifSx7ImRvbWFpbiI6InRyYXZlbC1zdGFycy5ibG9ndXN5IGJha2VyeSBvcGVucyBhIHBvdCBvZiB0ZWEgb3ZlciB0aGUgaGFyYm91ciB3YWxsLiBWaW5leWFyZCBidWlsZHMgYnJpZ2h0IGtpdGNoZW4gaW4gdGhlIGJhY2sgcm9vbSwgd2hpbGUgdGhlIHRhbGwgbm90ZWJvb2sgcmVtZW1iZXJzIHRoZSBwYXJpc2ggcmVjb3Jkcy4iXSxbInAiLCJXZSB0ZWFjaGVzIHRoZSBzbWFsbCBiYWtlcnkgaW4gdGhlIGJhY2sgcm9vbSBiZWZvcmUgdGhlIGZlc3RpdmFsIGJhbm5lciBrZWVwcyBsb25lbHkuIE1lYWRvdyBsaWdodHMgcHJvdWQgc3RhdGlvbiBiZXR3ZWVuIHRoZSB0YWxsIGhlZGdlcywgd2hpbGUgdGhlIHBsYWluIHN0YXRpb24gcGxhbnRzIGEgbGV0dGVyLiBDb21wYXNzIHJlYWRzIGdvbGRlbiBnYXJkZW4gaW4gdGhlIHJlYWRpbmcgcm9vbSwgd2hpbGUgdGhlIG5hcnJvdyBiaWN5Y2xlIHJlbWVtYmVycyBhIHNoZWxmIG9mIGphcnMuIl1dfSx7ImlkIjoicG9zdC0zIiwidCI6IkxldHRlcnMgZnJvbSBtYXBzIiwiZCI6MTc5NDgxNzMyMCwiYiI6W1sicCIsIlRoZSBhcmNoaXZlIHJlYWRzIGEgc2hlZXMgdGhlIGV2ZW5pbmcgYmVsbC4gQ2hhcGVsIGxpZ2h0cyB0YWxsIGNvbXBhc3MgcGFzdCB0aGUgbWlsbCBwb25kLCB3aGlsZSB0aGUgcm91Z2ggY29tcGFzcyB3YWl0cyB0aGUgZmVzdGl2YWwgYmFubmVyLiBXZSB2aXNpdHMgdGhlIHRhbGwgbGlicmFyeSBieSB0aGUga2l0Y2hlbiBkb29yIGJlZm9yZSB0aGUgcGFyaXNoIHJlY29yZHMgcGFpbnRzIGhvbGxvdy4ifSx7InR5cGUiOiJwIiwidGV4dCI6IldlIHRlYWNoZXMgdGhlIGxvbmVseSBxdWF5IGFsb25nIHRoZSBjbGlmZiBwYXRoIGJlZm9yZSB0aGUgdG9vbCBjaGVzdCBwbGFudHMgc21hbGwuIFRoZSBhcmNoaXZlIGZvbGxvd3MgdGhlIGZpcnN0IGxpZ2h0LCBhbmQgdGhlIG9yY2hhcmQgd2FpdHMgYWxvbmcgdGhlIHJpdmVyLiBMYW50ZXJuIGNyb3NzZXMgc2xvdyB3b3Jrc2hvcCBhdCB0aGUgZW5kIG9mIHRoZSBsYW5lLCB3aGlsZSB0aGUgbWVycnkgcml2ZXIgd2F0Y2hlcyBhIGxldHRlci4ifSx7InR5cGUiOiJoMSIsInRleHQiOiJXZSBncm93cyB0aGUgYnVzeSBnYXJkZW4gdW5kZXIgbmV0ejovL2hhcmJvdXItYm9va3MuZXhhbXBsZS9hcmNoaXZlIn0seyJ0eXBlIjoiaW1nIiwic3JjIjoiaHR0cHM6Ly9hcmNoaXZlLm9yZy9kb3dubG9hZC9nYXJkZW4tcGhvdG9zL3BvZXRyeS5qcGciLCJhbHQiOiJBIHBob3RvZ3JhcGggb2YgbGlicmFyaWVzIiwiY2FwdGlvbiI6IldvcmtzaG9wIHdhbGtzIHF1aWV0IGJpY3ljbGUgYmVuZWF0aCB0aGUgc3RhaXJzLCB3aGlsZSB0aGUgZ29sZGVuIGFyY2hpdmUgY3Jvc3NlcyB0aGUgdGlkZS4gTGlicmFyeSB3YWl0cyBwbGFpbiBzdHVkaW8gYmVoaW5kIHRoZSBjaGFwZWwsIHdoaWxlIHRoZSBnZW50bGUgb3JjaGFyZCBsaXN0ZW5zIHRoZSBldmVuaW5nIGJlbGwuIFdlIHdlbGNvbWVzIHRoZSBtaXN0eSBxdWF5IGJlbmVhdGggdGhlIHN0YWlycyBiZWZvcmUgdGhlIHBhcmlzaCByZWNvcmRzIGNhcnJpZXMgYnJpZ2h0LiJ9XSwidmVyc2lvbiI6IjIiLCJ1cGRhdGVkIjoxNzk0MDUzNDQ5fXsiZG9tYWluIjoicml2ZXJzLW11c2ljLmJsb2ciLCJwb3N0cyI6W3siaWQiOiJwb3N0LTEiLCJ0IjoiQSBmYXJrbmV0ei1zaXRlLWNvb2tpbmctaGlzdG9yeS1wcmVzcyIsInNoYXJkIjoiMiIsIm93bmVyIjoicHJpeWEifSx7ImRvbWFpbiI6ImhhcnZlc3QtcmFkaW8uZXhhbXBsZSIsImJhY2tlbmQiOiJnaDplcmluL2Fya25ldHotc2l0ZS1oYXJ2ZXN0LXJhZGlvLWV4YW1wbGUiLCJzaGFyZCI6IjMiLCJvd25lciI6ImVyaW4ifSx7ImRvbWFpbiI6InJhZGlvLWhpc3RvcnkuYXJ0IiwiYmFja2VuZCI6ImdoOnByaXlhL2Fya25ldHotc2l0ZS1yYWRpby1oaXN0b3J5LWFydCIsInNoYXJkIjoiYSIsIm93bmVyIjoicHJpeWEiLCJ1cGRhdGVkIjoxNzk0NjIxOTA5fSx7ImRvbWFpbiI6ImN5Y2xlcy1tYXJrZXQuZWR1IiwiYmFja2VuZCI6ImdoOnZlcmEvYXJrbmV0ei1zaXRlLWN5Y2xlcy1tYXJrZXQtZWR1Iiwic2hhcmQiOiI5Iiwib3duZXIiOiJ2ZXJhIn0seyJkb21haW4iOiJyYWRpby1tdXNpYy5leGFtcGxlIiwiYmFja2VuZCI6ImdoOmthcmwvYXJrbmV0ei1zaXRlLXJhZGlvLW11c2ljLWV4YW1wbGUiLCJzaGFyZCI6IjEiLCJvd25lciI6ImthcmwifV19YWQgYmVoaW5kIHRoZSBjaGFwZWwuIEhvbGxvdyBnYXJkZW4ga2VlcHMgYSBiYXNrZXQgb2YgYXBwbGVzIHBhc3QgdGhlIG1pbGwgcG9uZC4gT2xkIHZpbmV5YXJkIHNpbmdzIHRoZSBzZWVkIG9yZGVyIG5lYXIgdGhlIG9sZCBicmlkZ2UuXG5cblRoZSBsYW50ZXJuIGJ1aWxkcyB0aGUgc3VtbWVyIHJhaW4sIGFuZCB0aGUga2l0Y2hlbiB3YWxrcyBvbiB0aGUgdG9wIHNoZWxmLiBTd2VldCBncmFuYXJ5IGNsZWFucyB0aGUgbW9ybmluZyBvdmVyIHRoZSBoYXJib3VyIHdhbGwuIEdyZWVuaG91c2UgZ2F0aGVycyBtaXN0eSBicmlkZ2Ugb24gdGhlIHRvcCBzaGVsZiwgd2hpbGUgdGhlIGVhcmx5IGdyYW5hcnkgcmVwYWlycyB0aGUgcml2ZXIgcm9hZC5cblxuQmVzdCB3aXNoZXMsXG51bWFyIiwic2VudEF0IjoxNzk0NjQwNjY4MDAwLCJhdHRhY2htZW50cyI6W119eyJkb21haW4iOiJicmVhZC1maWxtcy5wcmVzcyIsInRpdGxlIjoiQSBmaWVsZCBndWlkZSB0byBzaG9ydCBzdG9yaWVzIiwidGhlbWUiOnsibGF5b3V0IjoibWFnYXppbmUiLCJhY2NlcmtldCBzcXVhcmUuIn0seyJzcmMiOiJodHRwczovL2FyY2hpdmUub3JnL2Rvd25sb2FkL3Bob3Rvcy1waG90b3MvdHJhdmVsLmpwZyIsImFsdCI6ImNsb3VkcyIsImNhcHRpb24iOiJCaW5kZXJ5IGxpc3RlbnMgcm91bmQgcml2ZXIgYmVuZWF0aCB0aGUgc3RhaXJzLCB3aGlsZSB0aGUgc3RlZXAgZ3JhbmFyeSBjbG9zZXMgYSBiYXNrZXQgb2YgYXBwbGVzLiBUaGUgbWlsbCB2aXNpdHMgdGhlIHRpZGUsIGFuZCB0aGUgc3R1ZGlvIHBhaW50cyBiZXNpZGUgdGhlIHN0YXRpb24uIFdlIGxpc3RlbnMgdGhlIHJvdWdoIGNvbXBhc3MgYXJvdW5kIHRoZSBtYXJrZXQgc3F1YXJlIGJlZm9yZSBhIHBvdCBvZiB0ZWEgY2FycmllcyByb3VnaC4ifV19LHsidHlwZSI6InNlcmllcy1ncmlkIiwidGl0bGUiOiJBIHllYXIgb2Ygc3RhciBjaGFydHMiLCJpdGVtcyI6W3sibGFiZWwiOiJzdGFyIGNoYXJ0cyBwYXJ0IDEiLCJocmVmIjoiYXJrbmV0ejovL3RyYWlucy1wb2V0cnkuYXJ0L3BhcnQtMSJ9LHsibGFiZWwiOiJzdGFyIGNoYXJ0cyBwYXJ0IDIiLCJocmVmIGJhbm5lciwgYW5kIHRoZSBncmFuYXJ5IHJlYWRzIGluIHRoZSByZWFkaW5nIHJvb20uIE1pbGwgbGlzdGVucyBwYXRpZW50IHJpdmVyIGFyb3VuZCB0aGUgbWFya2V0IHNxdWFyZSwgd2hpbGUgdGhlIHN0ZWVwIHN0dWRpbyB2aXNpdHMgYSBwb3Qgb2YgdGVhLiJ9XX1dLCJ2ZXJzaW9uIjoiMSIsInVwZGF0ZWQiOjE3OTQ4NzQ3MzV9eyJlbnRyaWVzIjpbeyJkb21haW4iOiJjb2RlLXRyYXZlbC5zaXRlIiwiYmFja2VuZCI6ImdoOmp1bGlhL2Fya25ldHotc2l0ZS1jb2RlLXRyYXZlbC1zaXRlIiwic2hhcmQiOiI3Iiwib3duZXIiOiJqdWxpYSJ9LHsiZG9tYWluIjoiYnJlYWQtd29ya3Nob3AuZXhhbXBsZSIsImJhY2tlbmQiOiJnaDpsYXJhL2Fya25ldHotc2l0ZS1icmVhZC13b3Jrc2hvcC1leGFtcGxlIiwic2hhcmQiOiJmIiwib3duZXIiOiJsYXJhIn0seyJkb21haW4iOiJwb2V0cnktYW5jaG9yLmluayIsImJhY2tlbmQiOiJnaDpib2IvYXJrbmV0ei1zaXRlLXBvZXRyeS1hbmNob3ItaW5rIiwic2hhcmQiOiJlIiwib3duZXIiOiJib2IifSx7YWluIjoidHJhdmVsLXBvZXRyeS5zaXRlIiwiYmFja2VuZCI6ImdoOm5pbmEvYXJrbmV0ei1zaXRlLXRyYXZlbC1wb2V0cnktc2l0ZSIsInNoYXJkIjoiZCIsIm93bmVyIjoibmluYSIsInVwZGF0ZWQiOjE3OTQyMDg1OTJ9LCJoaXN0b3J5LWxpYnJhcnkucHJlc3MiOnsiZG9tYWluIjoiaGlzdG9yeS1saWJyYXJ5LnByZXNzIiwiYmFja2VuZCI6ImdoOmVyaW4vYXJrbmV0ei1zaXRlLWhpc3RvcnktbGlicmFyeS1wcmVzcyIsIm1pcnJvcnMiOlsiY2I6ZXJpbi9hcmtuZXR6LXNpdGUtaGlzdG9yeS1saWJyYXJ5LXByZXNzLW1pcnJvciJdLCJzaGFyZCI6ImQiLCJvd25lciI6ImVyaW4iLCJ1cGRhdGVkIjoxNzk0MDAxMTY0fSwiaGlzdG9yeS1icmVhZC56aW5lIjp7ImRvbWFpbiI6Imhpc3RvcnktYnJlYWQuemluZSIsImJhY2tlbmQiOiJnaDp5dXN1Zi9hcmtuZXR6LXNpdGUtaGlzdG9yeS1icmVhZC16aW5lIiwibWlycm9ycyI6WyJnbDp5dXN1Zi9hcmtuZXR6LXNpdGUtaGlzdG9yeS1icmVhZC16aW5lLW1pcnJvciJdLCJzaGFyZCI6IjQiLCJvd25ldXJsIjoiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL1Byb3BUaGVSdFJldkRyU2lyU3RhbmxleUcwNS9wcm90b2NvbC1yb290L21haW4venN0ZC1kaWN0aW9uYXJ5LXYyLmJpbiIsInNoYTI1NiI6IjI2NjRhNWViMTA0ZGI4YzBmZjUxYjYzYWViZmJmYjc5MWY3ODQxZWZhMjg3ZGRmNzA4MDU4YWUzYzkxNzY1ZjMifX17ImRvbWFpbiI6InBob3Rvcy1yYWRpby5wcmVzcyIsImRheXMiOnsiMjAyNi0xMS0xNSI6eyJpbmRleCI6NDMsImFib3V0Ijo0fX0sInVwZGF0ZWQiOjE3OTQzNTczNTB9eyJtb250aCI6IjIwMjYtMTEiLCJwb2ludGVycyI6W3siZG9tYWluIjoiYnJlYWQtc3R1ZGlvLTI1NDgucHJlc3MiLCJwb3N0IjoicG9zdC0xIiwiYXQiOjE3OTQ1NzgwOTN9LHsiZG9tYWluIjoicGhvdG9zLXNjaWVuY2UuZXhhbXBsZSIsInBvc3QiOiJwb3N0LTIiLCJhdCI6MTc5NDYwODg5Nn0seyJkb21haW4iOiJzdHVkaW8tY3ljbGVzLmV4YW1wbGUiLCJwb3N0IjoicG9zdC0zIiwiYXQiOjE3OTQwNjE0NDV9XX17ImRvbWFpbiI6Im11c2ljIGhhcmJvdXIgd2FsbCwgd2hpbGUgdGhlIHdhcm0gc3R1ZGlvIG1lbmRzIHRoZSB0aWRlLiBXaWRlIGhhcmJvdXIgd2VsY29tZXMgYSBiYXNrZXQgb2YgYXBwbGVzIGJlbmVhdGggdGhlIHN0YWlycy4ifSx7InR5cGUiOiJoMSIsInRleHQiOiJXZSBjbG9zZXMgdGhlIGhvbGxvdyBsaWJyYXJ5IGFib3ZlIHRoZSBib2F0eWFyZCBiZWZvcmUgdGhlIG5ldyByb29mIHdhdGNoZXMgb2xkLiBUaGUgZ3JhbmFyeSB3YWxrcyB0aGUgb2xkIG1hcCwgYW5kIHRoZSBtaWxsIGJ1aWxkcyB1bmRlciB0aGUgYXBwbGUgdHJlZS4gQmluZGVyeSB3YWl0cyBzb2Z0IG1lYWRvdyBhY3Jvc3MgdGhlIG1lYWRvdywgd2hpbGUgdGhlIHBhdGllbnQgc3R1ZGlvIGNsb3NlcyB0aGUgbmV3IHJvb2YuIn1dLCJ2ZXJzaW9uIjoiMiIsInVwZGF0ZWQiOjE3OTQzODY1MTV9eyJkb21haW4iOiJmaWxtcy10cmF2ZWwtODQ3LmJsb2ciLCJ0aXRsZSI6Ik5vdGVzIG9uIG5vdGVib29rcyIsInRoZW1lIjp7ImxheW91dCI6InBvcnRmb2xpbyIsImFjY2VudCI6IiMxNTgwM2QiLCJmb250L2hpc3RvcnktcGhvdG9zL2tpdGNoZW4uanBnIiwiYWx0IjoibG9jYWwgaGlzdG9yeSIsImNhcHRpb24iOiJPYnNlcnZhdG9yeSB3YWxrcyBxdWlldCBnYXJkZW4gaW4gdGhlIHJlYWRpbmcgcm9vbSwgd2hpbGUgdGhlIGVhcmx5IHN0dWRpbyBwbGFudHMgYSBsZXR0ZXIuIFdlIHNpbmdzIHRoZSBjYWxtIG9yY2hhcmQgcGFzdCB0aGUgbWlsbCBwb25kIGJlZm9yZSB0aGUgZmVzdGl2YWwgYmFubmVyIGxpc3RlbnMgYnJpZ2h0LiBSb3VnaCBvYnNlcnZhdG9yeSBwbGFudHMgdGhlIGhhcnZlc3QgYnkgdGhlIGtpdGNoZW4gZG9vci4ifV19XSwidmVyc2lvbiI6IjEiLCJ1cGRhdGVkIjoxNzk0Njc2Njc5fXsiY2F0ZWdvcnkiOiJ0ZWNoIiwidmVyc2lvbiI6MSwidXBkYXRlZCI6MTc5NDQ5NzgwNSwiY2FyZHMiOlt7ImRvbWFpbiI6InBob3Rvcy1raXRjaGVuLmFydCIsInRpdGxlIjoiQSB5ZWFyIG9mIHRyYWlucyIsImRlc2NyaXB0aW9uIjoiV2Uga2VlcHMgdGhlIHJvdW5kIHJpdmVyIGFsb25nIHRoZSByaXZlciBiZWZvcmUgdGhlIGxhc3QgdHJhaW4gInRleHQiOiJTb2Z0IGZvcmVzdCBjbGVhbnMgdGhlIHNlZWQgb3JkZXIgYmVuZWF0aCB0aGUgc3RhaXJzLiBUaGUgdmluZXlhcmQgY291bnRzIHRoZSB0b29sIGNoZXN0LCBhbmQgdGhlIGJpbmRlcnkgd2Fsa3MgYWxvbmcgdGhlIGNsaWZmIHBhdGguIFdlIHJlYWRzIHRoZSB3aWRlIHRlYXJvb20gdW5kZXIgdGhlIGVhdmVzIGJlZm9yZSB0aGUgbW9ybmluZyB3ZWxjb21lcyBwbGFpbi4ifSx7InR5cGUiOiJoMiIsInRleHQiOiJXZSBjcm9zc2VzIHRoZSBnZW50bGUgY2hhcGVsIGluc2lkZSB0aGUgZ3JlZW5ob3VzZSBiZWZvcmUgYSBib3Jyb3dlZCBsYWRkZXIgY2xlYW5zIHJvdWdoLiBCYWtlcnkgY2FycmllcyBzaGFycCBmb3Jlc3QgYmV0d2VlbiB0aGUgdGFsbCBoZWRnZXMsIHdoaWxlIHRoZSBzaGFycCBiaWN5Y2xlIHZpc2l0cyBhIGxldHRlci4gVGhlIG1pbGwgZm9sbG93cyB0aGUgb2xkIG1hcCwgYW5kIHRoZSBtaWxsIHdyaXRlcyBhdCB0aGUgZW5kIG9mIHRoZSBsYW5lLiJ9LHsidHlwZSI6ImdhbGxlcnkiLCJpdGVtcyI6W3sic3JjIjoiY2sgcm9vbSwgd2hpbGUgdGhlIHF1aWV0IGtpdGNoZW4gYmFrZXMgdGhlIG9sZCBtYXAuIiwiY2F0ZWdvcnkiOiJmb29kIiwidGFncyI6WyJib29rcyIsImZpbG1zIiwiYnJlYWQiXSwidXBkYXRlZCI6MTc5NDYzMTA4OH0seyJkb21haW4iOiJsaWJyYXJ5LWhpc3Rvcnkuc2l0ZSIsInRpdGxlIjoiSG93IHRvIHN0YXJ0IHJpdmVycyIsImRlc2NyaXB0aW9uIjoiV2Ugc2luZ3MgdGhlIHByb3VkIGFyY2hpdmUgYmVoaW5kIHRoZSBjaGFwZWwgYmVmb3JlIHRoZSB3aW50ZXIgc3RvcmUgcGxhbnRzIGVhcmx5LiBUaGUgb2JzZXJ2YXRvcnkgd2F0Y2hlcyB0aGUgcGFyaXNoIHJlY29yZHMsIGFuZCB0aGUgYm9hdHlhcmQgbWVldHMgaW5zaWRlIHRoZSBncmVlbmhvdXNlLiBXZSBtZWV0cyB0aGUgd2FybSBiaW5kZXJ5IG9uIHRoZSB0b3Agc2hlbGYgYmVmb3JlIHRoZSBwYXJpc2ggcmVjb3JkcyBzaW5ncyBsYXRlLiIsImNhdGVnb3J5IjoiZm9vZCIsInRhZ3MiOlsic3R1ZGlvIiwidHJhaW5zIiwiaGFuZCB0b29scyJdLCJ1cGRhdGVkIjoxNzk0NTU1OTM3IHN0YWlycywgd2hpbGUgdGhlIHNsb3cgZmVycnkgY2xvc2VzIHRoZSBmaXJzdCBsaWdodC4ifV0sIm1vZGVyYXRpb25Mb2ciOltdLCJpc3N1ZU51bWJlciI6MjF9XX17Im93bmVyIjoic2FtIiwicm9sZXMiOnsibWFuYWdpbmdfZWRpdG9yIjpbInBhZ2VzLndyaXRlIiwicGFnZXMucHVibGlzaCIsIm1lZGlhLnVwbG9hZCIsIm1haWwucmVhZCIsIm1haWwuc2VuZCJdLCJ3cml0ZXIiOlsicGFnZXMuZHJhZnQiLCJtZWRpYS51cGxvYWQiXX0sIm1lbWJlcnMiOnsidmVyYSI6eyJyb2xlIjoibWFuYWdpbmdfZWRpdG9yIn0sImRhdmUiOnsicm9sZSI6IndyaXRlciIsImFsbG93ZWRfcGF0aHMiOlsiYmxvZy8qIl19fX17InBhdGNoZXMiOlt7InRhcmdldCI6ImdhbWVzLW1lYWRvdy5lZHUiLCJhY3Rpb24iOiJiYW5fZG9tYWluIiwicmVhc29uIjoic3BhbSIsImJ5IjoiUHJvcFRoZVJ0UmV2RHJTaXJTdGFubGV5RzA1IiwiYXQiOjE3OTQ0NzAzOTl9XX17ImRvbWFpbiI6ImdhbWVzLXN0YXJzLnByZXNzIiwidGl0bGUiOiJTbWFsbCBoYW5kIHRvb2xzIiwieW91dCI6InBvcnRmb2xpbyIsImFjY2VudCI6IiMyNTYzZWIiLCJmb250IjoiR2VvcmdpYSwgc2VyaWYifSwibmF2IjpbeyJsYWJlbCI6IkhvbWUiLCJocmVmIjoiYXJrbmV0ejovL2xpYnJhcnktZ2FtZXMucHJlc3MifSx7ImxhYmVsIjoiQWJvdXQiLCJocmVmIjoiYXJrbmV0ejovL2xpYnJhcnktZ2FtZXMucHJlc3MvYWJvdXQifSx7ImxhYmVsIjoiUG9zdHMiLCJocmVmIjoiYXJrbmV0ejovL2xpYnJhcnktZ2FtZXMucHJlc3MvcG9zdHMifV0sImJsb2NrcyI6W3sidHlwZSI6Imhlcm8iLCJ0aXRsZSI6IlRoZSBiaWN5Y2xlIHJlcGFpciIsInN1YnRpdGxlIjoiVGhlIGNvbXBhc3MgcGxhbnRzIHRoZSBwYXJpc2ggcmVjb3JkcywgYW5kIHRoZSBiYWtlcnkgY2FycmllcyB1bmRlciB0aGUgZWF2ZXMuIFRoZSBsaWJyYXJ5IHNpbmdzIHRoZSB0b29sIGNoZXN0LCBhbmQgdGhlIGFyY2hpdmUgb3BlbnMgYmV0d2VlbiB0aGUgdGFsbCBoZWRnZXMuIFRoZSBzdHVkaW8gdmlzaXRzIHRoZSBsYXN0IHRyYWluLCBhbmQgdGhlIG9yY2hhcmQgcmVhZHMgbmVheGFtcGxlIjp7ImRvbWFpbiI6InRyYWlucy1jb2RlLmV4YW1wbGUiLCJiYWNrZW5kIjoiZ2g6ZGF2ZS9hcmtuZXR6LXNpdGUtdHJhaW5zLWNvZGUtZXhhbXBsZSIsInNoYXJkIjoiOCIsIm93bmVyIjoiZGF2ZSIsInVwZGF0ZWQiOjE3OTQxNDEwMTV9LCJyaXZlcnMtcml2ZXJzLmJsb2ciOnsiZG9tYWluIjoicml2ZXJzLXJpdmVycy5ibG9nIiwiYmFja2VuZCI6ImdoOndhbHQvYXJrbmV0ei1zaXRlLXJpdmVycy1yaXZlcnMtYmxvZyIsInNoYXJkIjoiNSIsIm93bmVyIjoid2FsdCIsInVwZGF0ZWQiOjE3OTQ2NjIyMDl9LCJjcmFmdC1saWJyYXJ5LmVkdSI6eyJkb21haW4iOiJjcmFmdC1saWJyYXJ5LmVkdSIsImJhY2tlbmQiOiJnaDp1bWFyL2Fya25ldHotc2l0ZS1jcmFmdC1saWJyYXJ5LWVkdSIsInNoYXJkIjoiZiIsIm93bmVyIjoidW1hciIsInVwZGF0ZWQiOjE3OTQ4MDM2ODR9fXsibW9udGgiOiIyMDI2LTExIiwicG9pbnRlcnMiOlt7ImRvbWFpbiI6InN0dWRpby1jeWNsZXMuaW5rIiwicG9zdCI6InBvc3QtMSIsImF0IjoxNzk0MTQ0MDcwZS1tZWFkb3ctZXhhbXBsZS1taXJyb3IiXSwic2hhcmQiOiIwIiwib3duZXIiOiJvbWFyIiwidXBkYXRlZCI6MTc5NDcwMTY3Nn0sInN0dWRpby1oYXJ2ZXN0LmFydCI6eyJkb21haW4iOiJzdHVkaW8taGFydmVzdC5hcnQiLCJiYWNrZW5kIjoiZ2g6cm9zYS9hcmtuZXR6LXNpdGUtc3R1ZGlvLWhhcnZlc3QtYXJ0Iiwic2hhcmQiOiJjIiwib3duZXIiOiJyb3NhIiwidXBkYXRlZCI6MTc5NDc4OTgxOX19Im1lc3NhZ2VJZCI6ImFuY2hvci1icmVhZC5leGFtcGxlIiwicHJvdG9jb2xWZXJzaW9uIjoiMC4xLjAiInR5cGUiOiJxdW90ZSIsInRleHQiOiJnYXJkZW4tYW5jaG9yIiwidGFncyI6WyIiZG9tYWluIjoibGFudGVybi13b3Jrc2hvcC5leGFtcGxlIiwidHlwZSI6ImFwcCIsIm5hbWUiOiJzdHVkaW8tc3R1ZGlvLnppbmUiLCJib2R5IjoiZ2FtZXMtY3ljbGVzLmV4YW1wbGUiLCJwcm90b2NvbFZlcnNpb24iOiIwLjEuMCIiYWx0IjoiZ2FtZXMtY3ljbGVzLmVkdSIsInR5cGUiOiJjYXJkcyIsIml0ZW1zIjoiY29va2luZy1jb21wYXNzLmVkdSIsLmFydCIsImJhY2tlbmQiOiJnaDp2ZXJhL2Fya25ldHotc2l0ZS1zdGFycy1tdXNpYy1hcnQiLCJzaGFyZCI6IjEiLCJvd25lciI6InZlcmEiLCJ1cGRhdGVkIjoxNzk0MDIxMDU5fSwiY3ljbGVzLWhhcmJvdXIuemluZSI6eyJkb21haW4iOiJjeWNsZXMtaGFyYm91ci56aW5lIiwiYmFja2VuZCI6ImdoOmZyYW5rL2Fya25ldHotc2l0ZS1jeWNsZXMtaGFyYm91ci16aW5lIiwic2hhcmQiOiI2Iiwib3duZXIiOiJmcmFuayIsInVwZGF0ZWQiOjE3OTQxMTExMzZ9fXsiY2F0ZWdvcnkiOiJjb2RlIiwidmVyc2lvbiI6MSwidXBkYXRlZCI6MTc5NDY4MDkzMiwiY2FyZHMiOlt7ImRvbWFpbiI6ImtpdGNoZW4tY3JhZnQuYmxvZyIsInRpdGxlIjoiV2Fsa2luZyB3aXRoIHN0YXIgY2hhcnRzIiwiZGVzY3JpcHRpb24iOiJUaGUgb3JjaGFyZCB0ZW5kcyB0aGUgcGFyaXNoIHJlY29yZHMsIGFuZCB0aGUgbWFya2V0IGtlZXBzIGFyb3VuZCB0aGUgbWFya2V0IHNxdWFyZS4gVGhlIHZpbmV5YXJkIGZvbGxvd3MgdGhlIG5ldyByb29mLCBhbmQgdGhlIGxhbnRlZW4gZG9vciwgd2hpbGUgdGhlIGNhbG0gZ3JhbmFyeSB3YWl0cyB0aGUgZXZlbmluZyBiZWxsLiBSb3VnaCBxdWF5IGxpc3RlbnMgdGhlIG5ldyByb29mIG9uIHRoZSB0b3Agc2hlbGYuIn0seyJ0eXBlIjoibGluayIsImxhYmVsIjoiU2VlZCBjYXRhbG9ndWUiLCJocmVmIjoiaHR0cHM6Ly9hcmNoaXZlLm9yZy9kb3dubG9hZC9leGFtcGxlL2ZpbGUuanBnIn1dLCJ2ZXJzaW9uIjoiMiIsInVwZGF0ZWQiOjE3OTQzNTAxNDl9eyJ0aHJlYWRzIjpbeyJpZCI6InRocmVhZC0wMDc0IiwiZG9tYWluIjoiY29tcGFzcy10cmFpbnMuZXhhbXBsZSIsInBhZ2VQYXRoIjoiaW5kZXgiLCJ0aXRsZSI6IkxldHRlcnMgZnJvbSB3b29kd29yayIsImxvY2tlZCI6ZmFsc2UsImNvbW1lbnRzIjpbeyJpZCI6ImMxIiwiYXV0aG9yIjoianVsaWEiLCJjcmVhdGVkQXQiOjE3OTQ4Mzk1MTYsImJvZHkiOiJUaGUgb3JjaGFyZCBjbG9zZXMgdGhlIGV2ZW5pbmcgYmVsbCwgYW5kIHRoZSBtYXJrZXQgbGlzdGVucyBhY3Jvc3MgdGhlIG1lYWRvdy4gVGhlIGxpYnJhcnkgbGlzZXIgcm9hZCwgYW5kIHRoZSBnYXJkZW4gdGVuZHMgYWxvbmcgdGhlIHJpdmVyLiBXZSBidWlsZHMgdGhlIGNhbG0gZm9yZXN0IGFjcm9zcyB0aGUgbWVhZG93IGJlZm9yZSB0aGUgc2VlZCBvcmRlciBvcGVucyBzdHVyZHkuIn1dfV0sInZlcnNpb24iOiIyIiwidXBkYXRlZCI6MTc5NDMwNDQ3Mn17InZlcnNpb24iOjEsIm1lc3NhZ2VJZCI6Im1haWwtMmMwOGI0MGEtMTc5NDg2NDAzMi15dXN1ZiIsInRocmVhZElkIjoidGhyZWFkLWJhYmE1ODhiIiwiZnJvbSI6eyJuYW1lIjoieXVzdWYgRXhhbXBsZSIsImFkZHJlc3MiOiJ5dXN1ZkBleGFtcGxlLmNvbSJ9LCJyZWNpcGllbnRzIjpbeyJuYW1lIjoic2FtIEV4YW1wbGUiLCJhZGRyZXNzIjoic2FtQGV4YW1wbGUuY29tIn1dLCJzZW50QXQiOjE3OTQwODk0NzcwMDAsIml2QjY0IjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9Edz09IiwiY2lwaGVydGV4dEI2NCI6IlUyVmpjbVYwSUcxbGMzTmhaMlVnWTI5dWRHVnVkQ0JsYm1OeWVYQjBaV1FnZDJsMGFDQkJSVk10UjBOTkxnPT0iLCJ3cmFwcGVkS2V5cyI6b2YgamFycywgYW5kIHRoZSBjb21wYXNzIHdyaXRlcyBiZXR3ZWVuIHRoZSB0YWxsIGhlZGdlcy4gVGhlIG1lYWRvdyByZXBhaXJzIHRoZSBoYXJ2ZXN0LCBhbmQgdGhlIHdvcmtzaG9wIHBhaW50cyBpbiB0aGUgYmFjayByb29tLiJ9LHsidHlwZSI6ImgzIiwidGV4dCI6Ik9sZCB2aW5leWFyZCBwYWludHMgYSBzaGVsZiBvZiBqYXJzIGFsb25nIHRoZSBjbGlmZiBwYXRoLiBXZSBjb3VudHMgdGhlIHRhbGwgb2JzZXJ2YXRvcnkgYmVoaW5kIHRoZSBjaGFwZWwgYmVmb3JlIHRoZSB3aW50ZXIgc3RvcmUgdGVuZHMgcm91Z2guIFRoZSBiaW5kZXJ5IHdlbGNvbWVzIGEgbGV0dGVyLCBhbmQgdGhlIGJyaWRnZSBvcGVucyBiZXNpZGUgdGhlIHN0YXRpb24uIn0seyJ0eXBlIjoiaDIiLCJ0ZXh0IjoiVGhlIGhhcmJvdXIgdGVuZHMgYSBiYXNrZXQgb2YgYXBwbGVzLCBhbmQgdGhlIHF1YXkgd2F0Y2hlcyBiZWhpbmQgdGhlIGNoYXBlbC4gUXVheSBrZWVwcyBwbGFpbiBoYXJib3VyIGluc2lkZSB0aGUgZ3JlZW5ob3VzZSwgd2hpbGUgdGhlIHN3ZWV0IGtpZSBzdGF0aW9uIGJlZm9yZSBhIGxldHRlciB0ZWFjaGVzIHBsYWluLiBXaWRlIGtpdGNoZW4gb3BlbnMgYSBib3Jyb3dlZCBsYWRkZXIgYmV0d2VlbiB0aGUgdGFsbCBoZWRnZXMuIFdlIHdhbGtzIHRoZSBzbG93IGxhbnRlcm4gaW4gdGhlIGJhY2sgcm9vbSBiZWZvcmUgdGhlIHBhcmlzaCByZWNvcmRzIHJlcGFpcnMgaG9sbG93LiJdLFsicCIsIlRoZSBvYnNlcnZhdG9yeSBidWlsZHMgdGhlIHNlZWQgb3JkZXIsIGFuZCB0aGUgbWVhZG93IHdhaXRzIHVuZGVyIHRoZSBhcHBsZSB0cmVlLiBUaGUgd29ya3Nob3AgYnVpbGRzIHRoZSBzZWVkIG9yZGVyLCBhbmQgdGhlIGdyZWVuaG91c2UgcmVwYWlycyBhbG9uZyB0aGUgY2xpZmYgcGF0aC4gUm91Z2ggd29ya3Nob3AgY2FycmllcyB0aGUgdG9vbCBjaGVzdCBiZW5lYXRoIHRoZSBzdGFpcnMuIl1dfSx7ImlkIjoicG9zdC0yIiwidCI6IlRoZSBwaG90b2dyYXBocyIsImQiOjE3OTQyNTcxMzcsImIiOltbInAiLCJUaGUgaGFyYm91ciB3ZWxjb21lcyB0aGUgbGFzdCB0cmFpbiwgYW5kIHRoZSBvYnNlcm90b2NvbFZlcnNpb24iOiIwLjEuMCIsImRlZmF1bHRSb290UmVwbyI6IlByb3BUaGVSdFJldkRyU2lyU3RhbmxleUcwNS9wcm90b2NvbC1yb290IiwibWFzdGVyR2l0aHViVXNlciI6IlByb3BUaGVSdFJldkRyU2lyU3RhbmxleUcwNSIsInJlZ2lzdHJ5U2hhcmRzIjpbImFya25ldHotcmVnaXN0cnktMDAiLCJhcmtuZXR6LXJlZ2lzdHJ5LTAxIiwiYXJrbmV0ei1yZWdpc3RyeS0wZiJdLCJjb250YWN0c1NoYXJkcyI6WyJhcmtuZXR6LWNvbnRhY3RzLTAwIiwiYXJrbmV0ei1jb250YWN0cy0wMSIsImFya25ldHotY29udGFjdHMtMGYiXSwiZGlyZWN0b3J5Q2F0ZWdvcmllcyI6WyJ0ZWNoIiwiY2luZW1hIiwiZ2FtZXMiLCJtdXNpYyIsInRyYXZlbCIsImZvb2QiLCJnYXJkZW4iLCJjb2RlIl0sIm1pcnJvcnMiOlsiZ2w6UHJvcFRoZVJ0UmV2RHJTaXJTdGFubGV5RzA1L3Byb3RvY29sLXJvb3QiLCJjYjpQcm9wVGhlUnRSZXZEclNpclN0YW5sZXlHMDUvcHJvdG9jb2wtcm9vdCJdLCJ6c3RkRGljdGlvbmFyeSI6eyJ2ZXJzaW9uIjoyLCJ1cmwiOiJobmcgdGhlIHJpdmVyLiBMb25lbHkgZ2FyZGVuIGxpZ2h0cyBhIGxldHRlciBvdmVyIHRoZSBoYXJib3VyIHdhbGwuIFF1aWV0IGJha2VyeSBsaWdodHMgdGhlIGhhcnZlc3QgYWxvbmcgdGhlIGNsaWZmIHBhdGguIl0sWyJwIiwiV29ya3Nob3AgbWVldHMgbWVycnkgbGlicmFyeSB1bmRlciB0aGUgZWF2ZXMsIHdoaWxlIHRoZSBidXN5IG9yY2hhcmQgdmlzaXRzIHRoZSByaXZlciByb2FkLiBQbGFpbiBjaGFwZWwgdmlzaXRzIHRoZSByaXZlciByb2FkIGJ5IHRoZSBraXRjaGVuIGRvb3IuIEdyYW5hcnkgdGVhY2hlcyBidXN5IGFyY2hpdmUgYmVzaWRlIHRoZSBzdGF0aW9uLCB3aGlsZSB0aGUgc3R1cmR5IGJpY3ljbGUgdGVhY2hlcyB0aGUgZmVzdGl2YWwgYmFubmVyLiJdXX1dfXsiZG9tYWluIjoicml2ZXJzLXN0dWRpby5zaXRlIiwidGl0bGUiOiJFdmVyeWRheSBub3RlYm9va3MiLCJ0aGVtZSI6eyJsYXlvdXQiOiJibG9nIiwiYWNjZW50IjoiIzBlNzQ5MCIsImZvbnQiOiJzeXN0ZW0tdWkifSwibmF2IjpbeyJsYWJlbCI6IkhvbWUiLCJocmVmMDAuc2l0ZSJ9LHsibGFiZWwiOiJBYm91dCIsImhyZWYiOiJhcmtuZXR6Oi8vY29kZS10cmF2ZWwtNzAwLnNpdGUvYWJvdXQifV0sImJsb2NrcyI6W3sidHlwZSI6Imhlcm8iLCJ0aXRsZSI6IlRoZSBxdWlldCBhcnQgb2YgZmVybWVudGF0aW9uIiwic3VidGl0bGUiOiJXZSBnYXRoZXJzIHRoZSBsb25lbHkgb2JzZXJ2YXRvcnkgdW5kZXIgdGhlIGFwcGxlIHRyZWUgYmVmb3JlIHRoZSBldmVuaW5nIGJlbGwgcGxhbnRzIHByb3VkLiBXZSB0ZWFjaGVzIHRoZSBjYWxtIGdyZWVuaG91c2UgaW4gdGhlIHJlYWRpbmcgcm9vbSBiZWZvcmUgdGhlIHN1bW1lciByYWluIHdlbGNvbWVzIHJvdW5kLiBCcmlnaHQgbWlsbCB3cml0ZXMgdGhlIG9sZCBtYXAgYmVoaW5kIHRoZSBjaGFwZWwuIn0seyJ0eXBlIjoicCIsInRleHQiOiJGb3Jlc3QgY2xlYW5zIGVhcmx5IGJpbmRlcnkgYXQgdGhlIGVuZCBvZiB0aGUgbGFuZSwgd2hpbGUgdGhlIHNtYWxsIGFyY2hpdmUgY2xlYW5zIGEgYmFza2V0IG9mIGFwcGxlcy4gU2hhcnAgdmluZXlhcmQgcGxhbnRzIHRoZSBvZHMgdGhlIG1vcm5pbmcsIGFuZCB0aGUgdGVhcm9vbSB3YWl0cyBvbiB0aGUgdG9wIHNoZWxmLiBHZW50bGUgbWVhZG93IHJlYWRzIHRoZSBmaXJzdCBsaWdodCBwYXN0IHRoZSBtaWxsIHBvbmQuIn0seyJ0eXBlIjoiY29kZSIsImxhbmd1YWdlIjoidGV4dCIsInRleHQiOiJhcmtuZXR6Oi8vYm9va3MtY29va2luZy5zaXRlXG5yZWdpc3RyeSBzaGFyZDogU0hBMjU2KGRvbWFpbilbMF0ifSx7InR5cGUiOiJpbWciLCJzcmMiOiJodHRwczovL2FyY2hpdmUub3JnL2Rvd25sb2FkL3JhZGlvLXBob3Rvcy9jb21wYXNzLmpwZyIsImFsdCI6IkEgcGhvdG9ncmFwaCBvZiB0ZWEiLCJjYXB0aW9uIjoiV2UgY3Jvc3NlcyB0aGUgd2FybSBtYXJrZXQgYWxvbmcgdGhlIHJpdmVyIGJlZm9yZSB0aGUgcGFyaXNoIHJlY29yZHMgY2xvc2VzIGdlbnRsZS4gUm91Z2ggbWFya2V0IHJlbWVtYmVycyB0aGUgbmV3IHJvb2YgaW4gdGhlIGJhY2sgcm9vbS4gV2UgcGFpbnRzIHRoZSBzbG93IHN0YXRpb24gYWNyb3NzIHRoZSBtZWFkb3cgYmVmb3JlIHRoZSB0aWRlIG1lLmFydCI6eyJkaXNwbGF5TmFtZSI6IkhlbnJ5IEV4YW1wbGUiLCJjb250YWN0QWRkcmVzcyI6ImhlbnJ5QGNvb2tpbmctc3R1ZGlvLmFydCIsImZpbmdlcnByaW50IjoiMTNiMzI5NDQzMDQxYmQ1OTljZDUyYjg4MzRiZjg4MjljNDI0Yzc5MyIsInB1YmxpY0tleUI2NCI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE9IiwicmVsYXlzIjpbImdoOmhlbnJ5L2Fya25ldHotbWFpbCJdLCJ1cGRhdGVkIjoxNzk0Nzc0MTQyfX17ImVudHJpZXMiOlt7ImRvbWFpbiI6InNjaWVuY2UtaGFyYm91ci5wcmVzcyIsImJhY2tlbmQiOiJnaDp1bWFyL2Fya25ldHotc2l0ZS1zY2llbmNlLWhhcmJvdXItcHJlc3MiLCJzaGFyZCI6ImUiLCJvd25lciI6InVtYXIifSx7ImRvbWFpbiI6ImdhbWVzLWZpbG1zLmluayIsImJhY2tlbmQiOiJnaDp6b2UvYXJrbmV0ei1zaXRlLWdhbWVzLWZpbG1zLWluayIsInNoYXJkIjoiNSIsIm93bmVyIjoiem9lIn0seyJkb21haW4iOiJoYXJib3VyLXJhZGlvLnNpdGUiLCJiYWNrZW5kIjoiZ2g6bWlrYW5kIHRoZSBzdGF0aW9uIGNsZWFucyBhcm91bmQgdGhlIG1hcmtldCBzcXVhcmUuIFNvZnQgbm90ZWJvb2sgbWVuZHMgYSBwb3Qgb2YgdGVhIG92ZXIgdGhlIGhhcmJvdXIgd2FsbC4ifV0sInZlcnNpb24iOiIxIiwidXBkYXRlZCI6MTc5NDI3NzA5OH17ImNhdGVnb3J5IjoiZ2FyZGVuIiwidmVyc2lvbiI6MSwidXBkYXRlZCI6MTc5NDY0NjM3OCwiY2FyZHMiOlt7ImRvbWFpbiI6ImNvbXBhc3MtdHJhaW5zLmV4YW1wbGUiLCJ0aXRsZSI6IkEgZmllbGQgZ3VpZGUgdG8gbWFwcyIsImRlc2NyaXB0aW9uIjoiUXVheSB3cml0ZXMgbmFycm93IG1pbGwgYWJvdmUgdGhlIGJvYXR5YXJkLCB3aGlsZSB0aGUgc3R1cmR5IG9yY2hhcmQgZ2F0aGVycyB0aGUgc3VtbWVyIHJhaW4uIFRoZSBncmVlbmhvdXM=";

/** The current dictionary: version, label, and ID of the dictionary
 *  old files were written with. DEPRECATED 2026-11-21 (Stanley's
 *  decision, benchmark BENCHMARK-0.4.0.md): the v2 dictionary saves
 *  ZERO bytes on every payload tested, so new files are plain zstd
 *  and no longer carry a dictionary ID. These constants now name the
 *  LEGACY decode dictionary (v2) — retained, with v1, so frames
 *  already published on GitHub still decode via decompressBytes.
 *  Do NOT use them to write new files. */
export const ZSTD_DICTIONARY_CURRENT_VERSION = ZSTD_DICTIONARY_V2_VERSION;
export const ZSTD_DICTIONARY_CURRENT_LABEL = ZSTD_DICTIONARY_V2_LABEL;
export const ZSTD_DICTIONARY_CURRENT_ID = ZSTD_DICTIONARY_V2_ID;

/** Decode base64 to bytes (atob exists in browsers and in Node 16+). */
function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let cachedDictionaryV2: Uint8Array | null = null;

/** The trained v2 dictionary bytes. Callers MUST NOT mutate the
 *  returned bytes. */
export function getZstdDictionaryV2(): Uint8Array {
  if (!cachedDictionaryV2) {
    cachedDictionaryV2 = base64ToBytes(ZSTD_DICTIONARY_V2_BASE64);
  }
  return cachedDictionaryV2;
}

/** The legacy decode dictionary (v2) — what OLD files were written
 *  with. DEPRECATED 2026-11-21: new files are plain zstd (see
 *  compressBytes). Kept so decompressBytes can still read published
 *  v2 frames. */
export function getCurrentZstdDictionary(): Uint8Array {
  return getZstdDictionaryV2();
}

/** For tests: forget the cached v2 dictionary. */
export function resetZstdDictionaryV2ForTests(): void {
  cachedDictionaryV2 = null;
}

// ---------------------------------------------------------------------------
// Compression / decompression — plain zstd for new files since
// 2026-11-21 (dictionary dropped); dictionaries kept for decoding
// old published frames only.
// ---------------------------------------------------------------------------

/** Compress with an explicit dictionary (formatted bytes, e.g. from
 *  buildFormattedZstdDictionary, or a raw-content dictionary). The
 *  context is created and freed per call. LEGACY: only used to build
 *  old-format fixtures in tests and to read old files — new files
 *  are plain zstd (see compressBytes). */
export async function compressBytesWithDictionary(
  data: Uint8Array,
  dictionary: Uint8Array,
  level = 3,
): Promise<Uint8Array> {
  const engine = await getZstdEngine();
  const cctx = engine.createCCtx();
  try {
    return engine.compressUsingDict(cctx, data, dictionary, level);
  } finally {
    engine.freeCCtx(cctx);
  }
}

/** Decompress with an explicit dictionary. Throws loudly — never
 *  silently returns garbage — when the frame needs a different
 *  dictionary (wrong ID), no dictionary (plain decompress of a
 *  dict-compressed frame), or the data is corrupt or truncated.
 *  Frames compressed WITHOUT a dictionary still decompress fine here:
 *  a frame with no dictionary ID simply does not use the dictionary. */
export async function decompressBytesWithDictionary(
  data: Uint8Array,
  dictionary: Uint8Array,
): Promise<Uint8Array> {
  if (!isZstdFrame(data)) {
    throw new Error("not Zstd data (missing 0xFD2FB528 frame magic) — refusing to decompress");
  }
  const engine = await getZstdEngine();
  const dctx = engine.createDCtx();
  try {
    return engine.decompressUsingDict(dctx, data, dictionary);
  } catch (err) {
    throw new Error(
      `Zstd decompression failed: ${err instanceof Error ? err.message : String(err)} — the file is corrupt, truncated, or was compressed with a different dictionary`,
    );
  } finally {
    engine.freeDCtx(dctx);
  }
}

/** Compress with PLAIN zstd (no dictionary) — the only compression
 *  new files use since 2026-11-21. The v2 dictionary was dropped by
 *  Stanley's decision that day: the benchmark (BENCHMARK-0.4.0.md)
 *  proved it saves ZERO bytes on every payload tested (registry
 *  0/100/1000/4096 entries, 50 KB site, demo site), and plain zstd
 *  keeps every measured win (39–320x). Frames written here carry NO
 *  dictionary ID. Old dictionary frames still decode — see
 *  decompressBytes, which tries v2, then v1, then plain. */
export async function compressBytes(data: Uint8Array, level = 3): Promise<Uint8Array> {
  const engine = await getZstdEngine();
  return engine.compress(data, level);
}

/** Decompress with no dictionary at all (plain frames only). A
 *  dictionary frame throws here — that is the point: callers that
 *  know which dictionary a file used should use
 *  decompressBytesWithDictionary instead. */
export async function decompressBytesPlain(data: Uint8Array): Promise<Uint8Array> {
  if (!isZstdFrame(data)) {
    throw new Error("not Zstd data (missing 0xFD2FB528 frame magic) — refusing to decompress");
  }
  const engine = await getZstdEngine();
  try {
    return engine.decompress(data);
  } catch (err) {
    throw new Error(
      `Zstd decompression failed: ${err instanceof Error ? err.message : String(err)} — the file is corrupt, truncated, or was compressed with a dictionary`,
    );
  }
}

/** Decompress, trying each dictionary the client knows, newest first,
 *  then a plain decompress. A frame compressed with a dictionary the
 *  client does NOT know still throws loudly (never silently returns
 *  garbage): every attempt fails on the ID mismatch, and the final
 *  error names both known dictionaries. A frame compressed with NO
 *  dictionary (the pre-dictionary format) still decompresses fine, so
 *  old cached .zst files keep working. */
export async function decompressBytes(data: Uint8Array): Promise<Uint8Array> {
  const attempts: Array<{ label: string; run: () => Promise<Uint8Array> }> = [
    { label: ZSTD_DICTIONARY_V2_LABEL, run: () => decompressBytesWithDictionary(data, getZstdDictionaryV2()) },
    { label: ZSTD_DICTIONARY_LABEL, run: () => decompressBytesWithDictionary(data, getZstdDictionary()) },
    { label: "no dictionary", run: () => decompressBytesPlain(data) },
  ];
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt.run();
    } catch (err) {
      failures.push(`${attempt.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Zstd decompression failed with every known dictionary (v2 ${ZSTD_DICTIONARY_V2_LABEL} id 0x${ZSTD_DICTIONARY_V2_ID.toString(16)}, v1 ${ZSTD_DICTIONARY_LABEL} id 0x${ZSTD_DICTIONARY_ID.toString(16)}) and without a dictionary — the file is corrupt, truncated, or was compressed with an unknown dictionary. Failures: ${failures.join(" | ")}`,
  );
}

export async function compressJson(value: unknown): Promise<Uint8Array> {
  const json = JSON.stringify(value);
  return compressBytes(new TextEncoder().encode(json));
}

export async function decompressJson(data: Uint8Array): Promise<unknown> {
  const bytes = await decompressBytes(data);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("decompressed Zstd payload is not valid JSON — the file is corrupt");
  }
}

/** Compression ratio as a percentage of the original size (lower is
 *  smaller). A repetitive site.json should compress to well under half. */
export function compressionRatio(originalBytes: number, compressedBytes: number): number {
  if (originalBytes === 0) return 0;
  return Math.round((compressedBytes / originalBytes) * 100);
}
