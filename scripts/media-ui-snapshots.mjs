// Media-UI snapshot generator: renders the pure Calls panel
// renderer (renderCallsPanelHtml) into static HTML files under
// dist/.media-shots/ so the CDP harness can screenshot states
// the live headless app cannot reach (ringing, active call,
// mixer-routed group) at desktop + 390px widths.
// Usage: node scripts/media-ui-snapshots.mjs <dist-dir>
// (run after `npm run build`; the harness deletes .media-shots/ after).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderCallsPanelHtml } from "../dist/src/lib/p2p/call-panel.js";

const distDir = process.argv[2];
if (!distDir) {
  console.error("usage: node scripts/media-ui-snapshots.mjs <dist-dir>");
  process.exit(2);
}
const outDir = path.join(distDir, ".media-shots");
mkdirSync(outDir, { recursive: true });

function shell(title, panelHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main id="app" style="padding:.5rem 1rem">
${panelHtml}
</main>
</body>
</html>
`;
}

const base = {
  available: true,
  mediaOn: true,
  groupsOn: true,
  voiceOn: true,
  videoOn: true,
  screenShareOn: true,
  selfAddress: "peer-a@example.arknetz",
  peers: [
    { peerId: "peer-b", address: "peer-b@example.arknetz" },
    { peerId: "peer-c", address: "peer-c@example.arknetz" },
  ],
  callAddressDraft: "",
  incoming: null,
  active: null,
  group: null,
  groupInvite: null,
  screenShareSupported: true,
  screenShareNote: null,
  lastError: null,
};

const snapshots = {
  "snap-ringing": {
    ...base,
    incoming: { callId: "call-0123456789abcdef0123456789abcdef", kind: "video", fromAddress: "peer-b@example.arknetz" },
  },
  "snap-active-desktop": {
    ...base,
    active: {
      callId: "call-0123456789abcdef0123456789abcdef",
      kind: "video",
      peerAddress: "peer-b@example.arknetz",
      state: "connected",
      muted: false,
      videoEnabled: true,
      sharingScreen: true,
      remoteMuted: false,
      remoteVideoOn: true,
      remoteSharingScreen: false,
      qualityMode: "full",
      diagnostics: "Connection path: Direct (host) — 12 ms round-trip.",
      relayed: false,
      hasRemoteVideo: true,
      hasRemoteAudio: true,
      hasLocalVideo: true,
      myConsent: true,
      remoteConsent: true,
      canRecord: true,
      recording: true,
      remoteRecording: false,
    },
  },
  "snap-active-android": {
    ...base,
    screenShareSupported: false,
    screenShareNote:
      "Screen sharing on Android needs a native MediaProjection bridge, which is not built yet. Screen sharing works on desktop.",
    active: {
      callId: "call-0123456789abcdef0123456789abcdef",
      kind: "video",
      peerAddress: "peer-b@example.arknetz",
      state: "connected",
      muted: false,
      videoEnabled: true,
      sharingScreen: false,
      remoteMuted: false,
      remoteVideoOn: true,
      remoteSharingScreen: false,
      qualityMode: "full",
      diagnostics: "Connection path: Relayed (srflx → relay) — video calls over a relay use shared relay capacity.",
      relayed: true,
      hasRemoteVideo: true,
      hasRemoteAudio: true,
      hasLocalVideo: true,
      myConsent: true,
      remoteConsent: true,
      canRecord: true,
      recording: true,
      remoteRecording: true,
    },
  },
  "snap-group-mixer": {
    ...base,
    group: {
      groupId: "group-0123456789abcdef0123456789abcdef",
      mode: "mixer",
      mixerPeerId: "peer-b",
      isMixer: false,
      participants: [
        { peerId: "peer-a", address: "peer-a@example.arknetz", volunteer: false, isSelf: true, isMixer: false, hasVideo: true },
        { peerId: "peer-b", address: "peer-b@example.arknetz", volunteer: true, isSelf: false, isMixer: true, hasVideo: true },
        { peerId: "peer-c", address: "peer-c@example.arknetz", volunteer: false, isSelf: false, isMixer: false, hasVideo: true },
        { peerId: "peer-d", address: "peer-d@example.arknetz", volunteer: false, isSelf: false, isMixer: false, hasVideo: false },
        { peerId: "peer-e", address: "peer-e@example.arknetz", volunteer: true, isSelf: false, isMixer: false, hasVideo: true },
        { peerId: "peer-f", address: "peer-f@example.arknetz", volunteer: false, isSelf: false, isMixer: false, hasVideo: true },
      ],
      noVolunteer: false,
      mixerLost: null,
    },
  },
  "snap-group-self-mixer": {
    ...base,
    group: {
      groupId: "group-0123456789abcdef0123456789abcdef",
      mode: "mixer",
      mixerPeerId: "peer-a",
      isMixer: true,
      participants: [
        { peerId: "peer-a", address: "peer-a@example.arknetz", volunteer: true, isSelf: true, isMixer: true, hasVideo: true },
        { peerId: "peer-b", address: "peer-b@example.arknetz", volunteer: true, isSelf: false, isMixer: false, hasVideo: true },
        { peerId: "peer-c", address: "peer-c@example.arknetz", volunteer: false, isSelf: false, isMixer: false, hasVideo: true },
        { peerId: "peer-d", address: "peer-d@example.arknetz", volunteer: false, isSelf: false, isMixer: false, hasVideo: false },
        { peerId: "peer-e", address: "peer-e@example.arknetz", volunteer: false, isSelf: false, isMixer: false, hasVideo: true },
        { peerId: "peer-f", address: "peer-f@example.arknetz", volunteer: false, isSelf: false, isMixer: false, hasVideo: true },
      ],
      noVolunteer: false,
      mixerLost: null,
    },
  },
};

for (const [name, vm] of Object.entries(snapshots)) {
  const html = shell(`Calls — ${name}`, renderCallsPanelHtml(vm));
  writeFileSync(path.join(outDir, `${name}.html`), html);
  console.log("wrote", name);
}
console.log("done");
