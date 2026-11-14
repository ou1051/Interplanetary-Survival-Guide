import { describe, expect, it, vi } from 'vitest';
import { DEM_MAX_LEVEL, HEIGHTMAP_SIZE, LruCache, heightmapFor, sampleRaster, sourceTileFor, tileRect, type SourceRaster } from './dem';
import { HIRISE_COVERAGE_LEVEL, HIRISE_MAX_LEVEL, ancestor, createDemSampler, hasDataIn, sourceLevelFor, type DemIO } from './demSource';

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

describe('map · LERC post registration', () => {
  it('treats 513-sample tiles as posts on the tile edges', () => {
    // 3 posts across 2°: lon 0, 1, 2 → heights 0, 10, 20
    const r: SourceRaster = { width: 3, height: 3, pixels: [0, 10, 20, 0, 10, 20, 0, 10, 20], rect: { west: 0, east: 2, north: 2, south: 0 }, posts: true };
    expect(sampleRaster(r, 0, 1)).toBe(0);
    expect(sampleRaster(r, 1, 1)).toBe(10);
    expect(sampleRaster(r, 2, 1)).toBe(20);
    expect(sampleRaster(r, 1.5, 1)).toBe(15);
  });
});

// ------------------------------------------------------------------ pipeline

/** Fake services: every tile is `size` posts of a constant (or a function of position). */
function fakeIO(opts: {
  mola?: (level: number, y: number, x: number) => number | null;
  hirise?: (level: number, y: number, x: number) => { value: number; maskAll?: 0 | 1 } | null;
  size?: number;
}) {
  const size = opts.size ?? 5;
  const calls: string[] = [];
  const io: DemIO = {
    async fetchTile(service, level, y, x) {
      calls.push(`${service}/${level}/${y}/${x}`);
      if (service === 'mola') {
        const v = (opts.mola ?? (() => -4200))(level, y, x);
        return v === null ? null : new Float64Array([v, 1]).buffer;
      }
      const h = opts.hirise?.(level, y, x);
      if (!h) throw new TypeError('Failed to fetch'); // what a CORS-less 404 looks like
      return new Float64Array([h.value, h.maskAll ?? 1]).buffer;
    },
    decode(buf) {
      const [value, mask] = new Float64Array(buf);
      const n = size * size;
      return { width: size, height: size, pixels: new Float32Array(n).fill(value), mask: mask === 1 ? null : new Uint8Array(n) };
    },
  };
  return { io, calls };
}

