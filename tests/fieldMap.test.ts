import { afterEach, expect, it, vi } from 'vitest';
import { drawFieldHazards } from '../src/ui/mapRenderer.js';
import { TraverseRelief } from '../src/ui/traverseRelief.js';
import { drawNav } from '../src/rover/screens.js';
import { BLOWING_DUST } from '../src/sim/weather.js';

afterEach(() => vi.unstubAllGlobals());

it('keeps the station distance readable on the cockpit map in blowing dust', () => {
  const fillText = vi.fn();
  const screen = { ctx: { fillRect() {}, fillText }, canvas: { width: 400, height: 240 }, tex: {} };
  const mission = { rover: { x: 0, z: 0 }, s: 0, weather: BLOWING_DUST,
    nextKnownStop: { kind: 'station', ref: { id: 'S1', at: [60, 80], x: 60, z: 80 } } };
  drawNav(screen, { drawNav() {} }, mission, { x: 0, z: 0, headingDeg: 0 });
  const labels = fillText.mock.calls.map(([text]) => text);
  expect(labels).toContain('S1 100 m');
  expect(labels).toContain('VIS ≈ 50 m');
});

it('places observed obstacles at their actual world coordinates away from the planned route', () => {
  const fillRect = vi.fn();
  const context = { save() {}, restore() {}, fillRect, fillText() {} };
  const sample = vi.fn(() => ({ x: 0, z: 0 }));
  drawFieldHazards(context, { sample }, (x, z) => [x, z], null, [{ s: 10, ref: { at: { x: 87, z: -33 } } }]);
  expect(fillRect).toHaveBeenCalledWith(82, -38, 10, 10);
  expect(sample).not.toHaveBeenCalled();
});

it('centres wrist navigation visibility on the crew while walking off the planned route', () => {
  vi.stubGlobal('devicePixelRatio', 1);
  const heightAt = vi.fn(() => 0);
  const route = {
    x: [0, 10], z: [0, 0], h: [0, 0], count: 2, stops: [],
    terrain: { heightAt }, sample: vi.fn(() => ({ x: 0, z: 0 })),
  };
  const relief = new TraverseRelief(route);
  const project = vi.spyOn(relief, 'project');
  const methods = new Map();
  const context = new Proxy({}, {
    get: (_, key) => {
      if (!methods.has(key)) methods.set(key, vi.fn());
      return methods.get(key);
    },
    set: () => true,
  });
  const canvas = { clientWidth: 400, getContext: () => context };
  relief.draw(canvas, undefined, 5, { limitsVisibility: true, visibilityM: 20 }, null, [], { x: 87, z: -33 });
  expect(project).toHaveBeenCalledWith(87, -33, 0, 2);
  expect(project).toHaveBeenCalledWith(107, -33, 0, 2);
  expect(route.sample).not.toHaveBeenCalled();
});
