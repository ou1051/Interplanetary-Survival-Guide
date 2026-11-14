import * as THREE from 'three';
import { layoutTask, angleBetween, sub, norm } from '../sim/fieldTasks.js';
import { TaskField } from '../world/taskField.js';
import { clamp } from '../core/math.js';
import './taskRunner.css';

// ---------------------------------------------------------------------------
// Runs one station task first-person: builds its targets in the world, reads
// the crew's aim (the camera), shows the instrument reticle and gauges, plays
// cues and grades the result.
//
// Controls: drag / WASD / arrows to look · Shift (or the button) holds your
// breath to steady the aim · Space (or the button) presses the drill · Esc cancels.
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
const KIND = { scan: 'Instrument scan', pano: 'Panorama', tune: 'Signal search', sweep: 'Radar sweep', drill: 'Core drill' };
const HELP = {
  scan: 'Look at the marked rock and keep the reticle inside its ring until the instrument locks.',
  bed: 'Range the top and the bottom of the bed: hold the reticle on each ring on the rock face.',
  sky: 'Point the dosimeter at open sky and hold it steady inside the ring.',
  pano: 'Turn to each camera frame and hold still for the shutter. Turning too fast blurs the shot.',
  tune: 'No target ring. Turn toward the habitat antenna and listen: the pings speed up as the signal grows. Hold the peak.',
  sweep: 'Start at an orange post and trace the radar line to the other end. Slow and steady: too fast leaves gaps.',
  drill: 'Hold Space or the button to press the drill. Keep the needle in the green band. Too much pressure jams the bit.',
};
const BREATH_TASKS = new Set(['scan', 'pano', 'sweep']);

export class TaskRunner {
  constructor({ mission, scene, camera, terrain, rover, audio, habAntenna }) {
    Object.assign(this, { mission, camera, terrain, rover, audio, habAntenna });
    this.field = new TaskField(scene);
    this.logic = null;
    this.task = null;
    this.seed = 11;
    this.breath = { level: 1, holding: false, gasp: 0 };
    this.held = false; // on-screen button
    this.pingTimer = 0;
    this.grindTimer = 0;
    this.time = 0;
    this._v = new THREE.Vector3();

    const el = document.createElement('div');
    el.id = 'taskHud';
    el.className = 'task-hud hidden';
    el.innerHTML = `
      <svg class="th-reticle" viewBox="-60 -60 120 120" aria-hidden="true">
        <circle class="th-ring" r="20"></circle>
        <circle class="th-lock" r="29" pathLength="100" transform="rotate(-90)"></circle>
        <path class="th-cross" d="M-44 0H-27M27 0H44M0 -44V-27M0 27V44"></path>
        <circle class="th-dot" r="2.2"></circle>
      </svg>
      <div class="th-labels" aria-hidden="true"></div>
      <div class="th-arrow" aria-hidden="true" hidden><i></i><span></span></div>
      <section class="th-panel" aria-labelledby="taskHudTitle">
        <header><span class="th-kicker" data-kicker></span><button type="button" class="th-cancel" data-cancel aria-label="Cancel task">Esc</button></header>
        <h3 id="taskHudTitle" data-title></h3>
        <p class="th-help" data-help></p>
        <canvas class="th-gauge" data-gauge aria-hidden="true"></canvas>
        <div class="th-bar" aria-hidden="true"><i data-bar></i></div>
        <div class="th-foot"><p class="th-status" data-status role="status"></p><button type="button" class="th-hold" data-hold></button></div>
      </section>
      <div class="th-grade" data-grade hidden><b></b><span></span></div>`;
    document.getElementById('app').appendChild(el);
    this.el = el;
    this.q = (s) => el.querySelector(s);
    this.labels = this.q('.th-labels');
    this.arrow = this.q('.th-arrow');
    const hold = this.q('[data-hold]');
    hold.addEventListener('pointerdown', (e) => { e.preventDefault(); this.held = true; hold.classList.add('down'); });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(type, () => { this.held = false; hold.classList.remove('down'); });
    this.q('[data-cancel]').addEventListener('click', () => this.cancel());
  }