describe('map · Mars relief pipeline', () => {
  it('reads display level L from source level L-3, capped at the DEM depth', () => {
    expect(sourceLevelFor(2, DEM_MAX_LEVEL)).toBe(0);
    expect(sourceLevelFor(9, DEM_MAX_LEVEL)).toBe(6);
    expect(sourceLevelFor(14, DEM_MAX_LEVEL)).toBe(DEM_MAX_LEVEL);
    expect(sourceLevelFor(20, HIRISE_MAX_LEVEL)).toBe(HIRISE_MAX_LEVEL);
    expect(ancestor(3611, 1078, 12, 7)).toEqual({ x: 112, y: 33, level: 7 });
  });

  it('uses MOLA for coarse tiles and never asks HiRISE', async () => {
    const { io, calls } = fakeIO({ hirise: () => ({ value: -4300 }) });
    const s = createDemSampler(io, 5);
    const r = await s.heightmap(3, 1, 8);
    expect(r.source).toBe('mola');
    expect(Array.from(r.heights).every((h) => h === -4200)).toBe(true);
    expect(calls).toEqual(['mola/5/0/0']);
  });

  it('prefers HiRISE where it exists and agrees with MOLA', async () => {
    const { io, calls } = fakeIO({ hirise: () => ({ value: -4290 }) });
    const r = await createDemSampler(io, 5).heightmap(3611, 1078, 14);
    expect(r.source).toBe('hirise');
    expect(Array.from(r.heights).every((h) => h === -4290)).toBe(true);
    expect(calls).toContain(`hirise/${HIRISE_COVERAGE_LEVEL}/${1078 >> 8}/${3611 >> 8}`); // coverage oracle
    expect(calls).toContain(`hirise/11/${1078 >> 3}/${3611 >> 3}`); // L-3
    expect(calls.every((c) => !c.startsWith('mola/') || Number(c.split('/')[1]) <= DEM_MAX_LEVEL)).toBe(true);
  });

  it('rejects HiRISE pyramid artefacts that disagree with MOLA', async () => {
    const { io } = fakeIO({ hirise: () => ({ value: -9 }) }); // seen at Gale level 10
    const r = await createDemSampler(io, 5).heightmap(3611, 1078, 14);
    expect(r.source).toBe('mola');
    expect(r.heights[0]).toBe(-4200);
  });

  it('skips HiRISE when the coverage tile has no DTM there, and remembers misses', async () => {
    const { io, calls } = fakeIO({ hirise: (level) => (level === HIRISE_COVERAGE_LEVEL ? { value: 0, maskAll: 0 } : { value: -4290 }) });
    const s = createDemSampler(io, 5);
    expect((await s.heightmap(3611, 1078, 14)).source).toBe('mola');
    expect(calls.filter((c) => c.startsWith('hirise/')).length).toBe(1);

    const miss = fakeIO({ hirise: () => null });
    const s2 = createDemSampler(miss.io, 5);
    await s2.heightmap(3611, 1078, 14);
    await s2.heightmap(3612, 1078, 14);
    expect(miss.calls.filter((c) => c.startsWith('hirise/')).length).toBe(1); // failed coverage tile not re-requested
  });

  it('reports "none" when the global DEM is unreachable, and retries it later', async () => {
    let up = false;
    const { io, calls } = fakeIO({ mola: () => (up ? -4200 : null) });
    const s = createDemSampler(io, 5);
    expect((await s.heightmap(1, 0, 0)).source).toBe('none');
    up = true;
    expect((await s.heightmap(1, 0, 0)).source).toBe('mola');
    expect(calls.filter((c) => c === 'mola/0/0/1').length).toBe(2);
  });

  it('finds data inside a sub-rectangle of a masked tile', () => {
    const mask = new Uint8Array(25);
    mask[0] = 1; // only the north-west post is valid
    const r: SourceRaster = { width: 5, height: 5, pixels: new Float32Array(25), mask, rect: { west: 0, east: 4, north: 4, south: 0 }, posts: true };
    expect(hasDataIn(r, { west: 0, east: 1, north: 4, south: 3 })).toBe(true);
    expect(hasDataIn(r, { west: 2.5, east: 4, north: 1.5, south: 0 })).toBe(false);
  });
});

describe('map · Mars terrain provider', () => {
  it('uses the Mars ellipsoid and serves 65 × 65 heightmaps (in-thread fallback)', async () => {
    vi.resetModules();
    vi.doMock('lerc', () => ({
      default: { decode: () => ({ width: 513, height: 513, pixels: [new Float32Array(513 * 513).fill(-4200)], mask: null }) },
    }));
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u);
      if (u.includes('HiRISE_DEM')) throw new TypeError('Failed to fetch');
      return new Response(new ArrayBuffer(8), { status: 200 });
    }));
    const { createMarsTerrain } = await import('./elevation');
    const { Ellipsoid } = await import('cesium');
    const terrain = await createMarsTerrain(Ellipsoid.MARS, { worker: false });
    expect(terrain.provider.tilingScheme.ellipsoid).toEqual(Ellipsoid.MARS);
    expect(urls[0]).toBe('https://astro.arcgis.com/arcgis/rest/services/OnMars/MDEM200M/ImageServer/tile/0/0/1');

    const data = (await terrain.provider.requestTileGeometry(3611, 1078, 12)) as unknown as { _width: number; _buffer: Float32Array };
    expect(data._width).toBe(HEIGHTMAP_SIZE);
    expect(Array.from(data._buffer).every((h) => h === -4200)).toBe(true);
    expect(urls.filter((u) => u.includes('MDEM200M')).every((u) => Number(u.split('/tile/')[1].split('/')[0]) <= DEM_MAX_LEVEL)).toBe(true);
    expect(terrain.sourceAt(137.357, -4.714)).toBe('mola');
    terrain.dispose();
    vi.unstubAllGlobals();
    vi.doUnmock('lerc');
  });
});
