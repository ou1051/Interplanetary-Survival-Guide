import type { Cell, Site } from './contracts';

// Pure grid helpers. Missing elevation stays `null` everywhere — a cell with no
// data is never treated as flat ground (plan review focus #1).

export const cellKey = (c: Cell): string => `${c.col},${c.row}`;
export const sameCell = (a: Cell | undefined | null, b: Cell | undefined | null): boolean =>
  !!a && !!b && a.col === b.col && a.row === b.row;

export function inBounds(site: Site, c: Cell): boolean {
  return Number.isInteger(c.col) && Number.isInteger(c.row) && c.col >= 0 && c.row >= 0 && c.col < site.width && c.row < site.height;
}

export function elevationAt(site: Site, c: Cell): number | null {
  if (!inBounds(site, c)) return null;
  const v = site.elevationM[c.row * site.width + c.col];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const isMapped = (site: Site, c: Cell): boolean => elevationAt(site, c) !== null;

/** North-up local metres of a cell centre (shared convention). */
export function cellToMeters(site: Site, c: Cell): { eastM: number; northM: number } {
  return { eastM: c.col * site.cellSizeM, northM: -c.row * site.cellSizeM };
}

/**
 * Slope of every cell in degrees (row-major), estimated from mapped neighbours.
 * Uses central differences where both neighbours exist, one-sided otherwise.
 * A cell with no data — or with no mapped neighbour on either axis — is null.
 */
export function slopeGrid(site: Site): (number | null)[] {
  const out: (number | null)[] = new Array(site.width * site.height).fill(null);
  const d = site.cellSizeM;
  const axis = (c: Cell, dc: number, dr: number): number | null => {
    const h = elevationAt(site, c);
    if (h === null) return null;
    const ha = elevationAt(site, { col: c.col - dc, row: c.row - dr });
    const hb = elevationAt(site, { col: c.col + dc, row: c.row + dr });
    if (ha !== null && hb !== null) return (hb - ha) / (2 * d);
    if (hb !== null) return (hb - h) / d;
    if (ha !== null) return (h - ha) / d;
    return null;
  };
  for (let row = 0; row < site.height; row++) {
    for (let col = 0; col < site.width; col++) {
      const c = { col, row };
      if (!isMapped(site, c)) continue;
      const gx = axis(c, 1, 0);
      const gy = axis(c, 0, 1);
      if (gx === null && gy === null) continue;
      out[row * site.width + col] = (Math.atan(Math.hypot(gx ?? 0, gy ?? 0)) * 180) / Math.PI;
    }
  }
  return out;
}

export type Connectivity = 4 | 8;

const NEIGHBOURS: Record<Connectivity, [number, number][]> = {
  4: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  8: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
};

/** Mapped cells reachable from `start` through mapped neighbours. */
export function reachableFrom(site: Site, start: Cell, connectivity: Connectivity = 8): Set<string> {
  const seen = new Set<string>();
  if (!isMapped(site, start)) return seen;
  const queue: Cell[] = [start];
  seen.add(cellKey(start));
  while (queue.length) {
    const c = queue.shift()!;
    for (const [dc, dr] of NEIGHBOURS[connectivity]) {
      const n = { col: c.col + dc, row: c.row + dr };
      const k = cellKey(n);
      if (!seen.has(k) && isMapped(site, n)) {
        seen.add(k);
        queue.push(n);
      }
    }
  }
  return seen;
}

export interface Stop {
  id: string;
  label: string;
  cell: Cell;
  kind: 'station' | 'waypoint';
}

/** Required stops that cannot be reached from base over mapped terrain. */
export function unreachableStops(site: Site, stops: Stop[], connectivity: Connectivity = 8): Stop[] {
  const reach = reachableFrom(site, site.base, connectivity);
  return stops.filter((s) => !reach.has(cellKey(s.cell)));
}

/** Clamp a cell into the grid. */
export function clampCell(site: Site, c: Cell): Cell {
  return {
    col: Math.min(site.width - 1, Math.max(0, Math.round(c.col))),
    row: Math.min(site.height - 1, Math.max(0, Math.round(c.row))),
  };
}
