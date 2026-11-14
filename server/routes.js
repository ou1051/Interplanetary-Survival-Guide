import { planRoute, rerouteForHazard } from '../src/routes/pathfinding.js';
import costMatrix from '../public/cost_matrix.json' with { type: 'json' };

function inputError(body, reroute) {
  const grid = body?.grid;
  if (!Number.isSafeInteger(grid?.width) || grid.width < 1 ||
      !Number.isSafeInteger(grid.height) || grid.height < 1 ||
      !Number.isFinite(grid.cellSizeM) || grid.cellSizeM <= 0) {
    return 'grid requires positive integer width and height and positive cellSizeM.';
  }
  const size = grid.width * grid.height;
  if (!Array.isArray(grid.elevationM) || grid.elevationM.length !== size ||
      !grid.elevationM.every(h => h === null || Number.isFinite(h))) {
    return 'grid.elevationM must contain one elevation in metres or null per cell, in row-major order.';
  }
  if (grid.hazardCost !== undefined && (!Array.isArray(grid.hazardCost) || grid.hazardCost.length !== size ||
      !grid.hazardCost.every(cost => Number.isFinite(cost) && cost >= 0))) {
    return 'grid.hazardCost must contain one nonnegative surcharge per cell.';
  }
  const inBounds = cell => Number.isInteger(cell?.col) && Number.isInteger(cell.row) &&
    cell.col >= 0 && cell.col < grid.width && cell.row >= 0 && cell.row < grid.height;
  if (grid.blockedCells !== undefined && (!Array.isArray(grid.blockedCells) || !grid.blockedCells.every(inBounds))) {
    return 'grid.blockedCells must be an array of cells inside the grid.';
  }
  const from = reroute ? 'current' : 'start';
  if (!inBounds(body[from]) || !inBounds(body.goal)) return from + ' and goal must be cells inside the grid.';
  if (reroute && (!Array.isArray(body.liveHazard?.blockedCells) || !body.liveHazard.blockedCells.every(inBounds))) {
    return 'liveHazard.blockedCells must be an array of cells inside the grid.';
  }
}

export async function routeApi(req, res, next) {
  const path = req.url.split('?')[0];
  if (path !== '/api/route' && path !== '/api/reroute' && path !== '/api/route-data') return next();
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(405, { error: 'method_not_allowed' });
  }
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return send(415, { error: 'expected_json' });
  }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) return send(413, { error: 'body_too_large' });
      chunks.push(chunk);
    }
  } catch {
    if (!res.destroyed) send(400, { error: 'incomplete_request' });
    return;
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(400, { error: 'invalid_json' });
  }
  if (path === '/api/route-data') {
    const inBounds = pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isInteger) &&
      pair[0] >= 0 && pair[0] < costMatrix.width && pair[1] >= 0 && pair[1] < costMatrix.height;
    if (!inBounds(body?.start) || !inBounds(body?.end)) {
      return send(400, { error: 'invalid_request', message: 'start and end must be [col, row] pairs inside the cost matrix.' });
    }
    const [col, row] = body.start;
    const [endCol, endRow] = body.end;
    const route = planRoute(costMatrix, { col, row }, { col: endCol, row: endRow });
    if (!route) return send(422, { error: 'no_route' });
    const cells = route.path.map(cell => [cell.col, cell.row]);
    const warnings = new Set();
    for (const [x, y] of cells) {
      const label = costMatrix.hazardLabels?.[`${x},${y}`];
      if (label) warnings.add(label);
    }
    return send(200, {
      path: cells,
      oxygen_cost: route.oxygenMinutes,
      battery_drain: route.batteryWh,
      hazard_warnings: [...warnings],
    });
  }
  const reroute = path === '/api/reroute';
  const message = inputError(body, reroute);
  if (message) return send(400, { error: 'invalid_request', message });
  const route = reroute
    ? rerouteForHazard(body.grid, body.current, body.goal, body.liveHazard)
    : planRoute(body.grid, body.start, body.goal);
  return route ? send(200, route) : send(422, { error: 'no_route' });
}
