import { CLEAR_WEATHER, PASSING_WEATHER, DUST_FRONT, SHORTCUT_FRONT } from './weather.js';
import { ROVER, LIFE_SUPPORT, HAB, SITE, SURPRISES } from '../config/mission.js';
import { clamp, DEG } from '../core/math.js';
import { consumptionEstimate } from '../physics/traverse.js';
import { forecastReturn, temperatureAt, COLD_WORK_LIMIT_C } from './legCheck.js';

// ---------------------------------------------------------------------------
// Traverse state machine + consumables.
//
//   brief ─▶ drive ─▶ gate (acknowledge hazard briefing) ─▶ drive
//                 └─▶ station (hold to run tasks) ─▶ stationDone ─▶ legcheck (choose next leg) ─▶ drive
//                                                       └─(HAB)─▶ complete
// ---------------------------------------------------------------------------

const TASK_HOLD_SECONDS = 2.0;

// One hidden obstacle per unsurveyed zone on the route, somewhere in its middle part.
function hiddenSurprises(route, random) {
  return (route.zones ?? []).filter((zone) => zone.unsurveyed).map((zone) => {
    const kind = SURPRISES[Math.floor(random() * SURPRISES.length) % SURPRISES.length];
    const s = zone.s0 + (zone.s1 - zone.s0) * (0.3 + random() * 0.4);
    const i = Math.min(route.count - 1, Math.round(s / route.step));
    return {
      kind: 'gate',
      s,
      ref: {
        ...kind,
        id: `${kind.id}-${zone.id}`,
        surprise: true,
        severity: 'danger',
        s0: s,
        s1: s + 6,
        maxTilt: route.tilt[i],
        limit: zone.limit,
        basis: 'Found on site; too small for the orbital map that covers this ground',
      },
    };
  });
}
const BOOST = ROVER.timeBoost ?? 3;
export class Mission {
  constructor(route, terrain, habAntenna, { random = Math.random, surprises = true, legCheck = true, variableWeather = false, frontSeconds = 0 } = {}) {
    this.route = route;
    this.legCheck = legCheck;
    this.random = random;
    this.surprisesOn = surprises;
    // This drive's stops: the planned ones plus whatever the unsurveyed ground hides (not on any map).
    this.stops = [...(route.stops ?? []), ...(surprises ? hiddenSurprises(route, random) : [])].sort((a, b) => a.s - b.s);
    this.terrain = terrain;
    this.habAntenna = habAntenna;
    this.state = 'brief';
    this.s = 0;
    this.lateral = 0;
    this.yawOff = 0;
    this.speed = 0;
    this.cruise = false;
    this.stopIndex = 0;
    this.met = 0; // mission elapsed time, s
    this.o2Used = 0; // minutes of consumables used
    this.batteryWh = ROVER.batteryWh;
    this.dose = 0; // µSv
    this.distance = 0;
    this.samples = 0;
    this.comms = { los: true, margin: 9, timer: 0 };
    this.listeners = [];
    this.activeZones = [];
    this.limitReason = '';
    this.governed = false;
    this.boosting = false;
    this.boostCharge = 1; // 0–1; drains while Shift is held, refills slowly
    this.boostBlocked = ''; // why Shift does nothing right now
    this.offRoute = false;
    this.taskFlash = null;
    this._zoneIds = new Set();
    this.detectedObstacles = [];
    this.random = random;
    this._weather = CLEAR_WEATHER;
    this.frontUntilMet = route.weatherExposure ? frontSeconds : 0;
    this._weatherAt = variableWeather ? this.frontUntilMet + 15 + random() * 20 : Infinity;
  }

  get weather() {
    return this.dustWarning ? DUST_FRONT : this.weatherAt(this.s, this.met);
  }

