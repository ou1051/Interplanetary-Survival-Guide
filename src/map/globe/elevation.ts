import { Credit, CustomHeightmapTerrainProvider, Ellipsoid, GeographicTilingScheme } from 'cesium';
import { TERRAIN } from './catalog';
import { HEIGHTMAP_SIZE } from './dem';
import type { HeightmapResult, ReliefSource } from './demSource';

// ---------------------------------------------------------------------------
// Real Mars relief for Cesium: 200 m MOLA/HRSC everywhere, HiRISE stereo DTMs
// (~1 m) where they exist (the assignment area included).
//
// Why a custom provider rather than Cesium's ArcGISTiledElevationTerrainProvider:
//  - the Mars spatial reference (wkid 104971) is rejected;
//  - the metadata URL with a trailing slash answers without CORS headers;
//  - its 513 × 513 heightmaps rebuild huge meshes per level (refinement stalled).
// All fetching, LERC decoding and resampling happens in a Web Worker
// (demWorker.ts); the main thread only receives 65 × 65 Float32Arrays.
// ---------------------------------------------------------------------------

type Pending = { resolve: (r: HeightmapResult) => void; reject: (e: unknown) => void };

/** Promise-per-tile bridge to the worker, with an in-thread fallback (tests, old browsers). */
export interface HeightmapSource {
  heightmap(x: number, y: number, level: number): Promise<HeightmapResult>;
  dispose(): void;
}

function workerSource(): HeightmapSource {
  const worker = new Worker(new URL('./demWorker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let next = 1;
  worker.onmessage = (e: MessageEvent<{ id: number; heights?: Float32Array; source?: ReliefSource; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.heights) p.resolve({ heights: e.data.heights, source: e.data.source ?? 'mola' });
    else p.reject(new Error(e.data.error ?? 'relief worker failed'));
  };
  return {
    heightmap(x, y, level) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, x, y, level });
      });
    },
    dispose() {
      worker.terminate();
      pending.forEach((p) => p.reject(new Error('disposed')));
      pending.clear();
    },
  };
}

async function inThreadSource(): Promise<HeightmapSource> {
  const [{ default: Lerc }, { createDemSampler, fetchLerc }] = await Promise.all([import('lerc'), import('./demSource')]);
  const sampler = createDemSampler({
    fetchTile: fetchLerc,
    decode: (buf) => {
      const d = Lerc.decode(buf);
      return { pixels: d.pixels[0], width: d.width, height: d.height, mask: d.mask ?? null };
    },
  });
  return { heightmap: (x, y, level) => sampler.heightmap(x, y, level), dispose() {} };
}

export interface MarsTerrain {
  provider: CustomHeightmapTerrainProvider;
  /** Finest relief source used for the display tiles around a point (null = not loaded). */
  sourceAt(lon: number, lat: number): ReliefSource | null;
  dispose(): void;
}

export async function createMarsTerrain(ellipsoid: Ellipsoid, opts: { worker?: boolean } = {}): Promise<MarsTerrain> {
  const useWorker = (opts.worker ?? true) && typeof Worker !== 'undefined';
  const src = useWorker ? workerSource() : await inThreadSource();

  // Probe once so the UI can say "unreachable" instead of showing a flat planet.
  const probe = await src.heightmap(1, 0, 0).catch(() => null);
  if (!probe || probe.source === 'none') {
    src.dispose();
    throw new Error('Mars DEM unreachable');
  }

  // Which tiles got HiRISE relief, for the status read-out.
  const hirise = new Set<string>();
  const flat = () => new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);

  const provider = new CustomHeightmapTerrainProvider({
    width: HEIGHTMAP_SIZE,
    height: HEIGHTMAP_SIZE,
    tilingScheme: new GeographicTilingScheme({ ellipsoid }),
    credit: new Credit(TERRAIN.credit),
    callback: async (x: number, y: number, level: number) => {
      try {
        const r = await src.heightmap(x, y, level);
        if (r.source === 'hirise') hirise.add(`${level}/${x}/${y}`);
        return r.heights;
      } catch {
        return flat();
      }
    },
  });

  return {
    provider,
    sourceAt(lon, lat) {
      for (let level = 22; level >= 12; level--) {
        const span = 180 / 2 ** level;
        const x = Math.floor((lon + 180) / span);
        const y = Math.floor((90 - lat) / span);
        if (hirise.has(`${level}/${x}/${y}`)) return 'hirise';
      }
      return 'mola';
    },
    dispose: () => src.dispose(),
  };
}