  get active() { return Boolean(this.logic); }
  get kind() { return this.logic?.kind ?? null; }

  // Aim sway (radians) for the camera this frame.
  get sway() {
    if (!this.logic) return 0;
    const base = { scan: 0.95, sweep: 0.8, pano: 0.55, tune: 0.3, drill: 0 }[this.logic.kind] * RAD;
    if (this.breath.gasp > 0) return base * 1.8;
    return this.breath.holding ? base * 0.22 : base;
  }
  get shake() {
    const L = this.logic;
    if (L?.kind !== 'drill') return 0;
    return (L.zone === 'jam' ? 1.4 : L.zone === 'high' ? 0.7 : L.zone === 'ok' ? 0.3 : 0.1) * L.pressure * RAD;
  }
  get lockLook() { return this.logic?.kind === 'drill'; }

  start() {
    const task = this.mission.activeTask;
    if (!task || this.logic) return false;
    const station = this.mission.nextStop.ref;
    this.camera.updateMatrixWorld(true);
    const eye = this.camera.getWorldPosition(this._v).clone();
    this.logic = layoutTask(task, {
      eye, heading: this.rover.pose.yaw, ground: (x, z) => this.terrain.heightAt(x, z),
      source: this.habAntenna, seed: this.seed++,
    });
    this.task = task;
    this.station = station;
    this.field.show(this.logic, eye);
    this.breath = { level: 1, holding: false, gasp: 0 };
    const index = station.tasks.indexOf(task) + 1;
    const mode = task.layout === 'bed' ? 'bed' : task.layout === 'sky' ? 'sky' : this.logic.kind;
    this.q('[data-kicker]').textContent = `${station.final ? 'Habitat' : station.id} · task ${index}/${station.tasks.length} · ${KIND[this.logic.kind]}`;
    this.q('[data-title]').textContent = task.label;
    this.q('[data-help]').textContent = HELP[mode];
    const hold = this.q('[data-hold]');
    hold.hidden = this.logic.kind === 'tune';
    hold.textContent = this.logic.kind === 'drill' ? 'Hold to drill' : 'Hold breath';
    this.el.dataset.kind = this.logic.kind;
    this.el.classList.remove('hidden');
    this.q('[data-grade]').hidden = true;
    document.getElementById('app').classList.add('task-mode');
    this.audio?.beep('info');
    return true;
  }

  cancel() {
    if (!this.logic) return;
    this.mission.setTaskProgress(this.task, 0);
    this._end();
  }

  _end() {
    this.logic = null;
    this.task = null;
    this.held = false;
    this.field.clear();
    this.el.classList.add('hidden');
    this.labels.innerHTML = '';
    this.arrow.hidden = true;
    document.getElementById('app').classList.remove('task-mode');
  }

  _finish() {
    const { logic, task } = this;
    const grade = logic.grade;
    const points = logic.points;
    this.mission.completeTask(task, { result: task.result, grade, points });
    this._end();
    const badge = this.q('[data-grade]');
    badge.querySelector('b').textContent = grade;
    badge.querySelector('span').textContent = `+${points} · ${task.label}`;
    badge.dataset.grade = grade;
    badge.hidden = false;
    this.el.classList.remove('hidden');
    clearTimeout(this.gradeTimer);
    this.gradeTimer = setTimeout(() => {
      badge.hidden = true;
      if (!this.logic) this.el.classList.add('hidden');
    }, 1900);
    this.audio?.beep('ok');
  }

  // input: { eye, dir, pressing, breathing }
  update(dt, { eye, dir, pressing = false, breathing = false }) {
    const L = this.logic;
    if (!L) return;
    this.time += dt;
    // Breath: holding it steadies the aim for up to ~3 s, then you have to gasp.
    const b = this.breath;
    const wantHold = (breathing || (this.held && L.kind !== 'drill')) && BREATH_TASKS.has(L.kind);
    if (b.gasp > 0) b.gasp -= dt;
    b.holding = wantHold && b.level > 0 && b.gasp <= 0;
    b.level = clamp(b.level + (b.holding ? -dt / 3 : dt / 4), 0, 1);
    if (b.holding && b.level <= 0) { b.holding = false; b.gasp = 1; this.audio?.tone(220, 0.25, 0.05); }

    const event = L.update(dt, { eye, dir, pressing: pressing || (this.held && L.kind === 'drill') });
    this.mission.setTaskProgress(this.task, L.progress);
    this._cues(dt, event);
    this.field.update(dt, this.camera, this.time);
    if (L.done) { this._finish(); return; }
    this._hud(eye, dir);
  }

