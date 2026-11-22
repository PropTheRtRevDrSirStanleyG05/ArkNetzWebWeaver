// Tests: P2P group calls — mesh threshold, volunteer-only mixer
// election (scores, ties, re-election), selective forwarding, mesh
// fallback on shrink, and degraded-mixer step-down. No real WebRTC
// exists in Node; the fake media pair is the whole call under test.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FakeMediaConnection,
  FakeMediaConnectionFactory,
  type MediaConnection,
} from "../src/lib/p2p/media-connection.js";
import { FakeMediaDevices } from "../src/lib/p2p/media-devices.js";
import { electMixer, electionScore, type MediaControlMessage } from "../src/lib/p2p/media.js";
import { GroupCall, type GroupEvent } from "../src/lib/p2p/mixer.js";

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestPeer {
  group: GroupCall;
  events: GroupEvent[];
  sent: MediaControlMessage[];
  connections: Map<string, FakeMediaConnection>;
}

/** A group-call peer whose media connections are fake pairs held
 *  in `connections` (tests pair them by hand where needed). */
function makeGroupPeer(
  selfPeerId: string,
  volunteerMixer: boolean,
  opts: { now?: () => number } = {},
): TestPeer {
  const events: GroupEvent[] = [];
  const sent: MediaControlMessage[] = [];
  const connections = new Map<string, FakeMediaConnection>();
  const group = new GroupCall({
    groupId: "group-test-1",
    selfPeerId,
    selfAddress: `${selfPeerId}@example.arknetz`,
    volunteerMixer,
    mediaConnector: (peerId: string) => {
      let conn = connections.get(peerId);
      if (!conn) {
        conn = new FakeMediaConnection(peerId);
        connections.set(peerId, conn);
      }
      return conn as MediaConnection;
    },
    sendControl: (message) => {
      sent.push(message);
    },
    onEvent: (event) => events.push(event),
    now: opts.now,
  });
  return { group, events, sent, connections };
}

test("electionScore: uplink dominates, headroom breaks near-ties, unmeasured cannot win", () => {
  assert.equal(electionScore(0, 1), 0.3);
  assert.equal(electionScore(10_000, 1), 1);
  assert.equal(electionScore(20_000, 1), 1); // Capped at 10 Mbps.
  assert.ok(electionScore(5_000, 1) > electionScore(4_000, 1));
  assert.ok(electionScore(5_000, 0.9) > electionScore(5_000, 0.1));
});

test("electMixer: highest score wins, ties break by smaller peerId, non-volunteers never win", () => {
  assert.equal(
    electMixer([
      { peerId: "peer-b", score: 0.5, volunteer: true },
      { peerId: "peer-a", score: 0.9, volunteer: true },
      { peerId: "peer-c", score: 0.99, volunteer: false },
    ]),
    "peer-a",
  );
  assert.equal(
    electMixer([
      { peerId: "peer-b", score: 0.7, volunteer: true },
      { peerId: "peer-a", score: 0.7, volunteer: true },
    ]),
    "peer-a",
  );
  assert.equal(electMixer([{ peerId: "peer-a", score: 0.9, volunteer: false }]), null);
  assert.equal(electMixer([]), null);
});

test("group call: mesh at 5 participants, no mixer elected", () => {
  const { group, events } = makeGroupPeer("peer-a", true);
  group.join(5_000, 0.9);
  assert.equal(group.mode, "mesh");
  assert.equal(group.mixerPeerId, null);
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  assert.equal(group.size, 5);
  assert.equal(group.mode, "mesh");
  assert.equal(group.mixerPeerId, null);
  assert.equal(events.filter((e) => e.type === "mixer-elected").length, 0);
});

test("group call: 6th participant elects the best volunteer as mixer", () => {
  const { group, events } = makeGroupPeer("peer-a", true);
  group.join(5_000, 0.9); // Self: score 0.35 + 0.27 = 0.62.
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  assert.equal(group.mode, "mesh");
  // peer-f volunteers with a much better uplink.
  group.addParticipant("peer-f", "peer-f@example.arknetz", true, 9_000, 0.9);
  assert.equal(group.size, 6);
  assert.equal(group.mode, "mixer");
  assert.equal(group.mixerPeerId, "peer-f");
  const elected = events.filter((e) => e.type === "mixer-elected");
  assert.equal(elected.length, 1);
  assert.equal(elected[0]?.type === "mixer-elected" ? elected[0].mixerPeerId : "", "peer-f");
});

