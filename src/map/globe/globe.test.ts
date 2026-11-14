import { describe, expect, it } from 'vitest';
import { IMAGERY, PLACES, SOURCES, coverageAt, degreesPerPixel, inBBox, tileFor, tileUrl } from './catalog';
import { breadcrumb, durationFor, formatAltitude, formatHeight, formatLatLon, niceScale, pitchForRange, planFlight, surfaceDistance, MARS_RADIUS_M } from './flight';

describe('map · globe catalog', () => {
  it('builds Mars Trek and Esri tile URLs in {z}/{row}/{col} order', () => {
    expect(tileUrl(SOURCES.curiosityHirise, 16, 10, 20)).toBe(
      'https://trek.nasa.gov/tiles/Mars/EQ/curiosity_hirise_mosaic/1.0.0//default/default028mm/16/10/20.png',
    );
    expect(tileUrl(SOURCES.ctxGlobal, 3, 1, 2)).toBe('https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/3/1/2');
  });
  it('uses the geographic 2×1 tiling the services publish', () => {
    expect(tileFor(-180, 90, 0)).toEqual({ x: 0, y: 0 });
    expect(tileFor(137.357, -4.714, 0)).toEqual({ x: 1, y: 0 });
    // Vera Rubin Ridge at the HiRISE mosaic's deepest level stays inside its tile range
    const t = tileFor(137.357, -4.714, 16);
    expect(t.x).toBeLessThan(2 * 2 ** 16);
    expect(t.y).toBeLessThan(2 ** 16);
    expect(degreesPerPixel(0)).toBeCloseTo(180 / 256);
  });
  it('the assignment site lies inside the high-resolution footprints', () => {
    const vrr = PLACES.find((p) => p.assignment)!;
    expect(vrr.name).toBe('Vera Rubin Ridge');
    expect(inBBox(SOURCES.curiosityHirise.bbox!, vrr.lon, vrr.lat)).toBe(true);
    expect(inBBox(SOURCES.galeCtx.bbox!, vrr.lon, vrr.lat)).toBe(true);
    const best = IMAGERY.find((s) => s.id === 'best')!;
    expect(coverageAt(best, vrr.lon, vrr.lat).pop()!.id).toBe('curiosity-hirise');
    // far from Gale only the global layers cover
    expect(coverageAt(best, -133.8, 18.65).map((s) => s.id)).toEqual(['painted-mars', 'ctx-global']);
  });
  it('caps each source at the deepest level that really exists', () => {
    // checked against live tiles at Vera Rubin Ridge: CTX to 12, HiRISE to 16, Gale CTX to 12
    expect(SOURCES.ctxGlobal.maxLevel).toBe(12);
    expect(SOURCES.curiosityHirise.maxLevel).toBe(16);
    expect(SOURCES.galeCtx.maxLevel).toBe(12);
    // ground resolution at the cap matches the product
    const mPerDeg = (Math.PI / 180) * 3396190;
    expect(degreesPerPixel(12, 512) * mPerDeg).toBeCloseTo(5.06, 1);
    expect(degreesPerPixel(16, 256) * mPerDeg).toBeLessThan(0.7);
  });

  it('every place has a sane position and framing', () => {
    for (const p of PLACES) {
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
      expect(p.range).toBeGreaterThan(1000);
      expect(p.pitchDeg).toBeLessThan(0);
    }
    expect(new Set(PLACES.map((p) => p.id)).size).toBe(PLACES.length);
  });
});

describe('map · globe flight', () => {
  it('each click zooms in, but never below the minimum range', () => {
    expect(planFlight(1_000_000).range).toBeCloseTo(300_000);
    expect(planFlight(4000).range).toBe(2500);
    expect(planFlight(Number.NaN).range).toBeLessThanOrEqual(3 * MARS_RADIUS_M);
  });
  it('looks straight down from orbit and tilts near the ground', () => {
    expect(pitchForRange(5_000_000)).toBe(-90);
    expect(pitchForRange(3000)).toBe(-35);
    expect(pitchForRange(60_000)).toBeLessThan(-35);
    expect(pitchForRange(60_000)).toBeGreaterThan(-90);
  });
  it('flights are quick (≤ 1.8 s)', () => {
    expect(durationFor(11_000_000, 3000)).toBeLessThanOrEqual(1.8);
    expect(durationFor(10_000, 3000)).toBeGreaterThanOrEqual(0.9);
    expect(planFlight(11_000_000).duration).toBeLessThanOrEqual(1.8);
  });
  it('formats readouts in planetary conventions', () => {
    expect(formatLatLon(-4.714, 137.357)).toBe('4.7140° S  137.3570° E');
    expect(formatLatLon(18.65, -133.8)).toBe('18.6500° N  226.2000° E');
    expect(formatHeight(-4123.4)).toBe('−4,123 m');
    expect(formatHeight(21241)).toBe('21.2 km');
    expect(formatHeight(null)).toBe('—');
    expect(formatAltitude(11_000_000)).toBe('11,000 km');
    expect(formatAltitude(850)).toBe('850 m');
  });
  it('picks round scale bars', () => {
    const s = niceScale(10, 120); // 10 m per px → up to 1200 m
    expect(s.metres).toBe(1000);
    expect(s.px).toBe(100);
    expect(s.label).toBe('1 km');
    expect(niceScale(0.5, 120).label).toBe('50 m');
  });
  it('measures surface distance on Mars', () => {
    const quarter = surfaceDistance(0, 0, 0, 90);
    expect(quarter).toBeCloseTo((Math.PI / 2) * MARS_RADIUS_M, -2);
    expect(surfaceDistance(-4.714, 137.357, -4.714, 137.357)).toBe(0);
  });
  it('builds the breadcrumb from where the camera is', () => {
    expect(breadcrumb(PLACES, { lat: -4.7, lon: 137.4, altitudeM: 11_000_000 })).toEqual(['Mars']);
    expect(breadcrumb(PLACES, { lat: -5.3, lon: 137.7, altitudeM: 300_000 })).toEqual(['Mars', 'Gale Crater']);
    expect(breadcrumb(PLACES, { lat: -4.72, lon: 137.36, altitudeM: 9000 })).toEqual(['Mars', 'Gale Crater', 'Vera Rubin Ridge']);
    expect(breadcrumb(PLACES, { lat: 18.5, lon: -133.8, altitudeM: 900_000 })).toEqual(['Mars', 'Olympus Mons']);
  });
});

describe('map · natural-colour compositing', () => {
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
    const { SOURCES, IMAGERY } = await import('./catalog');
    expect((SOURCES.viking as { colorize?: boolean }).colorize).toBeUndefined();
    for (const s of [SOURCES.ctxGlobal, SOURCES.galeCtx, SOURCES.curiosityHirise, SOURCES.jezeroHirise]) expect(s.colorize).toBe(true);
    expect(IMAGERY[0].stack[0]).toBe(SOURCES.painted);
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
