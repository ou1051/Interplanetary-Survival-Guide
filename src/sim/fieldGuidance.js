import { LIFE_SUPPORT, ROVER, HAB } from '../config/mission.js';
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

export function temperatureAt(lmstMinutes, offsetC = 0) {
  const hours = (((lmstMinutes / 60) % 24) + 24) % 24;
  return -50 + 38 * Math.cos((2 * Math.PI * (hours - 13.5)) / 24) + offsetC;
}

export function forecastWeather(mission, s, elapsedSeconds, route = mission.route, position = route.sample?.(s)) {
  if (mission.weatherAt) return mission.weatherAt(s, (mission.met ?? 0) + elapsedSeconds + 1e-7, route, position);
  return elapsedSeconds + 1e-7 < (mission.weatherRemainingSeconds ?? 0) ? mission.weather : CLEAR_WEATHER;
}

// shortcut: governed speeds omit acceleration, unmapped obstacles and gate pauses; add dynamics when sub-minute ETA accuracy is needed.
// Known weather only; future random events are not predicted.
export function forecastReturn(mission, { workMinutes = 0, waitSeconds = 0, fromS = mission.s,
  route = mission.route, workAtS = fromS, toS = route.length, includeIngress = true, homeOnly = false,
  workStops = [{ s: workAtS, minutes: workMinutes }] } = {}) {
  let elapsed = waitSeconds;
  let oxygenUsed = consumptionEstimate(waitSeconds).oxygenMinutes;
  let batteryWhUsed = consumptionEstimate(waitSeconds).batteryWh;
  let driveSeconds = 0;
  let walkingSeconds = 0;
  let workStartMinutes = waitSeconds / 60;
  const deadlines = [mission.weatherRemainingSeconds ?? 0, (mission.frontUntilMet ?? 0) - (mission.met ?? 0)];
  const front = route.weatherExposure;
  const walking = mission.onFoot || mission.state === 'walk';
  const rover = walking ? mission.rover : mission.pos;
  if (walking && rover && route.nearestS) fromS = route.nearestS(rover.x, rover.z);

  // The same accounting covers the selected route, its off-route approach, and a free-roam return.
  function travel(start, end, path = route, onFoot = false) {
    const direction = end >= start ? 1 : -1;
    for (let s = start; direction * (end - s) > 1e-7;) {
      const position = path.sample?.(s);
      const weather = forecastWeather(mission, s + direction * 1e-7, elapsed, route, position);
      const cap = Math.min(onFoot ? LIFE_SUPPORT.walkSpeedKmh / 3.6 : ROVER.maxSpeed,
        path.speedLimitAt(s + direction * 3), weather.speedLimit);
      if (cap <= 0) {
        const remaining = Math.max(0, (mission.frontUntilMet ?? 0) - (mission.met ?? 0) - elapsed)
          || Math.max(0, (mission.weatherRemainingSeconds ?? 0) - elapsed);
        if (!remaining) { elapsed = Infinity; oxygenUsed = Infinity; batteryWhUsed = Infinity; break; }
        const rest = consumptionEstimate(remaining, { work: onFoot });
        elapsed += remaining; oxygenUsed += rest.oxygenMinutes; batteryWhUsed += rest.batteryWh;
        continue;
      }
      let distance = Math.min(path.step || 1, Math.abs(end - s));
      for (const deadline of deadlines) {
        const remaining = deadline - elapsed;
        if (remaining > 1e-7) distance = Math.min(distance, remaining * cap);
      }
      if (path === route && front) for (const boundary of [front.from, front.to]) {
        if (direction * (boundary - s) > 1e-7) distance = Math.min(distance, Math.abs(boundary - s));
      }
      const seconds = distance / cap;
      const pitch = path.pitchAt ? path.pitchAt(s)
        : (path.pitch?.[Math.min(path.pitch.length - 1, Math.round(s / path.step))] ?? 0) * Math.PI / 180 * direction;
      const used = consumptionEstimate(seconds, { work: onFoot, moving: onFoot ? 0 : distance, pitch });
      elapsed += seconds; driveSeconds += seconds;
      if (onFoot) walkingSeconds += seconds;
      oxygenUsed += used.oxygenMinutes; batteryWhUsed += used.batteryWh;
      s += direction * distance;
    }
  }

  // Off-route ground has no planned line: keep upstream's 30% detour allowance and conservative speed.
  function crossGround(from, to, onFoot = false) {
    const length = Math.hypot(to.x - from.x, to.z - from.z) * 1.3;
    const heading = Math.atan2(-(to.x - from.x), -(to.z - from.z));
    const sample = s => ({ x: from.x + (to.x - from.x) * s / length, z: from.z + (to.z - from.z) * s / length });
    const ground = s => mission.terrain?.heightAt ? mission._ground(sample(s).x, sample(s).z, heading) : null;
    travel(0, length, {
      step: 1, sample,
      speedLimitAt: s => Math.min(ROVER.dangerSlopeSpeed, ...(ground(s)?.zones.map(zone => zone.limit) ?? [])),
      pitchAt: s => (ground(s)?.pitch ?? 0) * Math.PI / 180,
    }, onFoot);
  }

  if (homeOnly && mission.pos) {
    workStartMinutes = elapsed / 60;
    const work = consumptionEstimate(workMinutes * 60, { work: true });
    elapsed += workMinutes * 60;
    oxygenUsed += work.oxygenMinutes; batteryWhUsed += work.batteryWh;
    if (walking || route.retracesOutbound === false) crossGround(mission.pos, HAB, walking);
    else {
      crossGround(rover, route.sample(fromS));
      travel(fromS, fromS < route.length / 2 ? 0 : route.length);
    }
  } else {
    if (walking && mission.pos && rover) crossGround(mission.pos, rover, true);
    const start = route.sample?.(fromS);
    if (rover && Number.isFinite(start?.x) && Number.isFinite(start?.z)) crossGround(rover, start);
    const endS = Math.max(fromS, toS);
    const stops = [...workStops, { s: endS, minutes: 0 }];
    for (const [leg, stop] of stops.entries()) {
      const destination = Math.max(fromS, Math.min(endS, stop.s));
      travel(fromS, destination);
      fromS = destination;
      if (leg === 0) workStartMinutes = elapsed / 60;
      const used = consumptionEstimate(stop.minutes * 60, { work: true });
      elapsed += stop.minutes * 60;
      oxygenUsed += used.oxygenMinutes; batteryWhUsed += used.batteryWh;
    }
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
    driveMinutes: driveSeconds / 60, walkingMinutes: walkingSeconds / 60, totalMinutes: elapsed / 60, workStartMinutes, oxygenUsed, batteryWhUsed,
  };
}

