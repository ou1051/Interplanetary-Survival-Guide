// ---------------------------------------------------------------------------
// Procedural EVA suit (Apollo-style pressure suit) as a renderer-agnostic scene graph.
//
// Everything here is plain JS (no three.js), so it can be built, posed and
// tested anywhere; ./astronaut.js turns the graph into three.js meshes.
//
// Frame: metres, +Y up, the astronaut faces +Z, feet on y = 0 when standing.
// A node is { p, r, s, kids, mesh } where r is an XYZ Euler rotation and
// mesh = { g, mat }: g holds flat arrays P/N/U/C/I (positions, normals, uvs,
// per-vertex shade, indices) and mat names an entry of SUIT_MATERIALS.
//
// Realism comes from geometry, not textures: inflated fabric with folds that
// gather on the compression side of each joint, one continuous leg bent at the
// knee (so the knee bunches instead of showing stacked rings), a fabric-covered
// backpack with straps and hardware, and a helmet with a framed gold visor.
// Crease shading and dust are baked into the per-vertex colour.
// ---------------------------------------------------------------------------

/* eslint-disable no-mixed-operators */
function hash3(x, y, z) { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
const fade = t => t * t * (3 - 2 * t);
function noise3(x, y, z) { const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z); const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const a = hash3(xi, yi, zi), b = hash3(xi + 1, yi, zi), c = hash3(xi, yi + 1, zi), d = hash3(xi + 1, yi + 1, zi), e = hash3(xi, yi, zi + 1), f = hash3(xi + 1, yi, zi + 1), g = hash3(xi, yi + 1, zi + 1), h = hash3(xi + 1, yi + 1, zi + 1);
  const x1 = a + (b - a) * u, x2 = c + (d - c) * u, x3 = e + (f - e) * u, x4 = g + (h - g) * u; const y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v; return y1 + (y2 - y1) * w; }
function fbm(x, y, z, oct = 5) { let s = 0, a = 0.5, t = 0, f = 1; for (let i = 0; i < oct; i++) { s += a * noise3(x * f, y * f, z * f); t += a; a *= 0.5; f *= 2.03; } return s / t; }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const V = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }, dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] };
function mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
function trs(p, e, s) { const te = new Float32Array(16); const a = Math.cos(e[0]), b = Math.sin(e[0]), c = Math.cos(e[1]), d = Math.sin(e[1]), ee = Math.cos(e[2]), f = Math.sin(e[2]);
  const ae = a * ee, af = a * f, be = b * ee, bf = b * f;
  te[0] = c * ee; te[4] = -c * f; te[8] = d; te[1] = af + be * d; te[5] = ae - bf * d; te[9] = -b * c; te[2] = bf - ae * d; te[6] = be + af * d; te[10] = a * c;
  for (let i = 0; i < 3; i++) { te[i] *= s[0]; te[4 + i] *= s[1]; te[8 + i] *= s[2]; } te[12] = p[0]; te[13] = p[1]; te[14] = p[2]; te[15] = 1; return te; }
function xform(m, p) { return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]; }

const geo = () => ({ P: [], N: [], U: [], C: null, I: [] });
function computeNormals(g) { const P = g.P, N = new Array(P.length).fill(0);
  for (let t = 0; t < g.I.length; t += 3) { const a = g.I[t] * 3, b = g.I[t + 1] * 3, c = g.I[t + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]], n = V.cross(e1, e2);
    for (const k of [a, b, c]) { N[k] += n[0]; N[k + 1] += n[1]; N[k + 2] += n[2]; } }
  for (let i = 0; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
  g.N = N; return g; }
function smoothSeams(g) { const P = g.P, N = g.N, map = new Map();
  for (let i = 0; i < P.length / 3; i++) { const k = P[i * 3].toFixed(5) + ',' + P[i * 3 + 1].toFixed(5) + ',' + P[i * 3 + 2].toFixed(5); let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(i); }
  for (const a of map.values()) { if (a.length < 2) continue; let x = 0, y = 0, z = 0; for (const i of a) { x += N[i * 3]; y += N[i * 3 + 1]; z += N[i * 3 + 2]; } const l = Math.hypot(x, y, z) || 1; for (const i of a) { N[i * 3] = x / l; N[i * 3 + 1] = y / l; N[i * 3 + 2] = z / l; } }
  return g; }
function scaleGeo(g, sx, sy, sz) { for (let i = 0; i < g.P.length; i += 3) { g.P[i] *= sx; g.P[i + 1] *= sy; g.P[i + 2] *= sz; const n = V.norm([g.N[i] / sx, g.N[i + 1] / sy, g.N[i + 2] / sz]); g.N[i] = n[0]; g.N[i + 1] = n[1]; g.N[i + 2] = n[2]; } return g; }
function lathe(pts, segs) { const g = geo(), L = pts.length;
  for (let i = 0; i <= segs; i++) { const phi = i / segs * Math.PI * 2, s = Math.sin(phi), c = Math.cos(phi);
    for (let j = 0; j < L; j++) { g.P.push(pts[j][0] * s, pts[j][1], pts[j][0] * c); g.U.push(i / segs, j / (L - 1)); } }
  for (let i = 0; i < segs; i++) for (let j = 0; j < L - 1; j++) { const a = j + i * L, b = a + L, c = a + L + 1, d = a + 1; g.I.push(a, b, d, c, d, b); }
  return smoothSeams(computeNormals(g)); }
function sphere(r, ws, hs, ps = 0, pl = Math.PI * 2, ts = 0, tl = Math.PI) { const g = geo(), te = Math.min(ts + tl, Math.PI), grid = [];
  for (let iy = 0; iy <= hs; iy++) { const row = [], v = iy / hs;
    for (let ix = 0; ix <= ws; ix++) { const u = ix / ws, ph = ps + u * pl, th = ts + v * tl;
      const x = -r * Math.cos(ph) * Math.sin(th), y = r * Math.cos(th), z = r * Math.sin(ph) * Math.sin(th);
      g.P.push(x, y, z); const n = V.norm([x, y, z]); g.N.push(...n); g.U.push(u, 1 - v); row.push(g.P.length / 3 - 1); } grid.push(row); }
  for (let iy = 0; iy < hs; iy++) for (let ix = 0; ix < ws; ix++) { const a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1];
    if (iy !== 0 || ts > 0) g.I.push(a, b, d); if (iy !== hs - 1 || te < Math.PI) g.I.push(b, c, d); }
  return g; }
