// ArkNetzWebWeaver — Real-time media over P2P (arknetz-media/1).
// Encrypted voice, video calling, screensharing, group calls with a
// peer-volunteered mixer. See MEDIA-SPEC.md for the full spec; this
// file is the shared types, constants, settings, and control-message
// framing. No network, no storage, no DOM access here — pure types
// and pure functions. Media is OFF by default like all of P2P.

import type { P2PSettings } from "./types.js";
import { defaultMediaSettings, defaultP2PSettings, type MediaSettings } from "./types.js";

/** Re-exported from types.ts (the settings store carries them, and
 *  media.ts cannot own them without a module cycle). */
export { defaultMediaSettings, type MediaSettings };

/** Media protocol version string (carried in call-invite). */
export const MEDIA_PROTOCOL_VERSION = "arknetz-media/1";

/** Data-channel label for call control. Defined here (not in the
 *  phase-1 P2P_CHANNEL_LABELS map, which this phase does not edit):
 *  the label is just a string, and the media channel is opened on
 *  the existing P2P data connection. */
export const MEDIA_CHANNEL_LABEL = "arknetz/media";

/** Mesh ceiling: at or below this many participants a group call
 *  is a mesh (every peer holds one media PC per other participant).
 *  Above it the group elects a volunteer mixer (MEDIA-SPEC.md §6).
 *  A coordinator may lower it, never raise it above 5 in v1. */
export const MESH_MAX_PARTICIPANTS = 5;

/** A new volunteer only displaces the current mixer if it is
 *  clearly better than the incumbent, so a group does not flap
 *  between two near-equal mixers on every join (MEDIA-SPEC.md §6). */
export const MIXER_SWITCH_MARGIN = 0.1;

/** A call has no GitHub fallback (MEDIA-SPEC.md §9.1): if ICE
 *  fails and no relay is configured, the call fails with this
 *  reason so the UI can say exactly that. */
export const CALL_NO_RELAY_REASON = "no-relay";

/** Quality-monitor thresholds (MEDIA-SPEC.md §7.2). Hysteresis
 *  stops the mode flapping on a noisy link. */
export const VIDEO_DEGRADE_KBPS = 300;
export const VIDEO_RESTORE_KBPS = 600;
export const VIDEO_DEGRADE_DWELL_MS = 5_000;
export const VIDEO_RESTORE_DWELL_MS = 10_000;
/** Stats poll cadence while a call is connected. */
export const CALL_STATS_INTERVAL_MS = 2_000;
/** Mixer minimums for re-election (MEDIA-SPEC.md §6.3). */
export const MIXER_MIN_UPLINK_KBPS = 2_000;
export const MIXER_MIN_CPU_HEADROOM = 0.2;
export const MIXER_DEGRADE_WINDOW_MS = 30_000;

/** Call timeouts (MEDIA-SPEC.md §3). */
export const CALL_INVITE_TIMEOUT_MS = 60_000;
export const CALL_CONNECT_TIMEOUT_MS = 30_000;

/** 1:1 call kinds. */
export type CallKind = "voice" | "video";

/** 1:1 call states (MEDIA-SPEC.md §3). `failed` and `ended` and
 *  `declined` are terminal. */
export type CallState =
  | "idle"
  | "inviting"
  | "ringing"
  | "connecting"
  | "connected"
  | "ended"
  | "declined"
  | "failed";

/** Quality modes for a connected call. */
export type CallQualityMode = "full" | "audio-only";

/** Group call modes. */
export type GroupMode = "mesh" | "mixer";

/** P2P settings with the media block attached. Media now lives on
 *  P2PSettings itself (types.ts), so this is an alias kept for the
 *  phase-1 call sites that import the name. */
export type P2PSettingsWithMedia = P2PSettings;

export function defaultP2PSettingsWithMedia(): P2PSettingsWithMedia {
  return defaultP2PSettings();
}

// ---------------------------------------------------------------------------
// Call control messages — JSON on the arknetz/media channel, framed
// [0x01][UTF-8 JSON] per the P2P frame format (P2P-SPEC.md §4.2).
// ---------------------------------------------------------------------------

export type MediaControlMessage =
  | { t: "call-invite"; v: string; callId: string; fromPeerId: string; fromAddress: string; kind: CallKind; at: number }
  | { t: "call-offer"; callId: string; sdp: RTCSessionDescriptionInit }
  | { t: "call-answer"; callId: string; sdp: RTCSessionDescriptionInit }
  | { t: "call-ice"; callId: string; candidate: RTCIceCandidateInit }
  | { t: "call-accept"; callId: string }
  | { t: "call-decline"; callId: string; reason?: string }
  | { t: "call-bye"; callId: string; reason?: string }
  | { t: "call-mute"; callId: string; fromPeerId: string; audio: boolean }
  | { t: "call-video"; callId: string; fromPeerId: string; video: boolean }
  | { t: "call-screen"; callId: string; fromPeerId: string; sharing: boolean }
  | { t: "call-quality"; callId: string; fromPeerId: string; mode: CallQualityMode }
  | { t: "record-consent"; callId: string; fromPeerId: string; recording: boolean }
  | { t: "recording-active"; callId: string; fromPeerId: string; active: boolean }
  | { t: "group-join"; groupId: string; peerId: string; address: string; volunteerMixer: boolean; uplinkKbps?: number; cpuHeadroom?: number }
  | { t: "group-leave"; groupId: string; peerId: string }
  | { t: "mixer-announce"; groupId: string; peerId: string; score: number; volunteer: boolean }
  | { t: "mixer-elect"; groupId: string; mixerPeerId: string; electedBy: string }
  | { t: "mixer-ready"; groupId: string; mixerPeerId: string }
  | { t: "mixer-lost"; groupId: string; mixerPeerId: string; reason: string }
  /** The coordinator found no volunteer at all past the mesh
   *  ceiling: the group stays in mesh and every participant is
   *  told why (MEDIA-SPEC.md §6.3). */
  | { t: "no-volunteer"; groupId: string }
  /** Group-call invite (1:1, over the data channel): the inviter
   *  asks a connected peer to join a group. The invitee joins
   *  through their own accept — nobody is pulled in silently. */
  | { t: "group-invite"; groupId: string; fromPeerId: string; fromAddress: string; volunteerMixer: boolean; kind: CallKind }
  | { t: "group-decline"; groupId: string; fromPeerId: string }
  /** Mesh-leg negotiation (1:1, over the data channel). The lower
   *  peerId offers — both sides agree without negotiating, so a
   *  leg is never double-offered. */
  | { t: "group-offer"; groupId: string; fromPeerId: string; fromAddress: string; sdp: RTCSessionDescriptionInit }
  | { t: "group-answer"; groupId: string; fromPeerId: string; sdp: RTCSessionDescriptionInit }
  | { t: "group-ice"; groupId: string; fromPeerId: string; candidate: RTCIceCandidateInit };

