// Each mapped cell owns its square footprint. Fans preserve cell-center heights,
// including narrow mapped corridors beside missing data.
function elevation(site, col, row) {
  if (col < 0 || row < 0 || col >= site.width || row >= site.height) return null;
  return site.elevationM[row * site.width + col];
}

function corners(site, col, row) {
  return [[0, 0], [0, 1], [1, 1], [1, 0]].map(([dx, dz]) => {
    let sum = 0;
    let count = 0;
    for (let r = row + dz - 1; r <= row + dz; r++) {
      for (let c = col + dx - 1; c <= col + dx; c++) {
        const h = elevation(site, c, r);
        if (h !== null) { sum += h; count++; }
      }
    }
    return sum / count;
  });
}

export function terrainGeometry(site) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let row = 0; row < site.height; row++) {
    for (let col = 0; col < site.width; col++) {
      const h = elevation(site, col, row);
      if (h === null) continue;
      const first = positions.length / 3;
      const heights = corners(site, col, row);
      const vertices = [[col, row, h], ...[[-.5, -.5], [-.5, .5], [.5, .5], [.5, -.5]].map(([dx, dz], i) => [col + dx, row + dz, heights[i]])];
      for (const [c, r, y] of vertices) {
        positions.push(c * site.cellSizeM, y, r * site.cellSizeM);
        uvs.push((c + .5) / site.width, 1 - (r + .5) / site.height);
      }
      for (let i = 0; i < 4; i++) indices.push(first, first + 1 + i, first + 1 + (i + 1) % 4);
    }
  }
  return { positions, uvs, indices };
}

export function heightAt(site, x, z) {
  const c = x / site.cellSizeM;
  const r = z / site.cellSizeM;
  const col = Math.floor(c + .5);
  const row = Math.floor(r + .5);
  const center = elevation(site, col, row);
  if (center === null) return null;
  const dx = c - col;
  const dz = r - row;
  const amount = 2 * Math.max(Math.abs(dx), Math.abs(dz));
  if (amount === 0) return center;
  const [nw, sw, se, ne] = corners(site, col, row);
  let edge;
  if (Math.abs(dx) > Math.abs(dz)) {
    const t = dz / amount + .5;
    edge = dx < 0 ? nw + (sw - nw) * t : ne + (se - ne) * t;
  } else {
    const t = dx / amount + .5;
    edge = dz < 0 ? nw + (ne - nw) * t : sw + (se - sw) * t;
  }
  return center + (edge - center) * amount;
}

function clearSegment(site, x, z, nextX, nextZ) {
  const times = [0, 1];
  // Split at every cell boundary so even a long frame cannot jump a hole.
  for (const [from, to] of [[x, nextX], [z, nextZ]]) {
    if (from === to) continue;
    const low = Math.min(from, to) / site.cellSizeM;
    const high = Math.max(from, to) / site.cellSizeM;
    for (let edge = Math.ceil(low - .5) + .5; edge <= high; edge++) {
      const t = (edge * site.cellSizeM - from) / (to - from);
      if (t > 0 && t < 1) times.push(t);
    }
  }
  times.sort((a, b) => a - b);
  let previousCol = Math.floor(x / site.cellSizeM + .5);
  let previousRow = Math.floor(z / site.cellSizeM + .5);
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < 1e-12) continue;
    const t = (times[i] + times[i - 1]) / 2;
    const col = Math.floor((x + (nextX - x) * t) / site.cellSizeM + .5);
    const row = Math.floor((z + (nextZ - z) * t) / site.cellSizeM + .5);
    if (elevation(site, col, row) === null) return false;
    if (col !== previousCol && row !== previousRow &&
      (elevation(site, col, previousRow) === null || elevation(site, previousCol, row) === null)) return false;
    previousCol = col;
    previousRow = row;
  }
  const col = Math.floor(nextX / site.cellSizeM + .5);
  const row = Math.floor(nextZ / site.cellSizeM + .5);
  if (col !== previousCol && row !== previousRow &&
    (elevation(site, col, previousRow) === null || elevation(site, previousCol, row) === null)) return false;
  return heightAt(site, nextX, nextZ) !== null;
}

export function createWalk({ site, route, planRevision, windowId, visibility }) {
  let leftBase = false;
  const walk = {
    x: site.base.col * site.cellSizeM,
    z: site.base.row * site.cellSizeM,
    elapsedSeconds: 0,
    distanceWalkedM: 0,
    observedStationIds: [],
    step(east, south, dt) {
      if (!Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(dt) || dt < 0) return;
      walk.elapsedSeconds += dt;
      const length = Math.hypot(east, south);
      if (!length || !dt) return;
      // Gameplay assumption: 1 m/s horizontal speed, independent of slope.
      const nextX = walk.x + east / length * dt;
      const nextZ = walk.z + south / length * dt;
      if (!clearSegment(site, walk.x, walk.z, nextX, nextZ)) return;
      walk.distanceWalkedM += Math.hypot(nextX - walk.x, nextZ - walk.z);
      walk.x = nextX;
      walk.z = nextZ;
      if (!walk.nearby(site.base)) leftBase = true;
    },
    nearby(cell) {
      return Math.hypot(walk.x - cell.col * site.cellSizeM, walk.z - cell.row * site.cellSizeM) <= site.stationRadiusM;
    },
    record(stationId) {
      const station = site.stations.find(station => station.id === stationId);
      if (!station || !route.stationIds.includes(stationId) || !walk.nearby(station.cell)) return false;
      if (!walk.observedStationIds.includes(stationId)) walk.observedStationIds.push(stationId);
      return true;
    },
    result() {
      return { planRevision, windowId, visibility, observedStationIds: [...walk.observedStationIds],
        returnedToBase: leftBase && walk.nearby(site.base), elapsedSeconds: walk.elapsedSeconds, distanceWalkedM: walk.distanceWalkedM };
    },
  };
  return walk;
}
