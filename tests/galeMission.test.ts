import { buildDeltaTraverse, buildDeltaApproaches, legVariants, buildLoopRoute } from '../src/data/deltaTraverse.js';
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

  it.each(['Gale', 'Delta'])('%s parks outside the habitat so the crew can get out and reboard before departure', site => {
    const { terrain, route } = buildDeltaTraverse();
    const mission = site === 'Gale' ? makeMission() : new Mission(route, terrain, { x: 0, y: 2, z: 0 });
    mission.start();
    const { x, z } = mission.rover;
    expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(11.9);
    if (site === 'Delta') expect([x, z]).toEqual([0, -14]);
    mission.update(dt, {}, 0);
    expect(mission.exitRover()).toBe(true);
    mission.update(dt, {}, 0);
    expect(mission.boardRover()).toBe(true);
    expect(mission.rover).toMatchObject({ x, z });
    expect(mission.leftHome).toBe(false);
    expect(fieldGuidance(mission).canReturn).toBe(false);
    expect(mission.returnToHabitat()).toBe(false);
    expect(mission.endEva()).toBe(false);
  });

  it('drives to the outcrop, collects its artifacts on foot and ends the EVA at the habitat', () => {
    const mission = makeMission();
    mission.start();
    const station = mission.stations[0];
    const finds = station.tasks.filter(task => task.artifact);
    expect(finds).toHaveLength(3);
    drive(mission, () => mission.currentStation === station);
    expect(station.visited).toBe(true);
    expect(mission.collect(finds[0].artifact)).toBe(false); // only on foot
    expect(mission.exitRover()).toBe(true);
    for (const task of finds) {
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
  expect(fieldGuidance(mission).canReturn).toBe(false);
  expect(mission.returnToHabitat()).toBe(false);
  drive(mission, () => mission.leftHome);
  expect(fieldGuidance(mission).canReturn).toBe(true);
  expect(mission.returnToHabitat()).toBe(true);
  expect(mission.retracing).toBe(false);
  expect(mission.nextStation?.final).toBe(true);
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
  const { route, terrain } = shortest.traverse;
  const patch = route.areaHazards.find(hz => hz.unsurveyed);
  const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 }, { random: () => 0 });
  mission.start();
  const seen: string[] = [];
  for (let step = 0; mission.state === 'drive' && step < 30 * 900; step++) {
    mission.update(dt, mission.autopilot(), 0);
    if (mission.state === 'drive' && mission.nextKnownStop) seen.push(mission.nextKnownStop.ref.type);
  }
  expect(mission.state).toBe('gate');
  const hit = mission.nextKnownStop.ref;
  expect(hit.type).toBe('SOFT SAND · WHEEL SINKING');
  expect(Math.hypot(hit.at.x - patch.cx, hit.at.z - patch.cz)).toBeLessThan(patch.radius);
  // A close camera sighting reveals the actual obstacle before the rover stops.
  expect(seen).toContain(hit.type);
  expect(mission.detectedObstacles.map(stop => stop.ref)).toEqual([hit]);
  // the rover stays put until the crew deals with it, which costs time
  const at = { ...mission.rover };
  mission.update(1, mission.autopilot(), 0);
  expect(Math.hypot(mission.rover.x - at.x, mission.rover.z - at.z)).toBe(0);
  const before = mission.met;
  expect(mission.acknowledge()).toBe(true);
  expect(mission.met - before).toBeCloseTo(4 * 60, 5);
  expect(mission.state).toBe('drive');
  // one per patch: driving on through it meets nothing more
  for (let i = 0; i < 30 * 20; i++) mission.update(dt, mission.autopilot(), 0);
  expect(mission.state).toBe('drive');
  // a mapped approach does not cross the patch: following it meets nothing on the way to S1
  const mapped = new Mission(intermediate.traverse.route, intermediate.traverse.terrain, { x: 0, y: 0, z: 0 }, { random: () => 0 });
  expect(intermediate.traverse.route.zones.some(z => z.unsurveyed)).toBe(false);
  mapped.start();
  for (let step = 0; step < 30 * 600 && mapped.currentStation?.id !== 'S1'; step++) mapped.update(dt, mapped.autopilot(), 0);
  expect(mapped.currentStation?.id).toBe('S1');
  expect(mapped.surprises.some(sp => sp.found)).toBe(false);
});

