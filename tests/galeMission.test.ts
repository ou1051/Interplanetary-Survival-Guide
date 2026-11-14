import { buildDeltaTraverse, buildDeltaApproaches } from '../src/data/deltaTraverse.js';
import { describe, expect, it } from 'vitest';
import { planGaleRoutes, missionHeight, outcrop, worldPosition, sampleMinutes, terrainSlope, gridPosition } from '../src/data/galeSite.js';
import { LIFE_SUPPORT, SLOPE_CLASSES } from '../src/config/mission.js';
import { Route } from '../src/world/route.js';
import { Mission } from '../src/sim/mission.js';
import { fieldGuidance } from '../src/sim/fieldGuidance.js';

const plans = planGaleRoutes();
const neutral = { throttle: true, brake: false, steer: 0, action: true, boost: true };

function makeMission(plan = plans[0]) {
  const terrain = { heightAt: missionHeight };
  const route = new Route(terrain, {
    points: plan.points, exact: true, areaHazards: [], stations: [{
      id: 'S1', name: 'Layered outcrop', at: worldPosition(outcrop),
      tasks: [{ label: 'Collect paired samples', minutes: sampleMinutes, sampleCount: 2 }],
    }],
  });
  return new Mission(route, terrain, { x: 0, y: 0, z: 0 });
}

function finish(mission: ReturnType<typeof makeMission>) {
  for (let i = 0; i < 8000 && mission.state !== 'complete'; i++) {
    if (!mission.acknowledge()) mission.update(1 / 30, neutral, 0);
  }
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

  it('keeps the recommended route off ground the rover classes as danger', () => {
    const [recommended] = plans;
    for (const cell of recommended.path) expect(terrainSlope(...gridPosition(cell))).toBeLessThan(SLOPE_CLASSES.danger);
  });

  it('leaves the oxygen the route card promised, including suit-up and ingress', () => {
    for (const plan of plans) {
      const mission = makeMission(plan);
      expect(mission.route.stations.at(-1)?.tasks[0].minutes).toBe(LIFE_SUPPORT.ingressMinutes);
      mission.start();
      finish(mission);
      expect(mission.state).toBe('complete');
      // The card plans at constant speed; live acceleration, stops and task holds add a little.
      expect(Math.abs(mission.o2Remaining - plan.returnOxygen)).toBeLessThan(10);
      expect(mission.o2Remaining).toBeLessThanOrEqual(plan.returnOxygen);
    }
  });

  it('collects the two samples and returns to habitat on the planned route', () => {
    const mission = makeMission();
    mission.start();
    finish(mission);
    expect(mission.state).toBe('complete');
    expect(mission.samples).toBe(2);
    expect(fieldGuidance(mission).advice).toBe('At habitat');
  });

  it('points the crew home when dust rolls in and permits an early return', () => {
    const mission = makeMission(plans[1]);
    mission.start();
    mission.s = mission.route.length / 4;
    const before = mission.route.sample(mission.s);
    mission.dustWarning = true;
    const guidance = fieldGuidance(mission);
    expect(guidance.advice).toBe('Return to habitat');
    expect(guidance.next).toBe('Habitat');
    expect(guidance.canReturn).toBe(true);
    expect(mission.returnToHabitat()).toBe(true);
    expect(mission.nextStation?.final).toBe(true);
    const after = mission.route.sample(mission.s);
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.z).toBeCloseTo(before.z, 4);
    finish(mission);
    expect(mission.state).toBe('complete');
    expect(mission.samples).toBe(0);
    expect(mission.nextStation).toBeNull();
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
  expect(shortest.distance).toBeLessThan(intermediate.distance);
  expect(intermediate.distance).toBeLessThan(longer.distance);
  expect(intermediate.traverse.route).toBe(original.route);
  const s1 = original.route.stations[0];
  for (const option of [shortest, longer]) {
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
