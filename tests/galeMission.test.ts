import { buildDeltaTraverse, buildDeltaApproaches } from '../src/data/deltaTraverse.js';
import { describe, expect, it } from 'vitest';
import { planGaleRoutes, missionHeight, outcrop, worldPosition, sampleMinutes } from '../src/data/galeSite.js';
import { Route } from '../src/world/route.js';
import { Mission, WALK } from '../src/sim/mission.js';
import { fieldGuidance } from '../src/sim/fieldGuidance.js';
import { placeArtifacts } from '../src/sim/artifacts.js';

const plans = planGaleRoutes();
const dt = 1 / 30;
type M = InstanceType<typeof Mission>;

function makeMission(plan = plans[0]) {
  const terrain = { heightAt: missionHeight };
  const route = new Route(terrain, {
    points: plan.points, exact: true, areaHazards: [], stations: [{
      id: 'S1', name: 'Layered outcrop', at: worldPosition(outcrop),
      tasks: [{ label: 'Collect paired samples', minutes: sampleMinutes, sampleCount: 2 }],
    }],
  });
  route.site = { name: 'Gale Crater · Vera Rubin Ridge' };
  const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 });
  mission.setArtifacts(placeArtifacts({ route, terrain, site: route.site, seed: 3 }));
  return mission;
}

// Drive along the planned route ahead until `done` holds, then stop.
function drive(mission: M, done: () => boolean, max = 20000) {
  for (let i = 0; i < max && !done(); i++) mission.update(dt, mission.autopilot({ boost: true }), 0);
  for (let i = 0; i < 600 && Math.abs(mission.rover.speed) > 0.01; i++) mission.update(dt, { brake: true }, 0);
}

// Walk straight toward (x, z) until within `near` metres.
function walkTo(mission: M, x: number, z: number, near = 1) {
  for (let i = 0; i < 20000; i++) {
    const w = mission.walker;
    if (Math.hypot(x - w.x, z - w.z) < near) return true;
    mission.update(dt, { forward: 1, strafe: 0, run: true, viewYaw: Math.atan2(-(x - w.x), -(z - w.z)) }, 0);
  }
  return false;
}

describe('Gale habitat-to-field handoff', () => {
  it('offers a longer, gentler route with two different drivable paths', () => {
    const [recommended, shortest] = plans;
    expect(recommended.distanceM).toBeGreaterThan(shortest.distanceM);
    expect(recommended.surfaceSlope).toBeLessThan(shortest.surfaceSlope);
    for (const plan of plans) {
      const { route } = makeMission(plan);
      let distance = 0;
      plan.points.forEach(([x, z], i) => {
        if (i > 0) distance += Math.hypot(x - plan.points[i - 1][0], z - plan.points[i - 1][1]);
        const point = route.sample(distance);
        expect(point.x).toBeCloseTo(x, 4);
        expect(point.z).toBeCloseTo(z, 4);
      });
    }
  });

  it('drives to the outcrop, collects its artifacts on foot and ends the EVA at the habitat', () => {
    const mission = makeMission();
    mission.start();
    const station = mission.stations[0];
    expect(station.tasks.length).toBe(3);
    drive(mission, () => mission.currentStation === station);
    expect(station.visited).toBe(true);
    expect(mission.collect(station.tasks[0].artifact)).toBe(false); // only on foot
    expect(mission.exitRover()).toBe(true);
    for (const task of station.tasks) {
      expect(walkTo(mission, task.artifact.x, task.artifact.z, WALK.reach * 0.8)).toBe(true);
      expect(mission.collect(task.artifact)).toBe(true);
    }
    expect(station.done).toBe(true);
    expect(mission.samples).toBe(3);
    expect(walkTo(mission, mission.rover.x, mission.rover.z, 2.5)).toBe(true);
    expect(mission.boardRover()).toBe(true);
    drive(mission, () => mission.atHome && mission.s > mission.route.length * 0.75);
    expect(mission.endEva()).toBe(true);
    expect(mission.state).toBe('complete');
    expect(fieldGuidance(mission).advice).toBe('At habitat');
  });

  it('points the crew home when dust rolls in and permits an early return', () => {
    const mission = makeMission(plans[1]);
    mission.start();
    drive(mission, () => mission.s >= mission.route.length / 4);
    const heading = mission.rover.heading;
    mission.dustWarning = true;
    const guidance = fieldGuidance(mission);
    expect(guidance.advice).toBe('Return to habitat');
    expect(guidance.next).toBe('Habitat');
    expect(guidance.canReturn).toBe(true);
    expect(mission.returnToHabitat()).toBe(true);
    expect(mission.nextStation?.final).toBe(true);
    expect(Math.abs(mission.rover.heading - heading - Math.PI)).toBeLessThan(1e-9);
    drive(mission, () => mission.atHome && mission.s < 30);
    expect(mission.endEva()).toBe(true);
    expect(mission.samples).toBe(0);
  });
});

