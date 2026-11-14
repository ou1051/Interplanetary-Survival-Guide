import { ROVER } from '../config/mission.js';
import { segmentEstimate } from '../physics/traverse.js';

class MinHeap {
  items = [];

  push(item) {
    const items = this.items;
    let index = items.length;
    items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].priority <= item.priority) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  pop() {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (items.length) {
      let index = 0;
      while (index * 2 + 1 < items.length) {
        let child = index * 2 + 1;
        if (child + 1 < items.length && items[child + 1].priority < items[child].priority) child++;
        if (last.priority <= items[child].priority) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
    }
    return first;
  }
}

export function planRoute(grid, start, goal) {
  const { width, height, cellSizeM, elevationM, hazardCost } = grid;
  const blocked = new Set((grid.blockedCells ?? []).map(cell => cell.row * width + cell.col));
  const mapped = (col, row) => col >= 0 && row >= 0 && col < width && row < height &&
    elevationM[row * width + col] !== null && !blocked.has(row * width + col);
  if (!mapped(start.col, start.row) || !mapped(goal.col, goal.row)) return null;

  const startId = start.row * width + start.col;
  const goalId = goal.row * width + goal.col;
  const costs = new Float64Array(width * height).fill(Infinity);
  const previous = new Int32Array(width * height).fill(-1);
  const heuristic = (col, row) => {
    const dx = Math.abs(goal.col - col);
    const dz = Math.abs(goal.row - row);
    return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * cellSizeM / ROVER.maxSpeed;
  };
  const open = new MinHeap();
  costs[startId] = 0;
  open.push({ id: startId, cost: 0, priority: heuristic(start.col, start.row) });

  while (open.items.length) {
    const current = open.pop();
    if (current.cost !== costs[current.id]) continue;
    if (current.id === goalId) {
      const path = [];
      for (let id = goalId; id !== -1; id = previous[id]) path.push({ col: id % width, row: Math.floor(id / width) });
      path.reverse();
      const result = { path, distanceM: 0, durationSeconds: 0, oxygenMinutes: 0, batteryWh: 0, maxSlopeDeg: 0 };
      for (let i = 1; i < path.length; i++) {
        const from = path[i - 1];
        const to = path[i];
        const segment = segmentEstimate(Math.hypot(to.col - from.col, to.row - from.row) * cellSizeM,
          elevationM[to.row * width + to.col] - elevationM[from.row * width + from.col]);
        result.distanceM += segment.distanceM;
        result.durationSeconds += segment.durationSeconds;
        result.oxygenMinutes += segment.oxygenMinutes;
        result.batteryWh += segment.batteryWh;
        result.maxSlopeDeg = Math.max(result.maxSlopeDeg, segment.slopeDeg);
      }
      return result;
    }

    const col = current.id % width;
    const row = Math.floor(current.id / width);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if ((!dc && !dr) || !mapped(col + dc, row + dr)) continue;
        if (dc && dr && (!mapped(col + dc, row) || !mapped(col, row + dr))) continue;
        const id = (row + dr) * width + col + dc;
        const segment = segmentEstimate(Math.hypot(dc, dr) * cellSizeM, elevationM[id] - elevationM[current.id]);
        // Hazard surcharges affect route choice; resource totals remain physical estimates.
        const cost = current.cost + segment.durationSeconds * (1 + (hazardCost?.[id] ?? 0));
        if (cost >= costs[id]) continue;
        costs[id] = cost;
        previous[id] = current.id;
        open.push({ id, cost, priority: cost + heuristic(col + dc, row + dr) });
      }
    }
  }
  return null;
}

export function rerouteForHazard(grid, current, goal, liveHazard) {
  return planRoute({ ...grid, blockedCells: [...(grid.blockedCells ?? []), ...liveHazard.blockedCells] }, current, goal);
}
