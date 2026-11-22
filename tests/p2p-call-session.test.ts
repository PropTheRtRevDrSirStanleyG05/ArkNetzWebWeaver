// Tests: P2P 1:1 call sessions — invite/accept/connect over the
// loopback data channel, decline, no-answer, mute/video, quality
// degradation, relay warnings, recording consent, and the
// CallManager's incoming-call routing. No real WebRTC exists in
// Node; the fake media pair is the whole call under test.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CallManager,
  CallSession,
  LocalCallRecorder,
  browserRecorderFactory,
  iceFailureReason,
  type CallEvent,
} from "../src/lib/p2p/call-session.js";
import {
  FakeMediaConnection,
  FakeMediaConnectionFactory,
  type MediaConnection,
  type MediaConnectionFactory,
  type MediaStatsReport,
} from "../src/lib/p2p/media-connection.js";
import { FakeMediaDevices } from "../src/lib/p2p/media-devices.js";
import { LoopbackConnectionFactory } from "../src/lib/p2p/transport.js";

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pairs fake media connections across two factory instances: when
 *  A creates a connection to B and B creates one to A, they become
 *  twins — the fake equivalent of ICE connecting them. */
class PairingHub {
  private readonly pending = new Map<string, FakeMediaConnection>();
  create(selfPeerId: string, remotePeerId: string): FakeMediaConnection {
    const conn = new FakeMediaConnection(remotePeerId);
    const reverseKey = `${remotePeerId}->${selfPeerId}`;
    const twin = this.pending.get(reverseKey);
    if (twin) {
      this.pending.delete(reverseKey);
      conn.pairWith(twin);
    } else {
      this.pending.set(`${selfPeerId}->${remotePeerId}`, conn);
    }
    return conn;
  }
}

class PairingMediaFactory implements MediaConnectionFactory {
  constructor(
    private readonly selfPeerId: string,
    private readonly hub: PairingHub,
  ) {}
  createConnection(peerId: string, _config: RTCConfiguration): MediaConnection {
    return this.hub.create(this.selfPeerId, peerId);
  }
}

interface Peer {
  manager: CallManager;
  devices: FakeMediaDevices;
  incoming: CallSession[];
  events: CallEvent[];
}

function makePeer(
  selfPeerId: string,
  hub: PairingHub,
  opts: { statsIntervalMs?: number } = {},
): Peer {
  const devices = new FakeMediaDevices();
  const incoming: CallSession[] = [];
  const events: CallEvent[] = [];
  const manager = new CallManager({
    selfPeerId,
    selfAddress: `${selfPeerId}@example.arknetz`,
    devices,
    mediaFactory: new PairingMediaFactory(selfPeerId, hub),
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    sendControl: () => undefined, // The manager sends over the data channel instead.
    onIncomingCall: (session) => {
      incoming.push(session);
    },
    onEvent: (event) => events.push(event),
  });
  void opts;
  return { manager, devices, incoming, events };
}

function makePair(opts: { statsIntervalMs?: number } = {}): { a: Peer; b: Peer } {
  const hub = new PairingHub();
  const dataFactory = new LoopbackConnectionFactory();
  // createPair's first argument is the REMOTE peer for the first
  // connection (see p2p-peer-manager.test.ts): A's connection is to B.
  const [connA, connB] = dataFactory.createPair("peer-b", "peer-a");
  const a = makePeer("peer-a", hub, opts);
  const b = makePeer("peer-b", hub, opts);
  a.manager.attachConnection(connA);
  b.manager.attachConnection(connB);
  return { a, b };
}

function statsReport(entries: Array<Record<string, unknown>>): MediaStatsReport {
  return {
    forEach(cb) {
      for (const e of entries) cb({ type: "", id: "", ...e });
    },
  };
}

