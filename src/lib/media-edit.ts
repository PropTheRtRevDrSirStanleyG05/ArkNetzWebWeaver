// ArkNetzWebWeaver — in-editor media editing: crop / flip / rotate / downscale.
// Pure pixel geometry lives here and is fully testable in Node (no DOM,
// no canvas): images are RGBA pixel buffers. The browser helpers at the
// bottom convert between Blobs and pixel buffers via OffscreenCanvas /
// canvas, and encode the result as WebP (AVIF when the browser offers
// it). The attach flow calls prepareImageForUpload() BEFORE the stealth
// IA upload, so a 6 MB phone photo is downscaled to max 1600px and
// encoded WebP 80% before it ever leaves the device — the IA path never
// sees the full-size original.
//
// Pipeline order is fixed: crop -> rotate -> flip -> downscale. Crop
// coordinates are fractions of the source (0..1), so the same edit
// applies identically at any resolution.

export interface ImagePixels {
  width: number;
  height: number;
  /** RGBA, row-major, length width*height*4. */
  data: Uint8ClampedArray;
}

export interface CropRect {
  x: number; // 0..1, left edge
  y: number; // 0..1, top edge
  w: number; // 0..1, width
  h: number; // 0..1, height
}

export interface MediaEditOpts {
  crop?: CropRect;
  /** Clockwise rotation, 0/90/180/270 only. */
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  /** Downscale so the longest side is at most this many pixels. */
  maxDimension?: number;
}

export const MAX_IMAGE_DIMENSION = 1600; // thread: max 1600px
export const IMAGE_QUALITY = 0.8; // WebP/AVIF 80%
export const THUMBNAIL_MAX_DIMENSION = 320; // ~12 KB WebP thumbnails

export function clampCrop(crop: CropRect): CropRect {
  const x = Math.max(0, Math.min(1, crop.x));
  const y = Math.max(0, Math.min(1, crop.y));
  const w = Math.max(0.01, Math.min(1 - x, crop.w));
  const h = Math.max(0.01, Math.min(1 - y, crop.h));
  return { x, y, w, h };
}

/** Centered crop for an aspect ratio ("16:9", "1:1", ...). "freeform"
 *  means no crop. The crop is the largest centered rectangle of that
 *  aspect inside the source. */
export function cropForAspect(
  srcW: number,
  srcH: number,
  aspect: string,
): CropRect | undefined {
  if (aspect === "freeform") return undefined;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  if (!m) throw new Error(`unknown aspect ratio "${aspect}" — use e.g. "16:9", "1:1", "4:3", or "freeform"`);
  const ratio = Number(m[1]) / Number(m[2]);
  const srcRatio = srcW / srcH;
  if (srcRatio > ratio) {
    // Source is wider: crop the sides.
    const w = srcH * ratio / srcW;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = srcW / ratio / srcH;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/** Output dimensions after the full pipeline, without touching pixels.
 *  The editor UI uses this to show the result size before applying. */
export function computeOutputSize(srcW: number, srcH: number, opts: MediaEditOpts): { width: number; height: number } {
  let w = srcW;
  let h = srcH;
  if (opts.crop) {
    const c = clampCrop(opts.crop);
    w = Math.max(1, Math.round(srcW * c.w));
    h = Math.max(1, Math.round(srcH * c.h));
  }
  if (opts.rotate === 90 || opts.rotate === 270) {
    [w, h] = [h, w];
  }
  const max = opts.maxDimension ?? MAX_IMAGE_DIMENSION;
  if (Math.max(w, h) > max) {
    const scale = max / Math.max(w, h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  return { width: w, height: h };
}

export function cropPixels(p: ImagePixels, crop: CropRect): ImagePixels {
  const c = clampCrop(crop);
  const x0 = Math.floor(p.width * c.x);
  const y0 = Math.floor(p.height * c.y);
  const w = Math.max(1, Math.round(p.width * c.w));
  const h = Math.max(1, Math.round(p.height * c.h));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(p.height - 1, y0 + y);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(p.width - 1, x0 + x);
      const si = (sy * p.width + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = p.data[si] as number;
      out[di + 1] = p.data[si + 1] as number;
      out[di + 2] = p.data[si + 2] as number;
      out[di + 3] = p.data[si + 3] as number;
    }
  }
  return { width: w, height: h, data: out };
}

export function rotatePixels(p: ImagePixels, degrees: 0 | 90 | 180 | 270): ImagePixels {
  if (degrees === 0) return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
  const swap = degrees === 90 || degrees === 270;
  const w = swap ? p.height : p.width;
  const h = swap ? p.width : p.height;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      let dx: number;
      let dy: number;
      if (degrees === 90) {
        dx = p.height - 1 - y;
        dy = x;
      } else if (degrees === 180) {
        dx = p.width - 1 - x;
        dy = p.height - 1 - y;
      } else {
        dx = y;
        dy = p.width - 1 - x;
      }
      const si = (y * p.width + x) * 4;
      const di = (dy * w + dx) * 4;
      out[di] = p.data[si] as number;
      out[di + 1] = p.data[si + 1] as number;
      out[di + 2] = p.data[si + 2] as number;
      out[di + 3] = p.data[si + 3] as number;
    }
  }
  return { width: w, height: h, data: out };
}

export function flipPixels(p: ImagePixels, horizontal: boolean, vertical: boolean): ImagePixels {
  if (!horizontal && !vertical) return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
  const out = new Uint8ClampedArray(p.data.length);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const sx = horizontal ? p.width - 1 - x : x;
      const sy = vertical ? p.height - 1 - y : y;
      const si = (sy * p.width + sx) * 4;
      const di = (y * p.width + x) * 4;
      out[di] = p.data[si] as number;
      out[di + 1] = p.data[si + 1] as number;
      out[di + 2] = p.data[si + 2] as number;
      out[di + 3] = p.data[si + 3] as number;
    }
  }
  return { width: p.width, height: p.height, data: out };
}

