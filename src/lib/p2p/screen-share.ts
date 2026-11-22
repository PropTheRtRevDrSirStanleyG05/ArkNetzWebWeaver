// ArkNetzWebWeaver — Screensharing over a call.
//
// Desktop: getDisplayMedia screen track, swapped into the ongoing
// call's video sender with replaceTrack (no renegotiation), camera
// restored on stop. Android: a typed stub — screen capture needs
// the native MediaProjection API, which the WebView does not expose
// and Tauri does not bridge. The stub throws a plain error with
// the exact missing capability BEFORE touching any media device:
// it never pretends to work, never returns a black track, never
// silently degrades to the camera. See MEDIA-SPEC.md §5.

import type { CallSession } from "./call-session.js";
import type { MediaDevicesLike, MediaStreamLike, MediaTrackLike } from "./media-devices.js";
import {
  detectScreenShareSupport,
  type ScreenShareSupport,
  type ScreenShareUnsupportedReason,
} from "./media-devices.js";

/** Thrown when screen sharing cannot start here. `reason` is a
 *  stable machine-readable string; the UI shows `detail`. */
export class ScreenShareUnavailableError extends Error {
  readonly reason: ScreenShareUnsupportedReason | "no-call" | "no-video-sender" | "capture-failed";
  constructor(reason: ScreenShareUnavailableError["reason"], detail: string) {
    super(detail);
    this.name = "ScreenShareUnavailableError";
    this.reason = reason;
  }
}

/** One screen-share session, bound to one call. */
export class ScreenShareSession {
  private screenStream: MediaStreamLike | null = null;
  private screenTrack: MediaTrackLike | null = null;
  private readonly userAgent: string;
  private readonly devices: MediaDevicesLike;

  constructor(devices: MediaDevicesLike, userAgent: string) {
    this.devices = devices;
    this.userAgent = userAgent;
  }

  /** Can screen sharing work on this device? Pure detection — no
   *  media is touched. */
  support(): ScreenShareSupport {
    const hasGetDisplayMedia = this.devices.hasGetDisplayMedia ?? true;
    return detectScreenShareSupport(this.userAgent, hasGetDisplayMedia);
  }

  get sharing(): boolean {
    return this.screenTrack !== null;
  }

  /** Start sharing the screen into an ongoing call. The screen
   *  track replaces the camera track on the call's video sender;
   *  the camera track is kept by the call and restored on stop.
   *  Throws ScreenShareUnavailableError when sharing is not
   *  possible here (Android stub, no call, no video sender, or
   *  the capture itself failed). */
  async start(call: CallSession): Promise<MediaTrackLike> {
    if (this.sharing) return this.screenTrack as MediaTrackLike;
    const support = this.support();
    if (!support.supported) {
      throw new ScreenShareUnavailableError(support.reason, support.detail);
    }
    if (call.state !== "connected") {
      throw new ScreenShareUnavailableError("no-call", "Screen sharing needs an active call.");
    }
    let stream: MediaStreamLike;
    try {
      stream = await this.devices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      throw new ScreenShareUnavailableError(
        "capture-failed",
        err instanceof Error ? `Screen capture failed: ${err.message}` : "Screen capture failed.",
      );
    }
    const tracks = stream.getVideoTracks();
    const track = tracks[0];
    if (!track) {
      throw new ScreenShareUnavailableError("capture-failed", "Screen capture returned no video track.");
    }
    const replaced = await call.replaceVideoTrack(track);
    if (!replaced) {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
      throw new ScreenShareUnavailableError(
        "no-video-sender",
        "This call has no video sender to share the screen through (voice-only call).",
      );
    }
    this.screenStream = stream;
    this.screenTrack = track;
    // The OS picker can end the share ("Stop sharing" in the
    // browser chrome): wire it to the same stop path so a share is
    // never left dangling. Fake tracks have no onended; the real
    // track does — attach defensively.
    const realTrack = track.realTrack as unknown as { onended?: (() => void) | null } | undefined;
    if (realTrack && "onended" in realTrack) {
      realTrack.onended = () => {
        void this.stop(call);
      };
    }
    return track;
  }

  /** Stop sharing and restore the camera track on the call. Safe
   *  to call when not sharing (no-op). */
  async stop(call: CallSession): Promise<void> {
    if (!this.sharing) return;
    const track = this.screenTrack;
    this.screenTrack = null;
    this.screenStream = null;
    try {
      await call.restoreVideoTrack();
    } catch {
      // The call may already be gone — the camera restore is
      // best-effort here; the call teardown stops its tracks.
    }
    if (track) {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
    }
  }
}
