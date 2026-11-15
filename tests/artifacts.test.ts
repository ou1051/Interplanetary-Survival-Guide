import { describe, expect, it } from 'vitest';
import { buildDeltaTraverse, buildDeltaApproaches } from '../src/data/deltaTraverse.js';
import { CATALOG, RARITY, byId, placeArtifacts, loadCollection, recordFind, saveCollection, siteKey } from '../src/sim/artifacts.js';
import { Mission } from '../src/sim/mission.js';

const { terrain, route } = buildDeltaTraverse();
const site = { name: 'Delta Front' };

function fakeStore() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
}

describe('artifact catalog and placement', () => {
  it('has a unique, complete catalog entry for every find', () => {
    expect(new Set(CATALOG.map((a) => a.id)).size).toBe(CATALOG.length);
    for (const a of CATALOG) {
      expect(RARITY[a.rarity]).toBeTruthy();
      expect(a.name.length).toBeGreaterThan(3);
      expect(a.about.length).toBeGreaterThan(30);
    }
    expect(siteKey({ name: 'Gale Crater · Vera Rubin Ridge' })).toBe('gale');
    expect(siteKey(site)).toBe('delta');
  });

  it('rings each station with its three finds on walkable ground', () => {
    const finds = placeArtifacts({ route, terrain, site, seed: 9 });
    for (const st of route.stations.filter((s: { final?: boolean }) => !s.final)) {
      const mine = finds.filter((a) => a.stationId === st.id);
      expect(mine).toHaveLength(3);
      for (const a of mine) {
        const d = Math.hypot(a.x - st.x, a.z - st.z);
        expect(d).toBeGreaterThan(8);
        expect(d).toBeLessThan(30); // inside the station ring
        expect(a.y).toBeCloseTo(terrain.heightAt(a.x, a.z), 6);
      }
    }
  });

  it('hides rarer finds away from the planned route, apart from each other', () => {
    const finds = placeArtifacts({ route, terrain, site, seed: 9 });
    const wild = finds.filter((a) => !a.stationId);
    expect(wild.length).toBeGreaterThanOrEqual(4);
    expect(wild.some((a) => a.rarity === 'epic' || a.rarity === 'legendary')).toBe(true);
    for (const a of wild) {
      let near = Infinity;
      for (let i = 0; i < route.count; i++) near = Math.min(near, Math.hypot(route.x[i] - a.x, route.z[i] - a.z));
      expect(near).toBeGreaterThan(34);
      expect(terrain.slopeAt(a.x, a.z, 2)).toBeLessThan(16.5);
      for (const b of wild) if (b !== a) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(79);
    }
    // Same seed, same world.
    expect(placeArtifacts({ route, terrain, site, seed: 9 }).map((a) => a.uid)).toEqual(finds.map((a) => a.uid));
  });

  it('turns station finds into the station work list and completes the station on the last one', () => {
    const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 });
    const finds = placeArtifacts({ route, terrain, site, seed: 9 });
    mission.setArtifacts(finds);
    mission.start();
    const s1 = mission.stations[0];
    expect(s1.tasks.map((t: { artifact: { stationId: string } }) => t.artifact.stationId)).toEqual(['S1', 'S1', 'S1']);
    mission.state = 'walk';
    const events: string[] = [];
    mission.on((type: string) => events.push(type));
    for (const t of s1.tasks) mission.collect(t.artifact);
    expect(s1.done).toBe(true);
    expect(mission.nextStation.id).toBe('S2');
    expect(mission.collect(s1.tasks[0].artifact)).toBe(false); // already collected
    expect(events.filter((e) => e === 'artifact')).toHaveLength(3);
    expect(events).toContain('station');
    const wild = finds.find((a) => !a.stationId)!;
    expect(mission.collect(wild)).toBe(true);
    expect(mission.samples).toBe(4);
  });
});

describe('collection storage', () => {
  it('records first finds, counts repeats and survives reloads', () => {
    const store = fakeStore();
    const book = loadCollection(store);
    expect(book.items).toEqual({});
    const find = { ...byId['iron-meteorite'], stationId: 'S3' };
    expect(recordFind(book, find, 'Delta Front', new Date('2026-11-14T10:00:00Z'))).toBe(true);
    expect(recordFind(book, find, 'Delta Front')).toBe(false);
    expect(saveCollection(book, store)).toBe(true);
    const again = loadCollection(store);
    expect(again.items['iron-meteorite']).toEqual({ count: 2, site: 'Delta Front · S3', at: '2026-11-14' });
  });

  it('ignores corrupt or unknown entries', () => {
    const store = fakeStore();
    store.setItem('isg.collection.v1', 'nope');
    expect(loadCollection(store).items).toEqual({});
    store.setItem('isg.collection.v1', JSON.stringify({ version: 1, items: { 'not-a-find': { count: 3 }, pallasite: { count: 1, site: 'x', at: 'y' }, gypsum: { count: -1 } } }));
    expect(Object.keys(loadCollection(store).items)).toEqual(['pallasite']);
    expect(loadCollection(null).items).toEqual({});
  });
});

it('applies mapped area hazards wherever the rover drives, not only on the route that crosses them', () => {
  const intermediate = buildDeltaApproaches(buildDeltaTraverse()).find((a: { id: string }) => a.id === 'intermediate')!;
  const { route: r, terrain: t } = intermediate.traverse;
  expect(r.zones.some((z: { unsurveyed?: boolean }) => z.unsurveyed)).toBe(false); // the plan avoids it
  const mission = new Mission(r, t, { x: 0, y: 0, z: 0 });
  mission.start();
  Object.assign(mission.rover, { x: -87, z: -132, speed: 3 });
  mission.update(1 / 30, { throttle: true }, 0);
  expect(mission.activeZones.map((z: { id: string }) => z.id)).toContain('H-UNSURVEYED');
  expect(mission.limit).toBe(1.2);
});
