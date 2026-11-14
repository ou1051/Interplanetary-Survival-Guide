import type { ClockPreview, LaunchWindow, Observation, Run, Site, SourceRecord, SourceKind } from './contracts';

// Scouting rules as the map shows them. The arithmetic lives in game flow's
// ClockPreview; `standInClock` reproduces the agreed rule so the map can be
// demonstrated before src/game/ exists:
//   - a window is open while turn <= lastOpenTurn
//   - each NEW observation costs one preparation turn; reopening is free

export function standInClock(currentTurn: number, windows: LaunchWindow[]): ClockPreview {
  return {
    turnAfter: (cost) => currentTurn + cost,
    closingAt: (turn) => windows.filter((w) => w.lastOpenTurn >= currentTurn && w.lastOpenTurn < turn),
  };
}

export const openWindows = (turn: number, windows: LaunchWindow[]): LaunchWindow[] =>
  windows.filter((w) => turn <= w.lastOpenTurn);

export interface ScoutPreview {
  observation: Observation;
  isNew: boolean;
  /** Preparation turns this action costs (0 when reopening). */
  cost: number;
  turnNow: number;
  turnAfter: number;
  /** Windows open now that would be closed by this request. */
  closes: LaunchWindow[];
  /** True when the request would leave no departure opportunity open. */
  closesLast: boolean;
}

export function previewScout(
  observation: Observation,
  run: Run,
  windows: LaunchWindow[],
  clock: ClockPreview = standInClock(run.turn, windows),
): ScoutPreview {
  const isNew = !run.revealedObservationIds.includes(observation.id);
  const cost = isNew ? 1 : 0;
  const turnAfter = clock.turnAfter(cost);
  const closes = cost ? clock.closingAt(turnAfter) : [];
  const openNow = openWindows(run.turn, windows);
  const closesLast = openNow.length > 0 && closes.length >= openNow.length;
  return { observation, isNew, cost, turnNow: run.turn, turnAfter, closes, closesLast };
}

export function sourceFor(site: Site, observation: Observation): SourceRecord | undefined {
  return site.sources.find((s) => s.id === observation.sourceId);
}

export function sourceKind(site: Site, source: SourceRecord | undefined, fallback: SourceKind): SourceKind {
  if (site.synthetic) return 'synthetic';
  return source?.kind ?? fallback;
}

export const KIND_LABEL: Record<SourceKind, string> = {
  archived: 'Archived observation',
  derived: 'Derived terrain',
  simulated: 'Simulated',
  synthetic: 'Synthetic placeholder',
};