  // Project only weather already observed or forecast on the route.
  weatherAt(s, met, route = this.route) {
    const zone = route.weatherExposure;
    if (zone && met < this.frontUntilMet && s >= zone.from && s <= zone.to) return SHORTCUT_FRONT;
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
    if (!['drive', 'gate', 'station', 'legcheck', 'stationDone'].includes(this.state) || !Number.isFinite(seconds) || seconds <= 0) return false;
    this.speed = 0;
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

  get nextStop() {
    return this.stops[this.stopIndex] || null;
  }
  // Keep unseen obstacles off the displays; discoveries stay on the map.
  get nextKnownStop() {
    for (let i = this.stopIndex; i < this.stops.length; i++) {
      const stop = this.stops[i];
      if (!stop.ref.surprise || stop.ref.detected || (i === this.stopIndex && this.state === 'gate')) return stop;
    }
    return null;
  }
  get nextStation() {
    return this.route.stations.find((station) => !station.done && !station.skipped && (!this.aborted || station.final)) || null;
  }
  get currentStation() {
    const st = this.nextStop;
    return st && st.kind === 'station' ? st.ref : null;
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
      .filter(task => task.done || task.skipped || st.skipped || this.aborted).map(task => ({
        station: st.id, task: task.label,
        result: task.done || task.deferred ? task.result : this.aborted ? 'Not performed · crew chose to head home' : 'Not performed · omitted from selected station plan',
        quality: task.quality ?? 'nominal', status: task.done ? 'complete' : task.deferred ? 'deferred' : 'skipped',
      })));
  }

  get outsideMinutes() {
    return this._outsideWeather === this.weather && this._outsideWeatherUntil === this._weatherAt ? this._outsideMinutes ?? 0 : 0;
  }

  get stationOptions() {
    const st = this.currentStation;
    if (this.state !== 'station' || !st) return [];
    const weather = this.weather;
    const options = st.tasks.flatMap((task, index) => {
      if (task.done || task.skipped) return [];
      const outside = !st.final && task.outside !== false;
      const window = weather.exposureMinutes ?? Infinity;
      const exceedsWindow = outside && this.outsideMinutes + task.minutes > window;
      const tooLate = outside && temperatureAt(this.lmst + task.minutes) < COLD_WORK_LIMIT_C;
      const forecast = forecastReturn(this, { workMinutes: task.minutes, includeIngress: !st.final });
      const dust = task.panorama && weather.visibilityM < 1000;
      const reason = exceedsWindow ? `Needs ${task.minutes} min outside; ${Math.max(0, window - this.outsideMinutes)} min left in cold window`
        : tooLate ? `Work ends below ${COLD_WORK_LIMIT_C} °C; head home`
          : this.dustWarning && !st.final ? 'Dust front: head home'
            : !st.final && !forecast.reserveOK ? 'Return would breach the oxygen reserve'
              : !st.final && forecast.batteryPct < 10 ? 'Return would breach the 10% battery margin'
                : !st.final && forecast.daylightMinutes < -30 ? 'Return would be after twilight' : '';
      return [{ id: `task:${index}`, label: `${/^collect/i.test(task.label) && st.id === 'S2' ? 'Sample first · ' : 'Do '}${task.label}`,
        detail: dust ? 'Dust will obscure fine detail; this panorama will be marked degraded' : `${task.minutes} min ${outside ? 'outside' : 'work'}`,
        workMinutes: task.minutes, waitSeconds: 0, forecast, allowed: !reason, reason }];
    });
    if (st.tasks.some(task => task.panorama && !task.done && !task.skipped)) options.push({
      id: 'defer-panorama', label: 'Defer panorama', detail: 'Record the missed observation and continue with other tasks',
      workMinutes: 0, waitSeconds: 0, forecast: forecastReturn(this), allowed: true, reason: '',
    });
    if (this.weatherRemainingSeconds > 0 && !this.dustWarning) {
      const forecast = forecastReturn(this, { waitSeconds: this.weatherRemainingSeconds });
      const allowed = forecast.reserveOK && forecast.batteryPct >= 10 && forecast.daylightMinutes >= -30;
      options.push({ id: 'wait', label: 'Wait in rover for clear weather', detail: 'Suit oxygen and rover hotel power keep running',
        workMinutes: 0, waitSeconds: this.weatherRemainingSeconds, forecast, allowed,
        reason: allowed ? '' : 'Waiting would breach oxygen, battery or daylight limits' });
    }
    if (!st.final) options.push({ id: 'home', label: 'Head home now', detail: 'End science work and drive the remaining route to HAB',
      workMinutes: 0, waitSeconds: 0, forecast: forecastReturn(this), allowed: true, reason: '' });
    return options;
  }

