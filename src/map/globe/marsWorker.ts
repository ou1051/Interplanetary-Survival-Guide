/// <reference lib="webworker" />
// The globe's single background worker. Everything heavy happens here, never
// on the main thread:
//   heightmap  fetch + LERC-decode + resample relief (MOLA/HRSC, HiRISE DTM)
//   paint      the designed base surface: Viking albedo → palette, × MOLA hillshade
//   tint       colour a greyscale CTX/HiRISE tile with the painted colour under it
// Images go back as ImageBitmaps in the orientation Cesium expects (pre-flipped
// vertically), so the main thread only uploads textures.
import Lerc from 'lerc';
import { COLOR_BASE } from './catalog';
import { LruCache, tileRect } from './dem';
import { createDemSampler, fetchLerc } from './demSource';
import { PAINT_MAX_LEVEL, PAINT_TILE, colorPatch, demLevelFor, hillshade, paint } from './marsPaint';

export type MarsJob =
  | { id: number; type: 'heightmap'; x: number; y: number; level: number }
  | { id: number; type: 'paint'; x: number; y: number; level: number }
  | { id: number; type: 'tint'; x: number; y: number; level: number; detail: ImageBitmap; url: string; tileSize: number; blackIsNoData: boolean };

const sampler = createDemSampler({
  fetchTile: fetchLerc,
  decode: (buf) => {
    const d = Lerc.decode(buf);
    return { pixels: d.pixels[0], width: d.width, height: d.height, mask: d.mask ?? null };
  },
});

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
const fill = (url: string, z: number, y: number, x: number) => url.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x));

// ------------------------------------------------------------------ colour source

const vikingTiles = new LruCache<Promise<ImageBitmap | null>>(64);
function viking(level: number, y: number, x: number): Promise<ImageBitmap | null> {
  const key = `${level}/${y}/${x}`;
  const hit = vikingTiles.get(key);
  if (hit) return hit;
  const p = fetch(fill(COLOR_BASE.url, level, y, x))
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b ? createImageBitmap(b) : null))
    .catch(() => null);
  vikingTiles.set(key, p);
  return p;
}

/** Painted tile, RGBA, row 0 = north (cached: tint jobs reuse them). */
const painted = new LruCache<Promise<Uint8ClampedArray>>(96);
const scratch = new OffscreenCanvas(PAINT_TILE, PAINT_TILE);
const sg = scratch.getContext('2d', { willReadFrequently: true })!;

function paintedTile(x: number, y: number, level: number): Promise<Uint8ClampedArray> {
  const key = `${level}/${y}/${x}`;
  const hit = painted.get(key);
  if (hit) return hit;
  const p = (async () => {
    const c = colorPatch(x, y, level, COLOR_BASE);
    const d = demLevelFor(level);
    const shift = level - d;
    const [bm, dem] = await Promise.all([viking(c.level, c.y, c.x), sampler.mola(d, y >> shift, x >> shift)]);
    sg.clearRect(0, 0, PAINT_TILE, PAINT_TILE);
    if (bm) {
      sg.imageSmoothingEnabled = true;
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(bm, c.sx, c.sy, c.size, c.size, 0, 0, PAINT_TILE, PAINT_TILE);
    } else {
      sg.fillStyle = 'rgb(130, 99, 94)'; // Viking's median ground
      sg.fillRect(0, 0, PAINT_TILE, PAINT_TILE);
    }
    const rgba = sg.getImageData(0, 0, PAINT_TILE, PAINT_TILE).data;
    const shade = dem ? hillshade(dem, x, y, level) : new Float32Array(PAINT_TILE * PAINT_TILE).fill(1);
    return paint(rgba, shade, PAINT_TILE, tileRect(x, y, level));
  })();
  painted.set(key, p);
  p.catch(() => painted.delete(key));
  return p;
}

/** RGBA (row 0 = north) → ImageBitmap flipped for WebGL upload. */
function flippedBitmap(rgba: Uint8ClampedArray, size: number): Promise<ImageBitmap> {
  const img = new ImageData(size, size);
  const row = size * 4;
  for (let j = 0; j < size; j++) img.data.set(rgba.subarray(j * row, (j + 1) * row), (size - 1 - j) * row);
  return createImageBitmap(img);
}

// ------------------------------------------------------------------ detail transfer

/**
 * Level at which a detail mosaic's pixels are about one Viking pixel (≈ 232 m):
 * its view there is the "coarse" reference the detail is measured against.
 */
export const anchorLevel = (tileSize: number) => (tileSize >= 512 ? 7 : 8);

