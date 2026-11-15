import { describe, expect, it } from 'vitest';
import { Mission } from '../src/sim/mission.js';
import * as weather from '../src/sim/weather.js';

function mission(profile = weather.BLOWING_DUST, heading = 0) {
  const route = {
    sample: (s: number) => ({ x: 100, z: 100 - s, tx: 0, tz: -1 }),
    length: 1000, stops: [], stations: [], zones: [], step: 1, count: 1001,
    x: new Float64Array(1001).fill(100), z: Float64Array.from({ length: 1001 }, (_, i) => 100 - i),
    tx: new Float64Array(1001), tz: new Float64Array(1001).fill(-1),
  };
  const m = new Mission(route, { heightAt: () => 0 }, {}, { surprises: false });
  m.start();
  m._weather = profile;
  m.rover.heading = heading;
  return m;
}

function drive(m: Mission, steer = 0, reverse = false, seconds = 10) {
  for (let t = 0; t < seconds * 20; t++) {
    m.update(0.05, { throttle: !reverse, brake: reverse, steer });
  }
}

describe('dust crosswind steering', () => {
  it('uses gently gusting weather wind while clear and cold have no crosswind', () => {
    const gusts = [0, 2, 4, 6, 8].map(t => weather.windSpeedAt(weather.BLOWING_DUST, t));
    expect(Math.min(...gusts)).toBeGreaterThan(15);
    expect(Math.max(...gusts)).toBeLessThan(30);
    expect(Math.max(...gusts) - Math.min(...gusts)).toBeGreaterThan(1);
    expect(weather.windSpeedAt(weather.CLEAR_WEATHER, 3)).toBe(0);
    expect(weather.windSpeedAt(weather.PASSING_WEATHER[1], 3)).toBe(0);
    expect(weather.windSpeedAt({ label: 'Cold spell', speedLimit: 4.5 }, 3)).toBe(0);
  });

  it.each([weather.PASSING_WEATHER[0], weather.BLOWING_DUST, weather.SHORTCUT_FRONT])('pulls a moving rover downwind during $label and allows a small steering correction', (profile) => {
    const drifting = mission(profile);
    const correcting = mission(profile);
    drive(drifting);
    drive(correcting, -0.1);
    expect(drifting.rover.x - 100).toBeGreaterThan(0.5);
    expect(Math.abs(correcting.rover.x - 100)).toBeLessThan(Math.abs(drifting.rover.x - 100));
    expect(drifting.rover.heading).toBeLessThan(0);
  });

  it('keeps the pull downwind when reversing', () => {
    const m = mission();
    const correcting = mission();
    drive(m, 0, true);
    drive(correcting, -0.1, true);
    expect(m.rover.speed).toBeLessThan(0);
    expect(m.rover.z).toBeGreaterThan(100);
    expect(m.rover.x - 100).toBeGreaterThan(0.5);
    expect(m.rover.heading).toBeGreaterThan(0);
    expect(Math.abs(correcting.rover.x - 100)).toBeLessThan(m.rover.x - 100);
  });

  it.each([weather.CLEAR_WEATHER, weather.PASSING_WEATHER[1]])('drives straight in $label', (profile) => {
    const m = mission(profile);
    drive(m);
    expect(m.rover.x).toBe(100);
    expect(m.rover.heading).toBe(0);
  });

  it('does not deflect a rover aligned with the wind', () => {
    const heading = Math.atan2(-1.4, -0.6);
    const m = mission(weather.BLOWING_DUST, heading);
    drive(m);
    expect(m.rover.heading).toBeCloseTo(heading, 10);
  });

  it('keeps parked and mandatory-stopped rovers in place', () => {
    const m = mission();
    for (let i = 0; i < 200; i++) m.update(0.05, {});
    expect(m.rover).toMatchObject({ x: 100, z: 100, heading: 0, speed: 0 });
    m.dustWarning = true;
    drive(m, 1);
    expect(m.rover).toMatchObject({ x: 100, z: 100, heading: 0, speed: 0 });
  });

  it('stops deflecting once the dust clears', () => {
    const m = mission();
    drive(m);
    m._weather = weather.CLEAR_WEATHER;
    const heading = m.rover.heading;
    drive(m);
    expect(m.rover.heading).toBe(heading);
  });

  it('keeps automatic route following usable during dust', () => {
    const m = mission();
    for (let i = 0; i < 400; i++) m.update(0.05, m.autopilot());
    expect(m.rover.z).toBeLessThan(80);
    expect(Math.abs(m.rover.x - 100)).toBeLessThan(2);
  });

  it('cannot push or rotate a rover through an unclimbable slope', () => {
    const m = mission();
    m.terrain.heightAt = (_x: number, z: number) => Math.max(0, 90 - z);
    drive(m, 0, false, 20);
    expect(m.blocked).toBe(true);
    expect(m.rover.speed).toBe(0);
    expect(m.rover.z).toBeGreaterThan(90);
    const before = { ...m.rover };
    drive(m, 0, false, 5);
    expect(m.rover).toEqual(before);
  });

  it('keeps wind-driven movement inside terrain and outside the habitat', () => {
    const m = mission();
    m.terrain.innerBounds = { x0: 75, x1: 125, z0: -1000, z1: 1000 };
    drive(m, 0, false, 30);
    expect(m.rover.x).toBeLessThanOrEqual(105);
    expect(m.rover.x).toBeGreaterThan(100);
    delete m.terrain.innerBounds;
    Object.assign(m.rover, { x: 15, z: 0, heading: Math.PI / 2, speed: 0 });
    for (let i = 0; i < 200; i++) {
      m.update(0.05, { throttle: true });
      expect(Math.hypot(m.rover.x, m.rover.z)).toBeGreaterThanOrEqual(11.9 - 1e-8);
    }
  });
});
