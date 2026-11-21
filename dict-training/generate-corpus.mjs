// Generate the zstd dictionary v2 training corpus (fix round 3, item 3).
// Deterministic (seeded PRNG): re-running this script regenerates the
// exact same corpus, so `zstd --train` on it is reproducible.
// The corpus is built from the project's own document shapes — the
// .json.zst schemas in PROTOCOL.md §3 — with varied fake data, so the
// trained dictionary learns the byte patterns real files actually
// contain (JSON keys, backend URIs, arknetz:// links, IA hotlinks,
// Markdown, common prose). Every file is compact JSON (no space after
// `:` or `,`), exactly as JSON.stringify produces for real .json.zst
// files. Nothing here is secret: every value is invented sample data.
//
// Usage: node dict-training/generate-corpus.mjs
// Output: dict-training/corpus/*.json (300 files)
// Then:  ./dict-training/train.sh   (runs zstd --train)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("./corpus/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// Seeded PRNG (mulberry32) — deterministic across runs and machines.
let seed = 0x41524b02;
function rnd() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}
function int(min, max) {
  return min + Math.floor(rnd() * (max - min + 1));
}

const FIRST = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "henry", "ivan", "julia", "karl", "lara", "mike", "nina", "omar", "priya", "quinn", "rosa", "sam", "tara", "umar", "vera", "walt", "xena", "yusuf", "zoe"];
const WORDS = ["garden", "kitchen", "trains", "bread", "code", "music", "photos", "poetry", "radio", "travel", "books", "films", "games", "history", "science", "cooking", "craft", "cycles", "stars", "rivers", "harbour", "market", "library", "workshop", "studio", "meadow", "harvest", "lantern", "compass", "anchor"];
const TLDS = ["edu", "example", "zine", "blog", "site", "press", "ink", "art"];
const TITLES = ["Notes on ", "The ", "A field guide to ", "Letters from ", "Small ", "Everyday ", "The quiet art of ", "How to start ", "A year of ", "Walking with "];
const TOPICS = ["bread", "trains", "gardens", "code", "songs", "photographs", "rivers", "libraries", "bicycle repair", "star charts", "fermentation", "local history", "hand tools", "wildflowers", "short stories", "maps", "tea", "woodwork", "clouds", "notebooks"];
// Prose is generated COMBINATORIALLY from templates + vocabulary, so
// almost every sentence is unique (like real user prose: shared common
// words, unique sentences). A fixed pool of a dozen repeated sentences
// would be memorised verbatim by the trainer and teach it nothing
// general — the first v2 attempt did exactly that, and the trained
// dictionary then lost to v1 on any held-out document. With unique
// sentences, the only frequent substrings are the JSON structure, the
// backend/URL shapes, and common English words — which is what a
// dictionary for .json.zst files should actually learn.
const NOUNS = ["garden", "kitchen", "harbour", "library", "workshop", "meadow", "river", "market", "station", "lantern", "compass", "notebook", "bicycle", "ferry", "orchard", "bakery", "studio", "bridge", "forest", "chapel", "quay", "mill", "vineyard", "observatory", "boatyard", "greenhouse", "archive", "tearoom", "bindery", "granary"];
const VERBS = ["opens", "closes", "waits", "grows", "sings", "mends", "paints", "builds", "tends", "watches", "keeps", "carries", "follows", "meets", "writes", "reads", "bakes", "plants", "repairs", "walks", "listens", "counts", "gathers", "cleans", "lights", "crosses", "visits", "teaches", "remembers", "welcomes"];
const ADJS = ["quiet", "small", "old", "bright", "slow", "patient", "warm", "green", "golden", "misty", "sturdy", "gentle", "early", "late", "round", "tall", "soft", "sharp", "calm", "busy", "hollow", "sweet", "rough", "plain", "proud", "lonely", "merry", "steep", "wide", "narrow"];
const OBJECTS = ["the morning", "the tide", "the harvest", "the first light", "a letter", "the old map", "the winter store", "the summer rain", "a pot of tea", "the last train", "the new roof", "a basket of apples", "the parish records", "the evening bell", "a shelf of jars", "the river road", "the seed order", "a borrowed ladder", "the festival banner", "the tool chest"];
const PLACES = ["by the kitchen door", "under the apple tree", "beside the station", "along the river", "in the back room", "on the top shelf", "near the old bridge", "behind the chapel", "across the meadow", "at the end of the lane", "over the harbour wall", "inside the greenhouse", "beneath the stairs", "around the market square", "past the mill pond", "above the boatyard", "between the tall hedges", "under the eaves", "along the cliff path", "in the reading room"];
function sentence() {
  const form = int(0, 3);
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  if (form === 0) return `${cap(pick(ADJS))} ${pick(NOUNS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(PLACES)}.`;
  if (form === 1) return `The ${pick(NOUNS)} ${pick(VERBS)} ${pick(OBJECTS)}, and the ${pick(NOUNS)} ${pick(VERBS)} ${pick(PLACES)}.`;
  if (form === 2) return `${cap(pick(NOUNS))} ${pick(VERBS)} ${pick(ADJS)} ${pick(NOUNS)} ${pick(PLACES)}, while the ${pick(ADJS)} ${pick(NOUNS)} ${pick(VERBS)} ${pick(OBJECTS)}.`;
  return `We ${pick(VERBS)} the ${pick(ADJS)} ${pick(NOUNS)} ${pick(PLACES)} before ${pick(OBJECTS)} ${pick(VERBS)} ${pick(ADJS)}.`;
}
function paragraph() {
  return `${sentence()} ${sentence()} ${sentence()}`;
}
const BLOCK_TEXT = [paragraph(), paragraph(), paragraph(), paragraph(), paragraph(), paragraph(), paragraph(), paragraph()];
const PROSE = [paragraph(), paragraph(), paragraph(), paragraph(), paragraph()];


