// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Mission } from '../src/sim/mission.js';
import { buildDeltaTraverse } from '../src/data/deltaTraverse.js';
import { renderStationChoices } from '../src/ui/stationChoices.js';
import { Hud } from '../src/ui/hud.js';

function setup(id = 'S2') {
  const { route, terrain } = buildDeltaTraverse();
  const mission = new Mission(route, terrain, {}, { surprises: false });
  mission.stopIndex = mission.stops.findIndex(stop => stop.ref.id === id);
  mission.s = mission.nextStop.s;
  mission.state = 'station';
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { mission, container };
}
afterEach(() => document.body.replaceChildren());

describe('shared station decisions UI', () => {
  it('runs the sample-first decision through a native button while the rover is parked', () => {
    const { mission, container } = setup();
    renderStationChoices(container, mission);
    const button = container.querySelector<HTMLButtonElement>('[data-action="task:2"]')!;
    expect(button.textContent).toContain('Sample first');
    expect(button.textContent).toContain('HAB O₂');
    expect(button.textContent).toContain('battery');
    expect(button.textContent).toContain('daylight');
    button.click();
    expect(mission.samples).toBe(1);
    expect(container.querySelector('[data-action="task:2"]')).toBeNull();
    expect(container.querySelector('.station-outcomes')!.textContent).toContain('tube A2');
  });

  it('preserves focus while forecasts refresh and exposes blocked cold work', () => {
    const { mission, container } = setup('S4');
    mission._weather = { label: 'Cold spell', speedLimit: 4.5, temperatureOffsetC: -25, exposureMinutes: 10 };
    renderStationChoices(container, mission);
    const short = container.querySelector<HTMLButtonElement>('[data-action="task:1"]')!;
    short.focus();
    mission.met += 1;
    renderStationChoices(container, mission);
    expect(document.activeElement).toBe(short);
    const long = container.querySelector<HTMLButtonElement>('[data-action="task:2"]')!;
    expect(long.disabled).toBe(true);
    expect(long.textContent).toContain('10 min left in cold window');
    long.click();
    expect(mission.scienceResults).toHaveLength(0);
  });

  it('retains skipped and degraded science outcomes in the debrief after early return', () => {
    const { mission } = setup();
    mission._weather = { label: 'Blowing dust', speedLimit: 1.5, visibilityM: 190, temperatureOffsetC: 0, exposureMinutes: Infinity };
    mission.chooseStationAction('task:0');
    mission.chooseStationAction('home');
    document.body.innerHTML = '<div id="hud"></div><div id="card"></div><div id="debriefGrid"></div><div id="debriefSub"></div><div id="debrief" class="hidden"></div><button id="restartBtn"></button>';
    const hud = Object.create(Hud.prototype);
    hud.mission = mission;
    hud.route = mission.route;
    hud.showDebrief(() => {});
    expect(document.querySelector('.debrief-science')!.textContent).toContain('Dust-degraded');
    expect(document.querySelector('.debrief-science')!.textContent).toContain('head home');
    expect(document.querySelector('#debriefSub')!.textContent).toContain('Returned early');
  });
});
