import * as THREE from 'three';
import { mulberry32 } from '../core/math.js';

// ---------------------------------------------------------------------------
// Welcome shot: the surface habitat seen from outside at Martian dusk.
// The camera slowly circles the module; flyIn() pushes it to the lit window
// so the welcome screen can cut to the interior console.
// Self-contained Three.js scene; disposed once the player is inside.
// ---------------------------------------------------------------------------

function canvasTexture(size, paint) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paint(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 512;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, '#1d1f2b'); // dusk zenith
  grd.addColorStop(0.38, '#5a4250');
  grd.addColorStop(0.62, '#b8714c');
  grd.addColorStop(0.74, '#e2a06e'); // horizon haze
  grd.addColorStop(1, '#c9825a');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function mountHabitatExterior(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = skyTexture();
  scene.fog = new THREE.FogExp2('#b9785a', 0.0105);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 800);
  const random = mulberry32(214);
  const disposables = [];
  const keep = (x) => (disposables.push(x), x);

  // ------------------------------------------------------------ materials
  const hullMap = keep(canvasTexture(512, (g, s) => {
    g.fillStyle = '#d8d3c8';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 4000; i++) {
      g.globalAlpha = random() * 0.06;
      g.fillStyle = random() > 0.5 ? '#ffffff' : '#7d7466';
      g.fillRect(random() * s, random() * s, random() * 6 + 1, 1);
    }
    g.globalAlpha = 1;
    g.strokeStyle = '#9c968a';
    g.lineWidth = 2;
    for (let x = 0; x <= s; x += s / 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
    for (let y = 0; y <= s; y += s / 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
    g.fillStyle = '#8a8478';
    for (let x = 0; x <= s; x += s / 8) for (let y = 6; y < s; y += 16) { g.fillRect(x - 5, y, 2, 2); g.fillRect(x + 3, y, 2, 2); }
    for (let i = 0; i < 6; i++) { // a few slightly different shielding panels
      g.fillStyle = i % 2 ? '#e4e0d6' : '#c9c3b6';
      const px = Math.floor(random() * 8) * (s / 8);
      const py = Math.floor(random() * 4) * (s / 4);
      g.fillRect(px + 2, py + 2, s / 8 - 4, s / 4 - 4);
    }
    // dust settled on the lower half
    const dust = g.createLinearGradient(0, s * 0.55, 0, s);
    dust.addColorStop(0, 'rgba(160,96,60,0)');
    dust.addColorStop(1, 'rgba(160,96,60,0.55)');
    g.fillStyle = dust;
    g.fillRect(0, 0, s, s);
  }));
  hullMap.repeat.set(3, 1);
  const groundMap = keep(canvasTexture(256, (g, s) => {
    g.fillStyle = '#8f5233';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      g.globalAlpha = random() * 0.13;
      g.fillStyle = ['#c7834f', '#5e3220', '#a8653c'][i % 3];
      g.fillRect(random() * s, random() * s, random() * 3 + 1, random() * 3 + 1);
    }
  }));
  groundMap.repeat.set(60, 60);
  const panelMap = keep(canvasTexture(256, (g, s) => {
    g.fillStyle = '#121a2c';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = '#3b4c74';
    g.lineWidth = 2;
    for (let x = 0; x <= s; x += s / 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
    for (let y = 0; y <= s; y += s / 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
  }));

  const M = {
    hull: keep(new THREE.MeshStandardMaterial({ map: hullMap, roughness: 0.62, metalness: 0.15 })),
    cap: keep(new THREE.MeshStandardMaterial({ color: '#cfc9bd', roughness: 0.55, metalness: 0.2 })),
    steel: keep(new THREE.MeshStandardMaterial({ color: '#6c6f72', roughness: 0.45, metalness: 0.7 })),
    dark: keep(new THREE.MeshStandardMaterial({ color: '#25282b', roughness: 0.7, metalness: 0.3 })),
    orange: keep(new THREE.MeshStandardMaterial({ color: '#d0612a', roughness: 0.5 })),
    window: keep(new THREE.MeshStandardMaterial({ color: '#ffd59a', emissive: '#ffb45e', emissiveIntensity: 2.6 })),
    lamp: keep(new THREE.MeshStandardMaterial({ color: '#ff3b2f', emissive: '#ff2a1c', emissiveIntensity: 3 })),
    panel: keep(new THREE.MeshStandardMaterial({ map: panelMap, roughness: 0.3, metalness: 0.65 })),
    foil: keep(new THREE.MeshStandardMaterial({ color: '#c9a24a', roughness: 0.35, metalness: 0.85 })),
    ground: keep(new THREE.MeshStandardMaterial({ map: groundMap, roughness: 1 })),
    rock: keep(new THREE.MeshStandardMaterial({ color: '#7a432a', roughness: 1, flatShading: true })),
    track: keep(new THREE.MeshBasicMaterial({ color: '#4a2516', transparent: true, opacity: 0.35, depthWrite: false })),
  };
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = scene) => {
    keep(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // ------------------------------------------------------------ lights
  scene.add(new THREE.HemisphereLight('#f1c39f', '#4a2616', 0.75));
  const sun = new THREE.DirectionalLight('#ffd1a0', 2.6);
  sun.position.set(-32, 13, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 18, bottom: -10, near: 1, far: 120 });
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  const rim = new THREE.DirectionalLight('#9fb8ff', 0.55); // the blue glow around a Martian sunset
  rim.position.set(-40, 6, -40);
  scene.add(rim);

  // ------------------------------------------------------------ terrain
  const groundGeo = new THREE.PlaneGeometry(420, 420, 140, 140);
  groundGeo.rotateX(-Math.PI / 2);
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    const flat = Math.min(1, Math.max(0, (r - 16) / 30)); // level pad around the habitat
    const h = (Math.sin(x * 0.045) * 1.6 + Math.sin(z * 0.06 + 1.3) * 1.2 + Math.sin((x + z) * 0.16) * 0.35) * flat
      + Math.max(0, -z - 90) * 0.08 * Math.max(0, Math.sin(x * 0.02) + 1.2); // rising ridge to the north
    pos.setY(i, h);
  }
  groundGeo.computeVertexNormals();
  const ground = add(groundGeo, M.ground);
  ground.castShadow = false;

  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  for (let i = 0; i < 140; i++) {
    const a = random() * Math.PI * 2;
    const r = 9 + random() ** 0.7 * 70;
    const s = 0.12 + random() ** 3 * 1.4;
    const rock = add(rockGeo, M.rock, Math.cos(a) * r, s * 0.25, Math.sin(a) * r);
    rock.scale.set(s, s * 0.6, s * (0.8 + random() * 0.6));
    rock.rotation.set(random() * 3, random() * 3, random() * 3);
  }

  // ------------------------------------------------------------ habitat
  const hab = new THREE.Group();
  scene.add(hab);
  const Y = 3.2; // hull centre height
  const R = 2.3;
  const L = 9;
  const hull = add(new THREE.CylinderGeometry(R, R, L, 56, 1, true), M.hull, 0, Y, 0, hab);
  hull.rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) {
    const cap = add(new THREE.SphereGeometry(R, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), M.cap, s * L / 2, Y, 0, hab);
    cap.rotation.z = -s * Math.PI / 2;
    cap.scale.y = 0.42;
    for (const x of [s * 1.6, s * (L / 2 - 0.15)]) {
      const band = add(new THREE.TorusGeometry(R + 0.03, 0.07, 8, 56), x === s * 1.6 ? M.orange : M.steel, x, Y, 0, hab);
      band.rotation.y = Math.PI / 2;
    }
  }
  // lit window row on the camera side
  const windowGeo = new THREE.BoxGeometry(0.95, 0.5, 0.08);
  const frameGeo = new THREE.BoxGeometry(1.15, 0.7, 0.06);
  const phi = 0.22; // just above the hull's equator
  const windows = [];
  for (const x of [-2.6, -1.3, 0, 1.3, 2.6]) {
    const wy = Y + Math.sin(phi) * R;
    const wz = Math.cos(phi) * R;
    const f = add(frameGeo, M.dark, x, wy, wz - 0.01, hab);
    f.rotation.x = -phi;
    const w = add(windowGeo, M.window, x, wy, wz + 0.02, hab);
    w.rotation.x = -phi;
    w.castShadow = false;
    windows.push(w);
  }
  const glow = new THREE.PointLight('#ffb766', 14, 9, 1.6);
  glow.position.set(0, Y + 0.3, R + 1.6);
  hab.add(glow);

  // legs and footpads
  for (const x of [-3.2, 3.2]) for (const z of [-1.5, 1.5]) {
    const leg = add(new THREE.CylinderGeometry(0.09, 0.12, 2.7, 10), M.steel, x * 1.06, Y - 1.9, z * 1.18, hab);
    leg.rotation.z = x > 0 ? -0.12 : 0.12;
    leg.rotation.x = z > 0 ? 0.18 : -0.18;
    add(new THREE.CylinderGeometry(0.45, 0.55, 0.12, 18), M.dark, x * 1.13, 0.06, z * 1.35, hab);
  }
  // radiators and foil on the roof
  for (const x of [-2.4, 2.4]) {
    const rad = add(new THREE.BoxGeometry(2.6, 0.05, 1.4), M.cap, x, Y + R + 0.25, -0.3, hab);
    rad.rotation.x = 0.12;
    add(new THREE.BoxGeometry(0.08, 0.35, 0.08), M.steel, x, Y + R + 0.05, -0.3, hab);
  }
  add(new THREE.BoxGeometry(1.6, 0.35, 1.0), M.foil, 0, Y + R + 0.1, 0.4, hab);
  // comms dish + mast with beacon
  const dish = add(new THREE.SphereGeometry(0.9, 24, 12, 0, Math.PI * 2, 0, 0.75), M.cap, 0, Y + R + 1.25, -0.6, hab);
  dish.rotation.x = -2.2;
  add(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 8), M.steel, 0, Y + R + 0.55, -0.6, hab);
  add(new THREE.CylinderGeometry(0.035, 0.035, 3.2, 6), M.steel, 3.6, Y + R + 1.2, -0.8, hab);
  const beacon = add(new THREE.SphereGeometry(0.12, 12, 8), M.lamp, 3.6, Y + R + 2.85, -0.8, hab);

  // airlock module with hatch, step ladder and hatch light
  const lock = new THREE.Group();
  lock.position.set(-L / 2 - 1.3, 0, 1.2);
  hab.add(lock);
  const lockHull = add(new THREE.CylinderGeometry(1.25, 1.25, 2.6, 36), M.hull, 0, 2.5, 0, lock);
  lockHull.rotation.x = Math.PI / 2;
  const hatchRing = add(new THREE.TorusGeometry(0.8, 0.09, 8, 32), M.orange, 0, 2.5, 1.33, lock);
  add(new THREE.CircleGeometry(0.78, 32), M.dark, 0, 2.5, 1.31, lock);
  hatchRing.castShadow = false;
  add(new THREE.BoxGeometry(1.2, 0.08, 2.2), M.steel, 0, 1.25, 2.3, lock).rotation.x = 0.55;
  add(new THREE.SphereGeometry(0.07, 8, 6), M.window, 0, 3.55, 1.25, lock);
  const hatchLight = new THREE.PointLight('#ffc27a', 6, 6, 1.8);
  hatchLight.position.set(0, 3.5, 1.9);
  lock.add(hatchLight);
  add(new THREE.CylinderGeometry(0.9, 0.9, 1.3, 20), M.cap, L / 2 + 1.0, Y, 0, hab).rotation.z = Math.PI / 2; // tunnel stub

  // ---------------------------------------------------------- detail pass
  // structural ribs
  for (const x of [-3.4, -0.8, 0.8, 3.4]) {
    const rib = add(new THREE.TorusGeometry(R + 0.02, 0.035, 6, 56), M.steel, x, Y, 0, hab);
    rib.rotation.y = Math.PI / 2;
  }
  // EVA handrails along both upper flanks (rail + stand-offs)
  for (const side of [-1, 1]) {
    const a = side * 0.95; // angle from the top
    const ry = Y + Math.cos(a) * (R + 0.18);
    const rz = Math.sin(a) * (R + 0.18);
    const rail = add(new THREE.CylinderGeometry(0.03, 0.03, 7.4, 6), M.orange, 0, ry, rz, hab);
    rail.rotation.z = Math.PI / 2;
    for (let x = -3.5; x <= 3.5; x += 1.0) {
      const post = add(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 5), M.steel, x, Y + Math.cos(a) * (R + 0.08), Math.sin(a) * (R + 0.08), hab);
      post.rotation.x = a;
    }
  }
  // hull markings: name plate and orange stripe under the windows
  const plate = keep(canvasTexture(512, (g) => {
    g.clearRect(0, 0, 512, 512);
    g.fillStyle = '#1b1d20';
    g.font = '700 50px Helvetica, Arial, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('SURFACE HABITAT 1', 18, 150);
    g.font = '600 30px Helvetica, Arial, sans-serif';
    g.fillStyle = '#3a3c40';
    g.fillText('EVA-01 · GALE CRATER · SOL 214', 20, 210);
    g.fillStyle = '#d0612a';
    g.fillRect(18, 250, 476, 12);
  }));
  plate.wrapS = plate.wrapT = THREE.ClampToEdgeWrapping;
  const plateMat = keep(new THREE.MeshStandardMaterial({ map: plate, transparent: true, roughness: 0.7 }));
  const pa = -0.42; // below the window row
  const decal = add(new THREE.PlaneGeometry(3.4, 3.4), plateMat, -1.6, Y + Math.sin(pa) * (R + 0.012) - 0.2, Math.cos(pa) * (R + 0.012), hab);
  decal.rotation.x = -pa;
  decal.castShadow = false;
  // hazard chevrons around the airlock hatch
  const chevron = keep(canvasTexture(128, (g) => {
    for (let i = -4; i < 8; i++) {
      g.fillStyle = i % 2 ? '#1b1b1b' : '#e2a12b';
      g.beginPath();
      g.moveTo(i * 16, 0); g.lineTo(i * 16 + 16, 0); g.lineTo(i * 16 + 48, 128); g.lineTo(i * 16 + 32, 128);
      g.fill();
    }
  }));
  const chev = add(new THREE.RingGeometry(0.9, 1.08, 40), keep(new THREE.MeshStandardMaterial({ map: chevron, roughness: 0.6 })), 0, 2.5, 1.315, lock);
  chev.castShadow = false;
  // RCS thruster quads on both end caps
  for (const s of [-1, 1]) for (const a of [0.7, -0.7]) {
    const pod = new THREE.Group();
    pod.position.set(s * (L / 2 - 0.6), Y + Math.sin(a) * (R + 0.15), Math.cos(a) * (R + 0.15));
    pod.rotation.x = -a;
    hab.add(pod);
    add(new THREE.BoxGeometry(0.34, 0.22, 0.22), M.cap, 0, 0, 0, pod);
    for (const [dx, dy] of [[0.2, 0], [-0.2, 0], [0, 0.14]]) {
      const n = add(new THREE.ConeGeometry(0.05, 0.13, 10, 1, true), M.dark, dx, dy, 0, pod);
      n.rotation.z = dx ? -Math.sign(dx) * Math.PI / 2 : 0;
    }
  }
  // landing-leg braces and shock pistons
  for (const x of [-3.2, 3.2]) for (const z of [-1.5, 1.5]) {
    const brace = add(new THREE.CylinderGeometry(0.045, 0.045, 2.2, 6), M.steel, x * 0.82, Y - 1.4, z * 0.9, hab);
    brace.rotation.z = x > 0 ? 0.55 : -0.55;
    add(new THREE.CylinderGeometry(0.16, 0.16, 0.6, 10), M.dark, x * 1.1, 0.75, z * 1.3, hab);
  }
  // inflatable module beyond the tunnel stub, with restraint straps
  const inflatable = add(new THREE.SphereGeometry(2.1, 40, 24), M.cap, L / 2 + 3.4, Y - 0.2, 0, hab);
  inflatable.scale.set(1.15, 0.92, 1);
  for (let i = 0; i < 6; i++) {
    const strap = add(new THREE.TorusGeometry(2.12, 0.04, 6, 48), M.steel, L / 2 + 3.4, Y - 0.2, 0, hab);
    strap.scale.set(1.15, 0.92, 1);
    strap.rotation.y = (i / 6) * Math.PI;
  }
  const belt = add(new THREE.TorusGeometry(2.14, 0.06, 6, 48), M.orange, L / 2 + 3.4, Y - 0.2, 0, hab);
  belt.scale.set(1.15, 1, 1);
  belt.rotation.x = Math.PI / 2;
  for (const z of [-1.3, 1.3]) add(new THREE.CylinderGeometry(0.1, 0.12, Y - 1.4, 8), M.steel, L / 2 + 3.4, (Y - 1.4) / 2, z, hab);
  // floodlight masts lighting the work area
  const beamMat = keep(new THREE.MeshBasicMaterial({ color: '#ffd9a6', transparent: true, opacity: 0.07, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  for (const [fx, fz] of [[-7.5, -4.5], [7.5, -4.8]]) {
    add(new THREE.CylinderGeometry(0.06, 0.08, 5.2, 8), M.steel, fx, 2.6, fz);
    add(new THREE.BoxGeometry(0.7, 0.22, 0.35), M.dark, fx, 5.3, fz);
    add(new THREE.SphereGeometry(0.12, 10, 8), M.window, fx - 0.18, 5.15, fz);
    add(new THREE.SphereGeometry(0.12, 10, 8), M.window, fx + 0.18, 5.15, fz);
    const spot = new THREE.SpotLight('#ffd6a0', 40, 18, 0.55, 0.6, 1.4);
    spot.position.set(fx, 5.2, fz);
    spot.target.position.set(fx * 0.4, 0, fz * 0.2);
    scene.add(spot, spot.target);
    const beam = add(new THREE.ConeGeometry(2.4, 5.4, 24, 1, true), beamMat, 0, 0, 0);
    beam.castShadow = beam.receiveShadow = false;
    beam.position.set((fx + fx * 0.4) / 2, 2.6, (fz + fz * 0.2) / 2);
    beam.lookAt(fx, 5.2, fz);
    beam.rotateX(Math.PI / 2);
  }
  // better comms dish: struts and a feed horn
  for (const a of [0, 2.1, 4.2]) {
    const strut = add(new THREE.CylinderGeometry(0.015, 0.015, 0.95, 4), M.steel, Math.cos(a) * 0.35, Y + R + 1.55, -0.6 + Math.sin(a) * 0.35, hab);
    strut.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
  }
  add(new THREE.CylinderGeometry(0.06, 0.09, 0.2, 10), M.dark, 0, Y + R + 2.0, -0.6, hab);

  // solar arrays on masts, angled at the low sun
  for (const [x, z] of [[-13, -5], [13, -6]]) {
    const wing = new THREE.Group();
    wing.position.set(x, 0, z);
    scene.add(wing);
    add(new THREE.CylinderGeometry(0.1, 0.14, 3.2, 8), M.steel, 0, 1.6, 0, wing);
    add(new THREE.SphereGeometry(0.22, 12, 8), M.dark, 0, 3.25, 0, wing); // gimbal
    const arr = new THREE.Group();
    arr.position.set(0, 3.35, 0);
    arr.rotation.set(0.62, x < 0 ? 0.5 : -0.3, 0);
    wing.add(arr);
    for (const sx of [-1.65, 1.65]) {
      add(new THREE.BoxGeometry(3.1, 0.07, 3.0), M.panel, sx, 0, 0, arr);
      add(new THREE.BoxGeometry(3.2, 0.1, 0.06), M.steel, sx, 0, 1.52, arr);
      add(new THREE.BoxGeometry(3.2, 0.1, 0.06), M.steel, sx, 0, -1.52, arr);
    }
    add(new THREE.BoxGeometry(0.12, 0.12, 3.1), M.steel, 0, 0, 0, arr);
  }
  // cable run to the arrays
  for (const x of [-1, 1]) {
    const cable = add(new THREE.BoxGeometry(8.5, 0.04, 0.06), M.dark, x * 8.6, 0.03, -2.5);
    cable.rotation.y = x * -0.2;
  }

  // rover parked near the airlock
  const rover = new THREE.Group();
  rover.position.set(-9.5, 0, 6.5);
  rover.rotation.y = 0.7;
  scene.add(rover);
  add(new THREE.BoxGeometry(3.2, 0.35, 1.9), M.cap, 0, 0.95, 0, rover);
  add(new THREE.BoxGeometry(1.4, 0.7, 1.7), M.dark, -0.5, 1.45, 0, rover);
  add(new THREE.BoxGeometry(0.6, 0.12, 1.92), M.orange, 1.2, 1.15, 0, rover);
  for (const x of [-1.15, 0, 1.15]) for (const z of [-1.05, 1.05]) {
    const wheel = add(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 18), M.dark, x, 0.42, z, rover);
    wheel.rotation.x = Math.PI / 2;
  }
  add(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6), M.steel, 1.0, 1.7, 0.5, rover);
  add(new THREE.BoxGeometry(0.3, 0.2, 0.3), M.dark, 1.0, 2.35, 0.5, rover);
  // tyre tracks leading to the rover
  for (const off of [-0.9, 0.9]) {
    const t = add(new THREE.PlaneGeometry(0.35, 26), M.track, -16 + off, 0.02, 14);
    t.rotation.set(-Math.PI / 2, 0, 0.75);
    t.receiveShadow = false;
    t.castShadow = false;
  }

  // drifting dust
  const dustGeo = keep(new THREE.BufferGeometry());
  const dustN = 600;
  const dp = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) {
    dp[i * 3] = (random() - 0.5) * 80;
    dp[i * 3 + 1] = random() * 14;
    dp[i * 3 + 2] = (random() - 0.5) * 80;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  const dust = new THREE.Points(dustGeo, keep(new THREE.PointsMaterial({ color: '#e9b48a', size: 0.08, transparent: true, opacity: 0.55, depthWrite: false })));
  scene.add(dust);

  // ------------------------------------------------------------ camera
  const target = new THREE.Vector3(-1.5, 2.6, 0);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let angle = 0.5;
  let flight = null;
  let running = true;
  let last = performance.now();
  let offsetX = 0;

  // ------------------------------------------------------------ cel look (三渲二)
  // Hard-stepped toon lighting plus an inverted-hull ink outline on every solid.
  const toonRamp = keep(new THREE.DataTexture(new Uint8Array([70, 70, 70, 255, 150, 150, 150, 255, 225, 225, 225, 255, 255, 255, 255, 255]), 4, 1, THREE.RGBAFormat));
  toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.needsUpdate = true;
  const toonOf = new Map();
  const toToon = (m) => {
    if (!m.isMeshStandardMaterial) return m;
    if (!toonOf.has(m)) {
      toonOf.set(m, keep(new THREE.MeshToonMaterial({
        color: m.color, map: m.map, emissive: m.emissive, emissiveIntensity: m.emissiveIntensity,
        gradientMap: toonRamp, transparent: m.transparent, opacity: m.opacity, side: m.side,
      })));
    }
    return toonOf.get(m);
  };
  const ink = keep(new THREE.ShaderMaterial({
    side: THREE.BackSide,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uWidth: { value: 0.0028 }, uColor: { value: new THREE.Color('#1a0f0b') } }]),
    vertexShader: `#include <fog_pars_vertex>
      uniform float uWidth;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        mvPosition.xyz += n * uWidth * -mvPosition.z; // constant on-screen width
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <fog_pars_fragment>
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
        #include <fog_fragment>
      }`,
  }));
  const noOutline = new Set([M.ground, M.track, M.window, M.lamp]);
  const solids = [];
  scene.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) solids.push(o); });
  for (const o of solids) {
    const original = o.material;
    o.material = Array.isArray(original) ? original.map(toToon) : toToon(original);
    if (Array.isArray(original) || !original.isMeshStandardMaterial || noOutline.has(original) || original.transparent || !o.geometry.attributes.normal) continue;
    const hull = new THREE.Mesh(o.geometry, ink);
    hull.castShadow = hull.receiveShadow = false;
    hull.raycast = () => {};
    o.add(hull);
  }

  function orbitPosition(a) {
    return new THREE.Vector3(Math.sin(a) * 24 - 1.5, 5.6 + Math.sin(a * 2) * 0.5, Math.cos(a) * 24);
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the habitat in the right two-thirds on wide screens (the title card sits left)
    offsetX = w > 900 ? -w * 0.14 : 0;
    camera.setViewOffset(w, h, offsetX, 0, w, h);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (flight) {
      const t = Math.min(1, (now - flight.start) / flight.ms);
      const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      camera.position.lerpVectors(flight.from, flight.to, e);
      const look = new THREE.Vector3().lerpVectors(flight.lookFrom, flight.lookTo, Math.min(1, e * 1.4));
      camera.lookAt(look);
      camera.fov = 34 - 12 * e;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w && h) camera.setViewOffset(w, h, offsetX * (1 - e), 0, w, h); // re-centre on the window
      camera.updateProjectionMatrix();
      if (t >= 1) {
        const done = flight.done;
        flight = null;
        done();
      }
    } else {
      if (!reduced) angle += dt * 0.035;
      camera.position.copy(orbitPosition(angle));
      camera.lookAt(target);
    }
    beacon.visible = Math.sin(now / 420) > 0.2;
    if (!reduced) {
      for (let i = 0; i < dustN; i++) {
        dp[i * 3] += dt * 0.9;
        if (dp[i * 3] > 40) dp[i * 3] -= 80;
      }
      dustGeo.attributes.position.needsUpdate = true;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    /** Fly the camera into the central lit window. Resolves when it arrives. */
    flyIn(ms = 2600) {
      const win = new THREE.Vector3();
      windows[2].getWorldPosition(win);
      const normal = new THREE.Vector3(0, Math.sin(phi), Math.cos(phi));
      if (reduced) return Promise.resolve();
      return new Promise((done) => {
        flight = {
          start: performance.now(),
          ms,
          from: camera.position.clone(),
          to: win.clone().addScaledVector(normal, 0.35),
          lookFrom: target.clone(),
          lookTo: win.clone(),
          done,
        };
      });
    },
    dispose() {
      running = false;
      ro.disconnect();
      scene.traverse((o) => o.isMesh && disposables.push(o.geometry));
      for (const d of new Set(disposables)) d.dispose?.();
      renderer.dispose();
    },
  };
}