const ancestors = new LruCache<Promise<ImageBitmap | null>>(48);
function ancestor(url: string, level: number, y: number, x: number): Promise<ImageBitmap | null> {
  const key = `${url}|${level}/${y}/${x}`;
  const hit = ancestors.get(key);
  if (hit) return hit;
  const p = fetch(fill(url, level, y, x))
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b ? createImageBitmap(b) : null))
    .catch(() => null); // bbox-limited mosaics answer missing tiles without CORS
  ancestors.set(key, p);
  return p;
}

const lum = (d: Uint8ClampedArray, k: number) => 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];

/**
 * Pan-sharpening by detail transfer: colour and brightness from the painted
 * surface; structure from the greyscale mosaic as the ratio of each pixel to
 * the same mosaic's coarse (ancestor-level) view. Seamless across tiles and
 * across mosaics with different processing, and consistent with the orbit view.
 */
async function tint(job: Extract<MarsJob, { type: 'tint' }>): Promise<ImageBitmap> {
  const { detail, x, y, level, url, tileSize, blackIsNoData } = job;
  const w = detail.width;
  const h = detail.height;
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  // everything below is drawn in Cesium's flipped orientation
  const flipped = (draw: () => void) => {
    g.save();
    g.translate(0, h);
    g.scale(1, -1);
    draw();
    g.restore();
  };

  // 1. detail (already flipped)
  g.drawImage(detail, 0, 0);
  const det = g.getImageData(0, 0, w, h).data;
  detail.close();

  // 2. painted colour under the tile
  const c = colorPatch(x, y, level, { tileSize: PAINT_TILE, maxLevel: PAINT_MAX_LEVEL });
  const rgba = await paintedTile(c.x, c.y, c.level);
  const pc = new OffscreenCanvas(PAINT_TILE, PAINT_TILE);
  pc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), PAINT_TILE, PAINT_TILE), 0, 0);
  g.clearRect(0, 0, w, h);
  flipped(() => g.drawImage(pc, c.sx, c.sy, c.size, c.size, 0, 0, w, h));
  const col = g.getImageData(0, 0, w, h).data;

  // 3. the mosaic's own coarse view of the same ground
  const aL = anchorLevel(tileSize);
  let ref: Uint8ClampedArray | null = null;
  if (level > aL) {
    const shift = level - aL;
    const bm = await ancestor(url, aL, y >> shift, x >> shift);
    if (bm) {
      const n = 2 ** shift;
      const sub = bm.width / n;
      g.clearRect(0, 0, w, h);
      flipped(() => g.drawImage(bm, (x % n) * sub, (y % n) * sub, sub, sub, 0, 0, w, h));
      ref = g.getImageData(0, 0, w, h).data;
    }
  }

  // tile mean as a fallback reference where the coarse view has no data
  let sum = 0;
  let cnt = 0;
  const valid = (d: Uint8ClampedArray, k: number) => d[k + 3] > 8 && !(blackIsNoData && d[k] < 3 && d[k + 1] < 3 && d[k + 2] < 3);
  for (let k = 0; k < det.length; k += 4) if (valid(det, k)) { sum += lum(det, k); cnt++; }
  const mean = cnt ? sum / cnt : 1;

  const out = new ImageData(w, h);
  const o = out.data;
  for (let k = 0; k < det.length; k += 4) {
    if (!valid(det, k)) continue; // transparent: no data
    const v = lum(det, k);
    let ratio: number;
    if (level <= aL) ratio = 1; // at or above the anchor the painted surface is the image
    else if (ref && valid(ref, k)) ratio = (v + 3) / (lum(ref, k) + 3);
    else ratio = (v + 3) / (mean + 3);
    ratio = Math.min(3.2, Math.max(0.22, ratio));
    let r = col[k] * ratio;
    let gg = col[k + 1] * ratio;
    let b = col[k + 2] * ratio;
    const m = Math.max(r, gg, b);
    if (m > 255) {
      // roll highlights off along the same hue instead of clipping to white
      const f = 255 / m;
      r *= f;
      gg *= f;
      b *= f;
    }
    o[k] = r;
    o[k + 1] = gg;
    o[k + 2] = b;
    o[k + 3] = 255;
  }
  return createImageBitmap(out);
}

self.onmessage = async (e: MessageEvent<MarsJob>) => {
  const job = e.data;
  try {
    if (job.type === 'heightmap') {
      const r = await sampler.heightmap(job.x, job.y, job.level);
      post({ id: job.id, heights: r.heights, source: r.source }, [r.heights.buffer]);
    } else if (job.type === 'paint') {
      const bitmap = await flippedBitmap(await paintedTile(job.x, job.y, job.level), PAINT_TILE);
      post({ id: job.id, bitmap }, [bitmap]);
    } else {
      const bitmap = await tint(job);
      post({ id: job.id, bitmap }, [bitmap]);
    }
  } catch (err) {
    post({ id: job.id, error: String(err) });
  }
};
