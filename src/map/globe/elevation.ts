import { Credit, CustomHeightmapTerrainProvider, Ellipsoid, GeographicTilingScheme } from 'cesium';
import Lerc from 'lerc';
import { TERRAIN } from './catalog';
import { DEM_MAX_LEVEL, DEM_TILE, HEIGHTMAP_SIZE, LruCache, heightmapFor, sourceTileFor, tileRect, type SourceRaster } from './dem';

// ---------------------------------------------------------------------------
// Real Mars relief from Esri's "Mars 200 m DEM" (MOLA + HRSC), served as LERC.
// Why a custom provider rather than Cesium's ArcGISTiledElevationTerrainProvider:
//  - its spatial reference (GCS_Mars_2000_Sphere, wkid 104971) is rejected;
//  - its metadata URL with a trailing slash answers without CORS headers;
//  - it has no tile map, and its 513 × 513 heightmaps make each refinement
//    level rebuild huge meshes (the view stalled around level 9 in testing).
// We decode the LERC tiles ourselves (Esri's lerc decoder, which reads the
// service's LERC1 "CntZImage" blobs) and give Cesium 65 × 65 heightmaps
// resampled from the deepest source tile at every display level.
// ---------------------------------------------------------------------------

const cache = new LruCache<Promise<SourceRaster | null>>(48);

async function loadSource(level: number, y: number, x: number): Promise<SourceRaster | null> {
  const key = `${level}/${y}/${x}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`${TERRAIN.url}/tile/${level}/${y}/${x}`);
    if (!res.ok) return null;
    const decoded = Lerc.decode(await res.arrayBuffer());
    return {
      pixels: decoded.pixels[0],
      width: decoded.width || DEM_TILE,
      height: decoded.height || DEM_TILE,
      mask: decoded.mask ?? null,
      rect: tileRect(x, y, level),
    } satisfies SourceRaster;
  })();
  cache.set(key, p);
  // a failed fetch should be retried later, not remembered forever
  p.then(
    (v) => v === null && cache.delete(key),
    () => cache.delete(key),
  );
  return p;
}

export async function createMarsTerrain(ellipsoid: Ellipsoid): Promise<CustomHeightmapTerrainProvider> {
  // Probe once so the UI can say "unreachable" instead of showing a flat planet.
  const probe = await loadSource(0, 0, 1);
  if (!probe) throw new Error('Mars DEM unreachable');
  const flat = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  return new CustomHeightmapTerrainProvider({
    width: HEIGHTMAP_SIZE,
    height: HEIGHTMAP_SIZE,
    tilingScheme: new GeographicTilingScheme({ ellipsoid }),
    credit: new Credit(TERRAIN.credit),
    callback: async (x: number, y: number, level: number) => {
      const s = sourceTileFor(x, y, level, DEM_MAX_LEVEL);
      try {
        const src = await loadSource(s.level, s.y, s.x);
        return src ? heightmapFor(src, tileRect(x, y, level)) : flat;
      } catch {
        return flat;
      }
    },
  });
}
