// @ts-nocheck
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Walkable habitat interior (procedural, no assets). Local frame: floor at y = 0,
// the hall runs along Z. The player enters at the AIRLOCK end (+Z) and looks down
// the hall (-Z) towards the mission console.
//
//   const hab = createHabitatInterior({ getStatus });   // getStatus() -> { o2, power, dose, comms, met }
//   hab.group.position.set(0, 4000, 0);                 // park it far away; eva.js does this for you
//   hab.inside(x, z)      is this a walkable spot?  (accounts for walls + furniture)
//   hab.update(t)         refresh the live console screens
// ---------------------------------------------------------------------------

const std = (color, roughness = 0.6, metalness = 0.2, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

function canvasTexture(w, h, draw) {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const g = c && c.getContext ? c.getContext('2d') : null;
  if (!g) return { tex: new THREE.Texture(), redraw: () => {} };
  c.width = w;
  c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const redraw = (...a) => {
    draw(g, w, h, ...a);
    tex.needsUpdate = true;
  };
  redraw();
  return { tex, redraw };
}

const FONT = 'ui-monospace, Menlo, Consolas, monospace';

function screenDraw(title, rowsFn) {
  return (g, w, h, status = {}) => {
    g.fillStyle = '#03080a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(127,239,255,0.10)';
    g.fillRect(0, 0, w, 44);
    g.fillStyle = '#7fefff';
    g.font = `600 26px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillText(title, 18, 24);
    const rows = rowsFn(status);
    rows.forEach(([k, v, warn], i) => {
      const y = 92 + i * 52;
      g.fillStyle = 'rgba(127,239,255,0.6)';
      g.font = `22px ${FONT}`;
      g.fillText(k, 18, y);
      g.fillStyle = warn ? '#ffb454' : '#e6fdff';
      g.font = `600 30px ${FONT}`;
      g.textAlign = 'right';
      g.fillText(String(v), w - 18, y);
      g.textAlign = 'left';
    });
  };
}

export function createHabitatInterior({ getStatus = null } = {}) {
  const group = new THREE.Group();
  group.name = 'habitat-interior';

  const wall = std(0xcfd2d6, 0.7, 0.1);
  const panel = std(0xb9bdc3, 0.6, 0.2);
  const rib = std(0x8f959d, 0.5, 0.5);
  const dark = std(0x23262b, 0.7, 0.3);
  const orange = std(0xff7a2a, 0.6, 0.1);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff4e0 });
  const cyanMat = new THREE.MeshBasicMaterial({ color: 0x7fefff });

  const floorTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#41454b';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2c2f34';
    g.lineWidth = 3;
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * 32); g.lineTo(w, i * 32); g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 40; i++) g.fillRect(Math.random() * w, Math.random() * h, 12, 3);
  });
  floorTex.tex.wrapS = floorTex.tex.wrapT = THREE.RepeatWrapping;
  floorTex.tex.repeat.set(2.4, 6);
  const floorMat = std(0xffffff, 0.8, 0.3, { map: floorTex.tex });

  const add = (m, parent = group) => {
    m.castShadow = false;
    m.receiveShadow = false;
    parent.add(m);
    return m;
  };
  const box = (w, h, d, m, x, y, z) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    return add(o);
  };

  // ---- shell: hall z in [-6, 6], x in [-2.4, 2.4], height 2.8; airlock z in [6, 8.6], x in [-1.4, 1.4]
  const hall = { x: 2.4, z0: -6, z1: 6, h: 2.8 };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(hall.x * 2, 12), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 0);
  add(floor);
  const lockFloor = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.6), floorMat);
  lockFloor.rotation.x = -Math.PI / 2;
  lockFloor.position.set(0, 0.001, 7.3);
  add(lockFloor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(hall.x * 2, 12), panel);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, hall.h, 0);
  add(ceil);
  const lockCeil = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.6), panel);
  lockCeil.rotation.x = Math.PI / 2;
  lockCeil.position.set(0, hall.h, 7.3);
  add(lockCeil);

  box(0.1, hall.h, 12, wall, -hall.x - 0.05, hall.h / 2, 0); // left
  box(0.1, hall.h, 12, wall, hall.x + 0.05, hall.h / 2, 0); // right
  box(hall.x * 2 + 0.2, hall.h, 0.1, wall, 0, hall.h / 2, hall.z0 - 0.05); // console wall
  // wall at the airlock end with a doorway
  box(1.0, hall.h, 0.1, wall, -1.9, hall.h / 2, 6.05);
  box(1.0, hall.h, 0.1, wall, 1.9, hall.h / 2, 6.05);
  box(2.8, 0.6, 0.1, wall, 0, hall.h - 0.3, 6.05);
  // airlock chamber
  box(0.1, hall.h, 2.6, wall, -1.45, hall.h / 2, 7.3);
  box(0.1, hall.h, 2.6, wall, 1.45, hall.h / 2, 7.3);
  box(2.9, hall.h, 0.1, wall, 0, hall.h / 2, 8.65);

  // ribs every 2 m
  for (let z = -5; z <= 5; z += 2) {
    box(0.1, hall.h, 0.1, rib, -hall.x + 0.03, hall.h / 2, z);
    box(0.1, hall.h, 0.1, rib, hall.x - 0.03, hall.h / 2, z);
    box(hall.x * 2, 0.1, 0.1, rib, 0, hall.h - 0.03, z);
  }
  // ceiling light strips + pipes
  for (const x of [-0.9, 0.9]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 9), lampMat);
    strip.position.set(x, hall.h - 0.03, 0);
    add(strip);
  }
  for (const x of [-2.1, 2.1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 12, 10), std(x < 0 ? 0xff7a2a : 0x5aa0d0, 0.5, 0.5));
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(x, hall.h - 0.2, 0);
    add(pipe);
  }

  // ---- airlock hatch (outer door)
  const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.12, 32), dark);
  hatch.rotation.x = Math.PI / 2;
  hatch.position.set(0, 1.2, 8.57);
  add(hatch);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.04, 8, 24), rib);
  wheel.position.set(0, 1.2, 8.5);
  add(wheel);
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.04, 0.04), rib);
    spoke.position.set(0, 1.2, 8.5);
    spoke.rotation.z = (i / 3) * Math.PI;
    add(spoke);
  }
  const warn = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff8a40 }));
  warn.position.set(1.0, 2.2, 8.55);
  add(warn);
  const stripe = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.35), new THREE.MeshBasicMaterial({ color: 0xffb020 }));
  stripe.rotation.x = -Math.PI / 2;
  stripe.position.set(0, 0.004, 6.1);
  add(stripe);

  // ---- mission console (south end of the hall = -Z)
  box(4.4, 0.9, 0.7, dark, 0, 0.45, -5.45);
  box(4.4, 0.05, 0.8, rib, 0, 0.92, -5.45);
  const screens = [];
  const defs = [
    ['LIFE SUPPORT', (s) => [['O2 REMAINING', s.o2 ?? '--:--'], ['SUIT POWER', s.power ?? '--'], ['DOSE', s.dose ?? '--'], ['EVA CLOCK', s.met ?? '--:--:--']]],
    ['COMMS', (s) => [['LINK', s.comms ?? 'LOS'], ['RELAY', 'ORBITER'], ['HAB POWER', '100 %'], ['CREW', 'IN HAB']]],
    ['HABITAT', () => [['PRESSURE', '101.3 kPa'], ['CABIN TEMP', '21 C'], ['CO2', '0.4 kPa'], ['AIRLOCK', 'CLOSED']]],
  ];
  defs.forEach(([title, rows], i) => {
    const ct = canvasTexture(512, 320, screenDraw(title, rows));
    const m = new THREE.MeshBasicMaterial({ map: ct.tex });
    const s = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 0.78), m);
    s.position.set(-1.45 + i * 1.45, 1.55, -5.72);
    s.rotation.x = -0.12;
    add(s);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.33, 0.86, 0.05), dark);
    frame.position.set(s.position.x, s.position.y, -5.76);
    frame.rotation.x = -0.12;
    add(frame);
    screens.push(ct);
  });
  // chair
  box(0.5, 0.06, 0.5, dark, 0, 0.5, -4.4);
  box(0.5, 0.55, 0.06, dark, 0, 0.8, -4.18);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 8), rib);
  post.position.set(0, 0.25, -4.4);
  add(post);

  // ---- lab bench (left wall)
  box(0.7, 0.9, 3.0, std(0x9aa0a8, 0.5, 0.4), -2.0, 0.45, -1.7);
  box(0.74, 0.04, 3.04, dark, -2.0, 0.92, -1.7);
  for (let i = 0; i < 6; i++) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.16, 8), cyanMat);
    tube.position.set(-2.1, 1.02, -2.9 + i * 0.12);
    add(tube);
  }
  box(0.35, 0.28, 0.35, rib, -1.95, 1.08, -1.5);
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 10), dark);
  scope.position.set(-1.95, 1.32, -1.5);
  scope.rotation.z = 0.35;
  add(scope);
  box(0.4, 0.3, 0.5, orange, -2.05, 1.09, -0.55);

  // ---- bunks (right wall)
  for (const [y, c] of [[0.5, 0x3a5f8a], [1.5, 0x8a4a3a]]) {
    box(0.9, 0.12, 2.0, dark, 1.9, y, -3.2);
    box(0.84, 0.1, 1.9, std(c, 0.9, 0), 1.9, y + 0.1, -3.2);
  }
  box(0.06, 1.4, 2.0, dark, 2.35, 1.0, -3.2);

  // ---- lockers (right wall)
  for (let i = 0; i < 4; i++) {
    box(0.5, 2.2, 0.95, std(0xaab0b8, 0.5, 0.4), 2.1, 1.1, 0.8 + i * 1.1);
    box(0.02, 0.3, 0.04, dark, 1.84, 1.2, 0.8 + i * 1.1 + 0.3);
  }

  // ---- round windows with a Mars view (left wall, between lab bench and airlock)
  const view = canvasTexture(256, 256, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
    sky.addColorStop(0, '#9a6f55');
    sky.addColorStop(1, '#e0ad86');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    const sun = g.createRadialGradient(w * 0.7, h * 0.4, 2, w * 0.7, h * 0.4, 70);
    sun.addColorStop(0, 'rgba(255,245,230,0.95)');
    sun.addColorStop(1, 'rgba(255,220,180,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#7a4a34';
    g.beginPath();
    g.moveTo(0, h * 0.62);
    for (let x = 0; x <= w; x += 16) g.lineTo(x, h * (0.6 + 0.04 * Math.sin(x * 0.07) + 0.02 * Math.sin(x * 0.19)));
    g.lineTo(w, h); g.lineTo(0, h); g.fill();
    g.fillStyle = '#9a6244';
    g.fillRect(0, h * 0.72, w, h * 0.28);
  });
  for (const z of [2.6, 4.4]) {
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.36, 28), new THREE.MeshBasicMaterial({ map: view.tex }));
    glass.rotation.y = Math.PI / 2;
    glass.position.set(-hall.x + 0.005, 1.55, z);
    add(glass);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.045, 8, 28), rib);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(-hall.x + 0.02, 1.55, z);
    add(ring);
  }

  // ---- lighting (only active while this group is in the scene)
  group.add(new THREE.AmbientLight(0xfff1e0, 1.1));
  for (const z of [-3.5, 0, 3.5]) {
    const p = new THREE.PointLight(0xfff0dc, 7, 9, 2);
    p.position.set(0, 2.5, z);
    group.add(p);
  }
  const lockLight = new THREE.PointLight(0xffd9b0, 4, 5, 2);
  lockLight.position.set(0, 2.4, 7.3);
  group.add(lockLight);

  // ---- walking rules: hall + airlock footprint minus furniture
  const colliders = [
    { x0: -2.2, x1: 2.2, z0: -5.85, z1: -5.0 }, // console desk
    { x0: -0.35, x1: 0.35, z0: -4.7, z1: -4.1 }, // chair
    { x0: -2.4, x1: -1.62, z0: -3.3, z1: -0.1 }, // lab bench
    { x0: 1.45, x1: 2.4, z0: -4.3, z1: -2.1 }, // bunks
    { x0: 1.82, x1: 2.4, z0: 0.3, z1: 5.3 }, // lockers
  ];
  const R = 0.3;
  const inFootprint = (x, z) => {
    const inHall = Math.abs(x) <= hall.x - R && z >= hall.z0 + R && z <= hall.z1;
    const inLock = Math.abs(x) <= 1.4 - R && z > hall.z1 - 0.01 && z <= 8.6 - R;
    return inHall || inLock;
  };
  const inside = (x, z) => {
    if (!inFootprint(x, z)) return false;
    return !colliders.some((c) => x > c.x0 - R && x < c.x1 + R && z > c.z0 - R && z < c.z1 + R);
  };

  let acc = 1;
  const update = (t, dt = 0.016) => {
    warn.visible = Math.sin(t * 3) > -0.2;
    acc += dt;
    if (acc < 0.3) return;
    acc = 0;
    const s = getStatus ? getStatus() || {} : {};
    screens.forEach((sc) => sc.redraw(s));
  };

  return { group, spawn: { x: 0, z: 6.9 }, exitZ: 7.45, doorZ: 8.6, colliders, inside, update, eyeHeight: 1.65 };
}