function cylinder(rt, rb, h, rs, open = false, ts = 0, tl = Math.PI * 2) { const g = geo(), idx = [], slope = (rb - rt) / h;
  for (let y = 0; y <= 1; y++) { const row = [], rad = y * (rb - rt) + rt;
    for (let x = 0; x <= rs; x++) { const u = x / rs, th = u * tl + ts, s = Math.sin(th), c = Math.cos(th);
      g.P.push(rad * s, -y * h + h / 2, rad * c); g.N.push(...V.norm([s, slope, c])); g.U.push(u, 1 - y); row.push(g.P.length / 3 - 1); } idx.push(row); }
  for (let x = 0; x < rs; x++) { const a = idx[0][x], b = idx[1][x], c = idx[1][x + 1], d = idx[0][x + 1]; g.I.push(a, b, d, b, c, d); }
  if (!open) for (const top of [true, false]) { const rad = top ? rt : rb, sign = top ? 1 : -1, cs = g.P.length / 3;
    for (let x = 0; x < rs; x++) { g.P.push(0, h / 2 * sign, 0); g.N.push(0, sign, 0); g.U.push(0.5, 0.5); }
    const is = g.P.length / 3;
    for (let x = 0; x <= rs; x++) { const th = x / rs * tl + ts; g.P.push(rad * Math.sin(th), h / 2 * sign, rad * Math.cos(th)); g.N.push(0, sign, 0); g.U.push(Math.cos(th) * 0.5 + 0.5, Math.sin(th) * 0.5 * sign + 0.5); }
    for (let x = 0; x < rs; x++) { const c = cs + x, i = is + x; if (top) g.I.push(i, i + 1, c); else g.I.push(i + 1, i, c); } }
  return g; }
function torus(R, r, rad, tub, arc = Math.PI * 2) { const g = geo();
  for (let j = 0; j <= rad; j++) for (let i = 0; i <= tub; i++) { const u = i / tub * arc, v = j / rad * Math.PI * 2;
    const x = (R + r * Math.cos(v)) * Math.cos(u), y = (R + r * Math.cos(v)) * Math.sin(u), z = r * Math.sin(v);
    g.P.push(x, y, z); g.N.push(...V.norm([x - R * Math.cos(u), y - R * Math.sin(u), z])); g.U.push(i / tub, j / rad); }
  for (let j = 1; j <= rad; j++) for (let i = 1; i <= tub; i++) { const a = (tub + 1) * j + i - 1, b = (tub + 1) * (j - 1) + i - 1, c = (tub + 1) * (j - 1) + i, d = (tub + 1) * j + i; g.I.push(a, b, d, b, c, d); }
  return g; }
function rbox(w, h, d, seg = 6, rad = 0.01) { const g = geo(), hw = [w / 2, h / 2, d / 2], inner = hw.map(v => Math.max(0, v - rad));
  const faces = [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]];
  const n = Math.max(seg, 2) * 2;
  for (const [ax, u, v, s] of faces) { const base = g.P.length / 3;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const p = [0, 0, 0]; p[ax] = s * hw[ax]; p[u] = (i / n * 2 - 1) * hw[u]; p[v] = (j / n * 2 - 1) * hw[v];
      const q = p.map((c, k) => Math.max(-inner[k], Math.min(inner[k], c))); let dv = V.sub(p, q); const l = Math.hypot(...dv);
      let nn; if (l < 1e-9) { nn = [0, 0, 0]; nn[ax] = s; } else nn = dv.map(c => c / l);
      g.P.push(q[0] + nn[0] * rad, q[1] + nn[1] * rad, q[2] + nn[2] * rad); g.N.push(...nn); g.U.push(i / n, j / n); }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const a = base + i * (n + 1) + j, b = a + n + 1, c = b + 1, dd = a + 1;
      // orient outward
      const pa = [g.P[a * 3], g.P[a * 3 + 1], g.P[a * 3 + 2]], pb = [g.P[b * 3], g.P[b * 3 + 1], g.P[b * 3 + 2]], pd = [g.P[dd * 3], g.P[dd * 3 + 1], g.P[dd * 3 + 2]];
      const cr = V.cross(V.sub(pb, pa), V.sub(pd, pa)); const out = cr[ax] * s >= 0;
      if (out) g.I.push(a, b, dd, b, c, dd); else g.I.push(a, dd, b, b, dd, c); } }
  return g; }
const box = (w, h, d) => rbox(w, h, d, 1, 0.0004);
function ring(ri, ro, segs) { const g = geo();
  for (let i = 0; i <= segs; i++) { const t = i / segs * Math.PI * 2; for (const r of [ri, ro]) { g.P.push(r * Math.cos(t), r * Math.sin(t), 0); g.N.push(0, 0, 1); g.U.push(0.5, 0.5); } }
  for (let i = 0; i < segs; i++) { const a = i * 2; g.I.push(a, a + 1, a + 3, a, a + 3, a + 2); } return g; }
function catmull(pts, n) { const out = []; const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let s = 1; s < P.length - 2; s++) for (let k = 0; k < n; k++) { const t = k / n, p0 = P[s - 1], p1 = P[s], p2 = P[s + 1], p3 = P[s + 2];
    out.push([0, 1, 2].map(i => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t * t + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t * t * t))); }
  out.push(pts[pts.length - 1]); return out; }
function tube(pts, r, rs) { const g = geo(), C = catmull(pts, 16); let prevN = null;
  for (let i = 0; i < C.length; i++) { const T = V.norm(V.sub(C[Math.min(i + 1, C.length - 1)], C[Math.max(i - 1, 0)]));
    let Nn = prevN ? V.norm(V.cross(V.cross(T, prevN), T)) : V.norm(V.cross(T, Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])); prevN = Nn; const B = V.cross(T, Nn);
    for (let j = 0; j <= rs; j++) { const a = j / rs * Math.PI * 2, n = [0, 1, 2].map(k => Math.cos(a) * Nn[k] + Math.sin(a) * B[k]);
      g.P.push(C[i][0] + n[0] * r, C[i][1] + n[1] * r, C[i][2] + n[2] * r); g.N.push(...n); g.U.push(i / (C.length - 1), j / rs); } }
  for (let i = 0; i < C.length - 1; i++) for (let j = 0; j < rs; j++) { const a = i * (rs + 1) + j, b = a + rs + 1; g.I.push(a, b, a + 1, b, b + 1, a + 1); }
  return g; }
