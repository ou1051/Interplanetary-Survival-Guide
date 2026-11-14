import type { LaunchWindow, Run, Site } from '../contracts';

// ---------------------------------------------------------------------------
// SYNTHETIC DEVELOPMENT FIXTURE — no NASA data, no realism claims.
// Exactly the shared example from the implementation plan:
//   9 × 7 grid, 10 m cells, base (1,3), ridge station (7,2), rock station (7,4),
//   elevation 4 m in column 4 rows 2–4, 0 m elsewhere,
//   three scouting pins, two distinct image placeholders.
// Person 6 will publish the canonical copy in src/shared/; this one only
// exists so the map can be built and demonstrated now.
// ---------------------------------------------------------------------------

const W = 9;
const H = 7;

function elevation(): (number | null)[] {
  const e: (number | null)[] = [];
  for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) e.push(col === 4 && row >= 2 && row <= 4 ? 4 : 0);
  return e;
}

const svg = (body: string, w = 640, h = 400) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`,
  )}`;

const stamp = (y = 380) =>
  `<text x="20" y="${y}" font-family="monospace" font-size="15" fill="#3b2a20" opacity=".7">PLACEHOLDER SKETCH · SYNTHETIC</text>`;

// Image placeholder A: a ridge seen from below.
export const IMAGE_RIDGE = svg(`
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9b28c"/><stop offset="1" stop-color="#f0d6b8"/></linearGradient></defs>
  <rect width="640" height="400" fill="url(#s)"/>
  <path d="M0 250 L120 230 L210 170 L260 150 L330 160 L420 120 L500 150 L640 170 L640 400 L0 400Z" fill="#a4643f"/>
  <path d="M210 170 L260 150 L330 160 L420 120 L500 150" stroke="#6e3a22" stroke-width="5" fill="none"/>
  <path d="M0 300 L640 280 L640 400 L0 400Z" fill="#c07a4e"/>
  <g fill="#7b4a33"><ellipse cx="120" cy="330" rx="26" ry="10"/><ellipse cx="380" cy="350" rx="18" ry="7"/><ellipse cx="520" cy="320" rx="12" ry="5"/></g>
  ${stamp()}`);

// Image placeholder B: close view of layered bedrock.
export const IMAGE_BEDROCK = svg(`
  <rect width="640" height="400" fill="#c88a5f"/>
  <g stroke="#7a4630" stroke-width="3" fill="none">
    <path d="M0 90 Q160 70 320 95 T640 85"/><path d="M0 150 Q170 130 330 160 T640 145"/>
    <path d="M0 215 Q150 195 320 225 T640 210"/><path d="M0 280 Q160 265 330 290 T640 275"/>
  </g>
  <g stroke="#5c3322" stroke-width="2"><path d="M200 95 L190 160"/><path d="M430 150 L445 225"/><path d="M90 220 L100 285"/></g>
  <rect x="250" y="300" width="120" height="6" fill="#2b1d16"/><text x="250" y="325" font-family="monospace" font-size="13" fill="#2b1d16">≈ 10 cm (sketch)</text>
  ${stamp()}`);

// Orbital-image placeholder covering the grid extent (north-up).
export const TEXTURE = svg(
  `
  <defs>
    <radialGradient id="g" cx=".55" cy=".45" r=".8"><stop offset="0" stop-color="#c98a5e"/><stop offset="1" stop-color="#9d603f"/></radialGradient>
    <filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="3" seed="4"/><feColorMatrix values="0 0 0 0 .35  0 0 0 0 .2  0 0 0 0 .12  0 0 0 .45 0"/></filter>
  </defs>
  <rect width="900" height="700" fill="url(#g)"/>
  <rect width="900" height="700" filter="url(#n)"/>
  <rect x="400" y="200" width="100" height="300" fill="#7d4a31" opacity=".55"/>
  <rect x="400" y="200" width="16" height="300" fill="#e3b48b" opacity=".35"/>
  <g fill="#6b3d28" opacity=".55"><circle cx="640" cy="180" r="9"/><circle cx="700" cy="250" r="6"/><circle cx="660" cy="470" r="11"/><circle cx="250" cy="560" r="7"/></g>`,
  900,
  700,
);

