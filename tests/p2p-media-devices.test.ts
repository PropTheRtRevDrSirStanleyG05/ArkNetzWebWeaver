// Tests: P2P media devices — fake devices, screen-share support
// detection, and the default audio constraints. No real media
// exists in Node; the fakes are the whole surface under test.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FakeMediaDevices,
  FakeMediaStream,
  FakeMediaTrack,
  defaultAudioConstraints,
  detectScreenShareSupport,
  isAndroidUserAgent,
} from "../src/lib/p2p/media-devices.js";

test("fake devices: getUserMedia returns audio (+video when asked)", async () => {
  const devices = new FakeMediaDevices();
  const audioOnly = await devices.getUserMedia({ audio: true });
  assert.equal(audioOnly.getAudioTracks().length, 1);
  assert.equal(audioOnly.getVideoTracks().length, 0);
  const withVideo = await devices.getUserMedia({ audio: true, video: true });
  assert.equal(withVideo.getAudioTracks().length, 1);
  assert.equal(withVideo.getVideoTracks().length, 1);
  assert.equal(devices.lastUserMediaConstraints?.video, true);
});

test("fake devices: getUserMedia failure propagates (permission denied)", async () => {
  const devices = new FakeMediaDevices();
  devices.failUserMedia = new Error("Permission denied");
  await assert.rejects(devices.getUserMedia({ audio: true }), /Permission denied/);
});

test("fake devices: getDisplayMedia returns a screen video track", async () => {
  const devices = new FakeMediaDevices();
  const screen = await devices.getDisplayMedia({ video: true });
  const video = screen.getVideoTracks();
  assert.equal(video.length, 1);
  assert.equal(video[0]?.kind, "video");
  assert.equal(devices.lastDisplayMediaConstraints?.video, true);
});

test("fake stream: add/remove track, stop marks the track stopped", () => {
  const track = new FakeMediaTrack("t1", "audio");
  const stream = new FakeMediaStream("s1", [track]);
  assert.equal(stream.getTracks().length, 1);
  const extra = new FakeMediaTrack("t2", "video");
  stream.addTrack(extra);
  assert.equal(stream.getTracks().length, 2);
  stream.removeTrack(extra);
  assert.equal(stream.getTracks().length, 1);
  track.stop();
  assert.equal(track.stopped, true);
  assert.equal(track.enabled, false);
});

test("fake devices: enumerateDevices lists mic + two cameras", async () => {
  const devices = new FakeMediaDevices();
  const list = await devices.enumerateDevices();
  assert.equal(list.filter((d) => d.kind === "videoinput").length, 2);
  assert.equal(list.filter((d) => d.kind === "audioinput").length, 1);
});

test("default audio constraints ask for echo cancellation, noise suppression, AGC", () => {
  const c = defaultAudioConstraints();
  assert.equal(typeof c.audio, "object");
  const audio = c.audio as { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean };
  assert.equal(audio.echoCancellation, true);
  assert.equal(audio.noiseSuppression, true);
  assert.equal(audio.autoGainControl, true);
});

test("screen-share support: desktop with getDisplayMedia is supported", () => {
  const support = detectScreenShareSupport(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0",
    true,
  );
  assert.equal(support.supported, true);
});

test("screen-share support: Android is a stub, never supported", () => {
  const support = detectScreenShareSupport(
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 Chrome/120.0",
    true,
  );
  assert.equal(support.supported, false);
  if (!support.supported) {
    assert.equal(support.reason, "android-media-projection-bridge-missing");
    assert.match(support.detail, /MediaProjection/);
  }
});

test("screen-share support: desktop without getDisplayMedia is unsupported", () => {
  const support = detectScreenShareSupport(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0",
    false,
  );
  assert.equal(support.supported, false);
  if (!support.supported) assert.equal(support.reason, "get-display-media-missing");
});

test("isAndroidUserAgent matches Android, not desktop", () => {
  assert.equal(isAndroidUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro)"), true);
  assert.equal(isAndroidUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), false);
  assert.equal(isAndroidUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false);
});
