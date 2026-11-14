import { describe, expect, it, vi } from 'vitest';
import { DEM_MAX_LEVEL, HEIGHTMAP_SIZE, LruCache, heightmapFor, sampleRaster, sourceTileFor, tileRect, type SourceRaster } from './dem';

// A 4 × 4 test raster over a 4° × 4° tile: height = 100 × column + row.
const raster = (mask?: number[]): SourceRaster => ({
  width: 4,
  height: 4,
  pixels: Array.from({ length: 16 }, (_, i) => 100 * (i % 4) + Math.floor(i / 4)),
  mask: mask ?? null,
  rect: { west: 0, east: 4, north: 4, south: 0 },
});

describe('map · Mars DEM resampling', () => {
  it('uses the services’ geographic 2×1 tiling', () => {
    expect(tileRect(0, 0, 0)).toEqual({ west: -180, east: 0, north: 90, south: -90 });
    expect(tileRect(1, 0, 0)).toEqual({ west: 0, east: 180, north: 90, south: -90 });
    const t = tileRect(3, 1, 2);
    expect(t.east - t.west).toBe(45);
  });

  it('display tiles deeper than the DEM read their level-7 ancestor', () => {
    expect(sourceTileFor(5, 3, 4)).toEqual({ x: 5, y: 3, level: 4 });
    expect(sourceTileFor(1000, 300, 10)).toEqual({ x: 125, y: 37, level: DEM_MAX_LEVEL });
    // the ancestor really contains the child
    const child = tileRect(1000, 300, 10);
    const parent = tileRect(125, 37, 7);
    expect(child.west).toBeGreaterThanOrEqual(parent.west);
    expect(child.east).toBeLessThanOrEqual(parent.east);
    expect(child.north).toBeLessThanOrEqual(parent.north);
    expect(child.south).toBeGreaterThanOrEqual(parent.south);
  });

  it('samples pixel centres exactly and interpolates between them', () => {
    const r = raster();
    expect(sampleRaster(r, 0.5, 3.5)).toBe(0); // centre of pixel (0,0)
    expect(sampleRaster(r, 1.5, 2.5)).toBe(101); // pixel (1,1)
    expect(sampleRaster(r, 1.0, 3.5)).toBe(50); // halfway between columns 0 and 1
    expect(sampleRaster(r, -10, 50)).toBe(0); // clamped outside
  });

  it('ignores no-data neighbours instead of averaging them in', () => {
    const mask = Array(16).fill(1);
    mask[1] = 0; // pixel (1,0) missing
    expect(sampleRaster(raster(mask), 1.0, 3.5)).toBe(0);
    expect(sampleRaster(raster(Array(16).fill(0)), 1, 1, -5)).toBe(-5);
  });

  it('builds an N×N heightmap with matching edges for neighbouring tiles', () => {
    const r = raster();
    const left = heightmapFor(r, { west: 0, east: 2, north: 4, south: 0 }, 5);
    const right = heightmapFor(r, { west: 2, east: 4, north: 4, south: 0 }, 5);
    expect(left).toHaveLength(25);
    for (let j = 0; j < 5; j++) expect(left[j * 5 + 4]).toBeCloseTo(right[j * 5 + 0], 6);
    expect(HEIGHTMAP_SIZE).toBe(65);
  });

  it('keeps a bounded cache of decoded tiles', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
  });
});

// Carried over from the earlier ArcGIS-provider test: Mars ellipsoid, the DEM's
// deepest level as the source, and no request for levels the service lacks.
describe('map · Mars terrain provider', () => {
  it('uses the Mars ellipsoid and reads deep tiles from their level-7 source tile', async () => {
    vi.resetModules();
    vi.doMock('lerc', () => ({
      default: { decode: () => ({ width: 4, height: 4, pixels: [new Float32Array(16).fill(-4200)], mask: null }) },
    }));
    const urls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => {
      urls.push(u);
      return new Response(new ArrayBuffer(8), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { createMarsTerrain } = await import('./elevation');
    const { Ellipsoid } = await import('cesium');
    const terrain = await createMarsTerrain(Ellipsoid.MARS);
    expect(terrain.tilingScheme.ellipsoid).toEqual(Ellipsoid.MARS);
    expect(urls[0]).toBe('https://astro.arcgis.com/arcgis/rest/services/OnMars/MDEM200M/ImageServer/tile/0/0/1');

    // a level-12 display tile near Vera Rubin Ridge
    const data = (await terrain.requestTileGeometry(3611, 1078, 12)) as unknown as { _width: number; _buffer: Float32Array };
    expect(data._width).toBe(HEIGHTMAP_SIZE);
    expect(Array.from(data._buffer).every((h) => h === -4200)).toBe(true);
    const last = urls[urls.length - 1];
    expect(last).toMatch(/\/tile\/7\/\d+\/\d+$/); // never asks the service for level 12
    expect(urls.every((u) => Number(u.split('/tile/')[1].split('/')[0]) <= DEM_MAX_LEVEL)).toBe(true);
    vi.unstubAllGlobals();
    vi.doUnmock('lerc');
  });
});