export const SYNTHETIC_SITE: Site = {
  id: 'synthetic-ridge',
  name: 'Synthetic ridge (dev fixture)',
  synthetic: true,
  width: W,
  height: H,
  cellSizeM: 10,
  elevationM: elevation(),
  base: { col: 1, row: 3 },
  textureUrl: TEXTURE,
  walkBudgetSeconds: 300,
  stationRadiusM: 10,
  terrainSourceId: 'src-grid',
  assignment: {
    title: 'Ridge and bedrock contact',
    question: 'Bring home one observation of the ridge and one of the bedrock beside it.',
    client: 'Field office',
  },
  stations: [
    { id: 'st-ridge', name: 'Ridge', cell: { col: 7, row: 2 }, task: 'Record the ridge capping unit' },
    { id: 'st-rock', name: 'Bedrock', cell: { col: 7, row: 4 }, task: 'Record the adjacent bedrock' },
  ],
  observations: [
    {
      id: 'obs-ridge-view',
      title: 'Ridge from below',
      cell: { col: 6, row: 1 },
      cameraCell: { col: 5, row: 1 },
      imageUrl: IMAGE_RIDGE,
      caption: 'Placeholder sketch of the ridge seen from the west. The camera stood about one cell west of the pin; the pictured crest lies further east.',
      sourceId: 'src-sketch-a',
      characterizedCells: [{ col: 6, row: 1 }, { col: 6, row: 2 }, { col: 7, row: 1 }, { col: 7, row: 2 }],
    },
    {
      id: 'obs-bedrock',
      title: 'Bedrock close-up',
      cell: { col: 6, row: 5 },
      imageUrl: IMAGE_BEDROCK,
      caption: 'Placeholder sketch of layered bedrock at the pin. Position is approximate to within one cell.',
      sourceId: 'src-sketch-b',
      characterizedCells: [{ col: 6, row: 4 }, { col: 6, row: 5 }, { col: 7, row: 4 }, { col: 7, row: 5 }],
    },
    {
      id: 'obs-rise',
      title: 'Rise crossing',
      cell: { col: 4, row: 5 },
      cameraCell: { col: 3, row: 5 },
      imageUrl: IMAGE_RIDGE,
      caption: 'Placeholder sketch reused for the low rise in column 4, seen from its south-west end.',
      sourceId: 'src-sketch-a',
      characterizedCells: [{ col: 4, row: 4 }, { col: 4, row: 5 }, { col: 5, row: 4 }, { col: 5, row: 5 }],
    },
  ],
  sources: [
    { id: 'src-grid', productId: 'DEV-GRID-9x7', mission: 'None (synthetic)', url: '', scale: '10 m / cell', processingNote: 'Hand-made test grid', kind: 'synthetic' },
    { id: 'src-sketch-a', productId: 'DEV-SKETCH-A', mission: 'None (synthetic)', url: '', scale: 'n/a', processingNote: 'Drawn placeholder', kind: 'synthetic' },
    { id: 'src-sketch-b', productId: 'DEV-SKETCH-B', mission: 'None (synthetic)', url: '', scale: 'n/a', processingNote: 'Drawn placeholder', kind: 'synthetic' },
  ],
};

/** Variant with a column of missing data that cuts the stations off from base. */
export const SYNTHETIC_SITE_BARRIER: Site = {
  ...SYNTHETIC_SITE,
  id: 'synthetic-ridge-barrier',
  name: 'Synthetic ridge with data gap (dev fixture)',
  elevationM: SYNTHETIC_SITE.elevationM.map((v, i) => (i % W === 5 ? null : v)),
};

export const SYNTHETIC_WINDOWS: LaunchWindow[] = [
  { id: 'win-a', label: 'Window A', lastOpenTurn: 2 },
  { id: 'win-b', label: 'Window B', lastOpenTurn: 4 },
  { id: 'win-c', label: 'Window C', lastOpenTurn: 6 },
];

export function initialRun(site: Site = SYNTHETIC_SITE): Run {
  return {
    turn: 0,
    revealedObservationIds: [],
    waypoints: [],
    stationOrder: site.stations.map((s) => s.id),
    selectedRouteId: null,
    planRevision: 0,
    rehearsalWindowId: null,
    latestRehearsal: null,
    surfaceApproved: false,
    scenarioId: 'scenario-dev',
  };
}
