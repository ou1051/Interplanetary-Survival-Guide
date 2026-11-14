import { planRoute } from '../routes/pathfinding.js';
import type { Cell, RoutePlan, Site } from './contracts';
import { cellKey } from './grid';

/** Compose shared rover-planner legs into the map's two round-trip policies. */
export function planRoutes(site: Site, waypoints: Cell[], orderedStationIds: string[], revealedIds: string[]): RoutePlan[] {
  const stations = orderedStationIds.map(id => site.stations.find(station => station.id === id));
  if (stations.some(station => !station)) return [];
  const covered = new Set(site.observations.filter(observation => revealedIds.includes(observation.id))
    .flatMap(observation => observation.characterizedCells.map(cellKey)));
  const stops = [site.base, ...waypoints, ...stations.map(station => station!.cell), site.base];
  // Uncharacterized cells carry a 25% travel-time surcharge, never extra physical distance.
  const hazardCost = site.elevationM.map((_, i) => covered.has(cellKey({ col: i % site.width, row: Math.floor(i / site.width) })) ? 0 : 0.25);
  const routes: RoutePlan[] = [];
  for (const policy of ['distance', 'terrain'] as const) {
    const route: RoutePlan = {
      id: `route-${policy}`, policy, cells: [], distanceM: 0, maxSegmentSlopeDeg: 0, limitedCoverageM: 0,
      stationIds: orderedStationIds.slice(),
      comparison: policy === 'distance' ? 'Fewest surface metres from base and back.' : 'Balances rover travel time with limited observation coverage.',
    };
    for (let i = 1; i < stops.length; i++) {
      const leg = planRoute({ ...site, hazardCost }, stops[i - 1], stops[i], policy === 'distance' ? 'distance' : 'time');
      if (!leg) return [];
      route.cells.push(...(route.cells.length ? leg.path.slice(1) : leg.path));
      route.distanceM += leg.distanceM;
      route.maxSegmentSlopeDeg = Math.max(route.maxSegmentSlopeDeg, leg.maxSlopeDeg);
      for (let j = 1; j < leg.path.length; j++) {
        const from = leg.path[j - 1];
        const to = leg.path[j];
        if (!covered.has(cellKey(to))) route.limitedCoverageM += Math.hypot(
          Math.hypot(to.col - from.col, to.row - from.row) * site.cellSizeM,
          site.elevationM[to.row * site.width + to.col]! - site.elevationM[from.row * site.width + from.col]!,
        );
      }
    }
    routes.push(route);
  }
  const [shortest, terrain] = routes;
  return shortest.cells.map(cellKey).join() === terrain.cells.map(cellKey).join()
    ? [{ ...shortest, id: 'route-shared', policy: undefined, label: 'Shared route', comparison: 'Both policies choose the same path.' }]
    : routes;
}
