// ArkNetzWebWeaver — Media devices: getUserMedia / getDisplayMedia
// behind an injectable interface, plus fake devices for tests.
//
// Node has no MediaStream, no MediaStreamTrack, and no
// navigator.mediaDevices — so every media type here is a small
// structural interface (MediaTrackLike / MediaStreamLike) that the
// real browser objects satisfy through thin wrappers, and that the
// fakes below implement directly. The call session and the mixer
// only ever see these interfaces, never the DOM types.

/** A media track: real MediaStreamTrack in the browser, fake in tests. */
export interface MediaTrackLike {
  readonly id: string;
  readonly kind: "audio" | "video";
  enabled: boolean;
  stop(): void;
  /** The underlying real track, when this wraps one. */
  readonly realTrack?: MediaStreamTrack;
}

/** A media stream: real MediaStream in the browser, fake in tests. */
export interface MediaStreamLike {
  readonly id: string;
  getTracks(): MediaTrackLike[];
  getAudioTracks(): MediaTrackLike[];
  getVideoTracks(): MediaTrackLike[];
  addTrack(track: MediaTrackLike): void;
  removeTrack(track: MediaTrackLike): void;
}

/** One device entry from enumerateDevices (kind + label only — the
 *  media core never needs more). */
export interface MediaDeviceInfoLike {
  readonly deviceId: string;
  readonly kind: "audioinput" | "audiooutput" | "videoinput";
  readonly label: string;
}

/** The media-devices surface the call session needs. Injected so
 *  tests can supply fakes; the browser implementation is
 *  `browserMediaDevices()` below. */
export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
  getDisplayMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
  enumerateDevices(): Promise<MediaDeviceInfoLike[]>;
  /** False when getDisplayMedia does not exist on this device
   *  (screen sharing is then unsupported — see screen-share.ts).
   *  The browser implementation reports it from
   *  navigator.mediaDevices; the fake reports its flag. */
  readonly hasGetDisplayMedia?: boolean;
}

/** Thrown when media devices are not available at all (Node, a
 *  WebView without WebRTC, a permission-denied browser). The
 *  `reason` is a stable machine-readable string; `detail` is the
 *  human sentence for the UI. */
export class MediaUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(detail);
    this.name = "MediaUnavailableError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Real wrappers (browser only).
// ---------------------------------------------------------------------------

class RealMediaTrack implements MediaTrackLike {
  readonly realTrack: MediaStreamTrack;
  constructor(track: MediaStreamTrack) {
    this.realTrack = track;
  }
  get id(): string {
    return this.realTrack.id;
  }
  get kind(): "audio" | "video" {
    return this.realTrack.kind === "video" ? "video" : "audio";
  }
  get enabled(): boolean {
    return this.realTrack.enabled;
  }
  set enabled(value: boolean) {
    this.realTrack.enabled = value;
  }
  stop(): void {
    this.realTrack.stop();
  }
}

class RealMediaStream implements MediaStreamLike {
  private readonly stream: MediaStream;
  constructor(stream: MediaStream) {
    this.stream = stream;
  }
  get id(): string {
    return this.stream.id;
  }
  private wrap(track: MediaStreamTrack): MediaTrackLike {
    return new RealMediaTrack(track);
  }
  getTracks(): MediaTrackLike[] {
    return this.stream.getTracks().map((t) => this.wrap(t));
  }
  getAudioTracks(): MediaTrackLike[] {
    return this.stream.getAudioTracks().map((t) => this.wrap(t));
  }
  getVideoTracks(): MediaTrackLike[] {
    return this.stream.getVideoTracks().map((t) => this.wrap(t));
  }
  addTrack(track: MediaTrackLike): void {
    if (track.realTrack) this.stream.addTrack(track.realTrack);
  }
  removeTrack(track: MediaTrackLike): void {
    if (track.realTrack) this.stream.removeTrack(track.realTrack);
  }
}

class BrowserMediaDevices implements MediaDevicesLike {
  private readonly md: MediaDevices;
  constructor(md: MediaDevices) {
    this.md = md;
  }
  get hasGetDisplayMedia(): boolean {
    return typeof this.md.getDisplayMedia === "function";
  }
  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike> {
    const stream = await this.md.getUserMedia(constraints);
    return new RealMediaStream(stream);
  }
  async getDisplayMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike> {
    const stream = await this.md.getDisplayMedia(constraints);
    return new RealMediaStream(stream);
  }
  async enumerateDevices(): Promise<MediaDeviceInfoLike[]> {
    const devices = await this.md.enumerateDevices();
    return devices.map((d) => ({
      deviceId: d.deviceId,
      kind: d.kind as MediaDeviceInfoLike["kind"],
      label: d.label,
    }));
  }
}

/** The browser's media devices, or a throw explaining why not.
 *  Callers catch MediaUnavailableError and report "media unavailable
 *  on this device" — the GitHub paths are unaffected. */
export function browserMediaDevices(): MediaDevicesLike {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new MediaUnavailableError(
      "media-devices-missing",
      "Media devices are not available in this environment — this device's WebView may not support WebRTC.",
    );
  }
  return new BrowserMediaDevices(navigator.mediaDevices);
}

/** Default audio constraints for a call: echo cancellation, noise
 *  suppression, and auto gain control ON. These three are the
 *  difference between a usable call and an echo chamber. */
export function defaultAudioConstraints(): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

/** Default video constraints for a call. No resolution is forced —
 *  the browser negotiates down on a weak device, and the quality
 *  monitor (call-session.ts) is the backstop, not a resolution cap. */
