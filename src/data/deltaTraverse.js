import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { Route, joinCurves, routeSegment } from '../world/route.js';
import { SITE, AREA_HAZARDS, STATIONS, SLOPE_CLASSES } from '../config/mission.js';
import { driveMinutes } from '../sim/legCheck.js';
import { estimateLeg } from '../sim/legEstimate.js';

export const deltaPlan = {
  id: 'delta-loop',
  name: 'Original Delta Traverse',
  site: { ...SITE, name: 'Delta Front', note: 'Original fictional terrain and hazards' },
};

export function buildDeltaTraverse() {
  const terrain = new Terrain();
  // The loop's own first leg is never driven (the crew picks one of the approaches below), so the
  // unsurveyed patch on it is left out here and only counts for the approach that crosses it.
  const route = new Route(terrain, { areaHazards: AREA_HAZARDS.filter(hazard => !hazard.unsurveyed) });
  route.retracesOutbound = false;
  return { terrain, route };
}

// Three approaches to the first science station, each a clear trade-off between distance and risk.
// All join the same original loop at S1.
//  - Shortest: the straight line. It crosses ground with no high-resolution survey (H-UNSURVEYED).
//  - Intermediate: bends east around that patch over mapped ground.
//  - Longer: a wide western detour over the gentlest ground.
export function buildDeltaApproaches(original) {
  const { terrain, route } = original;
  const [first] = route.stations.filter(station => !station.final);
  const start = route.sample(0);
  const end = route.sample(first.s);
  const vertex = ({ x, z }) => new THREE.Vector3(x, 0, z);
  const via = (...points) => {
    const curve = new THREE.CatmullRomCurve3([vertex(start), ...points.map(([x, z]) => vertex({ x, z })), vertex(end)]);
    curve.arcLengthDivisions = 1000;
    return curve;
  };
  const variants = [
    { id: 'shortest', label: 'Shortest', color: '#ffc179', curve: new THREE.LineCurve3(vertex(start), vertex(end)),
      detail: 'Direct · unsurveyed ground', risk: 'Unknown obstacles' },
    { id: 'intermediate', label: 'Intermediate', color: '#89edff', curve: via([-13, -132]),
      detail: 'Around the unsurveyed patch', risk: 'Mapped ground' },
    { id: 'longer', label: 'Longer', color: '#c2adff', curve: via([-226, -84]),
      detail: 'Western detour · gentlest', risk: 'Mapped ground' },
  ];
  const loop = loopLegs(route);
  return variants.map(variant => {
    const distance = variant.curve.getLength();
    const legs = [variant.curve, ...loop.slice(1)];
    const built = buildLoopRoute(terrain, legs);
    const lastIndex = Math.floor(distance / built.step);
    const unknowns = built.zones.filter(zone => zone.unsurveyed && zone.s0 < distance);
    built.retracesOutbound = false;
    const estimate = estimateLeg(built, terrain, distance);
    return { ...deltaPlan, ...variant, distance, s1: distance, unknowns, estimate, legs, name: `Delta Front · ${variant.label} to S1`,
      maxTilt: Math.max(...built.tilt.subarray(0, lastIndex + 1)),
      traverse: { terrain, route: built } };
  });
}

// ---------------------------------------------------------------------------
// Legs between stations. The loop is five legs (HAB→S1, S1→S2, S2→S3, S3→S4,
// S4→HAB); the driven route is those legs joined, with the stations at the joins,
// so one leg can be swapped for another path while the rest stays the same.
// ---------------------------------------------------------------------------

// The original loop cut into its five legs.
export function loopLegs(base) {
  const marks = [0, ...base.stations.filter(station => !station.final).map(station => station.s), base.length];
  return marks.slice(1).map((end, i) => routeSegment(base, marks[i], end));
}

export function buildLoopRoute(terrain, legs) {
  let s = 0;
  const stations = STATIONS.map((station, i) => ({ ...station, s: (s += legs[i].getLength()) }));
  const route = new Route(terrain, { path: joinCurves(legs), stations });
  route.retracesOutbound = false;
  route.legs = legs;
  const unknown = route.zones.find(zone => zone.unsurveyed && zone.s0 < legs[0].getLength());
  if (unknown) route.weatherExposure = { from: unknown.s0, to: unknown.s1 };
  return route;
}

// How hard a single leg is to drive: steepest tilt, hazard stops, slow stretches, time at the limits.
function judgeLeg(terrain, curve) {
  const leg = new Route(terrain, { path: joinCurves([curve]), stations: [] });
  const zones = leg.zones.filter(zone => zone.s0 < leg.length - 1);
  const danger = zones.filter(zone => zone.severity === 'danger').length;
  const caution = zones.filter(zone => zone.severity === 'caution').length;
  return {
    distance: leg.length,
    maxTilt: leg.stats.maxTilt,
    danger,
    caution,
    difficulty: danger ? 'Hard' : caution || leg.stats.maxTilt >= SLOPE_CLASSES.caution ? 'Moderate' : 'Easy',
    minutes: driveMinutes(leg, 0, leg.length),
  };
}

const ease = (p, q) => p.danger - q.danger || p.caution - q.caution || p.maxTilt - q.maxTilt || p.distance - q.distance;

// Three ways to drive leg `index` of the loop (1 = S1→S2 … 4 = S4→HAB): the fastest line, the
// planned path, and the safest line found among detours on either side (fewest hazards, gentlest).
const variantCache = new Map();
export function legVariants(terrain, legs, index, original = legs[index]) {
  const cached = variantCache.get(index);
  if (cached && cached.terrain === terrain) return cached.variants;
  const a = original.getPointAt(0);
  const b = original.getPointAt(1);
  const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const px = -(b.z - a.z) / length;
  const pz = (b.x - a.x) / length;
  const at = (t, offset) => new THREE.Vector3(a.x + (b.x - a.x) * t + px * offset, 0, a.z + (b.z - a.z) * t + pz * offset);
  const curveThrough = (...points) => {
    const curve = new THREE.CatmullRomCurve3([at(0, 0), ...points, at(1, 0)]);
    curve.arcLengthDivisions = 600;
    return curve;
  };
  const candidates = [{ curve: new THREE.LineCurve3(at(0, 0), at(1, 0)) }];
  for (const offset of [-180, -140, -100, -70, -40, 40, 70, 100, 140, 180]) {
    for (const t of [0.3, 0.5, 0.7]) candidates.push({ curve: curveThrough(at(t, offset)) });
    if (Math.abs(offset) >= 100) candidates.push({ curve: curveThrough(at(0.3, offset), at(0.7, offset)) });
  }
  for (const c of candidates) Object.assign(c, judgeLeg(terrain, c.curve));
  const planned = { curve: original, ...judgeLeg(terrain, original) };
  const fastest = [...candidates].sort((p, q) => p.minutes - q.minutes)[0];
  const safest = [...candidates, planned].sort(ease).find(c => c !== fastest && Math.abs(c.distance - planned.distance) > 8) ?? fastest;
  const variants = [
    { id: 'fast', label: 'Fastest', color: '#ffc179', ...fastest },
    { id: 'planned', label: 'Planned', color: '#89edff', ...planned },
    { id: 'safe', label: 'Safest', color: '#c2adff', ...safest },
  ];
  variantCache.set(index, { terrain, variants });
  return variants;
}
