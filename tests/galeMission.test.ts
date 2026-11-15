import { buildDeltaTraverse, buildDeltaApproaches, legVariants, buildLoopRoute } from '../src/data/deltaTraverse.js';
import { describe, expect, it } from 'vitest';
import { planGaleRoutes, missionHeight, outcrop, worldPosition, sampleMinutes } from '../src/data/galeSite.js';
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

it('estimates each approach with the live rules and flags the possible delay only on unsurveyed ground', () => {
  const [shortest, intermediate, longer] = buildDeltaApproaches(buildDeltaTraverse());
  // creeping through the unsurveyed patch makes the shortest line the slowest one
  expect(shortest.estimate.minutes).toBeGreaterThan(longer.estimate.minutes);
  expect(longer.estimate.minutes).toBeGreaterThan(intermediate.estimate.minutes);
  expect(shortest.estimate.extraMinutes).toEqual([2, 4]);
  expect(intermediate.estimate.extraMinutes).toBeNull();
  expect(longer.estimate.extraMinutes).toBeNull();
});

it('hides one obstacle in unsurveyed ground that stops the rover and costs time', () => {
  const [shortest, intermediate] = buildDeltaApproaches(buildDeltaTraverse());
  const input = { throttle: true, brake: false, steer: 0, action: false, boost: false };
  const route = shortest.traverse.route;
  const zone = route.zones.find(z => z.unsurveyed);
  const mission = new Mission(route, shortest.traverse.terrain, { x: 0, y: 0, z: 0 }, { random: () => 0 });
  mission.start();
  const seen: string[] = [];
  let hit = null;
  for (let step = 0; !hit && step < 30 * 600; step++) {
    if (mission.state === 'gate') {
      if (mission.nextStop.ref.surprise) hit = mission.nextStop;
      else mission.acknowledge();
    } else mission.update(1 / 30, input, 0);
    if (mission.state === 'drive' && mission.nextKnownStop) seen.push(mission.nextKnownStop.ref.type);
  }
  expect(hit.ref.type).toBe('SOFT SAND · WHEEL SINKING');
  expect(hit.s).toBeGreaterThan(zone.s0);
  expect(hit.s).toBeLessThan(zone.s1);
  // while driving, the displays never named it before the rover got there
  expect(seen).not.toContain(hit.ref.type);
  const before = mission.met;
  mission.acknowledge();
  expect(mission.met - before).toBeCloseTo(4 * 60, 5);
  // mapped approaches hide nothing
  const mapped = new Mission(intermediate.traverse.route, intermediate.traverse.terrain, { x: 0, y: 0, z: 0 });
  expect(mapped.stops.some(stop => stop.ref.surprise)).toBe(false);
});

describe('leg check at stations', () => {
  const drive = { throttle: true, brake: false, steer: 0, action: false, boost: false };
  const work = { ...drive, throttle: false, action: true };
  // drive the intermediate approach to S1 and finish all its tasks
  async function atFirstStationDone() {
    const { legOptions } = await import('../src/sim/legCheck.js');
    const [, intermediate] = buildDeltaApproaches(buildDeltaTraverse());
    const { route, terrain } = intermediate.traverse;
    const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 });
    mission.start();
    for (let step = 0; mission.state !== 'stationDone' && step < 30 * 900; step++) {
      if (mission.state === 'gate') mission.acknowledge();
      mission.update(1 / 30, mission.state === 'station' ? work : drive, 0);
    }
    return { mission, legOptions };
  }

  it('cools through the afternoon like the Gale records', async () => {
    const { temperatureAt, COLD_WORK_LIMIT_C } = await import('../src/sim/legCheck.js');
    expect(temperatureAt(14 * 60)).toBeGreaterThan(-20);
    expect(temperatureAt(17 * 60)).toBeLessThan(temperatureAt(15 * 60));
    expect(temperatureAt(20 * 60)).toBeLessThan(COLD_WORK_LIMIT_C);
  });

  it('parks the rover after a station until an allowed leg is chosen', async () => {
    const { mission, legOptions } = await atFirstStationDone();
    expect(mission.acknowledge()).toBe(true);
    expect(mission.state).toBe('legcheck');
    mission.update(1, drive, 0);
    expect(mission.state).toBe('legcheck');
    const check = legOptions(mission);
    expect(check.options.map(o => o.id)).toEqual(['continue', 'quick', 'skip', 'home']);
    expect(check.recommended.id).toBe('continue');
    expect(mission.chooseLeg({ ...check.options[0], allowed: false })).toBe(false);
    const skip = check.options.find(o => o.id === 'skip');
    expect(mission.chooseLeg(skip)).toBe(true);
    expect(mission.state).toBe('drive');
    expect(mission.nextStation.id).toBe('S3');
    expect(mission.stops.some(stop => stop.ref.id === 'S2')).toBe(false);
  });

  it('locks legs that would break the oxygen reserve, twilight or the cold limit', async () => {
    const { mission, legOptions } = await atFirstStationDone();
    mission.acknowledge();
    // late in the afternoon: a full stop at the next station would bring the crew home after twilight
    mission.met += 3 * 60 * 60;
    let check = legOptions(mission);
    const late = check.options.find(o => o.id === 'continue');
    expect(late.allowed).toBe(false);
    expect(late.checks.find(c => c.id === 'daylight').ok).toBe(false);
    expect(check.options.find(o => o.id === 'home').allowed).toBe(true);
    // oxygen nearly gone: only heading home remains
    mission.met -= 3 * 60 * 60;
    mission.o2Used = 8 * 60 - 60;
    check = legOptions(mission);
    expect(check.options.filter(o => o.allowed).map(o => o.id)).toEqual(['home']);
    expect(check.options[0].checks.find(c => c.id === 'oxygen').ok).toBe(false);
  });

  it('a quick stop leaves only the first task at the next station', async () => {
    const { mission, legOptions } = await atFirstStationDone();
    mission.acknowledge();
    const quick = legOptions(mission).options.find(o => o.id === 'quick');
    mission.chooseLeg(quick);
    const s2 = mission.route.stations.find(st => st.id === 'S2');
    expect(s2.tasks.map(t => !!t.skipped)).toEqual([false, true, true]);
  });
});

