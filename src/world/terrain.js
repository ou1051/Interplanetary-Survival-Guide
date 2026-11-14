import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { TERRAIN, FEATURES, ROUTE_POINTS, HAB } from '../config/mission.js';
import { mulberry32, smoothstep, clamp } from '../core/math.js';

// ---------------------------------------------------------------------------
// Procedural Martian terrain. This is the ONE place to swap in a real DEM later:
// replace `rawHeight` with a lookup into a HiRISE/CTX/MOLA elevation raster.
// ---------------------------------------------------------------------------

const rand = mulberry32(TERRAIN.seed);
const simplex = new SimplexNoise({ random: rand });

function fbm(x, z, octaves, freq) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * simplex.noise(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function ridged(x, z, octaves, freq) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(simplex.noise(x * freq, z * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

// Simple-crater profile: parabolic bowl + raised rim + ejecta apron.
function crater(r, R, depth) {
  const rim = depth * 0.28;
  let h = 0;
  if (r < R) h -= depth * (1 - (r / R) ** 2);
  h += rim * Math.exp(-(((r - R) / (0.28 * R)) ** 2));
  if (r > R) h += rim * 0.35 * Math.exp(-(r - R) / (0.9 * R));
  return h;
}

// Distance from a point to the planned route polyline (used to keep the
// corridor free of small random craters and rocks).
export function distanceToRoute(x, z) {
  let best = Infinity;
  for (let i = 0; i < ROUTE_POINTS.length - 1; i++) {
    const [ax, az] = ROUTE_POINTS[i];
    const [bx, bz] = ROUTE_POINTS[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const t = clamp(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz), 0, 1);
    const d = Math.hypot(x - (ax + vx * t), z - (az + vz * t));
    if (d < best) best = d;
  }
  return best;
}

// Scatter of small craters, kept out of the traverse corridor.
const smallCraters = [];
{
  const inner = TERRAIN.inner;
  let guard = 0;
  while (smallCraters.length < 46 && guard++ < 4000) {
    const R = 3 + rand() ** 2 * 26;
    const x = inner.cx + (rand() - 0.5) * inner.size * 0.95;
    const z = inner.cz + (rand() - 0.5) * inner.size * 0.95;
    if (distanceToRoute(x, z) < R * 2.2 + 16) continue;
    if (Math.hypot(x - HAB.x, z - HAB.z) < 80) continue;
    smallCraters.push({ x, z, R, depth: R * (0.12 + rand() * 0.1) });
  }
}

// Masks describing geologic units. Shared by the height model and the mock
// data layers so that "data" and terrain tell a consistent story.
export function featureMasks(x, z) {
  const D = FEATURES.delta;
  const dx = x - D.cx;
  const dz = z - D.cz;
  const r = Math.hypot(dx, dz);
  const th = Math.atan2(dz, dx);
  const R =
    D.radius +
    34 * simplex.noise(Math.cos(th) * 1.4 + 5, Math.sin(th) * 1.4 + 5) +
    12 * simplex.noise(Math.cos(th) * 4 + 9, Math.sin(th) * 4 - 3);
  const deltaEdgeDist = r - R;
  const delta = smoothstep(D.edge, -D.edge, deltaEdgeDist);

  const C = FEATURES.freshCrater;
  const rc = Math.hypot(x - C.cx, z - C.cz) / C.radius;
  const ejecta = smoothstep(2.6, 1.0, rc);
  const craterInterior = smoothstep(1.05, 0.85, rc);

  const O = FEATURES.oldCrater;
  const ro = Math.hypot(x - O.cx, z - O.cz) / O.radius;
  const oldCrater = smoothstep(1.6, 0.6, ro);

  const G = FEATURES.ridge;
  const px = x - G.cx;
  const pz = z - G.cz;
  const along = px * G.dx + pz * G.dz;
  const perp = -px * G.dz + pz * G.dx;
  const ridge = Math.exp(-((perp / G.width) ** 2)) * smoothstep(G.halfLength, G.halfLength * 0.55, Math.abs(along));

  const P = FEATURES.ripples;
  const ripple = smoothstep(P.radius, P.radius * 0.55, Math.hypot(x - P.cx, z - P.cz));

  return { delta, deltaEdgeDist, ejecta, craterInterior, oldCrater, ridge, ripple, ridgeAlong: along };
}

function rawHeight(x, z) {
  let h = 0;
  h += 9 * fbm(x, z, 4, 1 / 650);
  h += 2.2 * fbm(x + 311, z - 77, 3, 1 / 140);
  h += 0.45 * fbm(x - 91, z + 402, 2, 1 / 30);

  const m = featureMasks(x, z);

  // Delta: raised lobe with gently terraced (layered) edge.
  const D = FEATURES.delta;
  const n = 6;
  const tn = m.delta * n;
  const terr = (Math.floor(tn) + smoothstep(0.3, 0.7, tn - Math.floor(tn))) / n;
  const prof = m.delta * 0.72 + terr * 0.28;
  h += D.height * prof + m.delta * 3 * fbm(x + 50, z + 50, 2, 1 / 90);

  const C = FEATURES.freshCrater;
  const rc = Math.hypot(x - C.cx, z - C.cz);
  h += crater(rc, C.radius, C.depth);
  h += 0.4 * m.ejecta * fbm(x, z, 2, 1 / 16);

  const O = FEATURES.oldCrater;
  h += crater(Math.hypot(x - O.cx, z - O.cz), O.radius, O.depth) * 0.8;

  for (let i = 0; i < smallCraters.length; i++) {
    const c = smallCraters[i];
    const dx = x - c.x;
    const dz = z - c.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < (c.R * 3.5) ** 2) h += crater(Math.sqrt(d2), c.R, c.depth);
  }

  const G = FEATURES.ridge;
  h += G.height * m.ridge * (0.85 + 0.15 * simplex.noise(m.ridgeAlong / 80, 3.3));

  const P = FEATURES.ripples;
  if (m.ripple > 0) {
    const phase = (x * 0.28 + z * 0.96) * ((2 * Math.PI) / 12) + 1.5 * simplex.noise(x / 40, z / 40);
    h += P.amplitude * 1.6 * m.ripple * Math.sin(phase);
  }

  // Basin rim mountains on the horizon.
  const B = FEATURES.basin;
  const rb = Math.hypot(x - B.cx, z - B.cz);
  if (rb > 1500) {
    const rim = smoothstep(1700, 3900, rb);
    h += B.rimHeight * rim * (0.65 + 0.35 * fbm(x, z, 3, 1 / 1400));
    h += 140 * rim * ridged(x, z, 4, 1 / 900);
  }
  return h;
}

const HAB_BASE = rawHeight(HAB.x, HAB.z);

// Analytic height (used for the coarse horizon mesh and anything off-grid).
export function analyticHeight(x, z) {
  const h = rawHeight(x, z);
  const r = Math.hypot(x - HAB.x, z - HAB.z);
  return h + (HAB_BASE - h) * smoothstep(70, 22, r); // levelled landing / hab pad
}

// ---------------------------------------------------------------------------
// Grid mesh with a known triangulation so we can sample exactly what we render.
// Cell corners: p00(ix,iz) p10(ix+1,iz) p01(ix,iz+1) p11(ix+1,iz+1);
// triangles (p00,p01,p10) and (p10,p01,p11).
// ---------------------------------------------------------------------------
function buildGrid({ cx, cz, size, segments }, heightFn) {
  const n = segments + 1;
  const step = size / segments;
  const x0 = cx - size / 2;
  const z0 = cz - size / 2;
  const heights = new Float32Array(n * n);
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      const x = x0 + ix * step;
      const z = z0 + iz * step;
      const h = heightFn(x, z, ix, iz);
      heights[i] = h;
      pos[i * 3] = x;
      pos[i * 3 + 1] = h;
      pos[i * 3 + 2] = z;
      uv[i * 2] = x / 7;
      uv[i * 2 + 1] = z / 7;
    }
  }
  const index = new Uint32Array(segments * segments * 6);
  let k = 0;
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const p00 = iz * n + ix;
      const p10 = p00 + 1;
      const p01 = p00 + n;
      const p11 = p01 + 1;
      index[k++] = p00; index[k++] = p01; index[k++] = p10;
      index[k++] = p10; index[k++] = p01; index[k++] = p11;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  return { geo, heights, n, step, x0, z0 };
}

