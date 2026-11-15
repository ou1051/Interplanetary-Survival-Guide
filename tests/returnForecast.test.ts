import { describe, expect, it } from 'vitest';
import { forecastReturn, fieldGuidance } from '../src/sim/fieldGuidance.js';
import { legOptions } from '../src/sim/legCheck.js';
import { ROVER } from '../src/config/mission.js';
import { Mission } from '../src/sim/mission.js';
import { Route } from '../src/world/route.js';

function fixture(length = 2700) {
  return {
    s: 0, lmst: 14 * 60, o2Remaining: 480, batteryWh: 1600,
    weather: { label: 'Clear', speedLimit: 4.5, temperatureOffsetC: 0, exposureMinutes: Infinity },
    weatherRemainingSeconds: 0, state: 'drive',
    route: { length, step: 1, stations: [], zones: [], retracesOutbound: false,
      speedLimitAt: () => 4.5, sample: () => ({ tx: 0, tz: -1 }) },
  };
}

describe('remaining return forecast', () => {
  it('counts waiting at rest separately from working and movement', () => {
    const m = fixture();
    const base = forecastReturn(m);
    const wait = forecastReturn(m, { waitSeconds: 600 });
    const work = forecastReturn(m, { workMinutes: 10 });
    expect(base.oxygenLeft).toBeCloseTo(445); // 10 drive + 25 ingress
    expect(base.backAt).toBe('14:30');
    expect(wait.oxygenLeft).toBeCloseTo(435);
    expect(work.oxygenLeft).toBeCloseTo(432.5);
    expect(wait.batteryPct).toBeCloseTo(work.batteryPct);
    expect(base.batteryPct).toBeCloseTo((1600 - 55 - 243) / 16);
    expect(wait.backAt).toBe('14:40');
  });

  it('clears current dust part way along the route instead of extending it forever', () => {
    const m = fixture(450);
    m.weather = { ...m.weather, label: 'Blowing dust', speedLimit: 1.5 };
    m.weatherRemainingSeconds = 60;
    const forecast = forecastReturn(m);
    expect(forecast.driveMinutes).toBeCloseTo(140 / 60); // 90 m dusty, 360 m clear
    const waited = forecastReturn(m, { waitSeconds: 60 });
    expect(waited.driveMinutes).toBeCloseTo(100 / 60);
    expect(waited.oxygenLeft).toBeLessThan(forecast.oxygenLeft);
  });

  it('uses terrain caps and uphill movement battery use', () => {
    const m = fixture(60);
    m.route.speedLimitAt = () => 1;
    Object.assign(m.route, { pitch: new Float32Array(61).fill(30) });
    const f = forecastReturn(m);
    expect(f.driveMinutes).toBeCloseTo(1);
    expect(f.batteryPct).toBeCloseTo((1600 - 38.5 - 29.7) / 16);
  });

  it('includes ingress in sunset and exactly 30-minute oxygen reserve thresholds', () => {
    const m = fixture(0);
    m.lmst = 17 * 60 + 40;
    m.o2Remaining = 55;
    expect(forecastReturn(m)).toMatchObject({ oxygenLeft: 30, reserveOK: true, daylightMinutes: -10, backAt: '18:00' });
    m.o2Remaining -= 0.01;
    expect(forecastReturn(m).reserveOK).toBe(false);
  });

  it('does not count done or skipped tasks in leg checks or field advice', () => {
    const m = fixture(0);
    const station = { id: 'S1', name: 'Station', s: 0, tasks: [
      { label: 'done', minutes: 400, done: true }, { label: 'skipped', minutes: 400, skipped: true },
      { label: 'reading', minutes: 5 },
    ] };
    m.route.stations = [station] as never;
    m.o2Remaining = 70;
    expect(legOptions(m).options[0].allowed).toBe(true);
    expect(fieldGuidance(m).advice).toBe('Continue');
  });

  it('allows a five-minute reading but blocks sustained work in active cold', () => {
    const m = fixture(0);
    m.weather = { ...m.weather, label: 'Cold snap', temperatureOffsetC: -35, exposureMinutes: 10 };
    m.weatherRemainingSeconds = 3600;
    m.route.stations = [{ id: 'S1', name: 'Station', s: 0,
      tasks: [{ label: 'reading', minutes: 5 }, { label: 'sample', minutes: 20 }] }] as never;
    const options = legOptions(m).options;
    expect(options.find(o => o.id === 'continue')?.checks.find(c => c.id === 'cold')?.ok).toBe(false);
    expect(options.find(o => o.id === 'quick')?.checks.find(c => c.id === 'cold')?.ok).toBe(true);
    Object.assign(m, { outsideMinutes: 8 });
    const nextQuick = legOptions(m).options.find(o => o.id === 'quick');
    expect(nextQuick?.checks.find(c => c.id === 'cold')?.ok).toBe(false);
  });

  it('matches live consumption on a clear flat return within the acceleration and arrival allowance', () => {
    const terrain = { heightAt: () => 0 };
    const route = new Route(terrain, { points: [[0, -40], [450, -40]], exact: true, stations: [], areaHazards: [] });
    route.retracesOutbound = false;
    const m = new Mission(route, terrain, {}, { surprises: false });
    m.start();
    m.speed = ROVER.maxSpeed;
    const forecast = forecastReturn(m);
    const input = { throttle: true, brake: false, steer: 0, action: false, boost: false };
    for (let i = 0; i < 15000 && m.s < route.length; i++) m.update(0.01, input, 0);
    m._consume(1200, { work: true });
    expect(Math.abs(forecast.oxygenLeft - m.o2Remaining)).toBeLessThan(0.1);
    expect(Math.abs(forecast.batteryPct - m.batteryPct)).toBeLessThan(0.02);
    expect(Math.abs(forecast.backAtMinutes - m.lmst)).toBeLessThan(0.1);
  });

  it('forecasts a spatial front only inside its range and known lifetime', () => {
    const m = fixture(450);
    Object.assign(m, { met: 0, frontUntilMet: 60, weatherAt: (s: number, met: number) => ({
      ...m.weather, speedLimit: s >= 90 && s < 180 && met < 60 ? 1.5 : 4.5,
    }) });
    expect(forecastReturn(m).driveMinutes).toBeCloseTo(126.6667 / 60, 1);
    // Waiting clears the front before departure, but costs extra oxygen at rest.
    expect(forecastReturn(m, { waitSeconds: 60 }).driveMinutes).toBeCloseTo(100 / 60);
  });

  it('uses arrival weather for cold work, including weather that clears during the approach', () => {
    const m = fixture(450);
    m.weather = { ...m.weather, label: 'Cold snap', temperatureOffsetC: -35, exposureMinutes: 10 };
    m.weatherRemainingSeconds = 30;
    m.route.stations = [{ id: 'S1', name: 'Station', s: 450, tasks: [{ label: 'sample', minutes: 20 }] }] as never;
    expect(legOptions(m).options[0].checks.find(c => c.id === 'cold')?.ok).toBe(true);
  });


  it('uses the Mission spatial forecast when starting in clear weather before the front', () => {
    const route = { ...fixture(450).route, stops: [], zonesAt: () => [], weatherExposure: { from: 90, to: 180 } };
    const m = new Mission(route, {}, {}, { surprises: false, frontSeconds: 61 });
    expect(m.weather.label).toBe('Clear');
    // 20 s clear + 41 s at 0.65 m/s + remaining 333.35 m at 4.5 m/s.
    expect(forecastReturn(m).driveMinutes).toBeCloseTo((61 + 333.35 / 4.5) / 60, 5);
    const waited = forecastReturn(m, { waitSeconds: 61 });
    expect(waited.driveMinutes).toBeCloseTo(100 / 60, 5);
  });


  it('allows exact reserve, battery and twilight margins then rejects a later return', () => {
    const m = fixture(0);
    m.lmst = 17 * 60 + 55;
    m.o2Remaining = 61.25;
    m.batteryWh = 160 + 25 * 110 / 60;
    m.route.stations = [{ id: 'S1', name: 'Station', s: 0, tasks: [{ label: 'reading', minutes: 5 }] }] as never;
    expect(legOptions(m).options[0].allowed).toBe(true);
    m.lmst += 0.01;
    expect(legOptions(m).options[0].checks.find(c => c.id === 'daylight')?.ok).toBe(false);
    m.lmst -= 0.01;
    m.batteryWh -= 0.01;
    expect(legOptions(m).options[0].checks.find(c => c.id === 'battery')?.ok).toBe(false);
  });

});
