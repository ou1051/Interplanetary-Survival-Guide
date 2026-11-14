// ---------------------------------------------------------------------------
// Adapter: the Freelance Astronaut flow (game state, 3D world, route options)
// → the mission map module's contracts (src/map/contracts.ts).
//
// The flow works in local metres (+X east, −Z north, habitat at 0,0) with
// continuous route polylines. The map works on a grid of cells. This file is
// the only place the two meet; it is pure (no DOM), so it is unit-tested.
// ---------------------------------------------------------------------------

import { SCOUT_PINS, STATIONS, HAB, ASSIGNMENT, AREA_HAZARDS } from '../config/mission.js';
import { knownAreaHazards, unscoutedDistance } from '../sim/game.js';

export const CELL_M = 25;

/** Grid geometry over the route-map bounds (row 0 = north edge). */
export function makeGrid(bounds, cellM = CELL_M) {
  const width = Math.ceil((bounds.x1 - bounds.x0) / cellM);
  const height = Math.ceil((bounds.z1 - bounds.z0) / cellM);
  const clampCell = (c) => ({ col: Math.min(width - 1, Math.max(0, c.col)), row: Math.min(height - 1, Math.max(0, c.row)) });
  return {
    width,
    height,
    cellM,
    x0: bounds.x0,
    z0: bounds.z0,
    toCell: (x, z) => clampCell({ col: Math.floor((x - bounds.x0) / cellM), row: Math.floor((z - bounds.z0) / cellM) }),
    centre: (c) => [bounds.x0 + (c.col + 0.5) * cellM, bounds.z0 + (c.row + 0.5) * cellM],
    middle: [bounds.x0 + (width * cellM) / 2, bounds.z0 + (height * cellM) / 2],
  };
}

/** Cells whose centre lies within `radius` metres of (x, z). */
export function cellsWithin(grid, x, z, radius) {
  const out = [];
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const [cx, cz] = grid.centre({ col, row });
      if (Math.hypot(cx - x, cz - z) <= radius) out.push({ col, row });
    }
  }
  return out;
}

/** A route polyline as the ordered list of cells it passes through (no repeats in a row). */
export function routeCells(grid, route) {
  const cells = [];
  const every = Math.max(1, Math.round(grid.cellM / 3 / route.step));
  for (let i = 0; i < route.count; i += every) {
    const c = grid.toCell(route.x[i], route.z[i]);
    const last = cells[cells.length - 1];
    if (!last || last.col !== c.col || last.row !== c.row) cells.push(c);
  }
  const end = grid.toCell(route.x[route.count - 1], route.z[route.count - 1]);
  const last = cells[cells.length - 1];
  if (last.col !== end.col || last.row !== end.row) cells.push(end);
  return cells;
}

/** The route polyline in fractional cell coordinates (a smooth line for drawing). */
export function routePath(grid, route, everyM = 4) {
  const every = Math.max(1, Math.round(everyM / route.step));
  const out = [];
  const at = (i) => ({ col: (route.x[i] - grid.x0) / grid.cellM - 0.5, row: (route.z[i] - grid.z0) / grid.cellM - 0.5 });
  for (let i = 0; i < route.count; i += every) out.push(at(i));
  out.push(at(route.count - 1));
  return out;
}

/**
 * The site: grid elevations from the rehearsal terrain, habitat, stations and
 * scouting sites. `geo` places the grid centre on Mars (real imagery backdrop).
 */
export function buildSite({ grid, heightAt, toLonLat, snapshots = {} }) {
  const elevationM = [];
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) elevationM.push(+heightAt(...grid.centre({ col, row })).toFixed(2));
  }
  const [lon, lat] = toLonLat(...grid.middle);
  return {
    id: 'vera-rubin-rehearsal',
    name: 'Vera Rubin Ridge (rehearsal terrain)',
    synthetic: true,
    width: grid.width,
    height: grid.height,
    cellSizeM: grid.cellM,
    elevationM,
    base: grid.toCell(HAB.x, HAB.z),
    textureUrl: '',
    walkBudgetSeconds: 8 * 3600,
    stationRadiusM: grid.cellM,
    terrainSourceId: 'src-terrain',
    geo: { lat, lon },
    assignment: { title: ASSIGNMENT.title.replace(/^First assignment · /, ''), question: ASSIGNMENT.brief, client: ASSIGNMENT.client },
    stations: STATIONS.map((s) => ({ id: s.id, name: s.name, cell: grid.toCell(...s.at), task: s.objective })),
    observations: SCOUT_PINS.map((p) => {
      const hazards = p.reveals.map((id) => AREA_HAZARDS.find((h) => h.id === id)?.type).filter(Boolean);
      return {
        id: p.id,
        title: p.name,
        cell: grid.toCell(...p.at),
        cameraCell: grid.toCell(...p.camera),
        imageUrl: snapshots[p.id] ?? '',
        caption: `${p.finding}${hazards.length ? ` Revealed hazard: ${hazards.join(', ').toLowerCase()}.` : ''}`,
        sourceId: 'src-ground-view',
        characterizedCells: cellsWithin(grid, p.at[0], p.at[1], p.radius),
      };
    }),
    sources: [
      {
        id: 'src-terrain',
        productId: 'REHEARSAL-TERRAIN',
        mission: 'None (procedural rehearsal terrain)',
        url: '',
        scale: `${grid.cellM} m / cell`,
        processingNote: 'Sampled from the 3D rehearsal terrain; placeholder until real Gale elevation is connected.',
        kind: 'synthetic',
      },
      {
        id: 'src-ground-view',
        productId: 'SIMULATED-GROUND-VIEW',
        mission: 'Simulated (rendered from the rehearsal terrain)',
        url: '',
        scale: 'n/a',
        processingNote: 'Placeholder for rover imagery of the site.',
        kind: 'simulated',
      },
    ],
  };
}

