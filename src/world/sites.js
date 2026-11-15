// @ts-nocheck
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Sites along the route: field lab, core drilling rig, solar field, weather mast,
// comms relay. They are CONCEPT sites (fictional infrastructure): every site is
// flagged `fictional: true` so the UI can label them honestly.
//
//   import { RouteSites, placeAlongRoute } from './world/sites.js';
//   const sites = new RouteSites({
//     heightAt: (x, z) => terrain.heightAt(x, z),
//     sites: placeAlongRoute({ route, count: 5, heightAt: (x, z) => terrain.heightAt(x, z) }),
//     onNear: (s) => hud.log(`Passing ${s.name} (concept): ${s.note}`, 'info'),
//   });
//   scene.add(sites.group);
//   // every frame:  sites.update(time, { x, z });      // rover position (optional)
//
// Works in any coordinate frame as long as Y is up and heightAt(x, z) returns the
// ground height. Models face +Z in their own space (airlock / ramp side).
// ---------------------------------------------------------------------------

export const SITE_INFO = {
  lab: { name: 'Field Research Lab', note: 'Pressurised lab for sample analysis and crew shelter.' },
  drill: { name: 'Core Drilling Rig', note: 'Automated rig pulling sub-surface cores for the lab. Keep 15 m clear.' },
  solar: { name: 'Solar Field', note: 'Backup power for the lab. Output collapses in a dust storm.' },
  weather: { name: 'Weather Mast', note: 'Wind, pressure and dust opacity for storm warnings.' },
  comms: { name: 'Comms Relay', note: 'Extends line-of-sight to the habitat over ridges.' },
};
const PAD_RADIUS = { lab: 11, drill: 7, solar: 12, weather: 4, comms: 5 };

const mat = (o) => new THREE.MeshStandardMaterial(o);
const M = {
  white: mat({ color: 0xe9e6df, roughness: 0.55, metalness: 0.15 }),
  grey: mat({ color: 0x8c8f94, roughness: 0.45, metalness: 0.6 }),
  dark: mat({ color: 0x2a2d33, roughness: 0.6, metalness: 0.3 }),
  orange: mat({ color: 0xff7a2a, roughness: 0.5, metalness: 0.2 }),
  panel: mat({ color: 0x1b2a4a, roughness: 0.25, metalness: 0.7, emissive: 0x050a18 }),
  gravel: mat({ color: 0x4a372d, roughness: 1, metalness: 0 }),
  window: mat({ color: 0xffc36b, emissive: 0xffa640, emissiveIntensity: 1.6, roughness: 0.4 }),
  red: mat({ color: 0xff6040, emissive: 0xff3020, emissiveIntensity: 3 }),
  green: mat({ color: 0x70ff9a, emissive: 0x30ff70, emissiveIntensity: 2.5 }),
  core: mat({ color: 0xc9a47e, roughness: 0.9 }),
};

const box = (w, h, d, m, x = 0, y = 0, z = 0) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  return o;
};
const cyl = (rt, rb, h, m, x = 0, y = 0, z = 0, seg = 16) => {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  o.position.set(x, y, z);
  return o;
};
const sphere = (r, m, x = 0, y = 0, z = 0) => {
  const o = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m);
  o.position.set(x, y, z);
  return o;
};
/** a strut between two points */
const strut = (a, b, r, m) => {
  const dir = new THREE.Vector3().subVectors(b, a);
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 6), m);
  o.position.copy(a).addScaledVector(dir, 0.5);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return o;
};
const dish = (r, m) => {
  const d = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, 0.9), m);
  d.scale.set(1, 0.7, 1);
  return d;
};

