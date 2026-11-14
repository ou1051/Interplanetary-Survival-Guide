import * as THREE from 'three';
import { smoothstep, clamp } from '../core/math.js';

// ---------------------------------------------------------------------------
// Data layers draped over the terrain.
//
// Each layer is a sampler `color(ctx, outColor)` where ctx describes one point
// ({x, z, h, slope, n1, n2, m: feature masks}). Right now OPTICAL / THERMAL /
// MINERAL are MOCK samplers; SLOPE is genuinely derived from the (placeholder)
// elevation model. To connect real data, replace a sampler with a raster lookup
// (e.g. CRISM mineral map, THEMIS thermal inertia, HiRISE orthoimage) and set
// `source` accordingly. The UI reads `source`, `future` and `legend` from here.
// ---------------------------------------------------------------------------

const C = (hex) => new THREE.Color(hex);
const tmp = new THREE.Color();

function ramp(stops, t, out) {
  t = clamp(t, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(stops[stops.length - 1][1]);
}

const OPT = {
  dust: C('#c4875a'),
  rust: C('#a45f3b'),
  dark: C('#5a3727'),
  basalt: C('#4d342a'),
  deltaA: C('#c29274'),
  deltaB: C('#8d5d47'),
  ejecta: C('#d0a283'),
  ripple: C('#d7a273'),
};

const SLOPE_STOPS = [
  [0, C('#2f9e66')],
  [8 / 30, C('#58b86a')],
  [10 / 30, C('#e3c04a')],
  [14 / 30, C('#eba440')],
  [16 / 30, C('#ee7d35')],
  [20 / 30, C('#d9423a')],
  [1, C('#8f1d2c')],
];

const THERMAL_STOPS = [
  [0, C('#1b0c41')],
  [0.25, C('#6a176e')],
  [0.5, C('#c73e4c')],
  [0.75, C('#f78410')],
  [1, C('#fcf3a4')],
];

const MIN = {
  olivine: C('#69b34c'),
  clay: C('#37a3c8'),
  pyroxene: C('#9a6ad3'),
  dust: C('#c9b39a'),
};

function thermalInertia(ctx) {
  const { slope, m, n1 } = ctx;
  return clamp(
    0.32 + 0.45 * smoothstep(5, 25, slope) + 0.5 * m.ejecta + 0.18 * m.delta - 0.38 * m.ripple + 0.14 * n1,
    0,
    1,
  );
}

function mineralWeights(ctx) {
  const { m, n1, slope } = ctx;
  const clay = m.delta * (0.75 + 0.25 * n1);
  const pyroxene = Math.max(m.ejecta * 0.95, m.ridge * 0.7);
  const dust = clamp(m.ripple * 0.9 + smoothstep(0.35, 0.7, n1) * (1 - m.delta) * smoothstep(6, 1, slope) * 0.8, 0, 1);
  const olivine = clamp(1 - clay - pyroxene * 0.8 - dust * 0.6, 0, 1) * (1 - m.delta * 0.6);
  return { olivine, clay, pyroxene, dust };
}

export const LAYERS = [
  {
    id: 'optical',
    key: '1',
    name: 'OPTICAL',
    source: 'MOCK · procedural albedo',
    future: 'HiRISE / CTX orthoimage',
    legend: { type: 'note', text: 'True-colour style surface' },
    color(ctx, out) {
      const { slope, m, n1, n2, h } = ctx;
      out.copy(OPT.rust).lerp(OPT.dust, clamp(0.45 + 0.45 * n1, 0, 1));
      out.lerp(OPT.basalt, smoothstep(-0.05, -0.75, n1) * (1 - m.delta) * 0.5);
      // layered delta deposits: bands follow elevation on the scarp
      const edge = 1 - Math.abs(m.delta * 2 - 1);
      if (edge > 0.01) {
        const band = 0.5 + 0.5 * Math.sin(h * 2.6);
        out.lerp(band > 0.5 ? OPT.deltaA : OPT.deltaB, edge * 0.75);
      }
      out.lerp(OPT.deltaA, m.delta * (1 - edge) * 0.35);
      out.lerp(OPT.dark, smoothstep(10, 32, slope) * 0.6);
      const rays = 0.5 + 0.5 * Math.sin(Math.atan2(ctx.z + 675, ctx.x - 255) * 15 + n2 * 2);
      out.lerp(OPT.ejecta, m.ejecta * (1 - m.craterInterior) * (0.35 + 0.4 * rays));
      out.lerp(OPT.dark, m.craterInterior * 0.35);
      out.lerp(OPT.ripple, m.ripple * 0.55);
      out.multiplyScalar(0.94 + 0.12 * n2);
      return out;
    },
    readout(ctx) {
      return `ALBEDO ${(0.16 + 0.06 * ctx.n1).toFixed(2)}`;
    },
  },
  {
    id: 'slope',
    key: '2',
    name: 'SLOPE',
    source: 'DERIVED · placeholder DEM',
    future: 'HiRISE DTM (1 m/px)',
    legend: {
      type: 'classes',
      items: [
        ['< 9°', '#3aa86a', 'safe'],
        ['9–15°', '#e3b444', 'caution'],
        ['15–20°', '#ee7d35', 'danger'],
        ['> 20°', '#d9423a', 'no-go'],
      ],
    },
    color(ctx, out) {
      ramp(SLOPE_STOPS, ctx.slope / 30, out);
      out.multiplyScalar(0.9 + 0.1 * ctx.n2);
      return out;
    },
    readout(ctx) {
      return `SLOPE ${ctx.slope.toFixed(1)}°`;
    },
  },
  {
    id: 'thermal',
    key: '3',
    name: 'THERMAL INERTIA',
    source: 'MOCK',
    future: 'THEMIS night-time IR',
    legend: { type: 'gradient', stops: ['#1b0c41', '#6a176e', '#c73e4c', '#f78410', '#fcf3a4'], lo: 'dust', hi: 'rock' },
    color(ctx, out) {
      ramp(THERMAL_STOPS, thermalInertia(ctx), out);
      return out;
    },
    readout(ctx) {
      return `TI ${Math.round(80 + thermalInertia(ctx) * 720)} tiu`;
    },
  },
  {
    id: 'mineral',
    key: '4',
    name: 'MINERALOGY',
    source: 'MOCK',
    future: 'CRISM / OMEGA spectra',
    legend: {
      type: 'classes',
      items: [
        ['Olivine', '#69b34c', 'crater floor'],
        ['Clay / carbonate', '#37a3c8', 'delta'],
        ['Pyroxene', '#9a6ad3', 'ejecta / ridge'],
        ['Dust cover', '#c9b39a', 'mantle'],
      ],
    },
    color(ctx, out) {
      const w = mineralWeights(ctx);
      const total = w.olivine + w.clay + w.pyroxene + w.dust + 1e-6;
      out.setRGB(0, 0, 0);
      out.add(tmp.copy(MIN.olivine).multiplyScalar(w.olivine / total));
      out.add(tmp.copy(MIN.clay).multiplyScalar(w.clay / total));
      out.add(tmp.copy(MIN.pyroxene).multiplyScalar(w.pyroxene / total));
      out.add(tmp.copy(MIN.dust).multiplyScalar(w.dust / total));
      out.multiplyScalar(0.92 + 0.1 * ctx.n2);
      return out;
    },
    readout(ctx) {
      const w = mineralWeights(ctx);
      const entries = Object.entries(w).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((s, e) => s + e[1], 0) + 1e-6;
      const names = { olivine: 'OLIVINE', clay: 'CLAY/CARB', pyroxene: 'PYROXENE', dust: 'DUST' };
      return `${names[entries[0][0]]} ${Math.round((entries[0][1] / total) * 100)}%`;
    },
  },
];

export const layerById = (id) => LAYERS.find((l) => l.id === id);