/** Frame a media control message for the data channel. */
export function encodeMediaControl(message: MediaControlMessage): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(1 + json.byteLength);
  frame[0] = 0x01;
  frame.set(json, 1);
  return frame;
}

/** Parse one frame off the media channel. Returns null for anything
 *  that is not a well-formed media control frame — a bad frame is
 *  ignored, never fatal. */
export function decodeMediaControl(data: Uint8Array): MediaControlMessage | null {
  if (data.length < 2 || data[0] !== 0x01) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(data.subarray(1)));
    if (typeof parsed !== "object" || parsed === null) return null;
    const msg = parsed as { t?: unknown; callId?: unknown; groupId?: unknown };
    if (typeof msg.t !== "string") return null;
    const known = [
      "call-invite", "call-offer", "call-answer", "call-ice", "call-accept",
      "call-decline", "call-bye", "call-mute", "call-video", "call-screen",
      "call-quality", "record-consent", "recording-active", "group-join", "group-leave",
      "mixer-announce", "mixer-elect", "mixer-ready", "mixer-lost", "no-volunteer",
      "group-invite", "group-decline", "group-offer", "group-answer", "group-ice",
    ];
    if (!known.includes(msg.t)) return null;
    if (msg.t.startsWith("call-") && typeof msg.callId !== "string") return null;
    if ((msg.t.startsWith("group-") || msg.t.startsWith("mixer-")) && typeof msg.groupId !== "string") return null;
    return parsed as MediaControlMessage;
  } catch {
    return null;
  }
}

/** Mixer election score (MEDIA-SPEC.md §6.3): 70% measured uplink
 *  (capped at 10 Mbps), 30% self-reported CPU headroom (0..1).
 *  A peer that has never measured uplink scores 0 on that part and
 *  cannot win until it has. Pure function — fully testable. */
export function electionScore(uplinkKbps: number, cpuHeadroom: number): number {
  const uplinkPart = Math.min(Math.max(uplinkKbps, 0), 10_000) / 10_000;
  const cpuPart = Math.min(Math.max(cpuHeadroom, 0), 1);
  return 0.7 * uplinkPart + 0.3 * cpuPart;
}

/** Deterministic election pick: highest score wins; ties break by
 *  smaller peerId so both sides agree without negotiating. Returns
 *  null when there is no volunteer at all. */
export function electMixer(
  candidates: ReadonlyArray<{ peerId: string; score: number; volunteer: boolean }>,
): string | null {
  let best: { peerId: string; score: number } | null = null;
  for (const c of candidates) {
    if (!c.volunteer) continue;
    if (
      best === null ||
      c.score > best.score ||
      (c.score === best.score && c.peerId < best.peerId)
    ) {
      best = { peerId: c.peerId, score: c.score };
    }
  }
  return best?.peerId ?? null;
}

// ---------------------------------------------------------------------------
// UI copy. Plain words. Phase 2 drops these strings into the Calls
// panel and the P2P settings panel verbatim.
// ---------------------------------------------------------------------------

/** Shown when a call fails because no direct path and no relay exist. */
export const CALL_NO_RELAY_NOTE =
  "Could not connect directly and no relay is available. Add your own TURN key in Settings → P2P " +
  "to connect in more networks. Calls have no fallback — unlike sites, mail, and drive, there is no GitHub path for a live call.";

/** Shown while a call is relayed (MEDIA-SPEC.md §7.3). Information,
 *  not a limiter: the call is never throttled or ended for relay use. */
export const CALL_RELAYED_NOTE =
  "Relayed through a TURN server — video over a relay uses the relay's shared quota fast. " +
  "Direct connections are free and unlimited; a relay is only used when a direct connection fails.";

/** Shown next to the volunteer-mixer toggle. */
export const MIXER_VOLUNTEER_NOTE =
  "Volunteering as a mixer means your device receives every participant's audio and video and forwards it to the others. " +
  "It costs bandwidth and battery, and the mixer can technically access the media it forwards — the group always sees who the mixer is, " +
  "and you can stop volunteering at any time. Nobody is a mixer unless they turn this on.";

/** Shown in a mixer-routed call, naming the mixer. */
export function mixerRoutedNote(mixerPeerId: string): string {
  return `This call is routed through a volunteer mixer (${mixerPeerId}). The mixer forwards the group's media so the call works with more than 5 people.`;
}

/** Shown on Android where the screen-share button is disabled. */
export const SCREEN_SHARE_ANDROID_NOTE =
  "Screen sharing on Android needs a native MediaProjection bridge, which is not built yet. Screen sharing works on desktop.";