  _cues(dt, event) {
    const L = this.logic;
    const a = this.audio;
    if (!a) return;
    if (event === 'lock' || event === 'core') a.beep('ok');
    else if (event === 'capture') a.tone(1900, 0.04, 0.06);
    else if (event === 'tick') a.tone(1250, 0.02, 0.025);
    else if (event === 'jam' || event === 'blur') a.beep('warn');
    if (L.kind === 'tune') {
      // Geiger-style pings: faster and higher as the signal grows.
      this.pingTimer -= dt;
      if (this.pingTimer <= 0) {
        this.pingTimer = 0.07 + (1 - L.signal) * 0.85;
        a.tone(500 + 900 * L.signal, 0.05, 0.035);
      }
    }
    if (L.kind === 'scan' && L.onTarget) {
      this.pingTimer -= dt;
      if (this.pingTimer <= 0) { this.pingTimer = 0.18; a.tone(700 + 600 * (L.current?.lock ?? 0), 0.03, 0.025); }
    }
    if (L.kind === 'drill' && L.zone !== 'low' && L.zone !== 'jam') {
      this.grindTimer -= dt;
      if (this.grindTimer <= 0) { this.grindTimer = 0.11; a.tone(L.zone === 'high' ? 95 : 140, 0.09, 0.03, 'sawtooth'); }
    }
  }

  // ---------------------------------------------------------------- HUD
  _project(p) {
    const v = this._v.set(p.x, p.y, p.z).project(this.camera);
    return { x: v.x, y: v.y, behind: v.z > 1 };
  }

  _guide(eye, dir) {
    const L = this.logic;
    if (L.kind === 'scan') return L.current?.pos;
    if (L.kind === 'pano') {
      let best = null, bestA = Infinity;
      for (const s of L.sectors) {
        if (s.done) continue;
        const a = angleBetween(dir, s.dir);
        if (a < bestA) { bestA = a; best = s; }
      }
      return best && { x: eye.x + best.dir.x * 24, y: eye.y + best.dir.y * 24, z: eye.z + best.dir.z * 24 };
    }
    if (L.kind === 'sweep') {
      if (L.next) return L.next.pos;
      const first = L.samples[0].pos, last = L.samples.at(-1).pos;
      return angleBetween(dir, norm(sub(first, eye))) <= angleBetween(dir, norm(sub(last, eye))) ? first : last;
    }
    return null;
  }

