// ---------------------------------------------------------------------------
// Real Mars data used by the globe. Endpoints and limits were read from each
// service's own WMTS capabilities / ArcGIS REST metadata and checked by
// requesting real tiles at the assignment site (Nov 2026):
//   https://trek.nasa.gov/tiles/Mars/EQ/<layer>/1.0.0/WMTSCapabilities.xml
//   https://astro.arcgis.com/arcgis/rest/services/OnMars/<service>?f=json
// Same layers as NASA-funded OpenSpace's "nasa-treks" Mars assets.
// All tiling is geographic (lon/lat), 2 × 1 tiles at level 0, origin (-180, 90).
// ---------------------------------------------------------------------------

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TileSource {
  id: string;
  /** URL template with {z} {y} {x}. */
  url: string;
  tileSize: 256 | 512;
  maxLevel: number;
  bbox?: BBox;
  /** Only shown once the view is close enough (terrain tile level). */
  minViewLevel?: number;
  alpha?: number;
  /** Make pure-black "no data" pixels transparent. */
  blackIsNoData?: boolean;
  /** Greyscale product: tint with the Viking colour mosaic (see colorize.ts). */
  colorize?: boolean;
  /** Display grading (Cesium ImageryLayer: 1 = unchanged). */
  tone?: { brightness?: number; contrast?: number; saturation?: number; gamma?: number; hue?: number };
  mission: string;
  instrument: string;
  /** Approx. ground resolution of the source product. */
  resolution: string;
  credit: string;
}

export interface ImageryStyle {
  id: string;
  name: string;
  short: string;
  description: string;
  stack: TileSource[];
}

const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ';
// Grading tuned by eye against MRO/Curiosity natural-colour views of Gale:
// Viking colour gets a little warmer and crisper; colour-matched detail layers
// carry less chroma than Viking (luminance comes from greyscale), so they need more.
const VIKING_TONE = { saturation: 1.3, contrast: 1.12 };
const DETAIL_TONE = { saturation: 2.0, hue: 0.1, contrast: 1.06, brightness: 1.06 };
const trek = (layer: string, ext: 'png' | 'jpg') => `${TREK}/${layer}/1.0.0//default/default028mm/{z}/{y}/{x}.${ext}`;

export const SOURCES = {
  colorRelief: {
    id: 'mola-hrsc-color',
    url: trek('Mars_MOLA_blend200ppx_HRSC_ClrShade_clon0dd_200mpp_lzw', 'jpg'),
    tileSize: 256,
    maxLevel: 8,
    mission: 'MGS MOLA + Mars Express HRSC',
    instrument: 'Laser altimeter / stereo camera',
    resolution: '200 m/px',
    credit: 'NASA/JPL/GSFC · ESA/DLR/FU Berlin · Mars Trek',
  },
  viking: {
    id: 'viking-mdim',
    url: trek('Mars_Viking_MDIM21_ClrMosaic_global_232m', 'jpg'),
    tileSize: 256,
    maxLevel: 7,
    mission: 'Viking Orbiter',
    instrument: 'MDIM 2.1 colour mosaic',
    resolution: '232 m/px',
    credit: 'NASA/JPL/USGS · Mars Trek',
    tone: VIKING_TONE,
  },
  ctxGlobal: {
    id: 'ctx-global',
    url: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX/MapServer/tile/{z}/{y}/{x}',
    tileSize: 512,
    // REST metadata lists 18 LODs, but the cache stops at 12 (≈5 m/px, the source
    // resolution); deeper requests 404 without CORS. Verified at Vera Rubin Ridge.
    maxLevel: 12,
    minViewLevel: 7,
    colorize: true,
    tone: DETAIL_TONE,
    mission: 'Mars Reconnaissance Orbiter',
    instrument: 'CTX global mosaic (Murray Lab, Caltech)',
    resolution: '5 m/px',
    credit: 'NASA/JPL/MSSS · Caltech Murray Lab · Esri',
  },
  galeCtx: {
    id: 'gale-ctx',
    url: trek('Gale_CTX_BlockAdj_dd', 'png'),
    tileSize: 256,
    maxLevel: 12,
    bbox: { west: 135.1842593, south: -6.5732988, east: 139.2413012, north: -2.8077809 },
    minViewLevel: 8,
    blackIsNoData: true,
    colorize: true,
    tone: DETAIL_TONE,
    mission: 'Mars Reconnaissance Orbiter',
    instrument: 'CTX, Gale block-adjusted mosaic',
    resolution: '6 m/px',
    credit: 'NASA/JPL/MSSS · Mars Trek',
  },
  curiosityHirise: {
    id: 'curiosity-hirise',
    url: trek('curiosity_hirise_mosaic', 'png'),
    tileSize: 256,
    maxLevel: 16,
    bbox: { west: 137.1224669, south: -4.9254743, east: 137.7298129, north: -4.2489588 },
    minViewLevel: 10,
    blackIsNoData: true,
    colorize: true,
    tone: DETAIL_TONE,
    mission: 'Mars Reconnaissance Orbiter',
    instrument: 'HiRISE, Curiosity traverse mosaic',
    resolution: '25 cm/px source',
    credit: 'NASA/JPL/University of Arizona · Mars Trek',
  },
  jezeroHirise: {
    id: 'jezero-hirise',
    // Esri's sparse global HiRISE cache (red band, through 2018). Missing tiles
    // fail without CORS, so it is only requested where coverage was checked:
    // Jezero crater is fully covered at level 11, and tiles exist to level 17.
    url: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/HiRISE/MapServer/tile/{z}/{y}/{x}',
    tileSize: 512,
    maxLevel: 17,
    bbox: { west: 77.05, south: 18.15, east: 77.85, north: 18.75 },
    minViewLevel: 10,
    colorize: true,
    tone: DETAIL_TONE,
    mission: 'Mars Reconnaissance Orbiter',
    instrument: 'HiRISE, Esri global mosaic',
    resolution: '25 cm/px source',
    credit: 'NASA/JPL/University of Arizona/USGS · Esri',
  },
} satisfies Record<string, TileSource>;