  chooseStationAction(id) {
    const option = this.stationOptions.find(option => option.id === id);
    if (!option?.allowed) return false;
    const st = this.currentStation;
    if (id.startsWith('task:')) return this._finishStationTask(st.tasks[Number(id.slice(5))]);
    if (id === 'wait') {
      const waited = this.waitForWeather();
      if (waited) { this._outsideMinutes = 0; this._outsideWeather = null; }
      return waited;
    }
    if (id === 'home') {
      for (const station of this.route.stations.filter(station => !station.final && !station.done)) {
        station.skipped = station !== st;
        for (const task of station.tasks.filter(task => !task.done && !task.skipped)) {
          task.skipped = true;
          task.result = 'Not performed · crew chose to head home';
        }
      }
      st.done = true;
      this.stops = this.stops.filter((stop, i) => i <= this.stopIndex || !stop.ref.skipped);
      this.stopIndex++;
      this.aborted = true;
      this.state = 'drive';
      this.emit('log', { text: `${st.id} science ended · returning to HAB`, tone: 'warn' });
      this.emit('state', { state: this.state });
      return true;
    }
    const task = st.tasks.find(task => task.panorama && !task.done && !task.skipped);
    task.skipped = true;
    task.deferred = true;
    task.result = `Panorama deferred by crew · ${this.weather.label}; no panorama acquired`;
    this.emit('log', { text: `${st.id} · ${task.result}`, tone: 'warn' });
    this.emit('task', { station: st, task });
    this._stationComplete();
    return true;
  }

  start() {
    this.state = 'drive';
    this.emit('log', { text: `${SITE.eva} started · traverse ${Math.round(this.route.length)} m · ${this.route.stations.length - 1} stations`, tone: 'info' });
    this.emit('state', { state: this.state });
  }

  returnToHabitat() {
    if (this.route.retracesOutbound === false || !['drive', 'gate'].includes(this.state) || this.aborted || this.s <= 1 || this.s >= this.route.length / 2) return false;
    this.s = this.route.length - this.s;
    this.stopIndex = this.stops.findIndex(stop => stop.s >= this.s);
    if (this.stopIndex < 0) this.stopIndex = this.stops.length;
    this.speed = 0;
    this.cruise = false;
    this.lateral = -this.lateral;
    this.yawOff = 0;
    this.aborted = true;
    this.dustWarning = false;
    this.state = 'drive';
    this.emit('log', { text: 'Returning along the outbound track', tone: 'warn' });
    this.emit('state', { state: this.state });
    return true;
  }

  acknowledge() {
    if (this.state === 'gate') {
      const z = this.nextStop.ref;
      z.acknowledged = true;
      if (z.surprise) {
        // dealing with it takes time on site, and the suits keep breathing meanwhile
        this._consume(z.delayMinutes * 60, { work: true });
        this.emit('log', { text: `${z.type} cleared · +${z.delayMinutes} min`, tone: 'warn' });
      } else this.emit('log', { text: `Hazard briefing acknowledged: ${z.type}`, tone: 'warn' });
      this.stopIndex++;
      this.state = 'drive';
      this.emit('state', { state: this.state });
      return true;
    }
    if (this.state === 'stationDone') {
      const st = this.nextStop.ref;
      // more science stops ahead: the crew must pick the next leg on the wrist navigator first
      const ahead = this.route.stations.some((station) => !station.final && !station.done && !station.skipped && station !== st);
      if (!st.final && ahead && this.legCheck) {
        this.state = 'legcheck';
        this.emit('log', { text: `${st.id} complete · choose the next leg on your wrist navigator [P]`, tone: 'info' });
        this.emit('state', { state: this.state, stop: this.nextStop });
        return true;
      }
      this.stopIndex++;
      if (st.final) {
        this.state = 'complete';
        this.emit('log', { text: 'EVA complete. Welcome home.', tone: 'ok' });
      } else {
        this.state = 'drive';
        this.emit('log', { text: `Leaving ${st.id} · next: ${this.nextStation ? this.nextStation.name : 'HAB'}`, tone: 'info' });
      }
      this.emit('state', { state: this.state });
      return true;
    }
    return false;
  }

