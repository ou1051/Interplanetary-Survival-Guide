// ---------------------------------------------------------------------------
// Weather scenarios for the launch desk (SIMULATED, PLACEHOLDER).
//
// Each scenario holds three fictional launch windows. Every window has an
// initial forecast and an update that is revealed after the player holds.
// Earth = conditions at the departure pad; Mars arrival = entry/landing;
// Marswalk = conditions during the surface traverse (sets rehearsal visibility).
// Later these come from one LLM request per scenario (Person 5), validated once
// and kept for the whole run and for Retry.
// ---------------------------------------------------------------------------

const fc = (earth, arrival, walk, note) => ({
  earth: { text: earth[0], risk: earth[1] },
  arrival: { text: arrival[0], risk: arrival[1] },
  walk: { text: walk[0], risk: walk[1], visibility: walk[2] },
  note,
});

export const SCENARIOS = [
  {
    id: 'WX-A',
    source: 'Cached scenario (placeholder for LLM output)',
    windows: [
      {
        id: 'W1', label: 'Window 1', depart: 'Day 3', arrive: 'Sol 140', walk: 'Sol 142', lastOpenTurn: 2,
        forecast: fc(['Gusty crosswinds at the pad', 'moderate'], ['Calm entry corridor', 'low'], ['Clear skies', 'low', 'clear'],
          'Easy surface conditions; the launch itself may scrub on wind.'),
        update: fc(['Crosswinds easing', 'low'], ['Calm entry corridor', 'low'], ['Clear skies', 'low', 'clear'],
          'Wind risk has dropped.'),
      },
      {
        id: 'W2', label: 'Window 2', depart: 'Day 9', arrive: 'Sol 151', walk: 'Sol 153', lastOpenTurn: 4,
        forecast: fc(['Clear and calm', 'low'], ['Regional dust lifting', 'moderate'], ['Hazy, light dust', 'moderate', 'hazy'],
          'Smooth launch; stations will be harder to spot on the surface.'),
        update: fc(['Clear and calm', 'low'], ['Dust storm building', 'high'], ['Poor visibility, dust storm', 'high', 'poor'],
          'A dust storm is now expected during the traverse.'),
      },
      {
        id: 'W3', label: 'Window 3', depart: 'Day 15', arrive: 'Sol 160', walk: 'Sol 163', lastOpenTurn: 6,
        forecast: fc(['Thunderstorms possible', 'high'], ['Calm', 'low'], ['Hazy morning, clearing', 'low', 'hazy'],
          'Last chance. Mars looks fine; Earth weather is the risk.'),
        update: fc(['Storms moving away', 'moderate'], ['Calm', 'low'], ['Clear', 'low', 'clear'],
          'Earth weather improving.'),
      },
    ],
  },
  {
    id: 'WX-B',
    source: 'Cached scenario (placeholder for LLM output)',
    windows: [
      {
        id: 'W1', label: 'Window 1', depart: 'Day 3', arrive: 'Sol 140', walk: 'Sol 142', lastOpenTurn: 2,
        forecast: fc(['Clear and calm', 'low'], ['Dusty entry corridor', 'moderate'], ['Poor visibility, local dust', 'high', 'poor'],
          'Easy launch, hard traverse.'),
        update: fc(['Clear and calm', 'low'], ['Dust settling', 'low'], ['Hazy', 'moderate', 'hazy'],
          'Dust is settling.'),
      },
      {
        id: 'W2', label: 'Window 2', depart: 'Day 9', arrive: 'Sol 151', walk: 'Sol 153', lastOpenTurn: 4,
        forecast: fc(['Low cloud ceiling', 'moderate'], ['Calm', 'low'], ['Clear', 'low', 'clear'],
          'Launch may slip a day; the traverse looks easy.'),
        update: fc(['Ceiling lifting', 'low'], ['Calm', 'low'], ['Clear', 'low', 'clear'],
          'Both ends look good now.'),
      },
      {
        id: 'W3', label: 'Window 3', depart: 'Day 15', arrive: 'Sol 160', walk: 'Sol 163', lastOpenTurn: 6,
        forecast: fc(['Clear and calm', 'low'], ['Calm', 'low'], ['Hazy', 'moderate', 'hazy'],
          'Safe but late.'),
        update: fc(['High winds forecast', 'high'], ['Calm', 'low'], ['Hazy', 'moderate', 'hazy'],
          'Earth winds are now a risk.'),
      },
    ],
  },
];

export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