// Tileable value-noise texture used as fine regolith grain (+ normal map).
function makeDetailTextures() {
  const S = 256;
  const lattice = (period, r) => {
    const g = new Float32Array(period * period);
    for (let i = 0; i < g.length; i++) g[i] = r();
    return g;
  };
  const r = mulberry32(99);
  const layers = [
    { p: 8, a: 0.45, g: null },
    { p: 16, a: 0.25, g: null },
    { p: 32, a: 0.15, g: null },
    { p: 64, a: 0.1, g: null },
    { p: 128, a: 0.05, g: null },
  ];
  layers.forEach((l) => (l.g = lattice(l.p, r)));
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      for (const l of layers) {
        const fx = (x / S) * l.p;
        const fy = (y / S) * l.p;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const g = (a, b) => l.g[((b + l.p) % l.p) * l.p + ((a + l.p) % l.p)];
        const top = g(ix, iy) + (g(ix + 1, iy) - g(ix, iy)) * sx;
        const bot = g(ix, iy + 1) + (g(ix + 1, iy + 1) - g(ix, iy + 1)) * sx;
        v += l.a * (top + (bot - top) * sy);
      }
      // sprinkle pebbles
      if (r() < 0.012) v += 0.25;
      h[y * S + x] = v;
    }
  }
  const color = new Uint8Array(S * S * 4);
  const normal = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const v = h[i];
      const c = Math.round(clamp(150 + (v - 0.5) * 210, 0, 255));
      color[i * 4] = c; color[i * 4 + 1] = c; color[i * 4 + 2] = c; color[i * 4 + 3] = 255;
      const hl = h[y * S + ((x - 1 + S) % S)];
      const hr = h[y * S + ((x + 1) % S)];
      const hd = h[((y - 1 + S) % S) * S + x];
      const hu = h[((y + 1) % S) * S + x];
      let nx = (hl - hr) * 6;
      let ny = (hd - hu) * 6;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      normal[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal[i * 4 + 3] = 255;
    }
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(color, true), normalMap: mk(normal, false) };
}

