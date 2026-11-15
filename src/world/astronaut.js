import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

// ---------------------------------------------------------------------------
// The crew member in a NASA-style planetary surface suit (modelled on the
// xEMU / Artemis-era exploration suits), for the third-person views.
// Origin at the feet, facing -Z (same convention as the camera and the rover).
//
//   hard upper torso with chest display-and-control module (DCM) and umbilical
//   life-support backpack (PLSS) with vents, antenna and handholds
//   bubble helmet inside a visor assembly: gold sun visor, twin lights, camera
//   bearing rings at the neck, shoulders, waist, hips, wrists
//   bellows joints at the elbows and knees, rubber-palmed gloves, thick boots
//   commander's red bands, US flag and an original mission patch
//
//   setWalk(speed, dt)  leg and arm swing with a light bob
//   setSeated(true)     pose for the rover's driver seat
//   setReach(t)         bend down to pick something up (0 → 1)
// ---------------------------------------------------------------------------

export const EYE_HEIGHT = 1.68;

const TAU = Math.PI * 2;

// --- textures (built once, shared by every suit) ---------------------------

let textures = null;

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

// Woven outer layer: a fine basket weave with soft noise, used as a bump map.
function weaveTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#808080';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 4) {
    for (let x = 0; x < 256; x += 4) {
      const across = ((x >> 2) + (y >> 2)) % 2 === 0;
      const v = 118 + (across ? 26 : -10) + Math.random() * 18;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, y, across ? 4 : 3, across ? 3 : 4);
    }
  }
  // A few soft creases so the cloth doesn't read as perfectly flat.
  g.globalAlpha = 0.18;
  g.strokeStyle = '#3c3c3c';
  for (let i = 0; i < 14; i++) {
    g.lineWidth = 3 + Math.random() * 6;
    g.beginPath();
    const y = Math.random() * 256;
    g.moveTo(0, y);
    g.bezierCurveTo(80, y + 30 * (Math.random() - 0.5), 170, y + 30 * (Math.random() - 0.5), 256, y);
    g.stroke();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

function flagTexture() {
  const [c, g] = canvas(190, 100);
  const stripe = 100 / 13;
  for (let i = 0; i < 13; i++) {
    g.fillStyle = i % 2 ? '#f4f2ec' : '#b22234';
    g.fillRect(0, i * stripe, 190, stripe + 0.5);
  }
  g.fillStyle = '#3c3b6e';
  g.fillRect(0, 0, 76, stripe * 7);
  g.fillStyle = '#f4f2ec';
  for (let r = 0; r < 9; r++) {
    const n = r % 2 ? 5 : 6;
    for (let k = 0; k < n; k++) {
      const x = (r % 2 ? 12.6 : 6.3) + k * 12.6;
      const y = 4.2 + r * 5.4;
      g.beginPath();
      g.arc(x, y, 1.6, 0, TAU);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// An original mission patch for this game (not an agency logo).
function patchTexture() {
  const [c, g] = canvas(256, 256);
  const cx = 128;
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#d8d4c8';
  g.beginPath(); g.arc(cx, cx, 126, 0, TAU); g.fill();
  g.fillStyle = '#132a52';
  g.beginPath(); g.arc(cx, cx, 116, 0, TAU); g.fill();
  // Starfield
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * TAU;
    const r = 30 + Math.random() * 60;
    g.globalAlpha = 0.4 + Math.random() * 0.6;
    g.fillRect(cx + Math.cos(a) * r, cx + Math.sin(a) * r, 1.6, 1.6);
  }
  g.globalAlpha = 1;
  // Mars
  const mars = g.createRadialGradient(cx - 18, cx - 10, 6, cx, cx + 8, 52);
  mars.addColorStop(0, '#f0915a');
  mars.addColorStop(0.7, '#b6492a');
  mars.addColorStop(1, '#6e2414');
  g.fillStyle = mars;
  g.beginPath(); g.arc(cx, cx + 8, 50, 0, TAU); g.fill();
  // Traverse track over the surface, with three station dots
  g.strokeStyle = '#ffe2a8';
  g.lineWidth = 3;
  g.setLineDash([6, 5]);
  g.beginPath(); g.moveTo(cx - 34, cx + 30); g.quadraticCurveTo(cx - 6, cx - 8, cx + 30, cx + 18); g.stroke();
  g.setLineDash([]);
  g.fillStyle = '#ffe2a8';
  for (const [x, y] of [[cx - 34, cx + 30], [cx - 2, cx + 8], [cx + 30, cx + 18]]) {
    g.beginPath(); g.arc(x, y, 4, 0, TAU); g.fill();
  }
  // Orbit swoosh
  g.strokeStyle = '#e8eef8';
  g.lineWidth = 4;
  g.beginPath(); g.ellipse(cx, cx + 4, 88, 26, -0.35, Math.PI * 1.05, Math.PI * 2.02); g.stroke();
  g.fillStyle = '#e8eef8';
  g.beginPath(); g.arc(cx + 78, cx - 30, 5, 0, TAU); g.fill();
  // Lettering around the rim
  g.fillStyle = '#e9e4d6';
  g.font = 'bold 19px Helvetica, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const ring = (text, start, sweep, radius, flip) => {
    const step = sweep / (text.length - 1);
    for (let i = 0; i < text.length; i++) {
      const a = start + i * step;
      g.save();
      g.translate(cx + Math.cos(a) * radius, cx + Math.sin(a) * radius);
      g.rotate(a + (flip ? -Math.PI / 2 : Math.PI / 2));
      g.fillText(text[i], 0, 0);
      g.restore();
    }
  };
  ring('SURVIVAL GUIDE', Math.PI * 1.17, Math.PI * 0.66, 100, false);
  ring('MARS EVA', Math.PI * 0.8, -Math.PI * 0.6, 100, true);
  g.strokeStyle = '#d8d4c8';
  g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cx, 84, 0, TAU); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// The chest display: a small backlit readout.
function displayTexture() {
  const [c, g] = canvas(128, 48);
  g.fillStyle = '#0b1a10';
  g.fillRect(0, 0, 128, 48);
  g.fillStyle = '#7dffa8';
  g.font = 'bold 15px monospace';
  g.fillText('O2 98%', 8, 19);
  g.fillText('4.3 PSI', 8, 39);
  g.fillRect(84, 10, 34, 5);
  g.fillRect(84, 22, 22, 5);
  g.fillRect(84, 34, 28, 5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tagTexture() {
  const [c, g] = canvas(160, 40);
  g.fillStyle = '#1d2a44';
  g.fillRect(0, 0, 160, 40);
  g.fillStyle = '#e9e4d6';
  g.font = 'bold 22px Helvetica, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('EV1 · MARS', 80, 21);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function getTextures() {
  if (!textures) textures = { weave: weaveTexture(), flag: flagTexture(), patch: patchTexture(), display: displayTexture(), tag: tagTexture() };
  return textures;
}

// --- geometry helpers ---------------------------------------------------------

// A limb segment hanging down the -Y axis from its pivot: tapered, with domed
// ends and optional bellows convolutes (the ribbed joints of a pressure suit).
function limbGeometry(len, r0, r1, bellows = null) {
  const pts = [];
  const dome = 8;
  // Bottom dome (y = -len) up to the top dome (y = 0): y increasing.
  for (let i = 0; i <= dome; i++) {
    const a = (i / dome) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0.0005, r1 * Math.sin(a)), -len - r1 * 0.35 * Math.cos(a)));
  }
  const n = 48;
  for (let i = 1; i < n; i++) {
    const t = 1 - i / n; // t: 1 at the bottom, 0 at the top
    let r = r0 + (r1 - r0) * t;
    if (bellows) {
      const d = (t - bellows.at) / bellows.span;
      if (Math.abs(d) < 0.5) r += bellows.depth * (0.5 + 0.5 * Math.cos(d * bellows.count * TAU)) * Math.cos(d * Math.PI);
    }
    pts.push(new THREE.Vector2(r, -t * len));
  }
  for (let i = dome; i >= 0; i--) {
    const a = (i / dome) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0.0005, r0 * Math.sin(a)), r0 * 0.35 * Math.cos(a)));
  }
  const geo = new THREE.LatheGeometry(pts, 28);
  geo.computeVertexNormals();
  return geo;
}

