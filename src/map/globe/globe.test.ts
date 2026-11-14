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
    expect(coverageAt(best, -133.8, 18.65).map((s) => s.id)).toEqual(['mola-hrsc-color', 'ctx-global']);
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
