import { mulberry32, clamp } from '../core/math.js';

// ---------------------------------------------------------------------------
// First-person station tasks. Pure logic (no rendering) so every mechanic can
// be tested. Directions are unit vectors in world space; the aim is the
// camera's forward direction, including suit sway.
//
//   scan   hold the reticle on each marked rock until the instrument locks
//   pano   turn your head to each frame and hold still for the shutter
//   tune   no marker: sweep your head until the signal peaks, then hold
//   sweep  trace the radar line on the ground, steadily, from end to end
//   drill  keep the drill pressure inside a moving band until the core is cut
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
export const GRADE_POINTS = { S: 500, A: 350, B: 200, C: 100 };

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const angleBetween = (a, b) => Math.acos(clamp(dot(a, b), -1, 1));
// Same convention as the camera: yaw 0 looks along -Z, positive yaw turns left.
export const dirFromYawPitch = (yaw, pitch = 0) => ({
  x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch),
});

// Time against a par time → grade.
export function gradeFor(ratio, penalty = 0) {
  const r = ratio + penalty * 0.25;
  return r <= 0.75 ? 'S' : r <= 1.05 ? 'A' : r <= 1.6 ? 'B' : 'C';
}

class Task {
  constructor(kind) {
    this.kind = kind;
    this.t = 0;
    this.done = false;
    this.penalty = 0;
  }
  get grade() { return gradeFor(this.t / this.par, this.penalty); }
  get points() { return GRADE_POINTS[this.grade]; }
}

export class ScanTask extends Task {
  constructor({ targets, hold = 1.2 }) {
    super('scan');
    this.hold = hold;
    this.targets = targets.map((t) => ({ ...t, lock: 0, done: false }));
    this.index = 0;
    this.onTarget = false;
    this.error = 1; // aim error relative to the target size (≤ 1 is on target)
    this.par = this.targets.length * (hold + 3.2);
  }
  get current() { return this.targets[this.index] ?? null; }
  get progress() { return (this.index + (this.current?.lock ?? 0)) / this.targets.length; }

  update(dt, { eye, dir }) {
    if (this.done) return null;
    this.t += dt;
    const c = this.current;
    const to = sub(c.pos, eye);
    const size = Math.max(Math.atan2(c.radius, len(to)), 1.6 * RAD);
    this.error = angleBetween(dir, norm(to)) / size;
    const was = this.onTarget;
    this.onTarget = this.error < 1;
    if (was && !this.onTarget && c.lock > 0.15) this.penalty += 0.15; // slipped off mid-lock
    c.lock = this.onTarget ? Math.min(1, c.lock + dt / this.hold) : Math.max(0, c.lock - dt * 0.8);
    if (c.lock < 1) return null;
    c.done = true;
    this.index++;
    this.done = this.index >= this.targets.length;
    return this.done ? 'done' : 'lock';
  }
}

export class PanoTask extends Task {
  constructor({ sectors, tolerance = 8, settle = 0.45, maxRate = 28 }) {
    super('pano');
    this.sectors = sectors.map((s) => ({ ...s, settle: 0, done: false, blurred: false }));
    this.tolerance = tolerance * RAD;
    this.settle = settle;
    this.maxRate = maxRate * RAD;
    this.prev = null;
    this.rate = 0;
    this.near = null;
    this.par = this.sectors.length * 1.6 + 5;
  }
  get progress() { return this.sectors.filter((s) => s.done).length / this.sectors.length; }

  update(dt, { dir }) {
    if (this.done) return null;
    this.t += dt;
    const rate = this.prev && dt > 0 ? angleBetween(dir, this.prev) / dt : 0;
    this.rate += (rate - this.rate) * Math.min(1, dt * 12);
    this.prev = { x: dir.x, y: dir.y, z: dir.z }; // copy: callers reuse their vector
    let near = null, best = this.tolerance;
    for (const s of this.sectors) {
      if (s.done) continue;
      const a = angleBetween(dir, s.dir);
      if (a < best) { best = a; near = s; }
    }
    if (this.near && this.near !== near) { this.near.settle = 0; this.near.blurred = false; }
    this.near = near;
    if (!near) return null;
    if (this.rate > this.maxRate) {
      near.settle = 0;
      if (!near.blurred) { near.blurred = true; this.penalty += 0.2; return 'blur'; }
      return null;
    }
    near.settle += dt;
    if (near.settle < this.settle) return null;
    near.done = true;
    this.near = null;
    this.done = this.sectors.every((s) => s.done);
    return this.done ? 'done' : 'capture';
  }
}

