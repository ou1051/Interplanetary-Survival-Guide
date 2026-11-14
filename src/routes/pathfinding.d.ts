interface Cell { col: number; row: number }
interface Grid {
  width: number;
  height: number;
  cellSizeM: number;
  elevationM: (number | null)[];
  hazardCost?: number[];
  blockedCells?: Cell[];
}
interface PlannedLeg {
  path: Cell[];
  distanceM: number;
  durationSeconds: number;
  oxygenMinutes: number;
  batteryWh: number;
  maxSlopeDeg: number;
}
export function planRoute(grid: Grid, start: Cell, goal: Cell, policy?: 'time' | 'distance'): PlannedLeg | null;
export function rerouteForHazard(grid: Grid, current: Cell, goal: Cell, liveHazard: { blockedCells: Cell[] }): PlannedLeg | null;