describe('choosing a path between stations', () => {
  it('offers fastest, planned and safest paths for every leg after S1', () => {
    const original = buildDeltaTraverse();
    const [, intermediate] = buildDeltaApproaches(original);
    const { route, terrain } = intermediate.traverse;
    for (const index of [1, 2, 3, 4]) {
      const [fast, planned, safe] = legVariants(terrain, route.legs, index);
      expect([fast.id, planned.id, safe.id]).toEqual(['fast', 'planned', 'safe']);
      expect(fast.minutes).toBeLessThanOrEqual(planned.minutes + 1e-6);
      expect(safe.danger).toBeLessThanOrEqual(planned.danger);
      expect(['Easy', 'Moderate', 'Hard']).toContain(safe.difficulty);
    }
  });

  it('swaps only the leg ahead and keeps the rover where it is', () => {
    const original = buildDeltaTraverse();
    const [, intermediate] = buildDeltaApproaches(original);
    const { route, terrain } = intermediate.traverse;
    const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 }, { surprises: false });
    mission.start();
    const s1 = route.stations[0];
    mission.s = s1.s;
    mission.stopIndex = mission.stops.findIndex(stop => stop.ref === s1);
    mission.state = 'legcheck';
    s1.done = true;
    const [, , safe] = legVariants(terrain, route.legs, 1);
    const legs = [...route.legs];
    legs[1] = safe.curve;
    const next = buildLoopRoute(terrain, legs);
    mission.replaceRoute(next);
    expect(mission.route).toBe(next);
    expect(next.stations[0].s).toBeCloseTo(s1.s, 6);
    expect(next.stations[0].done).toBe(true);
    // the new S2 sits as far along as the safe path is long
    expect(next.stations[1].s - next.stations[0].s).toBeCloseTo(safe.distance, 0);
    const before = route.sample(s1.s - 10);
    const after = next.sample(s1.s - 10);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.z).toBeCloseTo(before.z, 3);
    expect(mission.nextStop.ref.id).toBe('S1');
  });
});

it('limits the Shift time boost: short charge, none on hazard stretches or near a stop', () => {
  const [, intermediate] = buildDeltaApproaches(buildDeltaTraverse());
  const { route, terrain } = intermediate.traverse;
  const boost = { throttle: true, brake: false, steer: 0, action: false, boost: true };
  const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 }, { surprises: false });
  mission.start();
  // open ground: boost works and drains
  mission.s = 40;
  mission.update(0.1, boost, 0);
  expect(mission.boosting).toBe(true);
  expect(mission.boostCharge).toBeLessThan(1);
  // held until empty: it stops and refills before it can be used again
  for (let i = 0; i < 200 && mission.boostBlocked !== 'RECHARGING'; i++) { mission.s = 40; mission.update(0.1, boost, 0); }
  expect(mission.boostBlocked).toBe('RECHARGING');
  expect(mission.boosting).toBe(false);
  // on a yellow or red stretch it never works
  const zone = route.zones.find(z => z.kind === 'slope');
  mission.boostCharge = 1;
  mission._boostEmpty = false;
  mission.s = zone.s0 + 1;
  mission.stopIndex = mission.stops.findIndex(stop => stop.s > zone.s1 + 30);
  mission.update(0.1, boost, 0);
  expect(mission.boosting).toBe(false);
  expect(mission.boostBlocked).toBe('HAZARD STRETCH');
});
