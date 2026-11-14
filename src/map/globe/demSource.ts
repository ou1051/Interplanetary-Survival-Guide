// Mars relief pipeline (no Cesium import): fetches LERC elevation tiles from
// Esri's Mars image services, decodes them, and builds N × N heightmaps for
// display tiles. Runs inside a Web Worker in the app (see demWorker.ts) so the
// main thread never decodes megabyte-sized float rasters.
//
// Two sources, both geographic 2 × 1 tilings (origin -180/90), 513 × 513 posts:
//   MOLA  Mars 200 m DEM (MOLA + HRSC), global, levels 0–7.
//   HIRISE  HiRISE stereo DTM mosaic (~1 m), sparse (~500 DTMs through 2018),
//           levels 0–15. Gale crater around the assignment is covered.
// HiRISE heights are used where valid and consistent with MOLA (|Δ| < 250 m,
// which rejects the pyramid's edge artefacts); everywhere else MOLA.

import { DEM_MAX_LEVEL, HEIGHTMAP_SIZE, LruCache, heightmapFor, sampleRaster, tileRect, type DegRect, type SourceRaster } from './dem';

export const HIRISE_MAX_LEVEL = 15;
/** Display tiles shallower than this never use HiRISE (its pyramid is patchy there). */
export const HIRISE_MIN_DISPLAY_LEVEL = 12;
/** Display level L reads source level L - SOURCE_LAG: 512 posts span 8 display tiles ≈ 64 posts each. */
export const SOURCE_LAG = 3;
/** Coverage oracle: one coarse HiRISE tile tells whether any DTM lies under a display tile. */
export const HIRISE_COVERAGE_LEVEL = 6;
export const MAX_DEVIATION_M = 250;

export type DemService = 'mola' | 'hirise';
export type ReliefSource = 'hirise' | 'mola' | 'none';

export interface DecodedTile {
  pixels: ArrayLike<number>;
  width: number;
  height: number;
  mask?: ArrayLike<number> | null;
}

export interface DemIO {
  /** Raw LERC bytes, or null when the service has no such tile. Throws on network failure. */
  fetchTile(service: DemService, level: number, y: number, x: number): Promise<ArrayBuffer | null>;
  decode(buf: ArrayBuffer): DecodedTile;
}

export interface HeightmapResult {
  heights: Float32Array;
  source: ReliefSource;
}

export const sourceLevelFor = (displayLevel: number, max: number) => Math.max(0, Math.min(max, displayLevel - SOURCE_LAG));

/** Source tile containing a display tile, at a given source level. */
export function ancestor(x: number, y: number, level: number, srcLevel: number) {
  const shift = level - srcLevel;
  return shift <= 0 ? { x, y, level } : { x: x >> shift, y: y >> shift, level: srcLevel };
}

/** True if any valid sample of `src` falls inside `rect` (coarse coverage test). */
export function hasDataIn(src: SourceRaster, rect: DegRect): boolean {
  if (!src.mask) return true;
  const { width: w, height: h } = src;
  const sx = (src.rect.east - src.rect.west) / (src.posts ? w - 1 : w);
  const sy = (src.rect.north - src.rect.south) / (src.posts ? h - 1 : h);
  const i0 = Math.max(0, Math.floor((rect.west - src.rect.west) / sx) - 1);
  const i1 = Math.min(w - 1, Math.ceil((rect.east - src.rect.west) / sx) + 1);
  const j0 = Math.max(0, Math.floor((src.rect.north - rect.north) / sy) - 1);
  const j1 = Math.min(h - 1, Math.ceil((src.rect.north - rect.south) / sy) + 1);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (src.mask[j * w + i]) return true;
  return false;
}

export function createDemSampler(io: DemIO, n = HEIGHTMAP_SIZE) {
  // Decoded rasters are ~1 MB each; keep the working set small.
  const caches: Record<DemService, LruCache<Promise<SourceRaster | null>>> = {
    mola: new LruCache(20),
    hirise: new LruCache(20),
  };

  function load(service: DemService, level: number, y: number, x: number): Promise<SourceRaster | null> {
    const key = `${level}/${y}/${x}`;
    const cache = caches[service];
    const hit = cache.get(key);
    if (hit) return hit;
    const p = (async (): Promise<SourceRaster | null> => {
      try {
        const buf = await io.fetchTile(service, level, y, x);
        if (!buf) return null;
        const d = io.decode(buf);
        return {
          pixels: d.pixels,
          width: d.width,
          height: d.height,
          mask: d.mask ?? null,
          rect: tileRect(x, y, level),
          posts: d.width % 2 === 1, // 513 × 513: samples sit on tile edges
        };
      } catch {
        // HiRISE misses come back without CORS headers, which looks exactly like
        // a network error. Either way the tile is unavailable right now.
        return null;
      }
    })();
    cache.set(key, p);
    // MOLA is global: a miss is a network problem worth retrying later. HiRISE
    // misses are remembered so sparse areas are not requested again and again.
    if (service === 'mola') void p.then((v) => v === null && cache.delete(key));
    return p;
  }

  async function hiriseFor(x: number, y: number, level: number): Promise<SourceRaster | null> {
    if (level < HIRISE_MIN_DISPLAY_LEVEL) return null;
    const rect = tileRect(x, y, level);
    const c = ancestor(x, y, level, HIRISE_COVERAGE_LEVEL);
    const coverage = await load('hirise', c.level, c.y, c.x);
    if (!coverage || !hasDataIn(coverage, rect)) return null;
    const s = ancestor(x, y, level, sourceLevelFor(level, HIRISE_MAX_LEVEL));
    const src = await load('hirise', s.level, s.y, s.x);
    return src && hasDataIn(src, rect) ? src : null;
  }

  return {
    async heightmap(x: number, y: number, level: number): Promise<HeightmapResult> {
      const m = ancestor(x, y, level, sourceLevelFor(level, DEM_MAX_LEVEL));
      const [mola, hirise] = await Promise.all([load('mola', m.level, m.y, m.x), hiriseFor(x, y, level)]);
      const rect = tileRect(x, y, level);
      if (!mola) return { heights: new Float32Array(n * n), source: 'none' };
      const base = heightmapFor(mola, rect, n);
      if (!hirise) return { heights: base, source: 'mola' };
      let used = 0;
      for (let j = 0; j < n; j++) {
        const lat = rect.north - ((rect.north - rect.south) * j) / (n - 1);
        for (let i = 0; i < n; i++) {
          const lon = rect.west + ((rect.east - rect.west) * i) / (n - 1);
          const k = j * n + i;
          const h = sampleRaster(hirise, lon, lat, Number.NaN);
          if (Number.isFinite(h) && Math.abs(h - base[k]) < MAX_DEVIATION_M) {
            base[k] = h;
            used++;
          }
        }
      }
      return { heights: base, source: used > (n * n) / 4 ? 'hirise' : 'mola' };
    },
    /** For tests and diagnostics. */
    cacheSizes: () => ({ mola: caches.mola.size, hirise: caches.hirise.size }),
  };
}

export type DemSampler = ReturnType<typeof createDemSampler>;

/** Real network IO for the Esri Mars services (browser or worker). */
export const SERVICE_URL: Record<DemService, string> = {
  mola: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/MDEM200M/ImageServer',
  hirise: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/HiRISE_DEM/ImageServer',
};

export async function fetchLerc(service: DemService, level: number, y: number, x: number): Promise<ArrayBuffer | null> {
  const res = await fetch(`${SERVICE_URL[service]}/tile/${level}/${y}/${x}`);
  return res.ok ? res.arrayBuffer() : null;
}
