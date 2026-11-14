// Pure DEM resampling for the Mars terrain (no Cesium import, unit-tested).
//
// Esri's Mars 200 m DEM is a geographic tile cache (2 × 1 tiles at level 0,
// origin -180/90) of 512 × 512 float pixels, levels 0–7. Cesium meshes each
// terrain tile from an N × N heightmap. Handing it 513 × 513 samples per tile
// (what the stock ArcGIS provider does) makes every refinement level rebuild a
// huge mesh on the main thread, so we resample to N × N ourselves, always from
// the deepest source tile, at any display level.

export const DEM_TILE = 512;
export const DEM_MAX_LEVEL = 7;
export const HEIGHTMAP_SIZE = 65;

export interface DegRect {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Extent of a geographic 2×1 tile in degrees. */
export function tileRect(x: number, y: number, level: number): DegRect {
  const span = 180 / 2 ** level;
  const west = -180 + x * span;
  const north = 90 - y * span;
  return { west, east: west + span, north, south: north - span };
}

/** The source tile (≤ DEM_MAX_LEVEL) that contains a display tile. */
export function sourceTileFor(x: number, y: number, level: number, maxLevel = DEM_MAX_LEVEL): { x: number; y: number; level: number } {
  if (level <= maxLevel) return { x, y, level };
  const shift = level - maxLevel;
  return { x: x >> shift, y: y >> shift, level: maxLevel };
}

export interface SourceRaster {
  /** Row-major heights, row 0 = north edge. */
  pixels: ArrayLike<number>;
  width: number;
  height: number;
  /** 1 = valid, 0 = no data (optional). */
  mask?: ArrayLike<number> | null;
  rect: DegRect;
}

/**
 * Bilinear sample of the raster at lon/lat. Pixel centres sit half a pixel in
 * from the edges; outside the centres we clamp. No-data neighbours are ignored;
 * if all four are missing the result is `fallback`.
 */
export function sampleRaster(src: SourceRaster, lon: number, lat: number, fallback = 0): number {
  const { width: w, height: h, rect } = src;
  const fx = ((lon - rect.west) / (rect.east - rect.west)) * w - 0.5;
  const fy = ((rect.north - lat) / (rect.north - rect.south)) * h - 0.5;
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const at = (x: number, y: number): number | null => {
    const i = y * w + x;
    if (src.mask && !src.mask[i]) return null;
    const v = src.pixels[i];
    return Number.isFinite(v) && v > -1e20 ? v : null;
  };
  const corners: [number | null, number][] = [
    [at(x0, y0), (1 - tx) * (1 - ty)],
    [at(x1, y0), tx * (1 - ty)],
    [at(x0, y1), (1 - tx) * ty],
    [at(x1, y1), tx * ty],
  ];
  let sum = 0;
  let wsum = 0;
  for (const [v, wt] of corners) {
    if (v === null) continue;
    sum += v * wt;
    wsum += wt;
  }
  if (wsum > 0) return sum / wsum;
  const any = corners.find(([v]) => v !== null);
  return any ? (any[0] as number) : fallback;
}

/** N × N heightmap (row 0 = north) for a display tile, sampled from its source raster. */
export function heightmapFor(src: SourceRaster, dst: DegRect, n = HEIGHTMAP_SIZE): Float32Array {
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const lat = dst.north - ((dst.north - dst.south) * j) / (n - 1);
    for (let i = 0; i < n; i++) {
      const lon = dst.west + ((dst.east - dst.west) * i) / (n - 1);
      out[j * n + i] = sampleRaster(src, lon, lat);
    }
  }
  return out;
}

/** Small LRU for decoded source tiles. */
export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private capacity: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as string);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  get size() {
    return this.map.size;
  }
}
