import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ---------------------------------------------------------------------------
// Route marker post v2: square-section black post with a slanted top, a red
// reflector panel held by two screws, an amber reflective band, and dust/rust
// creeping up from the base. Origin at the foot; the reflector faces -Z.
// ---------------------------------------------------------------------------

export const MARKER = { height: 1.5, width: 0.12, depth: 0.08 };

function tex(w, h, paint, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Body: matte dark grey with grain; rust and dust fading up from the bottom (v=0 at the foot).
function bodyTextures() {
  const paint = (rough) => (g, w, h) => {
    g.fillStyle = rough ? '#c8c8c8' : '#2b2b2c';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5000; i++) {
      g.fillStyle = rough ? `rgba(255,255,255,${Math.random() * 0.15})` : `rgba(${Math.random() > 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.06})`;
      g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
    }
    // rust / dust at the base (bottom of the canvas = foot)
    for (let i = 0; i < 1600; i++) {
      const y = h - Math.pow(Math.random(), 2.2) * h * 0.24;
      const r = 1 + Math.random() * 3;
      g.fillStyle = rough ? `rgba(255,255,255,${0.3 + Math.random() * 0.4})` : ['rgba(110,52,26,', 'rgba(150,78,40,', 'rgba(70,36,20,'][i % 3] + `${0.25 + Math.random() * 0.5})`;
      g.beginPath(); g.arc(Math.random() * w, y, r, 0, Math.PI * 2); g.fill();
    }
    const grd = g.createLinearGradient(0, h, 0, h * 0.78);
    grd.addColorStop(0, rough ? 'rgba(255,255,255,.6)' : 'rgba(110,55,28,.75)');
    grd.addColorStop(1, 'rgba(110,55,28,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  };
  return { map: tex(128, 1024, paint(false)), roughnessMap: tex(128, 1024, paint(true), false) };
}

// Retro-reflective sheeting: cell pattern.
function reflectiveTexture(base, cell) {
  return tex(128, 128, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    g.strokeStyle = cell; g.lineWidth = 0.6;
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = 1 + Math.random() * 1.6;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    }
  });
}

let shared;
function materials() {
  if (shared) return shared;
  const body = bodyTextures();
  shared = {
    body: new THREE.MeshStandardMaterial({ ...body, color: 0xffffff, roughness: 0.75, metalness: 0.15 }),
    band: new THREE.MeshStandardMaterial({ map: reflectiveTexture('#e6a01a', '#a86a08'), roughness: 0.35, metalness: 0.1, emissive: 0x3a2200, emissiveIntensity: 0.25 }),
    reflector: new THREE.MeshStandardMaterial({ map: reflectiveTexture('#c4140e', '#6a0604'), roughness: 0.2, metalness: 0.1, emissive: 0xff2010, emissiveIntensity: 0.9 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x141415, roughness: 0.5, metalness: 0.4 }),
    screw: new THREE.MeshStandardMaterial({ color: 0x9a9da2, roughness: 0.3, metalness: 0.9 }),
  };
  return shared;
}

export function createMarkerPost() {
  const { height: H, width: W, depth: D } = MARKER;
  const M = materials();
  const g = new THREE.Group();

  // body with a slanted top: drop the back-top vertices of a rounded box
  const geo = new RoundedBoxGeometry(W, H, D, 3, 0.012);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), z = p.getZ(i);
    if (y > H / 2 - 0.03) p.setY(i, y - ((z + D / 2) / D) * 0.06); // front (−Z) high, back low
  }
  geo.computeVertexNormals();
  geo.translate(0, H / 2, 0);
  // remap v so the texture runs foot→top
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, p.getY(i) / H);
  const body = new THREE.Mesh(geo, M.body);
  g.add(body);

  // amber band
  const band = new THREE.Mesh(new THREE.BoxGeometry(W + 0.004, 0.13, D + 0.004), M.band);
  band.position.y = H - 0.37;
  g.add(band);

  // red reflector on the front face, recessed in a black frame with two screws
  const frame = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.2, 0.012, 2, 0.006), M.frame);
  frame.position.set(0, H - 0.16, -D / 2 - 0.004);
  g.add(frame);
  const refl = new THREE.Mesh(new THREE.PlaneGeometry(0.044, 0.15), M.reflector);
  refl.position.set(0, H - 0.16, -D / 2 - 0.0105);
  refl.rotation.y = Math.PI;
  g.add(refl);
  for (const dy of [-0.088, 0.088]) {
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 12), M.screw);
    screw.rotation.x = Math.PI / 2;
    screw.position.set(0, H - 0.16 + dy, -D / 2 - 0.012);
    g.add(screw);
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, reflector: refl, materials: M };
}
