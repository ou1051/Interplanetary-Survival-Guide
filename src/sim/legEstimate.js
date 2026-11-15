import { Mission } from './mission.js';
import { SURPRISES } from '../config/mission.js';

// Planning estimate for one leg, driven through the same rules as the live drive: speed limits,
// acceleration and the ground along the planned line. Hidden obstacles are not known in advance, so they are
// reported apart as a possible extra delay (range over what unsurveyed ground can hide).
export function estimateLeg(route, terrain, toS) {
  const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 }, { surprises: false });
  const input = { throttle: true, brake: false, steer: 0, action: false, boost: false };
  mission.start();
  for (let step = 0; mission.s < toS - 0.5 && step < 30 * 60 * 30; step++) {
    if (mission.state === 'gate') mission.acknowledge();
    else if (mission.state !== 'drive') break;
    // the rover drives freely; the estimate follows the planned line
    mission.update(1 / 30, mission.autopilot(input), 0);
  }
  const unknown = (route.zones ?? []).filter((zone) => zone.unsurveyed && zone.s0 < toS).length;
  const delays = SURPRISES.map((surprise) => surprise.delayMinutes);
  return {
    minutes: mission.met / 60,
    oxygenMinutes: mission.o2Used,
    extraMinutes: unknown ? [Math.min(...delays) * unknown, Math.max(...delays) * unknown] : null,
  };
}