it('meets the hidden obstacle on any line through the unsurveyed patch, not only the planned one', () => {
  const [shortest] = buildDeltaApproaches(buildDeltaTraverse());
  const { route, terrain } = shortest.traverse;
  const patch = route.areaHazards.find(hz => hz.unsurveyed);
  const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 }, { random: () => 0.99 });
  mission.start();
  // start at the edge of the patch, aimed straight across its middle
  const a = Math.atan2(route.x[0] - patch.cx, route.z[0] - patch.cz) + 0.9;
  Object.assign(mission.rover, { x: patch.cx + Math.sin(a) * (patch.radius + 3), z: patch.cz + Math.cos(a) * (patch.radius + 3), heading: a, speed: 0 });
  for (let step = 0; mission.state === 'drive' && step < 30 * 300; step++) mission.update(dt, { throttle: true, steer: 0 }, 0);
  expect(mission.state).toBe('gate');
  expect(mission.nextKnownStop.ref.type).toBe('BOULDER ON THE ROUTE');
});

describe('leg check at stations', () => {
  // drive the intermediate approach to S1, get out and collect every S1 find
  async function atFirstStationDone() {
    const { legOptions } = await import('../src/sim/legCheck.js');
    const [, intermediate] = buildDeltaApproaches(buildDeltaTraverse());
    const { route, terrain } = intermediate.traverse;
    route.site = { name: 'Delta Front' };
    const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 }, { surprises: false });
    mission.setArtifacts(placeArtifacts({ route, terrain, site: route.site, seed: 5 }));
    const events: string[] = [];
    mission.on((type) => events.push(type));
    mission.start();
    drive(mission, () => mission.currentStation?.id === 'S1');
    expect(mission.exitRover()).toBe(true);
    const s1 = mission.route.stations[0];
    for (const task of s1.tasks.filter(task => task.artifact)) {
      const find = task.artifact;
      expect(walkTo(mission, find.x, find.z, WALK.reach - 0.4)).toBe(true);
      expect(mission.collect(find)).toBe(true);
    }
    return { mission, legOptions, events, s1 };
  }

  it('cools through the afternoon like the Gale records', async () => {
    const { temperatureAt, COLD_WORK_LIMIT_C } = await import('../src/sim/legCheck.js');
    expect(temperatureAt(14 * 60)).toBeGreaterThan(-20);
    expect(temperatureAt(17 * 60)).toBeLessThan(temperatureAt(15 * 60));
    expect(temperatureAt(20 * 60)).toBeLessThan(COLD_WORK_LIMIT_C);
  });

  it('asks for the next leg once a station is done and applies an allowed choice', async () => {
    const { mission, legOptions, events, s1 } = await atFirstStationDone();
    expect(s1.done).toBe(true);
    expect(mission.legPending).toBe(s1);
    expect(events).toContain('legcheck');
    const check = legOptions(mission);
    expect(check.options.map(o => o.id)).toEqual(['continue', 'quick', 'skip', 'home']);
    expect(check.recommended.id).toBe('continue');
    expect(mission.chooseLeg({ ...check.options[0], allowed: false })).toBe(false);
    expect(mission.legPending).toBe(s1);
    const skip = check.options.find(o => o.id === 'skip');
    expect(mission.chooseLeg(skip)).toBe(true);
    expect(mission.legPending).toBe(null);
    expect(mission.nextStation.id).toBe('S3');
    expect(mission.route.stations.find(st => st.id === 'S2').skipped).toBe(true);
  });

  it('locks legs that would break the oxygen reserve, twilight or the cold limit', async () => {
    const { mission, legOptions } = await atFirstStationDone();
    const { TWILIGHT_LIMIT } = await import('../src/sim/legCheck.js');
    // late in the afternoon: a full stop at the next station would bring the crew home after twilight
    const met = mission.met;
    mission.met += (TWILIGHT_LIMIT - 10 - mission.lmst) * 60;
    let check = legOptions(mission);
    const late = check.options.find(o => o.id === 'continue');
    expect(late.allowed).toBe(false);
    expect(late.checks.find(c => c.id === 'daylight').ok).toBe(false);
    expect(check.options.find(o => o.id === 'home').allowed).toBe(true);
    // oxygen nearly gone: only heading home remains
    mission.met = met;
    mission.o2Used = 8 * 60 - 60;
    check = legOptions(mission);
    expect(check.options.filter(o => o.allowed).map(o => o.id)).toEqual(['home']);
    expect(check.options[0].checks.find(c => c.id === 'oxygen').ok).toBe(false);
  });

  it('a quick stop leaves only the first find at the next station', async () => {
    const { mission, legOptions } = await atFirstStationDone();
    const quick = legOptions(mission).options.find(o => o.id === 'quick');
    expect(mission.chooseLeg(quick)).toBe(true);
    const s2 = mission.route.stations.find(st => st.id === 'S2');
    const planned = s2.tasks.filter(task => !task.skipped);
    expect(planned).toHaveLength(1);
    expect(planned[0].artifact.stationId).toBe('S2');
    // collecting that one find completes S2
    mission.state = 'walk';
    const find = planned[0].artifact;
    Object.assign(mission.walker, { x: find.x + 1, z: find.z });
    expect(mission.collect(find)).toBe(true);
    expect(s2.done).toBe(true);
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

  it('swaps only the leg ahead and keeps the crew, stations and finds where they are', () => {
    const original = buildDeltaTraverse();
    const [, intermediate] = buildDeltaApproaches(original);
    const { route, terrain } = intermediate.traverse;
    route.site = { name: 'Delta Front' };
    const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 }, { surprises: false });
    mission.setArtifacts(placeArtifacts({ route, terrain, site: route.site, seed: 5 }));
    mission.start();
    const s1 = route.stations[0];
    drive(mission, () => mission.currentStation?.id === 'S1');
    const at = { x: mission.rover.x, z: mission.rover.z, s: mission.s };
    s1.done = true;
    const s1Tasks = s1.tasks;
    const [, , safe] = legVariants(terrain, route.legs, 1);
    const legs = [...route.legs];
    legs[1] = safe.curve;
    const next = buildLoopRoute(terrain, legs);
    mission.replaceRoute(next);
    expect(mission.route).toBe(next);
    expect(next.stations[0].s).toBeCloseTo(s1.s, 6);
    expect(next.stations[0].done).toBe(true);
    expect(next.stations[0].tasks).toBe(s1Tasks);
    // the new S2 sits as far along as the safe path is long
    expect(next.stations[1].s - next.stations[0].s).toBeCloseTo(safe.distance, 0);
    const before = route.sample(s1.s - 10);
    const after = next.sample(s1.s - 10);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.z).toBeCloseTo(before.z, 3);
    // the rover has not moved and is found on the new plan where it was on the old one
    expect(mission.rover.x).toBe(at.x);
    expect(mission.rover.z).toBe(at.z);
    expect(mission.s).toBeCloseTo(at.s, -1);
    expect(mission.nextStation.id).toBe('S2');
  });
});