function domain(i) {
  return `${pick(WORDS)}-${pick(WORDS)}${i % 7 === 0 ? `-${i}` : ""}.${pick(TLDS)}`;
}
function owner() {
  return pick(FIRST);
}
function backend(d, o) {
  return `gh:${o}/arknetz-site-${d.replace(/\./g, "-")}`;
}
function updated() {
  return 1794000000 + int(0, 900000);
}
function hex(n) {
  return [...Array(n)].map(() => "0123456789abcdef"[int(0, 15)]).join("");
}
function compact(value) {
  return JSON.stringify(value);
}

let n = 0;
function write(name, value) {
  n++;
  writeFileSync(join(OUT, `${String(n).padStart(4, "0")}-${name}.json`), compact(value));
}

// --- registry shards: map form + entries-array form (60 files) --------
for (let i = 0; i < 300; i++) {
  const entries = {};
  const count = int(3, 8);
  for (let j = 0; j < count; j++) {
    const d = domain(i * 10 + j);
    const o = owner();
    entries[d] = {
      domain: d,
      backend: backend(d, o),
      ...(rnd() < 0.4 ? { mirrors: [pick(["gl:", "cb:"]) + `${o}/arknetz-site-${d.replace(/\./g, "-")}-mirror`] } : {}),
      shard: hex(1),
      owner: o,
      updated: updated(),
    };
  }
  write("registry-map", entries);
}
for (let i = 0; i < 300; i++) {
  const entries = [];
  const count = int(2, 6);
  for (let j = 0; j < count; j++) {
    const d = domain(300 + i * 10 + j);
    const o = owner();
    entries.push({ domain: d, backend: backend(d, o), shard: hex(1), owner: o, ...(rnd() < 0.5 ? { updated: updated() } : {}) });
  }
  write("registry-entries", { entries });
}

