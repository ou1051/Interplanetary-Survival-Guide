import { SCENARIOS, scenarioById } from '../data/scenarios.js';
import { SCOUT_PINS, LIFE_SUPPORT } from '../config/mission.js';

// ---------------------------------------------------------------------------
// The player's session (Freelance Astronaut): preparation turns, scouting,
// route choice, rehearsal approval, launch windows, hold, launch, retry.
//
// Turns count preparation, not driving time. A window is open while
// turn ≤ lastOpenTurn. Each newly scouted site costs one turn; holding jumps
// one turn past the earliest open window. The run survives page reloads
// (sessionStorage) so a rehearsal can rebuild the world for another route.
// ---------------------------------------------------------------------------

const KEY = 'isg-run-v1';

function freshRun(scenarioId) {
  return {
    scenarioId,
    turn: 0,
    revealed: [],
    routeId: 'survival',
    planRevision: 0,
    rehearsalWindowId: 'W1',
    rehearsal: null,
    forecastUpdated: false,
    outcome: 'planning', // planning | launched | deferred | expired
    launchedWindowId: null,
    decisions: [],
    pendingRehearsal: false,
  };
}

export class Game {
  constructor(run) {
    this.run = run;
    this.listeners = [];
  }

  static load() {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (raw) return new Game(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    return new Game(freshRun(SCENARIOS[0].id));
  }

  save() {
    sessionStorage.setItem(KEY, JSON.stringify(this.run));
    for (const fn of this.listeners) fn(this.run);
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  /** Retry: same weather scenario, all progress cleared. */
  retry() {
    this.run = freshRun(this.run.scenarioId);
    this.save();
  }

  /** New weather: a different scenario for the same site and assignment. */
  newWeather() {
    const others = SCENARIOS.filter((s) => s.id !== this.run.scenarioId);
    this.run = freshRun((others[0] || SCENARIOS[0]).id);
    this.save();
  }

  log(kind, text) {
    this.run.decisions.push({ turn: this.run.turn, kind, text });
  }

  // ------------------------------------------------------------ clock
  get scenario() {
    return scenarioById(this.run.scenarioId);
  }
  isOpen(w, turn = this.run.turn) {
    return turn <= w.lastOpenTurn;
  }
  openWindows(turn = this.run.turn) {
    return this.scenario.windows.filter((w) => this.isOpen(w, turn));
  }
  forecast(w) {
    return this.run.forecastUpdated ? w.update : w.forecast;
  }
  windowById(id) {
    return this.scenario.windows.find((w) => w.id === id);
  }
  _preview(turnAfter) {
    const closes = this.scenario.windows.filter((w) => this.isOpen(w) && !this.isOpen(w, turnAfter));
    return { turnAfter, closes, endsAll: this.openWindows(turnAfter).length === 0 };
  }

  previewScout(pinId) {
    const cost = this.run.revealed.includes(pinId) ? 0 : 1;
    return { cost, ...this._preview(this.run.turn + cost) };
  }

  previewHold() {
    const open = this.openWindows();
    if (!open.length) return null;
    return this._preview(Math.min(...open.map((w) => w.lastOpenTurn)) + 1);
  }

  _expireIfClosed() {
    if (this.run.outcome === 'planning' && this.openWindows().length === 0) {
      this.run.outcome = 'expired';
      this.log('expired', 'Every launch window closed before launch.');
    }
  }

  // ------------------------------------------------------------ planning
  scout(pinId, routes) {
    const pin = SCOUT_PINS.find((p) => p.id === pinId);
    const p = this.previewScout(pinId);
    if (!pin || p.cost === 0 || this.run.outcome !== 'planning') return;
    this.log('scout', `Scouted ${pin.name} (turn ${this.run.turn} → ${p.turnAfter}).`);
    this.run.turn = p.turnAfter;
    this.run.revealed.push(pinId);
    // New evidence on the chosen route invalidates the rehearsal done without it.
    const r = routes[this.run.routeId];
    if (r && routeTouches(r, pin) && this.run.rehearsal) {
      this.run.planRevision++;
      this.log('plan', `New evidence covers the ${r.option.name.toLowerCase()}; rehearse again.`);
    }
    this._expireIfClosed();
    this.save();
  }

  chooseRoute(id, name) {
    if (id === this.run.routeId) return;
    this.run.routeId = id;
    this.run.planRevision++;
    this.log('route', `Chose the ${name.toLowerCase()}.`);
    this.save();
  }

  setRehearsalWindow(id) {
    this.run.rehearsalWindowId = id;
    this.save();
  }

  // ------------------------------------------------------------ rehearsal
  recordRehearsal(result) {
    this.run.rehearsal = result;
    this.run.pendingRehearsal = false;
    const a = this.approval();
    this.log('rehearse', a.ok ? `Rehearsal approved (${result.visibility} visibility).` : `Rehearsal not approved: ${a.reasons[0]}`);
    this.save();
  }

  approval() {
    const r = this.run.rehearsal;
    const reasons = [];
    if (!r) return { ok: false, reasons: ['The traverse has not been rehearsed yet.'] };
    if (r.planRevision !== this.run.planRevision || r.routeId !== this.run.routeId) reasons.push('The plan changed after the last rehearsal.');
    if (r.aborted) reasons.push('The last rehearsal was ended early.');
    else if (!r.returned) reasons.push('The rover did not return to the habitat.');
    if (r.stationsDone < r.stationsTotal) reasons.push(`Only ${r.stationsDone} of ${r.stationsTotal} stations were recorded.`);
    if (!r.aborted && r.o2Remaining < LIFE_SUPPORT.reserveMinutes) reasons.push('Oxygen reserve was broken.');
    return { ok: reasons.length === 0, reasons };
  }

  // ------------------------------------------------------------ launch desk
  hold() {
    const p = this.previewHold();
    if (!p) return;
    this.log('hold', `Held to turn ${p.turnAfter}. Forecast updated${p.closes.length ? `; ${p.closes.map((w) => w.label).join(', ')} closed` : ''}.`);
    this.run.turn = p.turnAfter;
    this.run.forecastUpdated = true;
    this._expireIfClosed();
    this.save();
  }

  canLaunch(w) {
    if (this.run.outcome !== 'planning') return { ok: false, reason: 'The mission has ended.' };
    if (!this.isOpen(w)) return { ok: false, reason: `${w.label} has closed.` };
    const a = this.approval();
    if (!a.ok) return { ok: false, reason: a.reasons[0] };
    return { ok: true };
  }

  launch(w) {
    if (!this.canLaunch(w).ok) return false;
    this.run.outcome = 'launched';
    this.run.launchedWindowId = w.id;
    this.log('launch', `Launched in ${w.label} (${w.depart}).`);
    this.save();
    return true;
  }

  defer() {
    this.run.outcome = 'deferred';
    this.log('defer', 'Deferred the mission.');
    this.save();
  }
}

/** Does the route pass through the ground a scouting site characterizes? */
export function routeTouches(route, pin) {
  for (let i = 0; i < route.count; i += 4) {
    if (Math.hypot(route.x[i] - pin.at[0], route.z[i] - pin.at[1]) < pin.radius) return true;
  }
  return false;
}

/** Metres of route outside every revealed site (and away from the habitat pad). */
export function unscoutedDistance(route, revealedIds) {
  const pins = SCOUT_PINS.filter((p) => revealedIds.includes(p.id));
  let n = 0;
  for (let i = 0; i < route.count; i++) {
    const x = route.x[i];
    const z = route.z[i];
    if (Math.hypot(x, z) < 90) continue;
    if (!pins.some((p) => Math.hypot(x - p.at[0], z - p.at[1]) < p.radius)) n++;
  }
  return n * route.step;
}

/** Area hazards known for a route: only those a revealed site uncovered. */
export function knownAreaHazards(route, revealedIds) {
  const known = new Set(SCOUT_PINS.filter((p) => revealedIds.includes(p.id)).flatMap((p) => p.reveals));
  return route.zones.filter((z) => z.kind === 'area' && known.has(z.id));
}
