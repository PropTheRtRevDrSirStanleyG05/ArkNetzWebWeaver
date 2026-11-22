// Tests: P2P screen sharing — desktop start/stop/restore, the
// Android stub (never faked), and the failure paths. No real
// getDisplayMedia exists in Node; the fake devices stand in.
import test from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "../src/lib/p2p/call-session.js";
import {
  FakeMediaConnection,
  FakeMediaConnectionFactory,
  type MediaConnection,
  type MediaConnectionFactory,
} from "../src/lib/p2p/media-connection.js";
import { FakeMediaDevices } from "../src/lib/p2p/media-devices.js";
import {
  ScreenShareSession,
  ScreenShareUnavailableError,
} from "../src/lib/p2p/screen-share.js";

const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 Chrome/120.0";

function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A connected video call session (direct, no managers) for the
 *  screen-share tests to attach to. */
async function connectedVideoCall(): Promise<{ sessionA: CallSession; sessionB: CallSession }> {
  const hub = new PairingHubForTest();
  const devicesA = new FakeMediaDevices();
  const devicesB = new FakeMediaDevices();
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  let sessionA: CallSession;
  let sessionB: CallSession;
  sessionA = new CallSession({
    callId: "call-screen-1",
    kind: "video",
    selfPeerId: "peer-a",
    selfAddress: "peer-a@example.arknetz",
    remotePeerId: "peer-b",
    remoteAddress: "peer-b@example.arknetz",
    devices: devicesA,
    mediaFactory: hub.factoryFor("peer-a"),
    iceServers,
    sendControl: (msg) => {
      if (msg.t === "call-invite") sessionB.markRinging();
      else void sessionB.handleControl(msg);
    },
    onEvent: () => undefined,
    inviteTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    statsIntervalMs: 0,
  });
  sessionB = new CallSession({
    callId: "call-screen-1",
    kind: "video",
    selfPeerId: "peer-b",
    selfAddress: "peer-b@example.arknetz",
    remotePeerId: "peer-a",
    remoteAddress: "peer-a@example.arknetz",
    devices: devicesB,
    mediaFactory: hub.factoryFor("peer-b"),
    iceServers,
    sendControl: (msg) => {
      void sessionA.handleControl(msg);
    },
    onEvent: () => undefined,
    inviteTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    statsIntervalMs: 0,
  });
  const started = sessionA.start();
  await flush();
  await sessionB.accept();
  await started;
  return { sessionA, sessionB };
}

// Small pairing hub (same idea as the call-session tests: fake
// media connections are paired across the two factory instances).
class PairingHubForTest {
  private readonly pending = new Map<string, FakeMediaConnection>();
  factoryFor(selfPeerId: string): MediaConnectionFactory {
    const hub = this;
    return {
      createConnection(peerId: string, _config: RTCConfiguration): MediaConnection {
        const conn = new FakeMediaConnection(peerId);
        const reverseKey = `${peerId}->${selfPeerId}`;
        const twin = hub.pending.get(reverseKey);
        if (twin) {
          hub.pending.delete(reverseKey);
          conn.pairWith(twin);
        } else {
          hub.pending.set(`${selfPeerId}->${peerId}`, conn);
        }
        return conn;
      },
    };
  }
}

test("screen share (desktop): start swaps the camera for the screen, stop restores it", async () => {
  const { sessionA, sessionB } = await connectedVideoCall();
  const devices = new FakeMediaDevices();
  const share = new ScreenShareSession(devices, DESKTOP_UA);
  assert.equal(share.support().supported, true);
  assert.equal(share.sharing, false);
  const screenTrack = await share.start(sessionA);
  assert.equal(share.sharing, true);
  assert.equal(screenTrack.kind, "video");
  // The remote side now receives the screen track instead of the camera.
  await flush();
  const connB = sessionB.mediaConnection as FakeMediaConnection;
  assert.ok(connB.receivedTracks.some((t) => t.id === screenTrack.id));
  assert.equal(sessionA.sharingScreen, true);
  await share.stop(sessionA);
  assert.equal(share.sharing, false);
  assert.equal(sessionA.sharingScreen, false);
  // The camera track is back on the sender.
  await flush();
  const connA = sessionA.mediaConnection as FakeMediaConnection;
  const videoSender = connA.getSenders().find((s) => s.track?.kind === "video");
  assert.ok(videoSender?.track);
  assert.notEqual(videoSender?.track?.id, screenTrack.id);
  sessionA.end();
});

test("screen share: starting twice returns the same track", async () => {
  const { sessionA } = await connectedVideoCall();
  const share = new ScreenShareSession(new FakeMediaDevices(), DESKTOP_UA);
  const first = await share.start(sessionA);
  const second = await share.start(sessionA);
  assert.equal(first, second);
  await share.stop(sessionA);
  sessionA.end();
});

test("screen share (Android): the stub throws before touching any device", async () => {
  const { sessionA } = await connectedVideoCall();
  const devices = new FakeMediaDevices();
  const share = new ScreenShareSession(devices, ANDROID_UA);
  assert.equal(share.support().supported, false);
  await assert.rejects(share.start(sessionA), (err: unknown) => {
    assert.ok(err instanceof ScreenShareUnavailableError);
    assert.equal(err.reason, "android-media-projection-bridge-missing");
    return true;
  });
  // No capture was attempted: getDisplayMedia was never called.
  assert.equal(devices.lastDisplayMediaConstraints, null);
  assert.equal(share.sharing, false);
  sessionA.end();
});

test("screen share: no getDisplayMedia on this device is unsupported", async () => {
  const { sessionA } = await connectedVideoCall();
  const devices = new FakeMediaDevices();
  devices.hasGetDisplayMedia = false;
  const share = new ScreenShareSession(devices, DESKTOP_UA);
  assert.equal(share.support().supported, false);
  await assert.rejects(share.start(sessionA), (err: unknown) => {
    assert.ok(err instanceof ScreenShareUnavailableError);
    assert.equal(err.reason, "get-display-media-missing");
    return true;
  });
  sessionA.end();
});

test("screen share: capture failure is a typed error, not a crash", async () => {
  const { sessionA } = await connectedVideoCall();
  const devices = new FakeMediaDevices();
  devices.failDisplayMedia = new Error("Permission denied by user");
  const share = new ScreenShareSession(devices, DESKTOP_UA);
  await assert.rejects(share.start(sessionA), (err: unknown) => {
    assert.ok(err instanceof ScreenShareUnavailableError);
    assert.equal(err.reason, "capture-failed");
    return true;
  });
  assert.equal(share.sharing, false);
  sessionA.end();
});

test("screen share: voice-only call has no video sender to share through", async () => {
  const devices = new FakeMediaDevices();
  const voice = new CallSession({
    callId: "call-voice-only",
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
    inviteTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
    statsIntervalMs: 0,
  });
  // Fake a connected voice call: no video sender exists.
  const share = new ScreenShareSession(new FakeMediaDevices(), DESKTOP_UA);
  await assert.rejects(share.start(voice), (err: unknown) => {
    assert.ok(err instanceof ScreenShareUnavailableError);
    // Not connected yet, so the no-call reason fires first.
    assert.equal(err.reason, "no-call");
    return true;
  });
});