  // Take over a new route while parked at a station (a different path for the leg ahead).
  // Everything behind the rover is identical, so its position, finished work and time carry over.
  replaceRoute(route) {
    const here = this.nextStop;
    for (const station of route.stations) {
      const before = this.route.stations.find((old) => old.id === station.id);
      if (!before) continue;
      station.done = before.done;
      station.skipped = before.skipped;
      station.tasks.forEach((task, i) => Object.assign(task, before.tasks[i]));
    }
    this.route = route;
    const ahead = route.stops.filter((stop) => stop.s > this.s + 0.5 && !stop.ref.skipped);
    const hidden = this.surprisesOn ? hiddenSurprises(route, this.random).filter((stop) => stop.s > this.s + 0.5) : [];
    const current = route.stops.find((stop) => stop.kind === 'station' && stop.ref.id === here?.ref.id) ?? here;
    this.stops = [current, ...[...ahead, ...hidden].sort((a, b) => a.s - b.s)].filter(Boolean);
    this.stopIndex = 0;
    this._zoneIds = new Set();
  }

  // Apply the leg the crew picked at a station (see sim/legCheck.js), then drive on.
  //   continue: full tasks at the next station · quick: first task only
  //   skip: drive past the next station · home: no more stations
  chooseLeg(option) {
    if (this.state !== 'legcheck' || !option?.allowed) return false;
    const here = this.nextStop.ref;
    const ahead = this.route.stations.filter((station) => !station.final && !station.done && !station.skipped && station !== here);
    if (option.id === 'quick') ahead[0].tasks.filter(task => !task.done && !task.skipped).slice(1).forEach((task) => { task.skipped = true; });
    if (option.id === 'skip') ahead[0].skipped = true;
    if (option.id === 'home') ahead.forEach((station) => { station.skipped = true; });
    // skipped stations no longer stop the rover
    this.stops = this.stops.filter((stop, i) => i <= this.stopIndex || !stop.ref.skipped);
    this.lastLeg = option.id;
    this.stopIndex++;
    this.state = 'drive';
    const next = this.nextStation;
    this.emit('log', { text: `Leg confirmed: ${option.label} · next: ${next && !next.final ? `${next.id} · ${next.name}` : 'HAB'}`, tone: 'ok' });
    this.emit('state', { state: this.state });
    return true;
  }

  _consume(seconds, options = {}) {
    const consumed = consumptionEstimate(seconds, options);
    this.met += seconds;
    this.o2Used += consumed.oxygenMinutes;
    this.dose += LIFE_SUPPORT.doseRateUsvH * (seconds / 3600);
    this.batteryWh = Math.max(0, this.batteryWh - consumed.batteryWh);
    if (!this.dustWarning && this.met >= this._weatherAt) {
      const clearing = this._weather !== CLEAR_WEATHER;
      this._weather = clearing ? CLEAR_WEATHER : PASSING_WEATHER[Math.floor(this.random() * PASSING_WEATHER.length)];
      // Work can jump the clock by minutes; report the current transition once, then reschedule.
      const longEvent = !clearing && this._weather !== PASSING_WEATHER[0];
      const duration = clearing ? 45 + this.random() * 45
        : longEvent ? 12 * 60 + this.random() * 8 * 60 : 25 + this.random() * 15;
      this._weatherAt = this.met + duration;
      this.emit('log', {
        text: clearing ? 'Weather cleared · normal operations resumed'
          : Number.isFinite(this._weather.exposureMinutes) ? `Cold spell · outside work limited to ${this._weather.exposureMinutes} min`
            : `${this._weather.label} · speed limited to ${this._weather.speedLimit} m/s`,
        tone: clearing ? 'ok' : 'warn',
      });
    }
  }

