import { ROVER, SLOPE_CLASSES } from '../config/mission.js';

// Shared with live driving: moving is metres travelled, pitch is signed radians.
export function consumptionEstimate(seconds, { work = false, moving = 0, pitch = 0 } = {}) {
  const hotel = 110 * (seconds / 3600);
  const drive = moving * 0.09 * (1 + 9 * Math.max(0, Math.sin(pitch)));
  return {
    oxygenMinutes: (seconds / 60) * (work ? 1.25 : 1),
    batteryWh: hotel + drive,
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