/** Route options → RoutePlan[] (cells, measures, consumables, hazard gates). */
export function buildRoutePlans({ grid, routes, options, revealed, estimate }) {
  return options
    .filter((o) => routes[o.id])
    .map((o) => {
      const r = routes[o.id];
      const est = estimate(r);
      const slopeGates = r.zones.filter((z) => z.kind === 'slope' && z.severity === 'danger').length;
      return {
        id: o.id,
        label: o.name,
        badge: o.planner ? (o.planner.source === 'api' ? 'API' : 'Local') : undefined,
        cells: routeCells(grid, r),
        path: routePath(grid, r),
        distanceM: r.length,
        maxSegmentSlopeDeg: r.stats.maxTilt,
        limitedCoverageM: unscoutedDistance(r, revealed),
        stationIds: r.stations.filter((s) => !s.final).map((s) => s.id),
        comparison: o.note,
        estimates: { oxygenMinutes: est.oxygenMinutes, batteryWh: est.batteryWh, hazardGates: slopeGates + knownAreaHazards(r, revealed).length },
      };
    });
}

/** Game state → MapInput. */
export function buildMapInput({ game, plans }) {
  const run = game.run;
  const sc = game.scenario;
  const windows = sc.windows.map((w) => ({ id: w.id, label: w.label, lastOpenTurn: w.lastOpenTurn }));
  const approval = game.approval();
  const r = run.rehearsal;
  const stationIds = STATIONS.map((s) => s.id);
  return {
    run: {
      turn: run.turn,
      revealedObservationIds: [...run.revealed],
      waypoints: [],
      stationOrder: plans.find((p) => p.id === run.routeId)?.stationIds ?? stationIds,
      selectedRouteId: plans.some((p) => p.id === run.routeId) ? run.routeId : null,
      planRevision: run.planRevision,
      rehearsalWindowId: run.rehearsalWindowId,
      latestRehearsal: r
        ? {
            planRevision: r.planRevision,
            windowId: r.windowId,
            visibility: r.visibility,
            observedStationIds: stationIds.slice(0, r.stationsDone),
            returnedToBase: !!r.returned,
            elapsedSeconds: r.met ?? 0,
            distanceWalkedM: r.distance ?? 0,
          }
        : null,
      surfaceApproved: approval.ok,
      scenarioId: run.scenarioId,
    },
    routes: plans,
    windows,
    clock: {
      turnAfter: (cost) => run.turn + cost,
      closingAt: (turn) => windows.filter((w) => run.turn <= w.lastOpenTurn && turn > w.lastOpenTurn),
    },
    rehearsalAvailable: true,
    approval: { ok: approval.ok, reason: approval.reasons[0] },
    launchDesk: true,
    rehearsal: {
      selectedId: run.rehearsalWindowId,
      options: sc.windows.map((w) => ({ id: w.id, label: w.id, detail: game.forecast(w).walk.visibility, disabled: !game.isOpen(w) })),
    },
  };
}

/** Map action → game flow. Returns what the host should do next (or null). */
export function applyMapAction(action, { game, routes, options }) {
  switch (action.type) {
    case 'scout':
      game.scout(action.observationId, routes);
      return null;
    case 'chooseRoute': {
      const o = options.find((x) => x.id === action.routeId);
      if (o) game.chooseRoute(o.id, o.name);
      return null;
    }
    case 'setRehearsalWindow':
      game.setRehearsalWindow(action.windowId);
      return null;
    case 'startRehearsal':
      return 'rehearse';
    case 'openLaunchDesk':
      return 'desk';
    default:
      return null; // waypoints / station order: the flow's planner fixes them
  }
}