  _hud(eye, dir) {
    const L = this.logic;
    // Reticle state.
    const reticle = this.q('.th-reticle');
    const lock = L.kind === 'scan' ? L.current?.lock ?? 1 : L.kind === 'pano' ? (L.near ? L.near.settle / L.settle : 0)
      : L.kind === 'tune' ? L.lock : L.kind === 'sweep' ? L.progress : 0;
    const on = L.kind === 'scan' ? L.onTarget : L.kind === 'pano' ? Boolean(L.near) && L.rate <= L.maxRate
      : L.kind === 'tune' ? L.signal >= 0.9 : L.kind === 'sweep' ? Boolean(L.order) && !L.fast : false;
    reticle.classList.toggle('on', on);
    reticle.classList.toggle('warn', (L.kind === 'pano' && L.near && L.rate > L.maxRate) || (L.kind === 'sweep' && L.fast));
    reticle.querySelector('.th-lock').style.strokeDasharray = `${clamp(lock, 0, 1) * 100} 100`;

    // Target numbers on screen, an edge arrow when the next one is off screen.
    const marks = [];
    if (L.kind === 'scan') L.targets.forEach((t, i) => marks.push({ p: t.pos, text: t.done ? '✓' : String(i + 1), on: i === L.index, done: t.done }));
    if (L.kind === 'pano') L.sectors.forEach((s, i) => marks.push({ p: { x: eye.x + s.dir.x * 24, y: eye.y + s.dir.y * 24 + 3, z: eye.z + s.dir.z * 24 }, text: s.done ? '✓' : String(i + 1), on: L.near === s, done: s.done }));
    let html = '';
    for (const m of marks) {
      const s = this._project(m.p);
      if (s.behind || Math.abs(s.x) > 1 || Math.abs(s.y) > 1) continue;
      html += `<span class="${m.on ? 'on' : ''} ${m.done ? 'done' : ''}" style="left:${(s.x + 1) * 50}%;top:${(1 - s.y) * 50}%">${m.text}</span>`;
    }
    if (this.labels.innerHTML !== html) this.labels.innerHTML = html;
    const g = this._guide(eye, dir);
    let showArrow = false;
    if (g) {
      const s = this._project(g);
      let { x, y } = s;
      if (s.behind) { x = -x; y = -y; }
      if (s.behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.86) {
        const ang = Math.atan2(-y, x);
        const ex = Math.cos(ang), ey = Math.sin(ang);
        const k = Math.min(0.88 / Math.abs(ex || 1e-6), 0.8 / Math.abs(ey || 1e-6));
        this.arrow.style.left = `${(1 + ex * k) * 50}%`;
        this.arrow.style.top = `${(1 + ey * k) * 50}%`;
        this.arrow.querySelector('i').style.transform = `rotate(${ang}rad)`;
        const deg = Math.round(angleBetween(dir, norm(sub(g, eye))) / RAD);
        this.arrow.querySelector('span').textContent = `${deg}°`;
        showArrow = true;
      }
    }
    this.arrow.hidden = !showArrow;

    this._status();
    this._gauge();
  }

  _status() {
    const L = this.logic;
    let text = '';
    if (L.kind === 'scan') text = `Target ${Math.min(L.index + 1, L.targets.length)} of ${L.targets.length} · ${L.onTarget ? 'locking…' : 'find the ring'}`;
    else if (L.kind === 'pano') text = `Frame ${L.sectors.filter((s) => s.done).length} of ${L.sectors.length} · ${L.near ? (L.rate > L.maxRate ? 'too fast, hold still' : 'hold still…') : 'turn to a frame'}`;
    else if (L.kind === 'tune') text = `Signal ${Math.round(L.signal * 100)} % · ${L.signal >= 0.9 ? 'hold the peak' : L.signal > 0.4 ? 'warmer' : 'searching'}`;
    else if (L.kind === 'sweep') text = !L.order ? 'Aim at an orange post to start' : `Coverage ${Math.round(L.progress * 100)} % · ${L.fast ? 'too fast, gaps' : 'steady'}`;
    else if (L.kind === 'drill') text = `Core ${Math.min(L.core + 1, L.cores)} of ${L.cores} · depth ${Math.round(L.depth * 100)} % · ${{ ok: 'cutting', low: 'more pressure', high: 'too much pressure', jam: 'bit jammed, backing off' }[L.zone]}`;
    const status = this.q('[data-status]');
    if (status.textContent !== text) status.textContent = text;
    this.q('[data-bar]').style.width = `${L.progress * 100}%`;
    this.el.classList.toggle('th-warn', (L.kind === 'drill' && (L.zone === 'high' || L.zone === 'jam')) || (L.kind === 'sweep' && L.fast) || this.breath.gasp > 0);
  }

