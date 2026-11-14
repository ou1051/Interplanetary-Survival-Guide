import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { Route } from '../world/route.js';
import { SITE } from '../config/mission.js';

export const deltaPlan = {
  id: 'delta-loop',
  name: 'Original Delta Traverse',
  site: { ...SITE, name: 'Delta Front', note: 'Original fictional terrain and hazards' },
};

export function buildDeltaTraverse() {
  const terrain = new Terrain();
  const route = new Route(terrain);
  route.retracesOutbound = false;
  return { terrain, route };
}

// Three approaches to the first science station. Each joins the same original loop at S1.
export function buildDeltaApproaches(original) {
  const { terrain, route } = original;
  const [first, ...rest] = route.stations.filter(station => !station.final);
  const start = route.sample(0);
  const end = route.sample(first.s);
  const vertex = ({ x, z }) => new THREE.Vector3(x, 0, z);
  const direct = new THREE.LineCurve3(vertex(start), vertex(end));
  const detour = new THREE.CatmullRomCurve3([
    vertex(start), vertex({ x: 32, z: -78 }), vertex({ x: 3, z: -158 }),
    vertex({ x: -89, z: -218 }), vertex(end),
  ]);
  detour.arcLengthDivisions = 1000;
  const variants = [
    { id: 'shortest', label: 'Shortest', color: '#ffc179', curve: direct, detail: 'Direct crossing' },
    { id: 'intermediate', label: 'Intermediate', color: '#89edff', detail: 'Original approach' },
    { id: 'longer', label: 'Longer', color: '#c2adff', curve: detour, detail: 'Eastern detour' },
  ];
  return variants.map(variant => {
    const distance = variant.curve?.getLength() ?? first.s;
    const shift = distance - first.s;
    const built = variant.curve ? new Route(terrain, {
      approach: { curve: variant.curve, joinAt: first.s },
      stations: [{ ...first, s: distance }, ...rest.map(station => ({ ...station, s: station.s + shift }))],
    }) : route;
    const lastIndex = Math.floor(distance / built.step);
    return { ...deltaPlan, ...variant, distance, s1: distance, name: `Delta Front · ${variant.label} to S1`,
      maxTilt: Math.max(...built.tilt.subarray(0, lastIndex + 1)),
      traverse: { terrain, route: built } };
  });
}
