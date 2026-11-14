import type { Cell, RoutePlan, Site } from '../contracts';
import { cellKey, elevationAt, isMapped } from '../grid';

// ---------------------------------------------------------------------------
// The demo compares two round-trip policies. The routing API plans one leg at a time.
// ---------------------------------------------------------------------------

type Policy = 'distance' | 'terrain';

const STEPS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function coveredCells(site: Site, revealedIds: string[]): Set<string> {
  const s = new Set<string>();
  for (const o of site.observations) if (revealedIds.includes(o.id)) o.characterizedCells.forEach((c) => s.add(cellKey(c)));
  return s;
}

function leg(site: Site, from: Cell, to: Cell, policy: Policy, covered: Set<string>): Cell[] | null {
  if (!isMapped(site, from) || !isMapped(site, to)) return null;
  const W = site.width;
  const idx = (c: Cell) => c.row * W + c.col;
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const open: { i: number; d: number }[] = [{ i: idx(from), d: 0 }];
  dist.set(idx(from), 0);
  while (open.length) {
    open.sort((a, b) => a.d - b.d);
    const { i, d } = open.shift()!;
    if (i === idx(to)) break;
    if (d > (dist.get(i) ?? Infinity)) continue;
    const c = { col: i % W, row: Math.floor(i / W) };
    for (const [dc, dr] of STEPS) {
      const n = { col: c.col + dc, row: c.row + dr };
      if (!isMapped(site, n)) continue;
      const run = Math.hypot(dc, dr) * site.cellSizeM;
      let cost = run;
      if (policy === 'terrain') {
        const rise = Math.abs(elevationAt(site, n)! - elevationAt(site, c)!);
        const slope = (Math.atan(rise / run) * 180) / Math.PI;
        cost = run * (1 + slope / 6) + (covered.has(cellKey(n)) ? 0 : run * 0.25);
      }
      const nd = d + cost;
      const ni = idx(n);
      if (nd < (dist.get(ni) ?? Infinity) - 1e-9) {
        dist.set(ni, nd);
        prev.set(ni, i);
        open.push({ i: ni, d: nd });
      }
    }
  }
  if (!dist.has(idx(to))) return null;
  const path: Cell[] = [];
  let cur: number | undefined = idx(to);
  while (cur !== undefined) {
    path.unshift({ col: cur % W, row: Math.floor(cur / W) });
    cur = prev.get(cur);
  }
  return path;
}

function measure(site: Site, cells: Cell[], covered: Set<string>) {
  let distanceM = 0;
  let maxSlope = 0;
  let limited = 0;
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1];
    const b = cells[i];
    const run = Math.hypot(b.col - a.col, b.row - a.row) * site.cellSizeM;
    if (!run) continue;
    distanceM += run;
    const rise = Math.abs(elevationAt(site, b)! - elevationAt(site, a)!);
    maxSlope = Math.max(maxSlope, (Math.atan(rise / run) * 180) / Math.PI);
    if (!covered.has(cellKey(b))) limited += run;
  }
  return { distanceM, maxSlope, limited };
}

export function standInPlanRoutes(site: Site, waypoints: Cell[], orderedStationIds: string[], revealedIds: string[]): RoutePlan[] {
  const covered = coveredCells(site, revealedIds);
  const stations = orderedStationIds.map((id) => site.stations.find((s) => s.id === id)!).filter(Boolean);
  const stops = [site.base, ...waypoints, ...stations.map((s) => s.cell), site.base];
  const plans: RoutePlan[] = [];
  for (const policy of ['distance', 'terrain'] as Policy[]) {
    const cells: Cell[] = [];
    for (let i = 1; i < stops.length; i++) {
      const part = leg(site, stops[i - 1], stops[i], policy, covered);
      if (!part) return [];
      cells.push(...(cells.length ? part.slice(1) : part));
    }
    const m = measure(site, cells, covered);
    plans.push({
      id: `route-${policy}`,
      policy,
      cells,
      distanceM: m.distanceM,
      maxSegmentSlopeDeg: m.maxSlope,
      limitedCoverageM: m.limited,
      stationIds: stations.map((s) => s.id),
      comparison: policy === 'distance' ? 'Fewest metres from base and back.' : 'Avoids steep steps and unscouted cells where it can.',
    });
  }
  const [a, b] = plans;
  if (a.cells.map(cellKey).join() === b.cells.map(cellKey).join()) {
    return [{ ...a, id: 'route-shared', policy: undefined, label: 'Shared route', comparison: 'Both policies choose the same path.' }];
  }
  return plans;
}
