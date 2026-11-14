import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { mulberry32, clamp } from '../core/math.js';
import { distanceToRoute, featureMasks } from './terrain.js';
import { TERRAIN, HAB, ROVER } from '../config/mission.js';

// ---------------------------------------------------------------------------
// Rocks (instanced, noise-displaced) and the habitat landmark.
// ---------------------------------------------------------------------------

function rockGeometry(seed, detail = 1) {
  const r = mulberry32(seed);
  const noise = new SimplexNoise({ random: r });
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  const sx = 0.8 + r() * 0.5;
  const sy = 0.45 + r() * 0.35;
  const sz = 0.8 + r() * 0.5;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + 0.32 * noise.noise3d(v.x * 1.3, v.y * 1.3, v.z * 1.3) + 0.12 * noise.noise3d(v.x * 3.1, v.y * 3.1, v.z * 3.1);
    v.multiplyScalar(n);
    // flatten facets a bit (fractured look)
    v.x = Math.round(v.x * 5) / 5 * 0.25 + v.x * 0.75;
    v.y = Math.round(v.y * 5) / 5 * 0.25 + v.y * 0.75;
    v.set(v.x * sx, v.y * sy, v.z * sz);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export function createRocks(terrain, route) {
  const group = new THREE.Group();
  const r = mulberry32(TERRAIN.seed + 17);
  const clearance = ROVER.corridorHalfWidth + 1.6;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0.0, flatShading: true });
  const palette = ['#5b3f31', '#6e4a37', '#4a352c', '#7d5640', '#8a6a55', '#3f2f28'].map((c) => new THREE.Color(c));

  const variants = [rockGeometry(11), rockGeometry(23), rockGeometry(37, 2), rockGeometry(51)];
  const pools = variants.map(() => []);
  const p = {};

  const place = (x, z, size, tiltAmt = 0.4) => {
    if (distanceToRoute(x, z) < clearance + size * 0.8) return;
    if (Math.hypot(x - HAB.x, z - HAB.z) < 38) return;
    const m = featureMasks(x, z);
    if (m.craterInterior > 0.5 && size > 1.5) return;
    const k = Math.floor(r() * variants.length);
    const h = terrain.heightAt(x, z);
    pools[k].push({
      x,
      y: h - size * 0.22,
      z,
      s: size,
      ry: r() * Math.PI * 2,
      rx: (r() - 0.5) * tiltAmt,
      rz: (r() - 0.5) * tiltAmt,
      c: palette[Math.floor(r() * palette.length)],
    });
  };

  // 1) Near the corridor so the drive always has something passing by.
  for (let i = 0; i < 5200; i++) {
    route.sample(r() * route.length, p);
    const side = r() < 0.5 ? -1 : 1;
    const d = clearance + 0.5 + -Math.log(1 - r() * 0.999) * 26;
    const x = p.x + p.rx * side * d + (r() - 0.5) * 6;
    const z = p.z + p.rz * side * d + (r() - 0.5) * 6;
    const m = featureMasks(x, z);
    const big = r() < 0.04 + m.ejecta * 0.25;
    const size = big ? 0.9 + r() * 1.6 : 0.12 + r() ** 2 * 0.7;
    place(x, z, size);
  }
  // 2) Ejecta block field around the fresh crater.
  for (let i = 0; i < 900; i++) {
    const a = r() * Math.PI * 2;
    const rr = 38 * (1.05 + r() ** 1.6 * 1.7);
    place(255 + Math.cos(a) * rr, -675 + Math.sin(a) * rr, 0.25 + r() ** 2.5 * 1.9);
  }
  // 3) Sparse boulders everywhere (and talus below the delta scarp).
  const I = TERRAIN.inner;
  for (let i = 0; i < 2600; i++) {
    const x = I.cx + (r() - 0.5) * I.size;
    const z = I.cz + (r() - 0.5) * I.size;
    const m = featureMasks(x, z);
    const talus = clamp(1 - Math.abs(m.delta - 0.5) * 2, 0, 1);
    if (r() > 0.25 + talus * 0.75) continue;
    place(x, z, 0.3 + r() ** 3 * (2.2 + talus * 1.6));
  }

  const dummy = new THREE.Object3D();
  variants.forEach((geo, k) => {
    const list = pools[k];
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(it.rx, it.ry, it.rz);
      dummy.scale.setScalar(it.s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, it.c);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  group.userData.count = pools.reduce((s, l) => s + l.length, 0);
  return group;
}

// Habitat, solar field, comms mast and an ascent vehicle on the horizon.
export function createHabitat(terrain) {
  const g = new THREE.Group();
  const y0 = terrain.heightAt(HAB.x, HAB.z);
  g.position.set(HAB.x, y0, HAB.z);

  const white = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.55, metalness: 0.15 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x8c8f94, roughness: 0.45, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.3 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc89b46, roughness: 0.32, metalness: 1.0 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.25, metalness: 0.7, emissive: 0x050a18 });

  // Main module: horizontal pressurised cylinder on legs (behind the start point).
  const hab = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 11, 40), white);
  body.rotation.z = Math.PI / 2;
  body.position.y = 3.4;
  hab.add(body);
  for (const sx of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(2.6, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), white);
    cap.rotation.z = (-sx * Math.PI) / 2;
    cap.position.set(sx * 5.5, 3.4, 0);
    cap.scale.set(1, 0.45, 1);
    hab.add(cap);
  }
  const band = new THREE.Mesh(new THREE.CylinderGeometry(2.65, 2.65, 1.2, 40), gold);
  band.rotation.z = Math.PI / 2;
  band.position.y = 3.4;
  hab.add(band);
  for (const lx of [-4, 4]) {
    for (const lz of [-1.8, 1.8]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 2.2, 8), grey);
      leg.position.set(lx, 1.1, lz);
      hab.add(leg);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 16), grey);
      pad.position.set(lx, 0.04, lz);
      hab.add(pad);
    }
  }
  // Airlock + ramp facing the route start (north).
  const lock = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 2.6, 24), white);
  lock.rotation.x = Math.PI / 2;
  lock.position.set(0, 2.6, -3.2);
  hab.add(lock);
  const hatch = new THREE.Mesh(new THREE.CircleGeometry(0.85, 24), dark);
  hatch.position.set(0, 2.6, -4.51);
  hatch.rotation.y = Math.PI;
  hab.add(hatch);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x56e0ff, emissiveIntensity: 2.5 });
  for (const lx of [-1.0, 1.0]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), lampMat);
    lamp.position.set(lx, 3.6, -4.45);
    hab.add(lamp);
  }
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 3.4), grey);
  ramp.position.set(0, 0.9, -5.9);
  ramp.rotation.x = 0.5;
  hab.add(ramp);
  hab.position.set(0, 0, 5);
  g.add(hab);

  // Solar field.
  for (let i = 0; i < 6; i++) {
    const panel = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 6), grey);
    post.position.y = 0.6;
    const face = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.05, 1.8), panelMat);
    face.position.y = 1.25;
    face.rotation.x = -0.45;
    panel.add(post, face);
    const px = -14 - (i % 3) * 3.8;
    const pz = 8 + Math.floor(i / 3) * 2.8;
    panel.position.set(px, terrain.heightAt(HAB.x + px, HAB.z + pz) - y0, pz);
    panel.rotation.y = 0.35;
    g.add(panel);
  }

  // Comms mast with dish (line-of-sight target for the comms model).
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 9, 8), grey);
  mast.position.set(9, 4.5, 6);
  g.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(1.1, 24, 12, 0, Math.PI * 2, 0, 0.9), white);
  dish.position.set(9, 9.2, 6);
  dish.rotation.x = -2.1;
  g.add(dish);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshStandardMaterial({ color: 0xff6040, emissive: 0xff3020, emissiveIntensity: 3 }));
  beacon.position.set(9, 9.1, 6);
  g.add(beacon);
  g.userData.beacon = beacon;
  g.userData.antennaTop = new THREE.Vector3(HAB.x + 9, y0 + 9.5, HAB.z + 6);

  // Ascent vehicle, a tall landmark a little further away.
  const av = new THREE.Group();
  const avBody = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.4, 16, 32), white);
  avBody.position.y = 10;
  const avNose = new THREE.Mesh(new THREE.ConeGeometry(2.0, 5, 32), white);
  avNose.position.y = 20.5;
  const avSkirt = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 1.2, 32), gold);
  avSkirt.position.y = 2.6;
  av.add(avBody, avNose, avSkirt);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 4.5, 8), grey);
    leg.position.set(Math.cos(a) * 3.2, 1.6, Math.sin(a) * 3.2);
    leg.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45);
    av.add(leg);
  }
  av.position.set(-48, terrain.heightAt(HAB.x - 48, HAB.z + 46) - y0, 46);
  g.add(av);

  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}
