import { CLEAR_WEATHER, PASSING_WEATHER, BLOWING_DUST, DUST_FRONT, SHORTCUT_FRONT, WIND_DIRECTION, windSpeedAt } from './weather.js';
import { ROVER, LIFE_SUPPORT, HAB, SITE, SLOPE_CLASSES, SURPRISES } from '../config/mission.js';
import { clamp, DEG, wrapAngle } from '../core/math.js';
import { consumptionEstimate } from '../physics/traverse.js';
import { forecastReturn, temperatureAt, COLD_WORK_LIMIT_C } from './legCheck.js';

// ---------------------------------------------------------------------------
// EVA state machine + consumables.
//
//   brief ─▶ drive ⇄ walk ─▶ complete (End EVA near the habitat)
//              └─▶ gate (an obstacle the map could not show) ─▶ drive
//
// The rover drives freely over the terrain: the planned route is guidance, not
// a rail. Speed is governed by the ground under the rover (slope, mapped area
// hazards) and the rover will not climb ground steeper than STEEP_BLOCK.
// The crew can walk anywhere. Completing either the specimen collection or
// the instrument program finishes a station. `s` is crew progress projected onto the
// planned route, kept for the route displays.
//
// Unsurveyed ground hides one obstacle per patch (SURPRISES): the rover meets
// it somewhere inside the patch, whatever line it drives, and dealing with it
// costs time and oxygen. When a station's work is done and more stations lie
// ahead, the crew picks the next leg on the wrist navigator (sim/legCheck.js).
// ---------------------------------------------------------------------------

const BOOST = ROVER.timeBoost ?? 3;
export const STEEP_BLOCK = 32; // degrees: above the steepest ground any planned route crosses (Gale shortest ≈ 29°)
export const STATION_RADIUS = 30; // m: entering this ring "arrives" at a station
export const HOME_RADIUS = 30; // m: End EVA is offered inside this ring around the habitat
export const HAB_RADIUS = 10; // m: habitat footprint (collision)
export const WALK = { speed: 1.3, run: 2.4, reach: 2.4, board: 3.4, maxSlope: 32, hardSlope: 18 };
const ROVER_RADIUS = 1.9;
const REVERSE_SPEED = 1.2;
const BOOST_STOP_NEAR = 25; // m: Shift does nothing this close to the next station

// Each unsurveyed patch can reveal one obstacle after the rover drives partway through it.
function hiddenSurprises(route, random) {
  return (route.areaHazards ?? []).filter((hz) => hz.unsurveyed).map((hz) => {
    const kind = SURPRISES[Math.floor(random() * SURPRISES.length) % SURPRISES.length];
    return {
      kind: 'gate',
      hazard: hz,
      after: hz.radius * (0.5 + random() * 0.7), // metres driven inside the patch
      driven: 0,
      found: false,
      ref: {
        ...kind,
        id: `${kind.id}-${hz.id}`,
        surprise: true,
        severity: 'danger',
        limit: hz.limit,
        maxTilt: 0,
        basis: 'Found on site; too small for the orbital map that covers this ground',
      },
    };
  });
}