describe('free driving and walking', () => {
  const flat = (wall = Infinity) => ({ heightAt: (x: number) => (x > wall ? (x - wall) * 1.2 : 0) });
  const straight = (terrain: { heightAt: (x: number, z: number) => number }) => {
    const route = new Route(terrain, { points: [[0, -14], [0, -300]], exact: true, areaHazards: [], stations: [{ id: 'S1', name: 'Test', at: [0, -200], tasks: [] }] });
    const mission = new Mission(route, terrain, { x: 0, y: 2, z: 0 });
    mission.start();
    return mission;
  };

  it('leaves the planned route when steered away and keeps tracking progress along it', () => {
    const mission = straight(flat());
    for (let i = 0; i < 30 * 20; i++) mission.update(dt, { throttle: true, steer: i < 30 * 3 ? 1 : 0 }, 0);
    expect(mission.offRoute).toBe(true);
    expect(mission.routeDistance).toBeGreaterThan(15);
    expect(mission.s).toBeGreaterThanOrEqual(0);
  });

  it('stops before ground too steep to climb and can reverse away', () => {
    const mission = straight(flat(20));
    mission.rover.heading = -Math.PI / 2; // facing +X, toward the slope
    for (let i = 0; i < 30 * 30; i++) mission.update(dt, { throttle: true }, 0);
    expect(mission.blocked).toBe(true);
    expect(mission.rover.x).toBeLessThan(20);
    for (let i = 0; i < 30 * 4; i++) mission.update(dt, { brake: true }, 0);
    expect(mission.rover.speed).toBeLessThan(0);
    const x = mission.rover.x;
    for (let i = 0; i < 30; i++) mission.update(dt, { brake: true }, 0);
    expect(mission.rover.x).toBeLessThan(x);
  });

  it('gets out only when stopped, walks around the rover and boards within reach', () => {
    const mission = straight(flat());
    for (let i = 0; i < 60; i++) mission.update(dt, { throttle: true }, 0);
    expect(mission.exitRover()).toBe(false);
    for (let i = 0; i < 300 && mission.rover.speed > 0.01; i++) mission.update(dt, { brake: true }, 0);
    expect(mission.exitRover()).toBe(true);
    expect(mission.state).toBe('walk');
    const r = mission.rover;
    const side = Math.hypot(mission.walker.x - r.x, mission.walker.z - r.z);
    expect(side).toBeGreaterThan(1.9);
    // Walking straight at the rover stops at its side.
    for (let i = 0; i < 300; i++) mission.update(dt, { forward: 1, viewYaw: Math.atan2(-(r.x - mission.walker.x), -(r.z - mission.walker.z)) }, 0);
    expect(Math.hypot(mission.walker.x - r.x, mission.walker.z - r.z)).toBeGreaterThanOrEqual(1.89);
    expect(walkTo(mission, r.x - 20, r.z)).toBe(true); // away on the driver's side
    expect(mission.canBoard).toBe(false);
    expect(mission.boardRover()).toBe(false);
    expect(walkTo(mission, r.x - 2.6, r.z, 0.3)).toBe(true);
    expect(mission.boardRover()).toBe(true);
    expect(mission.state).toBe('drive');
  });

  it('keeps the rover out of the habitat footprint', () => {
    const mission = straight(flat());
    mission.rover.heading = 0; // facing -Z, start at (0, -14): the habitat is behind
    mission.rover.heading = Math.PI; // turn to face the habitat at the origin
    for (let i = 0; i < 30 * 10; i++) mission.update(dt, { throttle: true }, 0);
    expect(Math.hypot(mission.rover.x, mission.rover.z)).toBeGreaterThanOrEqual(10 + 1.9 - 1e-6);
  });
});

it('restores the original delta loop with four science stations and five hazard gates', () => {
  const { terrain, route } = buildDeltaTraverse();
  expect(route.length).toBeCloseTo(1800, -1);
  expect(route.stations.map(station => station.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'HAB']);
  expect(route.stops.filter(stop => stop.kind === 'gate')).toHaveLength(5);
  const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 });
  mission.start();
  mission.s = route.length / 4;
  expect(fieldGuidance(mission).canReturn).toBe(false);
  expect(mission.returnToHabitat()).toBe(false);
});

it('offers three ordered approaches and preserves the original path after S1', () => {
  const original = buildDeltaTraverse();
  const [shortest, intermediate, longer] = buildDeltaApproaches(original);
  // a real trade-off: each longer option is gentler, and only the shortest crosses unsurveyed ground
  expect(shortest.distance).toBeLessThan(intermediate.distance);
  expect(intermediate.distance).toBeLessThan(longer.distance);
  expect(shortest.maxTilt).toBeGreaterThan(intermediate.maxTilt);
  expect(intermediate.maxTilt).toBeGreaterThan(longer.maxTilt);
  expect(shortest.unknowns.map(zone => zone.id)).toEqual(['H-UNSURVEYED']);
  expect(intermediate.unknowns).toEqual([]);
  expect(longer.unknowns).toEqual([]);
  expect(shortest.traverse.route.stops.filter(stop => stop.kind === 'gate')).toHaveLength(6);
  expect(intermediate.traverse.route.stops.filter(stop => stop.kind === 'gate')).toHaveLength(5);
  const s1 = original.route.stations[0];
  for (const option of [shortest, intermediate, longer]) {
    const route = option.traverse.route;
    expect(route.stations[0].s).toBe(option.distance);
    for (const offset of [0, 20, 250, 1000]) {
      const expected = original.route.sample(s1.s + offset);
      const reached = route.sample(option.distance + offset);
      expect(reached.x).toBeCloseTo(expected.x, 2);
      expect(reached.z).toBeCloseTo(expected.z, 2);
    }
  }
});
