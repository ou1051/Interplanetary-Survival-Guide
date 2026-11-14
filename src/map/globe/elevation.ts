import { ArcGISTiledElevationTerrainProvider, Ellipsoid, Resource } from 'cesium';
import { TERRAIN } from './catalog';

/**
 * Esri's Mars 200 m DEM is an ordinary geographic (lon/lat) LERC tile cache, but
 * its spatial reference is "GCS_Mars_2000_Sphere" (wkid 104971), which Cesium's
 * ArcGIS terrain provider refuses. We relabel only the metadata response as a
 * geographic grid; the tiles, tiling scheme and LERC decoding are Cesium's own.
 */
class MarsGeographicResource extends Resource {
  override getDerivedResource(options: Parameters<Resource['getDerivedResource']>[0]): Resource {
    const derived = super.getDerivedResource(options);
    const q = options?.queryParameters as Record<string, unknown> | undefined;
    if (q?.f === 'pjson') {
      const fetchJson = derived.fetchJson.bind(derived);
      derived.fetchJson = (async (...args: Parameters<Resource['fetchJson']>) => {
        const meta = (await fetchJson(...args)) as Record<string, any> | undefined;
        if (meta?.spatialReference) meta.spatialReference = { wkid: 4326, marsWkid: meta.spatialReference.wkid };
        return meta;
      }) as Resource['fetchJson'];
    }
    return derived;
  }
}

export async function createMarsTerrain(ellipsoid: Ellipsoid): Promise<ArcGISTiledElevationTerrainProvider> {
  return ArcGISTiledElevationTerrainProvider.fromUrl(new MarsGeographicResource({ url: TERRAIN.url }), { ellipsoid });
}
