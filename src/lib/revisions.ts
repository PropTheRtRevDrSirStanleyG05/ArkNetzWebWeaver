// ArkNetzWebWeaver — revisions + autosave (builder phase).
// Gutenberg parity: visual revisions with a diff, autosave to local
// storage, and save-failure messages that say what went wrong instead
// of failing silently. Publish-only commits: autosave never publishes.
// The store is injected so tests can use memory and the browser can use
// IndexedDB (via a small store built in main.ts).

import type { Revision, SiteDocument } from "./types.js";

export interface RevisionStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

export function createMemoryRevisionStore(): RevisionStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

export function createFailingRevisionStore(message: string): RevisionStore {
  return {
    async get() {
      throw new Error(message);
    },
    async put() {
      throw new Error(message);
    },
  };
}

let revisionCounter = 0;
export function newRevisionId(): string {
  revisionCounter += 1;
  return `rev-${Date.now().toString(36)}-${revisionCounter}`;
}

export function cloneDocument(doc: SiteDocument): SiteDocument {
  return JSON.parse(JSON.stringify(doc)) as SiteDocument;
}

export function makeRevision(doc: SiteDocument, label: string): Revision {
  return { id: newRevisionId(), label, createdAt: Date.now(), document: cloneDocument(doc) };
}

export type DiffLine =
  | { kind: "same"; block: string }
  | { kind: "added"; block: string }
  | { kind: "removed"; block: string }
  | { kind: "changed"; before: string; after: string };

function blockSummary(block: SiteDocument["blocks"][number]): string {
  const text = block.title ?? block.text ?? block.src ?? block.href ?? "";
  return `${block.type}: ${text}`.slice(0, 120);
}

/** Block-level diff of two revisions: blocks matched by id (falling
 *  back to position when a block has no id), reported as added /
 *  removed / changed / same. This is what the visual revision compare
 *  renders. */
export function diffRevisions(a: Revision, b: Revision): DiffLine[] {
  const lines: DiffLine[] = [];
  const bById = new Map<string, (typeof b.document.blocks)[number]>();
  for (const block of b.document.blocks) {
    if (block.id) bById.set(block.id, block);
  }
  const seenB = new Set<string>();
  for (const before of a.document.blocks) {
    const after = before.id ? bById.get(before.id) : undefined;
    if (!after) {
      lines.push({ kind: "removed", block: blockSummary(before) });
      continue;
    }
    seenB.add(after.id as string);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      lines.push({ kind: "same", block: blockSummary(after) });
    } else {
      lines.push({ kind: "changed", before: blockSummary(before), after: blockSummary(after) });
    }
  }
  for (const after of b.document.blocks) {
    if (after.id && !seenB.has(after.id)) {
      lines.push({ kind: "added", block: blockSummary(after) });
    } else if (!after.id) {
      lines.push({ kind: "added", block: blockSummary(after) });
    }
  }
  return lines;
}

export type AutosaveResult =
  | { ok: true; savedAt: number }
  | { ok: false; error: string; retryInMs: number };

/** Autosave a draft. On failure the caller gets the exact reason and a
 *  retry delay — the UI must show both, never a silent fail. */
export async function autosaveDraft(
  store: RevisionStore,
  key: string,
  doc: SiteDocument,
  attempt = 0,
): Promise<AutosaveResult> {
  try {
    await store.put(key, JSON.stringify({ savedAt: Date.now(), document: doc }));
    return { ok: true, savedAt: Date.now() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Autosave failed: ${message}`,
      retryInMs: Math.min(1000 * 2 ** attempt, 30000),
    };
  }
}

export async function loadDraft(store: RevisionStore, key: string): Promise<SiteDocument | null> {
  const raw = await store.get(key).catch(() => undefined);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { document: SiteDocument };
    return parsed.document ?? null;
  } catch {
    return null;
  }
}