function splinePts(keys, n) { const out = [], P = [keys[0], ...keys, keys[keys.length - 1]];
  for (let s = 1; s < P.length - 2; s++) for (let k = 0; k < n; k++) { const t = k / n, p0 = P[s - 1], p1 = P[s], p2 = P[s + 1], p3 = P[s + 2];
    out.push([0, 1].map(i => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t * t + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t * t * t))); }
  out.push(keys[keys.length - 1]); return out; }
function capsuleProfile(rBot, rTop, len, rows = 48, cap = 10) { const pts = [];
  for (let i = 0; i <= cap; i++) { const a = -Math.PI / 2 + (Math.PI / 2) * i / cap; pts.push([i === 0 ? 0 : rBot * Math.cos(a), -len / 2 + rBot * Math.sin(a)]); }
  for (let i = 1; i < rows; i++) { const t = i / rows; pts.push([rBot + (rTop - rBot) * t, -len / 2 + len * t]); }
  for (let i = 0; i <= cap; i++) { const a = (Math.PI / 2) * i / cap; pts.push([i === cap ? 0 : rTop * Math.cos(a), len / 2 + rTop * Math.sin(a)]); }
  return pts; }
const capsule = (r, len) => lathe(capsuleProfile(r, r, len, 4, 6), 16);
function fixNormals(g, ref) { for (let i = 0; i < g.N.length; i += 3) if (g.N[i] * ref[i] + g.N[i + 1] * ref[i + 1] + g.N[i + 2] * ref[i + 2] < 0) { g.N[i] *= -1; g.N[i + 1] *= -1; g.N[i + 2] *= -1; } }
// Folds: anisotropic, domain-warped crease noise; dense on the compression side near the joint, calm in the inflated middle
function wrinkle(g, { amp = 0.0045, seed = 0, bunch = 0, half = 10, rMax = 0.1, comp = [0, 1], calm = 0.25 } = {}) {
  const P = g.P, C = new Array(P.length).fill(1); g.seam = true;
  for (let i = 0; i < P.length; i += 3) { const x = P[i], y = P[i + 1], z = P[i + 2], r = Math.hypot(x, z); if (r < 1e-5) continue;
    const ay = Math.abs(y), end = ay > half ? Math.max(0, 1 - (ay - half) / (0.7 * rMax)) : 1;
    const t = Math.min(1, Math.max(0, (y + half) / (2 * half)));
    const e0 = Math.exp(-((t / 0.3) ** 2)), e1 = Math.exp(-(((1 - t) / 0.3) ** 2));
    const jw = bunch > 0 ? e1 : bunch < 0 ? e0 : 0.5 * (e0 + e1) + 0.3;
    const cs = 0.5 + 0.5 * ((x / r) * comp[0] + (z / r) * comp[1]);
    const env = calm + (1 - calm) * jw * (0.35 + 0.65 * cs * cs);
    const wx = fbm(x * 5 + seed, y * 5, z * 5, 2) - 0.5, wz = fbm(x * 5 + 9, y * 5 + seed, z * 5 + 3, 2) - 0.5;
    const n = fbm(x * 13 + wx * 2.2 + seed * 3, y * 34 + wx * 7 + wz * 5, z * 13 + wz * 2.2, 2);
    const crease = Math.pow(Math.abs(2 * n - 1), 0.75) - 0.42;
    const n2 = fbm(x * 26 + 4 + seed, y * 70 + wz * 10, z * 26, 2);
    const fine = (Math.pow(Math.abs(2 * n2 - 1), 0.7) - 0.45) * 0.35;
    const bulge = (fbm(x * 3.5 + seed, y * 4.5, z * 3.5, 2) - 0.5) * 1.6;
    const d = amp * end * (env * (crease * 2.1 + fine * (0.4 + jw)) + bulge * 0.6);
    P[i] = x + x / r * d; P[i + 2] = z + z / r * d;
    C[i] = C[i + 1] = C[i + 2] = Math.min(1, 1 + 0.22 * Math.max(-1, Math.min(1, (env * crease * 2.1) / 0.9))); }
  g.C = C; computeNormals(g); smoothSeams(g); return g; }
function fabricLimb(rBot, rTop, len, opts = {}) { const g = lathe(capsuleProfile(rBot, rTop, len), 48); wrinkle(g, { half: len / 2, rMax: Math.max(rBot, rTop), ...opts });
  if (opts.stripes) { g.C = []; for (let i = 0; i < g.P.length; i += 3) { const y = g.P[i + 1]; let red = false; for (const [a, b] of opts.stripes) if (y >= a && y <= b) red = true; if (red) g.C.push(0.62, 0.075, 0.055); else g.C.push(1, 1, 1); } }
  return g; }

const node = (parent, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) => { const n = { p, r, s, kids: [], mesh: null }; if (parent) parent.kids.push(n); return n; };
const add = (parent, g, mat, p, r, s) => { const n = node(parent, p, r, s); n.mesh = { g, mat }; return n; };
const group = node;
function bearing(parent, r, pos, rot = [0, 0, 0], scl = [1, 1, 1], accent = null) { const g = group(parent, pos, rot, scl);
  add(g, cylinder(r + 0.006, r + 0.006, 0.028, 72, true), 'metal');
  for (const s of [-1, 1]) add(g, torus(r + 0.006, 0.0042, 10, 72), s > 0 && accent ? accent : 'darkMetal', [0, s * 0.0135, 0], [Math.PI / 2, 0, 0]); return g; }
