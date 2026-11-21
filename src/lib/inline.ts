// ArkNetzWebWeaver — inline rich-text formatting.
// Bold / italic / underline / strikethrough / inline code / links, on
// selected text inside paragraph / heading / quote blocks. Formatting is
// stored as TYPED inline runs in BlockNode.runs — never raw HTML. The
// renderer (renderer.ts) renders the same runs in the reader, so editor
// and reader can never diverge on formatting. Plain `text` is kept in
// sync with the runs (plainText(runs)) for back-compat with hand-written
// documents and the WordPress importer, which produce text-only blocks.

export interface InlineFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Link target. Must pass isSafeUrl — unsafe hrefs are dropped. */
  href?: string;
}

export interface InlineRun {
  text: string;
  format?: InlineFormat;
}

const URL_HOSTS = new Set([
  "archive.org",
  "raw.githubusercontent.com",
  "github.com",
]);

/** URL safety, shared by the renderer and the link formatter: only
 *  https: to the allow-listed hosts, or arknetz: deep links. Anything
 *  else (javascript:, http:, trackers) is rejected. */
export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "arknetz:") return true;
    if (u.protocol !== "https:") return false;
    return URL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A format is empty when it carries no marks and no link. Empty formats
 *  are not stored — runs keep `format` undefined instead. */
export function isEmptyFormat(f: InlineFormat | undefined): boolean {
  if (!f) return true;
  return (
    !f.bold && !f.italic && !f.underline && !f.strike && !f.code && !f.href
  );
}

export function sameFormat(a: InlineFormat | undefined, b: InlineFormat | undefined): boolean {
  const x = isEmptyFormat(a) ? undefined : a;
  const y = isEmptyFormat(b) ? undefined : b;
  if (!x && !y) return true;
  if (!x || !y) return false;
  return (
    !!x.bold === !!y.bold &&
    !!x.italic === !!y.italic &&
    !!x.underline === !!y.underline &&
    !!x.strike === !!y.strike &&
    !!x.code === !!y.code &&
    (x.href ?? "") === (y.href ?? "")
  );
}

export function plainText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join("");
}

export function runsFromText(text: string): InlineRun[] {
  return text ? [{ text }] : [];
}

/** Normalise runs: drop empty runs, drop empty formats, merge adjacent
 *  runs that carry the same format. */
export function normalizeRuns(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const format = isEmptyFormat(run.format) ? undefined : run.format;
    const last = out[out.length - 1];
    if (last && sameFormat(last.format, format)) {
      last.text += run.text;
    } else {
      out.push(format ? { text: run.text, format: { ...format } } : { text: run.text });
    }
  }
  return out;
}

/** Split a run list at a plain-text offset, so a boundary falls exactly
 *  between two runs. Returns [before, after] as run lists. */
function splitRunsAt(runs: InlineRun[], offset: number): [InlineRun[], InlineRun[]] {
  const before: InlineRun[] = [];
  const after: InlineRun[] = [];
  let pos = 0;
  for (const run of runs) {
    const start = pos;
    const end = pos + run.text.length;
    pos = end;
    if (end <= offset) {
      before.push({ ...run });
    } else if (start >= offset) {
      after.push({ ...run });
    } else {
      const cut = offset - start;
      before.push({ ...run, text: run.text.slice(0, cut) });
      after.push({ ...run, text: run.text.slice(cut) });
    }
  }
  return [before, after];
}

export type FormatPatch = Partial<InlineFormat>;

/** Apply (or toggle) formatting on the plain-text range [start, end).
 *  Out-of-range or empty ranges return the runs unchanged. Toggle: a key
 *  is removed when EVERY covered run already has it, otherwise it is set
 *  on all covered runs. `href` is applied as a set (toggle does not apply
 *  to links — use clearLink to remove one). Unsafe hrefs are ignored. */