// ------------------------------------------------------------------ builders
function buildLab(g) {
  const body = cyl(2.4, 2.4, 12, M.white, 0, 3.4, 0, 32);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  for (const sx of [-1, 1]) {
    const cap = sphere(2.4, M.white, sx * 6, 3.4, 0);
    cap.scale.set(0.45, 1, 1);
    g.add(cap);
    const ring = cyl(2.46, 2.46, 0.5, M.orange, sx * 3.6, 3.4, 0, 32);
    ring.rotation.z = Math.PI / 2;
    g.add(ring);
  }
  for (const lx of [-4.2, 4.2]) for (const lz of [-1.9, 1.9]) g.add(cyl(0.14, 0.2, 2.0, M.grey, lx, 1.0, lz, 8));
  for (let i = 0; i < 5; i++) g.add(box(0.9, 0.5, 0.05, M.window, -4 + i * 2, 3.8, 2.4));
  const lock = cyl(1.1, 1.1, 2.4, M.white, 0, 2.6, 3.5, 24);
  lock.rotation.x = Math.PI / 2;
  g.add(lock);
  const hatch = new THREE.Mesh(new THREE.CircleGeometry(0.82, 24), M.dark);
  hatch.position.set(0, 2.6, 4.72);
  g.add(hatch);
  const ramp = box(1.6, 0.08, 3.2, M.grey, 0, 0.8, 6.0);
  ramp.rotation.x = 0.42;
  g.add(ramp);
  for (const px of [-2.2, 2.2]) {
    const p = box(3.6, 0.07, 2.0, M.panel, px, 6.0, 0);
    p.rotation.z = px < 0 ? 0.12 : -0.12;
    g.add(p);
  }
  g.add(cyl(0.08, 0.1, 3.5, M.grey, -4.8, 7.4, -0.8, 8));
  const d = dish(0.95, M.white);
  d.position.set(-4.8, 9.2, -0.8);
  d.rotation.x = -2.0;
  g.add(d);
  const beacon = sphere(0.18, M.red, -4.8, 9.3, -0.8);
  g.add(beacon);
  g.add(cyl(0.9, 0.9, 2.4, M.white, 7.6, 1.3, -2.8, 20), cyl(0.9, 0.9, 2.4, M.white, 7.6, 1.3, -0.6, 20));
  return (t) => {
    beacon.visible = Math.sin(t * 2.2) > -0.25;
  };
}

function buildDrill(g) {
  g.add(box(5, 0.3, 5, M.dark, 0, 0.15, 0));
  const topY = 9.5;
  const base = [[-1.8, -1.8], [1.8, -1.8], [1.8, 1.8], [-1.8, 1.8]];
  const top = base.map(([x, z]) => [x * 0.3, z * 0.3]);
  base.forEach(([x, z], i) => g.add(strut(new THREE.Vector3(x, 0.3, z), new THREE.Vector3(top[i][0], topY, top[i][1]), 0.12, M.grey)));
  for (const h of [3, 6]) {
    const k = 1 - h / topY * 0.7;
    const ring = [[-1.8 * k, -1.8 * k], [1.8 * k, -1.8 * k], [1.8 * k, 1.8 * k], [-1.8 * k, 1.8 * k]];
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % 4];
      g.add(strut(new THREE.Vector3(p[0], h, p[1]), new THREE.Vector3(q[0], h, q[1]), 0.07, M.grey));
    });
  }
  const head = box(1.7, 1.0, 1.7, M.orange, 0, topY + 0.4, 0);
  g.add(head);
  const string = cyl(0.22, 0.22, 8.2, M.dark, 0, 5.2, 0, 10);
  g.add(string);
  g.add(box(4.6, 0.8, 1.2, M.grey, 4.2, 0.7, 0.8));
  for (let i = 0; i < 6; i++) {
    const c = cyl(0.14, 0.14, 1.0, M.core, 2.5 + i * 0.7, 1.35, 0.8, 10);
    c.rotation.z = Math.PI / 2;
    g.add(c);
  }
  g.add(box(2.0, 1.4, 1.4, M.orange, -3.6, 0.9, 1.2));
  const lamp = sphere(0.14, M.red, 0, topY + 1.1, 0);
  g.add(lamp);
  return (t) => {
    string.rotation.y = t * 6;
    head.position.y = topY + 0.4 + Math.sin(t * 1.6) * 0.06;
    lamp.visible = Math.sin(t * 3) > -0.1;
  };
}

