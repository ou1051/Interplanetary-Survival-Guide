import { describe, expect, it } from 'vitest';
import { fieldGuidance, forecastReturn } from '../src/sim/fieldGuidance.js';
import { legOptions } from '../src/sim/legCheck.js';
import { CLEAR_WEATHER, SHORTCUT_FRONT } from '../src/sim/weather.js';
import { LIFE_SUPPORT } from '../src/config/mission.js';

function fixture() {
  return {
    s: 0, lmst: 840, met: 0, o2Remaining: 480, batteryWh: 1600,
    state: 'drive', pos: { x: 100, z: 100 }, weather: CLEAR_WEATHER,
    route: { length: 400, step: 1, stations: [], zones: [], retracesOutbound: false,
      sample: (s: number) => ({ x: s, z: 0, tx: 1, tz: 0 }), speedLimitAt: () => 4.5 },
  };
}

describe('free-roam forecasts', () => {
  it('returns directly from the actual off-route position while planning keeps the chosen route', () => {
    const m = fixture();
    const home = forecastReturn(m, { homeOnly: true });
    expect(home.driveMinutes).toBeCloseTo(Math.hypot(100, 100) * 1.3 / 1.6 / 60);
    const plan = forecastReturn(m);
    expect(plan.driveMinutes).toBeCloseTo(home.driveMinutes + 400 / 4.5 / 60);
    expect(legOptions(m).options.at(-1)?.forecast).toEqual(home);
    m.pos.x = 200;
    expect(forecastReturn(m, { homeOnly: true }).totalMinutes).toBeGreaterThan(home.totalMinutes);
  });

  it('charges work oxygen and hotel power for walking home even when the rover is at habitat', () => {
    const m = Object.assign(fixture(), { state: 'walk', pos: { x: 100, z: 0 }, rover: { x: 0, z: 0 } });
    const home = forecastReturn(m, { homeOnly: true });
    const minutes = 130 / (LIFE_SUPPORT.walkSpeedKmh / 3.6) / 60;
    expect(home.walkingMinutes).toBeCloseTo(minutes);
    expect(home.oxygenUsed).toBeCloseTo(minutes * 1.25 + 25);
    expect(home.batteryWhUsed).toBeCloseTo((minutes + 20) * 110 / 60);
    expect(home.reserveOK).toBe(true);
    const guidance = fieldGuidance(m);
    expect(guidance).toMatchObject({ next: 'Habitat', direction: 'W', distance: 100 });
  });

  it('passes real positions to weather forecasts on the free-roam return', () => {
    const m = fixture();
    const clear = forecastReturn(m, { homeOnly: true });
    Object.assign(m, { frontUntilMet: 60, weatherAt: (_s: number, met: number, _route: unknown, position: { z: number }) =>
      position.z > 50 && met < 60 ? SHORTCUT_FRONT : CLEAR_WEATHER });
    expect(forecastReturn(m, { homeOnly: true }).driveMinutes).toBeGreaterThan(clear.driveMinutes);
    expect(forecastReturn(m, { homeOnly: true, waitSeconds: 60 }).driveMinutes).toBeCloseTo(clear.driveMinutes);
  });

  it('returns along the retraced outbound track and counts the off-route connector', () => {
    const m = fixture();
    m.route.retracesOutbound = true;
    m.s = 100;
    m.pos = { x: 100, z: 50 };
    expect(forecastReturn(m, { homeOnly: true }).driveMinutes).toBeCloseTo(65 / 1.6 / 60 + 100 / 4.5 / 60);
  });

  it('plans the artifact package without charging the alternative instruments as well', () => {
    const m = fixture();
    m.route.stations = [{ id: 'S1', s: 100, name: 'Station', x: 100, z: 0, tasks: [
      { label: 'Optional instrument', minutes: 400 },
      { label: 'Artifact', minutes: 1, artifact: 'A' },
    ] }] as never;
    expect(legOptions(m).options[0].allowed).toBe(true);
    expect(legOptions(m).options[0].detail).toBe('Station · 1 remaining tasks');
  });
});
