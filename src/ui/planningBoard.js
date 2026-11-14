import { planRoute } from '../routes/pathfinding.js';
import { SUIT, SUIT_PRESETS, BASE, DESTINATIONS, predict } from '../sim/suit.js';

// ---------------------------------------------------------------------------
// Mode 1 · Planning Board, shown as the astronaut's wrist navigator: a rugged
// arm-mounted computer with a green phosphor screen, held up over the 3D view.
// Pure 2D overlay (no 3D engine code).
//
//   MAP     destinations, the recommended route and step-by-step directions
//   SUIT    Light / Standard / Shielded (+ fine-tune)
//   STATUS  GO / CAUTION / NO-GO in one sentence, oxygen / battery / dose bars
//
// Route comes from /api/route-data; offline, the same A* runs in the browser.
// Keys: P open/close · ←/→ or Q/E switch tab · 1–3 pick a destination.
// ---------------------------------------------------------------------------

const $ = (sel, root) => root.querySelector(sel);
const TABS = ['MAP', 'SUIT', 'STATUS'];
const SITE_CHOICES = [30, 60, 120, 180];
const hm = (min) => {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const blocks = (frac, n = 18) => {
  const k = Math.round(Math.max(0, Math.min(1, frac)) * n);
  return '█'.repeat(k) + '░'.repeat(n - k);
};

async function fetchRouteData(start, end, grid) {
  try {
    const res = await fetch('./api/route-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end }),
    });
    if (res.status === 422) return { route: null, source: 'api' };
    if (!res.ok) throw new Error(String(res.status));
    return { route: await res.json(), source: 'api' };
  } catch {
    const r = planRoute(grid, { col: start[0], row: start[1] }, { col: end[0], row: end[1] });
    if (!r) return { route: null, source: 'local' };
    const path = r.path.map((c) => [c.col, c.row]);
    const hazards = [...new Set(path.map(([c, w]) => grid.hazardLabels?.[`${c},${w}`]).filter(Boolean))];
    return { route: { path, oxygen_cost: r.oxygenMinutes, battery_drain: r.batteryWh, hazard_warnings: hazards }, source: 'local' };
  }
}

/** Turn the cell path into "head EAST 30 m" style directions. */
export function directions(path, cellM = 10) {
  const NAMES = { '1,0': 'EAST', '-1,0': 'WEST', '0,-1': 'NORTH', '0,1': 'SOUTH', '1,-1': 'NORTH-EAST', '1,1': 'SOUTH-EAST', '-1,-1': 'NORTH-WEST', '-1,1': 'SOUTH-WEST' };
  const steps = [];
  for (let i = 1; i < path.length; i++) {
    const d = `${path[i][0] - path[i - 1][0]},${path[i][1] - path[i - 1][1]}`;
    const m = (d.includes('0') ? 1 : Math.SQRT2) * cellM;
    const last = steps[steps.length - 1];
    if (last && last.dir === NAMES[d]) last.m += m;
    else steps.push({ dir: NAMES[d], m });
  }
  return steps;
}

function verdictLine(p, preset) {
  if (p.verdict === 'NO ROUTE') return 'NO SAFE PATH. PICK ANOTHER TARGET.';
  if (p.verdict === 'NO-GO') return p.o2.left < 0 ? `OXYGEN RUNS OUT ${hm(-p.o2.left)} EARLY. SHORTEN THE STAY.` : 'ROVER BATTERY RUNS FLAT. SHORTEN THE TRIP.';
  if (p.verdict === 'CAUTION') {
    const w = p.warnings[0]?.text ?? '';
    if (/radiation/i.test(w) && preset !== 'shielded') return 'RADIATION SPIKE ON ROUTE. EQUIP SHIELDED SUIT.';
    if (/regolith/i.test(w)) return 'LOOSE REGOLITH ON ROUTE. ADD ABRASION LAYER.';
    if (/cold/i.test(w)) return 'TOO COLD FOR THIS SUIT. ADD INSULATION.';
    if (p.o2.left < p.o2.reserve) return `TIGHT: ONLY ${hm(p.o2.left)} O2 LEFT AT RETURN.`;
    return w.toUpperCase();
  }
  return `BACK AT BASE WITH ${hm(p.o2.left)} O2 TO SPARE.`;
}

