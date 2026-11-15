import * as THREE from 'three';
import { consumptionEstimate } from '../physics/traverse.js';
import { SITE, ROVER, LIFE_SUPPORT, SLOPE_CLASSES } from '../config/mission.js';
import { RARITY } from '../sim/artifacts.js';
import { temperatureAt } from '../sim/fieldGuidance.js';
import { formatHMS, formatHM, formatDist, clamp } from '../core/math.js';
import { ZONE_COLORS, bearingTo, mapWeatherLabel } from './mapRenderer.js';
import { renderStationChoices } from './stationChoices.js';

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
  constructor({ route, mission, mapRenderer, layers, input, artifacts = [] }) {
    this.artifacts = artifacts;
    this.context = {};
    this.keysMode = '';
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
    $('evaId').textContent = (route.site ?? SITE).eva;
    $('siteName').textContent = (route.site ?? SITE).name;
    $('sol').textContent = (route.site ?? SITE).sol;
    $('mapSite').textContent = (route.site ?? SITE).name;
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
    for (const a of this.artifacts) {
      const el = document.createElement('div');
      el.className = 'marker artifact';
      el.style.setProperty('--rarity', RARITY[a.rarity].color);
      el.innerHTML = `<span class="label">${a.stationId ? a.name : 'Unknown signal'}</span><span class="dist"></span><span class="icon"></span>`;
      root.appendChild(el);
      this.markers.push({ el, kind: 'artifact', ref: a, x: a.x, y: a.y + 1.9, z: a.z });
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
    $('legend').innerHTML = html;
    $('mapSub').textContent = `Layer: ${layer.name} (${layer.source}) · planned source: ${layer.future}`;
  }

  showHud() {
    $('hud').classList.remove('hidden');
  }

  toggleHidden() {
    this.hidden = !this.hidden;
    $('hud').classList.toggle('off', this.hidden);
  }

  // A held input completes one item; the crew must release before starting another.
  updateHold(dt, { held = false, reach = null, paused = false } = {}) {
    const M = this.mission;
    const H = this.hold ??= { target: null, t: 0, latched: false, reason: '' };
    if (paused) { this.heldTask = null; H.target = null; H.t = 0; H.reason = ''; return; }
    if (!held && !this.heldTask) { H.target = null; H.t = 0; H.reason = ''; H.latched = false; return; }
    if (H.latched) return;
    const station = M.currentStation;
    const target = this.heldTask ?? reach ?? station?.tasks.find(t => !t.done && !t.skipped && !t.artifact);
    if (!target || target.done || target.collected || target.skipped) {
      H.target = null;
      H.t = 0;
      return;
    }
    const artifact = target.artifact ?? (target === reach ? reach : null);
    const index = station?.tasks.indexOf(target);
    if (H.target !== target) {
      H.target = target;
      H.t = 0;
      const option = artifact ? null : M.stationOptions.find(o => o.id === `task:${index}`);
      H.reason = artifact ? M.collectionBlockReason(artifact)
        : option ? option.reason : 'Stop the rover at this station before starting work';
      if (H.reason) { H.latched = true; M.emit('log', { text: H.reason, tone: 'warn' }); }
      return; // The preceding frame interval may include time before the press.
    }
    H.t += dt;
    if (H.t < 0.9) return;
    H.latched = true;
    const completed = artifact ? M.collect(artifact) : M.chooseStationAction(`task:${index}`);
    H.t = 0;
    if (!completed) {
      H.reason = artifact ? M.collectionBlockReason(artifact)
        : M.stationOptions.find(o => o.id === `task:${index}`)?.reason || 'Task unavailable; review station conditions';
      M.emit('log', { text: H.reason, tone: 'warn' });
    }
    this.stationDecisionKey = '';
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
    const temp = Math.round(temperatureAt(M.lmst, M.weather.temperatureOffsetC));
    this._vital('v-temp', `${temp} °C`, null, Number.isFinite(M.weather.exposureMinutes) ? 'warn' : '');
    this._vital('v-comms', M.comms.los ? `LOS +${M.comms.margin.toFixed(0)} dB` : 'RELAY', null, M.comms.los ? 'ok' : 'warn');
    const wb = M.walkback();
    this._vital('v-walk', `${(wb.distance / 1000).toFixed(2)}/${(wb.limit / 1000).toFixed(1)} km`, clamp(wb.distance / Math.max(1, wb.limit), 0, 1), wb.distance > wb.limit ? 'danger' : wb.distance > wb.limit * 0.7 ? 'warn' : '');

    // navigation: the next open station (or home), straight-line from where the crew is
    const station = M.nextStation;
    if (station) {
      $('nextName').textContent = station.final ? 'HABITAT' : `${station.id} · ${station.name}`;
      const d = Math.hypot(station.x - view.x, station.z - view.z);
      $('nextDist').textContent = formatDist(d);
      const v = Math.max(M.speed, M.onFoot ? 0.8 : 1.2);
      $('nextEta').textContent = M.onFoot ? `ON FOOT · ${formatHM(d / v / 60)}` : `ETA ${formatHM(d / v / 60)}`;
    }
    $('speedVal').textContent = kmh(M.speed).toFixed(1);
    const lim = $('speedLimit');
    if (M.onFoot) lim.textContent = this.input.down('shift') ? 'RUNNING' : 'WALKING';
    else lim.textContent = M.governed ? `LIMITED · ${M.limitReason}` : M.rover.speed < -0.05 ? 'REVERSE' : `LIMIT ${Math.round(kmh(M.limit))} km/h`;
    lim.classList.toggle('gov', !M.onFoot && (M.governed || M.limit < ROVER.maxSpeed));

    const zi = $('zoneInfo');
    zi.innerHTML = M.activeZones.length
      ? M.activeZones.map((z) => `<span class="tag ${z.severity}">${z.type}</span>`).join('')
      : '';
    this._keys();

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
      } else if (mk.kind === 'gate') {
        // Hazard posts on the planned route: shown ahead while following it.
        const ahead = mk.ref.s0 - M.s;
        visible = !M.offRoute && ahead > -5 && ahead < 220;
      } else {
        const a = mk.ref;
        visible = !a.collected && Math.hypot(a.x - view.x, a.z - view.z) < 90;
        cls = a === this.context.reach ? 'next' : '';
      }
      const d = Math.hypot(mk.x - view.x, mk.z - view.z);
      if (mk.kind === 'station' && d < 9) visible = false;
      if (M.weather.limitsVisibility && d > M.weather.visibilityM) visible = false;
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
      const important = mk.kind === 'gate' || (mk.kind === 'station' && cls === 'next');
      if (edge && !important) {
        el.style.opacity = 0;
        continue;
      }
      sx = clamp(sx, m, W - m);
      sy = clamp(sy, 90, H - 80);
      el.style.opacity = 1;
      el.className = `marker ${mk.kind === 'station' ? '' : mk.kind} ${mk.ref.final ? 'hab' : ''} ${cls} ${edge ? 'edge' : ''}`;
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      el.querySelector('.dist').textContent = formatDist(d);
    }
  }

  _alerts(wb) {
    const M = this.mission;
    const el = $('alert');
    let msg = '';
    let tone = '';
    const fromRover = Math.hypot(M.walker.x - M.rover.x, M.walker.z - M.rover.z);
    if (wb.distance > wb.limit) { msg = 'WALKBACK LIMIT EXCEEDED — RETURN TOWARD HAB'; tone = 'danger'; }
    else if (M.o2Remaining < 45) { msg = 'O₂ LOW — RETURN TO HAB'; tone = 'danger'; }
    else if (M.batteryPct < 15) { msg = 'ROVER POWER LOW'; tone = 'danger'; }
    else if (M.blocked) { msg = M.onFoot ? 'TOO STEEP TO CLIMB ON FOOT' : 'TOO STEEP FOR THE ROVER — FIND ANOTHER WAY'; tone = 'warn'; }
    else if (M.bumped > 0) { msg = 'HABITAT — KEEP CLEAR'; tone = 'warn'; }
    else if (M.activeZones.some((z) => z.severity === 'danger')) { msg = `HAZARD ZONE · ${M.activeZones.find((z) => z.severity === 'danger').type}`; tone = 'danger'; }
    else if (M.onFoot && fromRover > 150) { msg = `ROVER ${Math.round(fromRover)} m AWAY`; tone = 'warn'; }
    else if (!M.comms.los) { msg = 'NO DIRECT LINE-OF-SIGHT TO HAB · ORBITER RELAY'; tone = 'warn'; }
    else if (M.governed) { msg = `SPEED LIMITED · ${M.limitReason}`; tone = 'info'; }
    else if (M.offRoute && !M.onFoot) { msg = `OFF THE PLANNED ROUTE · ${Math.round(M.routeDistance)} m`; tone = 'info'; }
    el.textContent = msg;
    el.className = `alert ${msg ? 'show' : ''} ${tone}`;
  }

  _prompt() {
    const M = this.mission;
    const C = this.context;
    const el = $('prompt');
    let html = '';
    if (this.hold?.t > 0 && this.hold.target?.label) html = `STATION WORK · ${this.hold.target.label} · ${Math.round(this.hold.t / 0.9 * 100)}%`;
    else if (M.state === 'drive') {
      const st = M.currentStation;
      const open = st && !st.skipped ? st.tasks.filter((t) => !t.done && !t.skipped).length : 0;
      const charge = `${Math.round(M.boostCharge * 100)}%`;
      const boost = M.boosting ? 'USING BOOST'
        : M.boostBlocked ? `<span class="boost-off">⇧ BOOST OFF · ${M.boostBlocked}${M.boostBlocked === 'RECHARGING' ? ` ${charge}` : ''}</span>` : '';
      if (M.atHome) html = `<span class="pulse">AT THE HABITAT · <kbd>↵</kbd> END EVA · <kbd>F</kbd> GET OUT</span>`;
      else if (M.legPending) html = `<span class="pulse">${M.legPending.id} DONE · CHOOSE THE NEXT LEG ON YOUR WRIST NAVIGATOR <kbd>P</kbd></span>`;
      else if (st && open && M.speed < 0.3) html = `<span class="pulse">${st.id} · HOLD <kbd>E</kbd> FOR SCIENCE WORK · <kbd>F</kbd> GET OUT TO COLLECT FINDS</span>`;
      else if (st && open) html = `${st.id} · STOP HERE FOR SCIENCE AND ARTIFACTS`;
      else if (M.cruise) html = `CRUISE ON · <kbd>S</kbd> to cancel${boost ? ` · ${boost}` : ''}`;
      else if (M.speed < 0.15 && !this.input.throttle) html = `<span class="pulse">HOLD <kbd>W</kbd> TO DRIVE · THE ROUTE IS A GUIDE, GO ANYWHERE</span>`;
      else if (boost) html = boost;
    } else if (M.state === 'gate') {
      html = `<span class="pulse">NOT ON THE MAP · ROVER STOPPED — PRESS <kbd>ENTER</kbd> TO DEAL WITH IT</span>`;
    } else if (M.state === 'walk') {
      if (C.reach) {
        const p = Math.round((C.collecting || 0) * 100);
        html = `<span class="pulse">HOLD <kbd>E</kbd> — COLLECT ${C.reach.name.toUpperCase()}${p ? ` · ${p} %` : ''}</span>`;
      } else if (M.canBoard) html = `<span class="pulse">PRESS <kbd>F</kbd> TO BOARD THE ROVER</span>`;
      else if (M.atHome) html = `AT THE HABITAT · <kbd>↵</kbd> END EVA`;
      else if (M.legPending) html = `<span class="pulse">${M.legPending.id} DONE · CHOOSE THE NEXT LEG ON YOUR WRIST NAVIGATOR <kbd>P</kbd></span>`;
      else html = 'FOLLOW THE BEAMS TO ARTIFACTS';
    }
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  // Key hints follow what the crew is doing.
  _keys() {
    const mode = this.mission.state;
    if (mode === this.keysMode) return;
    this.keysMode = mode;
    const k = (keys, text) => `<span>${keys.map((x) => `<kbd>${x}</kbd>`).join('')} ${text}</span>`;
    $('keys').innerHTML = mode === 'walk'
      ? [k(['W', 'A', 'S', 'D'], 'walk'), k(['⇧'], 'run'), k(['E'], 'collect · station work (hold)'), k(['F'], 'board rover'), k(['T'], 'view'), k(['I'], 'collection'), k(['M'], 'map'), k(['V'], 'recentre')].join('')
      : [k(['W'], 'drive'), k(['S'], 'brake · hold to reverse'), k(['A', 'D'], 'steer'), k(['C'], 'cruise'), k(['E'], 'station work (hold)'), k(['⇧'], 'boost'), k(['F'], 'get out'), k(['T'], 'view'), k(['I'], 'collection'),
        k(['Z', 'X'], 'look'), k(['B'], 'look back'), k(['M'], 'map'), k(['L'], 'lights'), k(['H'], 'HUD')].join('');
  }

  // ------------------------------------------------------------ cards
  _updateCard() {
    const M = this.mission;
    const card = $('card');
    const gate = M.state === 'gate' && M.surprise ? M.surprise.ref : null;
    const st = ['drive', 'walk'].includes(M.state) ? M.currentStation : null;
    const home = !st && M.atHome && ['drive', 'walk'].includes(M.state);
    // Inside a mapped area hazard: its briefing, without stopping the rover.
    const hazard = !st && !home && M.state === 'drive' ? M.activeZones.find((z) => z.area && z.procedure?.length) : null;
    const key = gate ? `g:${gate.id}` : st ? `s:${st.id}:${M.state}:${st.skipped ? 1 : 0}` : home ? 'home' : hazard ? `h:${hazard.id}` : '';
    if (key !== this.cardKey) {
      this.cardKey = key;
      if (!key) {
        card.classList.add('hidden');
        card.innerHTML = '';
      } else if (gate) this._gateCard(card, gate);
      else if (home) this._homeCard(card);
      else if (hazard) this._hazardCard(card, hazard);
      else this._stationCard(card, st);
    }
    if (st) {
      card.querySelectorAll('.task').forEach((el, i) => {
        const t = st.tasks[i];
        el.classList.toggle('done', t.done);
        el.classList.toggle('skipped', !!t.skipped && !t.done);
        const held = this.hold?.target && (this.hold.target === t || this.hold.target === t.artifact);
        el.classList.toggle('active', !t.done && (held || t.artifact && t.artifact === this.context.reach));
        el.querySelector('.fill').style.width = `${t.done ? 100 : held ? Math.min(100, this.hold.t / 0.9 * 100) : 0}%`;
        el.setAttribute('aria-disabled', String(!!t.done || !!t.skipped));
        const res = el.querySelector('.res');
        res.textContent = t.done || t.skipped ? `→ ${t.done || t.deferred ? t.result : 'Not performed · omitted from selected station plan'}`
          : held ? this.hold.reason : '';
      });
      const left = st.tasks.filter((t) => !t.done && !t.skipped).length;
      const findsLeft = st.tasks.some(t => t.artifact && !t.done && !t.skipped);
      const hint = card.querySelector('.hint');
      const text = st.skipped ? `${st.id} is skipped on this EVA.`
        : !left ? `${st.id} complete.${M.legPending === st ? ' Choose the next leg on your wrist navigator [P].' : ' Board the rover and head for the next station.'}`
        : !findsLeft ? 'Hold E for the next instrument task, or hold a station task button.'
          : M.onFoot ? 'Hold E beside a find to collect it; hold any instrument task button to run it.'
          : 'Hold E or an instrument task button for science. Press F to get out and collect artifacts.';
      if (hint.textContent !== text) hint.textContent = text;
      const decisionKey = `${st.id}:${M.state}:${Math.floor(M.met)}:${st.tasks.map(t => `${!!t.done}${!!t.skipped}`).join('')}:${M.weather.label}`;
      if (decisionKey !== this.stationDecisionKey) {
        this.stationDecisionKey = decisionKey;
        renderStationChoices(card.querySelector('.station-choices'), M);
      }
    }
  }

  _hazardCard(card, z) {
    card.className = 'card gate compact';
    card.innerHTML = `
      <div class="kicker">HAZARD AREA · LIMIT ${Math.round(kmh(z.limit))} km/h</div>
      <h2>${z.type}</h2>
      ${z.obstacles?.length ? `<h3>POSSIBLE HIDDEN OBSTACLES</h3><ul>${z.obstacles.map((o) => `<li>${o}</li>`).join('')}</ul>` : ''}
      <h3>PROCEDURE</h3>
      <ul>${z.procedure.map((p) => `<li>${p}</li>`).join('')}</ul>
      ${z.basis ? `<div class="basis">DATA BASIS · ${z.basis}</div>` : ''}`;
  }

  _homeCard(card) {
    card.className = 'card compact';
    const M = this.mission;
    const done = M.stations.filter((s) => s.done).length;
    card.innerHTML = `
      <div class="kicker">HABITAT AIRLOCK</div>
      <h2>Back at the habitat</h2>
      <div class="obj">${done} of ${M.stations.length} stations complete · ${M.collected.length} artifacts aboard. End the EVA here, or head out again.</div>
      <button class="cta">END EVA [ENTER]</button>`;
    card.querySelector('.cta').addEventListener('click', () => M.endEva());
  }

  // An obstacle the orbital map could not show: the rover is stopped until the crew deals with it.
  _gateCard(card, z) {
    card.className = 'card gate surprise';
    card.innerHTML = `
      <div class="kicker">NOT ON THE MAP · ROVER STOPPED</div>
      <h2>${z.type}</h2>
      <div class="facts">
        <div class="fact"><span>DELAY</span><b>+${z.delayMinutes} min</b></div>
        <div class="fact"><span>O₂ COST</span><b>+${consumptionEstimate(z.delayMinutes * 60, { work: true }).oxygenMinutes.toFixed(1)} min</b></div>
        <div class="fact"><span>TILT HERE</span><b>${z.maxTilt.toFixed(1)}°</b></div>
      </div>
      <h3>PROCEDURE</h3>
      <ul>${z.procedure.map((p) => `<li>${p}</li>`).join('')}</ul>
      <div class="basis">DATA BASIS · ${z.basis}</div>
      <button class="cta">DEAL WITH IT &amp; PROCEED [ENTER]</button>`;
    card.querySelector('.cta').addEventListener('click', () => this.mission.acknowledge());
  }

  _stationCard(card, st) {
    const onFoot = this.mission.onFoot;
    this.stationDecisionKey = '';
    this.heldTask = null;
    if (this.hold) this.hold.t = 0;
    card.className = `card ${onFoot ? 'compact' : ''}`;
    const T = this.route.terrain;
    const slope = T.slopeAt ? T.slopeAt(st.x, st.z, 3) : 0;
    card.innerHTML = `
      <div class="kicker">SCIENCE STATION ${st.id} · SCIENCE &amp; ARTIFACTS</div>
      <h2>${st.name}</h2>
      ${onFoot ? '' : `<div class="obj">${st.objective}</div>
      <div class="facts">
        <div class="fact"><span>ELEV</span><b>${st.h.toFixed(0)} m</b></div>
        <div class="fact"><span>SLOPE</span><b>${slope.toFixed(1)}°</b></div>
        <div class="fact"><span>FINDS</span><b>${st.tasks.length}</b></div>
      </div>
      <h3>WHY HERE</h3>
      <ul>${st.why.map((w) => `<li>${w}</li>`).join('')}</ul>
      ${st.observation ? `<a class="station-observation" href="${st.observation.source}" target="_blank" rel="noopener">
        <img src="${st.observation.image}" alt="Horizontal rock beds photographed by Curiosity">
        Curiosity Mastcam · Sol 1790 ↗</a>` : ''}`}
      <h3>STATION WORK</h3>
      <div class="tasks">${st.tasks.map((t) => `<button type="button" class="task" data-task-index="${st.tasks.indexOf(t)}"><i class="fill"></i><i class="chk" style="border-color:${RARITY[t.artifact?.rarity ?? 'common'].color}"></i><span class="lbl">${t.artifact?.name ?? t.label}</span><span class="min">${t.artifact ? RARITY[t.artifact.rarity].label : `${t.minutes} min`}</span><span class="res" role="status"></span></button>`).join('')}</div>
      <p class="hint"></p>
      <div class="station-choices"></div>`;
    for (const button of card.querySelectorAll('[data-task-index]')) {
      const task = st.tasks[Number(button.dataset.taskIndex)];
      const start = event => {
        if (task.done || task.skipped) return;
        event.preventDefault();
        this.heldTask = task;
      };
      const stop = () => { if (this.heldTask === task) this.heldTask = null; };
      button.addEventListener('pointerdown', start);
      for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) button.addEventListener(type, stop);
      button.addEventListener('keydown', event => { if (['e', 'Enter', ' '].includes(event.key)) start(event); });
      button.addEventListener('keyup', stop);
    }
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
    const weather = this.mission.weather;
    const label = mapWeatherLabel(weather, this.mission.activeFront, this.mission.detectedObstacles);
    if ($('mapWeather').textContent !== label) $('mapWeather').textContent = label;
    const mc = $('mapCanvas');
    const r = mc.getBoundingClientRect();
    const g = fitCanvas(mc, Math.max(200, r.width), Math.max(200, r.height));
    this.map.drawOverview(g, Math.max(200, r.width), Math.max(200, r.height), { x: view.x, z: view.z, heading: (view.headingDeg * Math.PI) / 180, s: this.mission.s, weather, front: this.mission.activeFront, obstacles: this.mission.detectedObstacles });
    const pc = $('profileCanvas');
    const pr = pc.getBoundingClientRect();
    const pg = fitCanvas(pc, Math.max(200, pr.width), 170);
    this.map.drawProfile(pg, Math.max(200, pr.width), 170, this.mission.s);
  }

  // ------------------------------------------------------------ debrief
  showDebrief(onRestart, { items: extraItems = [], note = '', extra = null } = {}) {
    const M = this.mission;
    $('hud').classList.add('hidden');
    $('card').classList.add('hidden');
    const items = [
      ['DRIVEN', formatDist(M.distance)],
      ['MET', formatHMS(M.met)],
      ['O₂ REMAINING', formatHM(M.o2Remaining)],
      ['ROVER PWR', `${M.batteryPct.toFixed(0)} %`],
      ['DOSE', `${M.dose.toFixed(1)} µSv`],
      ['SAMPLES', M.samples],
      ['SCIENCE COMPLETE', M.scienceResults.filter(result => result.status === 'complete').length],
      ['DEGRADED / DEFERRED', M.scienceResults.filter(result => result.quality === 'dust-degraded' || result.status === 'deferred').length],
      ...extraItems,
    ];
    $('debriefGrid').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    const results = document.createElement('div');
    results.className = 'debrief-science';
    const heading = document.createElement('h2');
    heading.textContent = 'Science returned';
    results.appendChild(heading);
    for (const result of M.scienceResults) {
      const p = document.createElement('p');
      p.textContent = `${result.station} · ${result.task} — ${result.result} (${result.status})`;
      results.appendChild(p);
    }
    $('debriefGrid').appendChild(results);
    $('debriefSub').textContent = `${this.mission.aborted ? 'Returned early' : 'Science traverse'} · ${(this.route.site ?? SITE).name}`;
    $('debriefNote').textContent = note;
    $('debriefNote').hidden = !note;
    const more = $('debriefExtra');
    more.hidden = !extra;
    if (extra) {
      more.textContent = extra.label;
      more.onclick = extra.onClick;
    }
    $('debrief').classList.remove('hidden');
    $('restartBtn').onclick = onRestart;
  }
}
