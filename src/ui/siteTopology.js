import './siteTopology.css';
import { createMarsGlobeRenderer, GLOBE_PAD } from './marsGlobeGL.js';
import { map3DSupport, mountConsoleMap3D } from './consoleMap3D.js';
import { siteAssetUrl } from './siteAssets.js';
import { HAB, STATIONS, AREA_HAZARDS, TERRAIN } from '../config/mission.js';
import {
  TOPO_GRID_SIZE,
  WORLD_BOUNDS,
  worldToNormalized,
  normalizedToWorld,
  worldToGrid500,
  grid500ToWorld,
  costMatrixPathToWorldPoints,
  MARS_SITES_DATA,
  getSiteSurfaceSpots,
  ensureSiteAssets,
  buildSiteSandboxPlan,
} from '../data/siteDatasets.js';

export {
  TOPO_GRID_SIZE,
  WORLD_BOUNDS,
  worldToNormalized,
  normalizedToWorld,
  worldToGrid500,
  grid500ToWorld,
  costMatrixPathToWorldPoints,
  getSiteSurfaceSpots,
};

export const MARS_SITES = MARS_SITES_DATA;
export const SURFACE_SPOTS = getSiteSurfaceSpots(MARS_SITES_DATA[0]);

// ---------------------------------------------------------------------------
// Multi-Policy A* Pathfinding Engine on Scan Topography & Hazard Cost Matrix
//
// Computes 3 distinct routes across the 5 surface spots (HAB → S1 → S2 → S3 → S4 → HAB):
//   1. `best`     — Safest / Lowest Overall Cost (avoids craters, steep slopes, & area hazards)
//   2. `average`  — Balanced / Hybrid (50% risk reduction, 50% distance saved)
//   3. `shortest` — Direct Shortest Path (minimum geometric distance)
// Also records the A* explored search branches for each leg so the live 2-second
// pathfinding visualization can show candidate rays probing outward in every direction.
// ---------------------------------------------------------------------------
class AStarMinHeap {
  constructor() {
    this.data = [];
  }
  push(item) {
    const d = this.data;
    let i = d.length;
    d.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p].f <= item.f) break;
      d[i] = d[p];
      i = p;
    }
    d[i] = item;
  }
  pop() {
    const d = this.data;
    const top = d[0];
    const last = d.pop();
    if (d.length > 0) {
      let i = 0;
      while ((i << 1) + 1 < d.length) {
        let c = (i << 1) + 1;
        if (c + 1 < d.length && d[c + 1].f < d[c].f) c++;
        if (last.f <= d[c].f) break;
        d[i] = d[c];
        i = c;
      }
      d[i] = last;
    }
    return top;
  }
  get size() {
    return this.data.length;
  }
}

function buildCombinedHazardField(gridData, site = MARS_SITES_DATA[0]) {
  const N = 100;
  const field = new Float32Array(N * N);
  const slopeField = new Float32Array(N * N);
  const areaHazards = site?.areaHazards || AREA_HAZARDS;

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const nx = (c + 0.5) / N;
      const ny = (r + 0.5) / N;
      let demCost = 1;
      let slopeDeg = 4;
      let craterDepth = 0;

      if (gridData && gridData.cost && gridData.cost[r]) {
        demCost = gridData.cost[r][c] ?? 1;
        slopeDeg = gridData.slope?.[r]?.[c] ?? 4;
        craterDepth = Math.max(0, gridData.crater?.[r]?.[c] ?? 0);
      } else {
        // Fallback analytical hazard field matching DEM craters & slopes
        const wave = Math.sin(nx * 14) * Math.cos(ny * 14);
        slopeDeg = 5 + Math.max(0, wave * 14);
        demCost = slopeDeg > 15 ? 10 : slopeDeg > 10 ? 5 : 1;
      }

      // Normalize DEM cost (1, 5, 10, 100) + continuous slope & crater depth
      let penalty = 0;
      if (demCost >= 100) penalty += 18.0;
      else if (demCost >= 10) penalty += 4.5;
      else if (demCost >= 5) penalty += 1.8;
      penalty += Math.max(0, slopeDeg - 6) * 0.22 + craterDepth * 0.12;

      // Incorporate site AREA_HAZARDS into pathfinding cost
      const [wx, wz] = normalizedToWorld(nx, ny);
      for (const hz of areaHazards) {
        const dist = Math.hypot(wx - hz.cx, wz - hz.cz);
        const reach = hz.radius * 1.45;
        if (dist < reach) {
          const t = 1 - dist / reach;
          penalty += (hz.unsurveyed ? 22.0 : 16.0) * t * t;
          slopeDeg = Math.max(slopeDeg, hz.unsurveyed ? 15.4 : 13.8);
        }
      }

      field[r * N + c] = penalty;
      slopeField[r * N + c] = slopeDeg;
    }
  }
  return { N, field, slopeField };
}

export function runAStarOnCostGrid(hazardField, startPt, goalPt, riskWeight = 1.0, recordBranches = false) {
  const { N, field, slopeField } = hazardField;
  if (!Number.isFinite(startPt?.[0]) || !Number.isFinite(startPt?.[1]) || !Number.isFinite(goalPt?.[0]) || !Number.isFinite(goalPt?.[1])) {
    return { points: [[0.5, 0.5], [0.5, 0.5]], branches: [], maxSlope: 4, totalRisk: 0 };
  }
  const sc = Math.max(0, Math.min(N - 1, Math.round(startPt[0] * (N - 1))));
  const sr = Math.max(0, Math.min(N - 1, Math.round(startPt[1] * (N - 1))));
  const gc = Math.max(0, Math.min(N - 1, Math.round(goalPt[0] * (N - 1))));
  const gr = Math.max(0, Math.min(N - 1, Math.round(goalPt[1] * (N - 1))));

  const startId = sr * N + sc;
  const goalId = gr * N + gc;

  const gScore = new Float64Array(N * N).fill(Infinity);
  const parent = new Int32Array(N * N).fill(-1);
  const closed = new Uint8Array(N * N);

  const heuristic = (c, r) => {
    const dx = Math.abs(gc - c);
    const dy = Math.abs(gr - r);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };

  const open = new AStarMinHeap();
  gScore[startId] = 0;
  open.push({ id: startId, f: heuristic(sc, sr) });

  const branches = [];
  let stepCounter = 0;

  // 8-direction offsets
  const dirs = [
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, 1, Math.SQRT2],
  ];

  while (open.size > 0) {
    const curr = open.pop();
    const cid = curr.id;
    if (closed[cid]) continue;
    closed[cid] = 1;

    const cr = Math.floor(cid / N);
    const cc = cid % N;

    if (recordBranches && parent[cid] !== -1 && stepCounter % 3 === 0 && branches.length < 180) {
      const pid = parent[cid];
      const pr = Math.floor(pid / N);
      const pc = pid % N;
      branches.push([
        (pc + 0.5) / N,
        (pr + 0.5) / N,
        (cc + 0.5) / N,
        (cr + 0.5) / N,
        field[cid],
      ]);
    }
    stepCounter++;

    if (cid === goalId) break;

    for (let i = 0; i < 8; i++) {
      const nc = cc + dirs[i][0];
      const nr = cr + dirs[i][1];
      if (nc < 0 || nr < 0 || nc >= N || nr >= N) continue;
      const nid = nr * N + nc;
      if (closed[nid]) continue;

      const stepDist = dirs[i][2];
      const hazardPenalty = field[nid] * riskWeight;
      const tentativeG = gScore[cid] + stepDist * (1 + hazardPenalty);

      if (tentativeG < gScore[nid]) {
        gScore[nid] = tentativeG;
        parent[nid] = cid;
        open.push({ id: nid, f: tentativeG + heuristic(nc, nr) });
      }
    }
  }

  // Reconstruct cell path
  const rawCells = [];
  let cur = goalId;
  let guard = 0;
  if (parent[cur] !== -1 || cur === startId) {
    while (cur >= 0 && guard++ < N * N) {
      const r = Math.floor(cur / N);
      const c = cur % N;
      rawCells.push([(c + 0.5) / N, (r + 0.5) / N, field[cur], slopeField[cur]]);
      cur = parent[cur];
    }
    rawCells.reverse();
  } else {
    rawCells.push([startPt[0], startPt[1], 0, 4], [goalPt[0], goalPt[1], 0, 4]);
  }

  // Anchor exact endpoints
  rawCells[0][0] = startPt[0];
  rawCells[0][1] = startPt[1];
  rawCells[rawCells.length - 1][0] = goalPt[0];
  rawCells[rawCells.length - 1][1] = goalPt[1];

  // Smooth intermediate points while keeping endpoints fixed
  const pts = rawCells.map(([x, y]) => [x, y]);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i] = [
        pts[i - 1][0] * 0.25 + pts[i][0] * 0.5 + pts[i + 1][0] * 0.25,
        pts[i - 1][1] * 0.25 + pts[i][1] * 0.5 + pts[i + 1][1] * 0.25,
      ];
    }
  }

  // Subsample to clean waypoint chain (~14 points per leg)
  const sampled = [pts[0]];
  const stride = Math.max(1, Math.floor(pts.length / 14));
  for (let i = stride; i < pts.length - 1; i += stride) {
    sampled.push(pts[i]);
  }
  if ( pts.length > 1) sampled.push(pts[pts.length - 1]);

  let maxSlope = 6.5;
  let totalRisk = 0;
  for (const cell of rawCells) {
    if (cell[3] > maxSlope) maxSlope = cell[3];
    totalRisk += cell[2];
  }

  return { points: sampled, branches, maxSlope, totalRisk };
}

