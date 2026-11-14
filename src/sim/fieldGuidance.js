import { ROVER } from '../config/mission.js';
import { evaBudget } from '../physics/traverse.js';

// Conservative rover forecast at the slowest governed speed. Egress was already
// charged when the traverse started; ingress is still ahead.
const fromHere = (mission, metres, workMinutes = 0) => evaBudget({
  driveSeconds: metres / ROVER.dangerSlopeSpeed, workMinutes, egress: false, usedMinutes: mission.o2Used,
});

export function fieldGuidance(mission) {
  const { route, s, nextStop, state } = mission;
  const turn = route.length / 2;
  const retraces = route.retracesOutbound !== false;
  const outbound = retraces && s < turn && !mission.aborted;
  const homeDistance = outbound ? s : route.length - s;
  const direct = fromHere(mission, homeDistance);
  const returnOxygen = direct.remaining;
  const workMinutes = route.stations.filter(stop => !stop.final && !stop.done).flatMap(stop => stop.tasks)
    .reduce((sum, task) => sum + (task.done ? 0 : task.minutes), 0);
  const planned = fromHere(mission, route.length - s, workMinutes);
  const zone = route.zones.find(hazard => !hazard.acknowledged && hazard.s1 >= s && hazard.s0 - s <= 55);
  const dust = mission.dustWarning;
  const canReturn = ['drive', 'gate'].includes(state) && outbound && s > 1;
  const reachedBase = state === 'complete' || (!outbound && nextStop?.ref.final && state !== 'drive' && state !== 'gate');
  const belowReserve = planned.belowReserve;
  let advice = 'Continue', reason = 'Planned return preserves your oxygen reserve.';
  if (reachedBase) { advice = 'At habitat'; reason = 'The traverse is complete or ready for ingress.'; }
  else if (direct.insufficient) { advice = 'Emergency'; reason = 'Estimated oxygen is insufficient for the return and ingress.'; }
  else if (dust || belowReserve) {
    advice = outbound ? 'Return to habitat' : retraces ? 'Proceed to habitat' : 'Oxygen caution';
    reason = dust ? 'Simulated dust front ahead. Turn back along your outbound track.' : 'Continuing the plan would use your return reserve.';
    if (!outbound && dust) reason = 'Follow the route back to the airlock.';
  } else if (zone) { advice = 'Caution'; reason = `${zone.type.toLowerCase()} ahead. Follow the marked speed limit.`; }
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
