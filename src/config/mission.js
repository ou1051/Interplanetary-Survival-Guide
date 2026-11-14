// ---------------------------------------------------------------------------
// Mission configuration (PLACEHOLDER DATA)
//
// Everything in this file is mock data so the UI can be built before real NASA
// datasets are connected. Coordinates are local metres:
//   +X = east, -Z = north, Y = up. The habitat sits at (0, 0).
// When real data arrives, replace the terrain height source (src/world/terrain.js)
// and the layer samplers (src/data/layers.js); this file keeps the mission story.
// ---------------------------------------------------------------------------

export const SITE = {
  name: 'VERA RUBIN RIDGE · GALE CRATER',
  eva: 'EVA-03',
  sol: 214,
  lmstStart: 14 * 60 + 10, // local mean solar time at EVA start, minutes
  note: 'Procedural placeholder terrain — no NASA data connected yet',
};

export const TERRAIN = {
  seed: 20261114,
  inner: { cx: 100, cz: -400, size: 1600, segments: 400 }, // 4 m grid, drivable area
  outer: { cx: 100, cz: -400, size: 9000, segments: 180 }, // 50 m grid, horizon
};

// Named landforms that shape the procedural terrain AND the mock data layers.
export const FEATURES = {
  delta: { cx: 150, cz: -800, radius: 330, height: 18, edge: 44 },
  freshCrater: { cx: 255, cz: -675, radius: 38, depth: 12 },
  oldCrater: { cx: -265, cz: -300, radius: 70, depth: 6 },
  ridge: { cx: 395, cz: -345, dx: 0.8, dz: 0.6, halfLength: 230, width: 62, height: 15 },
  ripples: { cx: 185, cz: -95, radius: 55, amplitude: 0.28, wavelength: 7 },
  basin: { cx: 100, cz: -400, rimRadius: 2600, rimHeight: 300 },
};

// Hand-planned traverse (control points of a centripetal Catmull-Rom spline).
export const ROUTE_POINTS = [
  [0, -14],
  [-70, -110],
  [-175, -250], // S1
  [-150, -380],
  [-70, -505], // S2
  [10, -590],
  [120, -640],
  [205, -630], // S3
  [300, -560],
  [340, -470],
  [395, -345], // S4
  [330, -210],
  [180, -90],
  [40, -25],
  [0, -14], // back at habitat
];

// Alternative the player can pick instead: straight lines between the same
// stations. Shorter, but it does not avoid the scarp and the ridge flank.
export const DIRECT_POINTS = [
  [0, -14],
  [-90, -130],
  [-175, -250], // S1
  [-125, -380],
  [-70, -505], // S2
  [70, -585],
  [205, -630], // S3
  [300, -490],
  [395, -345], // S4
  [200, -182],
  [60, -64],
  [0, -14],
];

export const ROUTE_OPTIONS = [
  {
    id: 'survival',
    name: 'Survival route',
    note: 'Hand-planned detours around the steepest scarp and crater-rim ground.',
    points: ROUTE_POINTS,
  },
  {
    id: 'direct',
    name: 'Direct route',
    note: 'Straight lines between stations. Shorter, but it meets the terrain head-on.',
    points: DIRECT_POINTS,
  },
];

// The player's job (Freelance Astronaut). Stations come from STATIONS below.
export const ASSIGNMENT = {
  client: 'Gale Sample Consortium (fictional)',
  title: 'First assignment · Vera Rubin Ridge survey',
  brief:
    'Visit all four science stations, record each one, and bring the rover back to the habitat with oxygen to spare.',
  prepTurns: 'Each newly scouted site costs one preparation turn. Launch windows close as turns pass.',
};

// Scouting sites. Revealing one costs a preparation turn and shows a ground view
// of the area plus what it tells you. `radius` = ground it characterizes (m).
// `reveals` = area hazards (AREA_HAZARDS ids) that only become known once scouted.
export const SCOUT_PINS = [
  {
    id: 'P1',
    name: 'Delta front scarp',
    at: [-30, -560],
    camera: [-160, -420],
    radius: 120,
    reveals: [],
    finding: 'Layered scarp face. The direct line climbs it head-on; the survival route traverses it at an angle.',
  },
  {
    id: 'P2',
    name: 'Fresh crater ejecta',
    at: [255, -600],
    camera: [160, -500],
    radius: 110,
    reveals: ['H-EJECTA'],
    finding: 'Block field around the fresh crater. Both routes cross it near S3: expect a slow, marked corridor.',
  },
  {
    id: 'P3',
    name: 'Ripple field',
    at: [185, -95],
    camera: [95, -25],
    radius: 110,
    reveals: ['H-RIPPLE'],
    finding: 'Soft regolith ripples on the way home. The survival route crosses them; the direct line passes north of them.',
  },
  {
    id: 'P4',
    name: 'Ridge flank',
    at: [330, -430],
    camera: [225, -330],
    radius: 120,
    reveals: [],
    finding: 'Ridge flank below the overlook. Gentle from the south, steeper on the straight approach.',
  },
];

// Fog density for the walk visibility forecast of the rehearsal window.
export const VISIBILITY_FOG = { clear: 0.00042, hazy: 0.0021, poor: 0.0062 };

export const HAB = { x: 0, z: 0, name: 'HABITAT', code: 'HAB' };