/** Bilinear downscale. Upscaling is refused — it only ever shrinks. */
export function downscalePixels(p: ImagePixels, maxDimension: number): ImagePixels {
  const longest = Math.max(p.width, p.height);
  if (longest <= maxDimension) return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
  const scale = maxDimension / longest;
  const w = Math.max(1, Math.round(p.width * scale));
  const h = Math.max(1, Math.round(p.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / scale - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(p.height - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(p.width - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      for (let c = 0; c < 4; c++) {
        const top = (p.data[(y0 * p.width + x0) * 4 + c] as number) * (1 - fx) + (p.data[(y0 * p.width + x1) * 4 + c] as number) * fx;
        const bot = (p.data[(y1 * p.width + x0) * 4 + c] as number) * (1 - fx) + (p.data[(y1 * p.width + x1) * 4 + c] as number) * fx;
        out[(y * w + x) * 4 + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** The full pipeline, in the fixed order crop -> rotate -> flip ->
 *  downscale. `maxDimension` defaults to 1600 (thread). */
export function processImagePixels(p: ImagePixels, opts: MediaEditOpts): ImagePixels {
  let out = p;
  if (opts.crop) out = cropPixels(out, opts.crop);
  if (opts.rotate) out = rotatePixels(out, opts.rotate);
  if (opts.flipH || opts.flipV) out = flipPixels(out, !!opts.flipH, !!opts.flipV);
  out = downscalePixels(out, opts.maxDimension ?? MAX_IMAGE_DIMENSION);
  return out;
}

// --- Browser helpers (canvas) --------------------------------------------
// These throw a plain Error when the browser APIs are missing, so the
// caller can fall back to attaching the original file instead of
// silently shipping an unprocessed one.

export function assertBrowserImageApis(): void {
  if (typeof OffscreenCanvas === "undefined" && typeof document === "undefined") {
    throw new Error("media editing needs canvas support — this environment has no OffscreenCanvas or document");
  }
}

export async function blobToPixels(file: Blob): Promise<ImagePixels> {
  assertBrowserImageApis();
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("could not get a 2d canvas context for media editing");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: imageData.data };
  } finally {
    bitmap.close();
  }
}

export function pixelsToCanvas(p: ImagePixels): OffscreenCanvas {
  assertBrowserImageApis();
  const canvas = new OffscreenCanvas(p.width, p.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2d canvas context for media editing");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  return canvas;
}

async function canvasToBlob(
  canvas: OffscreenCanvas,
  type: "image/webp" | "image/avif",
  quality: number,
): Promise<Blob | null> {
  const blob = await canvas.convertToBlob({ type, quality });
  return blob;
}

/** Encode pixels as WebP (80%), falling back from AVIF when the browser
 *  cannot encode it (convertToBlob returns null / throws). Returns the
 *  blob and the mime actually used. */
export async function encodeImage(p: ImagePixels, quality = IMAGE_QUALITY): Promise<{ blob: Blob; mime: string }> {
  const canvas = pixelsToCanvas(p);
  for (const type of ["image/avif", "image/webp"] as const) {
    try {
      const blob = await canvasToBlob(canvas, type, quality);
      if (blob && blob.size > 0) return { blob, mime: type };
    } catch {
      // Try the next encoding.
    }
  }
  throw new Error("this browser cannot encode WebP or AVIF — media editing is unavailable here");
}

export interface PreparedImage {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  /** The filename to upload (extension follows the encoded mime). */
  filename: string;
  thumbnail: PreparedImageThumbnail;
}

export interface PreparedImageThumbnail {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  filename: string;
}

function withExtension(filename: string, mime: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return `${base}.${mime === "image/avif" ? "avif" : "webp"}`;
}

/** Attach-time preparation: decode, apply the user's crop/rotate/flip,
 *  downscale to max 1600px, encode WebP 80% (AVIF when available), and
 *  build the ~12 KB thumbnail (max 320px) the same way. The returned
 *  blob is what gets uploaded to IA — the original full-size file never
 *  leaves the device. */
export async function prepareImageForUpload(
  file: Blob,
  filename: string,
  opts: MediaEditOpts = {},
): Promise<PreparedImage> {
  const pixels = await blobToPixels(file);
  const processed = processImagePixels(pixels, { maxDimension: MAX_IMAGE_DIMENSION, ...opts });
  const main = await encodeImage(processed);
  const thumbPixels = downscalePixels(processed, THUMBNAIL_MAX_DIMENSION);
  const thumb = await encodeImage(thumbPixels);
  const thumbFilename = withExtension(filename.replace(/\.[^.]+$/, "") + "-thumb", thumb.mime);
  return {
    blob: main.blob,
    mime: main.mime,
    width: processed.width,
    height: processed.height,
    filename: withExtension(filename, main.mime),
    thumbnail: {
      blob: thumb.blob,
      mime: thumb.mime,
      width: thumbPixels.width,
      height: thumbPixels.height,
      filename: thumbFilename,
    },
  };
}
