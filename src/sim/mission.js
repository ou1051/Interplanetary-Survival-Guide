import { ROVER, LIFE_SUPPORT, HAB, SITE, SLOPE_CLASSES } from '../config/mission.js';
import { clamp, DEG, wrapAngle } from '../core/math.js';
import { consumptionEstimate } from '../physics/traverse.js';

// ---------------------------------------------------------------------------
// EVA state machine + consumables.
//
//   brief ─▶ drive ⇄ walk ─▶ complete (End EVA near the habitat)
//
// The rover drives freely over the terrain: the planned route is guidance, not
// a rail. Speed is governed by the ground under the rover (slope, mapped area
// hazards) and the rover will not climb ground steeper than STEEP_BLOCK.
// The crew can get out and walk anywhere; station work means collecting the
// station's artifacts on foot. `s` is the rover's progress projected onto the
// planned route, kept for the route displays.
// ---------------------------------------------------------------------------

const BOOST = 3;
export const STEEP_BLOCK = 32; // degrees: above the steepest ground any planned route crosses (Gale shortest ≈ 29°)
export const STATION_RADIUS = 30; // m: entering this ring "arrives" at a station
export const HOME_RADIUS = 30; // m: End EVA is offered inside this ring around the habitat
export const HAB_RADIUS = 10; // m: habitat footprint (collision)
export const WALK = { speed: 1.3, run: 2.4, reach: 2.4, board: 3.4, maxSlope: 32, hardSlope: 18 };
const ROVER_RADIUS = 1.9;
const REVERSE_SPEED = 1.2;

