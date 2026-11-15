import * as THREE from 'three';
import { buildSuitGraph, solveLeg, SUIT_MATERIALS } from './suitGeometry.js';

// ---------------------------------------------------------------------------
// three.js adapter for the procedural EVA suit in ./suitGeometry.js, posed
// seated in a rover seat. Rover frame: -Z forward, +X right, +Y up.
// ---------------------------------------------------------------------------

// Seat layout this pose is fitted to (see Rover._buildSeatsAndCrew).
const SEAT = {
  top: 0.87, // top of the seat pan
  hipZ: 0.09, // hip joint, a little forward of the seat centre so the backpack rests on the backrest
  footrestTop: 0.715,
  ankleZ: -0.5, // boots on the footrest
};
const SCALE = 0.92; // suit scaled to the rover's crew size
const RECLINE = -0.16; // upper body leans back with the backrest
const SEATED_ARMS = {
  1: { x: -0.25, y: 0, z: 0.18, e: -0.84, ez: 0.35 },
  '-1': { x: -0.25, y: 0, z: 0.18, e: -0.84, ez: 0.35 },
};

/** Woven ripstop ("ortho fabric") normal map, generated once. */
function fabricNormalCanvas() {
  const S = 256, h = new Float32Array(S * S);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const wx = Math.abs(Math.sin((x + 0.5) * Math.PI / 2)), wy = Math.abs(Math.sin((y + 0.5) * Math.PI / 2));
    let v = 0.35 * (wx * ((y >> 1) % 2 ? 1 : 0.6) + wy * ((x >> 1) % 2 ? 0.6 : 1));
    const gx = Math.min(x % 32, 32 - (x % 32)), gy = Math.min(y % 32, 32 - (y % 32));
    v += 0.28 * Math.exp(-gx * gx / 2.2) + 0.28 * Math.exp(-gy * gy / 2.2) + (rnd() - 0.5) * 0.22;
    h[y * S + x] = v;
  }
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d'), img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const xl = (x - 1 + S) % S, xr = (x + 1) % S, yu = (y - 1 + S) % S, yd = (y + 1) % S;
    const nx = -(h[y * S + xr] - h[y * S + xl]) * 1.2, ny = (h[yd * S + x] - h[yu * S + x]) * 1.2, l = Math.hypot(nx, ny, 1);
    const i = (y * S + x) * 4;
    img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function patchCanvas(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  g.beginPath(); g.arc(0, 0, 120, 0, Math.PI * 2); g.fillStyle = '#c9a64a'; g.fill();
  g.beginPath(); g.arc(0, 0, 108, 0, Math.PI * 2); g.fillStyle = '#0d1e3d'; g.fill();
  g.save(); g.beginPath(); g.arc(0, 0, 108, 0, Math.PI * 2); g.clip();
  const grd = g.createRadialGradient(-20, 40, 5, -10, 52, 70);
  grd.addColorStop(0, '#d0784a'); grd.addColorStop(1, '#6e2f1c');
  g.beginPath(); g.arc(0, 150, 110, 0, Math.PI * 2); g.fillStyle = grd; g.fill(); g.restore();
  g.save(); g.rotate(-0.35); g.beginPath(); g.ellipse(0, -6, 92, 34, 0, 0, Math.PI * 2);
  g.strokeStyle = '#f4f1ea'; g.lineWidth = 5; g.stroke(); g.restore();
  g.fillStyle = '#f4f1ea';
  for (let i = 0; i < 18; i++) { const a = i * 2.4, r = 30 + (i * 37) % 70; g.fillRect(Math.cos(a) * r, Math.sin(a) * r - 30, 2, 2); }
  if (text) { g.font = '600 26px monospace'; g.textAlign = 'center'; g.fillText(text, 0, -62); }
  return c;
}

function tagCanvas(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f3f1ec'; g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#1b1d22'; g.lineWidth = 10; g.strokeRect(8, 8, 496, 112);
  g.fillStyle = '#1b1d22'; g.font = '700 60px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 68);
  return c;
}

/**
 * Materials for the suit, keyed like SUIT_MATERIALS. Per-vertex colour carries
 * the baked crease shading and Mars dust.
 * @param {THREE.Texture} [envMap]
 * @param {{ name?: string }} [opts]
 */