// --- site documents, every block type (60 files) -----------------------
const BLOCK_TYPES = ["hero", "h1", "h2", "h3", "p", "quote", "code", "link"];
for (let i = 0; i < 600; i++) {
  const d = domain(600 + i);
  const topic = pick(TOPICS);
  const blocks = [];
  blocks.push({ type: "hero", title: pick(TITLES) + topic, subtitle: paragraph() });
  const nb = int(3, 7);
  for (let j = 0; j < nb; j++) {
    const t = pick(BLOCK_TYPES);
    if (t === "hero") continue;
    if (t === "code") blocks.push({ type: "code", language: pick(["text", "typescript", "rust"]), text: `arknetz://${d}\nregistry shard: SHA256(domain)[0]` });
    else if (t === "link") blocks.push({ type: "link", label: pick(["Read more", "The archive", "Timetable", "Seed catalogue"]), href: rnd() < 0.5 ? `arknetz://${d}/archive` : "https://archive.org/download/example/file.jpg" });
    else if (t === "quote") blocks.push({ type: "quote", text: paragraph() });
    else blocks.push({ type: t, text: paragraph() });
  }
  if (rnd() < 0.5) {
    blocks.push({ type: "img", src: `https://archive.org/download/${pick(WORDS)}-photos/${pick(WORDS)}.jpg`, alt: `A photograph of ${topic}`, caption: paragraph() });
  }
  if (rnd() < 0.3) {
    blocks.push({ type: "gallery", items: [0, 1].map(() => ({ src: `https://archive.org/download/${pick(WORDS)}-photos/${pick(WORDS)}.jpg`, alt: pick(TOPICS), caption: paragraph() })) });
  }
  if (rnd() < 0.3) {
    blocks.push({ type: "series-grid", title: pick(TITLES) + topic, items: [0, 1, 2].map((k) => ({ label: `${topic} part ${k + 1}`, href: `arknetz://${d}/part-${k + 1}` })) });
  }
  write("site", {
    domain: d,
    title: pick(TITLES) + topic,
    theme: { layout: pick(["docs", "blog", "magazine", "portfolio"]), accent: pick(["#2563eb", "#b45309", "#15803d", "#0e7490", "#9d174d"]), font: pick(["system-ui", "Georgia, serif"]) },
    nav: [
      { label: "Home", href: `arknetz://${d}` },
      { label: "About", href: `arknetz://${d}/about` },
      ...(rnd() < 0.5 ? [{ label: "Posts", href: `arknetz://${d}/posts` }] : []),
    ],
    blocks,
    version: pick(["1", "2"]),
    updated: updated(),
  });
}

// --- directory shards (30 files) ---------------------------------------
const CATEGORIES = ["tech", "cinema", "games", "music", "travel", "food", "garden", "code"];
for (let i = 0; i < 300; i++) {
  const category = pick(CATEGORIES);
  const cards = [];
  for (let j = 0; j < int(2, 6); j++) {
    const d = domain(1200 + i * 10 + j);
    cards.push({
      domain: d,
      title: pick(TITLES) + pick(TOPICS),
      description: paragraph(),
      category,
      tags: [pick(WORDS), pick(WORDS), pick(TOPICS)],
      updated: updated(),
    });
  }
  write("directory", { category, version: 1, updated: updated(), cards });
}

// --- contacts shards (30 files) ----------------------------------------
for (let i = 0; i < 300; i++) {
  const shard = {};
  for (let j = 0; j < int(2, 5); j++) {
    const o = owner();
    const addr = `${o}@${domain(1500 + i * 10 + j)}`;
    shard[addr] = {
      displayName: `${o[0].toUpperCase()}${o.slice(1)} Example`,
      contactAddress: addr,
      fingerprint: hex(40),
      publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      relays: [`gh:${o}/arknetz-mail`],
      updated: updated(),
    };
  }
  write("contacts", shard);
}