test("1:1 voice call: invite → accept → connected, tracks flow both ways", async () => {
  const { a, b } = makePair();
  const sessionA = a.manager.startCall("peer-b", "peer-b@example.arknetz", "voice");
  const started = sessionA.start();
  await flush();
  assert.equal(b.incoming.length, 1);
  const sessionB = b.incoming[0];
  assert.ok(sessionB);
  assert.equal(sessionB.state, "ringing");
  assert.equal(sessionB.kind, "voice");
  const accepted = sessionB.accept();
  await accepted;
  await started;
  assert.equal(sessionA.state, "connected");
  assert.equal(sessionB.state, "connected");
  // Each side received the other's audio track.
  await flush();
  const connA = sessionA.mediaConnection as FakeMediaConnection;
  const connB = sessionB.mediaConnection as FakeMediaConnection;
  assert.equal(connA.receivedTracks.length, 1);
  assert.equal(connB.receivedTracks.length, 1);
  assert.equal(connA.receivedTracks[0]?.kind, "audio");
  assert.equal(connB.receivedTracks[0]?.kind, "audio");
  sessionA.end();
  sessionB.end();
  assert.equal(sessionA.state, "ended");
  assert.equal(sessionB.state, "ended");
});

test("1:1 video call: video track flows, mute and video-off are announced", async () => {
  const { a, b } = makePair();
  const sessionA = a.manager.startCall("peer-b", "peer-b@example.arknetz", "video");
  const started = sessionA.start();
  await flush();
  const sessionB = b.incoming[0];
  assert.ok(sessionB);
  await sessionB.accept();
  await started;
  assert.equal(sessionA.state, "connected");
  const connA = sessionA.mediaConnection as FakeMediaConnection;
  assert.equal(connA.receivedTracks.filter((t) => t.kind === "video").length, 1);
  // Mute: local audio track disabled, remote told.
  sessionA.setMuted(true);
  await flush();
  assert.equal(sessionA.muted, true);
  assert.equal(sessionB.remoteAudioOn, false);
  sessionA.setMuted(false);
  await flush();
  assert.equal(sessionA.muted, false);
  assert.equal(sessionB.remoteAudioOn, true);
  // Video off: camera track disabled, remote told.
  sessionA.setVideoEnabled(false);
  await flush();
  assert.equal(sessionB.remoteVideoOn, false);
  sessionA.setVideoEnabled(true);
  await flush();
  assert.equal(sessionB.remoteVideoOn, true);
  sessionA.end();
  await flush();
  assert.equal(sessionB.state, "ended");
});

test("declined call: callee declines, caller sees declined", async () => {
  const { a, b } = makePair();
  const sessionA = a.manager.startCall("peer-b", "peer-b@example.arknetz", "voice");
  const started = sessionA.start();
  await flush();
  const sessionB = b.incoming[0];
  assert.ok(sessionB);
  sessionB.decline("busy");
  await assert.rejects(started, /Call failed/);
  assert.equal(sessionA.state, "declined");
  assert.equal(sessionB.state, "declined");
});

test("no answer: invite times out and the caller fails with no-answer", async () => {
  // A direct session with a 30 ms invite timeout (the manager's
  // startCall uses the default 60 s — too slow to test here).
  const devices = new FakeMediaDevices();
  const direct = new CallSession({
    callId: "call-timeout-test",
    kind: "voice",
    selfPeerId: "peer-a",
    selfAddress: "peer-a@example.arknetz",
    remotePeerId: "peer-b",
    remoteAddress: "peer-b@example.arknetz",
    devices,
    mediaFactory: new FakeMediaConnectionFactory(),
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    sendControl: () => undefined,
    onEvent: () => undefined,
    inviteTimeoutMs: 30,
    connectTimeoutMs: 30,
    statsIntervalMs: 0,
  });
  await assert.rejects(direct.start(), /no-answer/);
  assert.equal(direct.state, "failed");
});

/** Two sessions wired directly to each other (no managers) with a
 *  fake clock — for tests that need to drive the dwell timers. */
function makeDirectPair(kind: "voice" | "video"): {
  sessionA: CallSession;
  sessionB: CallSession;
  advance: (ms: number) => void;
} {
  let now = 1_000_000;
  const nowFn = () => now;
  const hub = new PairingHub();
  const devicesA = new FakeMediaDevices();
  const devicesB = new FakeMediaDevices();
  // Definite assignment: the sendControl closures below only run
  // after both sessions are constructed.
  let sessionA!: CallSession;
  let sessionB!: CallSession;
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  sessionA = new CallSession({
    callId: "call-direct-1",
    kind,
    selfPeerId: "peer-a",
    selfAddress: "peer-a@example.arknetz",
    remotePeerId: "peer-b",
    remoteAddress: "peer-b@example.arknetz",
    devices: devicesA,
    mediaFactory: new PairingMediaFactory("peer-a", hub),
    iceServers,
    sendControl: (msg) => {
      if (msg.t === "call-invite") sessionB.markRinging();
      else void sessionB.handleControl(msg);
    },
    onEvent: () => undefined,
    inviteTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    statsIntervalMs: 0,
    now: nowFn,
  });
  sessionB = new CallSession({
    callId: "call-direct-1",
    kind,
    selfPeerId: "peer-b",
    selfAddress: "peer-b@example.arknetz",
    remotePeerId: "peer-a",
    remoteAddress: "peer-a@example.arknetz",
    devices: devicesB,
    mediaFactory: new PairingMediaFactory("peer-b", hub),
    iceServers,
    sendControl: (msg) => {
      void sessionA.handleControl(msg);
    },
    onEvent: () => undefined,
    inviteTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    statsIntervalMs: 0,
    now: nowFn,
  });
  return { sessionA, sessionB, advance: (ms: number) => { now += ms; } };
}

