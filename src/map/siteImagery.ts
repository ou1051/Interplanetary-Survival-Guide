import { albedo } from './globe/marsPaint';

// ---------------------------------------------------------------------------
// Real orbital backdrop for the site plan.
// Given the grid's geographic centre, fetch MRO HiRISE tiles (Esri's Mars
// HiRISE cache, 512 px, geographic 2 × 1 tiling) around it, tint them with the
// globe's painted colour of that ground (HiRISE red band is greyscale), and stitch them
// into one canvas whose extent is known in metres east/north of the centre.
// Loads coarse first (whole context) and sharp second (around the grid).
// ---------------------------------------------------------------------------

export const MARS_M_PER_DEG = (2 * Math.PI * 3_396_190) / 360; // ≈ 59 274 m
export const HIRISE_TILES = 'https://astro.arcgis.com/arcgis/rest/services/OnMars/HiRISE/MapServer/tile';
export const VIKING_TILES = 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0//default/default028mm';
const TILE = 512;

export interface Extent {
  /** Metres from the centre (east +, north +). */
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface Backdrop {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  extent: Extent;
  level: number;
  /** Ground metres per backdrop pixel (east-west). */
  mpp: number;
}

export interface TileRef {
  x: number;
  y: number;
  level: number;
}

/** Degrees per pixel in a geographic 2 × 1 tiling of 512 px tiles. */
export const degPerPx = (level: number) => 180 / TILE / 2 ** level;

/** Metres → degrees at a latitude. */
export function toDegrees(lat: number, eastM: number, northM: number) {
  return { dLon: eastM / (MARS_M_PER_DEG * Math.cos((lat * Math.PI) / 180)), dLat: northM / MARS_M_PER_DEG };
}

/** Coarsest level whose pixels are at most `maxMpp` metres (capped at maxLevel). */
export function levelFor(maxMpp: number, lat: number, maxLevel = 17): number {
  for (let l = 8; l <= maxLevel; l++) {
    const mpp = degPerPx(l) * MARS_M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    if (mpp <= maxMpp) return l;
  }
  return maxLevel;
}

/** Tiles covering an extent around a centre. */
export function tilesFor(center: { lat: number; lon: number }, ext: Extent, level: number): TileRef[] {
  const a = toDegrees(center.lat, ext.west, ext.north);
  const b = toDegrees(center.lat, ext.east, ext.south);
  const span = 180 / 2 ** level;
  const x0 = Math.floor((center.lon + a.dLon + 180) / span);
  const x1 = Math.floor((center.lon + b.dLon + 180) / span);
  const y0 = Math.floor((90 - (center.lat + a.dLat)) / span);
  const y1 = Math.floor((90 - (center.lat + b.dLat)) / span);
  const out: TileRef[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y, level });
  return out;
}

/**
 * Levels for a greyscale image: map the 1st–99.7th percentile to 7–93 % with a
 * slight gamma lift. HiRISE frames of Gale are dark (mean ≈ 55/255) and would
 * otherwise look muddy once tinted.
 */
export function levelsLut(hist: Uint32Array, total: number): Uint8ClampedArray {
  const pct = (q: number) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= q * total) return i;
    }
    return 255;
  };
  const lo = pct(0.01);
  const hi = Math.max(lo + 1, pct(0.997));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const t = Math.min(1, Math.max(0, (i - lo) / (hi - lo)));
    lut[i] = Math.round((0.07 + 0.86 * Math.pow(t, 0.8)) * 255);
  }
  return lut;
}

async function bitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await createImageBitmap(await r.blob());
  } catch {
    return null; // Esri answers missing tiles without CORS headers
  }
}

/** Average Viking colour around a point (level 7, 3 × 3 px). */
async function groundColor(lat: number, lon: number): Promise<[number, number, number]> {
  // same designed palette as the globe's painted surface (globe/marsPaint.ts)
  const level = 7;
  const span = 180 / 2 ** level;
  const x = Math.floor((lon + 180) / span);
  const y = Math.floor((90 - lat) / span);
  const bm = await bitmap(`${VIKING_TILES}/${level}/${y}/${x}.jpg`);
  if (!bm) return [196, 130, 92];
  const c = new OffscreenCanvas(bm.width, bm.height);
  const g = c.getContext('2d')!;
  g.drawImage(bm, 0, 0);
  const px = Math.floor(((lon + 180) / span - x) * bm.width);
  const py = Math.floor(((90 - lat) / span - y) * bm.height);
  const d = g.getImageData(Math.max(0, px - 1), Math.max(0, py - 1), 3, 3).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return albedo(r / n, gg / n, b / n, lat).map(Math.round) as [number, number, number];
}