/** Colour source used to tint the greyscale detail layers. */
export const COLOR_BASE = { url: SOURCES.viking.url, tileSize: SOURCES.viking.tileSize, maxLevel: SOURCES.viking.maxLevel };

export const IMAGERY: ImageryStyle[] = [
  {
    id: 'best',
    name: 'Natural colour',
    short: 'Natural',
    description: 'Viking colour, sharpening to colour-matched CTX and HiRISE as you zoom in',
    stack: [SOURCES.viking, SOURCES.ctxGlobal, SOURCES.galeCtx, SOURCES.jezeroHirise, SOURCES.curiosityHirise],
  },
  {
    id: 'relief',
    name: 'Colour relief',
    short: 'Relief',
    description: 'MOLA elevation colours over HRSC shading',
    stack: [SOURCES.colorRelief],
  },
  {
    id: 'viking',
    name: 'Viking colour',
    short: 'Viking',
    description: 'Approximate true colour, 1970s Viking orbiters',
    stack: [SOURCES.viking],
  },
];

export const TERRAIN = {
  url: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/MDEM200M/ImageServer',
  mission: 'MGS MOLA + Mars Express HRSC',
  resolution: '200 m grid',
  credit: 'Mars 200 m DEM · NASA/JPL/GSFC · ESA/DLR · Esri',
  /** Stereo DTMs blended in where they exist (Gale crater included). */
  detail: {
    url: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/HiRISE_DEM/ImageServer',
    mission: 'MRO HiRISE stereo DTMs',
    resolution: '~1 m grid',
    credit: 'HiRISE DTM mosaic · NASA/JPL/University of Arizona/USGS · Esri',
  },
};

export interface Place {
  id: string;
  name: string;
  /** Degrees, planetocentric latitude, east-positive longitude. */
  lat: number;
  lon: number;
  /** Camera range from the target when flying there, metres. */
  range: number;
  pitchDeg: number;
  note: string;
  /** Parent feature for the breadcrumb. */
  region?: string;
  /** Pin only shown when the camera is closer than this (m); avoids clutter at Gale. */
  showBelowM?: number;
  assignment?: boolean;
}

// Coordinates: Gale (IAU / Wikipedia 5.4°S 137.8°E), Vera Rubin Ridge (HiRISE
// ESP_052176_1750 image centre), Aeolis Mons summit, Perseverance landing site,
// Olympus Mons summit, central Valles Marineris.
export const PLACES: Place[] = [
  { id: 'vrr', name: 'Vera Rubin Ridge', lat: -4.714, lon: 137.357, range: 9000, pitchDeg: -38, note: 'Assignment area · Gale Crater', region: 'Gale Crater', assignment: true },
  { id: 'gale', name: 'Gale Crater', lat: -5.4, lon: 137.8, range: 260000, pitchDeg: -55, note: '154 km impact crater', showBelowM: 3_000_000 },
  { id: 'sharp', name: 'Mount Sharp', lat: -5.08, lon: 137.85, range: 70000, pitchDeg: -30, note: 'Aeolis Mons, ~5.5 km high', region: 'Gale Crater', showBelowM: 700_000 },
  { id: 'jezero', name: 'Jezero Crater', lat: 18.4447, lon: 77.4508, range: 90000, pitchDeg: -50, note: 'Perseverance landing site' },
  { id: 'olympus', name: 'Olympus Mons', lat: 18.65, lon: -133.8, range: 1100000, pitchDeg: -50, note: 'Largest volcano in the solar system' },
  { id: 'valles', name: 'Valles Marineris', lat: -13.9, lon: -59.2, range: 1600000, pitchDeg: -60, note: '4,000 km canyon system' },
];

/** Fill a {z}/{y}/{x} template. */
export function tileUrl(src: TileSource, z: number, y: number, x: number): string {
  return src.url.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x));
}

/** Geographic 2×1 tiling: degrees per pixel at a level. */
export function degreesPerPixel(level: number, tileSize = 256): number {
  return 180 / tileSize / 2 ** level;
}

/** Tile containing a lon/lat at a level (geographic 2×1, origin -180/90). */
export function tileFor(lon: number, lat: number, level: number): { x: number; y: number } {
  const n = 2 ** level;
  const span = 180 / n;
  const x = Math.min(2 * n - 1, Math.max(0, Math.floor((lon + 180) / span)));
  const y = Math.min(n - 1, Math.max(0, Math.floor((90 - lat) / span)));
  return { x, y };
}

export const inBBox = (b: BBox, lon: number, lat: number) => lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;

/** Sources that cover a point, best (finest) last. */
export function coverageAt(style: ImageryStyle, lon: number, lat: number): TileSource[] {
  return style.stack.filter((s) => !s.bbox || inBBox(s.bbox, lon, lat));
}
