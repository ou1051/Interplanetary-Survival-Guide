import * as THREE from 'three';
import {
  TERRAIN,
  HAB as MISSION_HAB,
  STATIONS as MISSION_STATIONS,
  AREA_HAZARDS as MISSION_AREA_HAZARDS,
} from '../config/mission.js';
import { analyticHeight, Terrain } from '../world/terrain.js';
import { Route, joinCurves } from '../world/route.js';
import { smoothstep, clamp } from '../core/math.js';
import {
  heightAtGale,
  imagery as galeImagery,
  observationSource as galeObsSource,
} from './galeSite.js';
import { siteAssetUrl, loadTopographyGrid } from '../ui/siteAssets.js';
import marsSitesDem from './marsSitesDem.json';

// ---------------------------------------------------------------------------
// Coordinate Bridge: 500×500 Topography / cost_matrix.json <-> 3D World (m)
//
// In-game 3D terrain inner grid (`TERRAIN.inner` in `src/config/mission.js`):
//   Center: (cx = 100, cz = -400), Size: 1600 m × 1600 m
//   X bounds (West -> East):  [-700 m, +900 m]
//   Z bounds (North -> South): [-1200 m, +400 m]
//   500×500 cost_matrix.json cell size: 1600 m / 500 = 3.2 m per pixel/cell
// ---------------------------------------------------------------------------
export const TOPO_GRID_SIZE = 500;
export const WORLD_BOUNDS = {
  x0: TERRAIN.inner.cx - TERRAIN.inner.size / 2, // -700 m
  x1: TERRAIN.inner.cx + TERRAIN.inner.size / 2, // +900 m
  z0: TERRAIN.inner.cz - TERRAIN.inner.size / 2, // -1200 m
  z1: TERRAIN.inner.cz + TERRAIN.inner.size / 2, // +400 m
  size: TERRAIN.inner.size,                      // 1600 m
  cellSizeM: TERRAIN.inner.size / TOPO_GRID_SIZE, // 3.2 m
};

export function worldToNormalized(x, z) {
  return [
    (x - WORLD_BOUNDS.x0) / WORLD_BOUNDS.size,
    (z - WORLD_BOUNDS.z0) / WORLD_BOUNDS.size,
  ];
}

export function normalizedToWorld(nx, ny) {
  return [
    WORLD_BOUNDS.x0 + nx * WORLD_BOUNDS.size,
    WORLD_BOUNDS.z0 + ny * WORLD_BOUNDS.size,
  ];
}

export function worldToGrid500(x, z) {
  const [nx, ny] = worldToNormalized(x, z);
  const col = Math.max(0, Math.min(TOPO_GRID_SIZE - 1, Math.round(nx * (TOPO_GRID_SIZE - 1))));
  const row = Math.max(0, Math.min(TOPO_GRID_SIZE - 1, Math.round(ny * (TOPO_GRID_SIZE - 1))));
  return { row, col, nx, ny };
}

export function grid500ToWorld(row, col) {
  const nx = (col + 0.5) / TOPO_GRID_SIZE;
  const ny = (row + 0.5) / TOPO_GRID_SIZE;
  return normalizedToWorld(nx, ny);
}

/**
 * Convert an array of path cells from the 500×500 `cost_matrix.json` pathfinder
 * (either `[[row, col], ...]` or `[{ row, col }, ...]`) into 3D sandbox world
 * metre coordinates `[[x, z], ...]` ready for `new Route(terrain, { points, exact: true })`.
 */
export function costMatrixPathToWorldPoints(cells) {
  return cells.map((cell) => {
    const row = Array.isArray(cell) ? cell[0] : cell.row;
    const col = Array.isArray(cell) ? cell[1] : cell.col;
    return grid500ToWorld(row, col);
  });
}

// ---------------------------------------------------------------------------
// Per-Site Continuous Elevation Samplers (all leveled smoothly at HAB (0, 0))
// ---------------------------------------------------------------------------
const GALE_SPAN_M = 636; // (160 - 1) * 4 m in src/data/gale/elevation.json
function worldToGaleDem(x, z) {
  const [nx, ny] = worldToNormalized(x, z);
  return [
    clamp(nx, 0, 1) * GALE_SPAN_M,
    clamp(ny, 0, 1) * GALE_SPAN_M,
  ];
}
const [HAB_GALE_X, HAB_GALE_Z] = worldToGaleDem(0, 0);
const HAB_GALE_H = heightAtGale(HAB_GALE_X, HAB_GALE_Z);

function habFlatten(x, z) {
  return smoothstep(26, 95, Math.hypot(x, z));
}

