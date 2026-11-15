import { LIFE_SUPPORT, ROVER, HAB } from '../config/mission.js';
import { consumptionEstimate } from '../physics/traverse.js';

// Conservative forecast home at the slowest governed speed, allowing for ingress.
// The crew can leave the planned route, so distances are measured from where
// they actually are: home over the ground (straight line × 1.3 for detours).
export const ingressMinutes = 20;
const DETOUR = 1.3;
const returnCost = (metres) => metres / ROVER.dangerSlopeSpeed / 60 +
  consumptionEstimate(ingressMinutes * 60, { work: true }).oxygenMinutes;
const compass = (degrees) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8];

export function fieldGuidance(mission) {
  const { route, s, state, o2Remaining } = mission;
  const pos = mission.pos ?? { x: HAB.x, z: HAB.z };
  const retraces = route.retracesOutbound !== false;
  const outbound = retraces && s < route.length / 2 && !mission.aborted;
  const homeDistance = Math.hypot(pos.x - HAB.x, pos.z - HAB.z) * DETOUR;
  const returnOxygen = o2Remaining - returnCost(homeDistance);
  const open = route.stations.filter((stop) => !stop.final && !stop.done);
  const workCost = open.flatMap((stop) => stop.tasks)
    .reduce((sum, task) => sum + (task.done ? 0 : consumptionEstimate(task.minutes * 60, { work: true }).oxygenMinutes), 0);
  // Remaining plan: on to the open stations in order, then home.
  let planned = 0;
  let from = pos;
  for (const stop of open) {
    planned += Math.hypot(stop.x - from.x, stop.z - from.z);
    from = stop;
  }
  planned = (planned + Math.hypot(from.x - HAB.x, from.z - HAB.z)) * DETOUR;
  const plannedReturnOxygen = o2Remaining - returnCost(planned) - workCost;
  const zone = mission.activeZones?.find((hazard) => hazard.severity === 'danger');
  const dust = mission.dustWarning;
  const canReturn = ['drive', 'walk'].includes(state) && outbound && s > 1;
  const reachedBase = state === 'complete' || (mission.atHome && !open.length);
  const belowReserve = plannedReturnOxygen < LIFE_SUPPORT.reserveMinutes;
  let advice = 'Continue', reason = 'Planned return preserves your oxygen reserve.';
  if (reachedBase) { advice = 'At habitat'; reason = 'The traverse is complete or ready for ingress.'; }
  else if (returnOxygen < 0) { advice = 'Emergency'; reason = 'Estimated oxygen is insufficient for the return and ingress.'; }
  else if (dust || belowReserve) {
    advice = outbound ? 'Return to habitat' : retraces ? 'Proceed to habitat' : 'Oxygen caution';
    reason = dust ? 'Simulated dust front ahead. Turn back along your outbound track.' : 'Continuing the plan would use your return reserve.';
    if (!outbound && dust) reason = 'Follow the route back to the airlock.';
  } else if (zone) { advice = 'Caution'; reason = `${zone.type.toLowerCase()} here. Follow the marked speed limit.`; }
  else if (!open.length || mission.aborted) { advice = 'Proceed to habitat'; reason = 'Head back to the airlock and end the EVA.'; }
  const returning = advice === 'Return to habitat' || advice === 'Proceed to habitat' || mission.aborted;
  const target = returning ? { x: HAB.x, z: HAB.z, name: 'Habitat' } : open[0] ?? { x: HAB.x, z: HAB.z, name: 'Habitat' };
  const degrees = (Math.round(Math.atan2(target.x - pos.x, -(target.z - pos.z)) * 180 / Math.PI) + 360) % 360;
  return {
    advice, reason, canReturn, degrees, direction: compass(degrees), returnOxygen,
    next: target.name,
    distance: Math.max(0, Math.round(Math.hypot(target.x - pos.x, target.z - pos.z))),
    hazard: dust ? 'Dust front · simulated' : zone?.type.toLowerCase() ?? 'None reported here',
  };
}
