// Tests: stealth IA media upload — mock IA endpoint only, never real IA.
import test from "node:test";
import assert from "node:assert/strict";
import {
  IaUploadQueue,
  attachMedia,
  backoffMs,
  decryptIaKeys,
  encryptIaKeys,
  iaHotlink,
  iaItemNameForUser,
  iaThumbnailFilename,
  sanitizeIaFilename,
  uploadToIa,
} from "../src/lib/ia-media.js";
import type { IaKeys } from "../src/lib/ia-media.js";

const KEYS: IaKeys = { accessKey: "AK", secretKey: "SK", username: "Alice_Dev" };
const FILE = new Blob(["hello"], { type: "image/webp" });

function mockIa(statuses: number[]) {
  let calls = 0;
  const seen: string[] = [];
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body: Blob }) => {
    calls++;
    seen.push(url);
    assert.equal(init.method, "PUT");
    assert.equal(init.headers.Authorization, "LOW AK:SK");
    const status = statuses[Math.min(calls - 1, statuses.length - 1)] as number;
    return { status, text: async () => (status >= 400 ? "slow down" : "ok") };
  };
  return { fetchFn, calls: () => calls, seen: () => seen };
}

test("iaItemNameForUser is lowercase, hyphenated, monthly", () => {
  assert.equal(iaItemNameForUser("Alice_Dev", new Date("2026-11-20T00:00:00Z")), "arknetz-media-alice-dev-2026-11");
});

test("iaHotlink builds archive.org/download/<item>/<file>", () => {
  assert.equal(iaHotlink("arknetz-media-alice-2026-11", "photo.webp"), "https://archive.org/download/arknetz-media-alice-2026-11/photo.webp");
});

test("sanitizeIaFilename strips unsafe characters; thumbnail name is -thumb.webp", () => {
  assert.equal(sanitizeIaFilename("my photo (1).PNG"), "my-photo-1-.PNG");
  assert.equal(iaThumbnailFilename("photo.png"), "photo-thumb.webp");
});

test("backoffMs doubles: 500, 1000, 2000, capped at 30000", () => {
  assert.deepEqual([0, 1, 2, 3].map((a) => backoffMs(a)), [500, 1000, 2000, 4000]);
  assert.equal(backoffMs(10), 30000);
});

test("uploadToIa succeeds first try and returns the hotlink with attempts=1", async () => {
  const { fetchFn, calls } = mockIa([200]);
  const r = await uploadToIa(FILE, "photo.webp", "arknetz-media-alice-2026-11", KEYS, fetchFn);
  assert.equal(r.hotlink, "https://archive.org/download/arknetz-media-alice-2026-11/photo.webp");
  assert.equal(r.attempts, 1);
  assert.equal(calls(), 1);
});

test("uploadToIa retries 429 then succeeds, attempts=2", async () => {
  const { fetchFn, calls } = mockIa([429, 200]);
  const r = await uploadToIa(FILE, "photo.webp", "item", KEYS, fetchFn);
  assert.equal(r.attempts, 2);
  assert.equal(calls(), 2);
});

test("uploadToIa gives up after 5 attempts on persistent 503 and says the local copy is kept", async () => {
  const { fetchFn, calls } = mockIa([503]);
  await assert.rejects(() => uploadToIa(FILE, "photo.webp", "item", KEYS, fetchFn), /after 5 attempts.*local copy kept/);
  assert.equal(calls(), 5);
});

test("uploadToIa does NOT retry a 403 (bad keys) — one call only", async () => {
  const { fetchFn, calls } = mockIa([403]);
  await assert.rejects(() => uploadToIa(FILE, "photo.webp", "item", KEYS, fetchFn), /HTTP 403/);
  assert.equal(calls(), 1);
});

test("IaUploadQueue caps concurrency at 2", async () => {
  const queue = new IaUploadQueue(2, 0);
  let running = 0;
  let maxRunning = 0;
  const task = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
  };
  await Promise.all([queue.enqueue(task), queue.enqueue(task), queue.enqueue(task), queue.enqueue(task)]);
  assert.ok(maxRunning <= 2, `max concurrent was ${maxRunning}`);
});

