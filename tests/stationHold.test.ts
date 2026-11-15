// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Mission } from '../src/sim/mission.js';
import { buildDeltaTraverse } from '../src/data/deltaTraverse.js';
import { Hud } from '../src/ui/hud.js';
import { placeArtifacts } from '../src/sim/artifacts.js';

function setup(id = 'S1') {
  const { route, terrain } = buildDeltaTraverse();
  const mission = new Mission(route, terrain, {}, { surprises: false, legCheck: false });
  mission.start();
  const station = mission.stations.find(st => st.id === id)!;
  Object.assign(mission.rover, { x: station.x, z: station.z, speed: 0 });
  mission.pos = { x: station.x, y: station.h, z: station.z };
  mission.s = station.s;
  mission.leftHome = true;
  document.body.innerHTML = '<div id="card"></div>';
  const hud = Object.assign(Object.create(Hud.prototype), { mission, route, context: {}, input: { virtual: {} }, cardKey: '' });
  hud._updateCard();
  return { mission, hud, station };
}
afterEach(() => document.body.replaceChildren());

it('finishes exactly one instrument per keyboard hold and displays the result immediately', () => {
  const { mission, hud, station } = setup();
  const choose = vi.spyOn(mission, 'chooseStationAction');
  hud.updateHold(1, { held: true });
  hud.updateHold(1, { held: true });
  hud._updateCard();
  expect(station.tasks[0].done).toBe(true);
  expect(station.tasks[1].done).toBe(false);
  expect(choose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.task .res')!.textContent).toContain(station.tasks[0].result);
  hud.updateHold(0, { held: false });
  hud.updateHold(0, { held: true });
  hud.updateHold(1, { held: true });
  expect(station.tasks[1].done).toBe(true);
});

it('supports holding a selected task by pointer and keyboard, and cancelling partial holds', () => {
  const { hud, station } = setup();
  const row = document.querySelector<HTMLButtonElement>('[data-task-index="1"]')!;
  expect(row.tagName).toBe('BUTTON');
  row.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  hud.updateHold(0.3, {});
  row.dispatchEvent(new Event('pointercancel'));
  hud.updateHold(1, {});
  expect(station.tasks[1].done).toBe(false);
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  hud.updateHold(0, {});
  hud.updateHold(1, {});
  row.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
  expect(station.tasks[1].done).toBe(true);
  expect(station.tasks[0].done).toBe(false);
});

it('shows why cold instrument work is blocked without filling or finishing the task', () => {
  const { mission, hud, station } = setup('S4');
  mission._weather = { label: 'Cold spell', speedLimit: 4.5, temperatureOffsetC: -25, exposureMinutes: 10 };
  const row = document.querySelector<HTMLButtonElement>('[data-task-index="2"]')!;
  row.dispatchEvent(new Event('pointerdown', { cancelable: true }));
  hud.updateHold(1, {});
  hud._updateCard();
  expect(station.tasks[2].done).toBe(false);
  expect(row.querySelector<HTMLElement>('.fill')!.style.width).toBe('0%');
  expect(row.querySelector('.res')!.textContent).toContain('10 min left');
  row.dispatchEvent(new Event('pointerup'));
  mission._weather = { label: 'Clear', speedLimit: 4.5, temperatureOffsetC: 0, exposureMinutes: Infinity };
  hud.updateHold(0, {});
  hud._updateCard();
  expect(row.querySelector('.res')!.textContent).toBe('');
  expect(row.classList.contains('active')).toBe(false);
  row.dispatchEvent(new Event('pointerdown', { cancelable: true }));
  hud.updateHold(0, {});
  hud.updateHold(1, {});
  expect(station.tasks[2].done).toBe(true);
});

it('checks collection permission before starting progress and rechecks it at completion', () => {
  const { mission, hud } = setup();
  const artifacts = placeArtifacts({ route: mission.route, terrain: mission.terrain, seed: 42 });
  mission.setArtifacts(artifacts);
  mission.exitRover();
  const find = artifacts.find(a => a.stationId === 'S1')!;
  Object.assign(mission.walker, { x: find.x, z: find.z });
  const gate = vi.spyOn(mission, 'collectionBlockReason').mockReturnValue('Cold window exhausted');
  hud.updateHold(1, { held: true, reach: find });
  expect(hud.hold.t).toBe(0);
  expect(hud.hold.reason).toBe('Cold window exhausted');
  expect(mission.collected).toHaveLength(0);
  hud.updateHold(0, { held: false });
  gate.mockReturnValueOnce('').mockReturnValue('Reserve would be breached');
  hud.updateHold(0, { held: true, reach: find });
  hud.updateHold(1, { held: true, reach: find });
  expect(mission.collected).toHaveLength(0);
  expect(hud.hold.reason).toBe('Reserve would be breached');
  expect(hud.hold.t).toBe(0);
});

it('does not credit time before a short tap or while the simulation is paused', () => {
  const { hud, station } = setup();
  hud.updateHold(5, { held: true });
  hud.updateHold(0, { held: false });
  expect(station.tasks[0].done).toBe(false);
  hud.updateHold(0, { held: true });
  hud.updateHold(0.5, { held: true });
  hud.updateHold(20, { held: true, paused: true });
  hud.updateHold(20, { held: true });
  expect(station.tasks[0].done).toBe(false);
  hud.updateHold(1, { held: true });
  expect(station.tasks[0].done).toBe(true);
});

it('restarts a partial hold after the crew leaves and returns to the station', () => {
  const { mission, hud, station } = setup();
  const stationPosition = mission.pos;
  hud.updateHold(0, { held: true });
  hud.updateHold(0.6, { held: true });
  mission.pos = { x: 0, y: 0, z: 0 };
  hud.updateHold(1, { held: true });
  mission.pos = stationPosition;
  hud.updateHold(0.6, { held: true });
  expect(hud.hold.t).toBe(0);
  expect(station.tasks[0].done).toBe(false);
});