function buildSolar(g) {
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 6; i++) {
      const x = -8.5 + i * 3.4;
      const z = -3.2 + row * 6.2;
      g.add(cyl(0.07, 0.07, 1.3, M.grey, x, 0.65, z, 6));
      const p = box(3.0, 0.06, 1.9, M.panel, x, 1.45, z);
      p.rotation.x = -0.5;
      g.add(p);
    }
  }
  g.add(box(1.6, 1.4, 1.1, M.white, 0, 0.7, 6.4));
  const lamp = sphere(0.1, M.green, 0, 1.55, 6.4);
  g.add(lamp);
  g.add(box(0.2, 0.05, 6.0, M.dark, 0, 0.03, 3.3));
  return (t) => {
    lamp.visible = Math.sin(t * 1.4) > -0.5;
  };
}

function buildWeather(g) {
  const legs = [0, 1, 2].map((i) => (i / 3) * Math.PI * 2);
  legs.forEach((a) => g.add(strut(new THREE.Vector3(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5), new THREE.Vector3(0, 2.2, 0), 0.07, M.grey)));
  g.add(cyl(0.07, 0.09, 7.4, M.grey, 0, 3.9, 0, 8));
  const cups = new THREE.Group();
  cups.position.y = 7.5;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    cups.add(strut(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55), 0.025, M.grey));
    const cup = sphere(0.14, M.white, Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6);
    cup.scale.set(1, 0.7, 1);
    cups.add(cup);
  }
  g.add(cups);
  const vane = new THREE.Group();
  vane.position.y = 6.7;
  vane.add(box(0.9, 0.04, 0.05, M.orange, 0.35, 0, 0), box(0.04, 0.3, 0.3, M.orange, -0.1, 0, 0));
  g.add(vane);
  g.add(box(0.8, 0.9, 0.5, M.white, 0.5, 2.6, 0.2));
  const sp = box(1.1, 0.05, 0.8, M.panel, -0.9, 4.2, 0);
  sp.rotation.z = 0.5;
  g.add(sp);
  const beacon = sphere(0.1, M.red, 0, 7.9, 0);
  g.add(beacon);
  return (t) => {
    cups.rotation.y = t * 5;
    vane.rotation.y = Math.sin(t * 0.4) * 0.8 + 0.6;
    beacon.visible = Math.sin(t * 2.6) > -0.2;
  };
}

function buildComms(g) {
  const h = 14;
  const base = [[-1.2, -1.2], [1.2, -1.2], [1.2, 1.2], [-1.2, 1.2]];
  base.forEach(([x, z]) => g.add(strut(new THREE.Vector3(x, 0, z), new THREE.Vector3(x * 0.25, h, z * 0.25), 0.07, M.grey)));
  for (const y of [3, 6, 9, 12]) {
    const k = 1 - (y / h) * 0.75;
    const r = base.map(([x, z]) => new THREE.Vector3(x * k, y, z * k));
    r.forEach((p, i) => g.add(strut(p, r[(i + 1) % 4], 0.04, M.grey)));
  }
  const d1 = dish(1.2, M.white);
  d1.position.set(0.5, h - 2, 0.9);
  d1.rotation.set(-2.2, 0, 0);
  const d2 = dish(0.8, M.white);
  d2.position.set(-0.5, h - 5, -0.9);
  d2.rotation.set(-1.9, 2.6, 0);
  g.add(d1, d2, box(1.0, 0.8, 0.8, M.dark, 0, 0.6, 1.8));
  const beacon = sphere(0.14, M.red, 0, h + 0.4, 0);
  g.add(beacon);
  return (t) => {
    beacon.visible = Math.sin(t * 2.0) > -0.3;
  };
}

const BUILDERS = { lab: buildLab, drill: buildDrill, solar: buildSolar, weather: buildWeather, comms: buildComms };