// --- mail envelopes + plaintext (30 files) ------------------------------
for (let i = 0; i < 300; i++) {
  const from = owner();
  const to = owner();
  const id = `mail-${hex(8)}-${updated()}-${from}`;
  if (rnd() < 0.5) {
    write("mail-envelope", {
      version: 1,
      messageId: id,
      threadId: `thread-${hex(8)}`,
      from: { name: `${from} Example`, address: `${from}@example.com` },
      recipients: [{ name: `${to} Example`, address: `${to}@example.com` }],
      sentAt: updated() * 1000,
      ivB64: "AAECAwQFBgcICQoLDA0ODw==",
      ciphertextB64: "U2VjcmV0IG1lc3NhZ2UgY29udGVudCBlbmNyeXB0ZWQgd2l0aCBBRVMtR0NNLg==",
      wrappedKeys: [{ fingerprint: hex(40), wrappedKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", ephemeralPublicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
      plaintextBytes: int(100, 2000),
    });
  } else {
    write("mail-plain", {
      version: 1,
      messageId: id,
      threadId: `thread-${hex(8)}`,
      from: { name: `${from} Example`, address: `${from}@example.com` },
      to: [{ name: `${to} Example`, address: `${to}@example.com` }],
      subject: pick(["Welcome to the new site", "Notes on " + pick(TOPICS), "Re: the meeting", "Photos from the trip"]),
      body: `Hello ${to},\n\n${paragraph()}\n\n${paragraph()}\n\nBest wishes,\n${from}`,
      sentAt: updated() * 1000,
      attachments: rnd() < 0.4 ? [{ name: "notes.txt", size: int(100, 5000), contentType: "text/plain" }] : [],
    });
  }
}

// --- comments (20), posts (20), manifests (20) --------------------------
for (let i = 0; i < 200; i++) {
  const d = domain(2000 + i);
  write("comments", {
    threads: [
      {
        id: `thread-${String(i).padStart(4, "0")}`,
        domain: d,
        pagePath: pick(["index", "recipes/starter", "about", "posts/first"]),
        title: pick(TITLES) + pick(TOPICS),
        locked: rnd() < 0.2,
        comments: [0, 1].map((k) => ({ id: `c${k + 1}`, author: owner(), createdAt: updated(), body: paragraph() })),
        moderationLog: [],
        issueNumber: int(1, 200),
      },
    ],
  });
}
for (let i = 0; i < 200; i++) {
  const d = domain(2200 + i);
  write("posts", {
    domain: d,
    posts: [0, 1, 2].map((k) => ({
      id: `post-${k + 1}`,
      t: pick(TITLES) + pick(TOPICS),
      d: updated(),
      b: [["p", paragraph()], ["p", paragraph()]],
    })),
  });
}
for (let i = 0; i < 200; i++) {
  write("manifest", {
    protocolVersion: "0.1.0",
    defaultRootRepo: "PropTheRtRevDrSirStanleyG05/protocol-root",
    masterGithubUser: "PropTheRtRevDrSirStanleyG05",
    registryShards: ["arknetz-registry-00", "arknetz-registry-01", "arknetz-registry-0f"],
    contactsShards: ["arknetz-contacts-00", "arknetz-contacts-01", "arknetz-contacts-0f"],
    directoryCategories: CATEGORIES.slice(0, int(3, 8)),
    mirrors: ["gl:PropTheRtRevDrSirStanleyG05/protocol-root", "cb:PropTheRtRevDrSirStanleyG05/protocol-root"],
    zstdDictionary: { version: 2, url: "https://raw.githubusercontent.com/PropTheRtRevDrSirStanleyG05/protocol-root/main/zstd-dictionary-v2.bin", sha256: hex(64) },
  });
}

// --- team (10), stats (10), feed pointers (10), delegations (10), moderation (10)
for (let i = 0; i < 100; i++) {
  const d = domain(2400 + i);
  write("team", {
    owner: owner(),
    roles: { managing_editor: ["pages.write", "pages.publish", "media.upload", "mail.read", "mail.send"], writer: ["pages.draft", "media.upload"] },
    members: { [owner()]: { role: "managing_editor" }, [owner()]: { role: "writer", allowed_paths: ["blog/*"] } },
  });
  write("stats", { domain: d, days: { "2026-11-15": { index: int(0, 50), about: int(0, 10) } }, updated: updated() });
  write("feed", { month: "2026-11", pointers: [0, 1, 2].map((k) => ({ domain: domain(2500 + i * 3 + k), post: `post-${k + 1}`, at: updated() })) });
  write("delegations", { [`blog.${d}`]: backend(`blog.${d}`, owner()), [`shop.${d}`]: backend(`shop.${d}`, owner()) });
  write("moderation", {
    patches: [{ target: d, action: pick(["ban_domain", "redact", "remove_post"]), reason: pick(["spam", "off-topic", "copyright"]), by: "PropTheRtRevDrSirStanleyG05", at: updated() }],
  });
}

// --- structural fragments (200 files) ---------------------------------
// Dense JSON key/structure patterns with varied values: the shapes
// that occur in EVERY .json.zst file. v1's hand-built dictionary won
// on novel prose largely because its content repeats these fragments
// dozens of times; the trained dictionary needs to see them too, or
// it spends its 32 KiB memorising prose instead of structure.
const FRAG_KEYS = ['"domain":"', '"title":"', '"blocks":[{"type":"', '"type":"p","text":"', '"type":"h1","text":"', '"type":"h2","text":"', '"type":"h3","text":"', '"type":"hero","title":"', '"type":"quote","text":"', '"type":"code","language":"', '"type":"img","src":"', '"type":"video","src":"', '"type":"audio","src":"', '"type":"gallery","items":"', '"type":"cards","items":"', '"type":"cols","columns":"', '"type":"link","label":"', '"type":"series-grid","title":"', '"type":"docs-sidebar","items":"', '"type":"app","name":"', '"backend":"gh:', '"shard":"', '"owner":"', '"updated":', '"mirrors":["gh:', '"theme":{"layout":"', '"accent":"#', '"font":"', '"nav":[{"label":"', '"href":"arknetz://', '"src":"https://archive.org/download/', '"alt":"', '"caption":"', '"category":"', '"tags":["', '"cards":[{"domain":"', '"threads":[{"id":"', '"comments":[{"id":"', '"author":"', '"createdAt":', '"body":"', '"messageId":"', '"threadId":"', '"from":{"name":"', '"address":"', '"subject":"', '"sentAt":', '"protocolVersion":"0.1.0"', '"defaultRootRepo":"', '"masterGithubUser":"', '"registryShards":["arknetz-registry-', '"contactsShards":["arknetz-contacts-', '"directoryCategories":["'];
for (let i = 0; i < 200; i++) {
  const parts = [];
  const count = int(6, 14);
  for (let j = 0; j < count; j++) {
    const frag = pick(FRAG_KEYS);
    if (frag.endsWith(':"')) parts.push(frag + pick(WORDS) + "-" + pick(WORDS) + pick([".edu", ".example", ".zine", ""]) + '",');
    else if (frag.endsWith('://')) parts.push(frag + domain(9000 + i * 3 + j) + "/");
    else if (frag.endsWith('gh:')) parts.push(frag + owner() + "/arknetz-site-" + pick(WORDS) + '",');
    else if (frag.endsWith('#')) parts.push(frag + hex(6) + '",');
    else if (frag.endsWith('":')) parts.push(frag + String(updated()) + ",");
    else parts.push(frag);
  }
  // Write as a raw text sample (not a JSON object): the trainer learns
  // byte patterns, and fragments are patterns, not documents.
  n++;
  writeFileSync(join(OUT, `${String(n).padStart(4, "0")}-fragments.txt`), parts.join(""));
}

console.log(`wrote ${n} corpus files to ${OUT}`);
