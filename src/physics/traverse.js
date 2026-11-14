import { ROVER, SLOPE_CLASSES, LIFE_SUPPORT } from '../config/mission.js';

// Shared with live driving: moving is metres travelled, pitch is signed radians.
export function consumptionEstimate(seconds, { work = false, moving = 0, pitch = 0 } = {}) {
  const hotel = 110 * (seconds / 3600);
  const drive = moving * 0.09 * (1 + 9 * Math.max(0, Math.sin(pitch)));
  return {
    oxygenMinutes: (seconds / 60) * (work ? LIFE_SUPPORT.workFactor : 1),
    batteryWh: hotel + drive,
  };
}

/**
 * The one oxygen ledger for an EVA, shared by the habitat route cards, the wrist
 * navigator, the suit planner and the live traverse. Oxygen is in minutes.
 *
 *   egress (airlock out, working rate) → drive (riding rate) → work (working rate)
 *   → ingress (dust-off + airlock in, working rate)
 *
 * Pass egress: false once the crew is outside (the live traverse charges egress
 * when the mission starts) and usedMinutes for oxygen already consumed.
 * rateFactor scales every phase, e.g. for a heavier suit.
 */
export function evaBudget({ driveSeconds = 0, workMinutes = 0, egress = true, ingress = true, usedMinutes = 0, rateFactor = 1 } = {}) {
  const working = (minutes) => consumptionEstimate(minutes * 60, { work: true }).oxygenMinutes * rateFactor;
  const phases = {
    egress: egress ? working(LIFE_SUPPORT.egressMinutes) : 0,
    drive: consumptionEstimate(driveSeconds).oxygenMinutes * rateFactor,
    work: working(workMinutes),
    ingress: ingress ? working(LIFE_SUPPORT.ingressMinutes) : 0,
  };
  const required = phases.egress + phases.drive + phases.work + phases.ingress;
  const capacity = LIFE_SUPPORT.evaHours * 60;
  const remaining = capacity - usedMinutes - required;
  return {
    ...phases,
    required,
    used: usedMinutes,
    capacity,
    reserve: LIFE_SUPPORT.reserveMinutes,
    remaining, // oxygen left at the end of the EVA
    belowReserve: remaining < LIFE_SUPPORT.reserveMinutes,
    insufficient: remaining < 0,
  };
}

// Constant-speed planning estimate; live acceleration, stops and area hazards are not simulated here.
export function segmentEstimate(horizontalM, riseM) {
  const distanceM = Math.hypot(horizontalM, riseM);
  const pitch = Math.atan2(riseM, horizontalM);
  const absolutePitch = Math.abs(pitch);
  const slopeDeg = absolutePitch * 180 / Math.PI;
  const speed = absolutePitch >= SLOPE_CLASSES.danger * Math.PI / 180 ? ROVER.dangerSlopeSpeed
    : absolutePitch >= SLOPE_CLASSES.caution * Math.PI / 180 ? ROVER.cautionSpeed
      : ROVER.maxSpeed;
  const durationSeconds = distanceM / speed;
  return {
    distanceM, durationSeconds,
    ...consumptionEstimate(durationSeconds, { moving: distanceM, pitch }),
    slopeDeg,
  };
}
