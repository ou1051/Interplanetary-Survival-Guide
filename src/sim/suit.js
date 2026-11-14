import { LIFE_SUPPORT, ROVER } from '../config/mission.js';
import { evaBudget } from '../physics/traverse.js';

// ---------------------------------------------------------------------------
// Planning Board model: suit materials + a planned route → predicted EVA
// consumables and a GO / CAUTION / NO-GO verdict.
//
// All suit numbers are GAMEPLAY ASSUMPTIONS (not NASA specifications) so the
// board has something to compute until the team agrees on real values.
// Route figures (drive oxygen, battery, hazards) come from /api/route-data.
// ---------------------------------------------------------------------------

export const SUIT = {
  baseMassKg: 50, // pressure garment + life-support pack, without the layers below
  o2PerExtraKg: 0.01, // +1 % oxygen use per extra kilogram carried
  materials: [
    {
      id: 'insulation',
      name: 'Thermal insulation',
      unit: 'layers',
      min: 3,
      max: 12,
      step: 1,
      value: 6,
      kgPerUnit: 0.6,
      note: 'Keeps body heat in at −60 °C nights',
    },
    {
      id: 'shielding',
      name: 'Radiation shielding',
      unit: 'mm',
      min: 0,
      max: 20,
      step: 1,
      value: 5,
      kgPerUnit: 0.9,
      note: 'Polyethylene liner; cuts radiation dose',
    },
    {
      id: 'abrasion',
      name: 'Abrasion layer',
      unit: '%',
      min: 0,
      max: 100,
      step: 10,
      value: 50,
      kgPerUnit: 0.04,
      note: 'Vectran coverage against sharp regolith',
    },
  ],
};

// Ready-made suits so the player chooses a trade-off, not three numbers.
export const SUIT_PRESETS = [
  { id: 'light', name: 'Light', tagline: 'Saves oxygen · little protection', suit: { insulation: 4, shielding: 0, abrasion: 20 } },
  { id: 'standard', name: 'Standard', tagline: 'Balanced for most walks', suit: { insulation: 6, shielding: 5, abrasion: 50 } },
  { id: 'shielded', name: 'Shielded', tagline: 'Blocks radiation · heavy, uses more oxygen', suit: { insulation: 8, shielding: 18, abrasion: 80 } },
];

// Named places on the routing API's grid (public/cost_matrix.json, [col, row]).
export const BASE = { name: 'Habitat', cell: [1, 3] };
export const DESTINATIONS = [
  { id: 'outcrop', name: 'Bedrock outcrop', note: 'Short, easy walk', cell: [8, 1] },
  { id: 'rim', name: 'Crater rim', note: 'Far side of the site', cell: [12, 2] },
  { id: 'hotspot', name: 'Radiation hotspot', note: 'Sample site inside a radiation spike', cell: [13, 6] },
];

// Airlock times and the working rate live in LIFE_SUPPORT and are applied by evaBudget.
export const EVA = {
  siteMinutes: { min: 0, max: 180, step: 10, value: 60 },
  shieldingHalfMm: 10, // every 10 mm of polyethylene halves the dose (assumption)
  radiationSpikeFactor: 1.5, // route passes a "Radiation Spike" cell
  coldInsulationLayers: 5, // fewer layers than this → cold-stress warning
  abrasionNeeded: 40, // % coverage needed on loose regolith
  shieldingForSpikeMm: 10, // mm of shielding that makes a radiation spike acceptable
};

export const defaultSuit = () => Object.fromEntries(SUIT.materials.map((m) => [m.id, m.value]));

export function suitMass(suit) {
  return SUIT.baseMassKg + SUIT.materials.reduce((kg, m) => kg + (suit[m.id] ?? m.value) * m.kgPerUnit, 0);
}

/**
 * @param route  { oxygen_cost, battery_drain, hazard_warnings } from /api/route-data (or null)
 * @param suit   { insulation, shielding, abrasion }
 * @param siteMinutes  time spent working at the destination
 */
export function predict(route, suit, siteMinutes = EVA.siteMinutes.value) {
  const massKg = suitMass(suit);
  const o2Factor = 1 + (massKg - SUIT.baseMassKg) * SUIT.o2PerExtraKg;
  // oxygen_cost is riding-rate oxygen minutes, i.e. minutes of driving.
  const driveMin = route ? route.oxygen_cost : 0;
  const idleMin = LIFE_SUPPORT.egressMinutes + LIFE_SUPPORT.ingressMinutes;
  const totalMin = driveMin + idleMin + siteMinutes;
  const o2 = evaBudget({ driveSeconds: driveMin * 60, workMinutes: siteMinutes, rateFactor: o2Factor });

  // rover hotel load (110 W, same as the shared physics model) while parked
  const batteryWh = (route ? route.battery_drain : 0) + 110 * ((idleMin + siteMinutes) / 60);

  const hazards = route ? route.hazard_warnings : [];
  const spike = hazards.some((h) => /radiation/i.test(h));
  const doseUsv =
    LIFE_SUPPORT.doseRateUsvH * (totalMin / 60) * Math.pow(0.5, suit.shielding / EVA.shieldingHalfMm) *
    (spike ? EVA.radiationSpikeFactor : 1);

  // A hazard on the route is a warning unless the suit already protects against it.
  const warnings = [];
  const covered = [];
  for (const h of hazards) {
    if (/radiation/i.test(h)) {
      if (suit.shielding >= EVA.shieldingForSpikeMm) covered.push(`${h}: covered by ${suit.shielding} mm shielding`);
      else warnings.push({ level: 'danger', text: `${h} on route` });
    } else if (/regolith/i.test(h)) {
      if (suit.abrasion >= EVA.abrasionNeeded) covered.push(`${h}: covered by ${suit.abrasion} % abrasion layer`);
      else warnings.push({ level: 'danger', text: `${h} on route` });
    } else warnings.push({ level: 'danger', text: `${h} on route` });
  }
  if (suit.insulation < EVA.coldInsulationLayers) warnings.push({ level: 'warn', text: 'Cold stress: add insulation layers' });

  let verdict = 'GO';
  if (!route) verdict = 'NO ROUTE';
  else if (o2.insufficient || batteryWh > ROVER.batteryWh) verdict = 'NO-GO';
  else if (o2.belowReserve || warnings.length) verdict = 'CAUTION';

  return {
    massKg,
    totalMin,
    o2: { used: o2.required, budget: o2.capacity, reserve: o2.reserve, left: o2.remaining },
    battery: { used: batteryWh, budget: ROVER.batteryWh },
    dose: { usv: doseUsv },
    warnings,
    covered,
    verdict,
  };
}