function craterDepression(x, z, cx, cz, r, depth) {
  const d = Math.hypot(x - cx, z - cz);
  const bowl = (1 - smoothstep(0, r * 0.88, d)) * depth;
  const rim = Math.exp(-(((d - r * 0.96) / Math.max(8, r * 0.14)) ** 2)) * (depth * 0.22);
  return rim - bowl;
}

function sampleRealDem(siteId, x, z, amplitudeM = 18.0) {
  const entry = marsSitesDem?.[siteId];
  if (!entry || !entry.grid) return 0;
  const N = entry.size || 64;
  const [nx, ny] = worldToNormalized(x, z);
  const gx = clamp(nx, 0, 1) * (N - 1);
  const gy = clamp(ny, 0, 1) * (N - 1);
  const c0 = Math.floor(gx);
  const r0 = Math.floor(gy);
  const c1 = Math.min(N - 1, c0 + 1);
  const r1 = Math.min(N - 1, r0 + 1);
  const fc = gx - c0;
  const fr = gy - r0;
  const g = entry.grid;
  const v00 = g[r0][c0];
  const v10 = g[r0][c1];
  const v01 = g[r1][c0];
  const v11 = g[r1][c1];
  const val = v00 * (1 - fc) * (1 - fr) + v10 * fc * (1 - fr) + v01 * (1 - fc) * fr + v11 * fc * fr;
  return val * amplitudeM;
}

const HAB_DEM_SHARP = sampleRealDem('sharp', 0, 0, 18.0);
const HAB_DEM_VALLES = sampleRealDem('valles', 0, 0, 22.0);
const HAB_DEM_OLYMPUS = sampleRealDem('olympus', 0, 0, 17.0);
const HAB_DEM_VRR = sampleRealDem('vrr', 0, 0, 11.0);

export function heightAtVRR(x, z) {
  const [gx, gz] = worldToGaleDem(x, z);
  const demDelta = (heightAtGale(gx, gz) - HAB_GALE_H) * 0.72;
  const ctxDelta = (sampleRealDem('vrr', x, z, 11.0) - HAB_DEM_VRR) * 0.45;
  return habFlatten(x, z) * (demDelta + ctxDelta);
}

export function heightAtSharp(x, z) {
  const realDem = sampleRealDem('sharp', x, z, 18.0) - HAB_DEM_SHARP;
  const microStrata = Math.sin(z * 0.018 + Math.cos(x * 0.012)) * 1.4;
  return habFlatten(x, z) * (realDem + microStrata);
}

export function heightAtValles(x, z) {
  const realDem = sampleRealDem('valles', x, z, 22.0) - HAB_DEM_VALLES;
  const microScarp = Math.sin(x * 0.016 - z * 0.014) * 1.6;
  return habFlatten(x, z) * (realDem + microScarp);
}

export function heightAtOlympus(x, z) {
  const realDem = sampleRealDem('olympus', x, z, 17.0) - HAB_DEM_OLYMPUS;
  const microLava = Math.sin(x * 0.015 + z * 0.011) * 1.3;
  return habFlatten(x, z) * (realDem + microLava);
}

