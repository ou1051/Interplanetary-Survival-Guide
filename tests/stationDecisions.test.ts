import { describe, expect, it } from 'vitest';
import { Mission } from '../src/sim/mission.js';
import { buildDeltaTraverse } from '../src/data/deltaTraverse.js';

function atStation(id = 'S2') {
  const { route, terrain } = buildDeltaTraverse();
  const mission = new Mission(route, terrain, {}, { surprises: false, legCheck: false });
  mission.start();
  parkAt(mission, id);
  return mission;
}
function parkAt(mission, id) {
  const station = mission.route.stations.find(station => station.id === id);
  Object.assign(mission.rover, { x: station.x, z: station.z, speed: 0 });
  mission.update(0, {}, 0);
}
const cold = { label: 'Cold spell', speedLimit: 4.5, fogDensity: 0.00042, temperatureOffsetC: -25, exposureMinutes: 10 };
const dust = { label: 'Blowing dust', speedLimit: 1.5, fogDensity: 0.009, visibilityM: 190, temperatureOffsetC: 0, exposureMinutes: Infinity };

describe('station science choices', () => {
  it('lets S2 sample first and charges one work cost, including repeat clicks', () => {
    const m = atStation();
    expect(m.chooseStationAction('task:2')).toBe(true);
    expect(m.samples).toBe(1);
    expect(m.currentStation.tasks[0].done).toBe(false);
    expect(m.met).toBe(1800);
    expect(m.o2Used).toBe(37.5);
    expect(m.chooseStationAction('task:2')).toBe(false);
    expect(m.o2Used).toBe(37.5);
  });

  it('stores a degraded dust panorama instead of claiming resolved beds', () => {
    const m = atStation();
    m._weather = dust;
    expect(m.chooseStationAction('task:0')).toBe(true);
    expect(m.currentStation.tasks[0].quality).toBe('dust-degraded');
    expect(m.currentStation.tasks[0].result).toContain('obscured');
    expect(m.scienceResults[0]).toMatchObject({ station: 'S2', quality: 'dust-degraded', status: 'complete' });
  });

  it('can defer S2 panorama with a durable reason and carry on to samples', () => {
    const m = atStation();
    m._weather = dust;
    expect(m.chooseStationAction('defer-panorama')).toBe(true);
    expect(m.currentStation.tasks[0]).toMatchObject({ skipped: true, deferred: true });
    expect(m.scienceResults[0]).toMatchObject({ station: 'S2', status: 'deferred' });
    expect(m.chooseStationAction('task:2')).toBe(true);
    expect(m.samples).toBe(1);
  });

  it('allows short S4 work but blocks the panorama and cumulative cold overrun', () => {
    const m = atStation('S4');
    m._weather = cold;
    expect(m.chooseStationAction('task:1')).toBe(true); // five-minute dosimeter check
    expect(m.chooseStationAction('task:2')).toBe(false); // 20-minute panorama
    expect(m.chooseStationAction('task:0')).toBe(false); // 10 more would exceed the window
    expect(m.met).toBe(300);
    expect(m.currentStation.tasks[2].done).toBe(false);
  });

  it('blocks outdoor work once time walking uses the cold window', () => {
    const m = atStation('S4');
    m._weather = cold;
    m.exitRover();
    m.update(6 * 60, {}, 0);
    expect(m.outsideMinutes).toBe(6);
    expect(m.chooseStationAction('task:1')).toBe(false);
    expect(m.currentStation.tasks[1].done).toBe(false);
    expect(m.stationOptions.some(option => option.id === 'wait')).toBe(false);
  });

  it('enforces late ambient temperature for outdoor tasks', () => {
    const m = atStation('S4');
    m.met = 5 * 3600;
    expect(m.chooseStationAction('task:1')).toBe(false);
    expect(m.currentStation.tasks[1].done).toBe(false);
  });

  it('offers return forecasts and an actionable head-home choice from a station', () => {
    const m = atStation();
    const option = m.stationOptions.find(o => o.id === 'task:2');
    expect(option.workMinutes).toBe(30);
    expect(option.forecast.oxygenLeft).toBeLessThan(480 - 37.5);
    expect(option.forecast).toEqual(expect.objectContaining({ batteryPct: expect.any(Number), daylightMinutes: expect.any(Number) }));
    expect(m.chooseStationAction('home')).toBe(true);
    expect(m.state).toBe('drive');
    expect(m.aborted).toBe(true);
    expect(m.nextStation.id).toBe('HAB');
  });

  it('resets exposure for a later cold event even when the same profile is reused', () => {
    const m = atStation('S4');
    m._weather = cold;
    m._weatherAt = 2000;
    expect(m.chooseStationAction('task:1')).toBe(true);
    expect(m.outsideMinutes).toBe(5);
    m._weatherAt = 3000; // same profile, a new event deadline
    expect(m.outsideMinutes).toBe(0);
    expect(m.chooseStationAction('task:0')).toBe(true);
  });

  it('carries exposure between stations during the same cold spell', () => {
    const m = atStation('S3');
    m.currentStation.tasks = [{ label: 'Short suit check', minutes: 5, result: 'Checked', progress: 0, done: false }];
    m._weather = cold;
    m._weatherAt = 2400;
    expect(m.chooseStationAction('task:0')).toBe(true);
    parkAt(m, 'S4');
    expect(m.outsideMinutes).toBe(5);
    expect(m.chooseStationAction('task:0')).toBe(false);
    expect(m.chooseStationAction('task:1')).toBe(true);
    expect(m.outsideMinutes).toBe(10);
  });

  it('waits in shelter, spends only the waiting budget, then produces a clear panorama', () => {
    const m = atStation();
    m._weather = dust;
    m._weatherAt = 60;
    expect(m.chooseStationAction('wait')).toBe(true);
    expect(m.met).toBe(60);
    expect(m.o2Used).toBe(1);
    expect(m.weather.label).toBe('Clear');
    expect(m.chooseStationAction('wait')).toBe(false);
    expect(m.chooseStationAction('task:0')).toBe(true);
    expect(m.scienceResults[0].quality).toBe('nominal');
  });

  it('blocks battery/daylight breaches even when oxygen alone has reserve', () => {
    const m = atStation();
    m.batteryWh = 100;
    expect(m.stationOptions.find(option => option.id === 'task:0').allowed).toBe(false);
    m.batteryWh = 1600;
    m.met = (18 * 60 - (14 * 60 + 10)) * 60;
    expect(m.stationOptions.find(option => option.id === 'task:0').allowed).toBe(false);
  });

  it('allows final ingress under a dust warning without losing earlier outcomes', () => {
    const m = atStation();
    m._weather = dust;
    m.chooseStationAction('task:0');
    m.chooseStationAction('home');
    parkAt(m, 'HAB');
    m.dustWarning = true;
    const before = m.met;
    expect(m.endEva()).toBe(true);
    expect(m.met - before).toBe(20 * 60);
    expect(m.endEva()).toBe(false);
    expect(m.state).toBe('complete');
    expect(m.scienceResults.some(result => result.quality === 'dust-degraded')).toBe(true);
  });

  it.each(['quick', 'skip', 'home'])('records %s leg omissions without claiming science acquisition', (id) => {
    const m = atStation('S1');
    m.legPending = m.currentStation;
    m.legPending.done = true;
    expect(m.chooseLeg({ id, label: id, allowed: true })).toBe(true);
    const omitted = m.scienceResults.filter(result => result.status === 'skipped');
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every(result => result.result.startsWith('Not performed'))).toBe(true);
  });

  it('records no acquired science if the crew returns before the first station', () => {
    const m = atStation('S1');
    m.state = 'drive';
    m.route.retracesOutbound = true;
    m.s = 10;
    expect(m.returnToHabitat()).toBe(true);
    expect(m.scienceResults.filter(result => result.status === 'complete')).toHaveLength(0);
    expect(m.scienceResults.filter(result => result.status === 'skipped')).toHaveLength(12);
    expect(m.scienceResults.every(result => result.result.startsWith('Not performed'))).toBe(true);
  });
});

