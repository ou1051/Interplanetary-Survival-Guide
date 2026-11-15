import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { wornMetal } from '../world/surfaceTextures.js';

// ---------------------------------------------------------------------------
// Two-seat open-frame rover, v2 (reference sheet: front / side / top views).
// Same frame and footprint as the in-game Rover: -Z forward, +X right, +Y up,
// origin on the ground at the centre; wheel centres at (±0.95, 0.41, ±1.15).
// Returns { group, wheels: [{ pivot, spin, sx, sz }] } so it can be swapped in.
// ---------------------------------------------------------------------------

const WHEEL_R = 0.41;
const WHEEL_X = 0.95;
const WHEEL_Z = 1.15;

function canvasTex(w, h, paint, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function solarTexture() {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#1c2540'; g.fillRect(0, 0, w, h);
    const n = 10;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = 30 + Math.random() * 14;
      g.fillStyle = `rgb(${v * 0.8},${v},${v * 1.9})`;
      g.fillRect(i * w / n + 2, j * h / n + 2, w / n - 4, h / n - 4);
    }
    g.strokeStyle = 'rgba(200,210,230,.55)'; g.lineWidth = 1;
    for (let i = 0; i <= n; i++) {
      g.beginPath(); g.moveTo(i * w / n, 0); g.lineTo(i * w / n, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * h / n); g.lineTo(w, i * h / n); g.stroke();
    }
  });
}

function hazardTexture() {
  const t = canvasTex(256, 32, (g, w, h) => {
    g.fillStyle = '#151515'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2b51c';
    for (let x = -32; x < w + 32; x += 32) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 16, h); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.fill(); }
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

function seatTexture() {
  return canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = '#1b1c1f'; g.fillRect(0, 0, w, h);
    for (let y = 18; y < h; y += 26) { g.fillStyle = '#0c0d0f'; g.fillRect(8, y, w - 16, 4); g.fillStyle = '#2a2b30'; g.fillRect(8, y + 4, w - 16, 2); }
  });
}