// Bunched knee: fabric pushed together. Partial, overlapping, sagging folds; crumpled on the compression side, stretched on the other.
function legMesh(side, B, seed) {
  const KY = -0.36, pts = [], cap = 10, rows = 150, yB = -0.70, yT = 0.0;
  const KEYS = [[-0.70, 0.104], [-0.44, 0.117], [-0.36, 0.123], [-0.28, 0.122], [0.0, 0.136]];
  const R = y => { for (let k = 0; k < KEYS.length - 1; k++) { const [y0, r0] = KEYS[k], [y1, r1] = KEYS[k + 1]; if (y <= y1) { const t = Math.max(0, (y - y0) / (y1 - y0)); return r0 + (r1 - r0) * t * t * (3 - 2 * t); } } return 0.136; };
  for (let i = 0; i <= cap; i++) { const a = -Math.PI / 2 + (Math.PI / 2) * i / cap; pts.push([i === 0 ? 0 : R(yB) * Math.cos(a), yB + 0.05 * Math.sin(a)]); }
  for (let i = 1; i < rows; i++) { const y = yB + (yT - yB) * i / rows; pts.push([R(y), y]); }
  for (let i = 0; i <= cap; i++) { const a = (Math.PI / 2) * i / cap; pts.push([i === cap ? 0 : R(yT) * Math.cos(a), yT + 0.08 * Math.sin(a)]); }
  const g = lathe(pts, 64), P = g.P, C = [];
  for (let i = 0; i < P.length; i += 3) { const x = P[i], y = P[i + 1], z = P[i + 2], r = Math.hypot(x, z); if (r < 1e-5 || y < yB || y > yT) { C.push(1, 1, 1); continue; }
    const th = Math.atan2(z, x), cx = Math.cos(th), cz = Math.sin(th);
    const kw = Math.exp(-(((y - KY) / 0.075) ** 2)), cs = 0.5 - 0.5 * cz;                 // cs = 1 at the back of the knee
    const endF = smooth(yB, yB + 0.05, y) * smooth(yT, yT - 0.04, y);
    // ordinary inflated-fabric folds along the whole leg
    const wx = fbm(x * 5 + seed, y * 5, z * 5, 2) - 0.5, wz = fbm(x * 5 + 9, y * 5 + seed, z * 5 + 3, 2) - 0.5;
    const n = fbm(x * 12 + wx * 2 + seed * 3, y * 26 + wx * 6 + wz * 4, z * 12 + wz * 2, 2), crease = Math.pow(Math.abs(2 * n - 1), 0.75) - 0.42;
    const bulge = fbm(x * 3 + seed, y * 3.5, z * 3, 2) - 0.5;
    let d = 0.0055 * (crease * (0.5 + 0.8 * kw) + bulge * 0.9);
    // knee: a few big, partial, sagging folds pushed together at the back; smoother stretch over the kneecap
    const warp = (fbm(cx * 1.4 + seed, y * 6, cz * 1.4, 3) - 0.5) * 2.4 + 0.8 * Math.sin(th * 1.5 + seed);
    const u = (y - KY) * (13 + 11 * cs) + warp, band = Math.floor(u), sfr = u - band;
    const prof = sfr < 0.6 ? sfr / 0.6 : (1 - sfr) / 0.4;
    const span = smooth(0.35, 0.6, fbm(cx * 1.8 + band * 1.37, band * 0.71 + seed, cz * 1.8, 2));
    const bandAmp = 0.5 + 0.8 * hash3(band + 50, Math.floor(seed * 10) + side, 7);
    const crum = Math.pow(Math.abs(2 * fbm(x * 26 + seed, y * 34, z * 26, 2) - 1), 0.7) - 0.48;
    d += 0.011 * kw * ((prof - 0.5) * bandAmp * span * (0.3 + 0.9 * cs) + crum * 0.35 * cs) + 0.006 * kw * (1 - cs) * (fbm(x * 8, y * 8 + 2, z * 8, 2) - 0.3);
    d *= endF;
    P[i] = x + cx * d; P[i + 2] = z + cz * d;
    const ao = Math.min(1, Math.max(0.74, 1 + Math.max(-1, Math.min(1, d / 0.011)) * 0.16)); C.push(ao, ao, ao); }
  // bend at the knee with a smooth blend (like a skinned joint)
  for (let i = 0; i < P.length; i += 3) { const y = P[i + 1], w = smooth(-0.31, -0.41, y); if (w <= 0) continue;
    const a = B * w, dy = y - KY, dz = P[i + 2]; P[i + 1] = KY + dy * Math.cos(a) - dz * Math.sin(a); P[i + 2] = dy * Math.sin(a) + dz * Math.cos(a); }
  g.C = C; computeNormals(g); smoothSeams(g); g.seam = true; return g; }
let convSeed = 0;
function convolute(parent, r, ys, tube_ = 0.015) { for (const y of ys) { const g = torus(r, tube_, 16, 72), ref = g.N.slice(), sd = (convSeed++) * 3.7, C = [];
    for (let i = 0; i < g.P.length; i += 3) { const x = g.P[i], yy = g.P[i + 1], z = g.P[i + 2];
      const d = tube_ * (0.55 * (fbm(x * 14 + sd, yy * 14, z * 14, 2) - 0.5) * 2 + 0.3 * (Math.abs(2 * noise3(x * 60 + sd, yy * 60, z * 60) - 1) - 0.5));
      g.P[i] += ref[i] * d; g.P[i + 1] += ref[i + 1] * d; g.P[i + 2] += ref[i + 2] * d; const ao = 1 + 0.5 * d / tube_; C.push(ao, ao, ao); }
    computeNormals(g); smoothSeams(g); fixNormals(g, ref); g.C = C.map(v => Math.min(1, Math.max(0.7, v)));
    add(parent, g, 'suit', [0, y, 0], [Math.PI / 2 + (hash3(convSeed, 1, 2) - 0.5) * 0.12, 0, (hash3(convSeed, 3, 4) - 0.5) * 0.12]); } }

function pillow(g, dims, amp, seed) { const ref = g.N.slice(), C = [];
  for (let i = 0; i < g.P.length; i += 3) { const P = [g.P[i], g.P[i + 1], g.P[i + 2]], N = [ref[i], ref[i + 1], ref[i + 2]];
    const k = Math.abs(N[0]) > Math.abs(N[1]) ? (Math.abs(N[0]) > Math.abs(N[2]) ? 0 : 2) : (Math.abs(N[1]) > Math.abs(N[2]) ? 1 : 2);
    let b = 1; for (let a = 0; a < 3; a++) if (a !== k) b *= Math.max(0, 1 - Math.pow(Math.abs(P[a]) / (dims[a] / 2), 4));
    const wn = fbm(P[0] * 18 + seed, P[1] * 22, P[2] * 18, 2), cr = Math.pow(Math.abs(2 * wn - 1), 0.75) - 0.45;
    const lump = fbm(P[0] * 6 + seed, P[1] * 6, P[2] * 6, 2) - 0.5;
    const d = amp * (b * (1 + lump) + cr * 0.35 * (0.4 + (1 - b)) );
    g.P[i] += N[0] * d; g.P[i + 1] += N[1] * d; g.P[i + 2] += N[2] * d;
    const ao = Math.min(1, Math.max(0.75, 1 + cr * 0.25 - (1 - b) * 0.05)); C.push(ao, ao, ao); }
  computeNormals(g); smoothSeams(g); fixNormals(g, ref); g.C = C; return g; }

