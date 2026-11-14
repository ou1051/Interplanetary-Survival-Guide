import { ArcGISTiledElevationTerrainProvider, Ellipsoid, Resource } from 'cesium';
import { TERRAIN } from './catalog';

/**
 * Esri's Mars 200 m DEM is an ordinary geographic (lon/lat) LERC tile cache, but
 * its spatial reference is "GCS_Mars_2000_Sphere" (wkid 104971), which Cesium's
 * ArcGIS terrain provider refuses. We relabel only the metadata response as a
 * geographic grid; the tiles, tiling scheme and LERC decoding are Cesium's own.
 */
class MarsGeographicResource extends Resource {
  override clone(result?: Resource): Resource {
    return super.clone(result ?? new MarsGeographicResource({ url: this.url }));
  }

  override getDerivedResource(options: Parameters<Resource['getDerivedResource']>[0]): Resource {
    const derived = super.getDerivedResource(options);
    const q = options?.queryParameters as Record<string, unknown> | undefined;
    if (q?.f === 'pjson') {
      const metadata = new Resource({ url: TERRAIN.url.replace(/\/+$/, ''), queryParameters: { f: 'pjson' } });
      derived.fetchJson = (async () => {
        const meta = (await metadata.fetchJson()) as Record<string, any> | undefined;
        if (meta?.spatialReference) meta.spatialReference = { wkid: 4326, marsWkid: meta.spatialReference.wkid };
        return meta;
      }) as Resource['fetchJson'];
    }
    return derived;
  }
}

export async function createMarsTerrain(ellipsoid: Ellipsoid): Promise<ArcGISTiledElevationTerrainProvider> {
  const provider = await ArcGISTiledElevationTerrainProvider.fromUrl(new MarsGeographicResource({ url: TERRAIN.url }), { ellipsoid });
  // shortcut: Cesium only exposes the DEM's LOD limit internally; revisit when its terrain API changes.
  const maxLevel = (provider as ArcGISTiledElevationTerrainProvider & { _lodCount: number })._lodCount;
  provider.getTileDataAvailable = (_x, _y, level) => level <= maxLevel;
  return provider;
}
