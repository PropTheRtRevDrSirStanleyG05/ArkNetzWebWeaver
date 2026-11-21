// ArkNetzWebWeaver — backend picker + Wayback view models.
// Pure functions returning view data. NO DOM here — the coordinator wires
// these into the shell UI later. All copy is plain English.
//
// Covers (thread turns 42, 44):
// - the upload-target picker, with hf:/wm: offered only for open /
//   educational / Creative Commons projects (ToS-aware routing),
// - the mirror failover status shown while a site loads,
// - the Time Machine viewer (Wayback snapshot list).
//
// Licence: MIT. No new dependencies.

import {
  BACKEND_INFO,
  assertUploadAllowed,
  type BackendPrefix,
  type MirrorAttempt,
  type ProjectFlags,
} from "./backends.js";
import {
  snapshotDisplayDate,
  type WaybackSnapshot,
} from "./wayback.js";

export interface BackendTargetView {
  prefix: BackendPrefix;
  label: string;
  role: string;
  offered: boolean;
  /** Plain-English reason when not offered (ToS gate). */
  reason?: string;
}

/** View model for the upload-target picker for a project. */
export function backendPickerView(flags: ProjectFlags): {
  targets: BackendTargetView[];
  note: string;
} {
  const targets = (Object.keys(BACKEND_INFO) as BackendPrefix[]).map((prefix) => {
    try {
      assertUploadAllowed(prefix, flags);
      return {
        prefix,
        label: BACKEND_INFO[prefix].label,
        role: BACKEND_INFO[prefix].role,
        offered: true,
      };
    } catch (err) {
      return {
        prefix,
        label: BACKEND_INFO[prefix].label,
        role: BACKEND_INFO[prefix].role,
        offered: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });
  return {
    targets,
    note: "GitHub is the default for sites. Hugging Face and Wikimedia Commons only appear when the project is an open dataset, an educational resource, or a Creative Commons work — their terms do not allow arbitrary personal uploads.",
  };
}

export interface MirrorStatusView {
  tried: number;
  succeededFrom: string | null;
  failed: string[];
  summary: string;
}

/** View model for mirror failover while a site loads. */
export function mirrorStatusView(attempts: MirrorAttempt[]): MirrorStatusView {
  const failed = attempts
    .filter((a) => a.error)
    .map((a) => `${a.uri} (${a.error})`);
  const ok = attempts.find((a) => !a.error && a.status === 200);
  return {
    tried: attempts.length,
    succeededFrom: ok ? ok.uri : null,
    failed,
    summary: ok
      ? attempts.length > 1
        ? `Loaded from ${ok.uri} after ${attempts.length - 1} mirror(s) failed.`
        : `Loaded from ${ok.uri}.`
      : `All ${attempts.length} mirror(s) failed — trying the Wayback Machine next.`,
  };
}

export interface TimeMachineEntryView {
  timestamp: string;
  displayDate: string;
  waybackUrl: string;
  idUrl: string;
  mimetype: string;
}

export interface TimeMachineView {
  originalUrl: string;
  count: number;
  latest: TimeMachineEntryView | null;
  entries: TimeMachineEntryView[];
  emptyNote: string;
}

/** View model for the Time Machine viewer (Wayback snapshot list). */
export function timeMachineView(
  originalUrl: string,
  snapshots: WaybackSnapshot[],
): TimeMachineView {
  const sorted = [...snapshots].sort((a, b) =>
    a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
  );
  const entries: TimeMachineEntryView[] = sorted.map((s) => ({
    timestamp: s.timestamp,
    displayDate: snapshotDisplayDate(s),
    waybackUrl: s.waybackUrl,
    idUrl: s.idUrl,
    mimetype: s.mimetype,
  }));
  return {
    originalUrl,
    count: entries.length,
    latest: entries[0] ?? null,
    entries,
    emptyNote:
      entries.length === 0
        ? "No Wayback Machine snapshots exist for this address yet. Use “Snapshot to Wayback Machine” on Publish to preserve one."
        : "",
  };
}
