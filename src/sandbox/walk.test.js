import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createWalk, heightAt, terrainGeometry } from './walk.js';

const site = {
  width: 9, height: 7, cellSizeM: 10,
  elevationM: Array.from({ length: 63 }, (_, i) => i % 9 === 4 && Math.floor(i / 9) >= 2 && Math.floor(i / 9) <= 4 ? 4 : 0),
  base: { col: 1, row: 3 }, stationRadiusM: 10,
  stations: [{ id: 'ridge', cell: { col: 7, row: 2 } }, { id: 'rock', cell: { col: 7, row: 4 } }],
};
const route = { cells: [site.base, ...site.stations.map(s => s.cell), site.base], orderedStationIds: ['ridge', 'rock'] };
const start = (overrides = {}) => createWalk({ site, route, planRevision: 3, windowId: 'dawn', visibility: 'poor', ...overrides });
function travel(walk, cell) {
  const dx = cell.col * site.cellSizeM - walk.x;
  const dz = cell.row * site.cellSizeM - walk.z;
  walk.step(dx, dz, Math.hypot(dx, dz));
}

for (const stations of [site.stations, [...site.stations].reverse()]) {
  test(`records a completed round trip via ${stations[0].id} first`, () => {
    const walk = start();
    assert.equal(walk.result().returnedToBase, false);
    for (const station of stations) {
      travel(walk, station.cell);
      assert.equal(walk.record(station.id), true);
    }
    travel(walk, site.base);
    assert.deepEqual(walk.result(), {
      planRevision: 3, windowId: 'dawn', visibility: 'poor',
      observedStationIds: stations.map(s => s.id), returnedToBase: true,
      elapsedSeconds: 2 * Math.hypot(60, 10) + 20, distanceM: 2 * Math.hypot(60, 10) + 20,
    });
  });
}

test('missed station remains missing; visiting does not automatically record', () => {
  const walk = start();
  travel(walk, site.stations[0].cell);
  assert.deepEqual(walk.observedStationIds, []);
  walk.record('ridge');
  walk.record('ridge');
  travel(walk, site.base);
  assert.deepEqual(walk.result().observedStationIds, ['ridge']);
  assert.equal(walk.result().returnedToBase, true);
  assert.equal(walk.record('rock'), false);
  assert.equal(walk.record('unknown'), false);
});

test('interaction radius includes its edge and uses cells in world meters', () => {
  const walk = start();
  assert.equal(walk.nearby({ col: 2, row: 3 }), true);
  assert.equal(walk.nearby({ col: 2.001, row: 3 }), false);
  assert.equal(walk.nearby({ col: 2, row: 4 }), false);
});

test('normalizes horizontal speed, counts idle time and snapshots results', () => {
  const walk = start();
  walk.step(1, 1, 2);
  assert.ok(Math.abs(walk.distanceM - 2) < 1e-10);
  assert.ok(Math.abs(walk.x - (10 + Math.SQRT2)) < 1e-10);
  walk.step(0, 0, 4);
  assert.equal(walk.elapsedSeconds, 6);
  assert.ok(Math.abs(walk.distanceM - 2) < 1e-10);
  const snapshot = walk.result();
  snapshot.observedStationIds.push('fake');
  assert.deepEqual(walk.observedStationIds, []);
});

test('holes, map boundaries, large time steps and diagonal corners cannot be crossed', () => {
  const blocked = { ...site, elevationM: site.elevationM.map((h, i) => i % 9 === 2 ? null : h) };
  const walk = start({ site: blocked });
  walk.step(1, 0, 40);
  assert.equal(walk.x, 10);
  walk.step(-1, 0, 100);
  assert.equal(walk.x, 10);
  assert.equal(walk.distanceM, 0);
  assert.equal(walk.elapsedSeconds, 140);
  const corner = { ...site, elevationM: [...site.elevationM] };
  corner.elevationM[3 * 9 + 2] = null;
  const diagonal = start({ site: corner });
  diagonal.step(1, 1, Math.SQRT2 * 10);
  assert.equal(diagonal.x, 10);
  assert.equal(diagonal.z, 30);
});

test('terrain preserves cell centers and holes, with north-up cell-centered UVs', () => {
  const small = { width: 3, height: 2, cellSizeM: 10, elevationM: [0, 4, null, 2, 6, null] };
  const mesh = terrainGeometry(small);
  assert.equal(mesh.indices.length, 4 * 4 * 3);
  assert.equal(heightAt(small, 10, 0), 4);
  assert.equal(heightAt(small, 20, 0), null);
  assert.equal(heightAt(small, -5.01, 0), null);
  assert.equal(heightAt(small, 10, 10), 6);
  assert.equal(heightAt(small, 5, 0), 2.5);
  assert.deepEqual(mesh.uvs.slice(0, 2), [1 / 6, 3 / 4]);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = mesh.positions.slice(i, i + 3);
    // Boundary vertices can be shared with a hole; test triangle interiors below.
    assert.ok(Number.isFinite(x + y + z));
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const points = mesh.indices.slice(i, i + 3).map(index => mesh.positions.slice(index * 3, index * 3 + 3));
    const [x, y, z] = [0, 1, 2].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / 3);
    assert.ok(Math.abs(heightAt(small, x, z) - y) < 1e-10);
  }
});

test('mapped neighboring centers stay walkable beside missing terrain', () => {
  const corridor = {
    ...site, width: 4, height: 3, base: { col: 0, row: 1 },
    elevationM: [null, null, null, null, 0, 2, 4, 6, null, null, null, null],
  };
  const walk = start({ site: corridor });
  walk.step(1, 0, 30);
  assert.equal(walk.x, 30);
  assert.equal(walk.z, 10);
  assert.equal(walk.distanceM, 30);
  assert.equal(heightAt(corridor, walk.x, walk.z), 6);
});

test('standing at base or moving only within its radius is not a return', () => {
  const walk = start();
  walk.step(0, 0, 12);
  walk.step(1, 0, 5);
  walk.step(-1, 0, 5);
  assert.equal(walk.result().returnedToBase, false);
  assert.equal(walk.result().elapsedSeconds, 22);
});
