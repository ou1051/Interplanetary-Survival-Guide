export interface SuitLayers {
  insulation: number;
  shielding: number;
  abrasion: number;
}

interface SuitMaterial {
  id: keyof SuitLayers;
  name: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  kgPerUnit: number;
  note: string;
}

interface Site {
  name: string;
  cell: [number, number];
}

interface RouteCosts {
  oxygen_cost: number;
  battery_drain: number;
  hazard_warnings: string[];
}

export const SUIT: { baseMassKg: number; o2PerExtraKg: number; materials: SuitMaterial[] };
export const SUIT_PRESETS: { id: string; name: string; tagline: string; suit: SuitLayers }[];
export const BASE: Site;
export const DESTINATIONS: (Site & { id: string; note: string })[];
export const EVA: {
  siteMinutes: { min: number; max: number; step: number; value: number };
  shieldingHalfMm: number;
  radiationSpikeFactor: number;
  coldInsulationLayers: number;
  abrasionNeeded: number;
  shieldingForSpikeMm: number;
};

export function defaultSuit(): SuitLayers;
export function suitMass(suit: Partial<SuitLayers>): number;
export function predict(route: RouteCosts | null, suit: SuitLayers, siteMinutes?: number): {
  massKg: number;
  totalMin: number;
  o2: { used: number; budget: number; reserve: number; left: number };
  battery: { used: number; budget: number };
  dose: { usv: number };
  warnings: { level: 'danger' | 'warn'; text: string }[];
  covered: string[];
  verdict: 'GO' | 'CAUTION' | 'NO-GO' | 'NO ROUTE';
};
