import { describe, expect, it } from 'vitest';
import { IMAGERY, SOURCES } from './catalog';

describe('map · natural-colour compositing', () => {
  it('keeps the console imagery inside the mission site coverage', () => {
    expect(IMAGERY).toEqual([SOURCES.painted, SOURCES.galeCtx, SOURCES.curiosityHirise]);
    for (const source of [SOURCES.galeCtx, SOURCES.curiosityHirise]) {
      expect(source.bbox.west).toBeLessThan(137.357);
      expect(source.bbox.east).toBeGreaterThan(137.357);
      expect(source.bbox.south).toBeLessThan(-4.714);
      expect(source.bbox.north).toBeGreaterThan(-4.714);
      expect(source.credit).toContain('NASA');
    }
    expect(SOURCES.galeCtx.maxLevel).toBe(12);
    expect(SOURCES.curiosityHirise.maxLevel).toBe(16);
  });

  it('finds the Viking colour patch under a detail tile', async () => {
    const { colorPatch } = await import('./marsPaint');
    const base = { tileSize: 256, maxLevel: 7 };
    // same level: the whole colour tile
    expect(colorPatch(5, 3, 4, base)).toEqual({ level: 4, x: 5, y: 3, sx: 0, sy: 0, size: 256 });
    // level 12 tile → level 7 ancestor, a 8 × 8 px patch at its offset in the ancestor
    const p = colorPatch(3611, 1078, 12, base);
    expect(p).toMatchObject({ level: 7, x: 3611 >> 5, y: 1078 >> 5, size: 8 });
    expect(p.sx).toBe((3611 % 32) * 8);
    expect(p.sy).toBe((1078 % 32) * 8);
  });

  it('marks greyscale detail layers for colouring and keeps the colour base plain', async () => {
    expect((SOURCES.viking as { colorize?: boolean }).colorize).toBeUndefined();
    for (const s of [SOURCES.galeCtx, SOURCES.curiosityHirise]) expect(s.colorize).toBe(true);
    expect(IMAGERY[0]).toBe(SOURCES.painted);
    expect(SOURCES.painted.painted).toBe(true);
  });
});

describe('map · painted Mars surface', () => {
  it('maps Viking albedo onto a warm true-colour palette', async () => {
    const { albedo, palette } = await import('./marsPaint');
    // Viking's measured median ground (greyish mauve) becomes ochre: R > G > B, clearly warm
    const [r, g, b] = albedo(130, 99, 94);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r / b).toBeGreaterThan(2);
    // its purple-grey dark regions become dark umber, still warm, never blue
    const dark = albedo(64, 48, 51);
    expect(dark[0]).toBeGreaterThan(dark[2]);
    expect(dark[0] + dark[1] + dark[2]).toBeLessThan(r + g + b);
    // palette brightens monotonically
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const c = palette(t);
      const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
  });

  it('turns bright bluish Viking pixels (frost, polar ice) white, not orange', async () => {
    const { albedo } = await import('./marsPaint');
    const ice = albedo(206, 210, 223, -80);
    expect(Math.max(...ice) - Math.min(...ice)).toBeLessThan(20);
    expect(ice[0]).toBeGreaterThan(200);
    // the same pixel near the equator is a bright slope, kept warm
    const slope = albedo(206, 210, 223, -5);
    expect(slope[0] - slope[2]).toBeGreaterThan(20);
    const dust = albedo(200, 150, 120); // bright but warm: dust, stays orange-tan
    expect(dust[0] - dust[2]).toBeGreaterThan(50);
  });

  it('hillshades with the sun in the north-west and leaves flat ground unchanged', async () => {
    const { hillshade, paint, demLevelFor, shadeExaggeration } = await import('./marsPaint');
    const { tileRect } = await import('./dem');
    const rect = tileRect(10, 3, 4);
    const raster = (f: (lon: number, lat: number) => number) => {
      const n = 33;
      const pixels = new Float32Array(n * n);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++)
          pixels[j * n + i] = f(rect.west + ((rect.east - rect.west) * i) / (n - 1), rect.north - ((rect.north - rect.south) * j) / (n - 1));
      return { width: n, height: n, pixels, rect, posts: true };
    };
    const flat = hillshade(raster(() => -2000), 10, 3, 4, 16);
    expect(Array.from(flat).every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
    // ground rising towards the south-east faces the north-west sun and is brighter
    const facing = hillshade(raster((lon, lat) => (lon - rect.west) * 4000 - (lat - rect.south) * 4000), 10, 3, 4, 16);
    const away = hillshade(raster((lon, lat) => -(lon - rect.west) * 4000 + (lat - rect.south) * 4000), 10, 3, 4, 16);
    expect(facing[8 * 16 + 8]).toBeGreaterThan(1);
    expect(away[8 * 16 + 8]).toBeLessThan(1);
    // painting keeps flat ground's colour and darkens shade
    const rgba = new Uint8ClampedArray(16 * 16 * 4).fill(120);
    const lit = paint(rgba, flat, 16);
    const shaded = paint(rgba, away, 16);
    expect(shaded[8 * 16 * 4 + 8 * 4]).toBeLessThan(lit[8 * 16 * 4 + 8 * 4]);
    expect(lit[3]).toBe(255);
    // one DEM post per pixel, capped at the DEM's depth; relief exaggerated at planet scale only
    expect(demLevelFor(0)).toBe(0);
    expect(demLevelFor(5)).toBe(4);
    expect(demLevelFor(12)).toBe(7);
    expect(shadeExaggeration(0)).toBeGreaterThan(shadeExaggeration(6));
    expect(shadeExaggeration(12)).toBeCloseTo(1.5);
  });

  it('fast palette lookup matches the reference colour function', async () => {
    const { albedo, paint } = await import('./marsPaint');
    const px = [[130, 99, 94], [64, 48, 51], [200, 150, 120], [206, 210, 223]];
    const rgba = new Uint8ClampedArray(px.length * 4);
    px.forEach((p, i) => rgba.set([...p, 255], i * 4));
    const shade = new Float32Array(px.length).fill(1);
    // a 2 × 2 tile spanning the equator: no ice
    const out = paint(rgba, shade, 2, { north: 1, south: -1 });
    px.forEach((p, i) => {
      const ref = albedo(p[0], p[1], p[2], 0);
      for (let c = 0; c < 3; c++) expect(Math.abs(out[i * 4 + c] - ref[c])).toBeLessThanOrEqual(3);
    });
  });
});