test("attachMedia with no keys returns ia_not_linked and uploads nothing", () => {
  let fetchCalls = 0;
  const fetchFn = async () => {
    fetchCalls++;
    return { status: 200, text: async () => "ok" };
  };
  const media = attachMedia(FILE, "photo.webp", null, new IaUploadQueue(2, 0), fetchFn, () => {
    throw new Error("onDone must not fire when IA is not linked");
  });
  assert.equal(media.status, "ia_not_linked");
  assert.equal(media.hotlink, "");
  assert.equal(fetchCalls, 0);
});

test("attachMedia with keys returns uploading + local preview, then onDone ready with the hotlink", async () => {
  const { fetchFn } = mockIa([200]);
  const done = new Promise((resolve) => {
    const media = attachMedia(FILE, "photo.webp", KEYS, new IaUploadQueue(2, 0), fetchFn, (m) => resolve(m));
    assert.equal(media.status, "uploading");
    assert.equal(media.item, iaItemNameForUser("Alice_Dev"));
  });
  const result = (await done) as { status: string; hotlink: string };
  assert.equal(result.status, "ready");
  assert.match(result.hotlink, /^https:\/\/archive\.org\/download\/arknetz-media-alice-dev-/);
});

test("encryptIaKeys / decryptIaKeys round-trip; wrong passphrase fails", async () => {
  const stored = await encryptIaKeys(KEYS, "correct horse");
  assert.equal((await decryptIaKeys(stored, "correct horse")).secretKey, "SK");
  await assert.rejects(() => decryptIaKeys(stored, "wrong passphrase"));
});

test("per-user keys: uploadToIa refuses blank/missing IA keys before any network call", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return { status: 200, text: async () => "ok" };
  };
  for (const keys of [
    { accessKey: "", secretKey: "SK", username: "alice" },
    { accessKey: "AK", secretKey: "", username: "alice" },
    { accessKey: "AK", secretKey: "SK", username: "  " },
  ] as IaKeys[]) {
    await assert.rejects(
      () => uploadToIa(FILE, "photo.webp", "item", keys, fetchFn),
      /own .* IA .* keys|link your own/i,
    );
  }
  assert.equal(calls, 0, "no IA request may be sent with blank keys");
});

test("per-user keys: attachMedia with blank keys returns ia_not_linked and uploads nothing", () => {
  let fetchCalls = 0;
  const fetchFn = async () => {
    fetchCalls++;
    return { status: 200, text: async () => "ok" };
  };
  const media = attachMedia(
    FILE,
    "photo.webp",
    { accessKey: "", secretKey: "SK", username: "alice" },
    new IaUploadQueue(2, 0),
    fetchFn,
    () => {
      throw new Error("onDone must not fire when the keys are blank");
    },
  );
  assert.equal(media.status, "ia_not_linked");
  assert.equal(media.hotlink, "");
  assert.equal(fetchCalls, 0);
});

test("IA path (mock): thumbnail uploads to the same monthly item as the photo, via the S3 URL shape, with the user's own LOW auth", async () => {
  const seen: Array<{ url: string; auth: string }> = [];
  const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body: Blob }) => {
    seen.push({ url, auth: init.headers.Authorization ?? "" });
    return { status: 200, text: async () => "ok" };
  };
  const queue = new IaUploadQueue(2, 0);
  const item = iaItemNameForUser("Alice_Dev");
  const photo = await uploadToIa(FILE, "photo.png", item, KEYS, fetchFn);
  const thumb = await uploadToIa(new Blob(["thumb"], { type: "image/webp" }), "photo-thumb.webp", item, KEYS, fetchFn);
  assert.equal(photo.hotlink, `https://archive.org/download/${item}/photo.png`);
  assert.equal(thumb.hotlink, `https://archive.org/download/${item}/photo-thumb.webp`);
  assert.equal(thumb.hotlink, iaHotlink(item, iaThumbnailFilename("photo.png")));
  assert.deepEqual(
    seen.map((c) => c.url),
    [`https://s3.us.archive.org/${item}/photo.png`, `https://s3.us.archive.org/${item}/photo-thumb.webp`],
  );
  assert.ok(seen.every((c) => c.auth === "LOW AK:SK"), "every IA call carries the user's own keys, never a shared key");
  void queue;
});