export class TuneTask extends Task {
  constructor({ source, width = 9, hold = 1.5 }) {
    super('tune');
    this.source = source; // unit vector toward the transmitter
    this.width = width * RAD;
    this.hold = hold;
    this.lock = 0;
    this.signal = 0;
    this.par = 11;
  }
  get progress() { return this.done ? 1 : this.lock; }

  update(dt, { dir }) {
    if (this.done) return null;
    this.t += dt;
    const a = angleBetween(dir, this.source);
    // Main lobe plus a weak back lobe, so the search has a "warmer" direction.
    this.signal = Math.max(Math.exp(-((a / this.width) ** 2)), 0.25 * Math.exp(-((a / (this.width * 6)) ** 2)));
    this.lock = this.signal >= 0.9 ? Math.min(1, this.lock + dt / this.hold) : Math.max(0, this.lock - dt * 0.9);
    if (this.lock < 1) return null;
    this.done = true;
    return 'done';
  }
}

export class SweepTask extends Task {
  constructor({ samples, tolerance = 3.2, maxRate = 42 }) {
    super('sweep');
    this.samples = samples.map((pos) => ({ pos, done: false }));
    this.tolerance = tolerance * RAD;
    this.maxRate = maxRate * RAD;
    this.covered = 0;
    this.order = null; // +1 left→right, -1 right→left, chosen by where the sweep starts
    this.prev = null;
    this.rate = 0;
    this.fast = false;
    this.par = 12;
  }
  get progress() { return this.covered / this.samples.length; }
  get next() {
    if (!this.order) return null;
    return this.samples[this.order > 0 ? this.covered : this.samples.length - 1 - this.covered];
  }

  update(dt, { eye, dir }) {
    if (this.done) return null;
    this.t += dt;
    const rate = this.prev && dt > 0 ? angleBetween(dir, this.prev) / dt : 0;
    this.rate += (rate - this.rate) * Math.min(1, dt * 12);
    this.prev = { x: dir.x, y: dir.y, z: dir.z }; // copy: callers reuse their vector
    const near = (sample) => angleBetween(dir, norm(sub(sample.pos, eye))) < this.tolerance;
    if (!this.order) {
      if (near(this.samples[0])) this.order = 1;
      else if (near(this.samples.at(-1))) this.order = -1;
      else return null;
    }
    const wasFast = this.fast;
    this.fast = this.rate > this.maxRate;
    if (this.fast && !wasFast) this.penalty += 0.1;
    const next = this.next;
    if (this.fast || !near(next)) return null;
    next.done = true;
    this.covered++;
    this.done = this.covered >= this.samples.length;
    return this.done ? 'done' : 'tick';
  }
}

export class DrillTask extends Task {
  constructor({ cores = 1, seed = 1, seconds = 6 }) {
    super('drill');
    const r = mulberry32(seed);
    this.cores = cores;
    this.seconds = seconds;
    this.phase = r() * 6;
    this.pressure = 0;
    this.depth = 0;
    this.core = 0;
    this.stall = 0;
    this.jam = 0;
    this.jams = 0;
    this.zone = 'low';
    this.par = cores * seconds * 1.6;
  }
  get band() {
    const t = this.t;
    return { center: 0.55 + 0.2 * Math.sin(t * 0.55 + this.phase) + 0.08 * Math.sin(t * 1.7 + this.phase), half: 0.1 };
  }
  get progress() { return Math.min(1, (this.core + this.depth) / this.cores); }

