import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGrid, cellsWithin, routeCells, buildSite, buildRoutePlans, buildMapInput, applyMapAction } from './missionAdapter.js';
import { Game } from '../sim/game.js';
import { SCENARIOS } from '../data/scenarios.js';
import { SCOUT_PINS, STATIONS, HAB } from '../config/mission.js';

// sessionStorage stand-in for Game.save()
globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };

const bounds = { x0: -300, x1: 500, z0: -760, z1: 100 };
const grid = makeGrid(bounds, 25);

/** A straight-segment route through the given points, sampled every metre (shape of world/route.js). */
function fakeRoute(id, pts, { danger = 0 } = {}) {
  const xs = [];
  const zs = [];
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1];
    const [bx, bz] = pts[k];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az)));
    for (let i = 0; i < n; i++) {
      xs.push(ax + ((bx - ax) * i) / n);
      zs.push(az + ((bz - az) * i) / n);
    }
  }
  xs.push(pts.at(-1)[0]);
  zs.push(pts.at(-1)[1]);
  return {
    option: { id, name: `${id} route`, note: `${id} note`, points: pts },
    length: xs.length - 1,
    step: 1,
    count: xs.length,
    x: Float32Array.from(xs),
    z: Float32Array.from(zs),
    stats: { maxTilt: 12.5 },
    zones: Array.from({ length: danger }, () => ({ kind: 'slope', severity: 'danger' })),
    stations: [...STATIONS.map((s) => ({ id: s.id })), { id: 'HAB', final: true }],
  };
}

const loop = [[0, -14], ...STATIONS.map((s) => s.at), [0, -14]];
const routes = { survival: fakeRoute('survival', loop, { danger: 2 }), direct: fakeRoute('direct', loop) };
const options = [routes.survival.option, routes.direct.option];

test('grid covers the bounds; cells clamp at the edges', () => {
  assert.equal(grid.width, 32);
  assert.equal(grid.height, 35);
  assert.deepEqual(grid.toCell(-300, -760), { col: 0, row: 0 });
  assert.deepEqual(grid.toCell(10_000, 10_000), { col: 31, row: 34 });
  // the cell centre maps back into the same cell
  const c = grid.toCell(HAB.x, HAB.z);
  assert.deepEqual(grid.toCell(...grid.centre(c)), c);
});

test('site: grid elevations, habitat, all stations and scouting sites, real place for the backdrop', () => {
  const site = buildSite({ grid, heightAt: (x, z) => x * 0.01 - z * 0.02, toLonLat: () => [137.36, -4.71], snapshots: { P1: 'data:p1' } });
  assert.equal(site.elevationM.length, grid.width * grid.height);
  assert.deepEqual(site.base, grid.toCell(0, 0));
  assert.deepEqual(site.stations.map((s) => s.id), STATIONS.map((s) => s.id));
  assert.equal(site.observations.length, SCOUT_PINS.length);
  assert.equal(site.observations[0].imageUrl, 'data:p1');
  assert.ok(site.observations[1].caption.includes('Revealed hazard'));
  assert.ok(site.observations.every((o) => o.characterizedCells.length > 0));
  assert.deepEqual(site.geo, { lat: -4.71, lon: 137.36 });
  assert.equal(site.synthetic, true);
  assert.equal(site.sources.find((s) => s.id === site.terrainSourceId).kind, 'synthetic');
});

test('characterised ground is the cells within the scouting radius', () => {
  const cells = cellsWithin(grid, 0, 0, 30);
  for (const c of cells) assert.ok(Math.hypot(...grid.centre(c)) <= 30);
  assert.ok(cells.length >= 4);
});

