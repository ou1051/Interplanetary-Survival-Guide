import { expect, it } from 'vitest';
import { buildDeltaApproaches, buildDeltaTraverse } from '../src/data/deltaTraverse.js';
import { Mission } from '../src/sim/mission.js';

it('dust shortens the camera range before encountering the same off-route obstacle', () => {
  const [shortcut] = buildDeltaApproaches(buildDeltaTraverse());
  const { route, terrain } = shortcut.traverse;
  const patch = route.areaHazards.find(hazard => hazard.unsurveyed);
  const ranges = [0, 600].map(frontSeconds => {
    const m = new Mission(route, terrain, {}, { random: () => 0, frontSeconds });
    m.start();
    // Cross the middle of the patch from the west, independent of the planned track.
    Object.assign(m.rover, { x: patch.cx - patch.radius - 3, z: patch.cz, heading: -Math.PI / 2 });
    expect(m.detectedObstacles).toHaveLength(0);
    expect(m.nextKnownStop.ref.surprise).toBeFalsy();
    let firstSeen;
    for (let i = 0; i < 12000 && m.state !== 'gate'; i++) {
      m.update(0.05, { throttle: true }, 0);
      if (!firstSeen && m.nextKnownStop.ref.surprise) firstSeen = { ...m.rover };
    }
    expect(m.state).toBe('gate');
    expect(m.detectedObstacles).toEqual([m.nextKnownStop]);
    expect(m.nextKnownStop.ref.at).toEqual({ x: m.rover.x, z: m.rover.z });
    expect(m.acknowledge()).toBe(true);
    expect(m.detectedObstacles[0].ref.acknowledged).toBe(true);
    return Math.hypot(m.rover.x - firstSeen.x, m.rover.z - firstSeen.z);
  });
  expect(ranges[0]).toBeGreaterThan(10);
  expect(ranges[1]).toBeGreaterThan(0);
  expect(ranges[1]).toBeLessThan(3);
});

it('uses the actual crew position when a detour driver visits the forecast shortcut', () => {
  const [, detour] = buildDeltaApproaches(buildDeltaTraverse());
  const { route, terrain } = detour.traverse;
  const patch = route.areaHazards.find(hazard => hazard.unsurveyed);
  const m = new Mission(route, terrain, {}, { frontSeconds: 120, surprises: false });
  m.start();
  expect(m.weather.label).toBe('Clear');
  expect(m.activeFront).toBeFalsy(); // selected track avoids the patch
  Object.assign(m.rover, { x: patch.cx, z: patch.cz });
  m.update(0, {}, 0);
  expect(m.weather.label).toBe('Dust front over shortcut');
  expect(m.limit).toBe(m.weather.speedLimit);
  m.exitRover();
  Object.assign(m.walker, { x: patch.cx + patch.radius + 3, z: patch.cz });
  m.update(0, {}, 0);
  expect(m.weather.label).toBe('Clear');
});
