import * as THREE from 'three';
import { mulberry32 } from '../core/math.js';

// Procedural surface detail for hard-surface props (rover, survey posts):
// a colour map (dust, scratches, chips), a roughness map and a normal map,
// all drawn once on canvases and shared between materials.

const cache = new Map();

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d') };
}

function tex(c, srgb, repeat = [1, 1]) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

// Height canvas (grey) → tangent-space normal map canvas.
function heightToNormal(src, strength = 2) {
  const w = src.width, h = src.height;
  const d = src.getContext('2d').getImageData(0, 0, w, h).data;
  const { c, g } = canvas(w, h);
  const out = g.createImageData(w, h);
  const H = (x, y) => d[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      out.data[i + 1] = (dy / len * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}

function blotches(g, r, size, n, colour, aMin, aMax, rMin, rMax) {
  for (let i = 0; i < n; i++) {
    const x = r() * size, y = r() * size, rad = rMin + r() * (rMax - rMin);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(${colour},${aMin + r() * (aMax - aMin)})`);
    grd.addColorStop(1, `rgba(${colour},0)`);
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

// Worn, dusty painted/anodised metal. Colour map is near-white so it multiplies
// the material colour; dust collects in streaks, scratches catch the light.
export function wornMetal({ seed = 1, dust = 0.5, repeat = [1, 1] } = {}) {
  const key = `metal:${seed}:${dust}:${repeat}`;
  if (cache.has(key)) return cache.get(key);
  const S = 512, r = mulberry32(seed);
  const col = canvas(S), rough = canvas(S), height = canvas(S);
  col.g.fillStyle = '#ffffff'; col.g.fillRect(0, 0, S, S);
  rough.g.fillStyle = '#8a8a8a'; rough.g.fillRect(0, 0, S, S);
  height.g.fillStyle = '#808080'; height.g.fillRect(0, 0, S, S);

  // fine grain
  for (let i = 0; i < 9000; i++) {
    const x = r() * S, y = r() * S, v = r();
    col.g.fillStyle = `rgba(${v > 0.5 ? '255,255,255' : '60,40,30'},${0.04 + r() * 0.05})`;
    col.g.fillRect(x, y, 1.5, 1.5);
    rough.g.fillStyle = `rgba(${v > 0.5 ? '255,255,255' : '0,0,0'},0.12)`;
    rough.g.fillRect(x, y, 2, 2);
    height.g.fillStyle = `rgba(${v > 0.5 ? '255,255,255' : '0,0,0'},0.18)`;
    height.g.fillRect(x, y, 1.5, 1.5);
  }
  // brushed streaks along u
  for (let i = 0; i < 260; i++) {
    const y = r() * S, x = r() * S, len = 40 + r() * 200, a = 0.03 + r() * 0.05;
    rough.g.strokeStyle = `rgba(0,0,0,${a * 2})`;
    rough.g.lineWidth = 1;
    rough.g.beginPath(); rough.g.moveTo(x, y); rough.g.lineTo(x + len, y + (r() - 0.5) * 3); rough.g.stroke();
  }
  // Martian dust: soft rust blotches, rougher where dusty
  blotches(col.g, r, S, Math.round(70 * dust), '176,104,66', 0.12, 0.35, 20, 90);
  blotches(rough.g, r, S, Math.round(70 * dust), '255,255,255', 0.15, 0.4, 20, 90);
  // dust settled toward the bottom edge (v = 1)
  const grd = col.g.createLinearGradient(0, S * 0.55, 0, S);
  grd.addColorStop(0, 'rgba(170,98,60,0)');
  grd.addColorStop(1, `rgba(170,98,60,${0.45 * dust})`);
  col.g.fillStyle = grd; col.g.fillRect(0, 0, S, S);
  // scratches: bright, smoother, slightly recessed
  for (let i = 0; i < 90; i++) {
    const x = r() * S, y = r() * S, a = r() * Math.PI, len = 8 + r() * 40;
    const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
    col.g.strokeStyle = `rgba(255,255,255,${0.25 + r() * 0.3})`;
    col.g.lineWidth = 0.8;
    col.g.beginPath(); col.g.moveTo(x, y); col.g.lineTo(x2, y2); col.g.stroke();
    rough.g.strokeStyle = 'rgba(0,0,0,0.5)';
    rough.g.beginPath(); rough.g.moveTo(x, y); rough.g.lineTo(x2, y2); rough.g.stroke();
    height.g.strokeStyle = 'rgba(0,0,0,0.7)';
    height.g.lineWidth = 1;
    height.g.beginPath(); height.g.moveTo(x, y); height.g.lineTo(x2, y2); height.g.stroke();
  }
  // a few dents
  blotches(height.g, r, S, 14, '0,0,0', 0.15, 0.3, 10, 40);

  const set = {
    map: tex(col.c, true, repeat),
    roughnessMap: tex(rough.c, false, repeat),
    normalMap: tex(heightToNormal(height.c, 2.5), false, repeat),
  };
  cache.set(key, set);
  return set;
}

// Crinkled multi-layer insulation (gold Kapton foil) for cargo and battery boxes.
export function foil({ seed = 3 } = {}) {
  const key = `foil:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const S = 512, r = mulberry32(seed);
  const col = canvas(S), rough = canvas(S), height = canvas(S);
  col.g.fillStyle = '#ffffff'; col.g.fillRect(0, 0, S, S);
  rough.g.fillStyle = '#4a4a4a'; rough.g.fillRect(0, 0, S, S);
  height.g.fillStyle = '#808080'; height.g.fillRect(0, 0, S, S);
  // facets of crumpled film: random triangles at random heights
  for (let i = 0; i < 1400; i++) {
    const x = r() * S, y = r() * S, s = 10 + r() * 40;
    const v = Math.floor(70 + r() * 120);
    height.g.fillStyle = `rgba(${v},${v},${v},0.55)`;
    height.g.beginPath();
    height.g.moveTo(x, y);
    height.g.lineTo(x + (r() - 0.5) * s * 2, y + (r() - 0.5) * s * 2);
    height.g.lineTo(x + (r() - 0.5) * s * 2, y + (r() - 0.5) * s * 2);
    height.g.fill();
    const c = Math.floor(200 + r() * 55);
    col.g.fillStyle = `rgba(${c},${Math.floor(c * 0.92)},${Math.floor(c * 0.8)},0.35)`;
    col.g.beginPath();
    col.g.moveTo(x, y);
    col.g.lineTo(x + (r() - 0.5) * s * 2, y + (r() - 0.5) * s * 2);
    col.g.lineTo(x + (r() - 0.5) * s * 2, y + (r() - 0.5) * s * 2);
    col.g.fill();
  }
  // long creases
  for (let i = 0; i < 40; i++) {
    const x = r() * S, y = r() * S, a = r() * Math.PI, len = 60 + r() * 220;
    height.g.strokeStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},0.6)`;
    height.g.lineWidth = 1.5;
    height.g.beginPath(); height.g.moveTo(x, y); height.g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); height.g.stroke();
  }
  // tape seams around the edges, and dust
  col.g.strokeStyle = 'rgba(150,120,70,0.8)';
  col.g.lineWidth = 18;
  col.g.strokeRect(0, 0, S, S);
  rough.g.strokeStyle = 'rgba(255,255,255,0.8)';
  rough.g.lineWidth = 18;
  rough.g.strokeRect(0, 0, S, S);
  blotches(col.g, r, S, 40, '170,100,62', 0.15, 0.4, 20, 80);
  blotches(rough.g, r, S, 40, '255,255,255', 0.2, 0.5, 20, 80);

  const set = {
    map: tex(col.c, true),
    roughnessMap: tex(rough.c, false),
    normalMap: tex(heightToNormal(height.c, 4), false),
  };
  cache.set(key, set);
  return set;
}

// Soft radial shadow under a vehicle: grounds it even where the sun's shadow
// falls off to the side.
export function contactShadow(width, length, opacity = 0.55) {
  const { c, g } = canvas(128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,1)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.75)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, length).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: t, transparent: true, opacity, depthWrite: false, color: 0x1a0a04,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }),
  );
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}
