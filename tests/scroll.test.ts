// Tests: scrolling below the sticky topbar (hunt 4, H1/H2).
import test from "node:test";
import assert from "node:assert/strict";
import { isTopHiddenBelowTopbar, scrollBelowTopbar } from "../src/lib/scroll.js";
import type { ScrollTarget, ScrollViewport } from "../src/lib/scroll.js";

function target(top: number): ScrollTarget {
  return { getBoundingClientRect: () => ({ top, height: 20, bottom: top + 20 }) };
}

function viewport(scrollY: number, innerHeight: number): { vp: ScrollViewport; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    vp: {
      scrollY,
      innerHeight,
      scrollTo: ({ top }: { top: number }) => {
        calls.push(top);
      },
    },
  };
}

test("scrollBelowTopbar lands the element below a 44px bar plus the gap", () => {
  const bar = target(0);
  (bar.getBoundingClientRect as () => { top: number; height: number; bottom: number }) = () => ({ top: 0, height: 44, bottom: 44 });
  const { vp, calls } = viewport(261, 844);
  scrollBelowTopbar(target(261), bar, 8, vp);
  assert.deepEqual(calls, [261 + 261 - 44 - 8]);
});

test("scrollBelowTopbar measures an 80px bar (360px topbar) and clamps at zero", () => {
  const bar = { getBoundingClientRect: () => ({ top: 0, height: 80, bottom: 80 }) };
  const { vp, calls } = viewport(0, 844);
  scrollBelowTopbar(target(10), bar, 8, vp);
  assert.deepEqual(calls, [0]);
});

test("scrollBelowTopbar falls back to 44px with no bar", () => {
  const { vp, calls } = viewport(100, 844);
  scrollBelowTopbar(target(200), null, 8, vp);
  assert.deepEqual(calls, [100 + 200 - 44 - 8]);
});

test("scrollBelowTopbar no-ops without a viewport (node)", () => {
  scrollBelowTopbar(target(200), null, 8, null);
});

test("isTopHiddenBelowTopbar flags tops under the bar and below the fold only", () => {
  const bar = { getBoundingClientRect: () => ({ top: 0, height: 44, bottom: 44 }) };
  const { vp } = viewport(0, 844);
  assert.equal(isTopHiddenBelowTopbar(target(10), bar, 8, vp), true);
  assert.equal(isTopHiddenBelowTopbar(target(52), bar, 8, vp), false);
  assert.equal(isTopHiddenBelowTopbar(target(500), bar, 8, vp), false);
  assert.equal(isTopHiddenBelowTopbar(target(900), bar, 8, vp), true);
  assert.equal(isTopHiddenBelowTopbar(target(500), bar, 8, null), false);
});
