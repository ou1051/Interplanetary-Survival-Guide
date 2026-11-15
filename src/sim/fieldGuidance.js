import { LIFE_SUPPORT, ROVER } from '../config/mission.js';
import { consumptionEstimate } from '../physics/traverse.js';
import { CLEAR_WEATHER } from './weather.js';

export const ingressMinutes = 20;
export const SUNSET = 17 * 60 + 50;
export const TWILIGHT_LIMIT = SUNSET + 30;
export const COLD_WORK_LIMIT_C = -40;
export const clock = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export function temperatureAt(lmstMinutes) {
  const hours = (((lmstMinutes / 60) % 24) + 24) % 24;
  return -50 + 38 * Math.cos((2 * Math.PI * (hours - 13.5)) / 24);
}

export function forecastWeather(mission, s, elapsedSeconds, route = mission.route) {
  if (mission.weatherAt) return mission.weatherAt(s, (mission.met ?? 0) + elapsedSeconds + 1e-7, route);
  return elapsedSeconds + 1e-7 < (mission.weatherRemainingSeconds ?? 0) ? mission.weather : CLEAR_WEATHER;
}

// shortcut: constant governed speed omits acceleration and gate pauses; add dynamics when sub-minute ETA accuracy is needed.
// Known weather only; future random events are not predicted.
export function forecastReturn(mission, { workMinutes = 0, waitSeconds = 0, fromS = mission.s,
  route = mission.route, workAtS = fromS, toS = route.length, includeIngress = true,
  workStops = [{ s: workAtS, minutes: workMinutes }] } = {}) {
  let elapsed = waitSeconds;
  let oxygenUsed = consumptionEstimate(waitSeconds).oxygenMinutes;
  let batteryWhUsed = consumptionEstimate(waitSeconds).batteryWh;
  let driveSeconds = 0;
  let workStartMinutes = waitSeconds / 60;
  const endS = Math.max(fromS, toS);
  const stops = [...workStops, { s: endS, minutes: 0 }];
  const deadlines = [mission.weatherRemainingSeconds ?? 0, (mission.frontUntilMet ?? 0) - (mission.met ?? 0)];
  const front = route.weatherExposure;
  for (const [leg, stop] of stops.entries()) {
    const destination = Math.max(fromS, Math.min(endS, stop.s));
    for (let s = fromS; s < destination;) {
      const weather = forecastWeather(mission, s + 1e-7, elapsed, route);
      const cap = Math.min(ROVER.maxSpeed, route.speedLimitAt(s + 3), weather.speedLimit);
      // A mandatory front ends at its known deadline; do not divide by a zero driving cap.
      if (cap <= 0) {
        const remaining = Math.max(0, (mission.frontUntilMet ?? 0) - (mission.met ?? 0) - elapsed)
          || Math.max(0, (mission.weatherRemainingSeconds ?? 0) - elapsed);
        if (!remaining) { elapsed = Infinity; oxygenUsed = Infinity; batteryWhUsed = Infinity; break; }
        const rest = consumptionEstimate(remaining);
        elapsed += remaining; oxygenUsed += rest.oxygenMinutes; batteryWhUsed += rest.batteryWh;
        continue;
      }
      let distance = Math.min(route.step || 1, destination - s);
      for (const deadline of deadlines) {
        const remaining = deadline - elapsed;
        if (remaining > 1e-7) distance = Math.min(distance, remaining * cap);
      }
      if (front) for (const boundary of [front.from, front.to]) {
        if (boundary > s + 1e-7) distance = Math.min(distance, boundary - s);
      }
      const seconds = distance / cap;
      const pitch = (route.pitch?.[Math.min(route.pitch.length - 1, Math.round(s / route.step))] ?? 0) * Math.PI / 180;
      const used = consumptionEstimate(seconds, { moving: distance, pitch });
      elapsed += seconds; driveSeconds += seconds;
      oxygenUsed += used.oxygenMinutes; batteryWhUsed += used.batteryWh;
      s += distance;
    }
    fromS = destination;
    if (leg === 0) workStartMinutes = elapsed / 60;
    const used = consumptionEstimate(stop.minutes * 60, { work: true });
    elapsed += stop.minutes * 60;
    oxygenUsed += used.oxygenMinutes; batteryWhUsed += used.batteryWh;
  }
  const finalStation = route.stations.find(station => station.final);
  const ingressTime = includeIngress ? (finalStation
    ? finalStation.tasks.reduce((sum, task) => sum + (task.done || task.skipped ? 0 : task.minutes), 0)
    : ingressMinutes) : 0;
  const ingress = consumptionEstimate(ingressTime * 60, { work: true });
  elapsed += ingressTime * 60;
  oxygenUsed += ingress.oxygenMinutes; batteryWhUsed += ingress.batteryWh;
  const oxygenLeft = mission.o2Remaining - oxygenUsed;
  const backAtMinutes = mission.lmst + elapsed / 60;
  return {
    oxygenLeft, batteryPct: Math.max(0, mission.batteryWh - batteryWhUsed) / ROVER.batteryWh * 100,
    backAt: Number.isFinite(backAtMinutes) ? clock(backAtMinutes) : '—', backAtMinutes,
    daylightMinutes: SUNSET - backAtMinutes, reserveOK: oxygenLeft >= LIFE_SUPPORT.reserveMinutes,
    driveMinutes: driveSeconds / 60, totalMinutes: elapsed / 60, workStartMinutes, oxygenUsed, batteryWhUsed,
  };
}

