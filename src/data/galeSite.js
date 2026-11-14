import raster from './gale/elevation.json';
import orbital from './gale/orbital.jpg?inline';
import mastcam from './gale/mastcam.jpg?inline';
import { planRoute } from '../routes/pathfinding.js';
import { evaBudget } from '../physics/traverse.js';
import { SLOPE_CLASSES } from '../config/mission.js';

export const imagery = { orbital, mastcam };
export const terrainSource = 'https://www.uahirise.org/dtm/dtm.php?ID=PSP_009149_1750';
export const observationSource = 'https://science.nasa.gov/photojournal/looking-up-at-layers-of-vera-rubin-ridge-on-sol-1790/';
export const siteWidth = raster.size * raster.step;
export const base = { col: 65, row: 35 };
export const outcrop = { col: 59, row: 47 };
export const sampleMinutes = 20;

// Align the DEM, planner nodes and 3D scene to the centres of the raster pixels.
export function heightAtGale(gridX, gridZ) {
  const x = Math.max(0, Math.min(raster.size - 1, gridX / raster.step + raster.size / 2 - 0.5));
  const z = Math.max(0, Math.min(raster.size - 1, gridZ / raster.step + raster.size / 2 - 0.5));
  const ix = Math.min(Math.floor(x), raster.size - 2);
  const iz = Math.min(Math.floor(z), raster.size - 2);
  const dx = x - ix, dz = z - iz;
  const row = iz * raster.size + ix;
  const h = raster.heights;
  if (dx + dz <= 1) return h[row] + dx * (h[row + 1] - h[row]) + dz * (h[row + raster.size] - h[row]);
  const far = row + raster.size + 1;
  return h[far] + (1 - dx) * (h[far - 1] - h[far]) + (1 - dz) * (h[far - raster.size] - h[far]);
}

export function terrainSlope(x, z) {
  const step = raster.step;
  return Math.atan(Math.hypot(heightAtGale(x + step, z) - heightAtGale(x - step, z),
    heightAtGale(x, z + step) - heightAtGale(x, z - step)) / (2 * step)) * 180 / Math.PI;
}

const gridSize = raster.size / 2;
const cellSizeM = raster.step * 2;
export const gridPosition = ({ col, row }) => [col * cellSizeM - siteWidth / 2 + raster.step / 2,
  row * cellSizeM - siteWidth / 2 + raster.step / 2];
const [baseX, baseZ] = gridPosition(base);
export const worldPosition = (cell) => {
  const [x, z] = gridPosition(cell);
  return [x - baseX, z - baseZ];
};
export const missionHeight = (x, z) => heightAtGale(x + baseX, z + baseZ);
export const heightGrid = { cx: raster.step / 2 - baseX, cz: raster.step / 2 - baseZ,
  size: siteWidth, segments: raster.size };
const slopeAtCell = (cell) => terrainSlope(...gridPosition(cell));

export function planGaleRoutes(start = base, target = outcrop) {
  const cells = Array.from({ length: gridSize ** 2 }, (_, i) => ({ col: i % gridSize, row: Math.floor(i / gridSize) }));
  const slopes = cells.map(slopeAtCell);
  const grid = { width: gridSize, height: gridSize, cellSizeM,
    elevationM: cells.map(cell => heightAtGale(...gridPosition(cell))) };
  // Never plan the recommended route through ground the rover classes as danger.
  const gentler = { ...grid, blockedCells: cells.filter((_, i) => slopes[i] >= SLOPE_CLASSES.danger),
    hazardCost: slopes.map(slope => (slope / 10) ** 3) };

  return [['recommended', gentler, 'time'], ['shortest', grid, 'distance']].flatMap(([id, input, policy]) => {
    const outbound = planRoute(input, start, target, policy);
    if (!outbound) return [];
    const path = outbound.path;
    const surfaceSlope = Math.max(...path.map(slopeAtCell));
    const budget = evaBudget({ driveSeconds: outbound.durationSeconds * 2, workMinutes: sampleMinutes });
    return [{ id, path, points: [...path, ...path.slice(0, -1).reverse()].map(worldPosition),
      distanceM: outbound.distanceM * 2, surfaceSlope, travel: budget.drive,
      returnOxygen: budget.remaining }];
  });
}
