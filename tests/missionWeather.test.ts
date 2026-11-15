import { describe, expect, it } from 'vitest';
import { Mission } from '../src/sim/mission.js';
import { legOptions } from '../src/sim/legCheck.js';
import { buildDeltaTraverse } from '../src/data/deltaTraverse.js';

const parked = { throttle: false, brake: false, steer: 0, boost: false, action: false };
const driving = { ...parked, throttle: true, brake: false };
function mission(random = () => 0, variableWeather = true) {
  const route = {
    sample: () => ({ x: 50, z: 0, tx: 0, tz: -1 }), length: 100000, stops: [], stations: [], zones: [], step: 1,
    speedLimitAt: () => 4.5, zonesAt: () => [],
  };
  return new Mission(route, { heightAt: () => 0 }, { x: 0, y: 10, z: 0 }, { random, variableWeather });
}

describe('variable mission weather', () => {
  it.each([[0, 'Dust gust'], [0.9, 'Blowing dust']])('starts an unpredictable %s event while parked and then clears', (kind, label) => {
    let draws = 0;
    const m = mission(() => draws++ === 1 ? kind : 0);
    expect(m.weather.label).toBe('Clear');
    expect(m.weather).toBe(m.weather);
    m.update(30, parked, 0); // briefing does not advance the simulation
    expect(m.met).toBe(0);
    m.start();
    m.update(14, parked, 0);
    expect(m.weather.label).toBe('Clear');
    m.update(1, parked, 0);
    expect(m.weather.label).toBe(label);
    expect(m.weather.speedLimit).toBeLessThan(4.5);
    expect(Math.exp(-Math.pow(m.weather.fogDensity * m.weather.visibilityM, 2))).toBeCloseTo(0.05);
    m.update(m.weatherRemainingSeconds, parked, 0);
    expect(m.weather.label).toBe('Clear');
    m.update(46, parked, 0);
    expect(m.weather.label).not.toBe('Clear');
    m.state = 'complete';
    const time = m.met;
    m.update(100, parked, 0);
    expect(m.met).toBe(time);
  });

  it.each([[0, 'Dust gust'], [0.9, 'Blowing dust']])('caps movement and recovers after %s weather', (kind, label) => {
    let draws = 0;
    const m = mission(() => draws++ === 1 ? kind : 0);
    m.start();
    m.update(5, { ...parked, boost: true }, 0);
    expect(m.weather.label).toBe(label);
    for (let i = 0; i < 50; i++) m.update(0.1, driving, 0);
    expect(m.speed).toBeGreaterThan(0);
    expect(m.speed).toBeLessThanOrEqual(m.weather.speedLimit);
    expect(m.limitReason).toBe(label);
    m.update(m.weatherRemainingSeconds, parked, 0);
    for (let i = 0; i < 100; i++) m.update(0.1, driving, 0);
    expect(m.weather.label).toBe('Clear');
    expect(m.speed).toBeGreaterThan(3);
  });

  it('distinguishes a brief gust from persistent dust and cold spells', () => {
    const durations = [];
    for (const roll of [0, 0.5, 0.9]) {
      const m = mission(() => roll);
      m.start();
      m.update(35, parked, 0);
      durations.push(m.weatherRemainingSeconds);
      if (roll === 0.5) {
        expect(m.weather).toMatchObject({ label: 'Cold spell', limitsVisibility: false, exposureMinutes: 10 });
        expect(m.weather.temperatureOffsetC).toBeLessThan(0);
      }
      const before = m.met;
      const cost = m.waitSeconds;
      expect(m.waitForWeather()).toBe(true);
      expect(m.met - before).toBeCloseTo(cost);
      expect(m.weather.label).toBe('Clear');
      expect(m.waitForWeather()).toBe(false);
    }
    expect(durations[0]).toBeLessThan(60);
    expect(durations[1]).toBeGreaterThan(10 * 60);
    expect(durations[2]).toBeGreaterThan(10 * 60);
  });

  it('follows the same weather timeline during long station work and short driving updates', () => {
    const m = mission();
    const drivingMission = mission();
    const messages: string[] = [];
    m.on((type, p) => { if (type === 'log') messages.push(p.text); });
    m.start();
    drivingMission.start();
    m.exitRover();
    m.update(15, parked, 0);
    expect(m.weather.label).toBe('Dust gust');
    const before = messages.length;
    m._consume(3600, { work: true });
    for (let t = 0; t < m.met; t++) drivingMission.update(1, parked, 0);
    expect(m.weather).toBe(drivingMission.weather);
    expect(m._weatherAt).toBe(drivingMission._weatherAt);
    expect(messages.length - before).toBe(1);
  });

  it('keeps variable weather opt-in and exposes the scripted mandatory-return front', () => {
    const m = mission(() => 0, false);
    m.start();
    m.update(100, parked, 0);
    expect(m.weather.label).toBe('Clear');
    m.dustWarning = true;
    expect(m.weather.label).toBe('Dust front');
    expect(m.weather.fogDensity).toBeGreaterThan(0.00042);
    m.update(1, driving, 0);
    expect(m.speed).toBe(0);
  });

  it('leaves passing weather drivable on the delta loop and keeps science choices available', () => {
    const { terrain, route } = buildDeltaTraverse();
    const m = new Mission(route, terrain, {}, { random: () => 0, variableWeather: true, surprises: false });
    m.start();
    m.update(15, parked, 0);
    expect(m.weather.label).toBe('Dust gust');
    const checks = legOptions(m).options.flatMap(option => option.checks).filter(check => check.id === 'dust');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every(check => check.ok && check.value === 'Dust gust')).toBe(true);
    const before = { ...m.rover };
    for (let i = 0; i < 30; i++) m.update(0.1, m.autopilot(), 0);
    expect(Math.hypot(m.rover.x - before.x, m.rover.z - before.z)).toBeGreaterThan(1);
    const site = m.stations[0];
    Object.assign(m.rover, { x: site.x, z: site.z, speed: 0 });
    m.update(0, {}, 0);
    expect(m.stationOptions.some(option => option.allowed && option.id.startsWith('task:'))).toBe(true);
    expect(m.chooseStationAction('home')).toBe(true);
    Object.assign(m.rover, { x: 0, z: -15 });
    m.update(0, {}, 0);
    expect(m.endEva()).toBe(true);
    expect(m.state).toBe('complete');
  });
});
