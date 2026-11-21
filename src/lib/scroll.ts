// ArkNetzWebWeaver — scrolling below the sticky topbar (hunt 4, H1/H2).
// The bug: every "scroll this into view" call used
// el.scrollIntoView({ block: "start" }), which puts the element's top
// at the viewport top — exactly under the sticky .an-topbar (44 px
// tall, 80 px at 360 px wide). Panel headings and the editor's
// "Back to view" button landed hidden behind the bar on every load
// and every panel switch. scrollBelowTopbar measures the real bar
// height and scrolls the element to just below it. It no-ops when
// there is no window (node tests) and never throws — a failed scroll
// must never break the navigation or edit it was attached to.

export interface ScrollTarget {
  getBoundingClientRect(): { top: number; height?: number; bottom?: number };
}

export interface ScrollViewport {
  scrollY: number;
  innerHeight: number;
  scrollTo(options: { top: number; behavior: "auto" | "smooth" }): void;
}

function globalViewport(): ScrollViewport | null {
  const w = (globalThis as unknown as { window?: ScrollViewport }).window;
  if (!w || typeof w.scrollTo !== "function") return null;
  return w;
}

function globalTopbar(): ScrollTarget | null {
  const d = (globalThis as unknown as { document?: { querySelector(s: string): ScrollTarget | null } }).document;
  if (!d || typeof d.querySelector !== "function") return null;
  try {
    return d.querySelector(".an-topbar");
  } catch {
    return null;
  }
}

function topbarHeight(topbar?: ScrollTarget | null): number {
  const bar = topbar ?? globalTopbar();
  if (!bar || typeof bar.getBoundingClientRect !== "function") return 44;
  const rect = bar.getBoundingClientRect() as { top: number; height?: number; bottom?: number };
  if (typeof rect.height === "number" && rect.height > 0) return rect.height;
  if (typeof rect.bottom === "number") return rect.bottom - rect.top;
  return 44;
}

/** Scroll `el` so its top sits `gap` px below the sticky topbar.
 *  `topbar` may be passed explicitly (callers that already hold it);
 *  otherwise the document's .an-topbar is measured, falling back to
 *  44 px when there is no bar. No-ops without a window. */
export function scrollBelowTopbar(
  el: ScrollTarget,
  topbar?: ScrollTarget | null,
  gap = 8,
  viewport: ScrollViewport | null = globalViewport(),
): void {
  if (!viewport || typeof el.getBoundingClientRect !== "function") return;
  const barH = topbarHeight(topbar);
  const top = el.getBoundingClientRect().top + viewport.scrollY - barH - gap;
  viewport.scrollTo({ top: Math.max(0, top), behavior: "auto" });
}

/** True when the element's top edge is hidden under the sticky
 *  topbar or below the viewport fold — the "scroll only if needed"
 *  check for tap-to-edit (M5): a block whose toolbar is already
 *  visible is never scrolled, so a mouse click that lands in view
 *  stays exactly where the user put it. False without a window. */
export function isTopHiddenBelowTopbar(
  el: ScrollTarget,
  topbar?: ScrollTarget | null,
  gap = 8,
  viewport: ScrollViewport | null = globalViewport(),
): boolean {
  if (!viewport || typeof el.getBoundingClientRect !== "function") return false;
  const barH = topbarHeight(topbar);
  const top = el.getBoundingClientRect().top;
  return top < barH + gap || top > viewport.innerHeight;
}