  _gauge() {
    const L = this.logic;
    const canvas = this.q('[data-gauge]');
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = 440, H = 64;
    const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d');
    g.setTransform(w / W, 0, 0, h / H, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = '600 10px ui-monospace, Menlo, monospace';
    g.textBaseline = 'middle';
    const label = (t, x, y, c = 'rgba(154,244,255,0.7)') => { g.fillStyle = c; g.fillText(t, x, y); };
    const bar = (x, y, bw, bh, f, c) => {
      g.fillStyle = 'rgba(154,244,255,0.12)'; g.fillRect(x, y, bw, bh);
      g.fillStyle = c; g.fillRect(x, y, bw * clamp(f, 0, 1), bh);
    };
    const chips = (items, y) => items.forEach((st, i) => {
      g.fillStyle = st === 'done' ? '#5cff9a' : st === 'on' ? '#77edff' : 'rgba(154,244,255,0.18)';
      g.fillRect(70 + i * 30, y - 7, 24, 14);
    });
    if (BREATH_TASKS.has(L.kind)) {
      label('BREATH', 0, 50);
      bar(70, 45, 150, 10, this.breath.level, this.breath.gasp > 0 ? '#ff5a45' : this.breath.holding ? '#5cff9a' : '#9af4ff');
      label('⇧ hold', 228, 50, 'rgba(214,251,255,0.55)');
    }
    if (L.kind === 'scan') {
      label('TARGETS', 0, 14);
      chips(L.targets.map((t, i) => (t.done ? 'done' : i === L.index ? 'on' : '')), 14);
      label('AIM', 290, 14);
      bar(320, 9, 120, 10, 1 - clamp((L.error - 1) / 3, 0, 1), L.onTarget ? '#5cff9a' : '#ffc23d');
    } else if (L.kind === 'pano') {
      label('FRAMES', 0, 14);
      chips(L.sectors.map((s) => (s.done ? 'done' : s === L.near ? 'on' : '')), 14);
      label('MOTION', 290, 14);
      bar(340, 9, 100, 10, L.rate / (L.maxRate * 1.6), L.rate > L.maxRate ? '#ff5a45' : '#5cff9a');
      g.fillStyle = '#d6fbff'; g.fillRect(340 + 100 / 1.6, 6, 2, 16);
    } else if (L.kind === 'sweep') {
      label('LINE', 0, 14);
      L.samples.forEach((s, i) => { g.fillStyle = s.done ? '#5cff9a' : s === L.next ? '#d6fbff' : 'rgba(154,244,255,0.25)'; g.fillRect(70 + i * 9.5, 8, 7, 12); });
      label('SPEED', 290, 50);
      bar(340, 45, 100, 10, L.rate / (L.maxRate * 1.6), L.fast ? '#ff5a45' : '#5cff9a');
      g.fillStyle = '#d6fbff'; g.fillRect(340 + 100 / 1.6, 42, 2, 16);
    } else if (L.kind === 'tune') {
      label('SIGNAL', 0, 30);
      for (let i = 0; i < 12; i++) {
        const lit = L.signal * 12 > i;
        g.fillStyle = lit ? (L.signal >= 0.9 ? '#5cff9a' : '#77edff') : 'rgba(154,244,255,0.14)';
        const bh = 8 + i * 3.6;
        g.fillRect(70 + i * 20, 52 - bh, 14, bh);
      }
      label('LOCK', 330, 30);
      bar(365, 25, 75, 10, L.lock, '#5cff9a');
    } else if (L.kind === 'drill') {
      label('PRESSURE', 0, 16);
      const x0 = 70, bw = 370;
      g.fillStyle = 'rgba(154,244,255,0.12)'; g.fillRect(x0, 8, bw, 16);
      const { center, half } = L.band;
      g.fillStyle = 'rgba(92,255,154,0.75)'; g.fillRect(x0 + bw * clamp(center - half, 0, 1), 8, bw * half * 2, 16);
      g.fillStyle = 'rgba(255,90,69,0.55)'; g.fillRect(x0 + bw * clamp(center + half + 0.12, 0, 1), 8, bw * (1 - clamp(center + half + 0.12, 0, 1)), 16);
      g.fillStyle = L.zone === 'ok' ? '#5cff9a' : L.zone === 'low' ? '#d6fbff' : '#ff5a45';
      g.fillRect(x0 + bw * L.pressure - 2, 4, 4, 24);
      label('DEPTH', 0, 50);
      bar(70, 45, 370, 10, L.depth, '#9af4ff');
    }
  }
}
