import { expect, it } from 'vitest';
import { buildDeltaApproaches, buildDeltaTraverse } from '../src/data/deltaTraverse.js';
import { Mission } from '../src/sim/mission.js';

it('dust shortens the detection distance and the camera adds only observed obstacles to the map', () => {
  const [shortcut] = buildDeltaApproaches(buildDeltaTraverse());
  const parked = { throttle: false, brake: true, steer: 0, boost: false, action: false };
  for (const dust of [false, true]) {
    const { route, terrain } = shortcut.traverse;
    const m = new Mission(route, terrain, {}, { random: () => 0, frontSeconds: dust ? 600 : 0 });
    m.start();
    const index = m.stops.findIndex(stop => stop.ref.surprise);
    const target = m.stops[index];
    m.stopIndex = index;
    m.s = target.s - 36;
    m.update(0.1, parked, 0);
    expect(m.nextKnownStop).not.toEqual(target);
    expect(m.detectedObstacles).toHaveLength(0);
    m.s = target.s - 10;
    m.update(0.1, parked, 0);
    expect(m.detectedObstacles.length).toBe(dust ? 0 : 1);
    m.s = target.s - 2;
    m.update(0.1, parked, 0);
    expect(m.nextKnownStop).toBe(target);
    m.update(0.1, parked, 0);
    expect(m.detectedObstacles).toEqual([target]);
    expect(route.stops.some(stop => stop.ref.surprise)).toBe(false);
  }
});
