// Tests: media crop/flip/rotate geometry (pure pixel buffers) and
// the attach-flow downscale sizing rules.
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeOutputSize,
  cropForAspect,
  cropPixels,
  downscalePixels,
  flipPixels,
  processImagePixels,
  rotatePixels,
} from "../src/lib/media-edit.js";
import type { ImagePixels } from "../src/lib/media-edit.js";

function pix(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): ImagePixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  return { width: w, height: h, data };
}
function px(p: ImagePixels, x: number, y: number): [number, number, number, number] {
  const i = (y * p.width + x) * 4;
  return [p.data[i] as number, p.data[i + 1] as number, p.data[i + 2] as number, p.data[i + 3] as number];
}

test("rotatePixels 90° swaps dimensions and maps pixels clockwise", () => {
  // 2x1: left=red, right=blue. Rotate 90 CW -> 1x2: top=red, bottom=blue.
  const src = pix(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const out = rotatePixels(src, 90);
  assert.equal(out.width, 1);
  assert.equal(out.height, 2);
  assert.deepEqual(px(out, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(out, 0, 1), [0, 0, 255, 255]);
  const back = rotatePixels(out, 270);
  assert.equal(back.width, 2);
  assert.equal(back.height, 1);
  assert.deepEqual(px(back, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(back, 1, 0), [0, 0, 255, 255]);
  // Four 90° turns are the identity.
  const four = rotatePixels(rotatePixels(rotatePixels(rotatePixels(src, 90), 90), 90), 90);
  assert.deepEqual(four.data, src.data);
});

test("rotatePixels 180° and flipPixels each invert the right axis", () => {
  const src = pix(2, 2, (x, y) => [x * 100, y * 100, 0, 255]);
  const r180 = rotatePixels(src, 180);
  assert.deepEqual(px(r180, 0, 0), [100, 100, 0, 255]);
  const fh = flipPixels(src, true, false);
  assert.deepEqual(px(fh, 0, 0), [100, 0, 0, 255]);
  assert.deepEqual(px(fh, 1, 0), [0, 0, 0, 255]);
  const fv = flipPixels(src, false, true);
  assert.deepEqual(px(fv, 0, 0), [0, 100, 0, 255]);
  // Flip H twice is the identity; 0° rotation is the identity.
  assert.deepEqual(flipPixels(fh, true, false).data, src.data);
  assert.deepEqual(rotatePixels(src, 0).data, src.data);
});

test("cropForAspect returns the largest centered crop as fractions", () => {
  // 800x600 -> 1:1: width fraction 600/800 = 0.75, centered.
  assert.deepEqual(cropForAspect(800, 600, "1:1"), { x: 0.125, y: 0, w: 0.75, h: 1 });
  // 600x800 -> 16:9: height fraction 600/(16/9)/800 = 0.421875.
  const wide = cropForAspect(600, 800, "16:9")!;
  assert.equal(wide.w, 1);
  assert.ok(Math.abs(wide.h - 0.421875) < 1e-9);
  assert.ok(Math.abs(wide.y - 0.2890625) < 1e-9);
  // 800x600 -> 9:16: width fraction 0.421875.
  const tall = cropForAspect(800, 600, "9:16")!;
  assert.ok(Math.abs(tall.w - 0.421875) < 1e-9);
  assert.ok(Math.abs(tall.x - 0.2890625) < 1e-9);
  assert.equal(cropForAspect(800, 600, "freeform"), undefined);
  assert.throws(() => cropForAspect(800, 600, "banana"), /aspect/);
});

test("cropPixels cuts the requested fractional rectangle", () => {
  const src = pix(4, 2, (x, y) => [x * 60, y * 120, 0, 255]);
  const out = cropPixels(src, { x: 0.25, y: 0, w: 0.5, h: 1 });
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  assert.deepEqual(px(out, 0, 0), [60, 0, 0, 255]);
  assert.deepEqual(px(out, 1, 1), [120, 120, 0, 255]);
  // A crop that runs past the edge is clamped, not an error.
  const clamped = cropPixels(src, { x: 0.9, y: 0, w: 0.5, h: 1 });
  assert.equal(clamped.width, 1);
  assert.deepEqual(px(clamped, 0, 0), [180, 0, 0, 255]);
});

test("downscalePixels caps at 1600px on the long edge and never upscales", () => {
  const big = downscalePixels(pix(4032, 3024, () => [200, 100, 50, 255]), 1600);
  assert.equal(big.width, 1600);
  assert.equal(big.height, 1200);
  // Flat fill stays flat through bilinear resampling.
  assert.deepEqual(px(big, 0, 0), [200, 100, 50, 255]);
  assert.deepEqual(px(big, 1599, 1199), [200, 100, 50, 255]);
  const small = pix(800, 600, () => [1, 2, 3, 255]);
  const kept = downscalePixels(small, 1600);
  assert.equal(kept.width, 800);
  assert.deepEqual(kept.data, small.data);
  assert.deepEqual(computeOutputSize(4032, 3024, {}), { width: 1600, height: 1200 });
  assert.deepEqual(computeOutputSize(800, 600, {}), { width: 800, height: 600 });
  assert.deepEqual(computeOutputSize(200, 100, { rotate: 90 }), { width: 100, height: 200 });
});

test("processImagePixels applies crop -> rotate -> flip -> downscale in that order", () => {
  // 4x2 gradient: crop to the middle 2x2 (x 0.25..0.75), rotate 90 CW,
  // flip H. Downscale cap 1600: no change.
  const src = pix(4, 2, (x, y) => [x * 60, y * 120, 0, 255]);
  const out = processImagePixels(src, {
    crop: { x: 0.25, y: 0, w: 0.5, h: 1 },
    rotate: 90,
    flipH: true,
  });
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
  // After crop: [[(60,0),(120,0)],[(60,120),(120,120)]]
  // rotate 90 CW: top [(60,120),(60,0)], bottom [(120,120),(120,0)]
  // flip H swaps columns: top [(60,0),(60,120)], bottom [(120,0),(120,120)]
  assert.deepEqual(px(out, 0, 0), [60, 0, 0, 255]);
  assert.deepEqual(px(out, 1, 0), [60, 120, 0, 255]);
  assert.deepEqual(px(out, 0, 1), [120, 0, 0, 255]);
  assert.deepEqual(px(out, 1, 1), [120, 120, 0, 255]);
});

test("processImagePixels downscales a 4032x3024 phone photo to 1600x1200", () => {
  const src = pix(4032, 3024, () => [200, 100, 50, 255]);
  const out = processImagePixels(src, {});
  assert.equal(out.width, 1600);
  assert.equal(out.height, 1200);
  assert.deepEqual(computeOutputSize(4032, 3024, {}), { width: 1600, height: 1200 });
});
