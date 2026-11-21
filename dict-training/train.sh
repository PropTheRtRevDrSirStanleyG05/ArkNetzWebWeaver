#!/bin/sh
# Train the zstd dictionary v2 (fix round 3, item 3).
#   ./dict-training/train.sh
# Requires: the zstd CLI (apt install zstd; 1.5.5 verified here) and the
# corpus from `node dict-training/generate-corpus.mjs`.
# Output: dict-training/zstd-dictionary-v2.bin — a FORMATTED dictionary
# (RFC 8878 §5: magic 0xEC30A437 + ID + entropy tables + content),
# capped at 32 KiB (the thread's ~32 KB), ID forced to 1095912194
# (0x41524B02, "ARK\x02") so a v2 frame read by a v1 client fails
# loudly instead of silently mis-decoding. (--dictID takes decimal;
# 0x41524B02 hex was rejected by the CLI.)
set -eu
cd "$(dirname "$0")"
node ./generate-corpus.mjs
zstd --train --maxdict=32768 --dictID=1095912194 -o zstd-dictionary-v2.bin corpus/*
echo "--- dictionary ---"
ls -l zstd-dictionary-v2.bin
sha256sum zstd-dictionary-v2.bin
od -A x -t x1 -N 16 zstd-dictionary-v2.bin
echo "--- sanity: compress + decompress one corpus file with the dictionary ---"
cp corpus/0001-registry-map.json /tmp/dict-v2-sample.json
zstd -f -D zstd-dictionary-v2.bin /tmp/dict-v2-sample.json -o /tmp/dict-v2-sample.json.zst
zstd -d -f -D zstd-dictionary-v2.bin /tmp/dict-v2-sample.json.zst -o /tmp/dict-v2-sample.out.json
cmp /tmp/dict-v2-sample.json /tmp/dict-v2-sample.out.json && echo "round-trip OK"
echo "--- sizes: plain vs v2-dict on one file of each kind (bytes) ---"
for f in $(ls corpus/*-registry-map.json | head -1) $(ls corpus/*-site.json | head -1) $(ls corpus/*-directory.json | head -1) $(ls corpus/*-contacts.json | head -1) $(ls corpus/*-mail-envelope.json | head -1); do
  plain=$(zstd -f -c "$f" | wc -c)
  withdict=$(zstd -f -D zstd-dictionary-v2.bin -c "$f" | wc -c)
  raw=$(wc -c < "$f")
  echo "$f raw=$raw plain=$plain dict=$withdict"
done