const STRIDE = 12;

function unpackContext(data, i, ctx) {
  const o = i * STRIDE;
  ctx.x = data[o];
  ctx.z = data[o + 1];
  ctx.h = data[o + 2];
  ctx.slope = data[o + 3];
  ctx.n1 = data[o + 4];
  ctx.n2 = data[o + 5];
  const m = ctx.m;
  m.delta = data[o + 6];
  m.ejecta = data[o + 7];
  m.craterInterior = data[o + 8];
  m.oldCrater = data[o + 9];
  m.ridge = data[o + 10];
  m.ripple = data[o + 11];
}

// Same context for an arbitrary point (used by the 2D map renderer).
export function sampleContext(terrain, x, z, ctx) {
  ctx.x = x;
  ctx.z = z;
  ctx.h = terrain.heightAt(x, z);
  ctx.slope = terrain.slopeAt(x, z, 2);
  ctx.n1 = simplex.noise(x / 55, z / 55);
  ctx.n2 = simplex.noise(x / 9 + 40, z / 9 - 40);
  ctx.m = featureMasks(x, z);
  return ctx;
}

export class Terrain {
  constructor() {
    const I = TERRAIN.inner;
    this.inner = buildGrid(I, (x, z) => analyticHeight(x, z));
    this.innerBounds = { x0: I.cx - I.size / 2, x1: I.cx + I.size / 2, z0: I.cz - I.size / 2, z1: I.cz + I.size / 2 };

    const O = TERRAIN.outer;
    const b = this.innerBounds;
    // Horizon mesh: vertices strictly inside the detailed area are pushed down
    // so the detailed mesh always wins (grid lines are aligned on the border).
    this.outer = buildGrid(O, (x, z) => {
      const inside = x > b.x0 + 1 && x < b.x1 - 1 && z > b.z0 + 1 && z < b.z1 - 1;
      return analyticHeight(x, z) - (inside ? 40 : 0);
    });

    const tex = makeDetailTextures();
    this.textures = tex;

    // Per-vertex data for the data layers.
    this.vertexInfo = this._computeVertexInfo(this.inner);
    this.outerInfo = this._computeVertexInfo(this.outer);

    const makeMat = () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: tex.map,
        normalMap: tex.normalMap,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughness: 0.96,
        metalness: 0.0,
      });

    this.mesh = new THREE.Mesh(this.inner.geo, makeMat());
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain-inner';

    this.outerMesh = new THREE.Mesh(this.outer.geo, makeMat());
    this.outerMesh.receiveShadow = false;
    this.outerMesh.name = 'terrain-outer';

    this.group = new THREE.Group();
    this.group.add(this.mesh, this.outerMesh);
  }

  // Packed per-vertex context: x, z, h, slope, n1, n2, delta, ejecta,
  // craterInterior, oldCrater, ridge, ripple  (STRIDE floats per vertex)
  _computeVertexInfo(grid) {
    const pos = grid.geo.attributes.position.array;
    const nrm = grid.geo.attributes.normal.array;
    const count = pos.length / 3;
    const data = new Float32Array(count * STRIDE);
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3];
      const z = pos[i * 3 + 2];
      const m = featureMasks(x, z);
      const o = i * STRIDE;
      data[o] = x;
      data[o + 1] = z;
      data[o + 2] = pos[i * 3 + 1];
      data[o + 3] = Math.acos(clamp(nrm[i * 3 + 1], -1, 1)) * (180 / Math.PI);
      data[o + 4] = simplex.noise(x / 55, z / 55);
      data[o + 5] = simplex.noise(x / 9 + 40, z / 9 - 40);
      data[o + 6] = m.delta;
      data[o + 7] = m.ejecta;
      data[o + 8] = m.craterInterior;
      data[o + 9] = m.oldCrater;
      data[o + 10] = m.ridge;
      data[o + 11] = m.ripple;
    }
    return { data, count };
  }

  applyLayer(layer) {
    const ctx = { x: 0, z: 0, h: 0, slope: 0, n1: 0, n2: 0, m: {} };
    const paint = (grid, info) => {
      const { data, count } = info;
      let col = grid.geo.getAttribute('color');
      if (!col) {
        col = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
        grid.geo.setAttribute('color', col);
      }
      const arr = col.array;
      const c = new THREE.Color();
      for (let i = 0; i < count; i++) {
        unpackContext(data, i, ctx);
        layer.color(ctx, c);
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      col.needsUpdate = true;
    };
    paint(this.inner, this.vertexInfo);
    paint(this.outer, this.outerInfo);
    // Data layers read better without the regolith grain texture.
    const grain = layer.id === 'optical' ? this.textures.map : null;
    for (const m of [this.mesh.material, this.outerMesh.material]) {
      m.map = grain;
      m.needsUpdate = true;
    }
  }

  // Height of the rendered surface (exact triangle interpolation).
  heightAt(x, z) {
    const g = this.inner;
    const fx = (x - g.x0) / g.step;
    const fz = (z - g.z0) / g.step;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    if (ix < 0 || iz < 0 || ix >= g.n - 1 || iz >= g.n - 1) return analyticHeight(x, z);
    const tx = fx - ix;
    const tz = fz - iz;
    const H = g.heights;
    const n = g.n;
    const h00 = H[iz * n + ix];
    const h10 = H[iz * n + ix + 1];
    const h01 = H[(iz + 1) * n + ix];
    const h11 = H[(iz + 1) * n + ix + 1];
    if (tx + tz <= 1) return h00 + tx * (h10 - h00) + tz * (h01 - h00);
    return h11 + (1 - tx) * (h01 - h11) + (1 - tz) * (h10 - h11);
  }

  // Surface slope in degrees, from central differences of the rendered surface.
  slopeAt(x, z, d = 2) {
    const gx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    const gz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return Math.atan(Math.hypot(gx, gz)) * (180 / Math.PI);
  }
}
