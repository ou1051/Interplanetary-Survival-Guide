import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { Route } from '../world/route.js';
import { SITE, AREA_HAZARDS } from '../config/mission.js';
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
  const [first, ...rest] = route.stations.filter(station => !station.final);
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
  return variants.map(variant => {
    const distance = variant.curve.getLength();
    const shift = distance - first.s;
    const built = new Route(terrain, {
      approach: { curve: variant.curve, joinAt: first.s },
      stations: [{ ...first, s: distance }, ...rest.map(station => ({ ...station, s: station.s + shift }))],
    });
    const lastIndex = Math.floor(distance / built.step);
    const unknowns = built.zones.filter(zone => zone.unsurveyed && zone.s0 < distance);
    built.retracesOutbound = false;
    if (variant.id === 'shortest') built.weatherExposure = { from: unknowns[0].s0, to: unknowns[0].s1 };
    const estimate = estimateLeg(built, terrain, distance);
    return { ...deltaPlan, ...variant, distance, s1: distance, unknowns, estimate, name: `Delta Front · ${variant.label} to S1`,
      maxTilt: Math.max(...built.tilt.subarray(0, lastIndex + 1)),
      traverse: { terrain, route: built } };
  });
}