it('limits the Shift time boost: short charge, none on hazard ground or near a station', () => {
  const [, intermediate] = buildDeltaApproaches(buildDeltaTraverse());
  const { route, terrain } = intermediate.traverse;
  const boost = { throttle: true, brake: false, steer: 0, action: false, boost: true };
  const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 }, { surprises: false });
  mission.start();
  const park = (x: number, z: number) => Object.assign(mission.rover, { x, z, speed: 0 });
  // open, flat ground away from the stations: boost works and drains
  const flat = (() => {
    for (let i = 0; i < route.count; i++) {
      const x = route.x[i], z = route.z[i];
      park(x, z);
      const g = mission._ground(x, z, mission.rover.heading);
      const near = route.stations.some(st => !st.final && Math.hypot(st.x - x, st.z - z) < 40);
      if (!g.zones.length && !near) return { x, z };
    }
    return null;
  })();
  expect(flat).not.toBeNull();
  park(flat.x, flat.z);
  mission.update(0.1, boost, 0);
  expect(mission.boosting).toBe(true);
  expect(mission.boostCharge).toBeLessThan(1);
  // held until empty: it stops and refills before it can be used again
  for (let i = 0; i < 200 && mission.boostBlocked !== 'RECHARGING'; i++) { park(flat.x, flat.z); mission.update(0.1, boost, 0); }
  expect(mission.boostBlocked).toBe('RECHARGING');
  expect(mission.boosting).toBe(false);
  // inside a mapped hazard area it never works
  const hz = route.areaHazards[0];
  mission.boostCharge = 1;
  mission._boostEmpty = false;
  park(hz.cx, hz.cz);
  mission.update(0.1, boost, 0);
  expect(mission.boosting).toBe(false);
  expect(mission.boostBlocked).toBe('HAZARD STRETCH');
  // nor right next to the next station
  const s1 = route.stations[0];
  mission.boostCharge = 1;
  mission._boostEmpty = false;
  park(s1.x + 5, s1.z);
  mission.update(0.1, boost, 0);
  expect(['STOP AHEAD', 'HAZARD STRETCH']).toContain(mission.boostBlocked);
  expect(mission.boosting).toBe(false);
});
