import { SCOUT_PINS, ROUTE_OPTIONS, AREA_HAZARDS, ASSIGNMENT, SITE, STATIONS } from '../config/mission.js';
import { knownAreaHazards, unscoutedDistance } from '../sim/game.js';
import { formatDist } from '../core/math.js';
import { estimateRoute } from '../sim/routeApi.js';
import { createSiteGlobe } from './siteGlobe.js';
import { ZONE_COLORS } from './mapRenderer.js';

// ---------------------------------------------------------------------------
// Mission map: the first playable screen. The player scouts sites (costs
// preparation turns), compares the route options, picks the rehearsal
// conditions and opens the rehearsal or the launch desk.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const AMBER = '#ffc23d';

function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(200, r.width);
  const h = Math.max(200, r.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, W: w, H: h };
}

export class Planner {
  constructor({ game, routes, baseMap, layers, onLayer, snapshot, onRehearse, onDesk }) {
    Object.assign(this, { game, routes, baseMap, layers, onLayer, snapshot, onRehearse, onDesk });
    this.selectedPin = null;
    this.snaps = new Map();
    this.estimates = new WeakMap();
    this.canvas = $('plannerCanvas');
    $('plannerSite').textContent = SITE.name;

    this.view = 'globe';
    $('mapViews').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (b) {
        this.view = b.dataset.view;
        this.render();
      }
    });
    $('plannerLayers').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.layer) onLayer(b.dataset.layer);
      if (b.dataset.style && this.globe) this._setGlobeStyle(b.dataset.style);
      this.render();
    });
    $('globeActions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-globe]');
      if (!b || !this.globe) return;
      if (b.dataset.globe === 'site') {
        if (this.globe.styleId !== 'best') this._setGlobeStyle('best');
        else this.globe.flyToSite(2);
        this.render();
      } else this.globe.home();
    });
    this.canvas.addEventListener('click', (e) => this._onMapClick(e));
    $('pinList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pin]');
      if (b) this.selectPin(b.dataset.pin);
    });
    $('scoutView').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'close') this.selectPin(null);
      if (b.dataset.act === 'scout') {
        game.scout(this.selectedPin, routes);
        this.render();
      }
    });
    $('routeOptions').addEventListener('click', (e) => {
      const b = e.target.closest('[data-route]');
      if (!b) return;
      const opt = ROUTE_OPTIONS.find((o) => o.id === b.dataset.route);
      game.chooseRoute(opt.id, opt.name);
      this.render();
    });
    $('readiness').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.window) {
        game.setRehearsalWindow(b.dataset.window);
        this.render();
      }
      if (b.dataset.act === 'rehearse') onRehearse();
      if (b.dataset.act === 'desk') onDesk();
    });
    window.addEventListener('resize', () => this.visible && this.draw());
  }

  get visible() {
    return !$('planner').classList.contains('hidden');
  }

  show() {
    $('planner').classList.remove('hidden');
    this.render();
    this._ensureGlobe();
  }

  // Relief and Viking are whole-planet maps (~200 m per pixel): at the 1.5 km site they are a
  // single blurred colour, so they are shown at Gale Crater scale. Best flies back to the site.
  _setGlobeStyle(id) {
    const g = this.globe;
    g.setStyle(id);
    const notes = {
      best: 'BEST AVAILABLE · VIKING → MRO CTX (5 m/px) → HiRISE (25 cm/px) · SITE AT VERA RUBIN RIDGE',
      relief: 'COLOUR RELIEF · MOLA + HRSC ELEVATION, 200 m/px · ZOOMED OUT TO GALE CRATER (BLUE = LOW, RED = HIGH)',
      viking: 'VIKING COLOUR · APPROX. TRUE COLOUR, 232 m/px · ZOOMED OUT TO GALE CRATER',
    };
    $('globeStatus').textContent = notes[id] || '';
    if (id === 'best') g.flyToSite(2);
    else g.flyToGale();
  }

  // The team's NASA globe loads lazily (CesiumJS is large) the first time the map opens.
  _ensureGlobe() {
    if (this.globePromise) return;
    $('globeStatus').textContent = 'LOADING MARS GLOBE…';
    this.globePromise = createSiteGlobe($('plannerGlobe'), { onPin: (id) => this.selectPin(id) })
      .then((g) => {
        this.globe = g;
        $('globeStatus').textContent = 'BEST AVAILABLE · VIKING → MRO CTX (5 m/px) → HiRISE (25 cm/px) · SITE AT VERA RUBIN RIDGE';
        this.render();
        setTimeout(() => g.flyToSite(), 700);
      })
      .catch((err) => {
        console.error(err);
        $('globeStatus').textContent = 'GLOBE UNAVAILABLE — SHOWING SITE PLAN';
        this.view = 'plan';
        this.render();
      });
  }

  hide() {
    $('planner').classList.add('hidden');
  }

  selectPin(id) {
    this.selectedPin = id;
    this.render();
  }

  // ------------------------------------------------------------ panels
  render() {
    const { game } = this;
    const run = game.run;
    const sc = game.scenario;

    const wrap = this.canvas.parentElement;
    wrap.classList.toggle('globe', this.view === 'globe');
    wrap.classList.toggle('plan', this.view === 'plan');
    for (const b of $('mapViews').children) b.classList.toggle('on', b.dataset.view === this.view);
    $('plannerLayers').innerHTML =
      this.view === 'globe'
        ? (this.globe ? this.globe.styles : [])
            .map((st) => `<button data-style="${st.id}" class="${this.globe.styleId === st.id ? 'on' : ''}" title="${st.description}">${st.short.toUpperCase()}</button>`)
            .join('')
        : this.layers
            .map((l) => `<button data-layer="${l.id}" class="${this.baseMap.layer?.id === l.id ? 'on' : ''}">${l.key} ${l.name.split(' ')[0]}</button>`)
            .join('');
    $('plannerSub').textContent = `Plan revision ${run.planRevision} · weather: ${sc.source} · scenario ${sc.id}`;
    $('turnStrip').innerHTML =
      `<div class="turn"><span>PREP TURN</span><b>${run.turn}</b></div>` +
      sc.windows
        .map((w) => {
          const open = game.isOpen(w);
          return `<div class="win ${open ? '' : 'closed'}"><span>${w.label.toUpperCase()}</span><b>${open ? `open ≤ T${w.lastOpenTurn}` : 'CLOSED'}</b></div>`;
        })
        .join('');

    $('assignment').innerHTML = `<b>Visit all ${STATIONS.length} stations and return to base.</b>
      <small>Scouting costs 1 turn · windows close as turns pass</small>`;

    $('pinList').innerHTML = SCOUT_PINS.map((p) => {
      const done = run.revealed.includes(p.id);
      const pv = game.previewScout(p.id);
      const tag = done ? '<em class="ok">✓ scouted</em>' : pv.closes.length ? `<em class="warn">1 turn · closes ${pv.closes.map((w) => w.id).join(', ')}</em>` : '<em>1 turn</em>';
      return `<button class="pin-row ${done ? 'done' : ''} ${this.selectedPin === p.id ? 'sel' : ''}" data-pin="${p.id}">
        <i>${p.id}</i><span>${p.name}</span>${tag}</button>`;
    }).join('');

    this._renderRoutes();
    this._renderReadiness();
    this._renderScoutView();
    this.draw();
    if (this.globe && this.view === 'globe') {
      const known = new Set(SCOUT_PINS.filter((p) => run.revealed.includes(p.id)).flatMap((p) => p.reveals));
      this.globe.update({ routes: this.routes, selectedId: run.routeId, revealed: run.revealed, selectedPin: this.selectedPin, knownHazardIds: known });
    }
  }

  _routeStats(opt) {
    const r = this.routes[opt.id];
    const known = knownAreaHazards(r, this.game.run.revealed);
    const slopeGates = r.zones.filter((z) => z.kind === 'slope' && z.severity === 'danger');
    if (!this.estimates.has(r)) this.estimates.set(r, estimateRoute(r));
    return {
      r,
      known,
      slopeGates,
      gates: slopeGates.length + known.length,
      unscouted: unscoutedDistance(r, this.game.run.revealed),
      est: this.estimates.get(r),
    };
  }

  _renderRoutes() {
    const run = this.game.run;
    const stats = ROUTE_OPTIONS.filter((o) => this.routes[o.id]).map((o) => ({ o, ...this._routeStats(o) }));
    $('routeOptions').innerHTML = stats
      .map((s) => {
        const sel = run.routeId === s.o.id;
        const hazards = [
          ...(s.slopeGates.length ? [`steep slope ×${s.slopeGates.length}`] : []),
          ...s.known.map((z) => z.type.toLowerCase().split(' · ')[0]),
        ];
        const badge = s.o.planner ? `<em class="api ${s.o.planner.source}" title="${s.o.note}">${s.o.planner.source === 'api' ? 'API' : 'LOCAL'}</em>` : '';
        return `<button class="route-row ${sel ? 'sel' : ''}" data-route="${s.o.id}" title="${s.o.note}">
          <span class="radio"></span>
          <span class="rr-name">${s.o.name}${badge}</span>
          <span class="rr-stats"><b>${(s.r.length / 1000).toFixed(2)} km</b> · <b>${s.est.oxygenMinutes.toFixed(1)}</b> min O₂ · <b>${Math.round(s.est.batteryWh)}</b> Wh</span>
          <span class="rr-gates ${s.gates ? 'warn' : ''}">⚠ ${s.gates}</span>
          ${sel ? `<span class="rr-hz">${hazards.length ? `Hazards: ${hazards.join(', ')}` : 'No known hazards'}${s.unscouted > 0 ? ' · scout to check the rest' : ''}</span>` : ''}
        </button>`;
      })
      .join('');
  }

  _renderReadiness() {
    const { game } = this;
    const run = game.run;
    const ap = game.approval();
    const chips = game.scenario.windows
      .map((w) => {
        const open = game.isOpen(w);
        const v = game.forecast(w).walk.visibility;
        return `<button class="wx-chip ${run.rehearsalWindowId === w.id ? 'on' : ''} vis-${v}" data-window="${w.id}" ${open ? '' : 'disabled'} title="Rehearse in ${w.label} surface weather">
          <span>${w.id}</span><b>${v}</b></button>`;
      })
      .join('');
    $('readiness').innerHTML = `
      <div class="label">Rehearsal weather</div>
      <div class="wx-chips">${chips}</div>
      <div class="status ${ap.ok ? 'ok' : 'no'}">${ap.ok ? '✓ Plan approved — ready to launch' : `✗ ${ap.reasons[0]}`}</div>
      <div class="btn-row two">
        <button class="primary small" data-act="rehearse">REHEARSE ▸</button>
        <button class="ghost" data-act="desk">LAUNCH DESK ▸</button>
      </div>`;
  }

  _renderScoutView() {
    const el = $('scoutView');
    const pin = SCOUT_PINS.find((p) => p.id === this.selectedPin);
    if (!pin) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    const done = this.game.run.revealed.includes(pin.id);
    if (!done) {
      const pv = this.game.previewScout(pin.id);
      const closes = pv.closes.length
        ? `<div class="warn">⚠ ${pv.closes.map((w) => w.label).join(', ')} will close.${pv.endsAll ? ' No launch window will remain.' : ''}</div>`
        : '';
      el.innerHTML = `<div class="sv-head"><b>${pin.id} · ${pin.name.toUpperCase()}</b><button class="x" data-act="close">✕</button></div>
        <p>Send the scouting team to photograph this ground. Costs <b>1 preparation turn</b> (turn ${this.game.run.turn} → ${pv.turnAfter}).</p>
        ${closes}
        <div class="btn-row"><button class="cta" data-act="scout">SCOUT SITE · 1 TURN</button><button class="ghost" data-act="close">CANCEL</button></div>`;
      return;
    }
    if (!this.snaps.has(pin.id)) this.snaps.set(pin.id, this.snapshot(pin));
    const hz = pin.reveals.map((id) => AREA_HAZARDS.find((h) => h.id === id)?.type).filter(Boolean);
    el.innerHTML = `<div class="sv-head"><b>${pin.id} · ${pin.name.toUpperCase()}</b><button class="x" data-act="close">✕</button></div>
      <img src="${this.snaps.get(pin.id)}" alt="Ground view of ${pin.name}" />
      <p>${pin.finding}</p>
      ${hz.length ? `<div class="warn">Revealed hazard: ${hz.join(', ')}</div>` : ''}
      <small>SIMULATED GROUND VIEW from (${pin.camera.join(', ')}) toward (${pin.at.join(', ')}) · placeholder for rover imagery · reopening is free</small>`;
  }

  // ------------------------------------------------------------ map
  draw() {
    if (!this.visible || this.view !== 'plan') return;
    const { g, W, H } = fitCanvas(this.canvas);
    const m = this.baseMap;
    const b = m.bounds;
    const scale = Math.min(W / (b.x1 - b.x0), H / (b.z1 - b.z0));
    const ox = (W - (b.x1 - b.x0) * scale) / 2;
    const oy = (H - (b.z1 - b.z0) * scale) / 2;
    const toPx = (x, z) => [ox + (x - b.x0) * scale, oy + (z - b.z0) * scale];
    this.toPx = toPx;
    const run = this.game.run;

    g.fillStyle = '#05090b';
    g.fillRect(0, 0, W, H);
    g.drawImage(m.base, ox, oy, m.w * m.mpp * scale, m.h * m.mpp * scale);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    for (let x = Math.ceil(b.x0 / 100) * 100; x < b.x1; x += 100) {
      const [px] = toPx(x, 0);
      g.beginPath(); g.moveTo(px, oy); g.lineTo(px, oy + (b.z1 - b.z0) * scale); g.stroke();
    }
    for (let z = Math.ceil(b.z0 / 100) * 100; z < b.z1; z += 100) {
      const [, py] = toPx(0, z);
      g.beginPath(); g.moveTo(ox, py); g.lineTo(ox + (b.x1 - b.x0) * scale, py); g.stroke();
    }

    // scouted ground
    for (const p of SCOUT_PINS) {
      if (!run.revealed.includes(p.id) && this.selectedPin !== p.id) continue;
      const [px, py] = toPx(p.at[0], p.at[1]);
      g.fillStyle = run.revealed.includes(p.id) ? 'rgba(255,194,61,0.10)' : 'rgba(255,255,255,0.06)';
      g.strokeStyle = run.revealed.includes(p.id) ? 'rgba(255,194,61,0.55)' : 'rgba(255,255,255,0.5)';
      g.setLineDash([4, 4]);
      g.beginPath(); g.arc(px, py, p.radius * scale, 0, Math.PI * 2); g.fill(); g.stroke();
      g.setLineDash([]);
    }
    // known area hazards
    const known = new Set(SCOUT_PINS.filter((p) => run.revealed.includes(p.id)).flatMap((p) => p.reveals));
    for (const hz of AREA_HAZARDS) {
      if (!known.has(hz.id)) continue;
      const [px, py] = toPx(hz.cx, hz.cz);
      g.fillStyle = 'rgba(255,90,69,0.16)';
      g.strokeStyle = 'rgba(255,90,69,0.9)';
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(px, py, hz.radius * scale, 0, Math.PI * 2); g.fill(); g.stroke();
    }

    // routes: others dim, selected coloured by known hazards
    for (const [k, opt] of ROUTE_OPTIONS.entries()) {
      const r = this.routes[opt.id];
      if (opt.id === run.routeId || !r) continue;
      g.strokeStyle = 'rgba(214,251,255,0.45)';
      g.lineWidth = 2;
      g.setLineDash([7, 6]);
      g.beginPath();
      for (let i = 0; i < r.count; i += 3) {
        const [px, py] = toPx(r.x[i], r.z[i]);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
      g.setLineDash([]);
      const mid = r.sample(r.length * [0.5, 0.62, 0.34][k % 3]);
      const [lx, ly] = toPx(mid.x, mid.z);
      this._tag(g, lx + 8, ly, opt.name.toUpperCase(), 'rgba(214,251,255,0.7)');
    }
    this._drawSelected(g, toPx, this.routes[run.routeId], known);

    // pins
    for (const p of SCOUT_PINS) {
      const [px, py] = toPx(p.at[0], p.at[1]);
      const done = run.revealed.includes(p.id);
      const sel = this.selectedPin === p.id;
      g.save();
      g.translate(px, py);
      g.fillStyle = done ? AMBER : 'rgba(5,9,11,0.85)';
      g.strokeStyle = done ? '#1a1205' : '#fff';
      g.lineWidth = sel ? 3 : 2;
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
        g.lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
      }
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = done ? '#1a1205' : '#fff';
      g.font = '700 10px ui-monospace, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(done ? p.id : '?', 0, 1);
      g.restore();
      this._tag(g, px + 16, py + 4, `${p.id} ${p.name}`, done ? AMBER : '#fff');
    }

    // north arrow + scale bar
    g.fillStyle = '#e8f6fa';
    g.font = '600 12px ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText('N', W - 26, 24);
    g.beginPath(); g.moveTo(W - 26, 30); g.lineTo(W - 20, 46); g.lineTo(W - 32, 46); g.closePath(); g.fill();
    g.fillRect(16, H - 22, 200 * scale, 3);
    g.textAlign = 'left';
    g.fillText('200 m', 16, H - 28);
  }

  _tag(g, x, y, text, color) {
    g.font = '600 11px ui-monospace, Menlo, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  _drawSelected(g, toPx, r, knownIds) {
    const sevAt = (s) => {
      let v = 0;
      for (const z of r.zones) {
        if (s < z.s0 || s > z.s1) continue;
        if (z.kind === 'area' && !knownIds.has(z.id)) continue;
        v = Math.max(v, z.severity === 'danger' ? 2 : 1);
      }
      return v;
    };
    const path = (style, width, dash = []) => {
      g.strokeStyle = style;
      g.lineWidth = width;
      g.setLineDash(dash);
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    path('rgba(0,0,0,0.6)', 7);
    g.beginPath();
    for (let i = 0; i < r.count; i += 2) {
      const [px, py] = toPx(r.x[i], r.z[i]);
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke();
    const segs = [];
    let cur = null;
    for (let k = 0; k < r.count; k += 2) {
      const sev = sevAt(k * r.step);
      const pt = toPx(r.x[k], r.z[k]);
      if (!cur || cur.sev !== sev) {
        if (cur) cur.pts.push(pt);
        cur = { sev, pts: [] };
        segs.push(cur);
      }
      cur.pts.push(pt);
    }
    for (const sg of segs) {
      path(sg.sev === 2 ? ZONE_COLORS.danger : sg.sev === 1 ? ZONE_COLORS.caution : '#5ce4ff', 4, sg.sev ? [6, 4] : []);
      g.beginPath();
      sg.pts.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.stroke();
    }
    g.setLineDash([]);
    for (const st of r.stations) {
      const [px, py] = toPx(st.x, st.z);
      const s = 7;
      g.fillStyle = st.final ? '#fff' : '#56e0ff';
      g.strokeStyle = '#041015';
      g.lineWidth = 2;
      g.beginPath();
      if (st.final) g.rect(px - s, py - s, s * 2, s * 2);
      else { g.moveTo(px, py - s * 1.2); g.lineTo(px + s * 1.2, py); g.lineTo(px, py + s * 1.2); g.lineTo(px - s * 1.2, py); g.closePath(); }
      g.fill();
      g.stroke();
      this._tag(g, px + 12, py - 6, st.final ? 'HAB' : `${st.id} ${st.name}`, '#e8f6fa');
    }
  }

  _onMapClick(e) {
    if (!this.toPx) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bd = 22;
    for (const p of SCOUT_PINS) {
      const [px, py] = this.toPx(p.at[0], p.at[1]);
      const d = Math.hypot(px - mx, py - my);
      if (d < bd) { bd = d; best = p.id; }
    }
    this.selectPin(best);
  }
}
