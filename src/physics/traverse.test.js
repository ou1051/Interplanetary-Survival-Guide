import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentEstimate, consumptionEstimate, evaBudget } from './traverse.js';
import { Mission } from '../sim/mission.js';
import { fieldGuidance } from '../sim/fieldGuidance.js';
import { predict, defaultSuit } from '../sim/suit.js';
import { ROVER, SLOPE_CLASSES, LIFE_SUPPORT } from '../config/mission.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const { egressMinutes, ingressMinutes, workFactor, reserveMinutes, evaHours } = LIFE_SUPPORT;

test('evaBudget charges egress, driving, work and ingress against the suit capacity', () => {
  const budget = evaBudget({ driveSeconds: 600, workMinutes: 40 });
  close(budget.egress, egressMinutes * workFactor);
  close(budget.drive, 10);
  close(budget.work, 40 * workFactor);
  close(budget.ingress, ingressMinutes * workFactor);
  close(budget.required, budget.egress + budget.drive + budget.work + budget.ingress);
  close(budget.remaining, evaHours * 60 - budget.required);
  assert.equal(budget.reserve, reserveMinutes);
  assert.equal(budget.belowReserve, false);
  assert.equal(budget.insufficient, false);

  const outside = evaBudget({ driveSeconds: 600, egress: false, usedMinutes: 100 });
  assert.equal(outside.egress, 0);
  close(outside.remaining, evaHours * 60 - 100 - 10 - ingressMinutes * workFactor);

  const heavy = evaBudget({ driveSeconds: 600, workMinutes: 40, rateFactor: 1.2 });
  close(heavy.required, budget.required * 1.2);

  const tight = evaBudget({ usedMinutes: evaHours * 60 - reserveMinutes });
  assert.equal(tight.belowReserve, true);
  assert.equal(tight.insufficient, true);
});

test('the live traverse charges egress when it starts, as the planning budget does', () => {
  const mission = new Mission({ length: 0, stops: [], stations: [] }, {}, {});
  mission.start();
  close(mission.o2Used, evaBudget().egress);
  assert.equal(mission.met, egressMinutes * 60);
  assert.equal(mission.state, 'drive');
});

test('field guidance budgets the return from the oxygen actually used, with ingress still ahead', () => {
  const route = {
    length: 1000, retracesOutbound: true, stops: [], zones: [],
    sample: () => ({ tx: 0, tz: -1 }),
    stations: [
      { id: 'S1', done: false, tasks: [{ minutes: 30, done: false }, { minutes: 10, done: true }] },
      { id: 'HAB', final: true, done: false, tasks: [{ minutes: ingressMinutes, done: false }] },
    ],
  };
  const mission = new Mission(route, {}, {});
  mission.start();
  mission.s = 250;
  mission._consume(600);
  const guidance = fieldGuidance(mission);
  const metresToSeconds = (m) => m / ROVER.dangerSlopeSpeed;
  close(guidance.returnOxygen, evaHours * 60 - mission.o2Used - metresToSeconds(250) / 60 - ingressMinutes * workFactor);
  assert.equal(guidance.advice, 'Continue');

  // The planned loop (750 m + 30 min of unfinished work) must leave the reserve; burn oxygen until it can't.
  const planned = evaBudget({ driveSeconds: metresToSeconds(750), workMinutes: 30, egress: false, usedMinutes: mission.o2Used });
  mission._consume((planned.remaining - reserveMinutes + 1) * 60);
  assert.equal(fieldGuidance(mission).advice, 'Return to habitat');
});

test('the suit planner uses the same budget, scaled by suit mass', () => {
  const route = { oxygen_cost: 2, battery_drain: 10, hazard_warnings: [] };
  const plain = predict(route, { insulation: 0, shielding: 0, abrasion: 0 }, 60);
  const budget = evaBudget({ driveSeconds: 120, workMinutes: 60 });
  close(plain.o2.used, budget.required);
  close(plain.o2.left, budget.remaining);
  const suited = predict(route, defaultSuit(), 60);
  assert.ok(suited.o2.used > plain.o2.used);
});