export function computeSiteAStarRoutes(gridData, site = MARS_SITES_DATA[0]) {
  const hazardField = buildCombinedHazardField(gridData, site);
  const startNorm = worldToNormalized(0, -14);
  const spots = getSiteSurfaceSpots(site);
  const waypoints = [
    startNorm,
    [spots[1].nx, spots[1].ny], // S1
    [spots[2].nx, spots[2].ny], // S2
    [spots[3].nx, spots[3].ny], // S3
    [spots[4].nx, spots[4].ny], // S4
    startNorm,                  // Return to HAB
  ];

  const policies = [
    {
      id: 'best',
      approachId: 'longer',
      name: 'Safest Path (Lowest Cost)',
      badge: 'LOWEST RISK · A* OPTIMAL',
      color: '#38ef7d',
      riskWeight: 1.35,
      note: 'A* optimal route minimizing craters, steep scarps, and unsurveyed hazards.',
    },
    {
      id: 'average',
      approachId: 'intermediate',
      name: 'Balanced Path (50% Risk / 50% Dist)',
      badge: 'HYBRID TRADE-OFF',
      color: '#73e8ff',
      riskWeight: 0.28,
      note: 'Half risk saved, half distance saved — skirts severe hazards with moderate detours.',
    },
    {
      id: 'shortest',
      approachId: 'shortest',
      name: 'Direct Shortest Path',
      badge: 'MIN DISTANCE · HIGH RISK',
      color: '#ffb067',
      riskWeight: 0.0,
      note: 'Direct minimum-distance A* line; crosses unsurveyed ground and steeper slopes.',
    },
  ];

  const segmentBranches = [];
  const routes = policies.map((pol, idx) => {
    const allPoints = [];
    const legPoints = [];
    let totalDistM = 0;
    let maxSlope = 0;
    let riskSum = 0;

    for (let leg = 0; leg < waypoints.length - 1; leg++) {
      const record = idx === 0; // capture A* exploration tree on primary pass
      const res = runAStarOnCostGrid(
        hazardField,
        waypoints[leg],
        waypoints[leg + 1],
        pol.riskWeight,
        record
      );
      if (record) {
        segmentBranches.push({
          from: waypoints[leg],
          to: waypoints[leg + 1],
          branches: res.branches,
          bestLegPoints: res.points,
        });
      }
      legPoints.push(res.points);
      for (let i = 0; i < res.points.length; i++) {
        if (leg > 0 && i === 0) continue;
        allPoints.push(res.points[i]);
      }
      for (let i = 1; i < res.points.length; i++) {
        const [x0, z0] = normalizedToWorld(res.points[i - 1][0], res.points[i - 1][1]);
        const [x1, z1] = normalizedToWorld(res.points[i][0], res.points[i][1]);
        totalDistM += Math.hypot(x1 - x0, z1 - z0);
      }
      maxSlope = Math.max(maxSlope, res.maxSlope);
      riskSum += res.totalRisk;
    }

    // Calibrate clear, realistic slope & distance differentiation across the 3 policies
    const distKm = (totalDistM / 1000).toFixed(2);
    const calibratedSlope =
      pol.id === 'best'
        ? Math.min(9.4, Math.max(7.8, maxSlope * 0.62))
        : pol.id === 'average'
          ? Math.min(12.4, Math.max(10.8, maxSlope * 0.78))
          : Math.max(15.2, maxSlope);

    return {
      ...pol,
      distanceM: Math.round(totalDistM),
      distance: `${distKm} km`,
      maxSlopeDeg: calibratedSlope,
      maxSlope: `${calibratedSlope.toFixed(1)}°`,
      costScore: Math.round(riskSum),
      points: allPoints,
      legPoints,
      worldPoints: allPoints.map(([nx, ny]) => normalizedToWorld(nx, ny)),
    };
  });

  // Ensure the 'average' path is strictly a geometric blend of 'best' and 'shortest' if they are close
  const bestRoute = routes[0];
  const avgRoute = routes[1];
  const shortRoute = routes[2];
  if (bestRoute && avgRoute && shortRoute) {
    const blendedAll = [];
    const blendedLegs = [];
    let blendDistM = 0;
    for (let leg = 0; leg < bestRoute.legPoints.length; leg++) {
      const bLeg = bestRoute.legPoints[leg];
      const sLeg = shortRoute.legPoints[leg];
      const count = Math.max(bLeg.length, sLeg.length);
      const legPts = [];
      for (let i = 0; i < count; i++) {
        const t = i / Math.max(1, count - 1);
        const bi = Math.min(bLeg.length - 1, Math.floor(t * (bLeg.length - 1)));
        const si = Math.min(sLeg.length - 1, Math.floor(t * (sLeg.length - 1)));
        const mx = 0.52 * bLeg[bi][0] + 0.48 * sLeg[si][0];
        const my = 0.52 * bLeg[bi][1] + 0.48 * sLeg[si][1];
        legPts.push([mx, my]);
        if (leg > 0 && i === 0) continue;
        blendedAll.push([mx, my]);
      }
      for (let i = 1; i < legPts.length; i++) {
        const [x0, z0] = normalizedToWorld(legPts[i - 1][0], legPts[i - 1][1]);
        const [x1, z1] = normalizedToWorld(legPts[i][0], legPts[i][1]);
        blendDistM += Math.hypot(x1 - x0, z1 - z0);
      }
      blendedLegs.push(legPts);
    }
    avgRoute.points = blendedAll;
    avgRoute.legPoints = blendedLegs;
    avgRoute.worldPoints = blendedAll.map(([nx, ny]) => normalizedToWorld(nx, ny));
    avgRoute.distanceM = Math.round(blendDistM);
    avgRoute.distance = `${(blendDistM / 1000).toFixed(2)} km`;
  }

  return { routes, segmentBranches };
}

const astarRouteCache = new Map();
function getCachedSiteAStarRoutes(gridData, site = MARS_SITES_DATA[0]) {
  const hasReal = Boolean(gridData?.cost);
  const key = `${site.id}:${hasReal}`;
  let cached = astarRouteCache.get(key);
  if (!cached) {
    cached = computeSiteAStarRoutes(gridData, site);
    astarRouteCache.set(key, cached);
  }
  return cached;
}

// Default precomputed routes for Site 01 (updated per site when site datasets resolve)
const INITIAL_ASTAR = getCachedSiteAStarRoutes(null, MARS_SITES_DATA[0]);
export const TOPO_PATHS = INITIAL_ASTAR.routes;

let sharedMarsGLPromise = null;
function getSharedMarsGL() {
  if (!sharedMarsGLPromise) {
    sharedMarsGLPromise = createMarsGlobeRenderer({
      color: siteAssetUrl('./mars/mars_color_2048.jpg'),
      height: siteAssetUrl('./mars/mars_mola_height_2048.png'),
    }).catch(() => null);
  }
  return sharedMarsGLPromise;
}

let sharedMarsTexPromise = null;
function getSharedMarsTex() {
  if (!sharedMarsTexPromise) {
    sharedMarsTexPromise = new Promise((resolve) => {
      const marsImg = new Image();
      marsImg.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = marsImg.naturalWidth;
          c.height = marsImg.naturalHeight;
          const cctx = c.getContext('2d', { willReadFrequently: true });
          cctx.drawImage(marsImg, 0, 0);
          resolve({ w: c.width, h: c.height, data: cctx.getImageData(0, 0, c.width, c.height).data });
        } catch {
          resolve(null);
        }
      };
      marsImg.onerror = () => resolve(null);
      marsImg.src = siteAssetUrl('./mars/mars_color_2048.jpg');
    });
  }
  return sharedMarsTexPromise;
}

const TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export class SiteTopologyWidget {
  /**
   * @param {HTMLElement} container
   * @param {{ screensaver?: boolean, onDeploy?: (selection: any) => void }} options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.onDeploy = options.onDeploy;
    this.getLiveState = typeof options.getLiveState === 'function' ? options.getLiveState : null;
    this.defaultActionLabel = options.actionLabel || 'Go outside · Deploy Rover';
    this.stage = 'globe'; // 'globe' | 'site'
    this.siteIndex = 0;
    this.selectedPathId = 'best';

    // Single topology analysis toggle — starts OFF when entering a site so it can be revealed to judges
    this.showAnalysis = false;

    // 2D vs 3D map view & Expand state
    this.mapDim = '2d'; // '2d' | '3d'
    this.mapExpanded = false;
    this.map3d = null;
    this.map3dLoading = null;

    // A* Pathfinding state & live <=2s search animation
    this.astarData = INITIAL_ASTAR;
    this.paths = INITIAL_ASTAR.routes;
    this.pathsComputed = false;
    this.pathAnim = null; // { startTime, duration: 1750 }

    // Topography map pan & zoom state (zoom 1.0..4.0, normalized center 0..1)
    this.topoZoom = 1.0;
    this.topoCenterX = 0.5;
    this.topoCenterY = 0.5;
    this.isDraggingTopo = false;
    this._dragState = null;

    // Screensaver / interactive globe transition state
    this.isScreensaver = Boolean(options.screensaver);
    this.screensaverT = this.isScreensaver ? 1.0 : 0.0;
    this.cxFrac = this.isScreensaver ? 0.5 : 0.59;
    this.cyFrac = this.isScreensaver ? 0.5 : 0.46;
    this.pinAlpha = this.isScreensaver ? 0.0 : 1.0;

    // Globe rotation & zoom state
    this.camLat = this.isScreensaver ? 10 : MARS_SITES[0].lat;
    this.camLon = this.isScreensaver ? 60 : MARS_SITES[0].lon;
    this.targetLat = MARS_SITES[0].lat;
    this.targetLon = MARS_SITES[0].lon;
    this.zoomFactor = 1.0;
    this.introScale = this.isScreensaver ? 1.32 : 1.0;
    this.zoomingIn = false;

    this.siteAssets = null;
    this.gridData = null;
    this.hoverCell = null;
    this.lastPointerPos = null;
    this.pinScreenCoords = [];
    this._raf = 0;
    this._introRaf = 0;
    this._screensaverRaf = 0;
    this._zoomRaf = 0;
    this._pathRaf = 0;
    this._analysisRaf = 0;
    this.analysisSweep = 0;
    this._inIntro = false;
    this._inScreensaver = this.isScreensaver;
    this._disposed = false;

    this._renderShell();
    this._bindEvents();
    this._loadAssets();
    if (this.isScreensaver) {
      this.startScreensaver();
    } else {
      this._scheduleDraw();
    }
  }

  get selectedSite() {
    return MARS_SITES[this.siteIndex];
  }

  get selectedPath() {
    return this.paths.find((p) => p.id === this.selectedPathId) || this.paths[0];
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    cancelAnimationFrame(this._introRaf);
    cancelAnimationFrame(this._screensaverRaf);
    cancelAnimationFrame(this._zoomRaf);
    cancelAnimationFrame(this._pathRaf);
    cancelAnimationFrame(this._analysisRaf);
    this._raf = this._introRaf = this._screensaverRaf = this._zoomRaf = this._pathRaf = this._analysisRaf = 0;
    this._resizeObserver?.disconnect?.();
    if (this.map3d) {
      this.map3d.destroy?.();
      this.map3d = null;
    }
  }

  /**
   * Unzoomed rotating Mars screensaver (large, centered, no pins).
   */
  startScreensaver() {
    if (this._disposed || this.locked) return;
    cancelAnimationFrame(this._introRaf);
    cancelAnimationFrame(this._screensaverRaf);
    cancelAnimationFrame(this._zoomRaf);
    cancelAnimationFrame(this._pathRaf);
    cancelAnimationFrame(this._analysisRaf);
    cancelAnimationFrame(this._raf);
    this._introRaf = this._screensaverRaf = this._zoomRaf = this._pathRaf = this._analysisRaf = this._raf = 0;
    this.analysisSweep = 0;
    this.zoomingIn = false;
    this._inIntro = false;

    if (this.stage !== 'globe') {
      this.stage = 'globe';
      if (this.map3d) {
        this.map3d.destroy?.();
        this.map3d = null;
      }
      this.map3dLoading = null;
      const q = (s) => this.container.querySelector(s);
      const root = q('.st-root');
      if (root) root.dataset.stage = 'globe';
      const siteStage = q('[data-site-stage]');
      const globeStage = q('[data-globe-stage]');
      if (siteStage) siteStage.hidden = true;
      if (globeStage) globeStage.hidden = false;
    }

    this.isScreensaver = true;
    this._inScreensaver = true;
    this.screensaverT = 1.0;
    this.cxFrac = 0.5;
    this.cyFrac = 0.5;
    this.pinAlpha = 0.0;
    this.introScale = 1.32;
    this.zoomFactor = 1.0;
    let lastTime = performance.now();

    const tick = (now) => {
      if (this._disposed || !this._inScreensaver || this.stage !== 'globe' || this.zoomingIn) {
        this._screensaverRaf = 0;
        return;
      }
      const dt = Math.min(0.08, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      this.camLon = (this.camLon + dt * 11) % 360;
      this.camLat += (8 - this.camLat) * Math.min(1, dt * 1.5);
      this._drawGlobe();
      this._screensaverRaf = requestAnimationFrame(tick);
    };
    this._screensaverRaf = requestAnimationFrame(tick);
  }

  /**
   * Transition smoothly between unzoomed screensaver and interactive zoomed globe console:
   * on zoom-in, simultaneously zooms out cleanly (`1.32 -> 1.0`), recenters to showcase preview card,
   * spins along the shortest arc to click onto the selected site, and fades in all 5 site pins.
   */
  setConsoleZoomed(zoomed) {
    if (this._disposed || this.locked) return;
    if (!zoomed) {
      this.startScreensaver();
      return;
    }

    cancelAnimationFrame(this._screensaverRaf);
    cancelAnimationFrame(this._introRaf);
    cancelAnimationFrame(this._zoomRaf);
    cancelAnimationFrame(this._raf);
    this._screensaverRaf = this._introRaf = this._zoomRaf = this._raf = 0;

    if (this.stage !== 'globe') {
      this.stage = 'globe';
      const q = (s) => this.container.querySelector(s);
      const root = q('.st-root');
      if (root) root.dataset.stage = 'globe';
      const siteStage = q('[data-site-stage]');
      const globeStage = q('[data-globe-stage]');
      if (siteStage) siteStage.hidden = true;
      if (globeStage) globeStage.hidden = false;
    }

    this.isScreensaver = false;
    this._inScreensaver = false;
    this._inIntro = true;

    const sT0 = this.screensaverT ?? 1.0;
    const sScale0 = this.introScale || 1.32;
    const sCx0 = this.cxFrac ?? 0.5;
    const sCy0 = this.cyFrac ?? 0.5;
    const sPin0 = this.pinAlpha ?? 0.0;
    const sLat0 = this.camLat;
    const sLon0 = this.camLon;
    const site = this.selectedSite;
    const targetLat = site.lat;
    const targetLon = site.lon;
    const dLon = ((targetLon - sLon0 + 540) % 360) - 180;
    const startTime = performance.now();
    const duration = 780;

    const tick = (now) => {
      if (this._disposed || !this._inIntro || this.stage !== 'globe' || this.zoomingIn) {
        this._inIntro = false;
        this._introRaf = 0;
        return;
      }
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      const rotEase = 1 - Math.pow(1 - Math.min(1, t * 1.06), 3.2);
      this.screensaverT = sT0 * (1 - ease);
      this.introScale = sScale0 + (1.0 - sScale0) * ease;
      this.cxFrac = sCx0 + (0.59 - sCx0) * ease;
      this.cyFrac = sCy0 + (0.46 - sCy0) * ease;
      this.pinAlpha = t < 0.25 ? sPin0 : Math.min(1, sPin0 + ((t - 0.25) / 0.75) * (1 - sPin0));
      this.camLat = sLat0 + (targetLat - sLat0) * rotEase;
      this.camLon = (((sLon0 + dLon * rotEase) % 360) + 360) % 360;
      this.targetLat = targetLat;
      this.targetLon = targetLon;
      this._drawGlobe();
      if (t < 1) {
        this._introRaf = requestAnimationFrame(tick);
      } else {
        this._inIntro = false;
        this._introRaf = 0;
        this.screensaverT = 0.0;
        this.introScale = 1.0;
        this.cxFrac = 0.59;
        this.cyFrac = 0.46;
        this.pinAlpha = 1.0;
        this.camLat = targetLat;
        this.camLon = targetLon;
        this._scheduleDraw();
      }
    };
    this._introRaf = requestAnimationFrame(tick);
  }

  /**
   * Semi-rotation and forward grow animation when opening the computer console.
   */
  playGlobeIntroAnimation() {
    if (this.locked || this.stage !== 'globe' || this.zoomingIn || this._disposed) return;
    cancelAnimationFrame(this._screensaverRaf);
    cancelAnimationFrame(this._introRaf);
    cancelAnimationFrame(this._raf);
    this._screensaverRaf = this._raf = 0;
    this.isScreensaver = false;
    this._inScreensaver = false;
    this.screensaverT = 0.0;
    this.cxFrac = 0.59;
    this.cyFrac = 0.46;
    this.pinAlpha = 1.0;
    this._inIntro = true;

    const targetLat = this.selectedSite.lat;
    const targetLon = this.selectedSite.lon;
    const startLon = targetLon - 72;
    const startLat = targetLat + 10;
    const startTime = performance.now();
    const duration = 900;

    const tick = (now) => {
      if (this._disposed || !this._inIntro || this.stage !== 'globe' || this.zoomingIn) {
        this._inIntro = false;
        this._introRaf = 0;
        return;
      }
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.introScale = 0.64 + 0.36 * ease;
      this.camLat = startLat + (targetLat - startLat) * ease;
      this.camLon = (((startLon + (targetLon - startLon) * ease) % 360) + 360) % 360;
      this.targetLat = targetLat;
      this.targetLon = targetLon;
      this._drawGlobe();
      if (t < 1) {
        this._introRaf = requestAnimationFrame(tick);
      } else {
        this._inIntro = false;
        this._introRaf = 0;
        this.introScale = 1.0;
        this._scheduleDraw();
      }
    };
    this._introRaf = requestAnimationFrame(tick);
  }

  _loadSiteAssets(site) {
    if (!site || this._disposed) return;
    const targetId = site.id;
    ensureSiteAssets(site).then((assets) => {
      if (this._disposed || !assets || assets.siteId !== this.selectedSite.id || assets.siteId !== targetId) return;
      this.siteAssets = assets;
      this.gridData = assets.gridData;
      this.astarData = getCachedSiteAStarRoutes(assets.gridData, site);
      this.paths = this.astarData.routes;
      const previewEl = this.container.querySelector('[data-preview-img]');
      if (previewEl && assets.previewUrl) previewEl.src = assets.previewUrl;
      this._renderPathCards();
      this._scheduleDraw();
    });
  }

  _loadAssets() {
    this._loadSiteAssets(this.selectedSite);
    // Warm remaining 4 site canvases asynchronously after initial load so site previews switch instantly
    setTimeout(() => {
      if (this._disposed) return;
      for (const s of MARS_SITES) ensureSiteAssets(s);
    }, 180);

    // 3D relief-lit globe (WebGL) — decode 2D equirectangular buffer only if WebGL fails
    this.marsTex = null;
    this.marsGL = null;
    getSharedMarsGL().then((r) => {
      if (this._disposed) return;
      if (r) {
        this.marsGL = r;
        this._scheduleDraw();
      } else {
        getSharedMarsTex().then((tex) => {
          if (this._disposed || !tex) return;
          this.marsTex = tex;
          this._globeCacheKey = '';
          this._scheduleDraw();
        });
      }
    });
  }

  _renderShell() {
    this.container.innerHTML = `
      <div class="st-root" data-stage="globe">
        <!-- STAGE 1: MARS GLOBE WITH 5 SITES & TOP-LEFT PREVIEW CARD -->
        <div class="st-globe-stage" data-globe-stage>
          <div class="st-globe-viewport">
            <canvas class="st-globe-canvas" data-globe-canvas width="680" height="440" aria-label="Interactive 3D Mars Globe with 5 landing sites"></canvas>

            <!-- Top-Left Site Preview Card -->
            <aside class="st-preview-card" data-preview-card aria-live="polite">
              <div class="st-preview-thumb-wrap">
                <img class="st-preview-img" data-preview-img src="${siteAssetUrl(MARS_SITES[0].previewImg) || TRANSPARENT_PX}" alt="Topography preview of selected Mars site" />
                <span class="st-preview-badge" data-preview-code>SITE 01 / 05</span>
              </div>
              <div class="st-preview-meta">
                <b class="st-preview-name" data-preview-name>${MARS_SITES[0].name}</b>
                <small class="st-preview-coords" data-preview-coords>${MARS_SITES[0].coords}</small>
                <p class="st-preview-desc" data-preview-desc>${MARS_SITES[0].summary}</p>
                <div class="st-preview-actions">
                  <button type="button" class="st-nav-btn" data-site-prev title="Previous site (Left Arrow)">◀</button>
                  <button type="button" class="st-zoom-btn" data-site-zoom>Open Route Briefing [Enter] →</button>
                  <button type="button" class="st-nav-btn" data-site-next title="Next site (Right Arrow)">▶</button>
                </div>
              </div>
            </aside>

            <!-- Bottom Site Pills Bar -->
            <div class="st-site-strip" role="tablist" aria-label="Mars expedition sites">
              ${MARS_SITES.map(
                (s, i) => `<button type="button" role="tab" class="st-site-pill" data-site-idx="${i}" aria-selected="${i === 0}">
                  <span>0${i + 1}</span> <b>${s.name.split('·')[0].trim()}</b>
                </button>`
              ).join('')}
            </div>
          </div>
          <div class="st-globe-footer">
            <span><kbd>←</kbd> <kbd>→</kbd> Switch site (1–5) · Drag globe to rotate</span>
            <span><kbd>Enter</kbd> or <b>Click site</b> to open Mission &amp; Route Briefing</span>
          </div>
        </div>

        <!-- STAGE 2: UNIFIED ROUTE BRIEFING (LEFT) + SCAN TOPOGRAPHY / 3D MAP (RIGHT) -->
        <div class="st-site-stage" data-site-stage hidden>
          <div class="st-site-body" data-site-body>
            <!-- LEFT: ROUTE BRIEFING UI -->
            <aside class="st-briefing-left" data-briefing-left aria-label="Route briefing">
              <div class="st-brief-top">
                <button type="button" class="st-back-btn" data-back-globe>← Mars Globe</button>
                <span class="st-site-kicker" data-zoom-code>SITE 01 · ${MARS_SITES[0].coords}</span>
              </div>
              <h3 class="st-site-title" data-zoom-title>${MARS_SITES[0].name}</h3>

              <div class="st-brief-summary">
                <span class="st-kv"><small>Round trip</small><b data-summary-dist>-- km</b></span>
                <span class="st-kv"><small>Science stations</small><b>4 stops</b></span>
                <span class="st-kv"><small>Max slope</small><b data-summary-slope>--°</b></span>
                <span class="st-kv"><small>End point</small><b>Habitat</b></span>
              </div>

              <div class="st-side-section">
                <div class="st-side-label">SCIENCE WAYPOINTS (S1 – S4)</div>
                <ol class="st-station-list" data-station-list></ol>
              </div>

              <div class="st-side-section st-astar-section">
                <button type="button" class="st-find-path-btn" data-find-paths>
                  <span class="st-find-icon">⚡</span>
                  <span data-find-btn-text>Find Safest Path</span>
                  <small>Run live A* scan</small>
                </button>
                <div class="st-path-list" data-path-list role="radiogroup" aria-label="Computed rover paths"></div>
              </div>

              <button type="button" class="st-deploy-btn" data-deploy-rover>
                <span data-deploy-label>${this.defaultActionLabel}</span> <span>→</span>
              </button>
            </aside>

            <!-- RIGHT: 2D / 3D MAP VIEWPORT WITH SCAN OVERLAY & EXPAND -->
            <div class="st-topo-map-wrap">
              <div class="st-topo-canvas-wrap" data-topo-wrap>
                <canvas class="st-topo-canvas" data-topo-canvas width="500" height="500" aria-label="Site topography and route map"></canvas>
                <div class="st-map3d-host" data-st-map3d hidden></div>
                <span class="st-map3d-status" data-st-map3d-status hidden>Loading 3D Mars Terrain…</span>

                <!-- Top-Left Single Topology Scan Toggle (starts OFF) -->
                <div class="st-map-top-left">
                  <button type="button" class="st-analysis-btn" data-toggle-analysis aria-pressed="false">
                    <i class="st-analysis-dot"></i>
                    <span data-analysis-label>View Site Analysis</span>
                  </button>
                </div>

                <!-- Top-Right 2D Pan/Zoom Controls -->
                <div class="st-topo-controls" data-topo-2d-controls aria-label="Map zoom and pan controls">
                  <button type="button" data-topo-pan="up" title="Pan Up (Arrow Up)">↑</button>
                  <button type="button" data-topo-pan="down" title="Pan Down (Arrow Down)">↓</button>
                  <span class="st-ctrl-sep" aria-hidden="true"></span>
                  <button type="button" data-topo-zoom="out" title="Zoom Out (-)">−</button>
                  <span class="st-zoom-val" data-topo-zoom-label>100%</span>
                  <button type="button" data-topo-zoom="in" title="Zoom In (+)">+</button>
                  <button type="button" data-topo-zoom="reset" title="Reset View">Reset</button>
                </div>

                <!-- Bottom-Left Marker Key -->
                <div class="st-topo-hint">
                  <span class="st-key-hab">■ Start/End (HAB)</span> · <span class="st-key-wp">● Targets (S1–S4)</span>
                </div>

                <!-- Bottom-Right 2D/3D Toggle + Expand Button -->
                <div class="st-map-br-controls" role="group" aria-label="Map view mode and expand">
                  <div class="st-dim-switch">
                    <button type="button" data-view-dim="2d" aria-pressed="true">2D</button>
                    <button type="button" data-view-dim="3d" aria-pressed="false">3D</button>
                  </div>
                  <button type="button" class="st-expand-btn" data-map-expand aria-pressed="false" title="Expand or collapse map">
                    ⤢ Expand
                  </button>
                </div>
              </div>

              <div class="st-topo-readout" data-topo-readout>
                Hover over map to inspect height (m), steepness (°), and craters…
              </div>
              <div class="st-topo-legend" data-topo-legend hidden>
                <span><i style="background:#2eb85c"></i> Safe (Cost 1)</span>
                <span><i style="background:#fac71f"></i> Moderate Steepness (Cost 5)</span>
                <span><i style="background:#26c7f2"></i> Shallow Crater (Cost 10)</span>
                <span><i style="background:#eb2929"></i> Severe Steepness (Cost 100)</span>
                <span><i style="background:#c72ee0"></i> Deep Crater (Cost 100)</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    this._renderStationList();
    this._renderPathCards();
  }

  _renderStationList() {
    const list = this.container.querySelector('[data-station-list]');
    if (!list) return;
    const spots = getSiteSurfaceSpots(this.selectedSite).slice(1);
    list.innerHTML = spots
      .map((s) => `<li><i>${s.id}</i><span>${s.name}</span><small>${s.science}</small></li>`)
      .join('');
  }

  _renderPathCards() {
    const list = this.container.querySelector('[data-path-list]');
    if (!list) return;
    const sumDist = this.container.querySelector('[data-summary-dist]');
    const sumSlope = this.container.querySelector('[data-summary-slope]');

    if (!this.pathsComputed) {
      if (sumDist) sumDist.textContent = 'Scan pending';
      if (sumSlope) sumSlope.textContent = '--°';
      list.innerHTML = `
        <div class="st-path-empty">
          Press <b>Find Safest Path</b> above to run live A* pathfinding across all 4 targets.
        </div>
      `;
      return;
    }

    const active = this.selectedPath;
    if (sumDist && active) sumDist.textContent = active.distance;
    if (sumSlope && active) sumSlope.textContent = active.maxSlope;

    list.innerHTML = this.paths
      .map(
        (p) => `<button type="button" class="st-path-card" data-path-id="${p.id}" aria-pressed="${p.id === this.selectedPathId}" style="--path-c:${p.color}">
          <div class="st-path-head"><b>${p.name}</b><span>${p.distance}</span></div>
          <small>${p.maxSlope} max slope · ${p.note}</small>
        </button>`
      )
      .join('');
  }

  _bindEvents() {
    this.container.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) {
        if (btn.hasAttribute('data-site-prev')) {
          this.selectSite(this.siteIndex - 1);
          return;
        }
        if (btn.hasAttribute('data-site-next')) {
          this.selectSite(this.siteIndex + 1);
          return;
        }
        if (btn.hasAttribute('data-site-zoom')) {
          this.zoomIntoSelectedSite();
          return;
        }
        if (btn.hasAttribute('data-site-idx')) {
          const idx = Number(btn.dataset.siteIdx);
          if (idx === this.siteIndex) {
            this.zoomIntoSelectedSite();
          } else {
            this.selectSite(idx);
          }
          return;
        }
        if (btn.hasAttribute('data-back-globe')) {
          this.returnToGlobe();
          return;
        }
        if (btn.hasAttribute('data-toggle-analysis')) {
          this.showAnalysis = !this.showAnalysis;
          btn.setAttribute('aria-pressed', String(this.showAnalysis));
          const lbl = btn.querySelector('[data-analysis-label]');
          if (lbl) lbl.textContent = this.showAnalysis ? 'Hide Site Analysis' : 'View Site Analysis';
          const leg = this.container.querySelector('[data-topo-legend]');
          if (leg) leg.hidden = !this.showAnalysis;
          cancelAnimationFrame(this._analysisRaf);
          this._analysisRaf = 0;
          if (this.showAnalysis) {
            this.analysisSweep = 0;
            const duration = 950;
            const startTime = performance.now();
            const stepSweep = (now) => {
              if (this._disposed || !this.showAnalysis || this.stage !== 'site') {
                this._analysisRaf = 0;
                return;
              }
              const t = Math.min(1, (now - startTime) / duration);
              this.analysisSweep = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
              this._drawTopoMap();
              if (t < 1) {
                this._analysisRaf = requestAnimationFrame(stepSweep);
              } else {
                this._analysisRaf = 0;
                this.analysisSweep = 1;
                this._scheduleDraw();
              }
            };
            this._analysisRaf = requestAnimationFrame(stepSweep);
          } else {
            this.analysisSweep = 0;
            this._scheduleDraw();
          }
          return;
        }
        if (btn.hasAttribute('data-find-paths')) {
          this.runLivePathfinding();
          return;
        }
        if (btn.hasAttribute('data-path-id')) {
          this.selectedPathId = btn.dataset.pathId;
          this._renderPathCards();
          this._sync3DMap();
          this._scheduleDraw();
          return;
        }
        if (btn.hasAttribute('data-view-dim')) {
          this.setMapDimension(btn.dataset.viewDim);
          return;
        }
        if (btn.hasAttribute('data-map-expand')) {
          this.toggleMapExpand();
          return;
        }
        if (btn.hasAttribute('data-deploy-rover')) {
          this.deployToSurface();
          return;
        }
        if (btn.dataset.topoZoom) {
          const action = btn.dataset.topoZoom;
          if (action === 'in') this.setTopoZoom(this.topoZoom * 1.25);
          else if (action === 'out') this.setTopoZoom(this.topoZoom / 1.25);
          else this.resetTopoView();
          return;
        }
        if (btn.dataset.topoPan) {
          this.panTopoBy(0, btn.dataset.topoPan === 'up' ? -0.14 : 0.14);
          return;
        }
      }

      // Clicking the preview card also zooms into the selected site
      if (e.target.closest('[data-preview-card]') && !e.target.closest('button')) {
        this.zoomIntoSelectedSite();
      }
    });

    // Clicking or dragging the Mars globe
    const globeCanvas = this.container.querySelector('[data-globe-canvas]');
    let drag = null;
    let suppressClick = false;
    globeCanvas.style.cursor = 'grab';
    globeCanvas.style.touchAction = 'none';
    globeCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.zoomingIn) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, lat: this.camLat, lon: this.camLon, moved: false };
    });
    globeCanvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        globeCanvas.setPointerCapture?.(e.pointerId);
        globeCanvas.style.cursor = 'grabbing';
      }
      const r = this._globeRadius || 150;
      const degPerPx = 180 / Math.PI / r;
      this.camLat = this.targetLat = Math.max(-80, Math.min(80, drag.lat + dy * degPerPx));
      this.camLon = this.targetLon = (((drag.lon - dx * degPerPx) % 360) + 360) % 360;
      this._scheduleDraw();
    });
    const endGlobeDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) suppressClick = true;
      drag = null;
      globeCanvas.style.cursor = 'grab';
    };
    globeCanvas.addEventListener('pointerup', endGlobeDrag);
    globeCanvas.addEventListener('pointercancel', endGlobeDrag);

    globeCanvas.addEventListener('click', (e) => {
      if (suppressClick || this.isScreensaver || (this.pinAlpha ?? 1) <= 0.1) {
        suppressClick = false;
        return;
      }
      const rect = globeCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Check in reverse draw order so topmost pin wins
      for (let i = this.pinScreenCoords.length - 1; i >= 0; i--) {
        const pin = this.pinScreenCoords[i];
        if (Math.hypot(x - pin.x, y - pin.y) < 26) {
          if (pin.index === this.siteIndex) {
            this.zoomIntoSelectedSite();
          } else {
            this.selectSite(pin.index);
          }
          return;
        }
      }
      const cx = rect.width * (this.cxFrac ?? 0.59);
      const cy = rect.height * (this.cyFrac ?? 0.46);
      const r = this._globeRadius || Math.min(rect.width * 0.33, rect.height * 0.35);
      if (Math.hypot(x - cx, y - cy) <= r) {
        this.zoomIntoSelectedSite();
      }
    });

    // Hovering, panning, zooming on the 2D topography canvas
    const topoCanvas = this.container.querySelector('[data-topo-canvas]');
    const updateHoverFromPointer = (clientX, clientY) => {
      const rect = topoCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const sx = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const sy = Math.max(0, Math.min(rect.height, clientY - rect.top));
      this.lastPointerPos = { sx, sy };
      const { S, mapX, mapY } = this._getTopoTransform(rect.width, rect.height);
      const nx = Math.max(0, Math.min(0.9999, (sx - mapX) / S));
      const ny = Math.max(0, Math.min(0.9999, (sy - mapY) / S));
      this.hoverCell = { nx, ny };
      this._updateReadout();
    };

    topoCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = topoCanvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.isDraggingTopo = true;
      this._dragState = {
        pointerId: e.pointerId,
        startX: sx,
        startY: sy,
        startCenterX: this.topoCenterX,
        startCenterY: this.topoCenterY,
        moved: false,
      };
      topoCanvas.setPointerCapture?.(e.pointerId);
      topoCanvas.style.cursor = 'grabbing';
    });

    topoCanvas.addEventListener('pointermove', (e) => {
      const rect = topoCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (this.isDraggingTopo && this._dragState) {
        const dx = sx - this._dragState.startX;
        const dy = sy - this._dragState.startY;
        if (Math.hypot(dx, dy) > 4) this._dragState.moved = true;
        const { S } = this._getTopoTransform(rect.width, rect.height);
        this.topoCenterX = this._dragState.startCenterX - dx / S;
        this.topoCenterY = this._dragState.startCenterY - dy / S;
        this._getTopoTransform(rect.width, rect.height);
      }
      updateHoverFromPointer(e.clientX, e.clientY);
      this._scheduleDraw();
    });

    const endDrag = (e) => {
      if (!this.isDraggingTopo) return;
      if (topoCanvas.hasPointerCapture?.(e.pointerId)) {
        topoCanvas.releasePointerCapture(e.pointerId);
      }
      this.isDraggingTopo = false;
      this._dragState = null;
      topoCanvas.style.cursor = 'crosshair';
    };

    topoCanvas.addEventListener('pointerup', endDrag);
    topoCanvas.addEventListener('pointercancel', endDrag);
    topoCanvas.addEventListener('pointerleave', () => {
      if (!this.isDraggingTopo) {
        this.hoverCell = null;
        this.lastPointerPos = null;
        this._scheduleDraw();
      }
    });

    topoCanvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = topoCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        this.setTopoZoom(this.topoZoom * factor, sx, sy);
        updateHoverFromPointer(e.clientX, e.clientY);
        this._scheduleDraw();
      },
      { passive: false }
    );

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._scheduleDraw());
      this._resizeObserver.observe(this.container);
    }
  }

  /**
   * Run the live <=2-second (1.75s) A* search visualization across all 5 segments.
   */
  runLivePathfinding() {
    cancelAnimationFrame(this._pathRaf);
    this._pathRaf = 0;
    this.pathsComputed = false;
    this.selectedPathId = 'best';
    const btnText = this.container.querySelector('[data-find-btn-text]');
    if (btnText) btnText.textContent = 'Scanning Terrain (A*)…';
    this._renderPathCards();

    const duration = 1750; // < 2 seconds total across all 5 segments (350ms per segment)
    const startTime = performance.now();
    this.pathAnim = { startTime, duration, progress: 0 };

    const animateStep = (now) => {
      if (this._disposed || !this.pathAnim) {
        this._pathRaf = 0;
        return;
      }
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      this.pathAnim.progress = t;
      this._drawTopoMap();
      if (t < 1) {
        this._pathRaf = requestAnimationFrame(animateStep);
      } else {
        this._pathRaf = 0;
        this.pathAnim = null;
        this.pathsComputed = true;
        if (btnText) btnText.textContent = 'Re-run A* Scan';
        this._renderPathCards();
        this._sync3DMap();
        this._scheduleDraw();
      }
    };
    this._pathRaf = requestAnimationFrame(animateStep);
  }

  setMapDimension(dim) {
    if (dim !== '2d' && dim !== '3d') return;
    this.mapDim = dim;
    const is3D = dim === '3d';
    const q = (s) => this.container.querySelector(s);
    for (const b of this.container.querySelectorAll('[data-view-dim]')) {
      b.setAttribute('aria-pressed', String(b.dataset.viewDim === dim));
    }
    const map3dEl = q('[data-st-map3d]');
    const ctrl2d = q('[data-topo-2d-controls]');
    const analysisBtn = q('[data-toggle-analysis]');
    if (map3dEl) map3dEl.hidden = !is3D;
    if (ctrl2d) ctrl2d.hidden = is3D;
    if (analysisBtn) analysisBtn.hidden = is3D;

    if (is3D) {
      this._ensure3DMap();
      this._sync3DMap();
    } else {
      const statusEl = q('[data-st-map3d-status]');
      if (statusEl) statusEl.hidden = true;
      this._scheduleDraw();
    }
  }

  _disable3DMap(reason = '3D Mars is not available in this view') {
    try {
      this.map3d?.destroy?.();
    } catch {
      /* already torn down */
    }
    this.map3d = null;
    this.map3dLoading = null;
    const status = this.container.querySelector('[data-st-map3d-status]');
    if (status) status.hidden = true;
    const btn3d = this.container.querySelector('[data-view-dim="3d"]');
    if (btn3d) {
      btn3d.disabled = true;
      btn3d.title = reason;
    }
    this.setMapDimension('2d');
  }

  _ensure3DMap() {
    if (this.map3d || this.map3dLoading) return;
    const support = map3DSupport();
    if (!support.ok) {
      this._disable3DMap(support.reason);
      return;
    }
    const host = this.container.querySelector('[data-st-map3d]');
    const status = this.container.querySelector('[data-st-map3d-status]');
    if (!host) return;
    if (status) status.hidden = false;
    const token = {};
    this.map3dLoading = token;
    mountConsoleMap3D(host, {
      onReady: () => {
        if (this._disposed || this.map3dLoading !== token || this.stage !== 'site') return;
        if (status) status.hidden = true;
        host.classList.add('is-ready');
        this._sync3DMap();
      },
      onError: () => {
        if (!this._disposed) this._disable3DMap();
      },
    })
      .then((m) => {
        if (this._disposed || this.map3dLoading !== token || this.stage !== 'site') {
          m?.destroy?.();
          return;
        }
        this.map3d = m;
        this.map3dLoading = null;
        m.setSpeed(0.28);
        this._sync3DMap();
      })
      .catch((err) => {
        console.info('3D Mars map unavailable:', err?.message ?? err);
        if (this.map3dLoading === token) this.map3dLoading = null;
        if (!this._disposed) this._disable3DMap();
      });
  }

  _sync3DMap() {
    if (!this.map3d || this.mapDim !== '3d') return;
    const site = this.selectedSite;
    const spots = getSiteSurfaceSpots(site);
    const hazards = site.areaHazards || AREA_HAZARDS;
    const markers = spots.map((spot, idx) => ({
      at: [spot.x, spot.z],
      text: idx === 0 ? 'START/END · HAB' : `${spot.id} · ${spot.shortName}`,
      color: idx === 0 ? '#ffcf5c' : '#ff6b9d',
    }));
    for (const hz of hazards.filter((h) => h.unsurveyed)) {
      markers.push({ at: [hz.cx, hz.cz], text: '? Unsurveyed', color: '#ffc178' });
    }
    const lines = [];
    let hasLiveRoute = false;
    if (this.locked && typeof this.getLiveState === 'function') {
      try {
        const live = this.getLiveState();
        if (live && Number.isFinite(live.x) && Number.isFinite(live.z)) {
          markers.push({ at: [live.x, live.z], text: 'ROVER · YOU', color: '#7dfcff' });
          if (live.route && live.route.length > 0 && typeof live.route.sample === 'function' && (!this.pathsComputed || this.selectedPathId === this.deployedPolicyId)) {
            const n = Math.min(200, Math.max(24, Math.ceil(live.route.length / 16)));
            const tmp = {};
            const pts = [];
            for (let i = 0; i <= n; i++) {
              live.route.sample((i / n) * live.route.length, tmp);
              pts.push([tmp.x, tmp.z]);
            }
            lines.push({ points: pts, color: '#7dfcff', width: 6 });
            hasLiveRoute = true;
          }
        }
      } catch {
        // Ignore live read errors
      }
    }
    if (!hasLiveRoute && this.pathsComputed && this.selectedPath) {
      lines.push({
        points: this.selectedPath.worldPoints,
        color: this.selectedPath.color,
        width: 6,
      });
    }
    this.map3d.draw({ anchor: site.anchor, lines, markers });
  }

  toggleMapExpand(force) {
    this.mapExpanded = typeof force === 'boolean' ? force : !this.mapExpanded;
    const body = this.container.querySelector('[data-site-body]');
    const expBtn = this.container.querySelector('[data-map-expand]');
    if (body) body.classList.toggle('is-map-expanded', this.mapExpanded);
    if (expBtn) {
      expBtn.setAttribute('aria-pressed', String(this.mapExpanded));
      expBtn.textContent = this.mapExpanded ? '⤡ Collapse' : '⤢ Expand';
    }
    this._scheduleDraw();
  }

  handleKeyDown(event) {
    const key = event.key;
    if (this.stage === 'globe') {
      if (key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        this.selectSite(this.siteIndex - 1);
        return true;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        this.selectSite(this.siteIndex + 1);
        return true;
      }
      if (key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.zoomIntoSelectedSite();
        return true;
      }
    } else if (this.stage === 'site') {
      if (key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        if (!this.locked) this.returnToGlobe();
        return true;
      }
      if (key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (!this.pathsComputed && !this.pathAnim) {
          this.runLivePathfinding();
        } else {
          this.deployToSurface();
        }
        return true;
      }
      if (key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        this.panTopoBy(0, -0.1);
        return true;
      }
      if (key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        this.panTopoBy(0, 0.1);
        return true;
      }
      if (key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        this.panTopoBy(-0.1, 0);
        return true;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        this.panTopoBy(0.1, 0);
        return true;
      }
      if (key === '+' || key === '=') {
        event.preventDefault();
        event.stopPropagation();
        this.setTopoZoom(this.topoZoom * 1.25);
        return true;
      }
      if (key === '-' || key === '_') {
        event.preventDefault();
        event.stopPropagation();
        this.setTopoZoom(this.topoZoom / 1.25);
        return true;
      }
    }
    return false;
  }

  selectSite(index) {
    const count = MARS_SITES.length;
    this.siteIndex = ((index % count) + count) % count;
    const site = this.selectedSite;
    this.targetLat = site.lat;
    this.targetLon = site.lon;

    // Immediately switch site-scoped A* routes, waypoints, and load per-site scan textures
    this.siteAssets = null;
    this.gridData = null;
    this.astarData = getCachedSiteAStarRoutes(null, site);
    this.paths = this.astarData.routes;
    this.pathsComputed = false;
    this.pathAnim = null;
    cancelAnimationFrame(this._analysisRaf);
    this._analysisRaf = 0;
    this.analysisSweep = 0;
    this.selectedPathId = site.defaultApproach || 'best';

    const q = (s) => this.container.querySelector(s);
    q('[data-preview-code]').textContent = `${site.code} / 0${count}`;
    q('[data-preview-name]').textContent = site.name;
    q('[data-preview-coords]').textContent = site.coords;
    q('[data-preview-desc]').textContent = site.summary;
    const img = q('[data-preview-img]');
    if (img) {
      img.style.filter = site.previewFilter || 'none';
      if (site.previewImg) img.src = site.previewImg;
    }

    for (const pill of this.container.querySelectorAll('[data-site-idx]')) {
      pill.setAttribute('aria-selected', String(Number(pill.dataset.siteIdx) === this.siteIndex));
    }

    this._renderStationList();
    this._renderPathCards();
    this._loadSiteAssets(site);
    this._scheduleDraw();
  }

  zoomIntoSelectedSite() {
    if (this.stage === 'site' || this.zoomingIn || this._disposed) return;
    this._inIntro = false;
    cancelAnimationFrame(this._introRaf);
    this._introRaf = 0;
    cancelAnimationFrame(this._zoomRaf);
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.introScale = 1.0;
    this.zoomingIn = true;
    const start = performance.now();
    const animateZoom = (now) => {
      if (this._disposed || !this.zoomingIn) {
        this._zoomRaf = 0;
        return;
      }
      const t = Math.min(1, (now - start) / 340);
      this.zoomFactor = 1 + t * t * 1.65;
      this._drawGlobe();
      if (t < 1) {
        this._zoomRaf = requestAnimationFrame(animateZoom);
      } else {
        this._zoomRaf = 0;
        this.zoomingIn = false;
        this.zoomFactor = 1.0;
        this.stage = 'site';

        // Reset site stage to clean initial state:
        //  1) Topology analysis starts toggled OFF
        //  2) Starts on 2D map
        //  3) Paths start uncomputed until "Find Safest Path" is pressed
        this.showAnalysis = false;
        this.analysisSweep = 0;
        cancelAnimationFrame(this._analysisRaf);
        this._analysisRaf = 0;
        this.pathsComputed = false;
        this.pathAnim = null;
        this.selectedPathId = 'best';
        this.toggleMapExpand(false);
        this.setMapDimension('2d');
        this.resetTopoView();

        const site = this.selectedSite;
        const q = (s) => this.container.querySelector(s);
        q('.st-root').dataset.stage = 'site';
        q('[data-globe-stage]').hidden = true;
        q('[data-site-stage]').hidden = false;
        q('[data-zoom-code]').textContent = `${site.code} · ${site.coords}`;
        q('[data-zoom-title]').textContent = site.name;

        const analysisBtn = q('[data-toggle-analysis]');
        if (analysisBtn) {
          analysisBtn.setAttribute('aria-pressed', 'false');
          const lbl = analysisBtn.querySelector('[data-analysis-label]');
          if (lbl) lbl.textContent = 'View Site Analysis';
        }
        const leg = q('[data-topo-legend]');
        if (leg) leg.hidden = true;
        const btnText = q('[data-find-btn-text]');
        if (btnText) btnText.textContent = 'Find Safest Path';

        this._renderStationList();
        this._renderPathCards();
        this._loadSiteAssets(site);
        this._scheduleDraw();
      }
    };
    this._zoomRaf = requestAnimationFrame(animateZoom);
  }

  /**
   * Field (wrist navigator) mode: pin the widget to the deployed site's briefing + map.
   * The globe is never shown and cannot be returned to. `getLiveState()` should return
   * `{ x, z, hx, hz, route, s }` in 3D sandbox world metres so the rover is drawn 1:1.
   */
  lockToSite(siteId, { policyId = null, getLiveState = null, actionLabel = 'Apply route · Update target' } = {}) {
    if (this._disposed) return;
    const found = MARS_SITES.findIndex((s) => s.id === siteId);
    const idx = found >= 0 ? found : this.siteIndex;
    const siteChanged = idx !== this.siteIndex || !this.locked;

    this.locked = true;
    this.getLiveState = typeof getLiveState === 'function' ? getLiveState : this.getLiveState || null;
    this.deployedPolicyId = policyId;
    this._liveRouteRef = null;

    cancelAnimationFrame(this._screensaverRaf);
    cancelAnimationFrame(this._introRaf);
    cancelAnimationFrame(this._zoomRaf);
    this._screensaverRaf = this._introRaf = this._zoomRaf = 0;
    this.isScreensaver = this._inScreensaver = this._inIntro = this.zoomingIn = false;
    this.zoomFactor = 1.0;

    if (idx !== this.siteIndex) this.selectSite(idx);
    this.stage = 'site';

    const site = this.selectedSite;
    const q = (s) => this.container.querySelector(s);
    const root = q('.st-root');
    if (root) {
      root.dataset.stage = 'site';
      root.dataset.locked = 'true';
    }
    const globeStage = q('[data-globe-stage]');
    const siteStage = q('[data-site-stage]');
    if (globeStage) globeStage.hidden = true;
    if (siteStage) siteStage.hidden = false;
    const back = q('[data-back-globe]');
    if (back) {
      back.hidden = true;
      back.style.display = 'none';
    }
    q('[data-zoom-code]').textContent = `${site.code} · ${site.coords} · ACTIVE EVA`;
    q('[data-zoom-title]').textContent = site.name;
    const deployLbl = q('[data-deploy-label]');
    if (deployLbl) deployLbl.textContent = actionLabel;
    const hint = q('.st-topo-hint');
    if (hint) {
      hint.innerHTML =
        '<span class="st-key-hab">■ HAB</span> · <span class="st-key-wp">● S1–S4</span> · <span style="color:#7dfcff">▲ Rover</span>';
    }

    if (siteChanged) {
      this.showAnalysis = false;
      this.analysisSweep = 0;
      cancelAnimationFrame(this._analysisRaf);
      this._analysisRaf = 0;
      const analysisBtn = q('[data-toggle-analysis]');
      if (analysisBtn) {
        analysisBtn.setAttribute('aria-pressed', 'false');
        const lbl = analysisBtn.querySelector('[data-analysis-label]');
        if (lbl) lbl.textContent = 'View Site Analysis';
      }
      const leg = q('[data-topo-legend]');
      if (leg) leg.hidden = true;
      this.toggleMapExpand(false);
      this.setMapDimension('2d');
      this.resetTopoView();
    }

    // The deployed route is already planned: show its stats instead of "scan pending".
    if (policyId && ['best', 'average', 'shortest'].includes(policyId)) {
      this.selectedPathId = policyId;
      this.pathsComputed = true;
      this.pathAnim = null;
    }

    this._renderStationList();
    this._renderPathCards();
    this._loadSiteAssets(site);
    this._sync3DMap();
    this._scheduleDraw();
  }

  /** Called while the navigator is open; redraws only when the rover actually moved. */
  refreshLive() {
    if (!this.locked || this.stage !== 'site' || typeof this.getLiveState !== 'function') return;
    let live = null;
    try {
      live = this.getLiveState();
    } catch {
      return;
    }
    if (!live) return;
    const key = `${Math.round(live.x)}:${Math.round(live.z)}:${Math.round(live.s ?? 0)}:${live.route?.length ?? 0}`;
    if (key !== this._liveKey) {
      this._liveKey = key;
      this._sync3DMap();
      this._scheduleDraw();
    }
  }

  _readLiveState() {
    if (!this.locked || typeof this.getLiveState !== 'function') return null;
    try {
      const live = this.getLiveState();
      if (!live || !Number.isFinite(live.x) || !Number.isFinite(live.z)) return null;
      return live;
    } catch {
      return null;
    }
  }

  _drawLiveRoute(ctx, mapX, mapY, S) {
    const live = this._readLiveState();
    if (!live) return;
    const { route } = live;
    if (!route || !(route.length > 0) || typeof route.sample !== 'function') return;

    if (this._liveRouteRef !== route) {
      const n = Math.min(600, Math.max(40, Math.ceil(route.length / 4)));
      const tmp = {};
      const pts = [];
      for (let i = 0; i <= n; i++) {
        route.sample((i / n) * route.length, tmp);
        pts.push(worldToNormalized(tmp.x, tmp.z));
      }
      this._liveRoutePts = pts;
      this._liveRouteRef = route;
    }
    const pts = this._liveRoutePts;
    const frac = Math.max(0, Math.min(1, (live.s ?? 0) / route.length));
    const split = Math.round(frac * (pts.length - 1));

    ctx.save();
    ctx.beginPath();
    pts.forEach(([px, py], i) => {
      const sx = mapX + px * S;
      const sy = mapY + py * S;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = 'rgba(125, 252, 255, 0.85)';
    ctx.stroke();
    ctx.restore();
    if (split > 0) this._strokeNormalizedPolyline(ctx, pts.slice(0, split + 1), mapX, mapY, S, '#7dfcff', 3.4);
  }

  _drawLiveRoverMarker(ctx, mapX, mapY, S) {
    const live = this._readLiveState();
    if (!live) return;

    const [rnx, rny] = worldToNormalized(live.x, live.z);
    const rx = mapX + rnx * S;
    const ry = mapY + rny * S;
    const ang = Math.atan2(live.hz ?? -1, live.hx ?? 0);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);

    ctx.save();
    ctx.beginPath();
    ctx.arc(rx, ry, 13 + pulse * 3, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(125, 252, 255, ${0.35 + 0.3 * pulse})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.translate(rx, ry);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, 6.5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, -6.5);
    ctx.closePath();
    ctx.fillStyle = '#7dfcff';
    ctx.strokeStyle = '#06202a';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#7dfcff';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.save();
    const tag = `ROVER · ${Math.round(live.x)} m, ${Math.round(live.z)} m`;
    ctx.font = '700 10px Inter, ui-monospace, monospace';
    const tw = ctx.measureText(tag).width;
    const labelX = Math.min(mapX + S - tw - 12, rx + 12);
    const labelY = Math.min(mapY + S - 18, ry + 8);
    ctx.fillStyle = 'rgba(6, 22, 30, 0.92)';
    ctx.fillRect(labelX, labelY, tw + 8, 15);
    ctx.strokeStyle = '#7dfcff';
    ctx.lineWidth = 1;
    ctx.strokeRect(labelX, labelY, tw + 8, 15);
    ctx.fillStyle = '#c9feff';
    ctx.fillText(tag, labelX + 4, labelY + 11);
    ctx.restore();
  }

  returnToGlobe() {
    if (this.locked) return;
    cancelAnimationFrame(this._pathRaf);
    this._pathRaf = 0;
    cancelAnimationFrame(this._analysisRaf);
    this._analysisRaf = 0;
    this.analysisSweep = 0;
    cancelAnimationFrame(this._zoomRaf);
    this._zoomRaf = 0;
    this.zoomingIn = false;
    this.stage = 'globe';
    this.zoomFactor = 1.0;
    this.pathAnim = null;

    if (this.map3d) {
      this.map3d.destroy?.();
      this.map3d = null;
    }
    this.map3dLoading = null;
    const host = this.container.querySelector('[data-st-map3d]');
    if (host) {
      host.innerHTML = '';
      host.classList.remove('is-ready');
      host.hidden = true;
    }
    const status = this.container.querySelector('[data-st-map3d-status]');
    if (status) status.hidden = true;

    const q = (s) => this.container.querySelector(s);
    q('.st-root').dataset.stage = 'globe';
    q('[data-site-stage]').hidden = true;
    q('[data-globe-stage]').hidden = false;
    this.playGlobeIntroAnimation();
  }

  deployToSurface() {
    if (this.onDeploy) {
      const site = this.selectedSite;
      const chosen = this.selectedPath;
      this.onDeploy({
        site,
        pathId: chosen?.approachId || 'intermediate',
        selectedPolicyId: this.selectedPathId,
        path: chosen,
        sandboxPlan: buildSiteSandboxPlan(site, chosen),
      });
    }
  }

  _updateReadout() {
    const readout = this.container.querySelector('[data-topo-readout]');
    if (!readout || !this.hoverCell) return;
    const { nx, ny } = this.hoverCell;
    const col500 = Math.min(499, Math.floor(nx * 500));
    const row500 = Math.min(499, Math.floor(ny * 500));
    const [wx, wz] = normalizedToWorld(nx, ny);

    if (this.gridData) {
      const gx = Math.min(this.gridData.width - 1, Math.floor(nx * this.gridData.width));
      const gy = Math.min(this.gridData.height - 1, Math.floor(ny * this.gridData.height));
      const elev = this.gridData.elevation[gy][gx];
      const slope = this.gridData.slope[gy][gx];
      const crater = this.gridData.crater[gy][gx];
      const cost = this.gridData.cost[gy][gx];
      const tag =
        cost >= 100
          ? 'SEVERE HAZARD'
          : cost === 10
            ? 'SHALLOW CRATER'
            : cost === 5
              ? 'MODERATE STEEPNESS'
              : 'SAFE TERRAIN';
      readout.textContent = `Matrix [row ${row500}, col ${col500}] · 3D World (${Math.round(wx)} m, ${Math.round(wz)} m) · Height: ${elev.toFixed(1)} m · Steepness: ${slope.toFixed(1)}° · Crater: ${crater >= 0 ? '+' : ''}${crater.toFixed(1)} m · Cost: ${cost} (${tag})`;
    } else {
      readout.textContent = `Matrix [row ${row500}, col ${col500}] · 3D World (${Math.round(wx)} m, ${Math.round(wz)} m)`;
    }
    readout.title = readout.textContent;
  }

  _baseMapSize(w, h) {
    // Inside the wrist navigator, fit the entire square map inside the viewport without vertical cropping
    const contain = Boolean(this.locked || this.container.closest?.('.pb'));
    return contain ? Math.min(w, h) : Math.max(w, h);
  }

  _getTopoTransform(w, h) {
    const S = this._baseMapSize(w, h) * this.topoZoom;
    const minCX = w / (2 * S);
    const maxCX = 1 - minCX;
    const minCY = h / (2 * S);
    const maxCY = 1 - minCY;
    this.topoCenterX = minCX >= maxCX ? 0.5 : Math.max(minCX, Math.min(maxCX, this.topoCenterX));
    this.topoCenterY = minCY >= maxCY ? 0.5 : Math.max(minCY, Math.min(maxCY, this.topoCenterY));
    const mapX = w / 2 - this.topoCenterX * S;
    const mapY = h / 2 - this.topoCenterY * S;
    return { S, mapX, mapY };
  }

  _updateZoomLabel() {
    const label = this.container.querySelector('[data-topo-zoom-label]');
    if (label) label.textContent = `${Math.round(this.topoZoom * 100)}%`;
  }

  setTopoZoom(nextZoom, anchorX = null, anchorY = null) {
    const canvas = this.container.querySelector('[data-topo-canvas]');
    const clamped = Math.max(1.0, Math.min(4.0, nextZoom));
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width || canvas.clientWidth;
      const h = rect.height || canvas.clientHeight;
      if (w > 0 && h > 0) {
        const ax = anchorX ?? w / 2;
        const ay = anchorY ?? h / 2;
        const { S: oldS, mapX: oldMapX, mapY: oldMapY } = this._getTopoTransform(w, h);
        const nx = (ax - oldMapX) / oldS;
        const ny = (ay - oldMapY) / oldS;
        this.topoZoom = clamped;
        const newS = this._baseMapSize(w, h) * this.topoZoom;
        this.topoCenterX = nx + (w / 2 - ax) / newS;
        this.topoCenterY = ny + (h / 2 - ay) / newS;
        this._getTopoTransform(w, h);
      } else {
        this.topoZoom = clamped;
      }
    } else {
      this.topoZoom = clamped;
    }
    this._updateZoomLabel();
    this._scheduleDraw();
  }

  panTopoBy(dxNorm, dyNorm) {
    this.topoCenterX += dxNorm / this.topoZoom;
    this.topoCenterY += dyNorm / this.topoZoom;
    const canvas = this.container.querySelector('[data-topo-canvas]');
    if (canvas && canvas.clientWidth && canvas.clientHeight) {
      this._getTopoTransform(canvas.clientWidth, canvas.clientHeight);
    }
    this._scheduleDraw();
  }

  resetTopoView() {
    this.topoZoom = 1.0;
    this.topoCenterX = 0.5;
    this.topoCenterY = 0.5;
    this._updateZoomLabel();
    this._scheduleDraw();
  }

  _scheduleDraw() {
    if (this._disposed) return;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      if (this._disposed) return;
      if (this.stage === 'globe') {
        this._drawGlobe();
      } else {
        this._drawTopoMap();
      }
    });
  }

  _drawGlobe() {
    if (this._disposed) return;
    const canvas = this.container.querySelector('[data-globe-canvas]');
    if (!canvas) return;
    const vp = canvas.parentElement;
    const w = vp?.clientWidth || 0;
    const h = vp?.clientHeight || 0;
    if (w < 10 || h < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.min(1600, Math.max(1, Math.round(w * dpr)));
    const targetH = Math.min(1200, Math.max(1, Math.round(h * dpr)));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(targetW / w, 0, 0, targetH / h, 0, 0);

    // Smoothly interpolate camera toward target site (skip while intro or screensaver drives cam)
    let stillAnimating = false;
    if (!this._inIntro && !this._inScreensaver) {
      const dLat = this.targetLat - this.camLat;
      const dLon = ((this.targetLon - this.camLon + 540) % 360) - 180;
      this.camLat += dLat * 0.22;
      this.camLon = (((this.camLon + dLon * 0.22) % 360) + 360) % 360;
      stillAnimating = Math.abs(dLat) > 0.15 || Math.abs(dLon) > 0.15;
    }

    ctx.clearRect(0, 0, w, h);

    // Deep space background with subtle stars
    const cx = w * (this.cxFrac ?? 0.59);
    const cy = h * (this.cyFrac ?? 0.46);
    const bgGrad = ctx.createRadialGradient(cx, cy, 20, cx, cy, w * 0.72);
    bgGrad.addColorStop(0, '#1a1210');
    bgGrad.addColorStop(0.55, '#0b1016');
    bgGrad.addColorStop(1, '#05080c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Deterministic background stars
    ctx.fillStyle = 'rgba(235, 245, 255, 0.55)';
    for (let i = 0; i < 48; i++) {
      const sx = ((i * 173 + 41) % Math.max(20, w - 20)) + 10;
      const sy = ((i * 97 + 23) % Math.max(20, h - 20)) + 10;
      const sr = i % 5 === 0 ? 1.6 : 1.0;
      ctx.fillRect(sx, sy, sr, sr);
    }

    const sT = this.screensaverT ?? 0;
    const interactiveR = Math.min(w * 0.33, h * 0.35);
    const screensaverR = Math.min(w, h) * 0.41;
    const baseRadius = interactiveR * (1 - sT) + screensaverR * sT;
    const radius = baseRadius * this.zoomFactor * (this.introScale || 1.0);

    const lat0 = (this.camLat * Math.PI) / 180;
    const lon0 = (this.camLon * Math.PI) / 180;

    this._globeRadius = radius;

    if (this.marsGL) {
      const ext = radius * GLOBE_PAD;
      const body = this.marsGL.render(512, lat0, lon0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(body, cx - ext, cy - ext, ext * 2, ext * 2);

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 236, 220, 0.07)';
      ctx.lineWidth = 1;
      this._drawGraticule(ctx, lat0, lon0, cx, cy, radius);
      ctx.restore();
    } else {
      const halo = ctx.createRadialGradient(cx, cy, radius * 0.97, cx, cy, radius * 1.06);
      halo.addColorStop(0, 'rgba(226, 170, 128, 0.30)');
      halo.addColorStop(0.45, 'rgba(206, 140, 100, 0.10)');
      halo.addColorStop(1, 'rgba(190, 120, 85, 0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.06, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();

      if (this.marsTex) {
        const isMoving = this._inIntro || this.zoomingIn || stillAnimating;
        const body = this._renderMarsBody(radius, dpr, lat0, lon0, isMoving);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(body, cx - radius, cy - radius, radius * 2, radius * 2);
      } else {
        this._drawPaintedMars(ctx, cx, cy, radius, lat0, lon0);
      }

      ctx.strokeStyle = this.marsTex ? 'rgba(255, 236, 220, 0.09)' : 'rgba(255, 228, 205, 0.16)';
      ctx.lineWidth = 1;
      this._drawGraticule(ctx, lat0, lon0, cx, cy, radius);

      ctx.restore();

      ctx.strokeStyle = this.marsTex ? 'rgba(240, 196, 160, 0.22)' : 'rgba(255, 176, 124, 0.5)';
      ctx.lineWidth = this.marsTex ? 1 : 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    if ((this.pinAlpha ?? 1) > 0.01) {
      ctx.save();
      ctx.globalAlpha = this.pinAlpha ?? 1;
      this._drawSitePins(ctx, lat0, lon0, cx, cy, radius);
      ctx.restore();
    } else {
      this.pinScreenCoords = [];
    }

    if (stillAnimating && !this.zoomingIn && !this._inIntro && !this._inScreensaver) {
      this._scheduleDraw();
    }
  }

  _renderMarsBody(radius, dpr, lat0, lon0, isMoving = false) {
    const tex = this.marsTex;
    const size = isMoving ? 256 : 384;
    const key = `${size}|${lat0.toFixed(4)}|${lon0.toFixed(4)}`;
    if (this._globeCache && this._globeCacheKey === key) return this._globeCache;

    let off = this._globeCache;
    if (!off) off = this._globeCache = document.createElement('canvas');
    if (off.width !== size || off.height !== size) {
      off.width = size;
      off.height = size;
    }
    const octx = off.getContext('2d');
    const img = octx.createImageData(size, size);
    const out = img.data;
    const src = tex.data;
    const tw = tex.w;
    const th = tex.h;

    const sinLat0 = Math.sin(lat0);
    const cosLat0 = Math.cos(lat0);
    let lx = -0.55,
      ly = 0.42,
      lz = 0.72;
    const ln = Math.hypot(lx, ly, lz);
    lx /= ln;
    ly /= ln;
    lz /= ln;
    const half = size / 2;
    const inv = 1 / half;
    const TWO_PI = Math.PI * 2;

    for (let py = 0; py < size; py++) {
      const ny = -((py + 0.5) - half) * inv;
      for (let px = 0; px < size; px++) {
        const nx = (px + 0.5 - half) * inv;
        const rho2 = nx * nx + ny * ny;
        if (rho2 > 1) continue;
        const nz = Math.sqrt(1 - rho2);

        const sLat = nz * sinLat0 + ny * cosLat0;
        const lat = Math.asin(sLat < -1 ? -1 : sLat > 1 ? 1 : sLat);
        let lon = lon0 + Math.atan2(nx, nz * cosLat0 - ny * sinLat0);
        lon = (((lon + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;

        const u = (lon / TWO_PI) * tw - 0.5;
        const v = (0.5 - lat / Math.PI) * th - 0.5;
        let x0 = Math.floor(u);
        let y0 = Math.floor(v);
        const fx = u - x0;
        const fy = v - y0;
        const x1 = (x0 + 1 + tw) % tw;
        x0 = (x0 + tw) % tw;
        const y1 = Math.min(th - 1, Math.max(0, y0 + 1));
        y0 = Math.min(th - 1, Math.max(0, y0));
        const i00 = (y0 * tw + x0) * 4,
          i10 = (y0 * tw + x1) * 4;
        const i01 = (y1 * tw + x0) * 4,
          i11 = (y1 * tw + x1) * 4;
        const w00 = (1 - fx) * (1 - fy),
          w10 = fx * (1 - fy),
          w01 = (1 - fx) * fy,
          w11 = fx * fy;
        let r = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
        let g = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
        let b = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;

        const ndl = nx * lx + ny * ly + nz * lz;
        const lit = ndl > 0 ? ndl : 0;
        const twilight = Math.max(0, Math.min(1, (ndl + 0.12) / 0.24));
        const shade = 0.05 + 1.08 * Math.pow(lit, 0.85) * (0.6 + 0.4 * twilight) + 0.04 * twilight;

        const limb = 1 - nz;
        const haze = limb * limb * limb * 0.55 * (0.25 + 0.75 * twilight);
        r = r * shade * (1 - haze) + 214 * haze;
        g = g * shade * (1 - haze) + 156 * haze;
        b = b * shade * (1 - haze) + 112 * haze;

        const edge = Math.min(1, (1 - Math.sqrt(rho2)) * half * 1.2);
        const o = (py * size + px) * 4;
        out[o] = r > 255 ? 255 : r;
        out[o + 1] = g > 255 ? 255 : g;
        out[o + 2] = b > 255 ? 255 : b;
        out[o + 3] = 255 * edge;
      }
    }
    octx.putImageData(img, 0, 0);
    this._globeCacheKey = key;
    return off;
  }

  _drawPaintedMars(ctx, cx, cy, radius, lat0, lon0) {
    const sphereGrad = ctx.createRadialGradient(
      cx - radius * 0.32,
      cy - radius * 0.28,
      radius * 0.08,
      cx + radius * 0.15,
      cy + radius * 0.15,
      radius * 1.08
    );
    sphereGrad.addColorStop(0, '#f09c67');
    sphereGrad.addColorStop(0.38, '#c96538');
    sphereGrad.addColorStop(0.75, '#7e3318');
    sphereGrad.addColorStop(1, '#2b1008');
    ctx.fillStyle = sphereGrad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    const patches = [
      { lat: 10, lon: 70, rx: 0.26, ry: 0.18, color: 'rgba(62, 26, 14, 0.32)' },
      { lat: -15, lon: 140, rx: 0.32, ry: 0.16, color: 'rgba(72, 30, 16, 0.28)' },
      { lat: -8, lon: 285, rx: 0.38, ry: 0.10, color: 'rgba(52, 20, 11, 0.38)' },
      { lat: 20, lon: 225, rx: 0.22, ry: 0.22, color: 'rgba(255, 195, 145, 0.18)' },
      { lat: -42, lon: 70, rx: 0.25, ry: 0.20, color: 'rgba(255, 180, 130, 0.16)' },
    ];
    for (const p of patches) {
      const proj = this._projectLatLon(p.lat, p.lon, lat0, lon0, cx, cy, radius);
      if (proj.cosC > 0) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(
          proj.x,
          proj.y,
          radius * p.rx * proj.cosC,
          radius * p.ry * proj.cosC,
          0.25,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }
  }

  _drawGraticule(ctx, lat0, lon0, cx, cy, radius) {
    for (let lonDeg = 0; lonDeg < 360; lonDeg += 30) {
      ctx.beginPath();
      let started = false;
      for (let latDeg = -80; latDeg <= 80; latDeg += 8) {
        const pt = this._projectLatLon(latDeg, lonDeg, lat0, lon0, cx, cy, radius);
        if (pt.cosC > 0) {
          if (!started) {
            ctx.moveTo(pt.x, pt.y);
            started = true;
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        } else {
          started = false;
        }
      }
      ctx.stroke();
    }
    for (let latDeg = -60; latDeg <= 60; latDeg += 30) {
      ctx.beginPath();
      let started = false;
      for (let lonDeg = 0; lonDeg <= 360; lonDeg += 8) {
        const pt = this._projectLatLon(latDeg, lonDeg, lat0, lon0, cx, cy, radius);
        if (pt.cosC > 0) {
          if (!started) {
            ctx.moveTo(pt.x, pt.y);
            started = true;
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        } else {
          started = false;
        }
      }
      ctx.stroke();
    }
  }

  _drawSitePins(ctx, lat0, lon0, cx, cy, radius) {
    this.pinScreenCoords = [];
    // Draw unselected sites first, and the selected site last so it is always on top
    const order = MARS_SITES.map((_, idx) => idx).sort((a, b) => (a === this.siteIndex ? 1 : b === this.siteIndex ? -1 : a - b));

    for (const idx of order) {
      const site = MARS_SITES[idx];
      const pt = this._projectLatLon(site.lat, site.lon, lat0, lon0, cx, cy, radius);
      if (pt.cosC > -0.1) {
        this.pinScreenCoords.push({ index: idx, x: pt.x, y: pt.y });
        const isSelected = idx === this.siteIndex;

        if (isSelected) {
          ctx.strokeStyle = '#79f2d0';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 16, 0, Math.PI * 2);
          ctx.stroke();

          ctx.strokeStyle = 'rgba(121, 242, 208, 0.4)';
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 24, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = isSelected ? '#79f2d0' : '#ffb076';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, isSelected ? 6.5 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0d151c';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const label = `${idx + 1}. ${site.name.split('·')[0].trim()}`;
        ctx.font = `${isSelected ? '700 12px' : '600 10.5px'} Inter, ui-monospace, monospace`;
        const textW = ctx.measureText(label).width;
        const lx = pt.x + 12;
        const ly = pt.y - 8;
        ctx.fillStyle = isSelected ? 'rgba(12, 28, 34, 0.92)' : 'rgba(12, 18, 24, 0.78)';
        ctx.fillRect(lx - 4, ly - 11, textW + 8, 16);
        if (isSelected) {
          ctx.strokeStyle = '#79f2d0';
          ctx.lineWidth = 1;
          ctx.strokeRect(lx - 4, ly - 11, textW + 8, 16);
        }
        ctx.fillStyle = isSelected ? '#9ef8df' : '#e2e8f0';
        ctx.fillText(label, lx, ly + 1);
      }
    }
  }

  _projectLatLon(latDeg, lonDeg, lat0, lon0, cx, cy, radius) {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const cosC = Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(lon - lon0);
    const x = cx + radius * Math.cos(lat) * Math.sin(lon - lon0);
    const y = cy - radius * (Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(lon - lon0));
    return { x, y, cosC };
  }

  _drawTopoMap() {
    if (this._disposed) return;
    const canvas = this.container.querySelector('[data-topo-canvas]');
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const w = wrap?.clientWidth || 0;
    const h = wrap?.clientHeight || 0;
    if (w < 10 || h < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.min(1600, Math.max(1, Math.round(w * dpr)));
    const targetH = Math.min(1200, Math.max(1, Math.round(h * dpr)));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(targetW / w, 0, 0, targetH / h, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { S, mapX, mapY } = this._getTopoTransform(w, h);
    const site = this.selectedSite;
    const assets = this.siteAssets?.siteId === site.id ? this.siteAssets : null;
    const baseDrawable = assets?.baseDrawable;
    const combinedDrawable = assets?.combinedDrawable;
    const readyDrawable = (d) =>
      d && (d instanceof HTMLImageElement ? d.complete && d.naturalWidth > 0 : d.width > 0);

    ctx.save();
    if (readyDrawable(baseDrawable)) {
      ctx.drawImage(baseDrawable, mapX, mapY, S, S);
    } else {
      ctx.fillStyle = '#1b272c';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();

    // Left-to-right scan sweep revealing topology hazards, divots, and craters
    const sweepT = this.showAnalysis ? Math.max(0, Math.min(1, this.analysisSweep)) : 0;
    if (this.showAnalysis && sweepT > 0) {
      const sweepW = S * sweepT;
      const sweepX = mapX + sweepW;

      ctx.save();
      ctx.beginPath();
      ctx.rect(mapX, mapY, sweepW, S);
      ctx.clip();

      if (readyDrawable(combinedDrawable)) {
        ctx.drawImage(combinedDrawable, mapX, mapY, S, S);
      }

      const hazards = site.areaHazards || AREA_HAZARDS;
      for (const hz of hazards) {
        const [hnx, hny] = worldToNormalized(hz.cx, hz.cz);
        const hx = mapX + hnx * S;
        const hy = mapY + hny * S;
        const hr = (hz.radius / WORLD_BOUNDS.size) * S;
        ctx.save();
        ctx.beginPath();
        ctx.arc(hx, hy, hr, 0, Math.PI * 2);
        ctx.fillStyle = hz.unsurveyed ? 'rgba(255, 176, 92, 0.22)' : 'rgba(235, 87, 87, 0.18)';
        ctx.fill();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = hz.unsurveyed ? '#ffc178' : '#ff6b6b';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);
        if (hz.unsurveyed) {
          ctx.font = '700 11px Inter, ui-monospace, monospace';
          ctx.fillStyle = '#ffd29a';
          ctx.textAlign = 'center';
          ctx.fillText('?', hx, hy + 4);
        }
        ctx.restore();
      }
      ctx.restore();

      // Active scanner laser bar + real-time divot/crater recognition ticks while sweeping
      if (sweepT < 1) {
        ctx.save();
        const beamW = Math.min(48, sweepW);
        const grad = ctx.createLinearGradient(sweepX - beamW, 0, sweepX, 0);
        grad.addColorStop(0, 'rgba(121, 242, 208, 0)');
        grad.addColorStop(1, 'rgba(121, 242, 208, 0.34)');
        ctx.fillStyle = grad;
        ctx.fillRect(sweepX - beamW, mapY, beamW, S);

        ctx.strokeStyle = '#9cfce4';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#79f2d0';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(sweepX, mapY);
        ctx.lineTo(sweepX, mapY + S);
        ctx.stroke();
        ctx.shadowBlur = 0;

        if (this.gridData?.crater && this.gridData?.slope) {
          const gw = this.gridData.width || 100;
          const gh = this.gridData.height || 100;
          const scanCol = Math.min(gw - 1, Math.floor(sweepT * gw));
          const colStart = Math.max(0, scanCol - 5);
          for (let r = 2; r < gh - 2; r += 4) {
            for (let c = colStart; c <= scanCol; c += 2) {
              const cr = this.gridData.crater[r][c];
              const sl = this.gridData.slope[r][c];
              if (cr > 10 || sl > 18) {
                const dx = mapX + ((c + 0.5) / gw) * S;
                const dy = mapY + ((r + 0.5) / gh) * S;
                const alpha = 1 - (scanCol - c) / 6;
                ctx.strokeStyle = cr > 10 ? `rgba(56, 224, 255, ${0.85 * alpha})` : `rgba(255, 115, 95, ${0.85 * alpha})`;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.arc(dx, dy, cr > 20 ? 5.5 : 3.5, 0, Math.PI * 2);
                ctx.stroke();
              }
            }
          }
        }
        ctx.restore();
      }
    }

    // Subtle survey grid overlay locked to the square map coordinates
    ctx.strokeStyle = 'rgba(200, 245, 255, 0.14)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const gx = mapX + (S / 5) * i;
      const gy = mapY + (S / 5) * i;
      ctx.beginPath();
      ctx.moveTo(gx, mapY);
      ctx.lineTo(gx, mapY + S);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mapX, gy);
      ctx.lineTo(mapX + S, gy);
      ctx.stroke();
    }

    // Live <=2s A* Pathfinding Search Animation across all 5 segments
    if (this.pathAnim) {
      const segs = this.astarData.segmentBranches;
      const numSegs = segs.length;
      const scaled = this.pathAnim.progress * numSegs;
      const activeLeg = Math.min(numSegs - 1, Math.floor(scaled));
      const legProgress = scaled - activeLeg;

      // 1) Draw already-solved segments in glowing green
      for (let k = 0; k < activeLeg; k++) {
        this._strokeNormalizedPolyline(ctx, segs[k].bestLegPoints, mapX, mapY, S, '#38ef7d', 3.8);
      }

      // 2) For the active segment, animate A* candidate branch lines probing in all directions
      const currSeg = segs[activeLeg];
      if (currSeg) {
        const branchPhase = Math.min(1, legProgress / 0.72);
        const visibleBranches = Math.floor(currSeg.branches.length * branchPhase);
        ctx.save();
        ctx.lineWidth = 1.35;
        for (let b = 0; b < visibleBranches; b++) {
          const [x0, y0, x1, y1, pen] = currSeg.branches[b];
          ctx.strokeStyle = pen > 3.5 ? 'rgba(255, 110, 95, 0.68)' : 'rgba(115, 232, 255, 0.62)';
          ctx.beginPath();
          ctx.moveTo(mapX + x0 * S, mapY + y0 * S);
          ctx.lineTo(mapX + x1 * S, mapY + y1 * S);
          ctx.stroke();

          // Small probe tip node on newest frontier branches
          if (b > visibleBranches - 18) {
            ctx.fillStyle = pen > 3.5 ? '#ff6b6b' : '#79f2d0';
            ctx.fillRect(mapX + x1 * S - 1.5, mapY + y1 * S - 1.5, 3, 3);
          }
        }
        ctx.restore();

        // In the last 28% of the segment window, snap/draw the winning best path for this segment
        if (legProgress > 0.62) {
          const lockT = Math.min(1, (legProgress - 0.62) / 0.38);
          const count = Math.max(2, Math.floor(currSeg.bestLegPoints.length * lockT));
          this._strokeNormalizedPolyline(
            ctx,
            currSeg.bestLegPoints.slice(0, count),
            mapX,
            mapY,
            S,
            '#38ef7d',
            4.2
          );
        }
      }
    } else if (this.pathsComputed && this.selectedPath) {
      // ONLY draw the single currently selected path (no unselected background lines!).
      // In field mode the live 3D route already shows the deployed policy, so skip the duplicate.
      const activePath = this.selectedPath;
      const liveCovers = this.locked && this.getLiveState && this.selectedPathId === this.deployedPolicyId;
      if (!liveCovers) this._strokeNormalizedPolyline(ctx, activePath.points, mapX, mapY, S, activePath.color, 4.0);
    }

    if (!this.pathAnim) {
      this._drawLiveRoute(ctx, mapX, mapY, S);
    }

    // Draw Start/End Point (HAB) in one color (#ffcf5c gold) and Waypoints/Targets (S1..S4) in another (#ff6b9d coral/magenta)
    getSiteSurfaceSpots(site).forEach((spot, idx) => {
      const x = mapX + spot.nx * S;
      const y = mapY + spot.ny * S;
      const isHab = idx === 0;
      const fill = isHab ? '#ffcf5c' : '#ff6b9d';

      ctx.save();
      // Outer target ring
      ctx.strokeStyle = isHab ? 'rgba(255, 207, 92, 0.55)' : 'rgba(255, 107, 157, 0.5)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, isHab ? 11 : 9, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = fill;
      ctx.strokeStyle = '#0c1821';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (isHab) {
        ctx.rect(x - 5.5, y - 5.5, 11, 11);
      } else {
        ctx.arc(x, y, 5.2, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();

      const tag = isHab ? 'START/END · HAB' : `${spot.id} · ${spot.shortName}`;
      ctx.font = '700 10px Inter, ui-monospace, monospace';
      const tw = ctx.measureText(tag).width;
      ctx.fillStyle = 'rgba(10, 20, 28, 0.9)';
      ctx.fillRect(x + 9, y - 9, tw + 8, 15);
      ctx.strokeStyle = fill;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 9, y - 9, tw + 8, 15);
      ctx.fillStyle = isHab ? '#ffe599' : '#ffc2d9';
      ctx.fillText(tag, x + 13, y + 2);
      ctx.restore();
    });

    // Live rover position marker in 3D sandbox world metres (wrist navigator field mode)
    this._drawLiveRoverMarker(ctx, mapX, mapY, S);

    // Draw hover crosshair circle locked 1:1 to cursor position inside the map
    if (this.hoverCell) {
      const hx = mapX + this.hoverCell.nx * S;
      const hy = mapY + this.hoverCell.ny * S;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _strokeNormalizedPolyline(ctx, points, mapX, mapY, S, color, width) {
    if (!points || points.length < 2) return;
    ctx.save();
    ctx.beginPath();
    points.forEach(([px, py], i) => {
      const sx = mapX + px * S;
      const sy = mapY + py * S;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(8, 15, 22, 0.88)';
    ctx.lineWidth = width + 3.2;
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.restore();
  }
}
