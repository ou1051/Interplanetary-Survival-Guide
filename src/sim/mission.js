import { ROVER, LIFE_SUPPORT, HAB, SITE } from '../config/mission.js';
import { clamp, DEG } from '../core/math.js';
import { consumptionEstimate } from '../routes/physics.js';

// ---------------------------------------------------------------------------
// Traverse state machine + consumables.
//
//   brief ─▶ drive ─▶ gate (acknowledge hazard briefing) ─▶ drive
//                 └─▶ station (hold to run tasks) ─▶ stationDone ─▶ drive
//                                                       └─(HAB)─▶ complete
// ---------------------------------------------------------------------------

const TASK_HOLD_SECONDS = 2.0;
const BOOST = 3;

export class Mission {
  constructor(route, terrain, habAntenna) {
    this.route = route;
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
    this.offRoute = false;
    this.taskFlash = null;
    this._zoneIds = new Set();
  }

  on(fn) {
    this.listeners.push(fn);
  }
  emit(type, payload = {}) {
    for (const fn of this.listeners) fn(type, payload);
  }

  get nextStop() {
    return this.route.stops[this.stopIndex] || null;
  }
  get nextStation() {
    return this.route.stations.find((s) => !s.done) || null;
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

  start() {
    this.state = 'drive';
    this.emit('log', { text: `${SITE.eva} started · traverse ${Math.round(this.route.length)} m · ${this.route.stations.length - 1} stations`, tone: 'info' });
    this.emit('state', { state: this.state });
  }

  acknowledge() {
    if (this.state === 'gate') {
      const z = this.nextStop.ref;
      z.acknowledged = true;
      this.emit('log', { text: `Hazard briefing acknowledged: ${z.type}`, tone: 'warn' });
      this.stopIndex++;
      this.state = 'drive';
      this.emit('state', { state: this.state });
      return true;
    }
    if (this.state === 'stationDone') {
      const st = this.nextStop.ref;
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

  _consume(seconds, options = {}) {
    const consumed = consumptionEstimate(seconds, options);
    this.met += seconds;
    this.o2Used += consumed.oxygenMinutes;
    this.dose += LIFE_SUPPORT.doseRateUsvH * (seconds / 3600);
    this.batteryWh = Math.max(0, this.batteryWh - consumed.batteryWh);
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
    this.boosting = input.boost;
    const k = this.boosting ? BOOST : 1;
    const sdt = dt * k;
    const throttle = input.throttle || this.cruise;
    const brake = input.brake;
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
    const approach = Math.sqrt(2 * 0.9 * toStop) + 0.08;
    if (approach < limit) {
      limit = approach;
      reason = stop && stop.kind === 'gate' ? 'HAZARD GATE AHEAD' : 'STATION AHEAD';
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
        this.emit('log', { text: `HAZARD GATE — ${stop.ref.type}. Briefing required.`, tone: 'danger' });
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
    const task = st.tasks.find((t) => !t.done);
    if (!task) return;
    if (input.action) {
      task.progress = Math.min(1, task.progress + dt / TASK_HOLD_SECONDS);
      if (task.progress >= 1) {
        task.done = true;
        this._consume(task.minutes * 60, { work: true });
        if (/^collect/i.test(task.label)) this.samples++;
        this.emit('log', { text: `${st.id} ✓ ${task.label} — ${task.result}`, tone: 'ok' });
        this.emit('task', { station: st, task });
        if (st.tasks.every((t) => t.done)) {
          st.done = true;
          this.state = 'stationDone';
          this.emit('state', { state: this.state, stop: this.nextStop });
        }
      }
    } else {
      task.progress = Math.max(0, task.progress - dt * 1.5);
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
