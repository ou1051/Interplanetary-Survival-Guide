import { LIFE_SUPPORT, ROVER } from '../config/mission.js';
import { consumptionEstimate } from '../physics/traverse.js';

// Conservative rover forecast at the slowest governed speed, allowing for ingress.
export const ingressMinutes = 20;
const returnCost = (metres) => metres / ROVER.dangerSlopeSpeed / 60 +
  consumptionEstimate(ingressMinutes * 60, { work: true }).oxygenMinutes;

export function fieldGuidance(mission) {
  const { route, s, nextKnownStop: nextStop, state, o2Remaining } = mission;
  const turn = route.length / 2;
  const retraces = route.retracesOutbound !== false;
  const outbound = retraces && s < turn && !mission.aborted;
  const homeDistance = outbound ? s : route.length - s;
  const returnOxygen = o2Remaining - returnCost(homeDistance);
  const workCost = route.stations.filter(stop => !stop.final && !stop.done).flatMap(stop => stop.tasks)
    .reduce((sum, task) => sum + (task.done ? 0 : consumptionEstimate(task.minutes * 60, { work: true }).oxygenMinutes), 0);
  const plannedReturnOxygen = o2Remaining - returnCost(route.length - s) - workCost;
  const zone = route.zones.find(hazard => !hazard.acknowledged && hazard.s1 >= s && hazard.s0 - s <= 55);
  const dust = mission.dustWarning;
  const canReturn = ['drive', 'gate'].includes(state) && outbound && s > 1;
  const reachedBase = state === 'complete' || (!outbound && nextStop?.ref.final && state !== 'drive' && state !== 'gate');
  const belowReserve = plannedReturnOxygen < LIFE_SUPPORT.reserveMinutes;
  let advice = 'Continue', reason = 'Planned return preserves your oxygen reserve.';
  if (reachedBase) { advice = 'At habitat'; reason = 'The traverse is complete or ready for ingress.'; }
  else if (returnOxygen < 0) { advice = 'Emergency'; reason = 'Estimated oxygen is insufficient for the return and ingress.'; }
  else if (dust || belowReserve) {
    advice = outbound ? 'Return to habitat' : retraces ? 'Proceed to habitat' : 'Oxygen caution';
    reason = dust ? 'Simulated dust front ahead. Turn back along your outbound track.' : 'Continuing the plan would use your return reserve.';
    if (!outbound && dust) reason = 'Follow the route back to the airlock.';
  } else if (zone) { advice = 'Caution'; reason = `${zone.type.toLowerCase()} ahead. Follow the marked speed limit.`; }
  else if (mission.weather.label !== 'Clear') {
    advice = 'Reduced visibility';
    reason = `${mission.weather.label}. Follow the marked route at the reduced speed limit.`;
  }
  else if (!outbound && (retraces || nextStop?.ref.final)) { advice = 'Proceed to habitat'; reason = 'Follow the return leg to the airlock.'; }
  const returning = advice === 'Return to habitat';
  const guideS = returning ? route.length - s : s;
  const heading = route.sample(Math.min(guideS + 2, route.length));
  const degrees = (Math.round(Math.atan2(heading.tx, -heading.tz) * 180 / Math.PI) + 360) % 360;
  const direction = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8];
  return {
    advice, reason, canReturn, degrees, direction, returnOxygen,
    next: returning ? 'Habitat' : nextStop?.kind === 'gate' ? 'Hazard gate' : nextStop?.ref.name ?? 'Habitat',
    distance: Math.max(0, Math.round(returning ? homeDistance : (nextStop?.s ?? route.length) - s)),
    hazard: dust ? 'Dust front · simulated' : zone?.type.toLowerCase() ?? 'None reported ahead',
  };
}