export function fieldGuidance(mission) {
  const { route, s, nextKnownStop: nextStop, state } = mission;
  const turn = route.length / 2;
  const retraces = route.retracesOutbound !== false;
  const outbound = retraces && s < turn && !mission.aborted;
  const homeDistance = outbound ? s : route.length - s;
  const returnForecast = forecastReturn(mission, { fromS: outbound ? route.length - s : s });
  const returnOxygen = returnForecast.oxygenLeft;
  const workStops = route.stations.filter(stop => !stop.final && !stop.done && !stop.skipped && stop.s >= s)
    .map(stop => ({ s: stop.s, minutes: stop.tasks.reduce((sum, task) => sum + (task.done || task.skipped ? 0 : task.minutes), 0) }));
  const plannedForecast = forecastReturn(mission, { workStops });
  const plannedReturnOxygen = plannedForecast.oxygenLeft;
  const zone = route.zones.find(hazard => !hazard.acknowledged && hazard.s1 >= s && hazard.s0 - s <= 55);
  const front = mission.activeFront;
  const dust = mission.dustWarning;
  const surprise = nextStop?.ref.surprise && (nextStop.ref.detected || state === 'gate') ? nextStop.ref : null;
  const canReturn = ['drive', 'gate'].includes(state) && outbound && s > 1;
  const reachedBase = state === 'complete' || (!outbound && nextStop?.ref.final && state !== 'drive' && state !== 'gate');
  const belowReserve = plannedReturnOxygen < LIFE_SUPPORT.reserveMinutes;
  const late = plannedForecast.backAtMinutes > TWILIGHT_LIMIT;
  const lowBattery = plannedForecast.batteryPct < 10;
  let advice = 'Continue', reason = 'Planned return preserves your oxygen reserve.';
  if (reachedBase) { advice = 'At habitat'; reason = 'The traverse is complete or ready for ingress.'; }
  else if (returnOxygen < 0) { advice = 'Emergency'; reason = 'Estimated oxygen is insufficient for the return and ingress.'; }
  else if (dust || belowReserve || late || lowBattery) {
    advice = outbound ? 'Return to habitat' : retraces ? 'Proceed to habitat' : belowReserve ? 'Oxygen caution' : 'Return caution';
    reason = dust ? 'Simulated dust front ahead. Turn back along your outbound track.'
      : belowReserve ? 'Finishing all remaining science would use your oxygen reserve.'
        : late ? 'Finishing all remaining science would put you back at HAB after twilight.' : 'Finishing all remaining science would use the rover battery margin.';
    if (!outbound && dust) reason = 'Follow the route back to the airlock.';
  } else if (surprise) { advice = 'Caution'; reason = `${surprise.type.toLowerCase()}. Complete the on-site recovery before continuing.`; }
  else if (zone) { advice = 'Caution'; reason = `${zone.type.toLowerCase()} ahead. Follow the marked speed limit.`; }
  else if (mission.weather.label !== 'Clear') {
    advice = Number.isFinite(mission.weather.exposureMinutes) ? 'Cold caution' : 'Reduced visibility';
    reason = Number.isFinite(mission.weather.exposureMinutes)
      ? `${mission.weather.label}. Keep outdoor work within the ${mission.weather.exposureMinutes}-minute exposure window.`
      : `${mission.weather.label}. Follow the marked route at the reduced speed limit.`;
  }
  else if (!outbound && (retraces || nextStop?.ref.final)) { advice = 'Proceed to habitat'; reason = 'Follow the return leg to the airlock.'; }
  const returning = advice === 'Return to habitat';
  const guideS = returning ? route.length - s : s;
  const heading = route.sample(Math.min(guideS + 2, route.length));
  const degrees = (Math.round(Math.atan2(heading.tx, -heading.tz) * 180 / Math.PI) + 360) % 360;
  const direction = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8];
  return {
    advice, reason, canReturn, degrees, direction, returnOxygen, returnForecast, plannedForecast,
    next: returning ? 'Habitat' : nextStop?.kind === 'gate' ? 'Hazard gate' : nextStop?.ref.name ?? 'Habitat',
    distance: Math.max(0, Math.round(returning ? homeDistance : (nextStop?.s ?? route.length) - s)),
    hazard: surprise?.type.toLowerCase() ?? (dust || (front && front.to >= s) ? 'Dust front · simulated' : zone?.type.toLowerCase() ?? 'None reported ahead'),
  };
}
