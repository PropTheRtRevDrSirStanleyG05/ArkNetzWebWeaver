// Tests: P2P media connection — fake pair track delivery,
// replaceTrack, stats summarisation, and the WebRTC adapter's
// Node guard. No real WebRTC exists in Node; the fake pair is the
// whole connection under test.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FakeMediaConnectionFactory,
  WebRtcMediaConnectionFactory,
  summarizeMediaStats,
  type MediaStatsReport,
} from "../src/lib/p2p/media-connection.js";
import { FakeMediaDevices, FakeMediaTrack } from "../src/lib/p2p/media-devices.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function statsReport(entries: Array<Record<string, unknown>>): MediaStatsReport {
  return {
    forEach(cb) {
      for (const e of entries) cb({ type: "", id: "", ...e });
    },
  };
}

test("fake pair: addTrack delivers ontrack to the twin, both directions", async () => {
  const factory = new FakeMediaConnectionFactory();
  const [a, b] = factory.createPair("peer-a", "peer-b");
  const devices = new FakeMediaDevices();
  const streamA = devices.makeStream(true);
  const streamB = devices.makeStream(true);
  const receivedB: string[] = [];
  const receivedA: string[] = [];
  b.ontrack = (ev) => receivedB.push(`${ev.track.kind}:${ev.track.id}`);
  a.ontrack = (ev) => receivedA.push(`${ev.track.kind}:${ev.track.id}`);
  const audioA = streamA.getAudioTracks()[0];
  const videoB = streamB.getVideoTracks()[0];
  assert.ok(audioA && videoB);
  a.addTrack(audioA, streamA);
  b.addTrack(videoB, streamB);
  await flush();
  assert.deepEqual(receivedB, [`audio:${audioA.id}`]);
  assert.deepEqual(receivedA, [`video:${videoB.id}`]);
  assert.equal(b.receivedTracks.length, 1);
  assert.equal(a.receivedTracks.length, 1);
});

test("fake pair: replaceTrack swaps the track the twin sees", async () => {
  const factory = new FakeMediaConnectionFactory();
  const [a, b] = factory.createPair("peer-a", "peer-b");
  const devices = new FakeMediaDevices();
  const stream = devices.makeStream(true);
  const seen: string[] = [];
  b.ontrack = (ev) => seen.push(ev.track.id);
  const cam = stream.getVideoTracks()[0];
  const screenVideo = new FakeMediaTrack("screen-1", "video");
  assert.ok(cam);
  const sender = a.addTrack(cam, stream);
  await flush();
  assert.deepEqual(seen, [cam.id]);
  await sender.replaceTrack(screenVideo);
  await flush();
  assert.deepEqual(seen, [cam.id, "screen-1"]);
  assert.equal(sender.track, screenVideo);
});

test("fake pair: removeTrack retires the track on the twin", async () => {
  const factory = new FakeMediaConnectionFactory();
  const [a, b] = factory.createPair("peer-a", "peer-b");
  const devices = new FakeMediaDevices();
  const stream = devices.makeStream(true);
  const audio = stream.getAudioTracks()[0];
  assert.ok(audio);
  const sender = a.addTrack(audio, stream);
  await flush();
  assert.equal(b.receivedTracks.length, 1);
  a.removeTrack(sender);
  assert.equal(b.receivedTracks.length, 0);
  assert.equal(a.getSenders().length, 0);
});

test("fake pair: offer/answer moves both sides to connected", async () => {
  const factory = new FakeMediaConnectionFactory();
  const [a, b] = factory.createPair("peer-a", "peer-b");
  const statesA: string[] = [];
  const statesB: string[] = [];
  a.onstatechange = (s) => statesA.push(s);
  b.onstatechange = (s) => statesB.push(s);
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);
  assert.equal(a.state, "connected");
  assert.equal(b.state, "connected");
  assert.ok(statesA.includes("connected"));
  assert.ok(statesB.includes("connected"));
});

test("fake connection: empty stats means unknown everywhere (no guessing)", async () => {
  const factory = new FakeMediaConnectionFactory();
  const [a] = factory.createPair("peer-a", "peer-b");
  const summary = summarizeMediaStats(await a.getStats());
  assert.equal(summary.outgoingKbps, undefined);
  assert.equal(summary.rttMs, undefined);
  assert.equal(summary.lossFraction, undefined);
  assert.equal(summary.localCandidateType, undefined);
});

test("summarizeMediaStats: reads bitrate, RTT, loss, and the relay URL", () => {
  const summary = summarizeMediaStats(
    statsReport([
      { type: "candidate-pair", id: "pair-1", state: "succeeded", localCandidateId: "lc-1", remoteCandidateId: "rc-1", availableOutgoingBitrate: 850_000, currentRoundTripTime: 0.042 },
      { type: "local-candidate", id: "lc-1", candidateType: "relay", url: "turn:freeturn.net:3478" },
      { type: "remote-candidate", id: "rc-1", candidateType: "srflx" },
      { type: "inbound-rtp", id: "in-1", packetsLost: 5, packetsReceived: 95 },
    ]),
  );
  assert.equal(summary.outgoingKbps, 850);
  assert.equal(summary.rttMs, 42);
  assert.equal(summary.lossFraction, 0.05);
  assert.equal(summary.localCandidateType, "relay");
  assert.equal(summary.remoteCandidateType, "srflx");
  assert.equal(summary.relayUrl, "turn:freeturn.net:3478");
});

test("summarizeMediaStats: non-succeeded pairs are ignored", () => {
  const summary = summarizeMediaStats(
    statsReport([
      { type: "candidate-pair", id: "pair-1", state: "in-progress", localCandidateId: "lc-1", availableOutgoingBitrate: 999_000 },
      { type: "local-candidate", id: "lc-1", candidateType: "host" },
    ]),
  );
  assert.equal(summary.outgoingKbps, undefined);
  assert.equal(summary.localCandidateType, undefined);
});

test("WebRTC media factory throws a plain error in Node", () => {
  const factory = new WebRtcMediaConnectionFactory();
  assert.throws(
    () => factory.createConnection("peer-a", { iceServers: [] }),
    /WebRTC is not available in this environment/,
  );
});
