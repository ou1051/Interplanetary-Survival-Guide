import { describe, expect, it } from 'vitest';
import { slopeGrid, reachableFrom, unreachableStops, elevationAt, isMapped } from './grid';
import { previewScout, standInClock, openWindows } from './scouting';
import { routeCards, observationThatChanged, planStops, planKey, moveItem, routeLabel } from './compare';
import { SYNTHETIC_SITE as SITE, SYNTHETIC_SITE_BARRIER as GAP, SYNTHETIC_WINDOWS as WINS, initialRun } from './dev/fixture';
import type { RoutePlan, Site } from './contracts';

const at = (col: number, row: number) => row * SITE.width + col;

describe('map · fixture matches the agreed shared example', () => {
  it('is 9 × 7 with 10 m cells and the agreed stops', () => {
    expect(SITE.width).toBe(9);
    expect(SITE.height).toBe(7);
    expect(SITE.elevationM).toHaveLength(63);
    expect(SITE.cellSizeM).toBe(10);
    expect(SITE.base).toEqual({ col: 1, row: 3 });
    expect(SITE.stations.map((s) => s.cell)).toEqual([{ col: 7, row: 2 }, { col: 7, row: 4 }]);
    expect(SITE.observations).toHaveLength(3);
    expect(new Set(SITE.observations.map((o) => o.imageUrl)).size).toBe(2);
  });
  it('has 4 m only in column 4, rows 2–4', () => {
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 9; col++) expect(elevationAt(SITE, { col, row })).toBe(col === 4 && row >= 2 && row <= 4 ? 4 : 0);
  });
});

describe('map · grid', () => {
  it('slope is 0 on flat ground and positive beside the rise', () => {
    const s = slopeGrid(SITE);
    expect(s[at(1, 3)]).toBe(0);
    expect(s[at(3, 3)]).toBeCloseTo((Math.atan(4 / 20) * 180) / Math.PI, 6);
    expect(s[at(4, 3)]).toBe(0); // top of the rise, flat along both axes
  });
  it('keeps missing elevation as null and never as flat ground', () => {
    expect(elevationAt(GAP, { col: 5, row: 3 })).toBeNull();
    expect(isMapped(GAP, { col: 5, row: 3 })).toBe(false);
    const s = slopeGrid(GAP);
    expect(s[at(5, 3)]).toBeNull();
    expect(s[at(4, 0)]).not.toBeNull();
  });
  it('uses one-sided differences next to missing data', () => {
    const s = slopeGrid(GAP);
    expect(s[at(6, 0)]).toBe(0); // right neighbour only, both 0 m
  });
  it('finds stops cut off by a missing-data barrier', () => {
    const reach = reachableFrom(GAP, GAP.base);
    expect(reach.has('7,2')).toBe(false);
    const stops = planStops(GAP, initialRun(GAP));
    expect(unreachableStops(GAP, stops).map((s) => s.id)).toEqual(['st-ridge', 'st-rock']);
    expect(unreachableStops(SITE, planStops(SITE, initialRun(SITE)))).toEqual([]);
  });
  it('keeps a station disconnected when only a diagonal crosses missing terrain', () => {
    const site: Site = {
      ...SITE, width: 2, height: 2, base: { col: 0, row: 0 }, elevationM: [0, null, null, 0],
      stations: [{ ...SITE.stations[0], cell: { col: 1, row: 1 } }, SITE.stations[1]],
    };
    const run = { ...initialRun(site), stationOrder: [site.stations[0].id] };
    expect(reachableFrom(site, site.base).has('1,1')).toBe(false);
    expect(unreachableStops(site, planStops(site, run)).map((stop) => stop.id)).toEqual(run.stationOrder);
  });
  it('keeps a station reachable via a mapped orthogonal detour', () => {
    const site: Site = {
      ...SITE, width: 2, height: 2, base: { col: 0, row: 0 }, elevationM: [0, null, 0, 0],
      stations: [{ ...SITE.stations[0], cell: { col: 1, row: 1 } }, SITE.stations[1]],
    };
    const run = { ...initialRun(site), stationOrder: [site.stations[0].id] };
    expect(reachableFrom(site, site.base).has('1,1')).toBe(true);
    expect(unreachableStops(site, planStops(site, run))).toEqual([]);
  });
  it('reports an unreachable waypoint by its own label', () => {
    const run = { ...initialRun(GAP), waypoints: [{ col: 2, row: 1 }, { col: 8, row: 6 }] };
    const ids = unreachableStops(GAP, planStops(GAP, run)).map((s) => s.label);
    expect(ids).toEqual(['Waypoint 2', 'Ridge', 'Bedrock']);
  });
});