export function createSuitMaterials(envMap, { name = 'K. ARATA' } = {}) {
  const weave = fabricNormalCanvas();
  const normalMaps = new Map();
  const weaveMap = (repeat) => {
    if (!normalMaps.has(repeat)) {
      const t = new THREE.CanvasTexture(weave);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      t.anisotropy = 4;
      normalMaps.set(repeat, t);
    }
    return normalMaps.get(repeat);
  };
  const colorTex = (canvas) => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
  const out = {};
  for (const [key, def] of Object.entries(SUIT_MATERIALS)) {
    const common = { color: def.color, vertexColors: true, envMap: envMap || null };
    switch (def.kind) {
      case 'fabric':
        out[key] = new THREE.MeshPhysicalMaterial({
          ...common, roughness: 0.9, metalness: 0, envMapIntensity: 0.35,
          sheen: 0.55, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff),
          normalMap: weaveMap(def.repeat || 6), normalScale: new THREE.Vector2(0.3, 0.3).multiplyScalar((def.normalScale || 1)),
        });
        break;
      case 'hard': out[key] = new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.48, metalness: 0, envMapIntensity: 0.5 }); break;
      case 'metal': out[key] = new THREE.MeshStandardMaterial({ ...common, roughness: 0.44, metalness: 1, envMapIntensity: 1 }); break;
      case 'darkMetal': out[key] = new THREE.MeshStandardMaterial({ ...common, roughness: 0.6, metalness: 0.6, envMapIntensity: 0.8 }); break;
      case 'rubber': out[key] = new THREE.MeshStandardMaterial({ ...common, roughness: 0.85, metalness: 0, envMapIntensity: 0.3 }); break;
      case 'anodised': out[key] = new THREE.MeshStandardMaterial({ ...common, roughness: 0.38, metalness: 0.75, envMapIntensity: 1 }); break;
      case 'visor': out[key] = new THREE.MeshPhysicalMaterial({ ...common, roughness: 0.06, metalness: 1, envMapIntensity: 1.1, side: THREE.DoubleSide }); break;
      case 'tag': out[key] = new THREE.MeshStandardMaterial({ ...common, color: 0xffffff, map: colorTex(tagCanvas(name)), roughness: 0.7 }); break;
      case 'patch': out[key] = new THREE.MeshStandardMaterial({ ...common, map: colorTex(patchCanvas(key === 'patch' ? 'EVA-1' : '')), roughness: 0.75, alphaTest: 0.5 }); break;
      default: out[key] = new THREE.MeshStandardMaterial(common);
    }
  }
  return out;
}

function toBufferGeometry(g) {
  const geom = new THREE.BufferGeometry();
  const n = g.P.length / 3;
  geom.setAttribute('position', new THREE.Float32BufferAttribute(g.P, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(g.N, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(g.U.length ? g.U : new Array(n * 2).fill(0), 2));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(g.C || new Array(n * 3).fill(1), 3));
  geom.setIndex(g.I);
  geom.computeBoundingSphere();
  return geom;
}

function toThree(node, mats, doubleSided) {
  let obj;
  if (node.mesh) {
    const { g, mat } = node.mesh;
    let geom, material = mats[mat];
    if (node.tag) geom = new THREE.PlaneGeometry(0.096, 0.022);
    else if (node.disc) geom = new THREE.CircleGeometry(node.disc, 48);
    else geom = toBufferGeometry(g);
    if ((node.tag || node.disc) && !geom.getAttribute('color')) geom.setAttribute('color', new THREE.Float32BufferAttribute(new Array(geom.getAttribute('position').count * 3).fill(1), 3));
    if (g.doubleSided && material.side !== THREE.DoubleSide) {
      if (!doubleSided.has(mat)) { const m = material.clone(); m.side = THREE.DoubleSide; doubleSided.set(mat, m); }
      material = doubleSided.get(mat);
    }
    obj = new THREE.Mesh(geom, material);
  } else {
    obj = new THREE.Group();
  }
  obj.position.fromArray(node.p);
  if (node.tag || node.disc) obj.rotation.set(0, 0, 0); else obj.rotation.set(node.r[0], node.r[1], node.r[2]);
  if (!(node.tag || node.disc)) obj.scale.fromArray(node.s);
  node.object = obj;
  for (const k of node.kids) obj.add(toThree(k, mats, doubleSided));
  return obj;
}

/**
 * An astronaut in the EVA suit, seated in the rover seat centred at `seatX`.
 * @param {Record<string, THREE.Material>} mats from createSuitMaterials()
 * @param {{ seatX: number, upperBody?: boolean }} opts upperBody=false gives the driver's own legs (seen when looking down)
 * @returns {{ group: THREE.Group, head: THREE.Object3D|null }} head is the helmet pivot (turn it to look around)
 */
export function createSeatedAstronaut(mats, { seatX, upperBody = true }) {
  // The suit graph faces +Z; the rover faces -Z, so the figure is turned 180 degrees.
  const origin = new THREE.Vector3(seatX, SEAT.top - 0.75 * SCALE, SEAT.hipZ);
  const toLocal = (y, z) => [(y - origin.y) / SCALE, (origin.z - z) / SCALE];
  const ankle = toLocal(SEAT.footrestTop + 0.204 * SCALE, SEAT.ankleZ);
  const leg = solveLeg([0.88, 0], ankle);
  const legs = { 1: leg, '-1': leg };
  const { root, helmet } = buildSuitGraph({ upperBody, legs, arms: SEATED_ARMS, recline: RECLINE, visorDown: true });
  const group = new THREE.Group();
  group.name = upperBody ? 'astronaut' : 'astronaut-legs';
  group.position.copy(origin);
  group.rotation.y = Math.PI;
  group.scale.setScalar(SCALE);
  group.add(toThree(root, mats, new Map()));
  return { group, head: helmet ? helmet.object : null };
}