// ---------------------------------------------------------------------------
// The 5 Planetary Mars Sites — Matched 1:1 across Globe, Datasets, Stations,
// Area Hazards, Cesium 3D Anchor, and Three.js Surface Sandbox Engine.
// ---------------------------------------------------------------------------
export const MARS_SITES_DATA = [
  {
    id: 'vrr',
    code: 'SITE 01',
    name: 'Gale Crater · Vera Rubin Ridge',
    coords: '4.71° S, 137.36° E',
    lat: -1.8, // Globe pin latitude (spread visually from Mount Sharp)
    lon: 129.5, // Globe pin longitude
    anchor: { lat: -4.714, lon: 137.357 },
    sol: 214,
    summary: 'HiRISE Gale Crater DEM & Mars Trek CTX · Hematite ridge & mudstone bedrock.',
    datasetLabel: `Mars Trek Gale CTX + HiRISE DEM · public/vrr/topography_grid.json`,
    previewImg: './vrr/base.png',
    assetDir: './vrr',
    useStaticAssets: true,
    previewFilter: 'none',
    defaultApproach: 'best',
    heightAt: heightAtVRR,
    palette: {
      low: [62, 43, 35],
      mid: [132, 86, 63],
      high: [188, 138, 106],
    },
    stations: [
      {
        id: 'S1',
        name: 'Hematite Ridge Crest',
        shortName: 'Hematite Ridge',
        code: '1 — HEMATITE RIDGE',
        science: 'High-Fe₂O₃ phyllosilicate outcrop',
        at: [-212, -312],
        tasks: [
          { label: 'APXS iron-oxide scan', minutes: 12, sampleCount: 1 },
          { label: 'Collect hematite core', minutes: 10, sampleCount: 1 },
        ],
      },
      {
        id: 'S2',
        name: 'Fractured Bedrock Shelf',
        shortName: 'Fractured Bedrock',
        code: '2 — FRACTURED BEDROCK',
        science: 'Calcium-sulfate vein network',
        at: [108, -472],
        tasks: [
          { label: 'LaserChem vein assay', minutes: 14, sampleCount: 1 },
          { label: 'Close-up hand lens log', minutes: 8 },
        ],
      },
      {
        id: 'S3',
        name: 'Jura Mudstone Bench',
        shortName: 'Mudstone Bench',
        code: '3 — MUDSTONE BENCH',
        science: 'Lacustrine mudstone & grey veins',
        at: [332, -760],
        tasks: [
          { label: 'Rotary drill grey-vein core', minutes: 16, sampleCount: 2 },
        ],
      },
      {
        id: 'S4',
        name: 'Knockfarril Overlook',
        shortName: 'Knockfarril',
        code: '4 — KNOCKFARRIL OVERLOOK',
        science: 'Clay-bearing unit contact',
        at: [-100, -808],
        tasks: [
          { label: 'Mastcam stereo stratigraphy', minutes: 12, sampleCount: 1 },
        ],
      },
    ],
    areaHazards: [
      {
        id: 'H-VRR-SCARP',
        cx: 92,
        cz: -632,
        radius: 125,
        type: 'STEEP RIDGE SCARP',
        severity: 'danger',
        limit: 3.5,
        unsurveyed: false,
      },
      {
        id: 'H-VRR-TALUS',
        cx: 508,
        cz: -280,
        radius: 110,
        type: 'LOOSE TALUS APRON',
        severity: 'caution',
        limit: 6.5,
        unsurveyed: false,
      },
      {
        id: 'H-VRR-DUST',
        cx: 204,
        cz: 8,
        radius: 100,
        type: 'UNSURVEYED FINES',
        severity: 'danger',
        limit: 3.5,
        unsurveyed: true,
      },
    ],
  },
  {
    id: 'jezero',
    code: 'SITE 02',
    name: 'Jezero Crater · River Delta',
    coords: '18.44° N, 77.45° E',
    lat: 18.4447,
    lon: 77.4508,
    anchor: { lat: 18.4447, lon: 77.4508 },
    sol: 214,
    summary: 'Western braided river delta & ancient lakebed deposits · Real GeoTIFF scan.',
    datasetLabel: 'GeoTIFF DEM · public/jezero/topography_grid.json',
    previewImg: './jezero/base.png',
    assetDir: './jezero',
    useStaticAssets: true,
    previewFilter: 'none',
    defaultApproach: 'best',
    heightAt: analyticHeight,
    stations: MISSION_STATIONS.map((s) => ({ ...s, shortName: s.name })),
    areaHazards: MISSION_AREA_HAZARDS,
    useJezeroFiles: true,
  },
  {
    id: 'sharp',
    code: 'SITE 03',
    name: 'Aeolis Mons · Mount Sharp',
    coords: '5.08° S, 137.85° E',
    lat: -14.2, // Spread south-east from Vera Rubin Ridge pin
    lon: 147.8,
    anchor: { lat: -5.08, lon: 137.85 },
    sol: 215,
    summary: '5.5 km central sedimentary mound with layered sulfate strata and Murray Buttes.',
    datasetLabel: 'Mars Trek Gale CTX + MOLA DEM · public/sharp/topography_grid.json',
    previewImg: './sharp/base.png',
    assetDir: './sharp',
    useStaticAssets: true,
    previewFilter: 'none',
    defaultApproach: 'best',
    heightAt: heightAtSharp,
    palette: {
      low: [92, 54, 34],
      mid: [176, 108, 64],
      high: [224, 174, 126],
    },
    stations: [
      {
        id: 'S1',
        name: 'Murray Mudstone Flat',
        shortName: 'Murray Flat',
        code: '1 — MURRAY FLAT',
        science: 'Fine-laminated lakebed siltstone',
        at: [-244, -120],
        tasks: [
          { label: 'Clay mineral spectroscopy', minutes: 12, sampleCount: 1 },
        ],
      },
      {
        id: 'S2',
        name: 'Siccar Unconformity',
        shortName: 'Siccar Point',
        code: '2 — SICCAR POINT',
        science: 'Stimson sandstone unconformity',
        at: [-308, -520],
        tasks: [
          { label: 'Contact boundary imaging', minutes: 14, sampleCount: 1 },
          { label: 'Collect basal breccia', minutes: 10, sampleCount: 1 },
        ],
      },
      {
        id: 'S3',
        name: 'Sulfate-Bearing Strata',
        shortName: 'Sulfate Strata',
        code: '3 — SULFATE STRATA',
        science: 'Hydrated Mg-sulfate yardang beds',
        at: [60, -920],
        tasks: [
          { label: 'Gypsum vein core drill', minutes: 16, sampleCount: 2 },
        ],
      },
      {
        id: 'S4',
        name: 'Gediz Vallis Channel',
        shortName: 'Gediz Channel',
        code: '4 — GEDIZ CHANNEL',
        science: 'Debris-flow boulder ridge',
        at: [332, -568],
        tasks: [
          { label: 'Debris cobble assay', minutes: 10, sampleCount: 1 },
        ],
      },
    ],
    areaHazards: [
      {
        id: 'H-SHARP-BUTTE',
        cx: -164,
        cz: -440,
        radius: 125,
        type: 'STEEP BUTTE ESCARPMENT',
        severity: 'danger',
        limit: 3.5,
        unsurveyed: false,
      },
      {
        id: 'H-SHARP-DUNE',
        cx: -84,
        cz: -184,
        radius: 110,
        type: 'BAGNOLD DUNE FIELD',
        severity: 'caution',
        limit: 6.0,
        unsurveyed: false,
      },
      {
        id: 'H-SHARP-SCOUR',
        cx: 524,
        cz: -792,
        radius: 115,
        type: 'UNSURVEYED TALUS FAN',
        severity: 'danger',
        limit: 3.5,
        unsurveyed: true,
      },
    ],
  },
  {
    id: 'valles',
    code: 'SITE 04',
    name: 'Valles Marineris · Coprates Chasma',
    coords: '13.90° S, 59.20° W',
    lat: -13.9,
    lon: 300.8,
    anchor: { lat: -13.9, lon: -59.2 },
    sol: 216,
    summary: '4,000 km tectonic canyon system with steep fault scarps and landslide benches.',
    datasetLabel: 'NASA/MRO CTX + MOLA DEM · public/valles/topography_grid.json',
    previewImg: './valles/base.png',
    assetDir: './valles',
    useStaticAssets: true,
    previewFilter: 'none',
    defaultApproach: 'average',
    heightAt: heightAtValles,
    palette: {
      low: [48, 39, 36],
      mid: [118, 88, 72],
      high: [194, 152, 118],
    },
    stations: [
      {
        id: 'S1',
        name: 'Chasma Talus Apron',
        shortName: 'Talus Apron',
        code: '1 — TALUS APRON',
        science: 'Colluvial canyon floor blocks',
        at: [236, -248],
        tasks: [
          { label: 'Slump block assay', minutes: 10, sampleCount: 1 },
        ],
      },
      {
        id: 'S2',
        name: 'Noctis Fault Scarp',
        shortName: 'Fault Scarp',
        code: '2 — FAULT SCARP',
        science: 'Exposed Noachian basalt crust',
        at: [348, -552],
        tasks: [
          { label: 'Basalt wall stratigraphy', minutes: 15, sampleCount: 1 },
        ],
      },
      {
        id: 'S3',
        name: 'Olivine Dark Dune Rim',
        shortName: 'Olivine Dune',
        code: '3 — OLIVINE DUNE',
        science: 'Mafic aeolian sand sheet',
        at: [-68, -824],
        tasks: [
          { label: 'Aeolian grain sieve', minutes: 12, sampleCount: 2 },
        ],
      },
      {
        id: 'S4',
        name: 'Coprates Mesa Base',
        shortName: 'Coprates Mesa',
        code: '4 — COPRATES MESA',
        science: 'Interior layered sulfate mesa',
        at: [-324, -408],
        tasks: [
          { label: 'Layered sulfates core', minutes: 14, sampleCount: 1 },
        ],
      },
    ],
    areaHazards: [
      {
        id: 'H-VM-CHASM',
        cx: 140,
        cz: -472,
        radius: 135,
        type: 'FAULT WALL DROP-OFF',
        severity: 'danger',
        limit: 3.0,
        unsurveyed: false,
      },
      {
        id: 'H-VM-SLIDE',
        cx: 236,
        cz: -552,
        radius: 110,
        type: 'LANDSLIDE BOULDERS',
        severity: 'caution',
        limit: 6.0,
        unsurveyed: false,
      },
      {
        id: 'H-VM-FISSURE',
        cx: -276,
        cz: 88,
        radius: 105,
        type: 'UNSURVEYED GRABEN CRACK',
        severity: 'danger',
        limit: 3.5,
        unsurveyed: true,
      },
    ],
  },
  {
    id: 'olympus',
    code: 'SITE 05',
    name: 'Olympus Mons · Caldera Flank',
    coords: '18.65° N, 133.80° W',
    lat: 18.65,
    lon: 226.2,
    anchor: { lat: 18.65, lon: -133.8 },
    sol: 217,
    summary: '21.9 km shield volcano aureole, basaltic lava levees, and collapsed lava tubes.',
    datasetLabel: 'NASA/MRO CTX + MOLA DEM · public/olympus/topography_grid.json',
    previewImg: './olympus/base.png',
    assetDir: './olympus',
    useStaticAssets: true,
    previewFilter: 'none',
    defaultApproach: 'shortest',
    heightAt: heightAtOlympus,
    palette: {
      low: [38, 36, 40],
      mid: [88, 72, 68],
      high: [148, 114, 98],
    },
    stations: [
      {
        id: 'S1',
        name: 'Basalt Lava Levee',
        shortName: 'Lava Levee',
        code: '1 — LAVA LEVEE',
        science: 'Young Amazonian pahoehoe lobe',
        at: [-244, -280],
        tasks: [
          { label: 'Vesicular basalt core', minutes: 12, sampleCount: 1 },
        ],
      },
      {
        id: 'S2',
        name: 'Collapsed Tube Skylight',
        shortName: 'Tube Skylight',
        code: '2 — TUBE SKYLIGHT',
        science: 'Subsurface lava cavern void',
        at: [-292, -648],
        tasks: [
          { label: 'Void LiDAR profiling', minutes: 15, sampleCount: 1 },
        ],
      },
      {
        id: 'S3',
        name: 'Aureole Block Rim',
        shortName: 'Aureole Rim',
        code: '3 — AUREOLE RIM',
        science: 'Pyroxene-rich tephra ridge',
        at: [236, -792],
        tasks: [
          { label: 'Pyroxene ash assay', minutes: 14, sampleCount: 2 },
        ],
      },
      {
        id: 'S4',
        name: 'Basal Scarp Overlook',
        shortName: 'Scarp Overlook',
        code: '4 — SCARP OVERLOOK',
        science: 'Caldera slope gravity gradient',
        at: [380, -312],
        tasks: [
          { label: 'Shield slope telemetry', minutes: 10, sampleCount: 1 },
        ],
      },
    ],
    areaHazards: [
      {
        id: 'H-OM-PIT',
        cx: -116,
        cz: -600,
        radius: 130,
        type: 'LAVA TUBE COLLAPSE PIT',
        severity: 'danger',
        limit: 3.0,
        unsurveyed: false,
      },
      {
        id: 'H-OM-CLINKER',
        cx: 668,
        cz: -104,
        radius: 120,
        type: 'JAGGED AA LAVA FLOW',
        severity: 'caution',
        limit: 6.0,
        unsurveyed: false,
      },
      {
        id: 'H-OM-ASH',
        cx: 380,
        cz: 88,
        radius: 105,
        type: 'UNSURVEYED PUMICE DRIFT',
        severity: 'danger',
        limit: 3.5,
        unsurveyed: true,
      },
    ],
  },
];