test("media unavailable: getUserMedia failure fails the call cleanly", async () => {
  const { a, b } = makePair();
  b.devices.failUserMedia = new Error("Permission denied");
  const sessionA = a.manager.startCall("peer-b", "peer-b@example.arknetz", "voice");
  const started = sessionA.start();
  await flush();
  const sessionB = b.incoming[0];
  assert.ok(sessionB);
  await assert.rejects(sessionB.accept(), /Could not access/);
  assert.equal(sessionB.state, "failed");
  await assert.rejects(started, /Call failed/);
});

test("quality monitor: low bitrate degrades to audio-only, recovery restores video", async () => {
  const { sessionA, sessionB, advance } = makeDirectPair("video");
  const started = sessionA.start();
  await flush();
  assert.equal(sessionB.state, "ringing");
  await sessionB.accept();
  await started;
  assert.equal(sessionA.state, "connected");
  const connA = sessionA.mediaConnection as FakeMediaConnection;
  const lowStats = statsReport([
    { type: "candidate-pair", id: "pair-1", state: "succeeded", localCandidateId: "lc-1", remoteCandidateId: "rc-1", availableOutgoingBitrate: 200_000 },
    { type: "local-candidate", id: "lc-1", candidateType: "host" },
    { type: "remote-candidate", id: "rc-1", candidateType: "host" },
  ]);
  const highStats = statsReport([
    { type: "candidate-pair", id: "pair-1", state: "succeeded", localCandidateId: "lc-1", remoteCandidateId: "rc-1", availableOutgoingBitrate: 900_000 },
    { type: "local-candidate", id: "lc-1", candidateType: "host" },
    { type: "remote-candidate", id: "rc-1", candidateType: "host" },
  ]);
  // Healthy first: no degradation.
  connA.fakeStats = highStats;
  await sessionA.pollStatsOnce();
  assert.equal(sessionA.qualityMode, "full");
  assert.equal(sessionA.lastDiagnostics?.path, "direct-host");
  // Low bitrate, but not yet past the 5 s dwell: still full.
  connA.fakeStats = lowStats;
  await sessionA.pollStatsOnce();
  assert.equal(sessionA.qualityMode, "full");
  // Past the dwell: degrades, and the remote side is told.
  advance(6_000);
  await sessionA.pollStatsOnce();
  assert.equal(sessionA.qualityMode, "audio-only");
  // Unknown bitrate (empty stats): no change, no guessing.
  connA.fakeStats = statsReport([]);
  await sessionA.pollStatsOnce();
  assert.equal(sessionA.qualityMode, "audio-only");
  // Healthy again, past the 10 s restore dwell: video returns.
  connA.fakeStats = highStats;
  await sessionA.pollStatsOnce();
  assert.equal(sessionA.qualityMode, "audio-only");
  advance(11_000);
  await sessionA.pollStatsOnce();
  assert.equal(sessionA.qualityMode, "full");
  sessionA.end();
});