/** one site model, origin at the centre of its pad, ground at y = 0 */
export function buildSite(type) {
  const fn = BUILDERS[type];
  if (!fn) throw new Error(`Unknown site type "${type}"`);
  const g = new THREE.Group();
  const anim = fn(g);
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  g.userData.anim = anim;
  return g;
}

// ------------------------------------------------------------------ placement
const ringFlatness = (heightAt, x, z, r) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const h = heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return { lo, hi, spread: hi - lo };
};

/**
 * Pick spots beside the route. `route` needs `length` and `sample(s, out)` filling
 * out.x, out.z, out.rx, out.rz (the right-hand vector). With `heightAt`, each site
 * tries several offsets and both sides and keeps the flattest ground.
 */
export function placeAlongRoute({ route, count = 5, offset = 18, types = ['lab', 'weather', 'drill', 'solar', 'comms'], startFrac = 0.12, endFrac = 0.88, heightAt = null }) {
  const out = [];
  const p = {};
  for (let i = 0; i < count; i++) {
    const frac = count === 1 ? 0.5 : startFrac + ((endFrac - startFrac) * i) / (count - 1);
    route.sample(route.length * frac, p);
    const type = types[i % types.length];
    const r = PAD_RADIUS[type];
    const prefer = i % 2 === 0 ? 1 : -1;
    let best = null;
    for (const side of [prefer, -prefer]) {
      for (const off of [offset, offset + 8, offset + 16]) {
        const x = p.x + p.rx * side * (off + r * 0.5);
        const z = p.z + p.rz * side * (off + r * 0.5);
        const score = heightAt ? ringFlatness(heightAt, x, z, r).spread + (side === prefer ? 0 : 0.4) : off * 0.01 + (side === prefer ? 0 : 1);
        if (!best || score < best.score) best = { x, z, score };
      }
    }
    const info = SITE_INFO[type];
    out.push({ id: `${type}-${i + 1}`, type, name: info.name, note: info.note, fictional: true, x: best.x, z: best.z, yaw: Math.atan2(p.x - best.x, p.z - best.z) });
  }
  return out;
}

// ------------------------------------------------------------------ the collection
export class RouteSites {
  constructor({ heightAt, sites = [], onNear = () => {}, nearRadius = 70 }) {
    this.heightAt = heightAt;
    this.onNear = onNear;
    this.nearRadius = nearRadius;
    this.group = new THREE.Group();
    this.group.name = 'route-sites';
    this.items = [];
    sites.forEach((s) => this.add(s));
  }

  add(def) {
    const type = def.type;
    const info = SITE_INFO[type] || { name: type, note: '' };
    const site = { fictional: true, name: info.name, note: info.note, yaw: 0, ...def };
    const R = PAD_RADIUS[type] || 6;
    const ring = ringFlatness(this.heightAt, site.x, site.z, R * 0.8);
    const holder = new THREE.Group();
    holder.position.set(site.x, ring.hi, site.z);
    holder.rotation.y = site.yaw;
    // gravel pad: sunk deep so it hides gaps on slopes
    const pad = cyl(R, R + 1.2, 3, M.gravel, 0, -1.42, 0, 40);
    pad.receiveShadow = true;
    holder.add(pad);
    const model = buildSite(type);
    model.position.y = 0.08;
    holder.add(model);
    this.group.add(holder);
    this.items.push({ def: site, holder, anim: model.userData.anim, near: false });
    return site;
  }

  update(t, pos = null) {
    for (const it of this.items) {
      if (it.anim) it.anim(t);
      if (pos) {
        const d = Math.hypot(pos.x - it.def.x, pos.z - it.def.z);
        if (d < this.nearRadius && !it.near) {
          it.near = true;
          this.onNear(it.def, d);
        } else if (d > this.nearRadius * 1.4) it.near = false;
      }
    }
  }

  nearest(x, z) {
    let best = null;
    for (const it of this.items) {
      const d = Math.hypot(x - it.def.x, z - it.def.z);
      if (!best || d < best.distance) best = { site: it.def, distance: d };
    }
    return best;
  }
}