export function getSiteSurfaceSpots(site = MARS_SITES_DATA[0]) {
  return [
    {
      id: MISSION_HAB.code,
      code: '0 — HABITAT',
      name: MISSION_HAB.name,
      shortName: 'Habitat',
      science: MISSION_HAB.subtitle || 'Surface base & airlock',
      x: MISSION_HAB.x,
      z: MISSION_HAB.z,
      ...worldToGrid500(MISSION_HAB.x, MISSION_HAB.z),
    },
    ...site.stations.map((s) => {
      const sx = s.x ?? s.at[0];
      const sz = s.z ?? s.at[1];
      return {
        id: s.id,
        code: s.code || s.id,
        name: s.name,
        shortName: s.shortName || s.name,
        science: s.science || s.objective || '',
        x: sx,
        z: sz,
        ...worldToGrid500(sx, sz),
      };
    }),
  ];
}

// ---------------------------------------------------------------------------
// 100×100 DEM & Hazard Classification Generator (works in Node + Browser)
// ---------------------------------------------------------------------------
export function computeSiteGridFromHeight(site) {
  const N = 100;
  const h = site.heightAt || analyticHeight;
  const cellM = WORLD_BOUNDS.size / N; // 16 m per grid sample
  const elevation = Array.from({ length: N }, () => new Array(N));
  const slope = Array.from({ length: N }, () => new Array(N));
  const crater = Array.from({ length: N }, () => new Array(N));
  const cost = Array.from({ length: N }, () => new Array(N));

  let minElevation = Infinity;
  let maxElevation = -Infinity;
  let maxSlopeDeg = 0;
  let maxCraterDepth = 0;

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const [wx, wz] = normalizedToWorld((c + 0.5) / N, (r + 0.5) / N);
      const val = h(wx, wz);
      elevation[r][c] = Number(val.toFixed(2));
      if (val < minElevation) minElevation = val;
      if (val > maxElevation) maxElevation = val;
    }
  }

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const rN = Math.max(0, r - 1);
      const rS = Math.min(N - 1, r + 1);
      const cW = Math.max(0, c - 1);
      const cE = Math.min(N - 1, c + 1);
      const dz = (elevation[rS][c] - elevation[rN][c]) / ((rS - rN || 1) * cellM);
      const dx = (elevation[r][cE] - elevation[r][cW]) / ((cE - cW || 1) * cellM);
      const slopeDeg = Math.atan(Math.hypot(dx, dz)) * (180 / Math.PI) * 2.4;

      // Local concavity relative to 4-cell neighbor mean detects crater / pit depressions
      const r2N = Math.max(0, r - 3);
      const r2S = Math.min(N - 1, r + 3);
      const c2W = Math.max(0, c - 3);
      const c2E = Math.min(N - 1, c + 3);
      const rimMean = (elevation[r2N][c] + elevation[r2S][c] + elevation[r][c2W] + elevation[r][c2E]) * 0.25;
      const depth = Math.max(0, (rimMean - elevation[r][c]) * 2.2);

      let cVal = 1;
      if (slopeDeg > 28 || depth > 20) cVal = 100;
      else if (depth > 10) cVal = 10;
      else if (slopeDeg > 15) cVal = 5;

      slope[r][c] = Number(slopeDeg.toFixed(2));
      crater[r][c] = Number(depth.toFixed(2));
      cost[r][c] = cVal;

      if (slopeDeg > maxSlopeDeg) maxSlopeDeg = slopeDeg;
      if (depth > maxCraterDepth) maxCraterDepth = depth;
    }
  }

  return {
    width: N,
    height: N,
    minElevation: Number(minElevation.toFixed(2)),
    maxElevation: Number(maxElevation.toFixed(2)),
    maxSlopeDeg: Number(maxSlopeDeg.toFixed(2)),
    maxCraterDepth: Number(maxCraterDepth.toFixed(2)),
    elevation,
    slope,
    crater,
    cost,
  };
}

