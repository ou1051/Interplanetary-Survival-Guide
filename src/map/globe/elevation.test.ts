import { afterEach, expect, it, vi } from 'vitest';
import { Ellipsoid, Resource } from 'cesium';
import { createMarsTerrain } from './elevation';

afterEach(() => vi.restoreAllMocks());

it('loads Mars metadata through Cesium resource cloning and stops at the last DEM level', async () => {
  const urls: string[] = [];
  vi.spyOn(Resource.prototype, 'fetchJson').mockImplementation(function (this: Resource) {
    urls.push(this.url);
    return Promise.resolve({
      spatialReference: { wkid: 104971, latestWkid: 104971 },
      extent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90 },
      capabilities: 'Image',
      tileInfo: { rows: 256, cols: 256, format: 'LERC', lods: [{ level: 0 }, { level: 1 }] },
      bandCount: 1,
      minValues: [-8210],
      maxValues: [21241],
    });
  });

  const terrain = await createMarsTerrain(Ellipsoid.MARS);

  expect(terrain.tilingScheme.ellipsoid).toEqual(Ellipsoid.MARS);
  expect(urls).toEqual(['https://astro.arcgis.com/arcgis/rest/services/OnMars/MDEM200M/ImageServer?f=pjson']);
  expect(terrain.getTileDataAvailable(0, 0, 0)).toBe(true);
  expect(terrain.getTileDataAvailable(0, 0, 1)).toBe(true);
  expect(terrain.getTileDataAvailable(0, 0, 2)).toBe(false);
});
