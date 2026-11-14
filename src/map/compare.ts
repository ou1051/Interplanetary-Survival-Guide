import type { Cell, RoutePlan, Run, Site } from './contracts';
import type { Stop } from './grid';

// View models for the route comparison. No DOM here, so it is easy to test.

export interface RouteCard {
  id: string;
  label: string;
  distanceM: number;
  maxSlopeDeg: number;
  limitedM: number;
  comparison: string;
  selected: boolean;
  /** Which measures this route is best at (only when there is a real choice). */
  best: { distance: boolean; slope: boolean; coverage: boolean };
}

const POLICY_LABEL: Record<string, string> = {
  distance: 'Shortest',
  shortest: 'Shortest',
  terrain: 'Terrain-aware',
  'slope-coverage': 'Terrain-aware',
  safe: 'Terrain-aware',
};

export function routeLabel(route: RoutePlan, index: number): string {
  if (route.label) return route.label;
  if (route.policy && POLICY_LABEL[route.policy]) return POLICY_LABEL[route.policy];
  return `Route ${String.fromCharCode(65 + index)}`;
}

export function routeCards(routes: RoutePlan[], selectedId: string | null): RouteCard[] {
  const several = routes.length > 1;
  const min = (f: (r: RoutePlan) => number) => Math.min(...routes.map(f));
  const allEqual = (f: (r: RoutePlan) => number) => routes.every((r) => Math.abs(f(r) - f(routes[0])) < 1e-6);
  const flag = (r: RoutePlan, f: (r: RoutePlan) => number) => several && !allEqual(f) && Math.abs(f(r) - min(f)) < 1e-6;
  return routes.map((r, i) => ({
    id: r.id,
    label: routeLabel(r, i),
    distanceM: r.distanceM,
    maxSlopeDeg: r.maxSegmentSlopeDeg,
    limitedM: r.limitedCoverageM,
    comparison: r.comparison,
    selected: r.id === selectedId,
    best: {
      distance: flag(r, (x) => x.distanceM),
      slope: flag(r, (x) => x.maxSegmentSlopeDeg),
      coverage: flag(r, (x) => x.limitedCoverageM),
    },
  }));
}

/** Signature of a set of routes: geometry + the three measures. */
export function routesSignature(routes: RoutePlan[]): string {
  return routes
    .map((r) => `${r.cells.map((c) => `${c.col}.${c.row}`).join('-')}|${r.distanceM.toFixed(1)}|${r.maxSegmentSlopeDeg.toFixed(2)}|${r.limitedCoverageM.toFixed(1)}`)
    .sort()
    .join('#');
}

/**
 * When the comparison changes right after a new observation (and the player
 * did not edit the plan in between), return the observation that changed it.
 */
export function observationThatChanged(
  prev: { routes: RoutePlan[]; revealed: string[]; planKey: string } | null,
  next: { routes: RoutePlan[]; revealed: string[]; planKey: string },
): string | null {
  if (!prev || !prev.routes.length || !next.routes.length) return null;
  if (prev.planKey !== next.planKey) return null;
  const added = next.revealed.filter((id) => !prev.revealed.includes(id));
  if (!added.length) return null;
  if (routesSignature(prev.routes) === routesSignature(next.routes)) return null;
  return added[added.length - 1];
}

/** Key that changes whenever the player edits waypoints or station order. */
export function planKey(run: Pick<Run, 'waypoints' | 'stationOrder'>): string {
  return `${run.waypoints.map((w) => `${w.col},${w.row}`).join(';')}/${run.stationOrder.join(',')}`;
}

/** Required stops of the current plan, in visiting order. */
export function planStops(site: Site, run: Pick<Run, 'waypoints' | 'stationOrder'>): Stop[] {
  const stations = run.stationOrder
    .map((id) => site.stations.find((s) => s.id === id))
    .filter((s): s is Site['stations'][number] => !!s)
    .map((s) => ({ id: s.id, label: s.name, cell: s.cell, kind: 'station' as const }));
  const waypoints = run.waypoints.map((w, i) => ({ id: `wp-${i + 1}`, label: `Waypoint ${i + 1}`, cell: w, kind: 'waypoint' as const }));
  return [...waypoints, ...stations];
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export function formatSlope(deg: number): string {
  return Number.isFinite(deg) ? `${deg.toFixed(1)}°` : '—';
}

/** Move an item inside a list (used for station order / waypoints). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list.slice();
  const copy = list.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

export function replaceAt(list: Cell[], index: number, cell: Cell): Cell[] {
  return list.map((c, i) => (i === index ? { col: cell.col, row: cell.row } : c));
}
