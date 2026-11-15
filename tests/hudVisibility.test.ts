import { afterEach, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { CLEAR_WEATHER, SHORTCUT_FRONT } from '../src/sim/weather.js';
import { Hud } from '../src/ui/hud.js';

const dust = SHORTCUT_FRONT;

afterEach(() => vi.unstubAllGlobals());

it.each(['station', 'gate', 'artifact'])('hides %s world markers beyond dust visibility and restores them in clear weather', (kind) => {
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 });
  const camera = new PerspectiveCamera(60, 1280 / 720, 0.1, 1000);
  const el = { style: { opacity: 0 }, querySelector: () => ({ textContent: '' }) };
  const ref = { id: 'A', s0: 50, x: 0, z: -(dust.visibilityM + 1) };
  const mission = { nextStation: ref, s: 0, offRoute: false, weather: dust };
  const hud = Object.assign(Object.create(Hud.prototype), {
    mission, context: {}, _v: new Vector3(),
    markers: [{ el, kind, ref, x: 0, y: 0, z: -(dust.visibilityM + 1) }],
  });
  const view = { x: 0, z: 0, camera };

  hud._markers(view);
  expect(el.style.opacity).toBe(0);

  view.z = -1;
  hud._markers(view);
  expect(el.style.opacity).toBe(1);

  view.z = 0;
  mission.weather = CLEAR_WEATHER;
  hud._markers(view);
  expect(el.style.opacity).toBe(1);
});

it('also hides the off-screen next-station arrow beyond dust visibility', () => {
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 });
  const ref = { id: 'A' };
  const el = { style: { opacity: 0 } };
  const hud = Object.assign(Object.create(Hud.prototype), {
    mission: { nextStation: ref, s: 0, weather: dust },
    _v: new Vector3(), markers: [{ el, kind: 'station', ref, x: 0, y: 0, z: dust.visibilityM + 1 }],
  });
  hud._markers({ x: 0, z: 0, camera: new PerspectiveCamera() });
  expect(el.style.opacity).toBe(0);
});
