// ---------------------------------------------------------------------------
// Module-local stand-ins for the shared contracts (Person 6 owns src/shared/).
//
// These follow the field list agreed in the implementation plan, table
// "Shared object". When src/shared/ lands, replace the bodies below with
//   export type { Site, Observation, ... } from '../shared';
// and keep the map-specific types (MapAction, ClockPreview, MapInput).
//
// Coordinates: grid cells (col, row). Columns increase east, rows increase
// south. Centre of cell (0,0) is (eastM 0, northM 0); northM = -row * cellSizeM.
// ---------------------------------------------------------------------------

export interface Cell {
  col: number;
  row: number;
}

/** What kind of evidence a source is — the interface labels each differently. */
export type SourceKind = 'archived' | 'derived' | 'simulated' | 'synthetic';

export interface SourceRecord {
  id: string;
  productId: string;
  mission: string;
  url: string;
  date?: string;
  scale: string;
  processingNote: string;
  /** Optional; the map falls back to 'archived' for observations, 'derived' for terrain. */
  kind?: SourceKind;
}

export interface FieldStation {
  id: string;
  name: string;
  cell: Cell;
  /** One short line, e.g. "Image the ridge capping unit". */
  task?: string;
}

export interface Observation {
  id: string;
  /** Pin position on the map (where the observation is requested). */
  cell: Cell;
  imageUrl: string;
  /** Short factual caption. Geographic uncertainty belongs here. */
  caption: string;
  sourceId: string;
  /** Original camera location, when the picture shows something elsewhere. */
  cameraCell?: Cell;
  /** Cells this observation explicitly helps characterise. */
  characterizedCells: Cell[];
  /** Short display name for the pin (optional, falls back to id). */
  title?: string;
}

export interface Assignment {
  title: string;
  /** The observation the crew must bring home, one sentence. */
  question: string;
  client?: string;
}

export interface Site {
  id: string;
  name?: string;
  width: number;
  height: number;
  cellSizeM: number;
  /** Row-major, length width*height. null = no data (never treat as flat). */
  elevationM: (number | null)[];
  base: Cell;
  textureUrl: string;
  walkBudgetSeconds: number;
  stationRadiusM: number;
  stations: [FieldStation, FieldStation];
  observations: Observation[];
  sources: SourceRecord[];
  /** Source id of the terrain product (optional). */
  terrainSourceId?: string;
  assignment?: Assignment;
  /** True for the synthetic development fixture: the UI says so. */
  synthetic?: boolean;
}

export interface RoutePlan {
  id: string;
  /** Ordered grid cells for the whole round trip (starts and ends at base). */
  cells: Cell[];
  distanceM: number;
  maxSegmentSlopeDeg: number;
  /** Distance across cells with limited observation coverage. */
  limitedCoverageM: number;
  stationIds: string[];
  /** Short comparison sentence written by the planner. */
  comparison: string;
  /** Optional policy hint from the planner, e.g. 'distance' | 'terrain'. */
  policy?: string;
  label?: string;
}

export interface LaunchWindow {
  id: string;
  label: string;
  lastOpenTurn: number;
}

export interface RehearsalResult {
  planRevision: number;
  windowId: string;
  visibility: 'clear' | 'hazy' | 'poor';
  observedStationIds: string[];
  returnedToBase: boolean;
  elapsedSeconds: number;
  distanceWalkedM: number;
}

export interface Run {
  turn: number;
  revealedObservationIds: string[];
  waypoints: Cell[];
  stationOrder: string[];
  selectedRouteId: string | null;
  planRevision: number;
  rehearsalWindowId?: string | null;
  latestRehearsal?: RehearsalResult | null;
  surfaceApproved: boolean;
  scenarioId?: string;
}

// ---------------------------------------------------------------------------
// Map-specific contract (owned by this module).
// ---------------------------------------------------------------------------

/** Clock preview supplied by game flow (Person 6). */
export interface ClockPreview {
  /** Turn after spending `cost` new observations from the current turn. */
  turnAfter(cost: number): number;
  /** Windows that are open now and would be closed at `turn`. */
  closingAt(turn: number): LaunchWindow[];
}

/** Everything the map renders. Pushed in with `update()`. */
export interface MapInput {
  run: Run;
  routes: RoutePlan[];
  windows: LaunchWindow[];
  clock?: ClockPreview;
  /** True while the planner is computing. */
  routesPending?: boolean;
}

/** Actions the map emits. Game flow owns the resulting state change. */
export type MapAction =
  | { type: 'scout'; observationId: string }
  | { type: 'setWaypoints'; waypoints: Cell[] }
  | { type: 'setStationOrder'; stationIds: string[] }
  | { type: 'chooseRoute'; routeId: string }
  | { type: 'startRehearsal'; routeId: string; planRevision: number };