export class Mission {
  constructor(route, terrain, habAntenna, { random = Math.random, surprises = true, legCheck = true, variableWeather = false, frontSeconds = 0 } = {}) {
    this.route = route;
    this.random = random;
    this.variableWeather = variableWeather;
    this.surprisesOn = surprises;
    this.legCheck = legCheck;
    this.surprises = surprises ? hiddenSurprises(route, random) : [];
    this.surprise = null; // the obstacle the rover is stopped at
    this.legPending = null; // station just finished; the next leg is still to be chosen
    this.lastLeg = null;
    this.terrain = terrain;
    this.habAntenna = habAntenna;
    this.state = 'brief';
    this.rover = { x: 0, z: 0, heading: 0, speed: 0, steer: 0 };
    this.walker = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, speed: 0 };
    this.s = 0;
    this.routeDistance = 0;
    this.speed = 0; // shown on the HUD: rover or walking speed, m/s
    this.cruise = false;
    this.met = 0; // mission elapsed time, s
    this.o2Used = 0; // minutes of consumables used
    this.batteryWh = ROVER.batteryWh;
    this.dose = 0; // µSv
    this.distance = 0; // driven
    this.walked = 0;
    this.samples = 0;
    this.comms = { los: true, margin: 9, timer: 0 };
    this.listeners = [];
    this.activeZones = [];
    this.limit = ROVER.maxSpeed;
    this.limitReason = '';
    this.governed = false;
    this.boosting = false;
    this.boostCharge = 1; // 0–1; drains while Shift is held, refills slowly
    this.boostBlocked = ''; // why Shift does nothing right now
    this.offRoute = false;
    this.blocked = false; // rover facing ground too steep to climb
    this.bumped = 0;
    this.artifacts = [];
    this.collected = [];
    this._brakeHeld = 0;
    this.leftHome = false;
    this._zoneIds = new Set();
    this._searchTimer = 0;
    this.detectedObstacles = [];
    this._weather = CLEAR_WEATHER;
    this.frontUntilMet = frontSeconds;
    const forecastDelay = route.weatherExposure ? frontSeconds : 0;
    this._weatherAt = variableWeather ? forecastDelay + 15 + random() * 20 : Infinity;
  }

  get weather() {
    return this.dustWarning ? DUST_FRONT : this.weatherAt(this.s, this.met, this.route, this.onFoot ? this.walker : this.rover);
  }

  // Project only weather already observed or forecast on the route.
  weatherAt(s, met, route = this.route, position) {
    const zone = route.weatherExposure;
    if (met < this.frontUntilMet) {
      const patch = position && route.areaHazards?.find(hazard => hazard.unsurveyed);
      if (patch ? Math.hypot(position.x - patch.cx, position.z - patch.cz) <= patch.radius
        : zone && s >= zone.from && s <= zone.to) return SHORTCUT_FRONT;
    }
    return met < this._weatherAt ? this._weather : CLEAR_WEATHER;
  }

  get activeFront() {
    return this.met < this.frontUntilMet ? this.route.weatherExposure : null;
  }

  get weatherRemainingSeconds() {
    const weather = this.weather;
    if (weather === SHORTCUT_FRONT) return this.frontUntilMet - this.met;
    if (weather === CLEAR_WEATHER || weather === DUST_FRONT) return 0;
    return Math.max(0, this._weatherAt - this.met);
  }

  get waitSeconds() {
    if (this.activeFront && this.s <= this.activeFront.to) return this.frontUntilMet - this.met;
    return this.weatherRemainingSeconds;
  }

  waitForWeather() {
    const seconds = this.waitSeconds;
    if ((!this.canExit && this.state !== 'gate') || !Number.isFinite(seconds) || seconds <= 0) return false;
    const forecast = forecastReturn(this, { waitSeconds: seconds, homeOnly: true });
    if (!forecast.reserveOK || forecast.batteryPct < 10 || forecast.daylightMinutes < -30) return false;
    this.rover.speed = this.speed = 0;
    this.cruise = false;
    this._consume(seconds);
    this.emit('log', { text: `Waited in rover · ${Math.ceil(seconds / 60)} min · ${this.weather.label}`, tone: 'info' });
    return true;
  }

  on(fn) {
    this.listeners.push(fn);
  }
  emit(type, payload = {}) {
    for (const fn of this.listeners) fn(type, payload);
  }

  get onFoot() { return this.state === 'walk'; }
  get stations() { return this.route.stations.filter((st) => !st.final); }
  get home() { return this.route.stations.find((st) => st.final) ?? null; }

  // The next station in plan order that still has work; the habitat once all are done.
  get nextStation() {
    if (this.aborted) return this.home;
    return this.stations.find((st) => !st.done && !st.skipped) ?? this.home;
  }
  get nextStop() {
    const st = this.nextStation;
    return st ? { kind: 'station', s: st.s, ref: st } : null;
  }
  // What the displays may show next: the obstacle while stopped at one, else the next station.
  get nextKnownStop() {
    if (this.surprise) return this.surprise;
    const spotted = this.detectedObstacles.find(sp => !sp.found &&
      Math.hypot(this.rover.x - sp.hazard.cx, this.rover.z - sp.hazard.cz) <= sp.hazard.radius);
    if (spotted) return spotted;
    return this.nextStop;
  }
  // The station whose area the crew is in, if any.
  get currentStation() {
    if (!this.pos) return null;
    return this.stations.find((st) => Math.hypot(st.x - this.pos.x, st.z - this.pos.z) < STATION_RADIUS) ?? null;
  }
  // Back at the habitat after having been out (the EVA starts inside this ring).
  get atHome() {
    return Boolean(this.pos) && this.leftHome && Math.hypot(this.pos.x - HAB.x, this.pos.z - HAB.z) < HOME_RADIUS;
  }
  get canExit() { return this.state === 'drive' && Math.abs(this.rover.speed) < 0.3; }
  get canBoard() {
    return this.state === 'walk' && Math.hypot(this.walker.x - this.rover.x, this.walker.z - this.rover.z) < WALK.board;
  }
  get o2Remaining() {
    return LIFE_SUPPORT.evaHours * 60 - this.o2Used;
  }
  get batteryPct() {
    return (this.batteryWh / ROVER.batteryWh) * 100;
  }
  get lmst() {
    return SITE.lmstStart + this.met / 60;
  }

  get scienceResults() {
    return this.route.stations.filter(st => !st.final).flatMap(st => st.tasks
      .filter(task => task.done || task.skipped || st.skipped || this.aborted || this.state === 'complete').map(task => ({
        station: st.id, task: task.label,
        result: task.done || task.deferred ? task.result : this.aborted ? 'Not performed · crew chose to head home' : 'Not performed · omitted from selected station plan',
        quality: task.quality ?? 'nominal', status: task.done ? 'complete' : task.deferred ? 'deferred' : 'skipped',
      })));
  }

  get outsideMinutes() {
    return this._outsideWeather === this.weather && this._outsideWeatherUntil === this._weatherAt ? this._outsideMinutes ?? 0 : 0;
  }

  // Both instrument work and collecting a find spend the same outside and return budgets.
  _workBudget(task) {
    const forecast = forecastReturn(this, { workMinutes: task.minutes, homeOnly: true });
    const left = (this.weather.exposureMinutes ?? Infinity) - this.outsideMinutes;
    const outside = task.outside !== false;
    const reason = outside && task.minutes > left ? `Needs ${task.minutes} min outside; ${Math.max(0, Math.floor(left))} min left in cold window`
      : outside && temperatureAt(this.lmst + task.minutes) < COLD_WORK_LIMIT_C ? `Work ends below ${COLD_WORK_LIMIT_C} °C; head home`
      : this.dustWarning ? 'Dust front: head home'
      : !forecast.reserveOK ? 'Return would breach the oxygen reserve'
      : forecast.batteryPct < 10 ? 'Return would breach the 10% battery margin'
      : forecast.daylightMinutes < -30 ? 'Return would be after twilight' : '';
    return { reason, forecast };
  }

  get stationOptions() {
    const st = this.currentStation;
    if ((!this.canExit && !this.onFoot) || !st || st.skipped || this.aborted) return [];
    const options = st.tasks.flatMap((task, index) => {
      if (task.done || task.skipped || task.artifact) return [];
      const { reason, forecast } = this._workBudget(task);
      const outside = task.outside !== false;
      const dust = task.panorama && this.weather.visibilityM < 1000;
      return [{ id: `task:${index}`, label: `${/^collect/i.test(task.label) && st.id === 'S2' ? 'Sample first · ' : 'Do '}${task.label}`,
        detail: dust ? 'Dust will obscure fine detail; this panorama will be marked degraded' : `${task.minutes} min ${outside ? 'outside' : 'work'}`,
        workMinutes: task.minutes, waitSeconds: 0, forecast, allowed: !reason, reason }];
    });
    if (st.tasks.some(task => task.panorama && !task.done && !task.skipped)) options.push({
      id: 'defer-panorama', label: 'Defer panorama', detail: 'Record the missed observation and continue with other tasks',
      workMinutes: 0, waitSeconds: 0, forecast: forecastReturn(this, { homeOnly: true }), allowed: true, reason: '',
    });
    if (this.canExit && this.waitSeconds > 0 && !this.dustWarning) {
      const forecast = forecastReturn(this, { waitSeconds: this.waitSeconds, homeOnly: true });
      const allowed = forecast.reserveOK && forecast.batteryPct >= 10 && forecast.daylightMinutes >= -30;
      options.push({ id: 'wait', label: 'Wait in rover for clear weather', detail: 'Suit oxygen and rover hotel power keep running',
        workMinutes: 0, waitSeconds: this.waitSeconds, forecast, allowed,
        reason: allowed ? '' : 'Waiting would breach oxygen, battery or daylight limits' });
    }
    options.push({ id: 'home', label: 'Head home now', detail: 'End science work and navigate back to HAB',
      workMinutes: 0, waitSeconds: 0, forecast: forecastReturn(this, { homeOnly: true }), allowed: true, reason: '' });
    return options;
  }

  chooseStationAction(id) {
    const option = this.stationOptions.find(option => option.id === id);
    if (!option?.allowed) return false;
    const st = this.currentStation;
    if (id.startsWith('task:')) return this._finishStationTask(st.tasks[Number(id.slice(5))]);
    if (id === 'wait') return this.waitForWeather();
    if (id === 'home') return this.returnToHabitat();
    const task = st.tasks.find(task => task.panorama && !task.done && !task.skipped);
    task.skipped = true;
    task.deferred = true;
    task.result = `Panorama deferred by crew · ${this.weather.label}; no panorama acquired`;
    this.emit('log', { text: `${st.id} · ${task.result}`, tone: 'warn' });
    this.emit('task', { station: st, task });
    this._stationComplete(st, task);
    return true;
  }

  start() {
    // Routes can start at the habitat centre; park at their first clear departure point.
    let p = this.route.sample(0);
    while (Math.hypot(p.x - HAB.x, p.z - HAB.z) < HAB_RADIUS + ROVER_RADIUS && this.s + this.route.step <= this.route.length) {
      this.s += this.route.step;
      p = this.route.sample(this.s);
    }
    Object.assign(this.rover, { x: p.x, z: p.z, heading: Math.atan2(-p.tx, -p.tz), speed: 0, steer: 0 });
    this.pos = { x: p.x, y: this.terrain.heightAt?.(p.x, p.z) ?? 0, z: p.z };
    this.state = 'drive';
    const science = this.stations.length;
    this.emit('log', { text: `${this.route.site?.eva ?? SITE.eva} started · planned route ${Math.round(this.route.length)} m · ${science} station${science === 1 ? '' : 's'}`, tone: 'info' });
    this.emit('state', { state: this.state });
  }

  // Collections and instrument observations are two ways to complete a station.
  setArtifacts(artifacts) {
    this.artifacts = artifacts;
    for (const st of this.stations) {
      const mine = artifacts.filter((a) => a.stationId === st.id);
      if (!mine.length) continue;
      st.tasks = st.tasks.filter(task => !task.artifact).concat(mine.map((a) => ({ label: `Collect ${a.name}`, minutes: a.minutes, artifact: a, result: a.note, progress: 0, done: false })));
    }
  }

  // ---------------------------------------------------------------- crew actions
  exitRover() {
    if (!this.canExit) return false;
    const r = this.rover;
    // Step out on the driver's (left) side.
    const side = 2.1;
    this.walker.x = r.x - Math.cos(r.heading) * side;
    this.walker.z = r.z + Math.sin(r.heading) * side;
    this.walker.yaw = r.heading;
    this.walker.vx = this.walker.vz = this.walker.speed = 0;
    r.speed = 0;
    this.cruise = false;
    this.state = 'walk';
    this.pos = { x: this.walker.x, y: this.terrain.heightAt(this.walker.x, this.walker.z), z: this.walker.z };
    this.emit('log', { text: 'Crew out of the rover · on foot', tone: 'info' });
    this.emit('state', { state: this.state });
    return true;
  }

  boardRover() {
    if (!this.canBoard) return false;
    this.state = 'drive';
    this.rover.speed = 0;
    this.pos = { x: this.rover.x, y: this.terrain.heightAt(this.rover.x, this.rover.z), z: this.rover.z };
    this.emit('log', { text: 'Crew aboard · rover ready', tone: 'info' });
    this.emit('state', { state: this.state });
    return true;
  }

  endEva() {
    if (!['drive', 'walk'].includes(this.state) || !this.atHome) return false;
    this.legPending = null;
    const home = this.home;
    if (home) {
      for (const task of home.tasks.filter(t => !t.done && !t.skipped)) {
        this._consume(task.minutes * 60, { work: true });
        task.done = true;
        task.progress = 1;
      }
      home.done = true;
    }
    if (this.stations.some(st => !st.done && !st.skipped)) this.aborted = true;
    this.rover.speed = this.speed = 0;
    this.state = 'complete';
    this.emit('log', { text: 'EVA complete. Welcome home.', tone: 'ok' });
    this.emit('state', { state: this.state });
    return true;
  }

  // Keep the crew where they are; redirect the navigator toward the habitat.
  returnToHabitat() {
    if (!['drive', 'walk'].includes(this.state) || this.aborted || this.atHome || !this.leftHome) return false;
    this.aborted = true;
    if (this.dustWarning) {
      this._weather = BLOWING_DUST;
      this._weatherAt = this.met + 45;
    }
    this.dustWarning = false;
    this.cruise = false;
    this.rover.speed = this.speed = 0;
    this.legPending = null;
    this.retracing = this.route.retracesOutbound !== false && this.s < this.route.length / 2;
    if (this.state === 'drive' && this.retracing) this.rover.heading += Math.PI;
    this.emit('log', { text: this.retracing ? 'Returning along the outbound track' : 'Returning to habitat', tone: 'warn' });
    this.emit('state', { state: this.state });
    return true;
  }

  // Deal with an obstacle the rover is stopped at (time and oxygen), then drive on.
  acknowledge() {
    if (this.state !== 'gate' || !this.surprise) return false;
    const z = this.surprise.ref;
    z.acknowledged = true;
    this._consume(z.delayMinutes * 60, { work: true });
    this.emit('log', { text: `${z.type} cleared · +${z.delayMinutes} min`, tone: 'warn' });
    this.surprise = null;
    this.state = 'drive';
    this.emit('state', { state: this.state });
    return true;
  }

  // Apply the leg the crew picked after a station (see sim/legCheck.js).
  //   continue: every artifact at the next station · quick: the first one only
  //   skip: pass the next station by · home: no more stations
  chooseLeg(option) {
    if (!this.legPending || !option?.allowed) return false;
    const ahead = this.stations.filter((st) => !st.done && !st.skipped && st !== this.legPending);
    if (option.id === 'quick' && ahead[0]) {
      const pending = ahead[0].tasks.filter(task => !task.done && !task.skipped);
      const keep = pending.find(task => task.artifact) ?? pending[0];
      for (const task of pending) if (task !== keep) task.skipped = true;
    }
    if (option.id === 'skip' && ahead[0]) ahead[0].skipped = true;
    if (option.id === 'home') {
      ahead.forEach((st) => { st.skipped = true; });
      this.returnToHabitat();
    }
    for (const st of ahead) if (!st.skipped && st.tasks.every((t) => t.done || t.skipped)) st.done = true;
    this.lastLeg = option.id;
    this.legPending = null;
    const next = this.nextStation;
    this.emit('log', { text: `Leg confirmed: ${option.label} · next: ${next && !next.final ? `${next.id} · ${next.name}` : 'HAB'}`, tone: 'ok' });
    this.emit('leg', { option });
    return true;
  }

  // Take over a new planned route (a different path picked for the leg ahead).
  // Stations keep their identity, work and artifacts; the crew stays where it is.
  replaceRoute(route) {
    for (const st of route.stations) {
      const before = this.route.stations.find((old) => old.id === st.id);
      if (!before) continue;
      st.tasks = before.tasks;
      st.done = before.done;
      st.skipped = before.skipped;
      st.visited = before.visited;
      if (this.legPending === before) this.legPending = st;
    }
    const found = this.surprises.filter((sp) => sp.ref.detected || sp.driven > 0);
    const fresh = this.surprisesOn ? hiddenSurprises(route, this.random).filter((sp) => !found.some((f) => f.hazard.id === sp.hazard.id)) : [];
    this.route = route;
    this.surprises = [...found, ...fresh];
    this._zoneIds = new Set();
    this._searchTimer = 0;
    if (this.pos) {
      // Find the crew on the new plan from scratch.
      this.s = 0;
      this._track(0, true);
    }
  }

  collectionBlockReason(artifact) {
    if (!artifact) return 'No find selected';
    if (artifact.collected) return 'Already collected';
    if (this.aborted) return 'Science ended · returning to habitat';
    if (!this.onFoot) return 'Leave the rover to collect this find';
    if (Math.hypot(this.walker.x - artifact.x, this.walker.z - artifact.z) > WALK.reach) return 'Move closer to the find';
    return this._workBudget(artifact).reason;
  }

  collect(artifact) {
    const reason = this.collectionBlockReason(artifact);
    if (reason) {
      this.emit('log', { text: reason, tone: 'warn' });
      return false;
    }
    artifact.collected = true;
    this.collected.push(artifact);
    this.samples++;
    this._consume(artifact.minutes * 60, { work: true, outside: true });
    const st = artifact.stationId ? this.stations.find((x) => x.id === artifact.stationId) : null;
    const task = st?.tasks.find((t) => t.artifact === artifact);
    if (task) { task.done = true; task.skipped = false; task.progress = 1; }
    this.emit('log', { text: `${st ? `${st.id} ✓ ` : ''}Collected ${artifact.name}`, tone: 'ok' });
    this.emit('artifact', { artifact, station: st });
    if (task) this._stationComplete(st, task);
    return true;
  }

  _stationComplete(st, task) {
    const group = st.tasks.filter(t => Boolean(t.artifact) === Boolean(task.artifact));
    if (st.done || !group.every(t => t.done || t.skipped)) return;
    st.done = true;
    st.skipped = false;
    const ahead = this.stations.some(x => !x.done && !x.skipped);
    if (this.legCheck && ahead) {
      this.legPending = st;
      this.emit('log', { text: `${st.id} complete · choose the next leg on your wrist navigator [P]`, tone: 'info' });
      this.emit('station', { station: st, done: true });
      this.emit('legcheck', { station: st });
    } else {
      this.emit('log', { text: `${st.id} complete · next: ${this.nextStation?.name ?? 'habitat'}`, tone: 'ok' });
      this.emit('station', { station: st, done: true });
    }
  }

  // ---------------------------------------------------------------- per frame
  _consume(seconds, options = {}) {
    const consumed = consumptionEstimate(seconds, options);
    let outsideFrom = this.met;
    this.met += seconds;
    this.o2Used += consumed.oxygenMinutes;
    this.dose += LIFE_SUPPORT.doseRateUsvH * (seconds / 3600);
    this.batteryWh = Math.max(0, this.batteryWh - consumed.batteryWh);
    if (!this.dustWarning && this.met >= this._weatherAt) {
      // A long science task crosses the same weather events as driving minute by minute.
      do {
        outsideFrom = this._weatherAt;
        this._weather = this._weather === CLEAR_WEATHER
          ? PASSING_WEATHER[Math.floor(this.random() * PASSING_WEATHER.length)] : CLEAR_WEATHER;
        if (!this.variableWeather) this._weatherAt = Infinity; // the scripted return has only one storm
        else this._weatherAt += this._weather === CLEAR_WEATHER ? 45 + this.random() * 45
          : this._weather === PASSING_WEATHER[0] ? 25 + this.random() * 15 : 12 * 60 + this.random() * 8 * 60;
      } while (this.met >= this._weatherAt);
      const clearing = this._weather === CLEAR_WEATHER;
      this.emit('log', {
        text: clearing ? 'Weather cleared · normal operations resumed'
          : Number.isFinite(this._weather.exposureMinutes) ? `Cold spell · outside work limited to ${this._weather.exposureMinutes} min`
            : `${this._weather.label} · speed limited to ${this._weather.speedLimit} m/s`,
        tone: clearing ? 'ok' : 'warn',
      });
    }
    if (options.outside && Number.isFinite(this.weather.exposureMinutes)) {
      this._outsideMinutes = this.outsideMinutes + (this.met - outsideFrom) / 60;
      this._outsideWeather = this.weather;
      this._outsideWeatherUntil = this._weatherAt;
    }
  }

  // input: { throttle, brake, steer, boost } when driving;
  //        { forward, strafe, run, viewYaw } (or throttle/brake/steer/boost) when walking.
  update(dt, input, roverPitchDeg = 0) {
    if (this.state === 'brief' || this.state === 'complete') return;
    if (this.state === 'drive') this._drive(dt, input, roverPitchDeg);
    else if (this.state === 'walk') this._walk(dt, input);
    else this._consume(dt);
    if (this.pos) {
      this._track(dt);
      this._stations();
    }
    this._comms(dt);
  }

  // Ground under (x, z): slope class and mapped area hazards → speed limit.
  _ground(x, z, heading) {
    const T = this.terrain;
    const fx = -Math.sin(heading), fz = -Math.cos(heading);
    const rx = Math.cos(heading), rz = -Math.sin(heading);
    const h = (a, b) => T.heightAt(x + fx * a + rx * b, z + fz * a + rz * b);
    const pitch = Math.atan2(h(1.5, 0) - h(-1.5, 0), 3);
    const roll = Math.atan2(h(0, 1) - h(0, -1), 2);
    const tilt = Math.atan(Math.hypot(Math.tan(pitch), Math.tan(roll))) * DEG;
    const zones = [];
    if (tilt >= SLOPE_CLASSES.danger) zones.push({ id: 'SLOPE', type: 'STEEP SLOPE', severity: 'danger', limit: ROVER.dangerSlopeSpeed });
    else if (tilt >= SLOPE_CLASSES.caution) zones.push({ id: 'SLOPE', type: 'MODERATE SLOPE', severity: 'caution', limit: ROVER.cautionSpeed });
    for (const hz of this.route.areaHazards ?? []) {
      if (Math.hypot(x - hz.cx, z - hz.cz) > hz.radius) continue;
      zones.push({ id: hz.id, type: hz.type, severity: hz.severity, limit: hz.limit, procedure: hz.procedure, obstacles: hz.obstacles, basis: hz.basis, area: true });
    }
    return { pitch: pitch * DEG, roll: roll * DEG, tilt, zones };
  }

  _drive(dt, input, pitchDeg) {
    const r = this.rover;
    const weather = this.weather;
    const ground = this._ground(r.x, r.z, r.heading);
    // Shift speeds up time, but only on easy ground, away from the next station, and only for a short while.
    const st = this.nextStation;
    const stopNear = st && !st.final && Math.hypot(st.x - r.x, st.z - r.z) < BOOST_STOP_NEAR;
    const empty = this.boostCharge <= 0.02 || (this._boostEmpty && this.boostCharge < 0.3);
    this._boostEmpty = empty;
    this.boostBlocked = !input.boost ? '' : ground.zones.length ? 'HAZARD STRETCH' : stopNear ? 'STOP AHEAD' : empty ? 'RECHARGING' : '';
    this.boosting = Boolean(input.boost) && !this.boostBlocked;
    if (this.boosting) this.boostCharge = Math.max(0, this.boostCharge - dt / (ROVER.boostSeconds ?? 12));
    else this.boostCharge = Math.min(1, this.boostCharge + dt / (ROVER.boostRechargeSeconds ?? 20));
    const sdt = dt * (this.boosting ? BOOST : 1);
    const throttle = !this.dustWarning && (input.throttle || this.cruise);
    const brake = this.dustWarning || input.brake;
    if (brake) this.cruise = false;
    this._brakeHeld = brake && r.speed <= 0.05 ? this._brakeHeld + dt : 0;

    let limit = ROVER.maxSpeed;
    let reason = '';
    for (const z of ground.zones) if (z.limit < limit) { limit = z.limit; reason = z.type; }
    if (weather.speedLimit < limit) { limit = weather.speedLimit; reason = weather.label; }
    this.limit = limit;

    let v = r.speed;
    const slopeDrag = 3.71 * Math.sin(pitchDeg / DEG) * 0.25 * Math.sign(v || 1);
    if (v >= 0) {
      if (throttle && !brake) v += ROVER.accel * sdt;
      else if (brake) v -= ROVER.brake * sdt;
      else v -= ROVER.coast * sdt;
      v -= slopeDrag * sdt;
      if (v > limit) v = Math.max(limit, v - ROVER.brake * 1.3 * sdt);
      // Hold brake at a standstill to reverse.
      if (v <= 0) v = brake && !this.dustWarning && this._brakeHeld > 0.35 ? -0.01 : 0;
    } else {
      if (brake && !this.dustWarning) v = Math.max(-REVERSE_SPEED, v - ROVER.accel * 0.6 * sdt);
      else v = Math.min(0, v + (throttle ? ROVER.brake : ROVER.coast * 3) * sdt);
    }
    v = clamp(v, -Math.min(REVERSE_SPEED, limit), ROVER.maxSpeed);
    this.governed = throttle && limit < ROVER.maxSpeed - 0.01 && v >= limit - 0.15;
    this.limitReason = reason;

    // Steering: bicycle model, the wheels turn in over ~0.3 s.
    r.steer += (clamp(input.steer || 0, -1, 1) * 0.5 - r.steer) * Math.min(1, dt * 6);
    const heading = r.heading;
    const crosswind = windSpeedAt(weather, this.met) * (Math.cos(heading) * WIND_DIRECTION.x - Math.sin(heading) * WIND_DIRECTION.z);
    // A small steering bias keeps correction familiar and reverses yaw correctly when backing up.
    r.heading -= (v * (Math.tan(r.steer) + crosswind * 0.003) / ROVER.wheelbase) * sdt;

    // Ground the rover cannot climb: stop before driving onto it.
    const dir = Math.sign(v);
    this.blocked = false;
    if (dir) {
      const ahead = this._ground(r.x - Math.sin(r.heading) * 2.6 * dir, r.z - Math.cos(r.heading) * 2.6 * dir, r.heading);
      if (ahead.tilt > STEEP_BLOCK && ahead.tilt > ground.tilt) {
        this.blocked = true;
        v = 0;
      }
    }
    if (throttle && !this.dustWarning) {
      const front = this._ground(r.x - Math.sin(r.heading) * 2.6, r.z - Math.cos(r.heading) * 2.6, r.heading);
      if (front.tilt > STEEP_BLOCK && front.tilt > ground.tilt) this.blocked = true;
    }
    if (!v) r.heading = heading;
    r.speed = v;
    this.speed = Math.abs(v);

    const px = r.x, pz = r.z;
    r.x += -Math.sin(r.heading) * v * sdt;
    r.z += -Math.cos(r.heading) * v * sdt;
    this._contain(r, HAB_RADIUS + ROVER_RADIUS, true);
    const moved = Math.hypot(r.x - px, r.z - pz);
    this.distance += moved;
    this._consume(sdt, { moving: moved, pitch: (pitchDeg / DEG) * (dir || 1) });
    this.pos = { x: r.x, y: this.terrain.heightAt(r.x, r.z), z: r.z };
    this._zones(ground.zones);
    this._hidden(moved);
  }

  // Driving across unsurveyed ground: meet its hidden obstacle part of the way in.
  _hidden(moved) {
    const r = this.rover;
    for (const sp of this.surprises) {
      if (sp.found || Math.hypot(r.x - sp.hazard.cx, r.z - sp.hazard.cz) > sp.hazard.radius) continue;
      sp.driven += moved;
      const remaining = Math.max(0, sp.after - sp.driven);
      const range = Math.min(35, this.weather.visibilityM * 0.035);
      if (!sp.ref.detected && remaining <= range) {
        sp.ref.detected = true;
        sp.ref.at = { x: r.x - Math.sin(r.heading) * remaining * Math.sign(r.speed || 1), z: r.z - Math.cos(r.heading) * remaining * Math.sign(r.speed || 1) };
        sp.s = this.route.nearestS(sp.ref.at.x, sp.ref.at.z);
        this.detectedObstacles.push(sp);
        this.emit('log', { text: `Mast camera spotted ${sp.ref.type.toLowerCase()} · ${Math.round(remaining)} m ahead`, tone: 'warn' });
      }
      if (remaining > 0) continue;
      sp.found = true;
      sp.ref.maxTilt = this._ground(r.x, r.z, r.heading).tilt;
      sp.ref.at = { x: r.x, z: r.z };
      sp.s = this.route.nearestS(r.x, r.z);
      this.surprise = sp;
      r.speed = this.speed = 0;
      this.cruise = false;
      this.state = 'gate';
      this.emit('log', { text: `NOT ON THE MAP — ${sp.ref.type}`, tone: 'danger' });
      this.emit('state', { state: this.state, surprise: sp.ref });
      return;
    }
  }

  _walk(dt, input) {
    const w = this.walker;
    const yaw = input.viewYaw ?? w.yaw;
    const forward = input.forward ?? ((input.throttle ? 1 : 0) - (input.brake ? 1 : 0));
    const strafe = input.strafe ?? (input.steer || 0);
    const run = input.run ?? input.boost;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let mx = fx * forward + rx * strafe;
    let mz = fz * forward + rz * strafe;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    const ground = this._ground(w.x, w.z, len ? Math.atan2(-mx, -mz) : yaw);
    let top = run ? WALK.run : WALK.speed;
    if (ground.tilt > WALK.hardSlope) top *= 0.55;
    // Accelerate toward the wanted velocity (suits are heavy, footing loose).
    const k = Math.min(1, dt * 5);
    w.vx += (mx * top - w.vx) * k;
    w.vz += (mz * top - w.vz) * k;
    if (len) {
      const ahead = this._ground(w.x + mx * 1.2, w.z + mz * 1.2, Math.atan2(-mx, -mz));
      if (ahead.tilt > WALK.maxSlope && ahead.tilt > ground.tilt) { w.vx = w.vz = 0; this.blocked = true; } else this.blocked = false;
    } else this.blocked = false;
    const px = w.x, pz = w.z;
    w.x += w.vx * dt;
    w.z += w.vz * dt;
    w.yaw = yaw;
    // Walk around the rover and the habitat, not through them.
    const d = Math.hypot(w.x - this.rover.x, w.z - this.rover.z);
    if (d < ROVER_RADIUS) {
      const nx = (w.x - this.rover.x) / (d || 1), nz = (w.z - this.rover.z) / (d || 1);
      w.x = this.rover.x + nx * ROVER_RADIUS;
      w.z = this.rover.z + nz * ROVER_RADIUS;
    }
    this._contain(w, HAB_RADIUS, false);
    const moved = Math.hypot(w.x - px, w.z - pz);
    w.speed = moved / Math.max(dt, 1e-6);
    this.speed = w.speed;
    this.walked += moved;
    this.governed = false;
    this.limit = top;
    this.limitReason = '';
    this._consume(dt, { work: true, outside: true });
    this.pos = { x: w.x, y: this.terrain.heightAt(w.x, w.z), z: w.z };
    this._zones(ground.zones.filter((z) => z.id !== 'SLOPE' || z.severity === 'danger'));
  }

  // Keep a body inside the mapped terrain and outside the habitat footprint.
  _contain(body, habRadius, isRover) {
    const b = this.terrain.innerBounds;
    if (b) {
      body.x = clamp(body.x, b.x0 + 20, b.x1 - 20);
      body.z = clamp(body.z, b.z0 + 20, b.z1 - 20);
    }
    const d = Math.hypot(body.x - HAB.x, body.z - HAB.z);
    if (d < habRadius) {
      const nx = (body.x - HAB.x) / (d || 1), nz = (body.z - HAB.z) / (d || 1);
      body.x = HAB.x + nx * habRadius;
      body.z = HAB.z + nz * habRadius;
      if (isRover && Math.abs(body.speed) > 0.5) this.bumped = 0.6;
      if (isRover) body.speed *= 0.3;
    }
    this.bumped = Math.max(0, this.bumped - 1 / 60);
  }

  _zones(now) {
    const ids = new Set(now.map((z) => `${z.id}:${z.severity}`));
    for (const z of now) {
      if (!this._zoneIds.has(`${z.id}:${z.severity}`)) {
        this.emit('log', { text: `Entering ${z.type} · limit ${z.limit} m/s`, tone: z.severity === 'danger' ? 'danger' : 'warn' });
      }
    }
    if (this._zoneIds.size && !ids.size) this.emit('log', { text: 'Hazard zones cleared', tone: 'ok' });
    this._zoneIds = ids;
    this.activeZones = now;
  }

  // Project the crew's position onto the planned route (route displays, guidance).
  _track(dt, full = false) {
    const R = this.route;
    if (!R.count) return;
    const { x, z } = this.pos;
    // Where an out-and-back route overlaps itself, the leg running the way the
    // rover drives wins.
    const r = this.rover;
    const moving = this.state === 'drive' && Math.abs(r.speed) > 0.3;
    const dx = moving ? -Math.sin(r.heading) * Math.sign(r.speed) : 0;
    const dz = moving ? -Math.cos(r.heading) * Math.sign(r.speed) : 0;
    const best = (i0, i1) => {
      let bi = this.s / R.step, bd = Infinity, be = Infinity;
      for (let i = Math.max(0, i0); i <= Math.min(R.count - 1, i1); i++) {
        const d = Math.hypot(R.x[i] - x, R.z[i] - z);
        const e = d + (R.tx[i] * dx + R.tz[i] * dz < -0.3 ? 6 : 0);
        if (e < be) { be = e; bd = d; bi = i; }
      }
      return [bi, bd];
    };
    // Search mostly ahead, so out-and-back routes whose legs overlap keep their direction.
    const at = Math.round(this.s / R.step);
    const ahead = Math.ceil(80 / R.step), behind = Math.ceil(12 / R.step);
    let [i, d] = this.retracing ? best(at - ahead, at + behind) : best(at - behind, at + ahead);
    this._searchTimer -= dt;
    if (full || (d > 40 && this._searchTimer <= 0)) {
      // Far from the last known stretch: search the whole route once in a while.
      this._searchTimer = 0.5;
      [i, d] = best(0, R.count - 1);
    }
    // Refine onto the neighbouring segments so progress is continuous between samples.
    let proj = i * R.step;
    let near = Infinity;
    for (const j of [i - 1, i]) {
      if (j < 0 || j + 1 >= R.count) continue;
      const ax = R.x[j], az = R.z[j], vx = R.x[j + 1] - ax, vz = R.z[j + 1] - az;
      const t = clamp(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1), 0, 1);
      const dd = Math.hypot(x - ax - vx * t, z - az - vz * t);
      if (dd < near) { near = dd; proj = (j + t) * R.step; }
    }
    this.s = clamp(proj, 0, R.length);
    if (Math.hypot(x - HAB.x, z - HAB.z) > HOME_RADIUS + 2) this.leftHome = true;
    this.routeDistance = d;
    this.offRoute = d > 15;
  }

  _stations() {
    for (const st of this.stations) {
      if (st.visited || Math.hypot(st.x - this.pos.x, st.z - this.pos.z) > STATION_RADIUS) continue;
      st.visited = true;
      const open = st.tasks.filter(t => t.artifact && !t.done && !t.skipped).length;
      this.emit('log', { text: `Arrived ${st.id} · ${st.name}${open ? ` · get out and collect ${open} artifact${open > 1 ? 's' : ''}` : ''}`, tone: 'ok' });
      this.emit('station', { station: st, done: false });
    }
  }

  // Steering that follows the planned route ahead (tests, demos, the simulate hook).
  autopilot(input = {}) {
    const R = this.route;
    const r = this.rover;
    const p = this.aborted && R.retracesOutbound === false ? HAB
      : R.sample(clamp(this.s + (this.retracing ? -9 : 9), 0, R.length));
    const want = Math.atan2(-(p.x - r.x), -(p.z - r.z));
    const err = wrapAngle(want - r.heading);
    return { throttle: true, brake: false, boost: false, ...input, steer: clamp(-err * 2.2, -1, 1) };
  }

  _finishStationTask(task) {
    const st = this.currentStation;
    const weather = this.weather;
    if (task.panorama && weather.visibilityM < 1000) {
      task.quality = 'dust-degraded';
      task.result = 'Dust-degraded panorama stored · fine beds obscured; repeat observation needed (SIMULATION)';
    } else task.quality = 'nominal';
    task.done = true;
    task.progress = 1;
    this._consume(task.minutes * 60, { work: true, outside: task.outside !== false });
    if (/^collect/i.test(task.label)) this.samples += task.sampleCount ?? 1;
    this.emit('log', { text: `${st.id} ✓ ${task.label} — ${task.result}`, tone: task.quality === 'nominal' ? 'ok' : 'warn' });
    this.emit('task', { station: st, task });
    this._stationComplete(st, task);
    return true;
  }

  // Line-of-sight from the rover's antenna to the habitat mast over the DEM.
  _comms(dt) {
    this.comms.timer -= dt;
    if (this.comms.timer > 0 || !this.pos) return;
    this.comms.timer = 0.3;
    const a = { x: this.pos.x, y: this.pos.y + 2.9, z: this.pos.z };
    const b = this.habAntenna;
    let los = true;
    const N = 40;
    let minClear = Infinity;
    for (let i = 1; i < N; i++) {
      const t = i / N;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t;
      const clear = y - this.terrain.heightAt(x, z);
      minClear = Math.min(minClear, clear);
      if (clear < 0) los = false;
    }
    const dist = Math.hypot(a.x - b.x, a.z - b.z);
    const margin = los ? Math.max(1, 14 - 20 * Math.log10(Math.max(1, dist / 60))) : -3;
    if (los !== this.comms.los) {
      this.emit('log', { text: los ? 'Comms: direct link to HAB restored' : 'Comms: line-of-sight to HAB lost — relay via orbiter', tone: los ? 'ok' : 'warn' });
    }
    this.comms.los = los;
    this.comms.margin = margin;
    this.comms.clearance = minClear;
  }

  walkback() {
    const d = this.pos ? Math.hypot(this.pos.x - HAB.x, this.pos.z - HAB.z) : 0;
    const usable = Math.max(0, this.o2Remaining - LIFE_SUPPORT.reserveMinutes) / 60;
    return { distance: d, limit: usable * LIFE_SUPPORT.walkSpeedKmh * 1000 };
  }
}
