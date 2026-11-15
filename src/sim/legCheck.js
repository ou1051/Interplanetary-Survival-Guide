import { LIFE_SUPPORT, ROVER } from '../config/mission.js';
import { consumptionEstimate } from '../physics/traverse.js';
import { ingressMinutes } from './fieldGuidance.js';

// ---------------------------------------------------------------------------
// Leg check: before the crew leaves a station, every way of doing the next leg
// is tested against the conditions they would meet. An option is allowed only
// if it keeps the oxygen reserve, gets the crew home by twilight, keeps work on
// foot above the cold limit, leaves the rover battery a margin, and no dust
// front is coming. "Head home" is always available.
// ---------------------------------------------------------------------------

export const SUNSET = 17 * 60 + 50; // local mean solar time, minutes (Gale, simulated sol)
export const TWILIGHT_LIMIT = SUNSET + 30; // crew must be back at the airlock by then
export const COLD_WORK_LIMIT_C = -40; // no work on foot below this (glove dexterity, suit heaters)
const BATTERY_MARGIN = 0.1; // keep 10 % of the rover battery

// Simulated diurnal air temperature at Gale, shaped like Curiosity REMS records:
// warmest just after midday (about −12 °C), falling fast towards sunset and into the night.
export function temperatureAt(lmstMinutes) {
  const hours = (((lmstMinutes / 60) % 24) + 24) % 24;
  return -50 + 38 * Math.cos((2 * Math.PI * (hours - 13.5)) / 24);
}

// Planning drive time between two points on the route, at the posted speed limits.
export function driveMinutes(route, fromS, toS) {
  let seconds = 0;
  for (let s = Math.max(0, fromS); s < toS; s += route.step) {
    seconds += Math.min(route.step, toS - s) / Math.min(ROVER.maxSpeed, route.speedLimitAt(s));
  }
  return seconds / 60;
}

const workMinutes = (station, quick) => (station ? (quick ? station.tasks.slice(0, 1) : station.tasks) : [])
  .reduce((sum, task) => sum + task.minutes, 0);
const clock = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// What each option would cost, given where the crew stands now.
// `path` (optional): the path picked for the leg to the next station ({ minutes, distance }); it
// replaces that stretch of the current route in every estimate.
function plan(mission, { target, work, label, short, id, detail, next, path }) {
  const { route, s } = mission;
  const now = mission.lmst;
  const firstLeg = next ? (path ? path.minutes : driveMinutes(route, s, next.s)) : 0;
  const fromNext = (to) => (next ? driveMinutes(route, next.s, to) : driveMinutes(route, s, to));
  const legDrive = target ? firstLeg + fromNext(target.s) : 0;
  const homeDrive = target ? driveMinutes(route, target.s, route.length) : firstLeg + fromNext(route.length);
  const drive = legDrive + homeDrive;
  const oxygen = consumptionEstimate((drive) * 60).oxygenMinutes
    + consumptionEstimate((work + ingressMinutes) * 60, { work: true }).oxygenMinutes;
  const distance = route.length - s + (path && next ? path.distance - (next.s - s) : 0);
  const hours = (drive + work + ingressMinutes) / 60;
  const batteryWh = consumptionEstimate(hours * 3600, { moving: distance }).batteryWh;
  const backAt = now + drive + work;
  const workEnd = now + legDrive + work;
  const coldest = work ? temperatureAt(workEnd) : null;

  const o2Left = mission.o2Remaining - oxygen;
  const batteryLeft = mission.batteryWh - batteryWh;
  const checks = [
    {
      id: 'oxygen', label: 'Oxygen',
      ok: o2Left >= LIFE_SUPPORT.reserveMinutes,
      value: `${Math.round(oxygen)} min needed · ${Math.round(Math.max(0, o2Left))} min left after`,
      rule: `Keep ${LIFE_SUPPORT.reserveMinutes} min reserve`,
    },
    {
      id: 'daylight', label: 'Daylight',
      ok: backAt <= TWILIGHT_LIMIT,
      value: `Back at habitat ${clock(backAt)}`,
      rule: `Sunset ${clock(SUNSET)} · home by ${clock(TWILIGHT_LIMIT)}`,
    },
    {
      id: 'cold', label: 'Temperature',
      ok: coldest === null || coldest >= COLD_WORK_LIMIT_C,
      value: coldest === null ? 'No work on foot' : `${Math.round(coldest)} °C when work ends`,
      rule: `No work on foot below ${COLD_WORK_LIMIT_C} °C`,
    },
    {
      id: 'battery', label: 'Rover battery',
      ok: batteryLeft >= ROVER.batteryWh * BATTERY_MARGIN,
      value: `${Math.round((Math.max(0, batteryLeft) / ROVER.batteryWh) * 100)} % left at habitat`,
      rule: `Keep ${Math.round(BATTERY_MARGIN * 100)} %`,
    },
    {
      id: 'dust', label: 'Dust',
      ok: !mission.dustWarning || id === 'home',
      value: mission.dustWarning ? 'Dust front ahead' : 'Clear',
      rule: 'Head home if a dust front is coming',
    },
  ];
  const failed = checks.filter((check) => !check.ok);
  return {
    id, label, short, detail, target, quick: id === 'quick',
    minutes: Math.round(drive + work), legMinutes: Math.round(legDrive + work), backAt: clock(backAt),
    checks, allowed: id === 'home' || failed.length === 0,
    reason: id === 'home' && failed.length ? 'Always allowed: getting home comes first'
      : failed.map((check) => check.label).join(' · '),
  };
}

export function legOptions(mission, path = null) {
  const remaining = mission.route.stations.filter((station) => !station.final && !station.done && !station.skipped
    && station !== mission.currentStation);
  const [next, after] = remaining;
  const options = [];
  if (next) {
    options.push(plan(mission, { id: 'continue', label: `Full stop at ${next.id}`, short: 'Full stop', detail: `All ${next.tasks.length} tasks`, target: next, next, path, work: workMinutes(next) }));
    if (next.tasks.length > 1) options.push(plan(mission, { id: 'quick', label: `Quick stop at ${next.id}`, short: 'Quick stop', detail: next.tasks[0].label, target: next, next, path, work: workMinutes(next, true) }));
    if (after) options.push(plan(mission, { id: 'skip', label: `Skip ${next.id}`, short: `Skip ${next.id}`, detail: `On to ${after.id}`, target: after, next, path, work: workMinutes(after) }));
  }
  options.push(plan(mission, { id: 'home', label: 'Head home now', short: 'Go home', detail: 'No more stops', target: null, next, path, work: 0 }));
  return {
    now: clock(mission.lmst),
    temperature: Math.round(temperatureAt(mission.lmst)),
    next,
    options,
    recommended: options.find((option) => option.allowed && option.id !== 'home') ?? options.at(-1),
  };
}
