import textureUrl from './terrain.png';
import ridgeUrl from './ridge.png';
import rockUrl from './rock.png';

// Synthetic development fixture: every image, position and measurement is invented.
export const site = {
  id: 'synthetic-development-fixture',
  name: 'Synthetic practice site',
  width: 9, height: 7, cellSizeM: 10,
  elevationM: Array.from({ length: 63 }, (_, i) => i % 9 === 4 && Math.floor(i / 9) >= 2 && Math.floor(i / 9) <= 4 ? 4 : 0),
  base: { col: 1, row: 3 },
  baseLabel: 'Fictional base',
  textureUrl,
  walkBudgetSeconds: 300,
  stationRadiusM: 10,
  stations: [
    { id: 'ridge', name: 'Ridge station', cell: { col: 7, row: 2 }, observationId: 'ridge-view', color: '#ffb75e' },
    { id: 'adjacent-rock', name: 'Adjacent rock', cell: { col: 7, row: 4 }, observationId: 'rock-view', color: '#b5b1ff' },
  ],
  observations: [
    { id: 'ridge-view', cell: { col: 7, row: 2 }, cameraCell: { col: 7, row: 2 }, characterizedCells: [{ col: 4, row: 2 }, { col: 4, row: 3 }], imageUrl: ridgeUrl, sourceId: 'synthetic-images', caption: 'Synthetic ridge sketch. View west from (7,2) toward the raised cells (4,2) and (4,3).' },
    { id: 'rock-view', cell: { col: 7, row: 4 }, cameraCell: { col: 7, row: 4 }, characterizedCells: [{ col: 7, row: 4 }], imageUrl: rockUrl, sourceId: 'synthetic-images', caption: 'Synthetic close-up rock sketch at (7,4). This view characterizes the rock at the camera cell.' },
    { id: 'overhead-view', cell: { col: 3, row: 3 }, characterizedCells: [{ col: 3, row: 3 }, { col: 4, row: 3 }, { col: 5, row: 3 }], imageUrl: textureUrl, sourceId: 'synthetic-grid', caption: 'Synthetic north-up grid illustration. The overhead view characterizes cells (3,3), (4,3) and (5,3).' },
  ],
  sources: [
    { id: 'synthetic-grid', productId: 'DEV-GRID-9x7', mission: 'Synthetic development fixture — no NASA mission', url: null, scale: '10 m per cell, invented elevations in metres', processingNote: '9 × 7 north-up grid. Column 4, rows 2–4 are 4 m high. All other cells are 0 m. The texture is a generated diagram.' },
    { id: 'synthetic-images', productId: 'DEV-SKETCHES-01', mission: 'Synthetic development fixture — no NASA mission', url: null, scale: 'Unscaled illustration', processingNote: 'Procedurally drawn ridge and rock placeholders. Camera cells and characterized cells are fictional and listed separately.' },
  ],
};

const cells = [
  [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [7, 2],
  [8, 2], [8, 3], [8, 4], [7, 4], [6, 4], [5, 4], [4, 4], [3, 4], [2, 4], [1, 4], [1, 3],
].map(([col, row]) => ({ col, row }));
const characterized = new Set(site.observations.flatMap(observation => observation.characterizedCells.map(cell => `${cell.col},${cell.row}`)));
export const route = {
  id: 'practice-round-trip', cells,
  orderedStationIds: ['ridge', 'adjacent-rock'],
  distanceM: (cells.length - 1) * site.cellSizeM,
  // Development metric: a leg has limited coverage if either endpoint lacks a characterized cell.
  limitedCoverageDistanceM: cells.slice(1).reduce((distance, cell, index) => distance +
    (characterized.has(`${cell.col},${cell.row}`) && characterized.has(`${cells[index].col},${cells[index].row}`) ? 0 : site.cellSizeM), 0),
};