describe('map · scouting preview', () => {
  const obs = SITE.observations[0];
  it('a new observation costs one turn; reopening is free', () => {
    const run = initialRun();
    expect(previewScout(obs, run, WINS)).toMatchObject({ isNew: true, cost: 1, turnNow: 0, turnAfter: 1, closes: [] });
    const seen = { ...run, revealedObservationIds: [obs.id] };
    expect(previewScout(obs, seen, WINS)).toMatchObject({ isNew: false, cost: 0, turnAfter: 0, closes: [] });
  });
  it('names the exact window a scout would close (open while turn ≤ lastOpenTurn)', () => {
    const run = { ...initialRun(), turn: 2 };
    const p = previewScout(obs, run, WINS);
    expect(p.turnAfter).toBe(3);
    expect(p.closes.map((w) => w.id)).toEqual(['win-a']);
    expect(p.closesLast).toBe(false);
    expect(previewScout(obs, { ...run, turn: 1 }, WINS).closes).toEqual([]);
  });
  it('flags when the request uses up the last opportunity', () => {
    const p = previewScout(obs, { ...initialRun(), turn: 6 }, WINS);
    expect(p.closes.map((w) => w.id)).toEqual(['win-c']);
    expect(p.closesLast).toBe(true);
  });
  it('never lists an already-closed window', () => {
    const p = previewScout(obs, { ...initialRun(), turn: 4 }, WINS);
    expect(p.closes.map((w) => w.id)).toEqual(['win-b']);
    expect(openWindows(4, WINS).map((w) => w.id)).toEqual(['win-b', 'win-c']);
  });
  it('uses the injected game clock rather than its own arithmetic', () => {
    const clock = { turnAfter: (c: number) => 10 + c, closingAt: () => [WINS[2]] };
    const p = previewScout(obs, initialRun(), WINS, clock);
    expect(p.turnAfter).toBe(11);
    expect(p.closes).toEqual([WINS[2]]);
    expect(standInClock(0, WINS).closingAt(5).map((w) => w.id)).toEqual(['win-a', 'win-b']);
  });
});

const route = (id: string, d: number, s: number, l: number, cells = [{ col: 1, row: 3 }, { col: 7, row: 2 }, { col: 1, row: 3 }], policy?: string): RoutePlan => ({
  id, cells, distanceM: d, maxSegmentSlopeDeg: s, limitedCoverageM: l, stationIds: ['st-ridge', 'st-rock'], comparison: '', policy,
});

describe('map · route comparison', () => {
  it('marks the best value per measure only when routes differ', () => {
    const cards = routeCards([route('a', 140, 11.3, 120, undefined, 'distance'), route('b', 170, 4, 60, undefined, 'terrain')], 'b');
    expect(cards.map((c) => c.label)).toEqual(['Shortest', 'Terrain-aware']);
    expect(cards[0].best).toEqual({ distance: true, slope: false, coverage: false });
    expect(cards[1].best).toEqual({ distance: false, slope: true, coverage: true });
    expect(cards[1].selected).toBe(true);
  });
  it('a single route has no "best" flags', () => {
    const [only] = routeCards([route('a', 140, 11.3, 120)], null);
    expect(only.best).toEqual({ distance: false, slope: false, coverage: false });
    expect(only.label).toBe('Route A');
  });
  it('ties are not called best', () => {
    const cards = routeCards([route('a', 140, 5, 60), route('b', 150, 5, 60)], null);
    expect(cards.map((c) => c.best.slope)).toEqual([false, false]);
    expect(cards.map((c) => c.best.coverage)).toEqual([false, false]);
  });
  it('prefers an explicit label', () => {
    expect(routeLabel({ ...route('x', 1, 1, 1), label: 'Shared route' }, 0)).toBe('Shared route');
  });
  it('attributes a changed comparison to the newly revealed observation', () => {
    const k = planKey(initialRun());
    const prev = { routes: [route('a', 140, 11, 120)], revealed: [], planKey: k };
    expect(observationThatChanged(prev, { routes: [route('a', 140, 11, 80)], revealed: ['obs-rise'], planKey: k })).toBe('obs-rise');
    // same numbers → nothing changed
    expect(observationThatChanged(prev, { routes: [route('a', 140, 11, 120)], revealed: ['obs-rise'], planKey: k })).toBeNull();
    // plan edited in between → not attributable to the observation
    expect(observationThatChanged(prev, { routes: [route('a', 140, 11, 80)], revealed: ['obs-rise'], planKey: 'other' })).toBeNull();
    // no new observation
    expect(observationThatChanged(prev, { routes: [route('a', 99, 11, 80)], revealed: [], planKey: k })).toBeNull();
  });
  it('moves list items without mutating', () => {
    const l = ['a', 'b', 'c'];
    expect(moveItem(l, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(l, 0, -1)).toEqual(l);
    expect(l).toEqual(['a', 'b', 'c']);
  });
});

describe('map · site backdrop maths', () => {
  it('finds the HiRISE tiles around a site and a sharp-enough level', async () => {
    const { tilesFor, levelFor, toDegrees, MARS_M_PER_DEG, levelsLut, gradeColor } = await import('./siteImagery');
    expect(Math.round(MARS_M_PER_DEG)).toBe(59275);
    const d = toDegrees(0, 59274, 59274);
    expect(d.dLon).toBeCloseTo(1, 3);
    expect(d.dLat).toBeCloseTo(1, 3);
    expect(levelFor(0.17, -4.7)).toBe(17); // ~0.16 m/px
    expect(levelFor(0.4, -4.7)).toBe(16);
    const tiles = tilesFor({ lat: -4.714, lon: 137.357 }, { west: -100, east: 100, south: -100, north: 100 }, 16);
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    expect(tiles.length).toBeLessThanOrEqual(9);
    // a 200 m box at level 16 (~163 m tiles) never needs a tile far away
    for (const t of tiles) {
      const span = 180 / 2 ** 16;
      expect(Math.abs(-180 + (t.x + 0.5) * span - 137.357)).toBeLessThan(0.006);
    }
    // levels stretch a dark histogram over most of the range
    const hist = new Uint32Array(256);
    for (let v = 30; v <= 90; v++) hist[v] = 10;
    const lut = levelsLut(hist, 610);
    expect(lut[30]).toBeLessThan(25);
    expect(lut[90]).toBeGreaterThan(230);
    // grading keeps a warm hue and never oversaturates
    const [r, g, b] = gradeColor(180, 120, 100);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});
