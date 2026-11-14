import * as THREE from 'three';
import { SITE, ROVER, LIFE_SUPPORT, SLOPE_CLASSES } from '../config/mission.js';
import { formatHMS, formatHM, formatDist, clamp } from '../core/math.js';
import { ZONE_COLORS, bearingTo } from './mapRenderer.js';

const $ = (id) => document.getElementById(id);

function fitCanvas(canvas, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

const kmh = (ms) => ms * 3.6;

export class Hud {
  constructor({ route, mission, mapRenderer, layers, input }) {
    this.route = route;
    this.mission = mission;
    this.map = mapRenderer;
    this.layers = layers;
    this.input = input;
    this.logLines = [];
    this.cardKey = '';
    this.overlayOpen = false;
    this.overlayTimer = 0;
    this.hidden = false;
    this._v = new THREE.Vector3();
    this._buildMarkers();
    this._buildLayerButtons();
    $('evaId').textContent = SITE.eva;
    $('siteName').textContent = SITE.name;
    $('sol').textContent = SITE.sol;
    $('mapSite').textContent = SITE.name;
    $('mapClose').addEventListener('click', () => this.toggleMap(false));
  }

  // ------------------------------------------------------------ setup
  _buildMarkers() {
    const root = $('markers');
    this.markers = [];
    for (const st of this.route.stations) {
      const el = document.createElement('div');
      el.className = `marker ${st.final ? 'hab' : ''}`;
      el.innerHTML = `<span class="label">${st.final ? 'HAB' : `${st.id} · ${st.name.toUpperCase()}`}</span><span class="dist"></span><span class="icon"></span>`;
      root.appendChild(el);
      this.markers.push({ el, kind: 'station', ref: st, x: st.x, y: st.h + 4.5, z: st.z });
    }
    for (const z of this.route.zones) {
      if (z.severity !== 'danger') continue;
      const p = this.route.sample(z.s0);
      const el = document.createElement('div');
      el.className = 'marker gate';
      el.innerHTML = `<span class="label">⚠ ${z.type}</span><span class="dist"></span><span class="icon"></span>`;
      root.appendChild(el);
      this.markers.push({ el, kind: 'gate', ref: z, x: p.x, y: this.route.terrain.heightAt(p.x, p.z) + 2.6, z: p.z });
    }
  }

  _buildLayerButtons() {
    const box = $('layerButtons');
    this.layerButtons = this.layers.map((l) => {
      const b = document.createElement('button');
      b.textContent = `${l.key} ${l.name.split(' ')[0]}`;
      b.dataset.id = l.id;
      box.appendChild(b);
      return b;
    });
  }

  onLayerClick(fn) {
    for (const b of this.layerButtons) b.addEventListener('click', () => fn(b.dataset.id));
  }

  setLayer(layer) {
    for (const b of this.layerButtons) b.classList.toggle('on', b.dataset.id === layer.id);
    $('layerChip').innerHTML = `LAYER <b>${layer.name}</b> · <em>${layer.source}</em>`;
    const lg = layer.legend;
    let html = '';
    if (lg.type === 'classes') {
      html = lg.items.map(([name, col, note]) => `<span><i class="sw" style="background:${col}"></i>${name} <small>${note}</small></span>`).join('');
    } else if (lg.type === 'gradient') {
      html = `<div class="grad" style="background:linear-gradient(90deg,${lg.stops.join(',')})"></div><span>${lg.lo}</span><span style="margin-left:auto">${lg.hi}</span>`;
    } else html = `<span>${lg.text}</span>`;
    html += `<span class="src">SOURCE: ${layer.source} → planned: ${layer.future}</span>`;
    $('legend').innerHTML = html;
    $('mapSub').textContent = `Layer: ${layer.name} (${layer.source}) · planned source: ${layer.future}`;
  }

  fillBriefing() {
    const R = this.route;
    const gates = R.zones.filter((z) => z.severity === 'danger').length;
    const items = [
      ['TRAVERSE', formatDist(R.length)],
      ['SCI STATIONS', R.stations.length - 1],
      ['HAZARD GATES', gates],
      ['MAX TILT', `${R.stats.maxTilt.toFixed(1)}°`],
      ['TOTAL CLIMB', `${Math.round(R.stats.climb)} m`],
      ['EVA BUDGET', `${LIFE_SUPPORT.evaHours} h O₂`],
      ['ROVER VMAX', `${Math.round(kmh(ROVER.maxSpeed))} km/h`],
      ['SITE', 'Vera Rubin Ridge'],
    ];
    $('briefGrid').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  }

  ready(onBegin, label = 'BEGIN EVA ▸') {
    const b = $('beginBtn');
    b.disabled = false;
    b.textContent = label;
    b.onclick = onBegin;
  }

  showHud() {
    $('brief').classList.add('hidden');
    $('hud').classList.remove('hidden');
  }

  toggleHidden() {
    this.hidden = !this.hidden;
    $('hud').classList.toggle('off', this.hidden);
  }

  // ------------------------------------------------------------ log
  log(text, tone = 'info') {
    const el = $('log');
    const line = document.createElement('div');
    line.className = tone;
    line.innerHTML = `<span class="t">${formatHMS(this.mission.met)}</span>${text}`;
    el.appendChild(line);
    this.logLines.push(line);
    while (this.logLines.length > 6) this.logLines.shift().remove();
    this.logLines.forEach((l, i) => l.classList.toggle('old', i < this.logLines.length - 3));
  }

  // ------------------------------------------------------------ per frame
  update(dt, view) {
    const M = this.mission;
    // clocks
    $('met').textContent = formatHMS(M.met);
    $('lmst').textContent = formatHM(M.lmst);

    // vitals
    const o2 = M.o2Remaining;
    this._vital('v-o2', formatHM(o2), o2 / (LIFE_SUPPORT.evaHours * 60), o2 < 45 ? 'danger' : o2 < 90 ? 'warn' : '');
    const pw = M.batteryPct;
    this._vital('v-pwr', `${pw.toFixed(0)} %`, pw / 100, pw < 15 ? 'danger' : pw < 30 ? 'warn' : '');
    this._vital('v-dose', `${M.dose.toFixed(1)} µSv`, null, '');
    this._vital('v-comms', M.comms.los ? `LOS +${M.comms.margin.toFixed(0)} dB` : 'RELAY', null, M.comms.los ? 'ok' : 'warn');
    const wb = M.walkback();
    this._vital('v-walk', `${(wb.distance / 1000).toFixed(2)}/${(wb.limit / 1000).toFixed(1)} km`, clamp(wb.distance / Math.max(1, wb.limit), 0, 1), wb.distance > wb.limit ? 'danger' : wb.distance > wb.limit * 0.7 ? 'warn' : '');

    // navigation
    const next = M.nextStop;
    const station = M.nextStation;
    if (next) {
      const name = next.kind === 'gate' ? `⚠ ${next.ref.type}` : next.ref.final ? 'HABITAT' : `${next.ref.id} · ${next.ref.name}`;
      $('nextName').textContent = name;
      const d = Math.max(0, next.s - M.s);
      $('nextDist').textContent = formatDist(d);
      const v = Math.max(M.speed, 0.6);
      $('nextEta').textContent = M.state === 'drive' ? `ETA ${formatHM(d / v / 60)}` : M.state.toUpperCase();
    }
    $('speedVal').textContent = kmh(M.speed).toFixed(1);
    const lim = $('speedLimit');
    const limit = this.route.speedLimitAt(M.s + 3);
    lim.textContent = M.governed ? `LIMITED · ${M.limitReason}` : `LIMIT ${Math.round(kmh(limit))} km/h`;
    lim.classList.toggle('gov', M.governed || limit < ROVER.maxSpeed);

    const zi = $('zoneInfo');
    zi.innerHTML = M.activeZones.length
      ? M.activeZones.map((z) => `<span class="tag ${z.severity}">${z.type}</span>`).join('')
      : '';

    this._attitude(view.pitch, view.roll);
    this._compass(view, station);
    this._progress();
    this._markers(view);
    this._alerts(wb);
    this._prompt();
    this._updateCard();

    if (this.overlayOpen) {
      this.overlayTimer -= dt;
      if (this.overlayTimer <= 0) {
        this.overlayTimer = 0.4;
        this._drawOverlay(view);
      }
    }
  }

  _vital(id, text, frac, cls) {
    const el = $(id);
    el.querySelector('.v').textContent = text;
    el.className = `vital ${cls}`;
    const bar = el.querySelector('.bar > i');
    if (bar && frac !== null) bar.style.width = `${clamp(frac, 0, 1) * 100}%`;
  }

  _attitude(pitch, roll) {
    const c = $('attitudeCanvas');
    const g = fitCanvas(c, 220, 92);
    g.clearRect(0, 0, 220, 92);
    const col = (a) => (Math.abs(a) >= SLOPE_CLASSES.danger ? ZONE_COLORS.danger : Math.abs(a) >= SLOPE_CLASSES.caution ? ZONE_COLORS.caution : '#9af4ff');
    const draw = (cx, label, angle, shown, side) => {
      g.save();
      g.translate(cx, 46);
      // horizon reference
      g.strokeStyle = 'rgba(154,244,255,0.25)';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(-42, 12); g.lineTo(42, 12); g.stroke();
      g.rotate((-angle * Math.PI) / 180);
      g.strokeStyle = col(angle);
      g.fillStyle = col(angle);
      g.lineWidth = 2;
      if (side) {
        // side view: body + two wheels, nose to the left
        g.strokeRect(-26, -6, 52, 10);
        g.beginPath(); g.arc(-17, 8, 6, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.arc(17, 8, 6, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(-10, -6); g.lineTo(-10, -18); g.lineTo(14, -18); g.lineTo(14, -6); g.stroke();
      } else {
        // rear view
        g.strokeRect(-20, -6, 40, 10);
        g.fillRect(-28, 0, 7, 14);
        g.fillRect(21, 0, 7, 14);
        g.beginPath(); g.moveTo(-16, -6); g.lineTo(-14, -20); g.lineTo(14, -20); g.lineTo(16, -6); g.stroke();
      }
      g.restore();
      g.fillStyle = col(angle);
      g.font = '600 13px ui-monospace, monospace';
      g.textAlign = 'center';
      g.fillText(`${shown >= 0 ? '+' : ''}${shown.toFixed(1)}°`, cx, 88);
      g.fillStyle = 'rgba(154,244,255,0.6)';
      g.font = '10px ui-monospace, monospace';
      g.fillText(label, cx, 10);
    };
    // side-view icon has its nose on the left: nose-up → rotate clockwise
    draw(56, 'PITCH', -pitch, pitch, true);
    draw(164, 'ROLL', roll, roll, false);
  }

  _compass(view, station) {
    const c = $('compassCanvas');
    const W = c.clientWidth || 520;
    const g = fitCanvas(c, W, 54);
    g.clearRect(0, 0, W, 54);
    const hdg = view.headingDeg;
    const span = 120;
    const pxPerDeg = W / span;
    const X = (deg) => {
      let d = deg - hdg;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return W / 2 + d * pxPerDeg;
    };
    const grd = g.createLinearGradient(0, 0, W, 0);
    grd.addColorStop(0, 'rgba(154,244,255,0)');
    grd.addColorStop(0.2, 'rgba(154,244,255,0.85)');
    grd.addColorStop(0.8, 'rgba(154,244,255,0.85)');
    grd.addColorStop(1, 'rgba(154,244,255,0)');
    g.strokeStyle = grd;
    g.fillStyle = grd;
    g.lineWidth = 1;
    g.font = '600 11px ui-monospace, monospace';
    g.textAlign = 'center';
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = Math.floor((hdg - span / 2) / 5) * 5; d <= hdg + span / 2; d += 5) {
      const dd = ((d % 360) + 360) % 360;
      const x = X(dd);
      const major = dd % 15 === 0;
      g.beginPath();
      g.moveTo(x, 30);
      g.lineTo(x, major ? 20 : 25);
      g.stroke();
      if (dd % 45 === 0) g.fillText(names[dd], x, 15);
      else if (dd % 15 === 0) {
        g.save();
        g.globalAlpha = 0.6;
        g.fillText(String(dd).padStart(3, '0'), x, 15);
        g.restore();
      }
    }
    const mark = (deg, color, shape) => {
      const x = X(deg);
      if (x < 6 || x > W - 6) return;
      g.fillStyle = color;
      g.beginPath();
      if (shape === 'diamond') { g.moveTo(x, 33); g.lineTo(x + 5, 38); g.lineTo(x, 43); g.lineTo(x - 5, 38); }
      else { g.rect(x - 4, 34, 8, 8); }
      g.closePath();
      g.fill();
    };
    const M = this.mission;
    if (M.pos) {
      const habB = (bearingTo(M.pos.x, M.pos.z, 0, 0) * 180) / Math.PI;
      mark(((habB % 360) + 360) % 360, '#ffffff', 'square');
      if (station) {
        const b = (bearingTo(M.pos.x, M.pos.z, station.x, station.z) * 180) / Math.PI;
        mark(((b % 360) + 360) % 360, '#56e0ff', 'diamond');
      }
    }
    // caret + heading box
    g.fillStyle = '#d6fbff';
    g.beginPath(); g.moveTo(W / 2, 32); g.lineTo(W / 2 - 5, 40); g.lineTo(W / 2 + 5, 40); g.closePath(); g.fill();
    g.font = '600 12px ui-monospace, monospace';
    g.fillText(`${String(Math.round(hdg) % 360).padStart(3, '0')}°`, W / 2, 53);
  }

  _progress() {
    const c = $('progressCanvas');
    const W = c.clientWidth || 760;
    const g = fitCanvas(c, W, 40);
    g.clearRect(0, 0, W, 40);
    const R = this.route;
    const pad = 10;
    const X = (s) => pad + (s / R.length) * (W - pad * 2);
    const y = 22;
    g.fillStyle = 'rgba(154,244,255,0.16)';
    g.fillRect(pad, y - 2, W - pad * 2, 4);
    for (const z of R.zones) {
      g.fillStyle = z.severity === 'danger' ? ZONE_COLORS.danger : 'rgba(255,194,61,0.75)';
      g.fillRect(X(z.s0), y - 2, Math.max(2, X(z.s1) - X(z.s0)), 4);
    }
    const M = this.mission;
    g.fillStyle = 'rgba(214,251,255,0.9)';
    g.fillRect(pad, y - 1, X(M.s) - pad, 2);
    g.font = '600 10px ui-monospace, monospace';
    g.textAlign = 'center';
    for (const st of R.stations) {
      const x = X(st.s);
      g.fillStyle = st.done ? '#5cff9a' : st.final ? '#ffffff' : '#56e0ff';
      g.beginPath();
      g.moveTo(x, y - 7); g.lineTo(x + 5, y); g.lineTo(x, y + 7); g.lineTo(x - 5, y);
      g.closePath();
      g.fill();
      g.fillText(st.final ? 'HAB' : st.id, x, 10);
    }
    const x = X(M.s);
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(x, y + 4); g.lineTo(x + 6, y + 14); g.lineTo(x - 6, y + 14); g.closePath(); g.fill();
    g.textAlign = 'right';
    g.fillStyle = 'rgba(154,244,255,0.7)';
    g.fillText(`${formatDist(M.s)} / ${formatDist(R.length)}`, W - pad, 38);
  }

  _markers(view) {
    const cam = view.camera;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const M = this.mission;
    const nextId = M.nextStation ? M.nextStation.id : null;
    for (const mk of this.markers) {
      const el = mk.el;
      let visible = true;
      let cls = '';
      if (mk.kind === 'station') {
        const st = mk.ref;
        cls = st.done ? 'done' : st.id === nextId ? 'next' : 'other';
        if (st.final && nextId !== 'HAB' && M.s < 60) cls = 'other';
      } else {
        const z = mk.ref;
        const ahead = z.s0 - M.s;
        visible = ahead > -5 && ahead < 220 && !(z.acknowledged && ahead < 0);
        cls = z.acknowledged ? 'ack' : '';
      }
      const d = Math.hypot(mk.x - view.x, mk.z - view.z);
      if (mk.kind === 'station' && d < 9) visible = false;
      if (!visible) {
        el.style.opacity = 0;
        continue;
      }
      this._v.set(mk.x, mk.y, mk.z).project(cam);
      let sx = (this._v.x * 0.5 + 0.5) * W;
      let sy = (-this._v.y * 0.5 + 0.5) * H;
      const behind = this._v.z > 1;
      let edge = false;
      if (behind) {
        sx = W - sx;
        sy = H - 60;
        edge = true;
      }
      const m = 46;
      if (sx < m || sx > W - m || sy < 90 || sy > H - 80) edge = true;
      // only the next target is shown when off-screen
      const important = mk.kind === 'gate' || cls === 'next';
      if (edge && !important) {
        el.style.opacity = 0;
        continue;
      }
      sx = clamp(sx, m, W - m);
      sy = clamp(sy, 90, H - 80);
      el.style.opacity = 1;
      el.className = `marker ${mk.kind === 'gate' ? 'gate' : ''} ${mk.ref.final ? 'hab' : ''} ${cls} ${edge ? 'edge' : ''}`;
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      el.querySelector('.dist').textContent = formatDist(d);
    }
  }

  _alerts(wb) {
    const M = this.mission;
    const el = $('alert');
    let msg = '';
    let tone = '';
    if (wb.distance > wb.limit) { msg = 'WALKBACK LIMIT EXCEEDED — RETURN TOWARD HAB'; tone = 'danger'; }
    else if (M.o2Remaining < 45) { msg = 'O₂ LOW — RETURN TO HAB'; tone = 'danger'; }
    else if (M.batteryPct < 15) { msg = 'ROVER POWER LOW'; tone = 'danger'; }
    else if (M.state === 'drive' && M.offRoute) { msg = 'CORRIDOR EDGE — STEER BACK TO ROUTE'; tone = 'warn'; }
    else if (M.state === 'drive' && M.activeZones.some((z) => z.severity === 'danger')) { msg = `HAZARD ZONE · ${M.activeZones.find((z) => z.severity === 'danger').type}`; tone = 'danger'; }
    else if (!M.comms.los) { msg = 'NO DIRECT LINE-OF-SIGHT TO HAB · ORBITER RELAY'; tone = 'warn'; }
    else if (M.governed) { msg = `SPEED LIMITED · ${M.limitReason}`; tone = 'info'; }
    el.textContent = msg;
    el.className = `alert ${msg ? 'show' : ''} ${tone}`;
  }

  _prompt() {
    const M = this.mission;
    const el = $('prompt');
    let html = '';
    if (M.state === 'drive') {
      if (M.cruise) html = `CRUISE ON · <kbd>S</kbd> to cancel${M.boosting ? ' · TIME ×3' : ''}`;
      else if (M.speed < 0.15 && !this.input.throttle) html = `<span class="pulse">HOLD <kbd>W</kbd> TO DRIVE THE SURVIVAL ROUTE</span>`;
      else if (M.boosting) html = 'TIME ×3';
    } else if (M.state === 'gate') html = `<span class="pulse">HAZARD BRIEFING — PRESS <kbd>ENTER</kbd> TO ACKNOWLEDGE</span>`;
    else if (M.state === 'station') {
      const t = M.nextStop.ref.tasks.find((x) => !x.done);
      html = t ? `HOLD <kbd>E</kbd> — ${t.label.toUpperCase()}` : '';
    } else if (M.state === 'stationDone') html = `<span class="pulse">PRESS <kbd>ENTER</kbd> TO ${M.nextStop.ref.final ? 'END THE EVA' : 'RESUME THE TRAVERSE'}</span>`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // ------------------------------------------------------------ cards
  _updateCard() {
    const M = this.mission;
    const card = $('card');
    const stop = M.nextStop;
    const showing = ['gate', 'station', 'stationDone'].includes(M.state);
    const key = showing ? `${M.state === 'gate' ? 'g' : 's'}:${stop.ref.id}` : '';
    if (key !== this.cardKey) {
      this.cardKey = key;
      if (!showing) {
        card.classList.add('hidden');
        card.innerHTML = '';
      } else if (M.state === 'gate') this._gateCard(card, stop.ref);
      else this._stationCard(card, stop.ref);
    }
    if (showing && M.state !== 'gate') {
      const st = stop.ref;
      const active = st.tasks.find((t) => !t.done);
      card.querySelectorAll('.task').forEach((el, i) => {
        const t = st.tasks[i];
        el.classList.toggle('done', t.done);
        el.classList.toggle('active', t === active);
        el.classList.toggle('locked', !t.done && t !== active);
        el.querySelector('.fill').style.width = `${(t.done ? 1 : t.progress) * 100}%`;
        const res = el.querySelector('.res');
        if (t.done && res.textContent === '') res.textContent = `→ ${t.result}`;
      });
      const cta = card.querySelector('.cta');
      const done = st.tasks.every((t) => t.done);
      cta.disabled = !done;
      cta.textContent = done ? (st.final ? 'END EVA [ENTER]' : 'RESUME TRAVERSE [ENTER]') : 'HOLD [E] ON EACH TASK';
    }
  }

  _gateCard(card, z) {
    card.className = 'card gate';
    const len = Math.round(z.s1 - z.s0);
    card.innerHTML = `
      <div class="kicker">HAZARD GATE · ROVER STOPPED</div>
      <h2>${z.type}</h2>
      <div class="facts">
        <div class="fact"><span>LENGTH</span><b>${len} m</b></div>
        <div class="fact"><span>MAX TILT</span><b>${z.maxTilt.toFixed(1)}°</b></div>
        <div class="fact"><span>LIMIT</span><b>${Math.round(kmh(z.limit))} km/h</b></div>
      </div>
      <h3>PROCEDURE</h3>
      <ul>${z.procedure.map((p) => `<li>${p}</li>`).join('')}</ul>
      <div class="basis">DATA BASIS · ${z.basis}</div>
      <button class="cta">ACKNOWLEDGE &amp; PROCEED [ENTER]</button>`;
    card.querySelector('.cta').addEventListener('click', () => this.mission.acknowledge());
  }

  _stationCard(card, st) {
    card.className = 'card';
    const T = this.route.terrain;
    const slope = T.slopeAt(st.x, st.z, 3);
    const total = st.tasks.reduce((s, t) => s + t.minutes, 0);
    card.innerHTML = `
      <div class="kicker">${st.final ? 'END OF TRAVERSE' : `SCIENCE STATION ${st.id}`} · ${st.tasks.length} TASK${st.tasks.length > 1 ? 'S' : ''}</div>
      <h2>${st.name}</h2>
      <div class="obj">${st.objective}</div>
      <div class="facts">
        <div class="fact"><span>ELEV</span><b>${st.h.toFixed(0)} m</b></div>
        <div class="fact"><span>SLOPE</span><b>${slope.toFixed(1)}°</b></div>
        <div class="fact"><span>TIME</span><b>${total} min</b></div>
      </div>
      <h3>WHY HERE</h3>
      <ul>${st.why.map((w) => `<li>${w}</li>`).join('')}</ul>
      <h3>TASKS</h3>
      <div class="tasks">${st.tasks
        .map(
          (t) => `<div class="task"><i class="fill"></i><i class="chk"></i><span class="lbl">${t.label}</span><span class="min">${t.minutes} min</span><span class="res"></span></div>`,
        )
        .join('')}</div>
      <button class="cta" disabled>HOLD [E] ON EACH TASK</button>`;
    card.querySelectorAll('.task').forEach((el) => {
      const on = (e) => {
        if (!el.classList.contains('active')) return;
        e.preventDefault();
        this.input.virtual.action = true;
      };
      const off = () => (this.input.virtual.action = false);
      el.addEventListener('pointerdown', on);
      el.addEventListener('pointerup', off);
      el.addEventListener('pointerleave', off);
      el.addEventListener('pointercancel', off);
    });
    card.querySelector('.cta').addEventListener('click', () => this.mission.acknowledge());
  }

  // ------------------------------------------------------------ map overlay
  toggleMap(force) {
    this.overlayOpen = force === undefined ? !this.overlayOpen : force;
    $('mapOverlay').classList.toggle('hidden', !this.overlayOpen);
    this.overlayTimer = 0;
    if (this.overlayOpen) this._fillRouteTables();
  }

  _fillRouteTables() {
    const R = this.route;
    const gates = R.zones.filter((z) => z.severity === 'danger');
    const stats = [
      ['LENGTH', formatDist(R.length)],
      ['TOTAL CLIMB', `${Math.round(R.stats.climb)} m`],
      ['MAX TILT', `${R.stats.maxTilt.toFixed(1)}°`],
      ['RELIEF', `${(R.stats.maxH - R.stats.minH).toFixed(0)} m`],
      ['HAZARD GATES', gates.length],
      ['CAUTION ZONES', R.zones.length - gates.length],
    ];
    $('routeStats').innerHTML = stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    $('zoneTable').innerHTML = R.zones
      .map(
        (z) => `<div class="zone-row"><i style="background:${ZONE_COLORS[z.severity]}"></i>
        <div><b>${z.type}</b><small>${Math.round(z.s0)}–${Math.round(z.s1)} m · tilt ≤ ${z.maxTilt.toFixed(1)}° · ${z.severity.toUpperCase()}</small></div>
        <span>${Math.round(kmh(z.limit))} km/h</span></div>`,
      )
      .join('');
  }

  _drawOverlay(view) {
    const mc = $('mapCanvas');
    const r = mc.getBoundingClientRect();
    const g = fitCanvas(mc, Math.max(200, r.width), Math.max(200, r.height));
    this.map.drawOverview(g, Math.max(200, r.width), Math.max(200, r.height), { x: view.x, z: view.z, heading: (view.headingDeg * Math.PI) / 180, s: this.mission.s });
    const pc = $('profileCanvas');
    const pr = pc.getBoundingClientRect();
    const pg = fitCanvas(pc, Math.max(200, pr.width), 170);
    this.map.drawProfile(pg, Math.max(200, pr.width), 170, this.mission.s);
  }

  // ------------------------------------------------------------ debrief
  showDebrief(onRestart, { title = 'TRAVERSE COMPLETE', approval = null } = {}) {
    const M = this.mission;
    $('hud').classList.add('hidden');
    $('card').classList.add('hidden');
    const gates = this.route.zones.filter((z) => z.severity === 'danger').length;
    const items = [
      ['DISTANCE', formatDist(M.distance)],
      ['MET', formatHMS(M.met)],
      ['O₂ REMAINING', formatHM(M.o2Remaining)],
      ['ROVER PWR', `${M.batteryPct.toFixed(0)} %`],
      ['DOSE', `${M.dose.toFixed(1)} µSv`],
      ['SAMPLES', M.samples],
      ['GATES CLEARED', `${this.route.zones.filter((z) => z.severity === 'danger' && z.acknowledged).length} / ${gates}`],
      ['STATIONS', `${this.route.stations.filter((s) => s.done && !s.final).length} / ${this.route.stations.length - 1}`],
    ];
    $('debriefTitle').firstChild.textContent = title;
    const ap = $('debriefApproval');
    ap.className = `approval-banner ${approval && approval.ok ? 'ok' : 'no'}`;
    ap.innerHTML = approval
      ? approval.ok
        ? '<b>SURFACE PLAN APPROVED</b><span>This route is cleared for launch.</span>'
        : `<b>NOT APPROVED</b><span>${approval.reasons.join(' ')}</span>`
      : '';
    $('debriefGrid').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    $('debriefSub').textContent = `${SITE.eva} · ${SITE.name}`;
    $('debrief').classList.remove('hidden');
    $('restartBtn').onclick = onRestart;
  }
}
