import { planRoute } from '../routes/pathfinding.js';
import { segmentEstimate } from '../physics/traverse.js';
import { AREA_HAZARDS, SCOUT_PINS, STATIONS } from '../config/mission.js';

// ---------------------------------------------------------------------------
// Bridge to the team's routing API (server/routes.js → POST /api/route).
//
// The 3D terrain is sampled into the API's grid format (10 m cells, columns
// east, rows south) and the round trip HAB → S1 → S2 → S3 → S4 → HAB is planned
// leg by leg. Known (scouted) area hazards get a large hazard surcharge and
// unscouted ground a small one, so scouting can change the planned route.
// If the API is not reachable (static build), the same A* runs in the browser.
// ---------------------------------------------------------------------------

export const GRID_CELL_M = 10;
const START = [0, -14]; // rover parking spot at the habitat, as for the other routes
const UNSCOUTED_COST = 0.35;
const KNOWN_HAZARD_COST = 4;

export function buildGrid(terrain, bounds, revealedIds) {
  const cs = GRID_CELL_M;
  const x0 = bounds.x0;
  const z0 = bounds.z0;
  const width = Math.ceil((bounds.x1 - bounds.x0) / cs) + 1;
  const height = Math.ceil((bounds.z1 - bounds.z0) / cs) + 1;
  const pins = SCOUT_PINS.filter((p) => revealedIds.includes(p.id));
  const known = new Set(pins.flatMap((p) => p.reveals));
  const hazards = AREA_HAZARDS.filter((h) => known.has(h.id));
  const elevationM = new Array(width * height);
  const hazardCost = new Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = x0 + col * cs;
      const z = z0 + row * cs;
      const i = row * width + col;
      elevationM[i] = +terrain.heightAt(x, z).toFixed(2);
      let cost = 0;
      const scouted = Math.hypot(x, z) < 90 || pins.some((p) => Math.hypot(x - p.at[0], z - p.at[1]) < p.radius);
      if (!scouted) cost += UNSCOUTED_COST;
      if (hazards.some((h) => Math.hypot(x - h.cx, z - h.cz) < h.radius)) cost += KNOWN_HAZARD_COST;
      hazardCost[i] = cost;
    }
  }
  const toCell = ([x, z]) => ({ col: Math.round((x - x0) / cs), row: Math.round((z - z0) / cs) });
  const toWorld = (c) => [x0 + c.col * cs, z0 + c.row * cs];
  return { grid: { width, height, cellSizeM: cs, elevationM, hazardCost }, toCell, toWorld };
}

async function apiLeg(grid, start, goal) {
  const res = await fetch('./api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grid, start, goal }),
  });
  if (res.status === 422) return null;
  if (!res.ok) throw new Error(`route API ${res.status}`);
  return res.json();
}

/**
 * Plan the planner round trip. Returns a ROUTE_OPTIONS-style entry
 * ({ id, name, note, points }) plus the API's own totals, or null if a stop
 * is unreachable.
 */
export async function planRoundTrip(terrain, bounds, revealedIds) {
  const { grid, toCell, toWorld } = buildGrid(terrain, bounds, revealedIds);
  const stops = [START, ...STATIONS.map((s) => s.at), START].map(toCell);
  let source = 'api';
  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    let leg;
    if (source === 'api') {
      try {
        leg = await apiLeg(grid, stops[i - 1], stops[i]);
      } catch {
        source = 'local';
      }
    }
    if (source === 'local') leg = planRoute(grid, stops[i - 1], stops[i]);
    if (!leg) return null;
    legs.push(leg);
  }
  const points = [];
  const totals = { distanceM: 0, durationSeconds: 0, oxygenMinutes: 0, batteryWh: 0, maxSlopeDeg: 0 };
  legs.forEach((leg, k) => {
    leg.path.forEach((c, j) => {
      if (k > 0 && j === 0) return;
      points.push(toWorld(c));
    });
    for (const key of ['distanceM', 'durationSeconds', 'oxygenMinutes', 'batteryWh']) totals[key] += leg[key];
    totals.maxSlopeDeg = Math.max(totals.maxSlopeDeg, leg.maxSlopeDeg);
  });
  points[0] = START;
  points[points.length - 1] = START;
  return {
    option: {
      id: 'planner',
      name: 'Planner route',
      note:
        source === 'api'
          ? 'Planned by the team route API (A*): fastest safe driving time, steering clear of known hazards and unscouted ground.'
          : 'Route API offline — same A* planner run in the browser: fastest driving time, avoiding known hazards and unscouted ground.',
      points: simplify(points),
      planner: { source, totals, legs: legs.length },
    },
  };
}

// Drop points that sit on a straight line, so the spline does not zig-zag.
function simplify(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, az] = out[out.length - 1];
    const [bx, bz] = points[i];
    const [cx, cz] = points[i + 1];
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(cross) > 1e-6) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Driving estimate for any route with the shared rover physics (same model as the API). */
export function estimateRoute(route) {
  const step = 4;
  const n = Math.max(1, Math.round(route.length / step));
  const t = { durationSeconds: 0, oxygenMinutes: 0, batteryWh: 0 };
  let prev = route.sample(0);
  let ph = route.terrain.heightAt(prev.x, prev.z);
  for (let i = 1; i <= n; i++) {
    const p = route.sample((i / n) * route.length);
    const h = route.terrain.heightAt(p.x, p.z);
    const seg = segmentEstimate(Math.hypot(p.x - prev.x, p.z - prev.z), h - ph);
    t.durationSeconds += seg.durationSeconds;
    t.oxygenMinutes += seg.oxygenMinutes;
    t.batteryWh += seg.batteryWh;
    prev = p;
    ph = h;
  }
  return t;
}

/** Route-map bounds, matching MapRenderer (route extent + 130 m). */
export function routeBounds(route, pad = 130) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < route.count; i++) {
    x0 = Math.min(x0, route.x[i]); x1 = Math.max(x1, route.x[i]);
    z0 = Math.min(z0, route.z[i]); z1 = Math.max(z1, route.z[i]);
  }
  return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
}