/**
 * Build the backdrop. `onProgress` is called with a drawable backdrop after
 * the coarse pass and again after the sharp pass.
 */
export async function loadBackdrop(
  center: { lat: number; lon: number },
  context: Extent,
  sharp: Extent,
  onProgress: (b: Backdrop) => void,
  opts: { sharpMpp?: number; coarseMpp?: number } = {},
): Promise<Backdrop | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const tint = groundColor(center.lat, center.lon);
  const coarseLevel = levelFor(opts.coarseMpp ?? 0.4, center.lat);
  const sharpLevel = levelFor(opts.sharpMpp ?? 0.17, center.lat);
  const cosLat = Math.cos((center.lat * Math.PI) / 180);

  // Output canvas at the sharp resolution over the whole context.
  const mpp = degPerPx(sharpLevel) * MARS_M_PER_DEG * cosLat;
  const mppN = degPerPx(sharpLevel) * MARS_M_PER_DEG;
  const W = Math.min(8192, Math.ceil((context.east - context.west) / mpp));
  const H = Math.min(8192, Math.ceil((context.north - context.south) / mppN));
  const out = new OffscreenCanvas(W, H);
  const g = out.getContext('2d')!;
  g.fillStyle = '#2a1a12';
  g.fillRect(0, 0, W, H);
  const color = await tint;

  const place = async (tiles: TileRef[]) => {
    await Promise.all(
      tiles.map(async (t) => {
        const bm = await bitmap(`${HIRISE_TILES}/${t.level}/${t.y}/${t.x}`);
        if (!bm) return;
        // tile corner in metres from the centre
        const span = 180 / 2 ** t.level;
        const lonW = -180 + t.x * span;
        const latN = 90 - t.y * span;
        const eastM = (lonW - center.lon) * MARS_M_PER_DEG * cosLat;
        const northM = (latN - center.lat) * MARS_M_PER_DEG;
        const sizeE = span * MARS_M_PER_DEG * cosLat;
        const sizeN = span * MARS_M_PER_DEG;
        g.imageSmoothingQuality = 'high';
        g.drawImage(bm, (eastM - context.west) / mpp, (context.north - northM) / mppN, sizeE / mpp, sizeN / mppN);
        bm.close();
      }),
    );
  };

  const finish = (level: number): Backdrop => {
    const c = new OffscreenCanvas(W, H);
    const cg = c.getContext('2d', { willReadFrequently: true })!;
    cg.drawImage(out, 0, 0);
    // levels from the histogram of the area around the grid (where it matters)
    const sx = Math.round((sharp.west - context.west) / mpp);
    const sy = Math.round((context.north - sharp.north) / mppN);
    const sw = Math.max(1, Math.round((sharp.east - sharp.west) / mpp));
    const sh = Math.max(1, Math.round((sharp.north - sharp.south) / mppN));
    const sample = cg.getImageData(sx, sy, Math.min(sw, W - sx), Math.min(sh, H - sy)).data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < sample.length; i += 16) hist[sample[i]]++;
    const lut = levelsLut(hist, sample.length / 16);
    const img = cg.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = lut[d[i]];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    cg.putImageData(img, 0, 0);
    // colour: luminance from HiRISE, hue/saturation from the ground's Viking colour
    cg.globalCompositeOperation = 'color';
    cg.globalAlpha = 1;
    cg.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    cg.fillRect(0, 0, W, H);
    cg.globalCompositeOperation = 'source-over';
    cg.globalAlpha = 1;
    return { canvas: c, extent: context, level, mpp };
  };

  await place(tilesFor(center, context, coarseLevel));
  onProgress(finish(coarseLevel));
  if (sharpLevel > coarseLevel) await place(tilesFor(center, sharp, sharpLevel));
  const done = finish(sharpLevel);
  onProgress(done);
  return done;
}
