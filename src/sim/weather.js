import { ROVER } from '../config/mission.js';

const weatherProfile = (label, speedLimit, fogDensity, temperatureOffsetC = 0, exposureMinutes = Infinity) => ({
  label, speedLimit, fogDensity, temperatureOffsetC, exposureMinutes,
  limitsVisibility: fogDensity > 0.00042,
  // Three.js exponential-squared fog: distance where 5% of the scene remains visible.
  visibilityM: Math.sqrt(-Math.log(0.05)) / fogDensity,
});
export const CLEAR_WEATHER = weatherProfile('Clear', ROVER.maxSpeed, 0.00042);
export const PASSING_WEATHER = [
  weatherProfile('Dust gust', 3, 0.004),
  weatherProfile('Cold spell', ROVER.maxSpeed, 0.00042, -25, 10),
  weatherProfile('Blowing dust', 1.5, 0.009),
];
export const DUST_FRONT = weatherProfile('Dust front', 0, 0.008);
export const SHORTCUT_FRONT = weatherProfile('Dust front over shortcut', 0.65, 0.023);
