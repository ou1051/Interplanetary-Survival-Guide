import test from 'node:test';
import assert from 'node:assert/strict';
import { planRoute, rerouteForHazard } from './pathfinding.js';
import { segmentEstimate } from './physics.js';

const cell = (col, row) => ({ col, row });
const flat = (width = 5, height = 3) => ({ width, height, cellSizeM: 10, elevationM: Array(width * height).fill(0) });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('flat route uses cheapest diagonal moves and sums segment metrics', () => {
  const grid = flat();
  const result = planRoute(grid, cell(0, 0), cell(4, 2));
  assert.deepEqual(result.path[0], cell(0, 0));
  assert.deepEqual(result.path.at(-1), cell(4, 2));
  assert.equal(result.path.length, 5);
  const straight = segmentEstimate(10, 0);
  const diagonal = segmentEstimate(Math.SQRT2 * 10, 0);
  for (const key of ['distanceM', 'durationSeconds', 'oxygenMinutes', 'batteryWh']) close(result[key], 2 * straight[key] + 2 * diagonal[key]);
  assert.equal(result.maxSlopeDeg, 0);
});

test('no-data cells and closures block movement and diagonal corner cutting', () => {
  const grid = flat(2, 2);
  grid.elevationM[1] = null;
  grid.blockedCells = [cell(0, 1)];
  assert.equal(planRoute(grid, cell(0, 0), cell(1, 1)), null);
  assert.equal(planRoute(grid, cell(1, 0), cell(1, 1)), null);
  assert.equal(planRoute(grid, cell(0, 0), cell(0, 1)), null);
  assert.equal(planRoute(grid, cell(-1, 0), cell(1, 1)), null);
});

test('zero leg reports one cell and zero metrics, but blocked zero leg is unavailable', () => {
  const grid = flat();
  assert.deepEqual(planRoute(grid, cell(1, 1), cell(1, 1)), {
    path: [cell(1, 1)], distanceM: 0, durationSeconds: 0, oxygenMinutes: 0, batteryWh: 0, maxSlopeDeg: 0,
  });
  grid.blockedCells = [cell(1, 1)];
  assert.equal(planRoute(grid, cell(1, 1), cell(1, 1)), null);
});

test('live hazard finds an alternate path without mutating existing grid closures', () => {
  const grid = flat();
  grid.blockedCells = [cell(2, 2)];
  const before = structuredClone(grid);
  const result = rerouteForHazard(grid, cell(0, 1), cell(4, 1), { blockedCells: [cell(2, 1)] });
  assert.ok(result);
  assert.ok(!result.path.some(p => p.col === 2 && p.row >= 1));
  assert.deepEqual(result.path[0], cell(0, 1));
  assert.equal(result.path.filter(p => p.col === 0 && p.row === 1).length, 1);
  assert.deepEqual(grid, before);
  assert.equal(rerouteForHazard(grid, cell(0, 1), cell(4, 1), { blockedCells: [cell(2, 0), cell(2, 1)] }), null);
  assert.equal(rerouteForHazard(grid, cell(0, 1), cell(4, 1), { blockedCells: [cell(0, 1)] }), null);
});

test('high travel surcharges favor detours and do not inflate physical metrics', () => {
  const grid = flat();
  grid.hazardCost = Array(15).fill(0);
  grid.hazardCost[7] = 100;
  const result = planRoute(grid, cell(0, 1), cell(4, 1));
  assert.ok(!result.path.some(p => p.col === 2 && p.row === 1));
  const metrics = result.path.slice(1).map((p, i) => {
    const previous = result.path[i];
    return segmentEstimate(Math.hypot(p.col - previous.col, p.row - previous.row) * 10, 0);
  });
  close(result.durationSeconds, metrics.reduce((sum, s) => sum + s.durationSeconds, 0));
});

test('terrain metrics use governed segment speed and absolute maximum slope', () => {
  const grid = flat(3, 1);
  grid.elevationM = [0, 4, 0];
  const result = planRoute(grid, cell(0, 0), cell(2, 0));
  const up = segmentEstimate(10, 4);
  const down = segmentEstimate(10, -4);
  for (const key of ['distanceM', 'durationSeconds', 'oxygenMinutes', 'batteryWh']) close(result[key], up[key] + down[key]);
  close(result.maxSlopeDeg, Math.max(up.slopeDeg, down.slopeDeg));
  assert.ok(result.durationSeconds > segmentEstimate(20, 0).durationSeconds);
});

test('least travel time can choose a longer horizontal path around steep terrain', () => {
  const grid = flat();
  grid.elevationM[7] = 100;
  const result = planRoute(grid, cell(0, 1), cell(4, 1));
  assert.ok(!result.path.some(p => p.col === 2 && p.row === 1));
  assert.ok(result.distanceM > 40);
  const steepDirectSeconds = 2 * segmentEstimate(10, 0).durationSeconds +
    segmentEstimate(10, 100).durationSeconds + segmentEstimate(10, -100).durationSeconds;
  assert.ok(result.durationSeconds < steepDirectSeconds);
});