// ---------------------------------------------------------------------------
// Per-Site Scan Canvas Renderer & Asset Cache (lazy, single-alloc per site)
// ---------------------------------------------------------------------------
const SCAN_RES = 360;
const siteAssetCache = new Map();

function loadImageElement(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function renderSyntheticScanCanvases(site, gridData, orbitalImg = null) {
  if (typeof document === 'undefined') {
    return { baseDrawable: null, combinedDrawable: null, previewUrl: './jezero/base.png' };
  }

  const W = SCAN_RES;
  const H = SCAN_RES;
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = W;
  baseCanvas.height = H;
  const bCtx = baseCanvas.getContext('2d');

  const combinedCanvas = document.createElement('canvas');
  combinedCanvas.width = W;
  combinedCanvas.height = H;
  const cCtx = combinedCanvas.getContext('2d');

  const bImg = bCtx.createImageData(W, H);
  const cImg = cCtx.createImageData(W, H);

  // If real HiRISE orbital texture exists (Site 01 Vera Rubin Ridge), sample pixels from it
  let orbPixels = null;
  if (orbitalImg && orbitalImg.complete && orbitalImg.naturalWidth > 0) {
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    const tCtx = tmp.getContext('2d');
    tCtx.drawImage(orbitalImg, 0, 0, W, H);
    orbPixels = tCtx.getImageData(0, 0, W, H).data;
  }

  const N = gridData.width || 100;
  const elev = gridData.elevation;
  const slopeGrid = gridData.slope;
  const craterGrid = gridData.crater;
  const lo = gridData.minElevation ?? -20;
  const span = Math.max(1, (gridData.maxElevation ?? 20) - lo);
  const pal = site.palette || { low: [62, 43, 35], mid: [132, 86, 63], high: [194, 148, 114] };

  for (let py = 0; py < H; py++) {
    const gy = (py / (H - 1)) * (N - 1);
    const r0 = Math.floor(gy);
    const r1 = Math.min(N - 1, r0 + 1);
    const fr = gy - r0;

    for (let px = 0; px < W; px++) {
      const gx = (px / (W - 1)) * (N - 1);
      const c0 = Math.floor(gx);
      const c1 = Math.min(N - 1, c0 + 1);
      const fc = gx - c0;

      const h00 = elev[r0][c0];
      const h10 = elev[r0][c1];
      const h01 = elev[r1][c0];
      const h11 = elev[r1][c1];
      const hVal = h00 * (1 - fc) * (1 - fr) + h10 * fc * (1 - fr) + h01 * (1 - fc) * fr + h11 * fc * fr;

      // Hillshade from NW light vector
      const dhx = ((h10 - h00) * (1 - fr) + (h11 - h01) * fr) * 0.65;
      const dhy = ((h01 - h00) * (1 - fc) + (h11 - h10) * fc) * 0.65;
      const shade = clamp(0.68 - dhx * 0.32 - dhy * 0.32, 0.25, 1.35);

      const tElev = clamp((hVal - lo) / span, 0, 1);
      let r;
      let g;
      let b;
      if (orbPixels) {
        const oi = (py * W + px) * 4;
        const hill = 0.55 + 0.55 * shade;
        r = clamp(orbPixels[oi] * hill, 0, 255);
        g = clamp(orbPixels[oi + 1] * hill, 0, 255);
        b = clamp(orbPixels[oi + 2] * hill, 0, 255);
      } else {
        if (tElev < 0.5) {
          const k = tElev * 2;
          r = pal.low[0] + (pal.mid[0] - pal.low[0]) * k;
          g = pal.low[1] + (pal.mid[1] - pal.low[1]) * k;
          b = pal.low[2] + (pal.mid[2] - pal.low[2]) * k;
        } else {
          const k = (tElev - 0.5) * 2;
          r = pal.mid[0] + (pal.high[0] - pal.mid[0]) * k;
          g = pal.mid[1] + (pal.high[1] - pal.mid[1]) * k;
          b = pal.mid[2] + (pal.high[2] - pal.mid[2]) * k;
        }
        r = clamp(r * shade, 0, 255);
        g = clamp(g * shade, 0, 255);
        b = clamp(b * shade, 0, 255);
      }

      const idx = (py * W + px) * 4;
      bImg.data[idx] = r;
      bImg.data[idx + 1] = g;
      bImg.data[idx + 2] = b;
      bImg.data[idx + 3] = 255;

      // Combined scan palette matching terrain_pipeline/src/hazard_generator.py:
      // steep slope > 28 (red), moderate > 15 (amber), deep crater > 20 (magenta), shallow > 10 (cyan)
      const rr = Math.round(gy);
      const cc = Math.round(gx);
      const sl = slopeGrid[rr][cc];
      const cr = craterGrid[rr][cc];
      let ovR = r * 0.62;
      let ovG = g * 0.62;
      let ovB = b * 0.62;
      if (cr > 20) {
        ovR = ovR * 0.25 + 199 * 0.75;
        ovG = ovG * 0.25 + 46 * 0.75;
        ovB = ovB * 0.25 + 224 * 0.75;
      } else if (sl > 28) {
        ovR = ovR * 0.25 + 235 * 0.75;
        ovG = ovG * 0.25 + 41 * 0.75;
        ovB = ovB * 0.25 + 41 * 0.75;
      } else if (cr > 10) {
        ovR = ovR * 0.32 + 38 * 0.68;
        ovG = ovG * 0.32 + 199 * 0.68;
        ovB = ovB * 0.32 + 242 * 0.68;
      } else if (sl > 15) {
        ovR = ovR * 0.32 + 250 * 0.68;
        ovG = ovG * 0.32 + 199 * 0.68;
        ovB = ovB * 0.32 + 31 * 0.68;
      }

      cImg.data[idx] = clamp(ovR, 0, 255);
      cImg.data[idx + 1] = clamp(ovG, 0, 255);
      cImg.data[idx + 2] = clamp(ovB, 0, 255);
      cImg.data[idx + 3] = 255;
    }
  }

  bCtx.putImageData(bImg, 0, 0);
  cCtx.putImageData(cImg, 0, 0);

  let previewUrl = site.previewImg || './jezero/base.png';
  try {
    previewUrl = baseCanvas.toDataURL('image/png');
  } catch {
    previewUrl = site.previewImg || './jezero/base.png';
  }

  return {
    baseDrawable: baseCanvas,
    combinedDrawable: combinedCanvas,
    previewUrl,
  };
}

export function ensureSiteAssets(site) {
  if (!site) return Promise.resolve(null);
  if (siteAssetCache.has(site.id)) return siteAssetCache.get(site.id);

  const promise = (async () => {
    if ((site.useStaticAssets || site.useJezeroFiles) && typeof fetch === 'function' && typeof document !== 'undefined') {
      const dir = site.assetDir || `./${site.id}`;
      try {
        const gridPromise = dir === './jezero'
          ? loadTopographyGrid().catch(() => null)
          : fetch(`${dir}/topography_grid.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const [gridResp, baseImg, combImg] = await Promise.all([
          gridPromise,
          loadImageElement(siteAssetUrl(`${dir}/base.png`)),
          loadImageElement(siteAssetUrl(`${dir}/combined.png`)),
        ]);
        const gridData = gridResp || computeSiteGridFromHeight(site);
        if (baseImg && combImg) {
          return {
            siteId: site.id,
            gridData,
            baseDrawable: baseImg,
            combinedDrawable: combImg,
            previewUrl: siteAssetUrl(site.previewImg || `${dir}/base.png`),
          };
        }
      } catch {
        // Fall through to synthesized relief
      }
    }

    const gridData = computeSiteGridFromHeight(site);
    let orbitalImg = null;
    if (site.id === 'vrr' && typeof document !== 'undefined' && galeImagery?.orbital) {
      orbitalImg = await loadImageElement(galeImagery.orbital);
    }
    const rendered = renderSyntheticScanCanvases(site, gridData, orbitalImg);
    return {
      siteId: site.id,
      gridData,
      ...rendered,
    };
  })();

  siteAssetCache.set(site.id, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// 3D Sandbox Plan Builder — connects selected site, A* route legs, site
// stations (S1..S4), and site area hazards directly into Terrain & Route.
// ---------------------------------------------------------------------------
export function buildSiteSandboxPlan(site, chosenRoute, existingTerrain = null) {
  const terrain = existingTerrain || new Terrain({ height: site.heightAt, inner: TERRAIN.inner });
  const legPoints = chosenRoute?.legPoints;
  const fallbackPts = [
    [0, -14],
    ...site.stations.map((s) => s.at),
    [0, -14],
  ];

  const curves = [];
  if (Array.isArray(legPoints) && legPoints.length > 0) {
    for (let leg = 0; leg < legPoints.length; leg++) {
      const worldPts = legPoints[leg].map(([nx, ny]) => normalizedToWorld(nx, ny));
      worldPts[0] = leg === 0 ? [0, -14] : [...site.stations[leg - 1].at];
      worldPts[worldPts.length - 1] = leg < site.stations.length ? [...site.stations[leg].at] : [0, -14];

      const dedup = [worldPts[0]];
      for (let i = 1; i < worldPts.length; i++) {
        const dx = worldPts[i][0] - dedup[dedup.length - 1][0];
        const dz = worldPts[i][1] - dedup[dedup.length - 1][1];
        if (Math.hypot(dx, dz) > 1.5) dedup.push(worldPts[i]);
      }
      if (dedup.length < 2) dedup.push(worldPts[worldPts.length - 1]);

      curves.push(
        new THREE.CatmullRomCurve3(
          dedup.map(([x, z]) => new THREE.Vector3(x, 0, z)),
          false,
          'centripetal',
        ),
      );
    }
  } else {
    for (let i = 0; i < fallbackPts.length - 1; i++) {
      const a = fallbackPts[i];
      const b = fallbackPts[i + 1];
      curves.push(
        new THREE.CatmullRomCurve3(
          [new THREE.Vector3(a[0], 0, a[1]), new THREE.Vector3(b[0], 0, b[1])],
          false,
          'centripetal',
        ),
      );
    }
  }

  let sAccum = 0;
  const stationS = site.stations.map((st, idx) => {
    sAccum += curves[idx]?.getLength() ?? 0;
    return { ...st, s: sAccum };
  });

  const path = joinCurves(curves);
  const route = new Route(terrain, {
    path,
    stations: stationS,
    areaHazards: site.areaHazards || [],
  });
  route.site = { name: site.name, eva: 'EVA-01', sol: site.sol ?? 214 };
  route.planName = `${site.name.split('·')[0].trim()} · ${chosenRoute?.name || chosenRoute?.label || 'Safest'} · 4-Station Survey`;

  const mins = Math.max(6, Math.round((route.length / 2.2) / 60));
  return {
    siteId: site.id,
    policyId: chosenRoute?.id || 'best',
    id: chosenRoute?.approachId || chosenRoute?.id || 'best',
    label: chosenRoute?.name || chosenRoute?.badge || 'Safest Path',
    name: route.planName,
    site: route.site,
    distance: Math.round(route.length),
    maxTilt: route.maxTilt ?? chosenRoute?.maxSlopeDeg ?? 10,
    unknowns: route.zones.filter((z) => z.unsurveyed),
    estimate: { minutes: mins, extraMinutes: null },
    traverse: { terrain, route },
  };
}
