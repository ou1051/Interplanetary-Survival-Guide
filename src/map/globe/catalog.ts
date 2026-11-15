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
  /** Greyscale product: tint with the painted surface's colour (see colorize.ts). */
  colorize?: boolean;
  /** Generated in the worker (marsPaint.ts), not fetched from `url`. */
  painted?: boolean;
  /** Display grading (Cesium ImageryLayer: 1 = unchanged). */
  tone?: { brightness?: number; contrast?: number; saturation?: number; gamma?: number; hue?: number };
  mission: string;
  instrument: string;
  /** Approx. ground resolution of the source product. */
  resolution: string;
  credit: string;
}

const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ';
// The raw Viking fallback is graded a little warmer and crisper. Detail
// layers need no grading: they are pan-sharpened onto the painted surface.
const VIKING_TONE = { saturation: 1.3, contrast: 1.12 };
const DETAIL_TONE = {};
const trek = (layer: string, ext: 'png' | 'jpg') => `${TREK}/${layer}/1.0.0//default/default028mm/{z}/{y}/{x}.${ext}`;

export const SOURCES = {
  painted: {
    id: 'painted-mars',
    url: 'painted',
    tileSize: 256,
    maxLevel: 8,
    painted: true,
    mission: 'Viking Orbiter · MGS MOLA',
    instrument: 'Painted surface: Viking albedo, true-colour palette, MOLA relief',
    resolution: '232 m/px',
    credit: 'Viking MDIM 2.1: NASA/JPL/USGS · MOLA/HRSC: NASA/GSFC, ESA/DLR · colour design: Field Office',
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
} satisfies Record<string, TileSource>;

/** Colour source used to tint the greyscale detail layers. */
export const COLOR_BASE = { url: SOURCES.viking.url, tileSize: SOURCES.viking.tileSize, maxLevel: SOURCES.viking.maxLevel };

/** Natural-colour imagery needed by the console at Gale crater, finest last. */
export const IMAGERY: TileSource[] = [SOURCES.painted, SOURCES.galeCtx, SOURCES.curiosityHirise];

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