export const STATIONS = [
  {
    id: 'S1',
    name: 'Crater Floor Unit',
    at: [-175, -250],
    objective: 'Characterise the dark, olivine-bearing crater-floor rock as the baseline unit for the traverse.',
    why: [
      'MINERAL layer: olivine signature dominates this unit (mock)',
      'SLOPE layer: < 5° — safe to dismount and work on foot',
      'OPTICAL: dark, rough texture distinct from the delta deposits',
    ],
    tasks: [
      { label: 'VNIR spectrometer scan', minutes: 20, result: 'Band at 1.05 µm → olivine-rich (MOCK)' },
      { label: 'Close-up imaging of outcrop texture', minutes: 15, result: '42 frames · grain size 1–3 mm (MOCK)' },
      { label: 'Collect rock core #1', minutes: 30, result: 'Core 6.1 cm sealed in tube A1 (MOCK)' },
    ],
  },
  {
    id: 'S2',
    name: 'Delta Front Scarp',
    at: [-70, -505],
    objective: 'Document layered sediments at the base of the delta — the best place to look for preserved biosignatures.',
    why: [
      'OPTICAL: visible layering on the scarp face',
      'MINERAL layer: clay / carbonate signal on the delta (mock)',
      'Base of the scarp is flat; the climb that follows is the main hazard',
    ],
    tasks: [
      { label: 'Stratigraphic panorama (12 frames)', minutes: 20, result: '≥ 9 beds resolved, 0.2–0.8 m thick (MOCK)' },
      { label: 'Laser range bed thickness', minutes: 15, result: 'Mean bed 0.46 m (MOCK)' },
      { label: 'Collect mudstone sample', minutes: 30, result: 'Fine-grained sample in tube A2 (MOCK)' },
    ],
  },
  {
    id: 'S3',
    name: 'Fresh Impact Crater',
    at: [205, -630],
    objective: 'Sample ejecta blocks that the impact excavated from below the delta surface.',
    why: [
      'THERMAL layer: high thermal inertia → rocky, recently exposed ejecta (mock)',
      'Crater depth ≈ 12 m samples material otherwise out of reach',
      'Rim is steep — stop outside it and work on foot',
    ],
    tasks: [
      { label: 'Survey ejecta block field', minutes: 20, result: '17 blocks > 0.5 m mapped (MOCK)' },
      { label: 'Ground-penetrating radar line', minutes: 25, result: 'Reflector at ~3.2 m depth (MOCK)' },
      { label: 'Collect ejecta sample', minutes: 25, result: 'Pyroxene-rich clast in tube A3 (MOCK)' },
    ],
  },
  {
    id: 'S4',
    name: 'Ridge Overlook',
    at: [395, -345],
    objective: 'High vantage point: confirm comms with the habitat and image the traverse for future EVAs.',
    why: [
      'Highest point near the route → line-of-sight to the habitat',
      'Panorama supports planning of the next traverse',
      'Exposed crest: check dosimeter and dust conditions',
    ],
    tasks: [
      { label: 'Comms relay check with HAB', minutes: 10, result: 'Link margin +7 dB (MOCK)' },
      { label: 'Dosimeter reading', minutes: 5, result: '0.29 mSv/sol, quiet space weather (MOCK)' },
      { label: '360° planning panorama', minutes: 20, result: 'Panorama stored · 64 frames (MOCK)' },
    ],
  },
];

// Non-slope hazards (slope hazards are derived automatically from the terrain).
export const AREA_HAZARDS = [
  {
    id: 'H-EJECTA',
    type: 'EJECTA BLOCK FIELD',
    cx: 255, cz: -598, radius: 48,
    limit: 1.5,
    severity: 'danger',
    procedure: [
      'Reduce speed to ≤ 1.5 m/s (5 km/h)',
      'Keep to the marked corridor — blocks up to 1 m beside the route',
      'Crew member 2 calls obstacles verbally',
    ],
    basis: 'Rock abundance from OPTICAL + THERMAL inertia (mock)',
  },
  {
    id: 'H-RIPPLE',
    type: 'SOFT REGOLITH · RIPPLES',
    cx: 185, cz: -95, radius: 55,
    limit: 2.0,
    severity: 'danger',
    procedure: [
      'Constant low speed, no stopping on ripple crests',
      'No sharp steering inputs (wheel sinkage risk)',
      'If traction is lost: stop, do not spin wheels',
    ],
    basis: 'Low thermal inertia → fine, loose material (mock)',
  },
];

export const ROVER = {
  maxSpeed: 4.5, // m/s (~16 km/h)
  cautionSpeed: 2.8,
  dangerSlopeSpeed: 1.6,
  accel: 1.1,
  brake: 2.6,
  coast: 0.35,
  corridorHalfWidth: 5.0, // lateral steering limit, m
  wheelbase: 2.3,
  track: 1.8,
  batteryWh: 1600,
};

export const LIFE_SUPPORT = {
  evaHours: 8,
  reserveMinutes: 30,
  walkSpeedKmh: 2.0,
  doseRateUsvH: 28, // ~0.67 mSv/sol, typical MSL/RAD surface value
};

export const SLOPE_CLASSES = { caution: 9, danger: 15 }; // degrees of combined tilt
