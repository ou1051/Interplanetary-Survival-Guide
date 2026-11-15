import { describe, expect, it } from 'vitest';
import { buildDeltaTraverse, buildDeltaApproaches } from '../src/data/deltaTraverse.js';

describe('Delta departure routes', () => {
  it('limits the forecast exposure to the unsurveyed shortcut and maps a longer alternative', () => {
    const [shortcut, , detour] = buildDeltaApproaches(buildDeltaTraverse());
    const zone = shortcut.unknowns[0];
    expect(shortcut.traverse.route.weatherExposure).toEqual({ from: zone.s0, to: zone.s1 });
    expect(detour.traverse.route.weatherExposure).toBeUndefined();
    expect(detour.distance).toBeGreaterThan(shortcut.distance);
    expect(detour.unknowns).toEqual([]);
    const middle = detour.traverse.route.sample(detour.distance / 2);
    const directMiddle = shortcut.traverse.route.sample(shortcut.distance / 2);
    expect(Math.hypot(middle.x - directMiddle.x, middle.z - directMiddle.z)).toBeGreaterThan(70);
    expect(detour.traverse.route.retracesOutbound).toBe(false);
    expect(shortcut.traverse.route.retracesOutbound).toBe(false);
  });
});