test("group call: no volunteer past the threshold stays in mesh and says so", () => {
  const { group, events } = makeGroupPeer("peer-a", false);
  group.join(8_000, 1);
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  assert.equal(group.size, 6);
  assert.equal(group.mode, "mesh");
  assert.equal(group.mixerPeerId, null);
  assert.equal(events.filter((e) => e.type === "no-volunteer").length, 1);
});

test("group call: mixer leaving re-elects the next volunteer", () => {
  const { group } = makeGroupPeer("peer-a", true);
  group.join(5_000, 0.9);
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e", "peer-g"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  group.addParticipant("peer-f", "peer-f@example.arknetz", true, 9_000, 0.9);
  assert.equal(group.size, 7);
  assert.equal(group.mixerPeerId, "peer-f");
  // peer-a also volunteers (score lower than peer-f). peer-f leaves:
  // 6 remain, so the group re-elects instead of falling to mesh.
  group.removeParticipant("peer-f");
  assert.equal(group.size, 6);
  assert.equal(group.mode, "mixer");
  assert.equal(group.mixerPeerId, "peer-a");
});

test("group call: a marginally better volunteer does not displace the live mixer", () => {
  const { group } = makeGroupPeer("peer-a", true);
  group.join(5_000, 0.9);
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e", "peer-g"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  assert.equal(group.mixerPeerId, "peer-a"); // Only volunteer so far.
  // A new volunteer whose score is only 0.042 above the incumbent
  // (below MIXER_SWITCH_MARGIN 0.1) must not cause a disruptive
  // mid-call mixer switch.
  group.addParticipant("peer-h", "peer-h@example.arknetz", true, 5_600, 0.9);
  assert.equal(group.size, 7);
  assert.equal(group.mode, "mixer");
  assert.equal(group.mixerPeerId, "peer-a");
});

test("group call: shrinking back to 5 falls back to mesh", () => {
  const { group, events } = makeGroupPeer("peer-a", true);
  group.join(5_000, 0.9);
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  group.addParticipant("peer-f", "peer-f@example.arknetz", true, 9_000, 0.9);
  assert.equal(group.mode, "mixer");
  group.removeParticipant("peer-f");
  // Still 6? No: peer-f left, so 5 remain (a–e) — wait, peer-a is
  // the mixer now, and the group is 5: mesh again.
  assert.equal(group.size, 5);
  assert.equal(group.mode, "mesh");
  assert.equal(group.mixerPeerId, null);
  assert.ok(events.some((e) => e.type === "mode" && e.mode === "mesh"));
});

test("mixer forwarding: a track from one participant is forwarded to the others, not back to itself", async () => {
  const { group } = makeGroupPeer("peer-a", true);
  group.join(8_000, 1);
  // Five more join so the group is 6 and peer-a (volunteer, best
  // score among volunteers — the only volunteer) is the mixer.
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  assert.equal(group.mode, "mixer");
  assert.equal(group.mixerPeerId, "peer-a");
  assert.equal(group.isMixer, true);
  // Wire fake media connections: the mixer's PC to each
  // participant is a fake pair whose twin is the participant's PC.
  const factory = new FakeMediaConnectionFactory();
  const devices = new FakeMediaDevices();
  const streamB = devices.makeStream(true);
  const audioB = streamB.getAudioTracks()[0];
  assert.ok(audioB);
  // The mixer's connection to peer-b is created lazily by
  // forwarding; pre-create pairs for b/c/d so the forwards land.
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]) {
    const [mixerSide] = factory.createPair(`mixer->${id}`, id);
    // Hand the mixer side to the group's connector cache by
    // asking the group for the connection (it caches it).
    const conn = group.connectionTo(id);
    // Pair the group's connection with the participant's side.
    (conn as FakeMediaConnection).pairWith(mixerSide);
  }
  // peer-b sends an audio track into the mixer (via its side of
  // the pair): the mixer's onRemoteTrack fires and forwards it.
  const connToB = group.connectionTo("peer-b") as FakeMediaConnection;
  const twinB = connToB.twin as FakeMediaConnection;
  assert.ok(twinB);
  twinB.addTrack(audioB, streamB);
  await flush();
  // Forwarded to c, d, e, f (4 targets) but not back to b, and not
  // to the mixer itself.
  assert.equal(group.forwardingCount(), 4);
  for (const id of ["peer-c", "peer-d", "peer-e", "peer-f"]) {
    const conn = group.connectionTo(id) as FakeMediaConnection;
    assert.equal(conn.getSenders().length, 1);
    assert.equal(conn.getSenders()[0]?.track, audioB);
  }
  const connB2 = group.connectionTo("peer-b") as FakeMediaConnection;
  assert.equal(connB2.getSenders().length, 0);
});