  update(dt, input, roverPitchDeg) {
    if (this.state === 'brief' || this.state === 'complete') return;

    if (this.state === 'drive') this._drive(dt, input, roverPitchDeg);
    else {
      this.governed = false;
      this.boosting = false;
      this.speed = Math.max(0, this.speed - ROVER.brake * dt);
      this._consume(dt);
    }

    if (this.state === 'station') this._station(dt, input);

    this._comms(dt);
  }

  _drive(dt, input, pitchDeg) {
    const R = this.route;
    // Shift speeds up time, but only on easy ground and only for a short while
    const marked = R.zonesAt(this.s + 3).length > 0;
    const stopNear = this.nextStop && this.nextStop.s - this.s < 25;
    const empty = this.boostCharge <= 0.02 || (this._boostEmpty && this.boostCharge < 0.3);
    this._boostEmpty = empty;
    this.boostBlocked = !input.boost ? '' : marked ? 'HAZARD STRETCH' : stopNear ? 'STOP AHEAD' : empty ? 'RECHARGING' : '';
    this.boosting = input.boost && !this.boostBlocked;
    if (this.boosting) this.boostCharge = Math.max(0, this.boostCharge - dt / ROVER.boostSeconds);
    else this.boostCharge = Math.min(1, this.boostCharge + dt / ROVER.boostRechargeSeconds);
    const k = this.boosting ? BOOST : 1;
    const sdt = dt * k;
    const throttle = !this.dustWarning && (input.throttle || this.cruise);
    const brake = this.dustWarning || input.brake;
    if (brake) this.cruise = false;

    const stop = this.nextStop;
    const stopS = stop ? stop.s : R.length;
    const toStop = Math.max(0, stopS - this.s);

    let limit = R.speedLimitAt(this.s + 3);
    let reason = '';
    if (limit < ROVER.maxSpeed) {
      const z = R.zonesAt(this.s + 3).sort((a, b) => a.limit - b.limit)[0];
      reason = z ? z.type : 'HAZARD';
    }
    this.offRoute = Math.abs(this.lateral) > ROVER.corridorHalfWidth * 0.8;
    if (this.offRoute && limit > 1.5) {
      limit = 1.5;
      reason = 'CORRIDOR EDGE';
    }
    const weather = this.weather;
    if (weather.speedLimit < limit) {
      limit = weather.speedLimit;
      reason = weather.label;
    }
    const approach = Math.sqrt(2 * 0.9 * toStop) + 0.08;
    if (approach < limit) {
      limit = approach;
      if (!stop?.ref.surprise || stop.ref.detected) reason = stop && stop.kind === 'gate' ? 'HAZARD GATE AHEAD' : 'STATION AHEAD';
    }

    let v = this.speed;
    const slopeDrag = 3.71 * Math.sin(pitchDeg / DEG) * 0.25;
    if (throttle && !brake) v += ROVER.accel * sdt;
    else if (brake) v -= ROVER.brake * sdt;
    else v -= ROVER.coast * sdt;
    v -= slopeDrag * sdt;
    if (v > limit) v = Math.max(limit, v - ROVER.brake * 1.3 * sdt);
    v = clamp(v, 0, ROVER.maxSpeed);
    this.governed = throttle && limit < ROVER.maxSpeed - 0.01 && v >= limit - 0.15;
    this.limitReason = reason;
    this.speed = v;

    // steering: heading offset relative to the route, with gentle auto-align
    const steer = input.steer;
    if (steer !== 0) this.yawOff = clamp(this.yawOff + steer * 0.7 * dt, -0.35, 0.35);
    else this.yawOff *= Math.exp(-1.6 * dt);
    this.lateral += v * Math.sin(this.yawOff) * sdt;
    const W = ROVER.corridorHalfWidth;
    if (Math.abs(this.lateral) >= W) {
      this.lateral = clamp(this.lateral, -W, W);
      this.yawOff *= 0.5;
    }

    const ds = v * Math.cos(this.yawOff) * sdt;
    const prevS = this.s;
    this.s = Math.min(this.s + ds, stopS);
    this.distance += this.s - prevS;
    this._consume(sdt, { moving: this.s - prevS, pitch: pitchDeg / DEG });

    // Small obstacles can only be identified within a fraction of the atmospheric sight range.
    const detectionRange = Math.min(35, this.weather.visibilityM * 0.035);
    for (let i = this.stopIndex; i < this.stops.length && this.stops[i].s <= this.s + detectionRange; i++) {
      const obstacle = this.stops[i];
      if (obstacle.ref.surprise && !obstacle.ref.detected) {
        obstacle.ref.detected = true;
        this.detectedObstacles.push(obstacle);
        this.emit('log', { text: `Mast camera spotted ${obstacle.ref.type.toLowerCase()} · ${Math.round(obstacle.s - this.s)} m ahead`, tone: 'warn' });
      }
    }

    // zone enter/exit events
    const now = R.zonesAt(this.s);
    const ids = new Set(now.map((z) => z.id));
    for (const z of now) if (!this._zoneIds.has(z.id)) this.emit('log', { text: `Entering ${z.type} · limit ${z.limit} m/s`, tone: z.severity === 'danger' ? 'danger' : 'warn' });
    if (this._zoneIds.size && !ids.size) this.emit('log', { text: 'Hazard zones cleared', tone: 'ok' });
    this._zoneIds = ids;
    this.activeZones = now;

    if (stop && this.s >= stopS - 0.02) {
      this.s = stopS;
      this.speed = 0;
      this.cruise = false;
      if (stop.kind === 'gate') {
        this.state = 'gate';
        this.emit('log', { text: stop.ref.surprise ? `FIELD OBSTACLE — ${stop.ref.type}` : `HAZARD GATE — ${stop.ref.type}. Briefing required.`, tone: 'danger' });
      } else {
        this.state = 'station';
        this.lateral *= 0.5;
        this.emit('log', { text: `Arrived ${stop.ref.id} · ${stop.ref.name}`, tone: 'ok' });
      }
      this.emit('state', { state: this.state, stop });
    }
  }

