// Tests: P2P media framing (control messages on the arknetz/media
// channel) and media settings defaults. Pure functions — no WebRTC.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MEDIA_CHANNEL_LABEL,
  MESH_MAX_PARTICIPANTS,
  decodeMediaControl,
  defaultMediaSettings,
  encodeMediaControl,
} from "../src/lib/p2p/media.js";

test("media control framing round-trips, and garbage is ignored", () => {
  const frame = encodeMediaControl({
    t: "call-invite",
    v: "arknetz-media/1",
    callId: "call-abc",
    fromPeerId: "peer-a",
    fromAddress: "peer-a@example.arknetz",
    kind: "video",
    at: 1_000_000,
  });
  assert.equal(frame[0], 0x01);
  const decoded = decodeMediaControl(frame);
  assert.ok(decoded);
  assert.equal(decoded.t, "call-invite");
  if (decoded.t === "call-invite") {
    assert.equal(decoded.callId, "call-abc");
    assert.equal(decoded.kind, "video");
  }
  // Wrong frame type, empty data, bad JSON, unknown t, missing
  // callId on a call message: all ignored, never fatal.
  assert.equal(decodeMediaControl(new Uint8Array([0x02, 1, 2, 3])), null);
  assert.equal(decodeMediaControl(new Uint8Array([])), null);
  assert.equal(decodeMediaControl(new TextEncoder().encode("not json")), null);
  const badJson = new Uint8Array([0x01, ...new TextEncoder().encode('{"t":"nope"}')]);
  assert.equal(decodeMediaControl(badJson), null);
  const noCallId = new Uint8Array([0x01, ...new TextEncoder().encode('{"t":"call-bye"}')]);
  assert.equal(decodeMediaControl(noCallId), null);
  // Group messages need a groupId, not a callId.
  const groupMsg = encodeMediaControl({
    t: "mixer-elect",
    groupId: "group-1",
    mixerPeerId: "peer-a",
    electedBy: "peer-a",
  });
  const groupDecoded = decodeMediaControl(groupMsg);
  assert.ok(groupDecoded);
  assert.equal(groupDecoded.t, "mixer-elect");
});

test("media channel label is arknetz/media", () => {
  assert.equal(MEDIA_CHANNEL_LABEL, "arknetz/media");
});

test("mesh ceiling is 5 participants", () => {
  assert.equal(MESH_MAX_PARTICIPANTS, 5);
});

test("media settings default to everything off (volunteer mixer included)", () => {
  const settings = defaultMediaSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.voice, false);
  assert.equal(settings.video, false);
  assert.equal(settings.groups, false);
  assert.equal(settings.screenShare, false);
  assert.equal(settings.volunteerMixer, false);
});