export function defaultVideoConstraints(): MediaStreamConstraints {
  return { video: true };
}

// ---------------------------------------------------------------------------
// Screen-share support detection (MEDIA-SPEC.md §5.2).
// ---------------------------------------------------------------------------

export type ScreenShareSupport =
  | { supported: true }
  | { supported: false; reason: ScreenShareUnsupportedReason; detail: string };

export type ScreenShareUnsupportedReason =
  | "android-media-projection-bridge-missing"
  | "get-display-media-missing";

/** Is this user agent Android? Screen capture on Android needs the
 *  native MediaProjection API, which no WebView exposes. */
export function isAndroidUserAgent(userAgent: string): boolean {
  return /Android/i.test(userAgent);
}

/** Detect whether screen sharing can work here. `hasGetDisplayMedia`
 *  is whether `navigator.mediaDevices.getDisplayMedia` is a
 *  function on this device. Android is unsupported even when the
 *  function happens to exist (it cannot capture the screen there).
 *  Pure function — fully testable. */
export function detectScreenShareSupport(
  userAgent: string,
  hasGetDisplayMedia: boolean,
): ScreenShareSupport {
  if (isAndroidUserAgent(userAgent)) {
    return {
      supported: false,
      reason: "android-media-projection-bridge-missing",
      detail:
        "Screen sharing on Android needs a native MediaProjection bridge, which is not built yet. " +
        "Screen sharing works on desktop.",
    };
  }
  if (!hasGetDisplayMedia) {
    return {
      supported: false,
      reason: "get-display-media-missing",
      detail: "This browser does not offer screen capture (getDisplayMedia is missing).",
    };
  }
  return { supported: true };
}

// ---------------------------------------------------------------------------
// Fakes (tests only).
// ---------------------------------------------------------------------------

export class FakeMediaTrack implements MediaTrackLike {
  readonly id: string;
  readonly kind: "audio" | "video";
  enabled = true;
  stopped = false;
  constructor(id: string, kind: "audio" | "video") {
    this.id = id;
    this.kind = kind;
  }
  stop(): void {
    this.stopped = true;
    this.enabled = false;
  }
}

export class FakeMediaStream implements MediaStreamLike {
  readonly id: string;
  private readonly tracks: MediaTrackLike[] = [];
  constructor(id: string, tracks: MediaTrackLike[] = []) {
    this.id = id;
    this.tracks.push(...tracks);
  }
  getTracks(): MediaTrackLike[] {
    return [...this.tracks];
  }
  getAudioTracks(): MediaTrackLike[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): MediaTrackLike[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(track: MediaTrackLike): void {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
  removeTrack(track: MediaTrackLike): void {
    const i = this.tracks.indexOf(track);
    if (i >= 0) this.tracks.splice(i, 1);
  }
}

/** Fake media devices for tests. `nextUserMedia` / `nextDisplayMedia`
 *  control what each call returns; `failUserMedia` makes
 *  getUserMedia throw (permission denied). `hasGetDisplayMedia`
 *  controls the support detection input. */
export class FakeMediaDevices implements MediaDevicesLike {
  private counter = 0;
  /** Streams returned by successive getUserMedia calls. */
  nextUserMedia: MediaStreamLike[] = [];
  /** Streams returned by successive getDisplayMedia calls. */
  nextDisplayMedia: MediaStreamLike[] = [];
  /** When set, getUserMedia throws this error. */
  failUserMedia: Error | null = null;
  /** When set, getDisplayMedia throws this error. */
  failDisplayMedia: Error | null = null;
  /** Fake device list for enumerateDevices. */
  devices: MediaDeviceInfoLike[] = [
    { deviceId: "mic-1", kind: "audioinput", label: "Fake microphone" },
    { deviceId: "cam-front", kind: "videoinput", label: "Fake front camera" },
    { deviceId: "cam-back", kind: "videoinput", label: "Fake back camera" },
  ];
  hasGetDisplayMedia = true;
  /** Constraints the last getUserMedia call asked for (asserted in tests). */
  lastUserMediaConstraints: MediaStreamConstraints | null = null;
  /** Constraints the last getDisplayMedia call asked for. */
  lastDisplayMediaConstraints: MediaStreamConstraints | null = null;

  /** Build a fresh fake stream with one audio and optionally one video track. */
  makeStream(withVideo: boolean): FakeMediaStream {
    this.counter += 1;
    const tracks: FakeMediaTrack[] = [new FakeMediaTrack(`audio-${this.counter}`, "audio")];
    if (withVideo) tracks.push(new FakeMediaTrack(`video-${this.counter}`, "video"));
    return new FakeMediaStream(`stream-${this.counter}`, tracks);
  }

  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike> {
    this.lastUserMediaConstraints = constraints;
    if (this.failUserMedia) throw this.failUserMedia;
    const next = this.nextUserMedia.shift();
    if (next) return next;
    const wantsVideo = Boolean(constraints.video);
    return this.makeStream(wantsVideo);
  }

  async getDisplayMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike> {
    this.lastDisplayMediaConstraints = constraints;
    if (this.failDisplayMedia) throw this.failDisplayMedia;
    const next = this.nextDisplayMedia.shift();
    if (next) return next;
    this.counter += 1;
    return new FakeMediaStream(`screen-${this.counter}`, [
      new FakeMediaTrack(`screen-video-${this.counter}`, "video"),
    ]);
  }

  async enumerateDevices(): Promise<MediaDeviceInfoLike[]> {
    return [...this.devices];
  }
}
