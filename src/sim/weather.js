import { ROVER } from '../config/mission.js';

// At the reported sight range, exponential-squared fog leaves 5% of the original contrast.
const extinction = Math.sqrt(-Math.log(0.05));
const clearRangeM = extinction / 0.00042;
const weatherProfile = (label, speedLimit, visibilityM, windSpeedMps = 0, temperatureOffsetC = 0, exposureMinutes = Infinity) => ({
  label, speedLimit, visibilityM, temperatureOffsetC, exposureMinutes, windSpeedMps,
  fogDensity: extinction / visibilityM,
  limitsVisibility: visibilityM < clearRangeM,
});
export const CLEAR_WEATHER = weatherProfile('Clear', ROVER.maxSpeed, clearRangeM);
export const BLOWING_DUST = weatherProfile('Blowing dust', 1.5, 50, 22);
export const PASSING_WEATHER = [
  weatherProfile('Dust gust', 3, 120, 14),
  weatherProfile('Cold spell', ROVER.maxSpeed, clearRangeM, 0, -25, 10),
  BLOWING_DUST,
];
export const DUST_FRONT = weatherProfile('Dust front', 0, 30, 28);
export const SHORTCUT_FRONT = weatherProfile('Dust front over shortcut', 0.65, 40, 24);

// World-space direction the wind blows towards, shared by handling and airborne dust.
export const WIND_DIRECTION = { x: 1.4 / Math.hypot(1.4, 0.6), z: 0.6 / Math.hypot(1.4, 0.6) };
export function windSpeedAt(weather, met) {
  return (weather.windSpeedMps ?? 0) * (1 + 0.12 * Math.sin(met * 0.8) + 0.06 * Math.sin(met * 1.9));
}