export function fieldGuidance(mission) {
  const { route, s, nextKnownStop: nextStop, state } = mission;
  const pos = mission.pos ?? route.sample(s);
  const retraces = route.retracesOutbound !== false;
  const outbound = retraces && s < route.length / 2 && !mission.aborted;
  const open = route.stations.filter(stop => !stop.final && !stop.done && !stop.skipped);
  const returnForecast = forecastReturn(mission, { homeOnly: true,
    fromS: !mission.pos && outbound ? route.length - s : s });
  const workStops = open.map(stop => ({ s: stop.s,
    minutes: (stop.tasks.some(task => task.artifact) ? stop.tasks.filter(task => task.artifact) : stop.tasks)
      .reduce((sum, task) => sum + (task.done || task.skipped ? 0 : task.minutes), 0) }));
  const plannedForecast = mission.aborted || state === 'complete' ? returnForecast : forecastReturn(mission, { workStops });
  const returnOxygen = returnForecast.oxygenLeft;
  const zone = mission.activeZones?.find(hazard => hazard.severity === 'danger')
    ?? (!mission.pos ? route.zones.find(hazard => !hazard.acknowledged && hazard.s1 >= s && hazard.s0 - s <= 55) : null);
  const front = mission.activeFront;
  const dust = mission.dustWarning;
  const surprise = nextStop?.ref.surprise && (nextStop.ref.detected || state === 'gate') ? nextStop.ref : null;
  const canReturn = ['drive', 'walk'].includes(state) && !mission.aborted
    && (mission.pos ? mission.leftHome && !mission.atHome : outbound && s > 1);
  const reachedBase = state === 'complete' || (mission.atHome && !open.length);
  const belowReserve = plannedForecast.oxygenLeft < LIFE_SUPPORT.reserveMinutes;
  const late = plannedForecast.backAtMinutes > TWILIGHT_LIMIT;
  const lowBattery = plannedForecast.batteryPct < 10;
  let advice = 'Continue', reason = 'Planned return preserves your oxygen reserve.';
  if (reachedBase) { advice = 'At habitat'; reason = 'The traverse is complete or ready for ingress.'; }
  else if (returnOxygen < 0) { advice = 'Emergency'; reason = 'Estimated oxygen is insufficient for the return and ingress.'; }
  else if (dust || belowReserve || late || lowBattery) {
    advice = mission.pos || outbound ? 'Return to habitat' : retraces ? 'Proceed to habitat' : belowReserve ? 'Oxygen caution' : 'Return caution';
    reason = dust ? 'Simulated dust front ahead. Return to the airlock.'
      : belowReserve ? 'Finishing all remaining science would use your oxygen reserve.'
        : late ? 'Finishing all remaining science would put you back at HAB after twilight.' : 'Finishing all remaining science would use the rover battery margin.';
  } else if (surprise) { advice = 'Caution'; reason = `${surprise.type.toLowerCase()}. Complete the on-site recovery before continuing.`; }
  else if (zone) { advice = 'Caution'; reason = `${zone.type.toLowerCase()} here. Follow the marked speed limit.`; }
  else if (!open.length || mission.aborted) { advice = 'Proceed to habitat'; reason = 'Head back to the airlock and end the EVA.'; }
  else if (mission.weather.label !== 'Clear') {
    advice = Number.isFinite(mission.weather.exposureMinutes) ? 'Cold caution' : 'Reduced visibility';
    reason = Number.isFinite(mission.weather.exposureMinutes)
      ? `${mission.weather.label}. Keep outdoor work within the ${mission.weather.exposureMinutes}-minute exposure window.`
      : `${mission.weather.label}. Follow the marked route at the reduced speed limit.`;
  }
  const returning = advice === 'Return to habitat' || advice === 'Proceed to habitat' || mission.aborted;
  const target = returning ? { ...HAB, name: 'Habitat' } : open[0] ?? { ...HAB, name: 'Habitat' };
  const hasCoordinates = Number.isFinite(pos?.x) && Number.isFinite(target.x);
  const heading = route.sample(Math.min(s + 2, route.length));
  const degrees = (Math.round(Math.atan2(hasCoordinates ? target.x - pos.x : heading.tx,
    hasCoordinates ? -(target.z - pos.z) : -heading.tz) * 180 / Math.PI) + 360) % 360;
  return {
    advice, reason, canReturn, degrees,
    direction: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8],
    returnOxygen, returnForecast, plannedForecast,
    next: returning ? 'Habitat' : nextStop?.kind === 'gate' ? 'Hazard gate' : target.name,
    distance: Math.max(0, Math.round(hasCoordinates ? Math.hypot(target.x - pos.x, target.z - pos.z)
      : returning && outbound ? s : (nextStop?.s ?? route.length) - s)),
    hazard: surprise?.type.toLowerCase() ?? (dust || (front && front.to >= s) ? 'Dust front · simulated' : zone?.type.toLowerCase() ?? 'None reported here'),
  };
}