export class PlanningBoard {
  constructor() {
    this.tab = 'MAP';
    this.preset = 'standard';
    this.suit = { ...SUIT_PRESETS[1].suit };
    this.siteMinutes = 60;
    this.dest = DESTINATIONS[0].id;
    this.result = null;
    this.el = document.createElement('section');
    this.el.id = 'planningBoard';
    this.el.className = 'pb hidden';
    this.el.innerHTML = this._shell();
    document.getElementById('app').appendChild(this.el);
    this._bind();
    fetch('./cost_matrix.json')
      .then((r) => r.json())
      .then((grid) => {
        this.grid = grid;
        this.plan();
      });
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }

  toggle(force) {
    const show = force ?? !this.open;
    this.el.classList.toggle('hidden', !show);
    if (show) {
      this.el.classList.remove('boot');
      void this.el.offsetWidth;
      this.el.classList.add('boot'); // screen power-on flicker
      this.render();
    }
  }

  async plan() {
    if (!this.grid) return;
    const d = DESTINATIONS.find((x) => x.id === this.dest);
    this.result = null;
    this.render();
    this.result = await fetchRouteData(BASE.cell, d.cell, this.grid);
    this.render();
  }

  // ------------------------------------------------------------ markup
  _shell() {
    return `<div class="wd">
      <div class="wd-strap"></div>
      <div class="wd-case">
        <div class="wd-screws"><i></i><i></i><i></i><i></i></div>
        <div class="wd-bezel">
          <div class="wd-screen">
            <nav class="wd-tabs" data-tabs></nav>
            <div class="wd-page" data-page></div>
            <footer class="wd-foot" data-foot></footer>
            <div class="wd-scan"></div>
          </div>
        </div>
        <div class="wd-side">
          <div class="wd-lamp" data-lamp></div>
          ${TABS.map((t) => `<button class="wd-key" data-tab="${t}">${t}</button>`).join('')}
          <div class="wd-dial" title="Use ← → to switch screens"></div>
        </div>
        <div class="wd-plate">EVA WRIST NAVIGATOR · MK II</div>
      </div>
      <button class="ghost wd-close" data-close>CLOSE [P]</button>
    </div>`;
  }

