// ArkNetzWebWeaver — Group calls: mesh, then a peer-volunteered mixer.
//
// Mesh while the group has ≤ 5 participants (every peer holds one
// media PC per other participant). Above that, the group elects a
// volunteer mixer: every participant holds exactly one media PC —
// to the mixer — and the mixer forwards tracks between
// participants (selective forwarding: no re-encode, no audio mix
// in v1). Nobody is a mixer unless they explicitly volunteer
// (toggle off by default). The mixer is visible, consented, and
// revocable, and the group falls back to mesh when it shrinks or
// when no one volunteers.
//
// THE TRUST BOUNDARY (MEDIA-SPEC.md §6.4) — read before using the
// mixer: a selective-forwarding mixer terminates DTLS-SRTP per leg,
// so it holds the SRTP keys for each leg and its browser has access
// to the decoded media it forwards. A mixer peer CAN technically
// access the media it forwards. It is not a blind forwarder. What
// it cannot do is do so undetectably: the role is visible (the
// group always knows who the mixer is), opt-in, and revocable, and
// any participant can leave. Blind forwarding needs an additional
// end-to-end encryption layer (SFrame) that is NOT built in v1 —
// the spec records it as future hardening, not a claim.
//
// The mixer never sees sealed mail or drive chunks: those travel on
// different channels with different crypto and never touch the
// mixer. It only ever sees the media of calls it is mixing.

import {
  MESH_MAX_PARTICIPANTS,
  MIXER_DEGRADE_WINDOW_MS,
  MIXER_MIN_CPU_HEADROOM,
  MIXER_MIN_UPLINK_KBPS,
  MIXER_SWITCH_MARGIN,
  electMixer,
  electionScore,
  type GroupMode,
  type MediaControlMessage,
} from "./media.js";
import type { MediaConnection, MediaSenderLike } from "./media-connection.js";
import type { MediaStreamLike, MediaTrackLike } from "./media-devices.js";

export interface GroupParticipant {
  peerId: string;
  address: string;
  /** Explicitly volunteered as mixer (off by default). */
  volunteerMixer: boolean;
  /** Measured uplink, kbps. 0 = never measured (cannot win). */
  uplinkKbps: number;
  /** Self-reported CPU headroom, 0..1. */
  cpuHeadroom: number;
  /** Latest election score (from group-join or mixer-announce). */
  score: number;
  /** Unix ms this participant joined (coordinator = earliest). */
  joinedAt: number;
  /** The media PC to this participant (mesh) or to the mixer. */
  connection: MediaConnection | null;
}

export type GroupEvent =
  | { type: "mode"; mode: GroupMode }
  | { type: "mixer-elected"; mixerPeerId: string }
  | { type: "mixer-lost"; mixerPeerId: string; reason: string }
  | { type: "no-volunteer" }
  | { type: "remote-track"; peerId: string; track: MediaTrackLike; kind: "audio" | "video" }
  | { type: "participant-joined"; peerId: string }
  | { type: "participant-left"; peerId: string };

export interface GroupCallOptions {
  groupId: string;
  selfPeerId: string;
  selfAddress: string;
  /** Am I volunteering as a mixer? Off by default — nobody is a
   *  mixer unless they explicitly opt in. */
  volunteerMixer: boolean;
  /** Returns (creating if needed) the media PC to a participant.
   *  Phase 2 plugs per-pair call negotiation in here; tests pass a
   *  fake factory pair. */
  mediaConnector: (peerId: string) => MediaConnection;
  /** Broadcast one control message to the whole group. */
  sendControl: (message: MediaControlMessage) => void;
  onEvent: (event: GroupEvent) => void;
  now?: () => number;
}

/** One group call. The coordinator is the longest-joined
 *  participant (deterministic — no vote needed); only the
 *  coordinator runs elections and broadcasts mixer-elect. */
export class GroupCall {
  readonly groupId: string;
  readonly selfPeerId: string;
  readonly selfAddress: string;
  volunteerMixer: boolean;