// ---------------------------------------------------------------------------
// Materials (base colours are sRGB hex; three.js converts them to linear).
// `dirt` scales how much dust a surface picks up.
// ---------------------------------------------------------------------------
export const SUIT_MATERIALS = {
  suit: { color: 0xe3dfd6, kind: 'fabric', dirt: 1 },
  dust: { color: 0xd8d3c9, kind: 'fabric', dirt: 1 },
  glove: { color: 0xd2cec4, kind: 'fabric', dirt: 0.8, repeat: 14, normalScale: 0.9 },
  pack: { color: 0xe4e0d7, kind: 'fabric', dirt: 0.75, repeat: 4, normalScale: 0.7 },
  webbing: { color: 0xc9c4b9, kind: 'fabric', dirt: 0.8, repeat: 14, normalScale: 1.1 },
  velcro: { color: 0x8f8b84, kind: 'fabric', dirt: 0.6, repeat: 40, normalScale: 1.6 },
  flap: { color: 0xd9d6cf, kind: 'fabric', dirt: 1 },
  hard: { color: 0xe9e7e1, kind: 'hard', dirt: 0.5 },
  metal: { color: 0xb4b7bb, kind: 'metal', dirt: 0.35 },
  darkMetal: { color: 0x55585d, kind: 'darkMetal', dirt: 0.3 },
  rubber: { color: 0x2c2d30, kind: 'rubber', dirt: 0.8 },
  greyRubber: { color: 0x6d6f73, kind: 'rubber', dirt: 0.8 },
  red: { color: 0xa8261e, kind: 'anodised', dirt: 0 },
  blue: { color: 0x1f4a9c, kind: 'anodised', dirt: 0 },
  gold: { color: 0xffd98a, kind: 'visor', dirt: 0 },
  tag: { color: 0xebebeb, kind: 'tag', dirt: 0.4 },
  patch: { color: 0xffffff, kind: 'patch', dirt: 0 },
  patch2: { color: 0xffffff, kind: 'patch', dirt: 0 },
};
/** Mars dust picked up by the lower legs, boots and creases (sRGB hex). */
export const DUST_COLOR = 0xb07858;

const srgbToLinear = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