test("mixer forwarding: participant leaving drops its forwards", async () => {
  const { group } = makeGroupPeer("peer-a", true);
  group.join(8_000, 1);
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  assert.equal(group.isMixer, true);
  const factory = new FakeMediaConnectionFactory();
  const devices = new FakeMediaDevices();
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]) {
    const [mixerSide] = factory.createPair(`mixer->${id}`, id);
    const conn = group.connectionTo(id);
    (conn as FakeMediaConnection).pairWith(mixerSide);
  }
  const streamB = devices.makeStream(true);
  const audioB = streamB.getAudioTracks()[0];
  assert.ok(audioB);
  const connToB = group.connectionTo("peer-b") as FakeMediaConnection;
  const twinB = connToB.twin as FakeMediaConnection;
  twinB.addTrack(audioB, streamB);
  await flush();
  assert.equal(group.forwardingCount(), 4);
  // peer-c leaves: its forward is dropped, and the group shrinks
  // to 5 — back to mesh, forwarding cleared.
  group.removeParticipant("peer-c");
  assert.equal(group.mode, "mesh");
  assert.equal(group.forwardingCount(), 0);
});

test("mixer health: a degraded mixer steps down and the group re-elects", () => {
  let now = 1_000_000;
  const { group, events } = makeGroupPeer("peer-a", true, { now: () => now });
  group.join(8_000, 1);
  for (const id of ["peer-b", "peer-c", "peer-d", "peer-e", "peer-g"]) {
    group.addParticipant(id, `${id}@example.arknetz`, false, 1_000, 0.5);
  }
  group.addParticipant("peer-f", "peer-f@example.arknetz", true, 9_000, 0.9);
  group.addParticipant("peer-h", "peer-h@example.arknetz", true, 8_000, 0.9);
  // peer-f is the mixer (best score). Remove it: 7 remain, and
  // peer-a wins the re-election on the peerId tie-break (a and h
  // both score 0.86).
  group.removeParticipant("peer-f");
  assert.equal(group.size, 7);
  assert.equal(group.mixerPeerId, "peer-a");
  assert.equal(group.isMixer, true);
  // Healthy report: no step-down.
  group.reportMeasurements(8_000, 1);
  assert.equal(group.mixerPeerId, "peer-a");
  // Degraded, but not yet past the 30 s window: still mixer.
  group.reportMeasurements(1_000, 0.1);
  assert.equal(group.mixerPeerId, "peer-a");
  // Past the window: steps down, mixer-lost fires, the group
  // re-elects peer-h (the next-best volunteer).
  now += 31_000;
  group.reportMeasurements(1_000, 0.1);
  assert.equal(group.mixerPeerId, "peer-h");
  assert.equal(group.mode, "mixer");
  assert.ok(events.some((e) => e.type === "mixer-lost"));
});

test("group call: handleControl routes joins, leaves, and mixer messages", () => {
  const { group } = makeGroupPeer("peer-a", true);
  group.join(5_000, 0.9);
  group.handleControl({
    t: "group-join",
    groupId: "group-test-1",
    peerId: "peer-b",
    address: "peer-b@example.arknetz",
    volunteerMixer: false,
    uplinkKbps: 2_000,
    cpuHeadroom: 0.8,
  });
  assert.equal(group.size, 2);
  assert.ok(group.participants.has("peer-b"));
  group.handleControl({ t: "group-leave", groupId: "group-test-1", peerId: "peer-b" });
  assert.equal(group.size, 1);
  // A message for another group is ignored.
  group.handleControl({
    t: "group-join",
    groupId: "group-other",
    peerId: "peer-z",
    address: "peer-z@example.arknetz",
    volunteerMixer: false,
  });
  assert.equal(group.size, 1);
  // Unknown group-join fields are tolerated (defaults apply).
  group.handleControl({
    t: "mixer-elect",
    groupId: "group-test-1",
    mixerPeerId: "peer-ghost",
    electedBy: "peer-a",
  });
  assert.equal(group.mixerPeerId, null); // Ghost is not a participant.
});

test("group call: leave clears state and announces", () => {
  const { group, sent } = makeGroupPeer("peer-a", true);
  group.join(5_000, 0.9);
  group.addParticipant("peer-b", "peer-b@example.arknetz", false, 1_000, 0.5);
  assert.equal(group.size, 2);
  group.leave();
  assert.equal(group.size, 0);
  assert.equal(group.mode, "mesh");
  assert.ok(sent.some((m) => m.t === "group-leave"));
});