test('route plans: connected cells from base and back, measures and consumables', () => {
  const plans = buildRoutePlans({ grid, routes, options, revealed: [], estimate: (r) => ({ oxygenMinutes: r.length / 250, batteryWh: r.length / 8 }) });
  assert.deepEqual(plans.map((p) => p.id), ['survival', 'direct']);
  const p = plans[0];
  assert.deepEqual(p.cells[0], grid.toCell(0, -14));
  assert.deepEqual(p.cells.at(-1), grid.toCell(0, -14));
  for (let i = 1; i < p.cells.length; i++) {
    const a = p.cells[i - 1];
    const b = p.cells[i];
    assert.ok(Math.abs(a.col - b.col) <= 1 && Math.abs(a.row - b.row) <= 1, 'cells are neighbours');
    assert.ok(a.col !== b.col || a.row !== b.row, 'no repeats in a row');
  }
  // the drawing path follows the polyline: its first point is the start's position, not a cell centre
  assert.ok(Math.abs(p.path[0].col - ((0 - grid.x0) / 25 - 0.5)) < 1e-6);
  assert.ok(Math.abs(p.path[0].row - ((-14 - grid.z0) / 25 - 0.5)) < 1e-6);
  assert.ok(p.path.length > p.cells.length);
  assert.equal(p.distanceM, routes.survival.length);
  assert.equal(p.maxSegmentSlopeDeg, 12.5);
  assert.deepEqual(p.stationIds, STATIONS.map((s) => s.id));
  assert.equal(p.estimates.hazardGates, 2);
  assert.ok(p.limitedCoverageM > 0);
  // scouting everything removes the unscouted distance near the pins
  const scouted = buildRoutePlans({ grid, routes, options, revealed: SCOUT_PINS.map((x) => x.id), estimate: () => ({ oxygenMinutes: 1, batteryWh: 1 }) });
  assert.ok(scouted[0].limitedCoverageM < p.limitedCoverageM);
});

test('map input mirrors the game: turn, windows, approval, rehearsal weather', () => {
  const game = new Game({ scenarioId: SCENARIOS[0].id, turn: 1, revealed: ['P2'], routeId: 'direct', planRevision: 3, rehearsalWindowId: 'W2', rehearsal: null, forecastUpdated: false, outcome: 'planning', launchedWindowId: null, decisions: [], pendingRehearsal: false });
  const plans = buildRoutePlans({ grid, routes, options, revealed: ['P2'], estimate: () => ({ oxygenMinutes: 1, batteryWh: 1 }) });
  const input = buildMapInput({ game, plans });
  assert.equal(input.run.turn, 1);
  assert.equal(input.run.selectedRouteId, 'direct');
  assert.deepEqual(input.run.revealedObservationIds, ['P2']);
  assert.equal(input.windows.length, SCENARIOS[0].windows.length);
  assert.equal(input.approval.ok, false);
  assert.match(input.approval.reason, /not been rehearsed/);
  assert.equal(input.rehearsal.selectedId, 'W2');
  assert.equal(input.launchDesk, true);
  // clock preview: one more turn from turn 1 closes nothing that is open through turn 2
  assert.equal(input.clock.turnAfter(1), 2);
  assert.deepEqual(input.clock.closingAt(3).map((w) => w.id), ['W1']);
});

test('map actions drive the game, or tell the host where to go', () => {
  const game = new Game({ scenarioId: SCENARIOS[0].id, turn: 0, revealed: [], routeId: 'survival', planRevision: 0, rehearsalWindowId: 'W1', rehearsal: null, forecastUpdated: false, outcome: 'planning', launchedWindowId: null, decisions: [], pendingRehearsal: false });
  applyMapAction({ type: 'scout', observationId: 'P3' }, { game, routes, options });
  assert.equal(game.run.turn, 1);
  assert.deepEqual(game.run.revealed, ['P3']);
  applyMapAction({ type: 'chooseRoute', routeId: 'direct' }, { game, routes, options });
  assert.equal(game.run.routeId, 'direct');
  assert.equal(game.run.planRevision, 1);
  applyMapAction({ type: 'setRehearsalWindow', windowId: 'W3' }, { game, routes, options });
  assert.equal(game.run.rehearsalWindowId, 'W3');
  assert.equal(applyMapAction({ type: 'startRehearsal', routeId: 'direct', planRevision: 1 }, { game, routes, options }), 'rehearse');
  assert.equal(applyMapAction({ type: 'openLaunchDesk' }, { game, routes, options }), 'desk');
  assert.equal(applyMapAction({ type: 'setWaypoints', waypoints: [] }, { game, routes, options }), null);
});