test("quality monitor: relayed path raises a relayed event with the operator", async () => {
  const { a, b } = makePair();
  const sessionA = a.manager.startCall("peer-b", "peer-b@example.arknetz", "voice");
  const started = sessionA.start();
  await flush();
  const sessionB = b.incoming[0];
  assert.ok(sessionB);
  await sessionB.accept();
  await started;
  const connA = sessionA.mediaConnection as FakeMediaConnection;
  connA.fakeStats = statsReport([
    { type: "candidate-pair", id: "pair-1", state: "succeeded", localCandidateId: "lc-1", remoteCandidateId: "rc-1", availableOutgoingBitrate: 1_200_000 },
    { type: "local-candidate", id: "lc-1", candidateType: "relay", url: "turn:freeturn.net:3478" },
    { type: "remote-candidate", id: "rc-1", candidateType: "srflx" },
  ]);
  await sessionA.pollStatsOnce();
  assert.equal(sessionA.lastDiagnostics?.path, "relayed");
  assert.match(sessionA.lastDiagnostics?.summary ?? "", /freeturn\.net/);
  const relayed = a.events.filter((e) => e.type === "relayed");
  assert.equal(relayed.length, 1);
  sessionA.end();
});

test("iceFailureReason: no TURN at all means no-relay; any TURN means ice-failed", () => {
  assert.equal(iceFailureReason([{ urls: "stun:stun.l.google.com:19302" }]), "no-relay");
  assert.equal(iceFailureReason([{ urls: ["stun:stun.l.google.com:19302", "turn:freeturn.net:3478"] }]), "ice-failed");
  assert.equal(iceFailureReason([{ urls: "turns:openrelay.metered.ca:443" }]), "ice-failed");
  assert.equal(iceFailureReason([]), "no-relay");
});

test("recording consent: silence is never consent; all-party consent gates recording", async () => {
  const { a, b } = makePair();
  const sessionA = a.manager.startCall("peer-b", "peer-b@example.arknetz", "voice");
  const started = sessionA.start();
  await flush();
  const sessionB = b.incoming[0];
  assert.ok(sessionB);
  await sessionB.accept();
  await started;
  // Nobody has consented: cannot record.
  assert.equal(sessionA.canRecord(), false);
  // Only I consent: still cannot record.
  sessionA.setRecordingConsent(true);
  await flush();
  assert.equal(sessionA.canRecord(), false);
  // The remote consents too: now it can record.
  sessionB.setRecordingConsent(true);
  await flush();
  assert.equal(sessionA.canRecord(), true);
  assert.equal(sessionB.canRecord(), true);
  // Withdrawal stops it.
  sessionB.setRecordingConsent(false);
  await flush();
  assert.equal(sessionA.canRecord(), false);
  // The recorder refuses without consent, and reports
  // unavailable in Node (no MediaRecorder).
  const recorder = new LocalCallRecorder(sessionA, browserRecorderFactory());
  assert.equal(recorder.recording, false);
  sessionA.end();
});

test("CallManager: a second invite while busy is declined, not rung", async () => {
  const { a, b } = makePair();
  const sessionA = a.manager.startCall("peer-b", "peer-b@example.arknetz", "voice");
  const started = sessionA.start();
  await flush();
  const sessionB = b.incoming[0];
  assert.ok(sessionB);
  await sessionB.accept();
  await started;
  // A second call to the same peer while the first is connected:
  // B's manager must decline it, not ring it.
  const incomingBefore = b.incoming.length;
  const sessionA2 = a.manager.startCall("peer-b", "peer-b@example.arknetz", "voice");
  const started2 = sessionA2.start();
  // Attach the rejection handler BEFORE the flush: the decline
  // arrives during the flush, and a promise that rejects with no
  // handler attached is an unhandled rejection.
  const rejected2 = assert.rejects(started2, /Call failed/);
  await flush();
  assert.equal(b.incoming.length, incomingBefore);
  await rejected2;
  assert.equal(sessionA2.state, "declined");
  sessionA.end();
  sessionB.end();
});

test("CallManager: invite from a different peer while busy is also declined", async () => {
  const { a, b } = makePair();
  const sessionA = a.manager.startCall("peer-b", "peer-b@example.arknetz", "voice");
  const started = sessionA.start();
  await flush();
  const sessionB = b.incoming[0];
  assert.ok(sessionB);
  await sessionB.accept();
  await started;
  // Simulate a third peer inviting B while B is in a call: route
  // the invite straight at B's manager.
  const before = b.incoming.length;
  await b.manager.routeControl("peer-c", {
    t: "call-invite",
    v: "arknetz-media/1",
    callId: "call-third-peer",
    fromPeerId: "peer-c",
    fromAddress: "peer-c@example.arknetz",
    kind: "voice",
    at: Date.now(),
  });
  await flush();
  assert.equal(b.incoming.length, before);
  sessionA.end();
  sessionB.end();
});
