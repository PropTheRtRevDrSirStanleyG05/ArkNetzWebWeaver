# Zstd dictionary v2 — training record (fix round 3, item 3)

## What v2 is

A genuinely **trained** dictionary, built with the real zstd trainer
(`zstd --train`, zstd CLI 1.5.5, installed via `apt install zstd` —
it was NOT installed before this round).

- **Dictionary:** `zstd-dictionary-v2.bin`, **32,768 bytes** (the
  thread's ~32 KB), formatted per RFC 8878 §5.
- **ID:** `0x41524B02` ("ARK\x02") — a new ID, so a v2 frame read by a
  v1 client fails loudly instead of silently mis-decoding.
- **SHA-256:** `a1786956c8f9b919c393ba27347213c8db48a283615b23bfe03582f92544c96d`
  (pinned in `src/lib/zstd.ts` and by test).
- **Label:** `v2-trained`.
- **Training command** (exact, see `train.sh`):
  `zstd --train --maxdict=32768 --dictID=1095912194 -o zstd-dictionary-v2.bin corpus/*.json`
  (`--dictID` takes decimal; 1095912194 = 0x41524B02. An earlier
  attempt used the wrong decimal 1095918082 and produced ID
  0x41526202 — caught by the header check in `embed-dict-v2.mjs` and
  retrained.)
- **Trainer algorithm:** fastcover with zstd's defaults (the first run reported k=1511, d=8, f=20, steps=4,
  split=75, accel=1 (fastcover).

## Corpus

- **Generator:** `generate-corpus.mjs` — deterministic (seeded PRNG),
  so re-running it regenerates the exact same corpus.
- **3,400 files, ~2 MB total** (corpus/): registry shards (map +
  entries-array forms), site documents (every block type), directory
  shards, contacts shards, mail envelopes + plaintext, comments,
  posts, protocol manifests (including the new `directoryCategories`
  field), team, stats, feed pointers, delegations, moderation, plus
  200 structural-fragment files (dense JSON key patterns with varied
  values). That is ~60x the dictionary size — above zstd's 10x minimum
  (the first attempt, 320 files / 186 KB, was only 5.7x and drew a
  trainer warning, so the corpus was scaled 10x and retrained).
- Prose is generated combinatorially (templates + vocabulary), so
  almost every sentence is unique — like real user prose. The first
  corpus reused a dozen fixed sentences, which the trainer memorised
  verbatim; the retrained dictionary then lost to v1 on any held-out
  document. With unique sentences, the only frequent substrings are
  the JSON structure, backend/URL shapes, and common English words —
  which is what a dictionary for `.json.zst` files should learn.
- Every file is compact JSON, exactly as `JSON.stringify` produces
  for real `.json.zst` files (fragment files are raw pattern text).
  All values are invented sample data.

## Measured compression (CLI, level 3, one file of each kind)

| file | raw | plain zstd | v2 dict | v2 vs plain |
|---|---|---|---|---|
| registry-map | 607 | 240 | 141 | −41% |
| site | 2105 | 969 | 448 | −54% |
| directory | 1681 | 776 | 383 | −51% |
| contacts | 1087 | 399 | 264 | −34% |
| mail-envelope | 594 | 369 | 122 | −67% |

(The app's own test battery measures the same comparison through the
in-app engine; see `tests/zstd-dict-v2.test.ts`. Aggregate in-app
measurement on 100 sampled corpus files (104,600 raw bytes): plain
48,227, v1 36,962, **v2 22,769** — v2 wins on all 100 files. Held-out
documents (nothing in them appears in the corpus): novel registry v2
104 vs v1 139, novel mail v2 184 vs v1 208 — v2 wins. Honest
exceptions: on long-prose site documents v1 still wins (held-out
harbour site: v1 497 vs v2 574, plain 711; the demo site: v1 152 vs
v2 619, because the demo site's text is verbatim inside v1's
hand-built content — pure overfit, not a fair comparison). v1 wins
those shapes because its content repeats the JSON structural
fragments with a density no trainer reproduced: tripling the fragment
share and switching to the cover algorithm were both tried and
changed nothing on held-out docs (cover: harbour 604, demo 643, mail
201, registry 68 — worse than fastcover on held-out, marginally
better on corpus files). v2 is the genuinely trained dictionary the
protocol specifies; v1 stays readable for old files.)

## Regenerating

```sh
./dict-training/train.sh          # regenerates corpus + trains + embeds nothing
node dict-training/embed-dict-v2.mjs  # embeds the .bin into src/lib/zstd.ts
npm test                          # the SHA-256 pin + round-trip tests must pass
```

`train.sh` re-runs the generator, trains, prints the SHA-256, and
sanity-checks a CLI round-trip. `embed-dict-v2.mjs` verifies the magic
and ID before writing the base64 + SHA-256 into `src/lib/zstd.ts`;
changing the dictionary without updating the pinned hash fails the
tests loudly, by design.

## Versioning

- v1 (`v1-corpus-derived`, 26,300 bytes, ID `0x41524B01`) still
  decodes: `decompressBytes` tries v2, then v1, then plain frames.
  New files are written with v2.
- The protocol-root manifest announces v2
  (`zstdDictionary: { version: 2, url: "…/zstd-dictionary-v2.bin",
  sha256: "a178…" }`); see PROTOCOL.md §4.