  _bind() {
    const el = this.el;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.close !== undefined) return this.toggle(false);
      if (b.dataset.tab) this.tab = b.dataset.tab;
      if (b.dataset.dest) {
        this.dest = b.dataset.dest;
        this.plan();
        return;
      }
      if (b.dataset.preset) {
        this.preset = b.dataset.preset;
        this.suit = { ...SUIT_PRESETS.find((p) => p.id === this.preset).suit };
      }
      if (b.dataset.min) this.siteMinutes = Number(b.dataset.min);
      this.render();
    });
    el.addEventListener('input', (e) => {
      if (!e.target.dataset.suit) return;
      this.suit[e.target.dataset.suit] = Number(e.target.value);
      this.preset = 'custom';
      this.render();
    });
    el.addEventListener('click', (e) => {
      const c = e.target.closest('[data-grid]');
      if (!c || !this.grid) return;
      const r = c.getBoundingClientRect();
      const col = Math.floor(((e.clientX - r.left) / r.width) * this.grid.width);
      const row = Math.floor(((e.clientY - r.top) / r.height) * this.grid.height);
      const d = DESTINATIONS.find((x) => Math.abs(x.cell[0] - col) <= 1 && Math.abs(x.cell[1] - row) <= 1);
      if (d) {
        this.dest = d.id;
        this.plan();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      if (e.key === 'p' || e.key === 'P') return this.toggle();
      if (!this.open) return;
      if (e.key === 'Escape') this.toggle(false);
      const i = TABS.indexOf(this.tab);
      if (e.key === 'ArrowRight' || e.key === 'e' || e.key === 'E') this.tab = TABS[(i + 1) % TABS.length];
      if (e.key === 'ArrowLeft' || e.key === 'q' || e.key === 'Q') this.tab = TABS[(i + TABS.length - 1) % TABS.length];
      const n = Number(e.key);
      if (n >= 1 && n <= DESTINATIONS.length) {
        this.dest = DESTINATIONS[n - 1].id;
        this.plan();
        return;
      }
      this.render();
    });
    window.addEventListener('resize', () => this.open && this._drawMap());
  }

  // ------------------------------------------------------------ render
  render() {
    const el = this.el;
    const route = this.result?.route ?? null;
    const p = predict(this.result ? route : { oxygen_cost: 0, battery_drain: 0, hazard_warnings: [] }, this.suit, this.siteMinutes);
    const v = this.result ? p.verdict : '…';

    $('[data-tabs]', el).innerHTML = TABS.map((t) => `<span class="${t === this.tab ? 'on' : ''}">${t}</span>`).join('');
    for (const b of el.querySelectorAll('.wd-key')) b.classList.toggle('on', b.dataset.tab === this.tab);
    const lamp = $('[data-lamp]', el);
    lamp.className = `wd-lamp ${v === 'GO' ? 'go' : v === 'CAUTION' ? 'caution' : v === '…' ? '' : 'nogo'}`;

    const page = $('[data-page]', el);
    if (this.tab === 'MAP') page.innerHTML = this._mapPage(route, p);
    if (this.tab === 'SUIT') page.innerHTML = this._suitPage(p);
    if (this.tab === 'STATUS') page.innerHTML = this._statusPage(route, p, v);

    const o2Frac = p.o2.budget ? Math.max(0, p.o2.left) / p.o2.budget : 0;
    $('[data-foot]', el).innerHTML = `
      <span>O2 ${route ? hm(Math.max(0, p.o2.left)) : '--'} LEFT</span>
      <span class="wd-meter"><i style="width:${o2Frac * 100}%"></i></span>
      <span class="v-${v === 'GO' ? 'go' : v === 'CAUTION' ? 'caution' : 'nogo'}">${v === 'NO ROUTE' ? 'NO PATH' : v}</span>`;

    if (this.tab === 'MAP') this._drawMap();
  }

  _mapPage(route, p) {
    const d = DESTINATIONS.find((x) => x.id === this.dest);
    const steps = route ? directions(route.path, this.grid?.cellSizeM ?? 10) : [];
    const hz = route?.hazard_warnings ?? [];
    return `<div class="wd-map">
      <div class="wd-mapbox"><canvas data-grid></canvas></div>
      <div class="wd-nav">
        <div class="wd-h">TARGET</div>
        ${DESTINATIONS.map((x, i) => `<button class="wd-item ${x.id === this.dest ? 'on' : ''}" data-dest="${x.id}">[${i + 1}] ${x.name.toUpperCase()}</button>`).join('')}
        <div class="wd-h">RECOMMENDED ROUTE</div>
        ${
          !this.result
            ? '<div class="wd-dim">CALCULATING…</div>'
            : !route
              ? '<div class="wd-warn">NO SAFE PATH</div>'
              : `<ol class="wd-steps">${steps.map((s) => `<li>HEAD ${s.dir} ${Math.round(s.m)} M</li>`).join('')}<li>ARRIVE · ${d.name.toUpperCase()}</li></ol>
                 ${hz.length ? hz.map((h) => `<div class="wd-warn blink">⚠ ${h.toUpperCase()} ON ROUTE</div>`).join('') : '<div class="wd-dim">NO HAZARDS ON PATH</div>'}`
        }
      </div>
    </div>`;
  }

  _suitPage(p) {
    const sliders = SUIT.materials
      .map(
        (m) => `<label class="wd-slider"><span>${m.name.toUpperCase()}</span><b>${this.suit[m.id]} ${m.unit}</b>
          <input type="range" data-suit="${m.id}" min="${m.min}" max="${m.max}" step="${m.step}" value="${this.suit[m.id]}" /></label>`,
      )
      .join('');
    return `<div class="wd-suit">
      <div class="wd-h">SELECT SUIT</div>
      ${SUIT_PRESETS.map(
        (s) => `<button class="wd-item big ${this.preset === s.id ? 'on' : ''}" data-preset="${s.id}">
          <b>${this.preset === s.id ? '▶ ' : '  '}${s.name.toUpperCase()}</b><small>${s.tagline.toUpperCase()}</small></button>`,
      ).join('')}
      <div class="wd-row"><span>SUIT MASS</span><b>${p.massKg.toFixed(1)} KG</b>${this.preset === 'custom' ? '<em>CUSTOM</em>' : ''}</div>
      <div class="wd-h">FINE-TUNE</div>${sliders}
    </div>`;
  }

  _statusPage(route, p, v) {
    const doseWord = p.dose.usv > 500 ? 'HIGH' : p.dose.usv > 200 ? 'MED' : 'LOW';
    const line = (label, frac, val) => `<div class="wd-bar"><span>${label}</span><code>${blocks(frac)}</code><b>${val}</b></div>`;
    return `<div class="wd-status">
      <div class="wd-verdict v-${v === 'GO' ? 'go' : v === 'CAUTION' ? 'caution' : 'nogo'}">${v === 'NO ROUTE' ? 'NO PATH' : v}</div>
      <div class="wd-say">${this.result ? verdictLine(p, this.preset) : 'CALCULATING…'}</div>
      ${route ? `
        ${line('O2 NEEDED', p.o2.used / p.o2.budget, `${hm(p.o2.used)} / ${hm(p.o2.budget)}`)}
        ${line('BATTERY', p.battery.used / p.battery.budget, `${Math.round(p.battery.used)} / ${p.battery.budget} WH`)}
        ${line('RADIATION', p.dose.usv / 600, `${Math.round(p.dose.usv)} µSV ${doseWord}`)}
        ${p.covered.map((c) => `<div class="wd-ok">✓ ${c.toUpperCase()}</div>`).join('')}` : ''}
      <div class="wd-h">TIME AT TARGET</div>
      <div class="wd-chips">${SITE_CHOICES.map((m) => `<button class="${this.siteMinutes === m ? 'on' : ''}" data-min="${m}">${hm(m)}</button>`).join('')}</div>
      <div class="wd-dim small">ROUTE: ${this.result?.source === 'api' ? 'ROUTING API' : this.result ? 'OFFLINE PLANNER' : '--'} · SUIT VALUES ARE GAME ASSUMPTIONS</div>
    </div>`;
  }

  _drawMap() {
    const canvas = $('[data-grid]', this.el);
    const g = this.grid;
    if (!canvas || !g || !this.open) return;
    const w = canvas.parentElement.clientWidth || 360;
    const cell = w / g.width;
    const h = cell * g.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const G = '#46ff8a';
    const DIM = 'rgba(70,255,138,0.18)';
    const at = ([c, r]) => [(c + 0.5) * cell, (r + 0.5) * cell];
    const text = (t, x, y, color = G, size = Math.max(9, cell * 0.32)) => {
      ctx.font = `600 ${size}px "VT323", "SF Mono", ui-monospace, monospace`;
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.fillText(t, x, y);
      ctx.shadowBlur = 0;
    };
    ctx.clearRect(0, 0, w, h);
    // dotted survey grid
    ctx.fillStyle = DIM;
    for (let r = 0; r <= g.height; r++) for (let c = 0; c <= g.width; c++) ctx.fillRect(c * cell - 1, r * cell - 1, 2, 2);
    ctx.strokeStyle = DIM;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    // hazards
    for (const [k, name] of Object.entries(g.hazardLabels || {})) {
      const [x, y] = at(k.split(',').map(Number));
      ctx.strokeStyle = '#ffb347';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(x, y, cell * 0.7, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      text('⚠', x, y, '#ffb347');
      text(name.toUpperCase(), x, y - cell * 0.95, '#ffb347', Math.max(8, cell * 0.24));
    }
    for (const b of g.blockedCells || []) {
      const [x, y] = at([b.col, b.row]);
      text('▓', x, y, 'rgba(70,255,138,0.45)', cell * 0.8);
    }
    // recommended route
    const route = this.result?.route;
    if (route) {
      ctx.strokeStyle = G;
      ctx.lineWidth = Math.max(2.5, cell * 0.12);
      ctx.setLineDash([cell * 0.35, cell * 0.2]);
      ctx.lineDashOffset = -((performance.now() / 40) % 100);
      ctx.shadowColor = G;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      route.path.forEach((pt, i) => (i ? ctx.lineTo(...at(pt)) : ctx.moveTo(...at(pt))));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }
    // targets + base
    DESTINATIONS.forEach((d, i) => {
      const [x, y] = at(d.cell);
      const on = d.id === this.dest;
      ctx.strokeStyle = G;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - cell * 0.3, y - cell * 0.3, cell * 0.6, cell * 0.6);
      if (on) {
        ctx.fillStyle = G;
        ctx.fillRect(x - cell * 0.3, y - cell * 0.3, cell * 0.6, cell * 0.6);
        text(String(i + 1), x, y, '#03140a');
      } else text(String(i + 1), x, y);
    });
    const [hx, hy] = at(BASE.cell);
    text('⌂', hx, hy, G, cell * 0.7);
    text('BASE', hx, hy + cell * 0.65, G, Math.max(8, cell * 0.26));
    // marching route animation while the map is visible
    if (route && this.tab === 'MAP' && this.open) {
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this._drawMap());
    }
  }
}