// ---------------------------------------------------------------------------
// Two-bone leg IK in the astronaut's sagittal (Y-Z) plane.
// hip, ankle: [y, z]. Returns the hip pitch `a` and knee bend `B` (radians,
// XYZ Euler about +X) that put the ankle on target with the knee bent forward.
// ---------------------------------------------------------------------------
export const THIGH = 0.36;
export const SHIN = 0.34;
export function solveLeg(hip, ankle, L1 = THIGH, L2 = SHIN) {
  const dy = ankle[0] - hip[0], dz = ankle[1] - hip[1];
  const d = Math.min(Math.max(Math.hypot(dy, dz), Math.abs(L1 - L2) + 1e-3), (L1 + L2) * 0.999);
  const phi = Math.atan2(-dz, -dy);
  const alpha = Math.acos((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d));
  const gamma = Math.acos((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2));
  return { a: phi - alpha, B: Math.PI - gamma };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
const STAND_LEGS = { 1: { a: 0.03, B: 0.1 }, '-1': { a: -0.12, B: 0.2 } };
const STAND_ARMS = { 1: { x: -0.05, z: 0.27, y: 0, e: -0.38, ez: 0 }, '-1': { x: -0.2, z: 0.16, y: 0, e: -0.72, ez: 0 } };

/**
 * Build the suit graph.
 * @param {object} [o]
 * @param {boolean} [o.upperBody=true]  torso, arms, backpack and helmet (false = waist down, e.g. the driver's own legs)
 * @param {object} [o.legs]   per side ({1: {a, B}, -1: {a, B}}) hip pitch / knee bend; defaults to a relaxed stance
 * @param {object} [o.arms]   per side ({x, y, z, e, ez}) shoulder Euler + elbow pitch/yaw
 * @param {number} [o.recline=0] backward lean of the upper body about the hips (radians, negative leans back)
 * @param {boolean} [o.visorDown=true]
 * @returns {{ root: object, helmet: object|null, hips: object[], parts: object }}
 *   parts: the joints a renderer can pose at runtime, per side (1 = right, -1 = left):
 *   { upper, knees, boots, shoulders, elbows }
 */
export function buildSuitGraph(o = {}) {
  const upperBody = o.upperBody !== false;
  const legs = o.legs || STAND_LEGS;
  const arms = o.arms || STAND_ARMS;
  convSeed = 0;
  const root = node(null);
  const parts = { upper: null, knees: {}, boots: {}, shoulders: {}, elbows: {} };

  // pelvis / brief: wide, so the inflated suit fills out around the thighs
  { const g = lathe(splinePts([[0.0, 0.0], [0.09, 0.006], [0.16, 0.04], [0.19, 0.11], [0.198, 0.2], [0.188, 0.28], [0.17, 0.35]], 8), 64);
    wrinkle(g, { amp: 0.0055, seed: 2.4, calm: 0.45 }); scaleGeo(g, 1.36, 1, 0.97); add(root, g, 'suit', [0, 0.76, 0]);
    // soft fabric dome closing the waist (seen from above as the driver's lap)
    { const d = sphere(0.172, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2); wrinkle(d, { amp: 0.004, seed: 8.1, calm: 0.5 }); add(root, d, 'suit', [0, 1.09, 0], [0, 0, 0], [1.32, 0.45, 0.92]); }
    if (upperBody) bearing(root, 0.172, [0, 1.11, 0], [0, 0, 0], [1.32, 1, 0.92]); }

  // legs: one continuous mesh per leg, bent at the knee
  const hips = [];
  for (const side of [1, -1]) {
    const { a, B } = legs[side];
    const hip = group(root, [side * 0.13, 0.88, 0], [0, side * 0.06, side * 0.04]);
    hip.pitch = a; hips.push(hip);
    bearing(hip, 0.136, [0, -0.1, 0]);
    add(hip, legMesh(side, B, side * 4.3 + 1.1), 'suit');
    const knee = group(hip, [0, -THIGH, 0], [B, 0, 0]);
    parts.knees[side] = knee;
    bearing(knee, 0.106, [0, -0.315, 0]);
    const boot = group(knee, [0, -SHIN, 0], [-(a + B), 0, -side * 0.04]);
    parts.boots[side] = boot;
    add(boot, cylinder(0.118, 0.124, 0.1, 44), 'dust', [0, -0.02, 0]);
    add(boot, pillow(rbox(0.172, 0.14, 0.34, 6, 0.06), [0.172, 0.14, 0.34], 0.006, side * 2.3), 'dust', [0, -0.1, 0.045]);
    add(boot, rbox(0.176, 0.085, 0.11, 4, 0.04), 'greyRubber', [0, -0.125, 0.165]);
    add(boot, rbox(0.188, 0.05, 0.36, 3, 0.016), 'rubber', [0, -0.175, 0.045]);
    for (let i = 0; i < 9; i++) add(boot, box(0.176, 0.012, 0.02), 'rubber', [0, -0.204, -0.11 + i * 0.039]);
    for (const sx of [-1, 1]) add(boot, rbox(0.006, 0.05, 0.03, 2, 0.002), 'metal', [sx * 0.089, -0.06, 0.1]);
    add(boot, rbox(0.18, 0.022, 0.014, 2, 0.004), 'greyRubber', [0, -0.06, 0.2], [0.35, 0, 0]);
    add(boot, rbox(0.03, 0.05, 0.008, 2, 0.003), 'webbing', [0, -0.03, -0.122]);
  }

  let helmet = null;
  if (upperBody) {
    const upper = group(root, [0, 0.95, 0], [o.recline || 0, 0, 0]);
    parts.upper = upper;
    const U = (y) => y - 0.95; // standing height -> upper-body local
    const torsoProfile = splinePts([[0.175, 0], [0.19, 0.04], [0.215, 0.12], [0.235, 0.22], [0.24, 0.29], [0.228, 0.35], [0.2, 0.395], [0.165, 0.43], [0.138, 0.448]], 8);
    { const g = lathe(torsoProfile, 72);
      wrinkle(g, { amp: 0.004, seed: 5.3, calm: 0.4 }); scaleGeo(g, 1.22, 1, 0.82); add(upper, g, 'suit', [0, U(1.11), 0]);
      bearing(upper, 0.142, [0, U(1.558), 0.005], [-0.08, 0, 0], [1.08, 1, 0.92]);
      add(upper, ring(0.12, 0.165, 64), 'darkMetal', [0, U(1.572), 0.005], [-Math.PI / 2 - 0.08, 0, 0], [1, 0.88, 1]); }
    const torsoR = (yl) => { const P = torsoProfile; for (let k = 0; k < P.length - 1; k++) if (yl >= P[k][1] && yl <= P[k + 1][1]) { const t = (yl - P[k][1]) / (P[k + 1][1] - P[k][1]); return P[k][0] + (P[k + 1][0] - P[k][0]) * t; } return P[P.length - 1][0]; };
    const onTorso = (x, yW, lift = 0) => { const yl = yW - 1.11, r = torsoR(yl), a = 1.22 * r, b = 0.82 * r; const z = b * Math.sqrt(Math.max(0, 1 - (x / a) ** 2));
      const r2 = torsoR(yl + 0.01), z2 = 0.82 * r2 * Math.sqrt(Math.max(0, 1 - (x / (1.22 * r2)) ** 2)); const pitch = Math.atan((z2 - z) / 0.01);
      const yaw = Math.atan2(x / (a * a), z / (b * b)); return { pos: [x + Math.sin(yaw) * lift, U(yW), z + Math.cos(yaw) * lift], rot: [pitch, yaw, 0] }; };

    // Apollo-style gas connectors (blue = inlet, red = outlet), pocket flap, name tag, patch
    for (const [x, y, col] of [[-0.088, 1.375, 'blue'], [0.088, 1.375, 'blue'], [-0.078, 1.245, 'red'], [0.078, 1.245, 'red']]) {
      const t = onTorso(x, y, 0.004), c = group(upper, t.pos, t.rot), q = group(c, [0, 0, 0], [Math.PI / 2, 0, 0]);
      add(q, cylinder(0.029, 0.031, 0.012, 40), 'metal', [0, 0.004, 0]);
      add(q, cylinder(0.024, 0.024, 0.018, 40), col, [0, 0.016, 0]);
      add(q, torus(0.024, 0.0025, 8, 40), 'metal', [0, 0.025, 0], [Math.PI / 2, 0, 0]);
      add(q, cylinder(0.013, 0.013, 0.022, 28), 'metal', [0, 0.028, 0]);
      add(q, cylinder(0.006, 0.006, 0.004, 16), 'rubber', [0, 0.0395, 0]);
      add(q, box(0.006, 0.006, 0.016), 'darkMetal', [0.016, 0.03, 0]);
    }
    { const t = onTorso(0, 1.305, 0.004), f = group(upper, t.pos, t.rot);
      add(f, rbox(0.095, 0.15, 0.014, 3, 0.006), 'flap');
      add(f, rbox(0.099, 0.04, 0.018, 3, 0.006), 'flap', [0, 0.058, 0.002]);
      for (const sx of [-0.028, 0.028]) add(f, cylinder(0.0045, 0.0045, 0.006, 14), 'metal', [sx, 0.05, 0.012], [Math.PI / 2, 0, 0]); }
    { const t = onTorso(-0.07, 1.452, 0.004), tg = group(upper, t.pos, t.rot);
      add(tg, rbox(0.1, 0.026, 0.005, 2, 0.002), 'hard'); add(tg, ring(0, 0.5, 4), 'tag', [0, 0, 0.0027], [0, 0, Math.PI / 4], [0.135, 0.031, 1]).tag = true; }
    { const t = onTorso(0.09, 1.452, 0.003), pp = group(upper, t.pos, t.rot);
      add(pp, cylinder(0.0245, 0.0245, 0.004, 48), 'hard', [0, 0, 0], [Math.PI / 2, 0, 0]);
      add(pp, ring(0, 0.024, 48), 'patch2', [0, 0, 0.0022]).disc = 0.024; }

    // arms
    for (const side of [1, -1]) {
      const P = arms[side];
      const sh = group(upper, [side * 0.315, U(1.44), 0], [P.x, P.y || 0, side * P.z]);
      parts.shoulders[side] = sh;
      bearing(sh, 0.104, [-side * 0.014, 0, 0], [0, 0, Math.PI / 2 + side * 0.1]);
      add(sh, sphere(0.1, 40, 28), 'suit', [0, -0.02, 0]);
      add(sh, fabricLimb(0.088, 0.096, 0.17, { seed: side * 7 + 0.5, bunch: -1, amp: 0.0072, comp: [0, 1] }), 'suit', [0, -0.14, 0]);
      bearing(sh, 0.097, [0, -0.07, 0]);
      if (side > 0) { const tc = Math.PI / 2 - 0.15; add(sh, cylinder(0.1, 0.1, 0.075, 24, true, tc - 0.4, 0.8), 'patch', [0, -0.125, 0]); }
      const elbow = group(sh, [0, -0.28, 0], [P.e, 0, -side * (P.ez || 0)]);
      parts.elbows[side] = elbow;
      convolute(elbow, 0.09, [0.03, 0.002, -0.026], 0.017);
      add(elbow, fabricLimb(0.074, 0.086, 0.15, { seed: side * 11 + 2.1, bunch: 1, amp: 0.0068, comp: [0, 1] }), 'suit', [0, -0.125, 0]);
      if (side < 0) { add(elbow, rbox(0.085, 0.1, 0.02, 2, 0.005), 'hard', [0, -0.15, 0.087], [0.05, 0, 0]); add(elbow, box(0.088, 0.008, 0.022), 'darkMetal', [0, -0.105, 0.087]); }
      bearing(elbow, 0.074, [0, -0.24, 0], [0, 0, 0], [1, 1, 1], side > 0 ? 'blue' : 'red');
      const gl = group(elbow, [0, -0.255, 0], [0.08, 0, side * 0.05], [1.16, 1.16, 1.16]);
      add(gl, cylinder(0.064, 0.058, 0.075, 36), 'glove', [0, -0.02, 0]);
      add(gl, rbox(0.042, 0.095, 0.088, 3, 0.016), 'glove', [0, -0.1, 0]);
      add(gl, rbox(0.008, 0.08, 0.075, 2, 0.003), 'greyRubber', [-side * 0.02, -0.105, 0]);
      const fz = [0.031, 0.011, -0.01, -0.03], fl = [0.056, 0.062, 0.058, 0.046];
      for (let i = 0; i < 4; i++) {
        const f = group(gl, [0, -0.145, fz[i]], [-0.06 + i * 0.04, 0, -side * (0.42 + i * 0.05)]); const l1 = fl[i] * 0.55, l2 = fl[i] * 0.5;
        add(f, capsule(0.0108, l1), 'glove', [0, -l1 / 2 - 0.006, 0]);
        const f2 = group(f, [0, -l1 - 0.012, 0], [0, 0, -side * (0.65 + i * 0.06)]);
        add(f2, capsule(0.0102, l2), 'glove', [0, -l2 / 2, 0]); add(f2, sphere(0.0108, 14, 10), 'greyRubber', [0, -l2 - 0.002, 0]);
      }
      const th = group(gl, [-side * 0.012, -0.075, 0.046], [-0.75, 0, -side * 0.45]);
      add(th, capsule(0.012, 0.04), 'glove', [0, -0.026, 0]); add(th, sphere(0.0125, 14, 10), 'greyRubber', [0, -0.05, 0]);
    }

    // backpack (PLSS) under a fabric thermal cover, with webbing, buckles, snaps and ports
    { const p = group(upper, [0, U(1.29), -0.31]);
      add(p, pillow(rbox(0.52, 0.62, 0.2, 12, 0.055), [0.52, 0.62, 0.2], 0.009, 1.3), 'pack');
      add(p, pillow(rbox(0.46, 0.13, 0.18, 8, 0.045), [0.46, 0.13, 0.18], 0.006, 4.1), 'pack', [0, 0.375, -0.01]);
      for (const x of [-0.15, 0.15]) {
        add(p, rbox(0.044, 0.64, 0.006, 2, 0.002), 'webbing', [x, -0.005, -0.1075]);
        add(p, rbox(0.044, 0.006, 0.2, 2, 0.002), 'webbing', [x, 0.322, 0]); add(p, rbox(0.04, 0.006, 0.19, 2, 0.002), 'webbing', [x * 0.9, 0.445, -0.01]);
        add(p, rbox(0.04, 0.13, 0.006, 2, 0.002), 'webbing', [x * 0.9, 0.378, -0.103]);
      }
      add(p, rbox(0.535, 0.04, 0.006, 2, 0.002), 'webbing', [0, -0.2, -0.1075]);
      for (const sx of [-1, 1]) add(p, rbox(0.006, 0.04, 0.205, 2, 0.002), 'webbing', [sx * 0.2655, -0.2, 0]);
      for (const x of [-0.15, 0.15]) { add(p, rbox(0.058, 0.05, 0.008, 2, 0.003), 'metal', [x, -0.2, -0.113]); add(p, rbox(0.04, 0.012, 0.01, 2, 0.002), 'darkMetal', [x, -0.2, -0.118]); }
      for (const sx of [-1, 1]) for (let k = 0; k < 6; k++) add(p, cylinder(0.0045, 0.0045, 0.004, 12), 'metal', [sx * 0.24, -0.26 + k * 0.1, -0.1065], [Math.PI / 2, 0, 0]);
      add(p, rbox(0.11, 0.07, 0.004, 2, 0.002), 'velcro', [0.05, 0.13, -0.1075]);
      add(p, rbox(0.075, 0.032, 0.003, 2, 0.001), 'hard', [-0.05, 0.22, -0.1075]);
      for (const sx of [-1, 1]) { add(p, cylinder(0.024, 0.026, 0.03, 28), 'metal', [sx * 0.13, -0.32, 0.02]); add(p, cylinder(0.019, 0.019, 0.01, 24), sx > 0 ? 'blue' : 'red', [sx * 0.13, -0.338, 0.02]); }
      add(p, cylinder(0.006, 0.006, 0.12, 10), 'darkMetal', [0.18, 0.5, -0.05]); add(p, sphere(0.01, 10, 8), 'darkMetal', [0.18, 0.56, -0.05]);
      for (const sx of [-1, 1]) add(p, torus(0.05, 0.007, 8, 24, Math.PI), 'metal', [sx * 0.268, 0.05, -0.02], [0, sx * Math.PI / 2, Math.PI / 2]);
    }

    // helmet: shell, framed gold sun visor (pivot group), visor pivot hubs
    helmet = group(upper, [0, U(1.70), 0.02], [0, 0, 0], [1.07, 1.07, 1.07]);
    { const h = helmet, Wd = 2.3;
      const shellGeo = [sphere(0.205, 72, 16, 0, Math.PI * 2, 0, 0.62), sphere(0.205, 72, 36, Math.PI / 2 + Wd / 2, Math.PI * 2 - Wd, 0.6, 1.65), sphere(0.205, 48, 8, Math.PI / 2 - Wd / 2, Wd, 1.93, 0.32)];
      for (const g of shellGeo) { g.doubleSided = true; add(h, g, 'hard'); }
      add(h, sphere(0.19, 32, 20), 'darkMetal', [0, -0.005, -0.01]); // helmet interior / comm cap silhouette
      add(h, torus(0.205, 0.004, 8, 96), 'darkMetal', [0, 0.205 * Math.cos(0.62), 0], [Math.PI / 2, 0, 0], [Math.sin(0.62), Math.sin(0.62), 1]);
      const pv = group(h, [0, 0, 0], [o.visorDown === false ? -0.95 : 0, 0, 0]);
      const vg = sphere(0.198, 72, 36, Math.PI / 2 - Wd / 2 + 0.03, Wd - 0.06, 0.62, 1.32); vg.doubleSided = true; add(pv, vg, 'gold');
      add(pv, rbox(0.03, 0.012, 0.012, 2, 0.004), 'hard', [0, 0.198 * Math.cos(0.68), 0.198 * Math.sin(0.68) + 0.004]);
      { const sp = (r, ph, th) => [-r * Math.cos(ph) * Math.sin(th), r * Math.cos(th), r * Math.sin(ph) * Math.sin(th)];
        const p0 = Math.PI / 2 - Wd / 2 + 0.03, p1 = Math.PI / 2 + Wd / 2 - 0.03, rr = 0.2;
        const bottom = [], left = [], right = []; for (let k = 0; k <= 30; k++) bottom.push(sp(rr, p0 + (p1 - p0) * k / 30, 1.94));
        for (let k = 0; k <= 16; k++) { const th = 0.62 + (1.94 - 0.62) * k / 16; left.push(sp(rr, p0, th)); right.push(sp(rr, p1, th)); }
        for (const path of [bottom, left, right]) add(pv, tube(path, 0.0042, 10), 'hard'); }
      for (const sx of [-1, 1]) { const hub = group(h, [sx * 0.207, 0.0, 0.0], [0, 0, Math.PI / 2]);
        add(hub, cylinder(0.027, 0.029, 0.014, 36), 'hard'); add(hub, cylinder(0.009, 0.009, 0.018, 18), 'darkMetal');
        for (let k = 0; k < 3; k++) { const ang = k * 2.094 + 0.5; add(hub, cylinder(0.0028, 0.0028, 0.017, 10), 'metal', [Math.cos(ang) * 0.019, 0, Math.sin(ang) * 0.019]); } }
    }
  }

  bakeShading(root);
  for (const hip of hips) hip.r = [hip.pitch, hip.r[1], hip.r[2]];
  return { root, helmet, hips, parts };
}

// ---------------------------------------------------------------------------
// Bake per-vertex shade: crease darkening (already in g.C), fabric blotches and
// Mars dust that collects low on the legs and in folds. Runs in the standing
// pose so "low" means low on the body, whatever pose is applied afterwards.
// ---------------------------------------------------------------------------
function bakeShading(root) {
  const dust = srgbToLinear(DUST_COLOR);
  const done = new Set();
  (function walk(n, parentM) {
    const m = parentM ? mul(parentM, trs(n.p, n.r, n.s)) : trs(n.p, n.r, n.s);
    if (n.mesh && !done.has(n.mesh.g)) {
      const g = n.mesh.g, mat = SUIT_MATERIALS[n.mesh.mat], amt = mat.dirt || 0;
      done.add(g);
      const count = g.P.length / 3, base = srgbToLinear(mat.color), C = new Array(count * 3);
      for (let i = 0; i < count; i++) {
        const ao = g.C ? g.C[i * 3] : 1;
        let r = ao, gg = ao, b = ao;
        if (amt > 0) {
          const w = xform(m, [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]]);
          const n1 = fbm(w[0] * 16, w[1] * 16, w[2] * 16, 4), n2 = fbm(w[0] * 3.2 + 7, w[1] * 3.2 + 7, w[2] * 3.2 + 7, 3);
          const blot = 1 + (n2 - 0.5) * 0.14;
          let d = smooth(0.8, 0.02, w[1]) * (0.45 + 1.2 * (n1 - 0.5)) + smooth(0.62, 0.7, n1 * 0.6 + n2 * 0.5) * 0.3 + (1 - ao) * 2.2;
          d = Math.min(1, Math.max(0, d)) * amt * 0.6;
          r *= blot * (1 - d + d * dust[0] / Math.max(base[0], 0.02));
          gg *= blot * (1 - d + d * dust[1] / Math.max(base[1], 0.02));
          b *= blot * (1 - d + d * dust[2] / Math.max(base[2], 0.02));
        }
        C[i * 3] = r; C[i * 3 + 1] = gg; C[i * 3 + 2] = b;
      }
      g.C = C;
    }
    for (const k of n.kids) walk(k, m);
  })(root, null);
}

/** Count vertices/triangles of a graph (handy for budgets and tests). */
export function graphStats(root) {
  let verts = 0, tris = 0, meshes = 0;
  (function walk(n) { if (n.mesh) { meshes++; verts += n.mesh.g.P.length / 3; tris += n.mesh.g.I.length / 3; } n.kids.forEach(walk); })(root);
  return { meshes, verts, tris };
}