export function applyFormat(
  runs: InlineRun[],
  start: number,
  end: number,
  patch: FormatPatch,
  mode: "set" | "toggle" = "set",
): InlineRun[] {
  const text = plainText(runs);
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(0, Math.min(end, text.length));
  if (s >= e) return normalizeRuns(runs);
  const clean: FormatPatch = { ...patch };
  if (clean.href !== undefined && !isSafeUrl(clean.href)) delete clean.href;
  if (Object.keys(clean).length === 0) return normalizeRuns(runs);

  const [, rest] = splitRunsAt(runs, s);
  const [middle, tail] = splitRunsAt(rest, e - s);
  const [head] = splitRunsAt(runs, s);

  let patched: InlineRun[];
  if (mode === "toggle") {
    const keys = (Object.keys(clean) as Array<keyof FormatPatch>).filter((k) => k !== "href");
    const allSet = keys.length > 0 && middle.length > 0 && keys.every((k) => middle.every((r) => !!r.format?.[k]));
    patched = middle.map((r) => {
      const format: InlineFormat = { ...(r.format ?? {}) };
      for (const k of keys) {
        if (allSet) delete format[k];
        else format[k] = true as never;
      }
      if (clean.href !== undefined) format.href = clean.href;
      return { text: r.text, format: isEmptyFormat(format) ? undefined : format };
    });
  } else {
    patched = middle.map((r) => {
      const format: InlineFormat = { ...(r.format ?? {}), ...clean };
      return { text: r.text, format: isEmptyFormat(format) ? undefined : format };
    });
  }
  return normalizeRuns([...head, ...patched, ...tail]);
}

export function setLink(runs: InlineRun[], start: number, end: number, href: string): InlineRun[] {
  return applyFormat(runs, start, end, { href }, "set");
}

export function clearLink(runs: InlineRun[], start: number, end: number): InlineRun[] {
  const text = plainText(runs);
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(0, Math.min(end, text.length));
  if (s >= e) return normalizeRuns(runs);
  const [, rest] = splitRunsAt(runs, s);
  const [middle, tail] = splitRunsAt(rest, e - s);
  const [head] = splitRunsAt(runs, s);
  const cleared = middle.map((r) => {
    const format: InlineFormat = { ...(r.format ?? {}) };
    delete format.href;
    return { text: r.text, format: isEmptyFormat(format) ? undefined : format };
  });
  return normalizeRuns([...head, ...cleared, ...tail]);
}

/** Render runs to HTML. Text is always escaped; links are allow-listed
 *  (an unsafe href renders as plain text, never as a link); marks nest in
 *  a fixed order so the output is deterministic: a > code > strong > em >
 *  u > s, innermost text last. */
export function renderInlineRuns(runs: InlineRun[]): string {
  return runs
    .map((run) => {
      const f = run.format;
      if (!f || isEmptyFormat(f)) return escapeHtml(run.text);
      let inner = escapeHtml(run.text);
      if (f.strike) inner = `<s>${inner}</s>`;
      if (f.underline) inner = `<u>${inner}</u>`;
      if (f.italic) inner = `<em>${inner}</em>`;
      if (f.bold) inner = `<strong>${inner}</strong>`;
      if (f.code) inner = `<code>${inner}</code>`;
      if (f.href && isSafeUrl(f.href)) {
        inner = `<a href="${escapeHtml(f.href)}" rel="noopener">${inner}</a>`;
      }
      return inner;
    })
    .join("");
}

/** After the user edits plain text in a contenteditable element, rebuild
 *  runs for the new text while keeping the old formatting per character
 *  position: characters that survive keep their format; newly typed
 *  characters take the format of the run they were typed into (the last
 *  run's format when appended at the end). */
export function syncRunsFromText(oldRuns: InlineRun[], newText: string): InlineRun[] {
  if (oldRuns.length === 0) return runsFromText(newText);
  const formats: Array<InlineFormat | undefined> = [];
  for (const run of oldRuns) {
    for (let i = 0; i < run.text.length; i++) formats.push(run.format);
  }
  const out: InlineRun[] = [];
  for (let i = 0; i < newText.length; i++) {
    const format = i < formats.length ? formats[i] : formats[formats.length - 1];
    const last = out[out.length - 1];
    if (last && sameFormat(last.format, format)) {
      last.text += newText[i] as string;
    } else {
      out.push(format ? { text: newText[i] as string, format: { ...format } } : { text: newText[i] as string });
    }
  }
  return normalizeRuns(out);
}