it('applies the same cold and reserve limits to nearby finds, charging a successful pickup once', () => {
  const m = atStation('S4');
  const { x, z } = m.rover;
  const find = { name: 'Dust core', stationId: 'S4', minutes: 6, note: 'Bagged', x: x - 2.1, z };
  m.setArtifacts([find]);
  m.exitRover();
  Object.assign(m.walker, { x: find.x, z: find.z });
  m.update(0, {}, 0);
  m._weather = cold;
  m.update(5 * 60, {}, 0);
  expect(m.collect(find)).toBe(false);
  expect(m.samples).toBe(0);
  expect(m.met).toBe(300);
  m._weatherAt = 600; // a new spell restores the exposure window
  m.batteryWh = 100;
  expect(m.collect(find)).toBe(false);
  m.batteryWh = 1600;
  expect(m.collect(find)).toBe(true);
  expect(m.collect(find)).toBe(false);
  expect(m.met).toBe(660);
  expect(m.samples).toBe(1);
  expect(m.scienceResults.filter(result => result.status === 'complete')).toHaveLength(1);
});

it('keeps the same reserve threshold for a station wait and a navigator wait', () => {
  const m = atStation();
  m._weather = dust;
  m._weatherAt = 90;
  m.batteryWh = 100;
  expect(m.stationOptions.find(option => option.id === 'wait').allowed).toBe(false);
  expect(m.waitForWeather()).toBe(false);
  expect(m.met).toBe(0);
});