  _station(dt, input) {
    const st = this.nextStop.ref;
    const task = st.tasks.find((t) => !t.done && !t.skipped);
    if (!task) return;
    if (input.action) {
      task.progress = Math.min(1, task.progress + dt / TASK_HOLD_SECONDS);
      if (task.progress >= 1 && !this.chooseStationAction(`task:${st.tasks.indexOf(task)}`)) task.progress = 0;
    } else {
      task.progress = Math.max(0, task.progress - dt * 1.5);
    }
  }

  _finishStationTask(task) {
    if (this.state !== 'station' || task.done || task.skipped) return false;
    const st = this.currentStation;
    const weather = this.weather;
    if (task.panorama && weather.visibilityM < 1000) {
      task.quality = 'dust-degraded';
      task.result = 'Dust-degraded panorama stored · fine beds obscured; repeat observation needed (SIMULATION)';
    } else task.quality = 'nominal';
    this._outsideMinutes = this.outsideMinutes + (!st.final && task.outside !== false ? task.minutes : 0);
    this._outsideWeather = weather;
    this._outsideWeatherUntil = this._weatherAt;
    task.done = true;
    task.progress = 1;
    this._consume(task.minutes * 60, { work: true });
    if (/^collect/i.test(task.label)) this.samples += task.sampleCount ?? 1;
    this.emit('log', { text: `${st.id} ✓ ${task.label} — ${task.result}`, tone: task.quality === 'nominal' ? 'ok' : 'warn' });
    this.emit('task', { station: st, task });
    this._stationComplete();
    return true;
  }

  _stationComplete() {
    const st = this.currentStation;
    if (st.tasks.every(task => task.done || task.skipped)) {
      st.done = true;
      this.state = 'stationDone';
      this.emit('state', { state: this.state, stop: this.nextStop });
    }
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