function caseTexture() {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 3;
    g.strokeRect(10, 10, w - 20, h - 20); // lid seam / ribs
    g.beginPath(); g.moveTo(10, h * 0.32); g.lineTo(w - 10, h * 0.32); g.stroke();
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(120,60,20,${Math.random() * 0.08})`; g.fillRect(Math.random() * w, Math.random() * h, 3, 3); }
    const d = g.createLinearGradient(0, h * 0.6, 0, h); d.addColorStop(0, 'rgba(150,80,40,0)'); d.addColorStop(1, 'rgba(150,80,40,.35)');
    g.fillStyle = d; g.fillRect(0, 0, w, h);
  });
}

function tube(points, radius, mat) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.05);
  return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(32, points.length * 20), radius, 12), mat);
}

// Polyline with rounded corners (bent tube, like a roll cage).
function bentTube(points, radius, bend, mat) {
  const P = points.map((p) => new THREE.Vector3(...p));
  const path = new THREE.CurvePath();
  let prev = P[0].clone();
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], c = P[i + 1];
    if (!c) { path.add(new THREE.LineCurve3(prev, b)); break; }
    const inP = b.clone().addScaledVector(a.clone().sub(b).normalize(), Math.min(bend, a.distanceTo(b) / 2));
    const outP = b.clone().addScaledVector(c.clone().sub(b).normalize(), Math.min(bend, c.distanceTo(b) / 2));
    path.add(new THREE.LineCurve3(prev, inP));
    path.add(new THREE.QuadraticBezierCurve3(inP, b, outP));
    prev = outP;
  }
  return new THREE.Mesh(new THREE.TubeGeometry(path, P.length * 40, radius, 12), mat);
}

// Options let the in-game Rover keep its own live console and seat positions:
//   console: false  → skip the simple console block (the Rover adds its screen console)
//   seat: {x, y, z} → seat placement to match the seated crew
export function buildRoverV2(envMap, { console: withConsole = true, seat = { x: 0.36, y: 0.7, z: 0.2 } } = {}) {
  // chrome keeps only the roughness/normal detail; the dust colour map would tint it copper
  const { roughnessMap, normalMap } = wornMetal({ seed: 5, dust: 0.35 });
  const metal = { roughnessMap, normalMap };
  const M = {
    chrome: new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 0.9, roughness: 0.3, ...metal, envMap, envMapIntensity: 0.9 }),
    body: new THREE.MeshStandardMaterial({ color: 0x232427, metalness: 0.35, roughness: 0.55, ...wornMetal({ seed: 9, dust: 0.6 }), envMap }),
    fender: new THREE.MeshStandardMaterial({ color: 0xd9d6d0, metalness: 0.2, roughness: 0.55, ...wornMetal({ seed: 13, dust: 0.45 }), envMap }),
    orange: new THREE.MeshStandardMaterial({ color: 0xf28a12, metalness: 0.05, roughness: 0.48, map: caseTexture(), envMap, envMapIntensity: 0.5 }),
    latch: new THREE.MeshStandardMaterial({ color: 0xd8dadd, metalness: 0.9, roughness: 0.25, envMap }),
    tire: new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.9 }),
    hub: new THREE.MeshStandardMaterial({ color: 0x2c2d30, metalness: 0.6, roughness: 0.4, envMap }),
    seat: new THREE.MeshStandardMaterial({ map: seatTexture(), roughness: 0.85 }),
    solar: new THREE.MeshStandardMaterial({ map: solarTexture(), metalness: 0.4, roughness: 0.18, envMap, envMapIntensity: 1.3 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.35, metalness: 0.05, envMap }),
    dish: new THREE.MeshStandardMaterial({ color: 0xc8c2b8, roughness: 0.45, metalness: 0.4, side: THREE.DoubleSide, envMap }),
    hazard: new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.6 }),
    lens: new THREE.MeshStandardMaterial({ color: 0xfffbf0, emissive: 0xfff2d0, emissiveIntensity: 0.6, roughness: 0.1 }),
    red: new THREE.MeshStandardMaterial({ color: 0xff2a1a, emissive: 0xff1a0a, emissiveIntensity: 2.5 }),
    black: new THREE.MeshStandardMaterial({ color: 0x0e0e10, roughness: 0.6 }),
  };
  const group = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = group) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  // ---------------------------------------------------------------- chassis
  add(new RoundedBoxGeometry(1.5, 0.2, 3.3, 3, 0.04), M.body, 0, 0.58, 0.05);       // main tub
  add(new RoundedBoxGeometry(1.42, 0.34, 0.42, 3, 0.05), M.body, 0, 0.78, -1.42);   // front nose block
  add(new RoundedBoxGeometry(1.5, 0.12, 0.85, 3, 0.03), M.body, 0, 0.74, 1.27);     // rear cargo bed
  add(new RoundedBoxGeometry(1.52, 0.1, 0.12, 2, 0.03), M.hazard, 0, 0.66, 1.72).material.map.repeat.set(4, 1); // rear bumper stripe
  // headlights with chrome bezels
  const lenses = [];
  for (const x of [-0.42, 0.42]) {
    const bezel = add(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 28), M.chrome, x, 0.8, -1.65);
    bezel.rotation.x = Math.PI / 2;
    const lens = add(new THREE.CircleGeometry(0.095, 28), M.lens, x, 0.8, -1.692);
    lens.rotation.y = Math.PI;
    lenses.push(lens);
  }
  // tow T-handle on the nose
  add(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 10), M.chrome, 0, 0.78, -1.7).rotation.x = Math.PI / 2;
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.18, 10), M.chrome, 0, 0.78, -1.8).rotation.z = Math.PI / 2;
  // small orange utility boxes at the front corners
  for (const sx of [-1, 1]) add(new RoundedBoxGeometry(0.3, 0.2, 0.3, 2, 0.03), M.orange, sx * 0.55, 0.75, -1.05);
  // angled black console in front of the seats
  if (withConsole) {
    const consolePanel = add(new RoundedBoxGeometry(1.1, 0.42, 0.06, 2, 0.02), M.body, 0, 1.05, -0.86);
    consolePanel.rotation.x = -0.75;
    add(new RoundedBoxGeometry(1.2, 0.3, 0.3, 2, 0.03), M.body, 0, 0.8, -0.85);
  }

  // ---------------------------------------------------------------- wheels + fenders
  const wheels = [];
  const tireGeo = new THREE.TorusGeometry(WHEEL_R - 0.06, 0.07, 14, 48).rotateY(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(WHEEL_R - 0.08, WHEEL_R - 0.08, 0.2, 40, 1, true).rotateZ(Math.PI / 2);
  const spokes = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const s = new THREE.BoxGeometry(0.03, 0.2, 0.035);
      s.translate(0, 0.17, 0); s.rotateZ(0); s.rotateX(a + side * 0.18); s.translate(side * 0.06, 0, 0);
      spokes.push(s);
    }
  }
  const spokeGeo = mergeGeometries(spokes);
  const hubGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.22, 24).rotateZ(Math.PI / 2);
  const capGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.24, 24).rotateZ(Math.PI / 2);
  // fender: thick quarter-shell over the wheel
  const fenderShape = new THREE.Shape();
  const Rf = WHEEL_R + 0.1, Ri = WHEEL_R + 0.04;
  fenderShape.absarc(0, 0, Rf, 0.15, Math.PI - 0.15, false);
  fenderShape.absarc(0, 0, Ri, Math.PI - 0.15, 0.15, true);
  const fenderGeo = new THREE.ExtrudeGeometry(fenderShape, { depth: 0.3, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 2, curveSegments: 32 });
  fenderGeo.translate(0, 0, -0.15).rotateY(Math.PI / 2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * WHEEL_X, WHEEL_R, sz * WHEEL_Z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(tireGeo, M.tire), new THREE.Mesh(rimGeo, M.chrome), new THREE.Mesh(spokeGeo, M.chrome), new THREE.Mesh(hubGeo, M.hub), new THREE.Mesh(capGeo, M.black));
    pivot.add(spin);
    group.add(pivot);
    wheels.push({ pivot, spin, sx, sz, offset: 0 });
    add(fenderGeo, M.fender, sx * WHEEL_X, WHEEL_R + 0.02, sz * WHEEL_Z);
    // suspension arm to the tub
    group.add(tube([[sx * WHEEL_X, WHEEL_R, sz * WHEEL_Z], [sx * 0.72, 0.56, sz * (WHEEL_Z - 0.18)]], 0.03, M.chrome));
  }

  // ---------------------------------------------------------------- roll cage
  const r = 0.032;
  for (const sx of [-1, 1]) {
    const x = sx * 0.74;
    // side profile: front foot → A-pillar → roof → rear post → bed
    group.add(bentTube([[x, 0.68, -0.98], [x, 1.2, -0.72], [x, 1.98, -0.42], [x, 1.98, 0.95], [x, 0.78, 0.95]], r, 0.16, M.chrome));
    group.add(bentTube([[x, 1.12, -0.7], [x, 1.12, 0.95]], r * 0.8, 0.05, M.chrome)); // waist rail
  }
  // cross bars front + rear of the roof
  for (const z of [-0.42, 0.95]) group.add(bentTube([[-0.74, 1.98, z], [0.74, 1.98, z]], r, 0.05, M.chrome));

  // ---------------------------------------------------------------- roof gear
  add(new THREE.BoxGeometry(1.4, 0.035, 1.3), M.solar, 0, 2.03, 0.27);
  add(new THREE.BoxGeometry(1.44, 0.03, 1.34), M.chrome, 0, 2.005, 0.27);
  add(new THREE.SphereGeometry(0.12, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.white, -0.22, 2.05, 0.05);
  add(new RoundedBoxGeometry(0.34, 0.12, 0.3, 2, 0.02), M.orange, 0.05, 2.1, 0.35);
  const tips = [];
  for (const [x, z, h] of [[0.42, 0.75, 0.75], [0.52, 0.85, 0.95]]) {
    add(new THREE.CylinderGeometry(0.008, 0.012, h, 8), M.black, x, 2.05 + h / 2, z);
    tips.push(add(new THREE.SphereGeometry(0.03, 12, 8), M.red, x, 2.05 + h, z));
  }
  // dish on a mast at the rear right
  add(new THREE.CylinderGeometry(0.03, 0.035, 0.75, 12), M.chrome, 0.58, 2.38, 1.0);
  const dish = new THREE.Group();
  dish.position.set(0.58, 2.8, 1.0);
  dish.rotation.set(-0.75, 0, 0.35);
  const dishGeo = new THREE.SphereGeometry(0.75, 40, 8, 0, Math.PI * 2, 0, 0.42);
  dishGeo.scale(1, 0.55, 1).translate(0, -0.75 * 0.55, 0);
  const d = new THREE.Mesh(dishGeo, M.dish); d.rotation.x = Math.PI; dish.add(d);
  const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8), M.chrome); feed.position.y = 0.12; dish.add(feed);
  group.add(dish);

  // ---------------------------------------------------------------- seats
  for (const sx of [-1, 1]) {
    const chair = new THREE.Group();
    chair.position.set(sx * seat.x, seat.y, seat.z);
    const pan = new THREE.Mesh(new RoundedBoxGeometry(0.48, 0.1, 0.48, 3, 0.04), M.seat); pan.position.y = 0.06;
    const back = new THREE.Mesh(new RoundedBoxGeometry(0.48, 0.66, 0.1, 3, 0.04), M.seat); back.position.set(0, 0.42, 0.26); back.rotation.x = 0.14;
    chair.add(pan, back);
    for (const ox of [-0.26, 0.26]) chair.add(bentTube([[ox, 0.02, -0.22], [ox, 0.02, 0.3], [ox, 0.8, 0.4]], 0.016, 0.06, M.chrome));
    chair.add(bentTube([[-0.26, 0.8, 0.4], [0.26, 0.8, 0.4]], 0.016, 0.03, M.chrome));
    group.add(chair);
  }

  // ---------------------------------------------------------------- rear cargo cases
  const latchGeo = new RoundedBoxGeometry(0.07, 0.09, 0.02, 2, 0.008);
  for (const sx of [-1, 1]) {
    const box = add(new RoundedBoxGeometry(0.66, 0.4, 0.62, 3, 0.035), M.orange, sx * 0.36, 1.0, 1.28);
    for (const lx of [-0.17, 0.17]) {
      const latch = new THREE.Mesh(latchGeo, M.latch); latch.position.set(lx, 0.06, -0.32); box.add(latch);
      const latch2 = new THREE.Mesh(latchGeo, M.latch); latch2.position.set(sx * 0.335, 0.06, lx); latch2.rotation.y = Math.PI / 2; box.add(latch2);
    }
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.01, 6, 16, Math.PI), M.latch);
    handle.position.set(0, 0.2, 0); handle.rotation.x = -Math.PI / 2; box.add(handle);
  }

  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group, wheels, lenses, antennaTip: tips[1], materials: M };
}
