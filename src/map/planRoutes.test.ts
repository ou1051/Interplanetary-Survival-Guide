import { describe, expect, it } from 'vitest';
import { planRoutes } from './planRoutes';
import type { Site } from './contracts';
import { SYNTHETIC_SITE } from './dev/fixture';

const cell = (col: number, row: number) => ({ col, row });
const siteWith = (patch: Partial<Site>): Site => ({ ...SYNTHETIC_SITE, observations: [], ...patch });

describe('map planner integration', () => {
  it('measures physical surface distance and low coverage on every round-trip leg', () => {
    const site = siteWith({ width: 3, height: 1, cellSizeM: 10, elevationM: [0, 4, 0], base: cell(0, 0),
      stations: [{ id: 'a', name: 'A', cell: cell(1, 0) }, { id: 'b', name: 'B', cell: cell(2, 0) }] });
    const [route] = planRoutes(site, [], ['b', 'a'], []);
    expect(route.cells).toEqual([cell(0, 0), cell(1, 0), cell(2, 0), cell(1, 0), cell(0, 0)]);
    expect(route.stationIds).toEqual(['b', 'a']);
    expect(route.distanceM).toBeCloseTo(4 * Math.hypot(10, 4));
    expect(route.limitedCoverageM).toBeCloseTo(route.distanceM);
    expect(route.maxSegmentSlopeDeg).toBeCloseTo(Math.atan(0.4) * 180 / Math.PI);
    expect(route.id).toBe('route-shared');
  });

  it('offers the physically shortest route separately from the fastest terrain route', () => {
    const site = siteWith({ width: 3, height: 3, cellSizeM: 10, elevationM: [0, 0, 0, 0, 2, 0, 0, 0, 0],
      base: cell(0, 1), stations: [{ id: 'a', name: 'A', cell: cell(2, 1) }, { id: 'b', name: 'B', cell: cell(2, 1) }] });
    const routes = planRoutes(site, [], ['a', 'b'], []);
    expect(routes).toHaveLength(2);
    const [shortest, terrain] = routes;
    expect(shortest.policy).toBe('distance');
    expect(shortest.cells).toContainEqual(cell(1, 1));
    expect(terrain.cells).not.toContainEqual(cell(1, 1));
    expect(shortest.distanceM).toBeLessThan(terrain.distanceM);
  });

  it('uses revealed coverage to prefer a characterized detour and reports it in metres', () => {
    const site = siteWith({ width: 6, height: 3, cellSizeM: 10, elevationM: Array(18).fill(0), base: cell(0, 1),
      stations: [{ id: 'a', name: 'A', cell: cell(5, 1) }, { id: 'b', name: 'B', cell: cell(5, 1) }],
      observations: [{ id: 'seen', cell: cell(2, 0), imageUrl: '', caption: '', sourceId: '',
        characterizedCells: [cell(0, 1), cell(1, 0), cell(2, 0), cell(3, 0), cell(4, 0), cell(5, 1)] }] });
    const before = planRoutes(site, [], ['a', 'b'], []);
    expect(before).toHaveLength(1);
    const routes = planRoutes(site, [], ['a', 'b'], ['seen']);
    expect(routes).toHaveLength(2);
    expect(routes[1].limitedCoverageM).toBe(0);
    expect(routes[0].limitedCoverageM).toBeGreaterThan(0);
  });

  it('includes waypoints before ordered stations and rejects disconnected legs or corner gaps', () => {
    const site = siteWith({ width: 3, height: 2, cellSizeM: 10, elevationM: Array(6).fill(0), base: cell(0, 0),
      stations: [{ id: 'a', name: 'A', cell: cell(2, 0) }, { id: 'b', name: 'B', cell: cell(2, 1) }] });
    const routes = planRoutes(site, [cell(0, 1)], ['b', 'a'], []);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.cells[1]).toEqual(cell(0, 1));
      expect(route.cells.at(-1)).toEqual(site.base);
      expect(route.cells.findIndex(c => c.col === 2 && c.row === 1)).toBeLessThan(route.cells.findIndex(c => c.col === 2 && c.row === 0));
    }
    const gap = siteWith({ width: 2, height: 2, elevationM: [0, null, null, 0], base: cell(0, 0),
      stations: [{ id: 'a', name: 'A', cell: cell(1, 1) }, { id: 'b', name: 'B', cell: cell(1, 1) }] });
    expect(planRoutes(gap, [], ['a', 'b'], [])).toEqual([]);
    expect(planRoutes(site, [], ['missing'], [])).toEqual([]);
  });
});