  private readonly mediaConnector: (peerId: string) => MediaConnection;
  private readonly sendControlFn: (message: MediaControlMessage) => void;
  private readonly onEvent: (event: GroupEvent) => void;
  private readonly now: () => number;

  /** peerId -> participant (includes self once joined). */
  readonly participants = new Map<string, GroupParticipant>();
  private _mode: GroupMode = "mesh";
  private _mixerPeerId: string | null = null;
  /** sourcePeerId -> targetPeerId -> sender (forwarding table). */
  private readonly forwarded = new Map<string, Map<string, MediaSenderLike>>();
  /** When the mixer (self) first fell below the health minimums. */
  private degradedSince: number | null = null;
  private joined = false;

  constructor(options: GroupCallOptions) {
    this.groupId = options.groupId;
    this.selfPeerId = options.selfPeerId;
    this.selfAddress = options.selfAddress;
    this.volunteerMixer = options.volunteerMixer;
    this.mediaConnector = options.mediaConnector;
    this.sendControlFn = options.sendControl;
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => Date.now());
  }

  get mode(): GroupMode {
    return this._mode;
  }

  get mixerPeerId(): string | null {
    return this._mixerPeerId;
  }

  get size(): number {
    return this.participants.size;
  }

  /** Am I the coordinator (longest-joined participant)? Only the
   *  coordinator elects and broadcasts mixer-elect. */
  get isCoordinator(): boolean {
    return this.coordinatorPeerId() === this.selfPeerId;
  }

  /** Am I the current mixer? */
  get isMixer(): boolean {
    return this._mixerPeerId === this.selfPeerId;
  }

  private coordinatorPeerId(): string | null {
    let best: GroupParticipant | null = null;
    for (const p of this.participants.values()) {
      if (
        best === null ||
        p.joinedAt < best.joinedAt ||
        (p.joinedAt === best.joinedAt && p.peerId < best.peerId)
      ) {
        best = p;
      }
    }
    return best?.peerId ?? null;
  }

  private send(message: MediaControlMessage): void {
    try {
      this.sendControlFn(message);
    } catch {
      // A failed broadcast is not fatal — the group degrades.
    }
  }

  private setMode(mode: GroupMode): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this.onEvent({ type: "mode", mode });
  }

  // ------------------------------------------------------------------
  // Membership.
  // ------------------------------------------------------------------

  /** Join the group: record self, broadcast group-join. */
  join(uplinkKbps = 0, cpuHeadroom = 1): void {
    if (this.joined) return;
    this.joined = true;
    const now = this.now();
    this.participants.set(this.selfPeerId, {
      peerId: this.selfPeerId,
      address: this.selfAddress,
      volunteerMixer: this.volunteerMixer,
      uplinkKbps,
      cpuHeadroom,
      score: electionScore(uplinkKbps, cpuHeadroom),
      joinedAt: now,
      connection: null,
    });
    this.send({
      t: "group-join",
      groupId: this.groupId,
      peerId: this.selfPeerId,
      address: this.selfAddress,
      volunteerMixer: this.volunteerMixer,
      uplinkKbps,
      cpuHeadroom,
    });
    this.updateMode();
  }

  /** Leave the group: tell everyone, drop forwarding, close our
   *  media connections to participants. If I was the mixer, the
   *  group re-elects (the coordinator handles it on my leave). */
  leave(): void {
    if (!this.joined) return;
    this.joined = false;
    if (this.isMixer) {
      this.send({ t: "mixer-lost", groupId: this.groupId, mixerPeerId: this.selfPeerId, reason: "mixer left" });
    }
    this.send({ t: "group-leave", groupId: this.groupId, peerId: this.selfPeerId });
    this.clearForwarding();
    for (const p of this.participants.values()) {
      try {
        p.connection?.close();
      } catch {
        // Already closed.
      }
    }
    this.participants.clear();
    this._mixerPeerId = null;
    this.setMode("mesh");
  }

  /** Record (or refresh) a participant from a group-join. */
  addParticipant(
    peerId: string,
    address: string,
    volunteerMixer: boolean,
    uplinkKbps = 0,
    cpuHeadroom = 1,
  ): void {
    const existing = this.participants.get(peerId);
    const now = this.now();
    this.participants.set(peerId, {
      peerId,
      address,
      volunteerMixer,
      uplinkKbps,
      cpuHeadroom,
      score: electionScore(uplinkKbps, cpuHeadroom),
      joinedAt: existing?.joinedAt ?? now,
      connection: existing?.connection ?? null,
    });
    if (!existing) this.onEvent({ type: "participant-joined", peerId });
    this.updateMode();
  }

  /** Remove a participant (group-leave or drop). If it was the
   *  mixer, re-elect; if the group shrank, fall back to mesh. */
  removeParticipant(peerId: string): void {
    const wasMixer = this._mixerPeerId === peerId;
    this.participants.delete(peerId);
    this.dropForwardingFor(peerId);
    this.onEvent({ type: "participant-left", peerId });
    if (wasMixer) {
      this._mixerPeerId = null;
      this.onEvent({ type: "mixer-lost", mixerPeerId: peerId, reason: "mixer left" });
      this.updateMode(true);
    } else {
      this.updateMode(true);
    }
  }

  /** Update my own measurements (uplink from stats, headroom
   *  self-reported). Volunteers re-announce on change so the
   *  coordinator elects from fresh scores. */
  reportMeasurements(uplinkKbps: number, cpuHeadroom: number): void {
    const self = this.participants.get(this.selfPeerId);
    if (!self) return;
    self.uplinkKbps = uplinkKbps;
    self.cpuHeadroom = cpuHeadroom;
    self.score = electionScore(uplinkKbps, cpuHeadroom);
    if (this.volunteerMixer) {
      this.send({
        t: "mixer-announce",
        groupId: this.groupId,
        peerId: this.selfPeerId,
        score: self.score,
        volunteer: true,
      });
    }
    // Mixer health: below the minimums for the whole window →
    // I step down and the group re-elects.
    if (this.isMixer) {
      const unhealthy = uplinkKbps < MIXER_MIN_UPLINK_KBPS || cpuHeadroom < MIXER_MIN_CPU_HEADROOM;
      if (unhealthy) {
        if (this.degradedSince === null) this.degradedSince = this.now();
        if (this.now() - this.degradedSince >= MIXER_DEGRADE_WINDOW_MS) {
          this.degradedSince = null;
          this.send({ t: "mixer-lost", groupId: this.groupId, mixerPeerId: this.selfPeerId, reason: "mixer degraded" });
          this._mixerPeerId = null;
          this.clearForwarding();
          this.onEvent({ type: "mixer-lost", mixerPeerId: this.selfPeerId, reason: "mixer degraded" });
          this.updateMode(true);
        }
      } else {
        this.degradedSince = null;
      }
    }
  }

  // ------------------------------------------------------------------
  // Mode + election.
  // ------------------------------------------------------------------

  /** Recompute the mode from the current membership. The
   *  coordinator elects; everyone else follows mixer-elect.
   *
   *  `shrank` is true only when the group actually got smaller
   *  (a leave, or a lost mixer) — the one case where a live mixer
   *  is dropped for falling back to mesh. A late joiner learns
   *  the mixer (mixer-elect) BEFORE it learns the full membership
   *  that justifies it, so its own size is stale-small until the
   *  relayed joins arrive; clearing the mixer on a join-driven
   *  update would drop a good election on every join, and the
   *  joiner would sit in mesh while the rest of the group is
   *  mixer-routed. A coordinator-elected mixer is therefore
   *  trusted over my own size until a real shrink says otherwise. */
  updateMode(shrank = false): void {
    if (!this.joined) return;
    if (this.participants.size <= MESH_MAX_PARTICIPANTS) {
      if (this._mode === "mixer" && shrank) {
        this._mixerPeerId = null;
        this.clearForwarding();
      }
      if (this._mode === "mixer" && !shrank) return;
      this.setMode("mesh");
      return;
    }
    // Above the mesh ceiling: need a mixer.
    if (!this.isCoordinator) return; // The coordinator elects; I wait for mixer-elect.
    const winner = electMixer(
      [...this.participants.values()].map((p) => ({
        peerId: p.peerId,
        score: p.score,
        volunteer: p.volunteerMixer,
      })),
    );
    if (winner === null) {
      // No volunteer at all: stay in mesh past the ceiling and say
      // so. The call never fails for lack of a mixer; it degrades.
      if (this._mode === "mixer") {
        this._mixerPeerId = null;
        this.clearForwarding();
      }
      this.setMode("mesh");
      // The coordinator tells the whole group, not just itself:
      // only the coordinator runs the election, so without this
      // broadcast the other members would never see the notice.
      this.send({ t: "no-volunteer", groupId: this.groupId });
      this.onEvent({ type: "no-volunteer" });
      return;
    }
    if (this._mode === "mixer" && this._mixerPeerId) {
      // A mixer is already live. Only displace it for a clearly
      // better volunteer, so the group does not flap between two
      // near-equal mixers on every join.
      if (winner === this._mixerPeerId) return;
      const incumbent = this.participants.get(this._mixerPeerId);
      const challenger = this.participants.get(winner);
      if (incumbent && challenger && challenger.score - incumbent.score <= MIXER_SWITCH_MARGIN) return;
    }
    this.setMixer(winner);
  }

  /** Install a mixer: announce it, clear stale forwarding when the
   *  mixer changes, and (if it is me) announce readiness. */
  private setMixer(mixerPeerId: string): void {
    const changed = this._mixerPeerId !== mixerPeerId;
    if (changed) this.clearForwarding();
    this._mixerPeerId = mixerPeerId;
    this.setMode("mixer");
    this.send({ t: "mixer-elect", groupId: this.groupId, mixerPeerId, electedBy: this.selfPeerId });
    this.onEvent({ type: "mixer-elected", mixerPeerId });
    if (mixerPeerId === this.selfPeerId) {
      this.send({ t: "mixer-ready", groupId: this.groupId, mixerPeerId });
    }
  }

  /** This peer was elected mixer (by mixer-elect, or by winning
   *  the local election as coordinator). */
  acceptMixerRole(mixerPeerId: string): void {
    if (this._mixerPeerId === mixerPeerId && this._mode === "mixer") return;
    const changed = this._mixerPeerId !== mixerPeerId;
    if (changed) this.clearForwarding();
    this._mixerPeerId = mixerPeerId;
    this.setMode("mixer");
    this.onEvent({ type: "mixer-elected", mixerPeerId });
  }

  // ------------------------------------------------------------------
  // Media plumbing.
  // ------------------------------------------------------------------

  /** Get (creating if needed) the media PC to a participant, and
   *  wire its incoming tracks. In mesh mode the tracks go to the
   *  UI; when I am the mixer they are forwarded (§6.4). */
  connectionTo(peerId: string): MediaConnection {
    const participant = this.participants.get(peerId);
    if (!participant) throw new Error(`unknown participant ${peerId}`);
    if (participant.connection) return participant.connection;
    const conn = this.mediaConnector(peerId);
    participant.connection = conn;
    conn.ontrack = (event) => {
      this.onRemoteTrack(peerId, event.track, event.streams[0] ?? null);
    };
    return conn;
  }

  /** A remote track arrived on the PC from `sourcePeerId`. In mesh
   *  mode it goes straight to the UI. When I am the mixer, it is
   *  forwarded to every other participant (selective forwarding —
   *  the same encoded track, re-sent, no re-encode). */
  onRemoteTrack(sourcePeerId: string, track: MediaTrackLike, stream: MediaStreamLike | null): void {
    if (!this.participants.has(sourcePeerId)) return;
    if (!this.isMixer) {
      this.onEvent({ type: "remote-track", peerId: sourcePeerId, track, kind: track.kind });
      return;
    }
    // I am the mixer: forward to everyone except the source.
    const targets = this.forwarded.get(sourcePeerId) ?? new Map<string, MediaSenderLike>();
    for (const [targetPeerId, participant] of this.participants) {
      if (targetPeerId === sourcePeerId || targetPeerId === this.selfPeerId) continue;
      if (targets.has(targetPeerId)) continue; // Already forwarding this track there.
      try {
        const conn = this.connectionTo(targetPeerId);
        const sender = conn.addTrack(track, stream ?? fakeStreamFor(track));
        targets.set(targetPeerId, sender);
      } catch {
        // That participant's PC is not up — skip it; a later
        // track from the same source retries the forward.
      }
    }
    this.forwarded.set(sourcePeerId, targets);
  }

  /** Drop every forwarded sender for one participant — both the
   *  tracks it sourced and the forwards targeting it. */
  private dropForwardingFor(peerId: string): void {
    const sourced = this.forwarded.get(peerId);
    if (sourced) {
      for (const [targetPeerId, sender] of sourced) {
        const target = this.participants.get(targetPeerId);
        try {
          target?.connection?.removeTrack(sender);
        } catch {
          // Already gone.
        }
      }
      this.forwarded.delete(peerId);
    }
    for (const [sourcePeerId, targets] of this.forwarded) {
      const sender = targets.get(peerId);
      if (!sender) continue;
      const target = this.participants.get(peerId);
      try {
        target?.connection?.removeTrack(sender);
      } catch {
        // Already gone.
      }
      targets.delete(peerId);
      if (targets.size === 0) this.forwarded.delete(sourcePeerId);
    }
  }

  private clearForwarding(): void {
    for (const sourcePeerId of [...this.forwarded.keys()]) {
      this.dropForwardingFor(sourcePeerId);
    }
    this.forwarded.clear();
  }

  /** How many forwarded senders are live right now (tests + UI). */
  forwardingCount(): number {
    let n = 0;
    for (const targets of this.forwarded.values()) n += targets.size;
    return n;
  }

  // ------------------------------------------------------------------
  // Incoming control messages (routed by the phase-2 channel router).
  // ------------------------------------------------------------------

  /** Route one decoded group/mixer control message. Unknown or
   *  mismatched messages are ignored — never fatal. */
  handleControl(message: MediaControlMessage): void {
    if (!("groupId" in message) || message.groupId !== this.groupId) return;
    switch (message.t) {
      case "group-join": {
        this.addParticipant(
          message.peerId,
          message.address,
          message.volunteerMixer,
          message.uplinkKbps ?? 0,
          message.cpuHeadroom ?? 1,
        );
        return;
      }
      case "group-leave": {
        if (this.participants.has(message.peerId)) this.removeParticipant(message.peerId);
        return;
      }
      case "mixer-announce": {
        const p = this.participants.get(message.peerId);
        if (p) {
          p.volunteerMixer = message.volunteer;
          p.score = message.score;
        }
        return;
      }
      case "mixer-elect": {
        if (!this.participants.has(message.mixerPeerId)) return;
        this.acceptMixerRole(message.mixerPeerId);
        return;
      }
      case "mixer-ready": {
        // The elected mixer confirms it is forwarding. Nothing to
        // do locally — the mode is already "mixer".
        return;
      }
      case "mixer-lost": {
        if (this._mixerPeerId !== message.mixerPeerId) return;
        this._mixerPeerId = null;
        this.clearForwarding();
        this.onEvent({ type: "mixer-lost", mixerPeerId: message.mixerPeerId, reason: message.reason });
        this.updateMode(true);
        return;
      }
      case "no-volunteer": {
        // The coordinator found no volunteer: the group stays in
        // mesh past the ceiling, and every participant is told why.
        this.onEvent({ type: "no-volunteer" });
        return;
      }
      default:
        return;
    }
  }
}

/** Minimal stream wrapper for a track with no stream (the mixer
 *  forwards the track itself; the stream is only an association
 *  for the receiver's UI). */
function fakeStreamFor(track: MediaTrackLike): MediaStreamLike {
  return {
    id: `forward-${track.id}`,
    getTracks: () => [track],
    getAudioTracks: () => (track.kind === "audio" ? [track] : []),
    getVideoTracks: () => (track.kind === "video" ? [track] : []),
    addTrack: () => undefined,
    removeTrack: () => undefined,
  };
}