export class Mission {
  constructor(route, terrain, habAntenna) {
    this.route = route;
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
    this.offRoute = false;
    this.blocked = false; // rover facing ground too steep to climb
    this.bumped = 0;
    this.artifacts = [];
    this.collected = [];
    this._brakeHeld = 0;
    this.leftHome = false;
    this._zoneIds = new Set();
    this._searchTimer = 0;
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
    return this.stations.find((st) => !st.done) ?? this.home;
  }
  get nextStop() {
    const st = this.nextStation;
    return st ? { kind: 'station', s: st.s, ref: st } : null;
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

  start() {
    const p = this.route.sample(0);
    Object.assign(this.rover, { x: p.x, z: p.z, heading: Math.atan2(-p.tx, -p.tz), speed: 0, steer: 0 });
    this.pos = { x: p.x, y: this.terrain.heightAt?.(p.x, p.z) ?? 0, z: p.z };
    this.state = 'drive';
    const science = this.stations.length;
    this.emit('log', { text: `${this.route.site?.eva ?? SITE.eva} started · planned route ${Math.round(this.route.length)} m · ${science} station${science === 1 ? '' : 's'}`, tone: 'info' });
    this.emit('state', { state: this.state });
  }

  // Station artifacts become the station's work list.
  setArtifacts(artifacts) {
    this.artifacts = artifacts;
    for (const st of this.stations) {
      const mine = artifacts.filter((a) => a.stationId === st.id);
      if (!mine.length) continue;
      st.tasks = mine.map((a) => ({ label: `Collect ${a.name}`, minutes: a.minutes, artifact: a, result: a.note, progress: 0, done: false }));
      st.done = false;
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
    this.emit('log', { text: 'Crew out of the rover · on foot', tone: 'info' });
    this.emit('state', { state: this.state });
    return true;
  }

  boardRover() {
    if (!this.canBoard) return false;
    this.state = 'drive';
    this.rover.speed = 0;
    this.emit('log', { text: 'Crew aboard · rover ready', tone: 'info' });
    this.emit('state', { state: this.state });
    return true;
  }

  endEva() {
    if (!['drive', 'walk'].includes(this.state) || !this.atHome) return false;
    const home = this.home;
    if (home) home.done = true;
    this.rover.speed = this.speed = 0;
    this.state = 'complete';
    this.emit('log', { text: 'EVA complete. Welcome home.', tone: 'ok' });
    this.emit('state', { state: this.state });
    return true;
  }

  // Dust or a reserve problem: turn around and head home along the outbound track.
  returnToHabitat() {
    if (this.route.retracesOutbound === false || !['drive', 'walk'].includes(this.state) || this.aborted ||
        this.s <= 1 || this.s >= this.route.length / 2) return false;
    this.aborted = true;
    this.dustWarning = false;
    this.cruise = false;
    this.rover.speed = 0;
    if (this.state === 'drive') this.rover.heading += Math.PI;
    this.emit('log', { text: 'Returning along the outbound track', tone: 'warn' });
    this.emit('state', { state: this.state });
    return true;
  }

  collect(artifact) {
    if (!artifact || artifact.collected || this.state !== 'walk') return false;
    artifact.collected = true;
    this.collected.push(artifact);
    this.samples++;
    this._consume(artifact.minutes * 60, { work: true });
    const st = artifact.stationId ? this.stations.find((x) => x.id === artifact.stationId) : null;
    const task = st?.tasks.find((t) => t.artifact === artifact);
    if (task) { task.done = true; task.progress = 1; }
    this.emit('log', { text: `${st ? `${st.id} ✓ ` : ''}Collected ${artifact.name}`, tone: 'ok' });
    this.emit('artifact', { artifact, station: st });
    if (st && !st.done && st.tasks.every((t) => t.done)) {
      st.done = true;
      const next = this.nextStation;
      this.emit('log', { text: `${st.id} complete · next: ${next?.final ? 'habitat' : `${next.id} · ${next.name}`}`, tone: 'ok' });
      this.emit('station', { station: st, done: true });
    }
    return true;
  }

  // ---------------------------------------------------------------- per frame
  _consume(seconds, options = {}) {
    const consumed = consumptionEstimate(seconds, options);
    this.met += seconds;
    this.o2Used += consumed.oxygenMinutes;
    this.dose += LIFE_SUPPORT.doseRateUsvH * (seconds / 3600);
    this.batteryWh = Math.max(0, this.batteryWh - consumed.batteryWh);
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
    this.boosting = Boolean(input.boost);
    const sdt = dt * (this.boosting ? BOOST : 1);
    const throttle = !this.dustWarning && (input.throttle || this.cruise);
    const brake = this.dustWarning || input.brake;
    if (brake) this.cruise = false;
    this._brakeHeld = brake && r.speed <= 0.05 ? this._brakeHeld + dt : 0;

    const ground = this._ground(r.x, r.z, r.heading);
    let limit = ROVER.maxSpeed;
    let reason = '';
    for (const z of ground.zones) if (z.limit < limit) { limit = z.limit; reason = z.type; }
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
    v = clamp(v, -REVERSE_SPEED, ROVER.maxSpeed);
    this.governed = throttle && limit < ROVER.maxSpeed - 0.01 && v >= limit - 0.15;
    this.limitReason = reason;

    // Steering: bicycle model, the wheels turn in over ~0.3 s.
    r.steer += (clamp(input.steer || 0, -1, 1) * 0.5 - r.steer) * Math.min(1, dt * 6);
    r.heading -= (v * Math.tan(r.steer) / ROVER.wheelbase) * sdt;

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
    this._consume(dt, { work: true });
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
  _track(dt) {
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
    let [i, d] = this.aborted && R.retracesOutbound !== false ? best(at - ahead, at + behind) : best(at - behind, at + ahead);
    this._searchTimer -= dt;
    if (d > 40 && this._searchTimer <= 0) {
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
      const open = st.tasks.filter((t) => !t.done).length;
      this.emit('log', { text: `Arrived ${st.id} · ${st.name}${open ? ` · get out and collect ${open} artifact${open > 1 ? 's' : ''}` : ''}`, tone: 'ok' });
      this.emit('station', { station: st, done: false });
    }
  }

  // Steering that follows the planned route ahead (tests, demos, the simulate hook).
  autopilot(input = {}) {
    const R = this.route;
    const r = this.rover;
    const back = this.aborted && R.retracesOutbound !== false;
    const p = R.sample(clamp(this.s + (back ? -9 : 9), 0, R.length));
    const want = Math.atan2(-(p.x - r.x), -(p.z - r.z));
    const err = wrapAngle(want - r.heading);
    return { throttle: true, brake: false, boost: false, ...input, steer: clamp(-err * 2.2, -1, 1) };
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
