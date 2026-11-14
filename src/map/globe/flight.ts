// Pure camera / readout helpers for the globe (no Cesium import, unit-tested).

export const MARS_RADIUS_M = 3396190;

export interface FlightPlan {
  /** Distance from camera to the clicked point, metres. */
  range: number;
  /** Camera pitch, degrees (negative = looking down). */
  pitchDeg: number;
  /** Flight time, seconds. Short on purpose: the player asked for speed. */
  duration: number;
}

/**
 * Where to put the camera after a click. Each click zooms in by `factor`,
 * never closer than `minRange`. High above the planet we look straight down;
 * close to the surface we tilt to show the relief in 3D.
 */
export function planFlight(currentHeightM: number, opts: { factor?: number; minRange?: number; maxRange?: number } = {}): FlightPlan {
  const factor = opts.factor ?? 0.3;
  const minRange = opts.minRange ?? 2500;
  const maxRange = opts.maxRange ?? 3 * MARS_RADIUS_M;
  const h = Math.max(0, Number.isFinite(currentHeightM) ? currentHeightM : maxRange);
  const range = Math.min(maxRange, Math.max(minRange, h * factor));
  const pitchDeg = pitchForRange(range);
  const duration = durationFor(h, range);
  return { range, pitchDeg, duration };
}

/** Steeper when far, oblique when near (−90° … −35°). */
export function pitchForRange(range: number): number {
  const t = Math.min(1, Math.max(0, Math.log10(range / 3000) / Math.log10(2_000_000 / 3000)));
  return -35 - t * 55;
}

/** 0.9–1.8 s depending on how far the camera travels in height. */
export function durationFor(fromHeight: number, toRange: number): number {
  const ratio = Math.abs(Math.log10(Math.max(1, fromHeight) / Math.max(1, toRange)));
  return Math.min(1.8, Math.max(0.9, 0.9 + ratio * 0.45));
}

export function formatLatLon(lat: number, lon: number): string {
  const la = `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'}`;
  const e = ((lon % 360) + 360) % 360; // east-positive 0–360, the planetary convention
  return `${la}  ${e.toFixed(4)}° E`;
}

export function formatHeight(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  const sign = m < 0 ? '−' : '';
  const a = Math.abs(m);
  return a >= 10000 ? `${sign}${(a / 1000).toFixed(1)} km` : `${sign}${Math.round(a).toLocaleString('en-US')} m`;
}

export function formatAltitude(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m >= 10000 ? `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: m >= 1e6 ? 0 : 1 })} km` : `${Math.round(m).toLocaleString('en-US')} m`;
}

/** Ground metres per screen pixel for a nadir view (approximate, for the scale bar). */
export function metresPerPixel(heightM: number, viewportHeightPx: number, fovYDeg = 60): number {
  const visible = 2 * heightM * Math.tan(((fovYDeg / 2) * Math.PI) / 180);
  return visible / Math.max(1, viewportHeightPx);
}

/** Pick a round scale-bar length (1-2-5 series) that fits within maxPx. */
export function niceScale(mpp: number, maxPx = 120): { metres: number; px: number; label: string } {
  const target = mpp * maxPx;
  const pow = 10 ** Math.floor(Math.log10(target));
  const steps = [5, 2, 1];
  let metres = pow;
  for (const s of steps) if (s * pow <= target) {
    metres = s * pow;
    break;
  }
  const px = metres / mpp;
  return { metres, px, label: metres >= 1000 ? `${metres / 1000} km` : `${metres} m` };
}

/** Great-circle distance on Mars (sphere), metres. */
export function surfaceDistance(lat1: number, lon1: number, lat2: number, lon2: number, radius = MARS_RADIUS_M): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface Crumbable {
  id: string;
  name: string;
  lat: number;
  lon: number;
  region?: string;
}

/** "Mars › Gale Crater › Vera Rubin Ridge" from where the camera is. */
export function breadcrumb(places: Crumbable[], cam: { lat: number; lon: number; altitudeM: number }): string[] {
  const crumbs = ['Mars'];
  if (cam.altitudeM > 2_500_000 || !places.length) return crumbs;
  let best = places[0];
  let bestD = Infinity;
  for (const p of places) {
    const d = surfaceDistance(cam.lat, cam.lon, p.lat, p.lon);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (bestD > Math.max(400_000, cam.altitudeM * 0.6)) return crumbs;
  if (best.region) crumbs.push(best.region);
  if (!best.region || (cam.altitudeM < 80_000 && bestD < 40_000)) crumbs.push(best.name);
  return crumbs;
}
