import { describe, expect, it } from 'vitest';
import { buildDeltaTraverse, buildDeltaApproaches, buildLoopRoute, legVariants } from '../src/data/deltaTraverse.js';
import { Mission } from '../src/sim/mission.js';
import { forecastReturn, legOptions } from '../src/sim/legCheck.js';
import { PASSING_WEATHER } from '../src/sim/weather.js';

function atS1() {
  const [shortcut] = buildDeltaApproaches(buildDeltaTraverse());
  const { route, terrain } = shortcut.traverse;
  const mission = new Mission(route, terrain, {}, { surprises: false, frontSeconds: 600 });
  mission.start();
  const station = route.stations[0];
  mission.s = station.s;
  mission.stopIndex = mission.stops.findIndex(stop => stop.ref === station);
  mission.state = 'legcheck';
  station.done = true;
  return { mission, route, terrain };
}

describe('weather and upstream leg-path integration', () => {
  it('forecasts the chosen geometry with observed weather and keeps the compact action labels', () => {
    const { mission, route, terrain } = atS1();
    mission._weather = PASSING_WEATHER[2];
    mission._weatherAt = 600;
    const [fast] = legVariants(terrain, route.legs, 1);
    const legs = [...route.legs];
    legs[1] = fast.curve;
    const preview = buildLoopRoute(terrain, legs);
    const options = legOptions(mission, preview).options;
    const home = options.find(option => option.id === 'home');
    expect(home.forecast).toEqual(forecastReturn(mission, { route: preview }));
    expect(home.forecast.driveMinutes).not.toBeCloseTo(legOptions(mission).options.at(-1).forecast.driveMinutes, 3);
    const clear = new Mission(preview, terrain, {}, { surprises: false });
    clear.s = mission.s;
    expect(home.forecast.driveMinutes).toBeGreaterThan(forecastReturn(clear).driveMinutes);
    expect(options.map(option => option.short)).toEqual(['Full stop', 'Quick stop', 'Skip S2', 'Go home']);
  });

  it('retains the shortcut front and acquired or deferred science records when a later leg changes', () => {
    const { mission, route, terrain } = atS1();
    Object.assign(route.stations[0].tasks[0], { done: true, quality: 'dust-degraded', result: 'Acquired in dust' });
    Object.assign(route.stations[0].tasks[1], { skipped: true, deferred: true, result: 'Crew deferred panorama' });
    const records = mission.scienceResults;
    const [, , safe] = legVariants(terrain, route.legs, 1);
    const legs = [...route.legs];
    legs[1] = safe.curve;
    const next = buildLoopRoute(terrain, legs);
    mission.replaceRoute(next);
    expect(mission.scienceResults).toEqual(records);
    expect(next.weatherExposure.from).toBeCloseTo(route.weatherExposure.from, 0);
    expect(next.weatherExposure.to).toBeCloseTo(route.weatherExposure.to, 0);
    expect(mission.weatherAt((next.weatherExposure.from + next.weatherExposure.to) / 2, 0).label).toBe('Dust front over shortcut');
    expect(mission.s).toBe(route.stations[0].s);
  });
});