test('flat traverse has a numeric time, oxygen and battery estimate', () => {
  const result = segmentEstimate(270, 0);
  assert.deepEqual(Object.keys(result).sort(), ['batteryWh', 'distanceM', 'durationSeconds', 'oxygenMinutes', 'slopeDeg']);
  assert.equal(result.distanceM, 270);
  assert.equal(result.durationSeconds, 60);
  assert.equal(result.oxygenMinutes, 1);
  close(result.batteryWh, 24.3 + 110 / 60);
  assert.equal(result.slopeDeg, 0);
});

test('ascent and descent share surface distance and slope speed, but downhill has no regeneration', () => {
  const up = segmentEstimate(100, 100);
  const down = segmentEstimate(100, -100);
  close(up.distanceM, Math.sqrt(20000));
  assert.equal(up.slopeDeg, 45);
  assert.equal(down.slopeDeg, 45);
  close(up.durationSeconds, up.distanceM / ROVER.dangerSlopeSpeed);
  assert.equal(down.durationSeconds, up.durationSeconds);
  assert.equal(down.oxygenMinutes, up.oxygenMinutes);
  close(up.batteryWh, 110 * up.durationSeconds / 3600 + up.distanceM * 0.09 * (1 + 9 / Math.sqrt(2)));
  close(down.batteryWh, 110 * down.durationSeconds / 3600 + down.distanceM * 0.09);
  assert.ok(up.batteryWh > down.batteryWh);
});

test('speed switches inclusively at both shared slope thresholds for either direction', () => {
  for (const sign of [-1, 1]) {
    for (const [degrees, speed] of [
      [SLOPE_CLASSES.caution - 0.001, ROVER.maxSpeed],
      [SLOPE_CLASSES.caution, ROVER.cautionSpeed],
      [SLOPE_CLASSES.danger - 0.001, ROVER.cautionSpeed],
      [SLOPE_CLASSES.danger, ROVER.dangerSlopeSpeed],
      [SLOPE_CLASSES.danger + 0.001, ROVER.dangerSlopeSpeed],
    ]) {
      const radians = degrees * Math.PI / 180;
      const result = segmentEstimate(Math.cos(radians) * 100, sign * Math.sin(radians) * 100);
      close(result.durationSeconds, 100 / speed);
    }
  }
});

test('time and consumables add over split segments and equal the rover simulation', () => {
  const whole = segmentEstimate(80, 20);
  const half = segmentEstimate(40, 10);
  for (const key of ['distanceM', 'durationSeconds', 'oxygenMinutes', 'batteryWh']) close(whole[key], half[key] * 2);
  const mission = new Mission({ stops: [], stations: [] }, {}, {});
  const pitch = Math.atan2(10, 40);
  mission._consume(half.durationSeconds, { moving: half.distanceM, pitch });
  mission._consume(half.durationSeconds, { moving: half.distanceM, pitch });
  close(mission.met, whole.durationSeconds);
  close(mission.o2Used, whole.oxygenMinutes);
  close(ROVER.batteryWh - mission.batteryWh, whole.batteryWh);
});

test('live consumption retains idle time, working oxygen, radiation and depleted battery clamp', () => {
  const mission = new Mission({ stops: [], stations: [] }, {}, {});
  mission.state = 'stationDone';
  mission.update(60, {}, 0);
  mission._consume(120, { work: true });
  close(mission.o2Used, 1 + 2 * 1.25);
  close(mission.batteryWh, ROVER.batteryWh - 110 * 180 / 3600);
  close(mission.dose, LIFE_SUPPORT.doseRateUsvH * 180 / 3600);
  assert.equal(mission.met, 180);
  mission._consume(1, { moving: 100000, pitch: Math.PI / 4 });
  assert.equal(mission.batteryWh, 0);
  assert.deepEqual(consumptionEstimate(0), { oxygenMinutes: 0, batteryWh: 0 });
  assert.deepEqual(segmentEstimate(0, 0), { distanceM: 0, durationSeconds: 0, oxygenMinutes: 0, batteryWh: 0, slopeDeg: 0 });
});