  update(dt, { pressing = false } = {}) {
    if (this.done) return null;
    this.t += dt;
    if (this.jam > 0) {
      this.jam -= dt;
      this.pressure = Math.max(0, this.pressure - dt * 1.2);
      this.zone = 'jam';
      return null;
    }
    this.pressure = clamp(this.pressure + (pressing ? 0.75 : -0.6) * dt, 0, 1);
    const { center, half } = this.band;
    this.zone = this.pressure > center + half ? 'high' : this.pressure < center - half ? 'low' : 'ok';
    if (this.zone === 'ok') this.depth += dt / this.seconds;
    if (this.zone === 'high') {
      this.stall += dt * (this.pressure > center + half + 0.12 ? 2 : 1);
      if (this.stall > 0.9) {
        this.stall = 0;
        this.jam = 1.2;
        this.jams++;
        this.penalty += 0.5;
        this.depth = Math.max(0, this.depth - 0.12);
        return 'jam';
      }
    } else this.stall = Math.max(0, this.stall - dt);
    if (this.depth < 1) return null;
    this.core++;
    this.depth = 0;
    this.pressure *= 0.3;
    this.done = this.core >= this.cores;
    return this.done ? 'done' : 'core';
  }
}

// ---------------------------------------------------------------- layout
// Where a station task puts its targets, relative to the crew's seat.
//   eye: camera position · heading: rover yaw (camera convention) · ground(x, z): height
export function layoutTask(task, { eye, heading, ground, source = null, seed = 1 }) {
  const r = mulberry32(seed);
  const at = (bearingDeg, distance, lift = 0) => {
    const d = dirFromYawPitch(heading + bearingDeg * RAD);
    const x = eye.x + d.x * distance;
    const z = eye.z + d.z * distance;
    return { x, y: ground(x, z) + lift, z };
  };
  const kind = task.kind ?? 'scan';
  if (kind === 'drill') return new DrillTask({ cores: task.sampleCount ?? 1, seed });
  if (kind === 'tune') {
    const toward = source ? norm(sub(source, eye)) : dirFromYawPitch(heading + (110 + r() * 140) * RAD, 0.05);
    return new TuneTask({ source: toward });
  }
  if (kind === 'pano') {
    const n = task.frames ?? 4;
    const arc = task.arc ?? 120;
    const start = arc >= 360 ? 0 : -arc / 2;
    const step = arc >= 360 ? 360 / n : arc / (n - 1);
    return new PanoTask({ sectors: Array.from({ length: n }, (_, i) => ({
      bearing: start + i * step, dir: dirFromYawPitch(heading + (start + i * step) * RAD, 2 * RAD),
    })) });
  }
  if (kind === 'sweep') {
    const n = 22;
    return new SweepTask({ samples: Array.from({ length: n }, (_, i) => at(-38 + 76 * i / (n - 1), 7.5, 0.05)) });
  }
  // scan
  const n = task.targets ?? 1;
  if (task.layout === 'sky') {
    const d = dirFromYawPitch(heading + (r() - 0.5) * 60 * RAD, 38 * RAD);
    return new ScanTask({ targets: [{ pos: { x: eye.x + d.x * 20, y: eye.y + d.y * 20, z: eye.z + d.z * 20 }, radius: 0.85, sky: true }] });
  }
  if (task.layout === 'bed') {
    const base = at(18, 9);
    return new ScanTask({ targets: [0.35, 1.75].slice(0, n).map((h, i) => ({ pos: { ...base, y: base.y + h }, radius: 0.32, bed: i, slab: base })) });
  }
  const spreads = { 1: [24], 2: [-28, 30], 3: [-46, 8, 52] };
  const bearings = spreads[n] ?? Array.from({ length: n }, (_, i) => -60 + 120 * i / Math.max(1, n - 1));
  return new ScanTask({ targets: bearings.map((b) => {
    const size = 0.45 + r() * 0.3;
    const ground = at(b + (r() - 0.5) * 8, 7 + r() * 3.5);
    return { pos: { ...ground, y: ground.y + size * 0.55 }, radius: Math.max(0.42, size * 0.9), rock: size, ground };
  }) });
}
