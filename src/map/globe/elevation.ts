import { Credit, CustomHeightmapTerrainProvider, Ellipsoid, GeographicTilingScheme } from 'cesium';
import { TERRAIN } from './catalog';
import { HEIGHTMAP_SIZE } from './dem';
import type { HeightmapResult, ReliefSource } from './demSource';
import { marsWorker, workerSupported } from './workerBridge';

// ---------------------------------------------------------------------------
// Real Mars relief for Cesium: 200 m MOLA/HRSC everywhere, HiRISE stereo DTMs
// (~1 m) where they exist (the assignment area included).
//
// Why a custom provider rather than Cesium's ArcGISTiledElevationTerrainProvider:
//  - the Mars spatial reference (wkid 104971) is rejected;
//  - the metadata URL with a trailing slash answers without CORS headers;
//  - its 513 × 513 heightmaps rebuild huge meshes per level (refinement stalled).
// All fetching, LERC decoding and resampling happens in the globe's worker
// (marsWorker.ts); the main thread only receives 65 × 65 Float32Arrays.
// ---------------------------------------------------------------------------

/** Promise-per-tile relief source: the shared worker, or in-thread (tests, old browsers). */
export interface HeightmapSource {
  heightmap(x: number, y: number, level: number): Promise<HeightmapResult>;
  dispose(): void;
}

function workerSource(): HeightmapSource {
  const w = marsWorker();
  return { heightmap: (x, y, level) => w.heightmap(x, y, level), dispose: () => w.release() };
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
  const useWorker = (opts.worker ?? true) && workerSupported();
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