// A curved strip around a limb, for bands and sewn-on patches.
function wrapGeometry(radius, height, thetaStart, thetaLength) {
  return new THREE.CylinderGeometry(radius, radius, height, 24, 1, true, thetaStart, thetaLength);
}

function ring(radius, tube, mat) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 36), mat);
  m.castShadow = true;
  return m;
}

function tube(points, radius, mat) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, radius, 8), mat);
  m.castShadow = true;
  return m;
}

function mesh(geo, mat, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow;
  return m;
}

// --- the suit -------------------------------------------------------------------

export class Astronaut {
  constructor(envMap) {
    const T = getTextures();
    const M = {
      // Thermal micrometeoroid garment: matte woven white.
      cloth: new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.92, metalness: 0, bumpMap: T.weave, bumpScale: 0.9, envMap, envMapIntensity: 0.35 }),
      // Hard composite shells (torso, backpack, helmet visor assembly).
      shell: new THREE.MeshStandardMaterial({ color: 0xf5f5f2, roughness: 0.42, metalness: 0.02, envMap, envMapIntensity: 0.55 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xc3c7cc, roughness: 0.28, metalness: 0.9, envMap, envMapIntensity: 1 }),
      grey: new THREE.MeshStandardMaterial({ color: 0x8e939a, roughness: 0.55, metalness: 0.25, envMap, envMapIntensity: 0.5 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.88, metalness: 0 }),
      sole: new THREE.MeshStandardMaterial({ color: 0x3a3631, roughness: 0.95, metalness: 0 }),
      red: new THREE.MeshStandardMaterial({ color: 0xc23a2c, roughness: 0.7, bumpMap: T.weave, bumpScale: 0.6 }),
      blue: new THREE.MeshStandardMaterial({ color: 0x2c58a8, roughness: 0.35, metalness: 0.6, envMap }),
      visor: new THREE.MeshStandardMaterial({ color: 0xe0ab4a, metalness: 1, roughness: 0.07, envMap, envMapIntensity: 1.6 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9fb0c0, metalness: 0.2, roughness: 0.03, transparent: true, opacity: 0.32, depthWrite: false, envMap, envMapIntensity: 2 }),
      interior: new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.7, side: THREE.BackSide }),
      skin: new THREE.MeshStandardMaterial({ color: 0xa87a62, roughness: 0.75 }),
      capWhite: new THREE.MeshStandardMaterial({ color: 0xe9e6de, roughness: 0.9 }),
      capDark: new THREE.MeshStandardMaterial({ color: 0x3a2c22, roughness: 0.85 }),
      tag: new THREE.MeshStandardMaterial({ map: T.tag, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dc, emissiveIntensity: 1.6 }),
      lens: new THREE.MeshStandardMaterial({ color: 0x101418, metalness: 0.8, roughness: 0.1, envMap }),
      flag: new THREE.MeshStandardMaterial({ map: T.flag, roughness: 0.8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }),
      patch: new THREE.MeshStandardMaterial({ map: T.patch, roughness: 0.8, transparent: true, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2 }),
      display: new THREE.MeshStandardMaterial({ map: T.display, emissive: 0xffffff, emissiveMap: T.display, emissiveIntensity: 0.9, roughness: 0.3 }),
    };
    this.materials = M;

    this.root = new THREE.Group();
    this.root.name = 'astronaut';
    this.body = new THREE.Group();
    this.root.add(this.body);

    this._buildLegs(M);
    this._buildTorso(M);
    this._buildBackpack(M);
    this._buildArms(M);
    this._buildHelmet(M);

    this.phase = 0;
    this.seated = false;
  }

  // Hips at 0.96 m, knees 0.50, ankles 0.10.
  _buildLegs(M) {
    this.legs = [-1, 1].map((side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.115, 0.96, 0);

      const hipBearing = ring(0.112, 0.016, M.metal);
      hipBearing.rotation.x = Math.PI / 2;
      hipBearing.position.y = -0.06;
      const thigh = mesh(limbGeometry(0.46, 0.112, 0.094), M.cloth);
      const band = mesh(wrapGeometry(0.112, 0.05, 0, TAU), M.red);
      band.position.y = -0.2;

      const knee = new THREE.Group();
      knee.position.y = -0.46;
      const shin = mesh(limbGeometry(0.4, 0.093, 0.082, { at: 0.08, span: 0.26, count: 4, depth: 0.012 }), M.cloth);
      // Boot: thick ridged sole, padded upper, toe cap and an ankle strap.
      const ankle = new THREE.Group();
      ankle.position.y = -0.4;
      const sole = mesh(new RoundedBoxGeometry(0.135, 0.05, 0.31, 3, 0.02), M.sole);
      sole.position.set(0, -0.075, -0.045);
      const upper = mesh(new RoundedBoxGeometry(0.128, 0.12, 0.22, 4, 0.045), M.shell);
      upper.position.set(0, -0.02, -0.01);
      const toe = mesh(new RoundedBoxGeometry(0.124, 0.06, 0.1, 3, 0.03), M.grey);
      toe.position.set(0, -0.04, -0.14);
      const cuff = mesh(new THREE.CylinderGeometry(0.09, 0.095, 0.07, 20), M.shell);
      cuff.position.y = 0.04;
      const strap = mesh(wrapGeometry(0.097, 0.018, 0, TAU), M.grey, false);
      strap.position.y = 0.02;
      ankle.add(sole, upper, toe, cuff, strap);
      knee.add(shin, ankle);
      hip.add(hipBearing, thigh, band, knee);
      this.body.add(hip);
      return { hip, knee, side };
    });
  }

  _buildTorso(M) {
    // Brief (lower torso) and the waist bearing.
    const brief = mesh(new THREE.CylinderGeometry(0.205, 0.19, 0.24, 28), M.cloth);
    brief.scale.z = 0.82;
    brief.position.y = 0.99;
    const seat = mesh(new THREE.SphereGeometry(0.19, 24, 12, 0, TAU, Math.PI / 2, Math.PI / 2), M.cloth);
    seat.scale.set(1.04, 0.5, 0.84);
    seat.position.y = 0.88;
    const waist = ring(0.2, 0.02, M.metal);
    waist.rotation.x = Math.PI / 2;
    waist.scale.y = 0.84;
    waist.position.y = 1.12;

    // Hard upper torso: a lathe profile flattened front to back.
    const prof = [
      [0.0005, 0], [0.2, 0], [0.225, 0.06], [0.25, 0.16], [0.27, 0.27], [0.272, 0.34],
      [0.255, 0.42], [0.21, 0.48], [0.15, 0.52], [0.0005, 0.53],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const hut = mesh(new THREE.LatheGeometry(new THREE.SplineCurve(prof).getPoints(40), 36), M.shell);
    hut.scale.z = 0.74;
    hut.position.y = 1.11;

    // Neck ring the helmet locks onto.
    const neck = ring(0.15, 0.024, M.metal);
    neck.rotation.x = Math.PI / 2;
    neck.position.y = 1.645;
    const neckBase = mesh(new THREE.CylinderGeometry(0.155, 0.17, 0.05, 28), M.grey);
    neckBase.position.y = 1.62;

    // Display and control module on the chest: housing, readout, knobs.
    const dcm = new THREE.Group();
    dcm.position.set(0, 1.36, -0.205);
    dcm.rotation.x = -0.12;
    const box = mesh(new RoundedBoxGeometry(0.25, 0.13, 0.08, 3, 0.018), M.shell);
    const face = mesh(new RoundedBoxGeometry(0.235, 0.115, 0.01, 2, 0.004), M.grey, false);
    face.position.z = -0.042;
    const screen = mesh(new THREE.PlaneGeometry(0.085, 0.032), M.display, false);
    screen.rotation.y = Math.PI;
    screen.position.set(0, 0.032, -0.049);
    dcm.add(box, face, screen);
    for (const [x, y, r, mat] of [[-0.08, -0.02, 0.016, M.blue], [-0.035, -0.022, 0.012, M.rubber], [0.035, -0.022, 0.012, M.rubber], [0.085, -0.02, 0.016, M.red]]) {
      const knob = mesh(new THREE.CylinderGeometry(r, r, 0.022, 14), mat, false);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(x, y, -0.052);
      dcm.add(knob);
    }
    // Purge valve and the umbilical hoses from the DCM round to the backpack.
    const purge = mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.05, 12), M.red, false);
    purge.position.set(0.18, 1.2, -0.15);
    purge.rotation.z = Math.PI / 2;
    const hoseL = tube([[-0.11, 1.32, -0.21], [-0.2, 1.24, -0.17], [-0.25, 1.17, -0.02], [-0.22, 1.17, 0.17]], 0.016, M.grey);
    const hoseR = tube([[0.11, 1.32, -0.21], [0.2, 1.24, -0.17], [0.25, 1.17, -0.02], [0.22, 1.17, 0.17]], 0.016, M.grey);

    // Mission patch on the left chest, name strip on the right.
    const patch = mesh(new THREE.CircleGeometry(0.055, 32), M.patch, false);
    patch.rotation.set(0.42, Math.PI + 0.45, 0, 'YXZ');
    patch.position.set(-0.163, 1.49, -0.161);
    const tag = mesh(new THREE.PlaneGeometry(0.12, 0.03), M.tag, false);
    tag.rotation.set(0.42, Math.PI - 0.45, 0, 'YXZ');
    tag.position.set(0.163, 1.5, -0.156);

    this.body.add(brief, seat, waist, hut, neck, neckBase, dcm, purge, hoseL, hoseR, patch, tag);
  }

  _buildBackpack(M) {
    // Portable life support system: rounded shell, lid, side vents, lower
    // service unit, handholds and the comm antenna.
    const plss = new THREE.Group();
    plss.position.set(0, 1.38, 0.33);
    const shell = mesh(new RoundedBoxGeometry(0.52, 0.66, 0.26, 5, 0.06), M.shell);
    const lid = mesh(new RoundedBoxGeometry(0.46, 0.05, 0.22, 3, 0.02), M.grey);
    lid.position.y = 0.335;
    const back = mesh(new RoundedBoxGeometry(0.4, 0.46, 0.02, 2, 0.008), M.cloth, false);
    back.position.set(0, 0.04, 0.131);
    const sop = mesh(new RoundedBoxGeometry(0.46, 0.15, 0.22, 3, 0.04), M.shell);
    sop.position.set(0, -0.41, -0.01);
    const seam = mesh(new THREE.BoxGeometry(0.42, 0.01, 0.01), M.grey, false);
    seam.position.set(0, -0.2, 0.131);
    const label = mesh(new THREE.BoxGeometry(0.16, 0.035, 0.006), M.red, false);
    label.position.set(0, 0.2, 0.143);
    plss.add(shell, lid, back, sop, seam, label);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const vent = mesh(new THREE.BoxGeometry(0.008, 0.012, 0.16), M.rubber, false);
        vent.position.set(side * 0.262, 0.16 - i * 0.03, 0);
        plss.add(vent);
      }
      // Handrail along each side of the pack.
      const rail = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.2, 8), M.metal);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(side * 0.29, -0.16, 0);
      for (const z of [-0.08, 0.08]) {
        const post = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6), M.metal, false);
        post.rotation.z = Math.PI / 2;
        post.position.set(side * 0.275, -0.16, z);
        plss.add(post);
      }
      plss.add(rail);
    }
    const mast = mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.26, 8), M.grey);
    mast.position.set(-0.17, 0.48, 0.05);
    const tip = mesh(new THREE.SphereGeometry(0.012, 8, 6), M.red, false);
    tip.position.set(-0.17, 0.615, 0.05);
    const unit = mesh(new RoundedBoxGeometry(0.07, 0.05, 0.08, 2, 0.012), M.grey);
    unit.position.set(-0.17, 0.36, 0.05);
    plss.add(mast, tip, unit);
    this.body.add(plss);
  }

  // Shoulders at 1.50 m; arm ≈ 0.62 m to the wrist.
  _buildArms(M) {
    this.arms = [-1, 1].map((side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.305, 1.5, 0);

      // Scye bearing where the arm leaves the hard torso.
      const bearing = ring(0.092, 0.015, M.metal);
      bearing.rotation.x = Math.PI / 2;
      bearing.position.y = -0.085;
      const cap = mesh(new THREE.SphereGeometry(0.096, 20, 14), M.cloth);
      cap.scale.set(1, 0.85, 1.05);
      cap.position.set(-side * 0.01, -0.035, 0);
      const upper = mesh(limbGeometry(0.31, 0.09, 0.078), M.cloth);
      upper.position.y = -0.04;
      const band = mesh(wrapGeometry(0.091, 0.04, 0, TAU), M.red);
      band.position.y = -0.24;
      // Sewn-on emblem on the outside of the upper arm: the flag on the left
      // sleeve, the mission patch on the right.
      const emblem = side < 0
        ? mesh(wrapGeometry(0.0905, 0.058, Math.PI * 1.5 - 0.6, 1.2), M.flag, false)
        : mesh(wrapGeometry(0.0905, 0.075, Math.PI * 0.5 - 0.42, 0.84), M.patch, false);
      emblem.position.y = -0.13;

      const elbow = new THREE.Group();
      elbow.position.y = -0.33;
      const fore = mesh(limbGeometry(0.27, 0.077, 0.066, { at: 0.07, span: 0.22, count: 3.5, depth: 0.01 }), M.cloth);
      // Wrist bearing (blue disconnect ring) and gauntlet.
      const wrist = ring(0.066, 0.012, M.blue);
      wrist.rotation.x = Math.PI / 2;
      wrist.position.y = -0.275;
      const gauntlet = mesh(new THREE.CylinderGeometry(0.07, 0.058, 0.08, 20), M.shell);
      gauntlet.position.y = -0.315;
      // Hand: rubberised palm, four fingers and a thumb, slightly curled.
      const hand = new THREE.Group();
      hand.position.y = -0.36;
      const palm = mesh(new RoundedBoxGeometry(0.05, 0.1, 0.095, 3, 0.02), M.rubber);
      palm.position.y = -0.04;
      const back = mesh(new RoundedBoxGeometry(0.03, 0.085, 0.09, 2, 0.012), M.grey, false);
      back.position.set(side * 0.015, -0.04, 0);
      hand.add(palm, back);
      for (let f = 0; f < 4; f++) {
        const finger = new THREE.Group();
        finger.position.set(-side * 0.004, -0.09, -0.033 + f * 0.022);
        finger.rotation.z = -side * 0.35;
        const seg = mesh(new THREE.CapsuleGeometry(0.0105, 0.045 - Math.abs(f - 1.3) * 0.006, 4, 8), M.rubber, false);
        seg.position.y = -0.028;
        finger.add(seg);
        hand.add(finger);
      }
      const thumb = mesh(new THREE.CapsuleGeometry(0.012, 0.04, 4, 8), M.rubber, false);
      thumb.position.set(-side * 0.025, -0.05, -0.05);
      thumb.rotation.set(0.6, 0, -side * 0.5);
      hand.add(thumb);
      hand.rotation.z = side * 0.08;
      elbow.add(fore, wrist, gauntlet, hand);
      // Cuff checklist on the left wrist.
      if (side < 0) {
        const book = mesh(new RoundedBoxGeometry(0.035, 0.07, 0.06, 2, 0.006), M.shell, false);
        book.position.set(-0.07, -0.21, -0.01);
        elbow.add(book);
      }
      shoulder.add(bearing, cap, upper, band, emblem, elbow);
      this.body.add(shoulder);
      return { shoulder, elbow, side };
    });
  }

  // Bubble helmet inside the extravehicular visor assembly.
  _buildHelmet(M) {
    this.head = new THREE.Group();
    this.head.position.y = 1.8;
    const R = 0.168;
    const FRONT = Math.PI * 1.5; // phi of -Z on a three.js sphere
    const OPEN = Math.PI * 0.36; // half-width of the face opening

    // Clear bubble with the crew member's head inside: comm cap ("Snoopy
    // cap", white crown and brown sides) and face, against a dark interior.
    const bubble = mesh(new THREE.SphereGeometry(R, 32, 24), M.glass, false);
    bubble.renderOrder = 2;
    const inside = mesh(new THREE.SphereGeometry(R - 0.004, 24, 16), M.interior, false);
    const face = mesh(new THREE.SphereGeometry(0.085, 20, 16), M.skin, false);
    face.scale.set(0.92, 1.12, 0.95);
    face.position.set(0, -0.02, -0.02);
    const capSides = mesh(new THREE.SphereGeometry(0.094, 20, 14, 0, TAU, 0, Math.PI * 0.62), M.capDark, false);
    capSides.position.set(0, -0.012, 0.0);
    capSides.rotation.x = 0.35;
    const capTop = mesh(new THREE.SphereGeometry(0.097, 20, 10, 0, TAU, 0, Math.PI * 0.3), M.capWhite, false);
    capTop.position.copy(capSides.position);
    capTop.rotation.x = 0.35;
    const mic = mesh(new THREE.CapsuleGeometry(0.008, 0.03, 4, 8), M.capDark, false);
    mic.rotation.z = Math.PI / 2;
    mic.position.set(0, -0.075, -0.085);
    // Visor assembly shell: top cap plus sides and back, open at the face.
    const top = mesh(new THREE.SphereGeometry(R + 0.016, 32, 8, 0, TAU, 0, Math.PI * 0.2), M.shell);
    const sides = mesh(new THREE.SphereGeometry(R + 0.016, 32, 16, FRONT + OPEN, TAU - OPEN * 2, Math.PI * 0.2, Math.PI * 0.46), M.shell);
    // Gold sun visor, pulled half down.
    const visor = mesh(new THREE.SphereGeometry(R + 0.008, 32, 16, FRONT - OPEN + 0.04, OPEN * 2 - 0.08, Math.PI * 0.2, Math.PI * 0.33), M.visor, false);
    // Rim along the edge of the opening and the visor pivots at the temples.
    const rim = new THREE.Group();
    for (const s of [-1, 1]) {
      const phi = FRONT + s * OPEN;
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const th = Math.PI * (0.2 + 0.46 * (i / 12));
        const r = R + 0.018;
        pts.push([-r * Math.cos(phi) * Math.sin(th), r * Math.cos(th), r * Math.sin(phi) * Math.sin(th)]);
      }
      rim.add(tube(pts, 0.008, M.grey));
      const pivot = mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.014, 16), M.grey, false);
      pivot.rotation.z = Math.PI / 2;
      pivot.position.set(s * (R + 0.02), 0.0, -0.01);
      rim.add(pivot);
    }
    // Helmet lights and HD camera on both temples.
    for (const s of [-1, 1]) {
      const pod = new THREE.Group();
      pod.position.set(s * 0.19, 0.075, -0.03);
      pod.rotation.y = s * -0.12;
      const housing = mesh(new RoundedBoxGeometry(0.05, 0.05, 0.1, 2, 0.012), M.shell);
      const light = mesh(new THREE.CircleGeometry(0.017, 16), M.lamp, false);
      light.rotation.y = Math.PI;
      light.position.set(0, 0.006, -0.0505);
      pod.add(housing, light);
      if (s > 0) {
        const cam = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.02, 12), M.lens, false);
        cam.rotation.x = Math.PI / 2;
        cam.position.set(0, -0.017, -0.055);
        pod.add(cam);
      }
      this.head.add(pod);
    }
    this.head.add(inside, face, capSides, capTop, mic, bubble, top, sides, visor, rim);
    this.body.add(this.head);
  }

  setSeated(seated) {
    this.seated = seated;
    for (const leg of this.legs) {
      leg.hip.rotation.x = seated ? 1.5 : 0;
      leg.knee.rotation.x = seated ? -1.45 : 0;
    }
    for (const arm of this.arms) {
      arm.shoulder.rotation.x = seated ? 0.55 : 0;
      arm.elbow.rotation.x = seated ? 0.9 : 0;
      arm.shoulder.rotation.z = 0;
    }
    this.body.position.y = 0;
  }

  // Walking speed in m/s drives the gait; standing still settles the pose.
  setWalk(speed, dt) {
    if (this.seated) return;
    const amount = Math.min(1, speed / 1.4);
    this.phase += dt * (2.2 + speed * 2.4);
    const s = Math.sin(this.phase);
    for (const leg of this.legs) {
      const swing = s * leg.side;
      leg.hip.rotation.x += (swing * 0.55 * amount - leg.hip.rotation.x) * Math.min(1, dt * 12);
      const bend = Math.max(0, -swing) * 0.9 * amount + 0.05;
      leg.knee.rotation.x += (-bend - leg.knee.rotation.x) * Math.min(1, dt * 12);
    }
    for (const arm of this.arms) {
      const swing = -s * arm.side;
      arm.shoulder.rotation.x += (swing * 0.4 * amount - arm.shoulder.rotation.x) * Math.min(1, dt * 10);
      // A pressurised suit holds the arms out from the body.
      arm.shoulder.rotation.z = arm.side * 0.16;
      arm.elbow.rotation.x = 0.3 + 0.25 * amount;
    }
    this.body.position.y = Math.abs(Math.cos(this.phase)) * 0.045 * amount;
    this.body.rotation.x = -0.06 * amount;
  }

  // Bend down to pick something up (0 → 1).
  setReach(t) {
    if (this.seated) return;
    this.body.rotation.x = -0.5 * t;
    for (const arm of this.arms) arm.shoulder.rotation.x = 0.9 * t;
  }
}
