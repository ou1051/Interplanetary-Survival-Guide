import { planRoute } from '../routes/pathfinding.js';
import { SUIT, SUIT_PRESETS, BASE, DESTINATIONS, predict } from '../sim/suit.js';
import { LIFE_SUPPORT, SITE } from '../config/mission.js';
import { TraverseRelief } from './traverseRelief.js';
import gridData from '../../public/cost_matrix.json?raw';
import './planningBoard.css';

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
// Keys: P open/close · ←/→ or Q/E switch tab.
// ---------------------------------------------------------------------------

const $ = (sel, root) => root.querySelector(sel);
const TABS = ['MAP', 'SUIT', 'STATUS'];
const SITE_CHOICES = [30, 60, 120, 180];
const GRID = JSON.parse(gridData);
const stopName = ({ kind, ref }) => kind === 'gate' ? ref.type.toLowerCase() : ref.name;
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
  if (location.protocol !== 'file:') {
    try {
      const res = await fetch('./api/route-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start, end }),
        signal: AbortSignal.timeout(2500),
      });
      if (res.status === 422) return { route: null, source: 'api' };
      if (res.ok) return { route: await res.json(), source: 'api' };
    } catch {
      // A static host or an unavailable API can use the bundled grid.
    }
  }
  const r = planRoute(grid, { col: start[0], row: start[1] }, { col: end[0], row: end[1] });
  if (!r) return { route: null, source: 'local' };
  const path = r.path.map((c) => [c.col, c.row]);
  const hazards = [...new Set(path.map(([c, w]) => grid.hazardLabels?.[`${c},${w}`]).filter(Boolean))];
  return { route: { path, oxygen_cost: r.oxygenMinutes, battery_drain: r.batteryWh, hazard_warnings: hazards }, source: 'local' };
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
    this.grid = GRID;
    this.planVersion = 0;
    this.mapMode = 'traverse';
    this.el = document.createElement('dialog');
    this.el.id = 'planningBoard';
    this.el.className = 'pb';
    this.el.setAttribute('aria-label', 'EVA Planning Board');
    this.el.innerHTML = this._shell();
    document.getElementById('app').appendChild(this.el);
    this._bind();
  }

  get open() {
    return this.el.open;
  }

  connectTraverse(mission) {
    this.mission = mission;
    if (this.open) this.render();
  }

  updateReadouts() {
    const budget = LIFE_SUPPORT.evaHours * 60;
    const minutes = Math.max(0, this.mission?.o2Remaining ?? budget);
    const percent = Math.round(100 * minutes / budget);
    const oxygen = `${percent}% · ${hm(minutes)}`;
    if (oxygen === this.oxygenReadout) return;
    this.oxygenReadout = oxygen;
    $('[data-oxygen]', this.el).textContent = oxygen;
    $('[data-needle]', this.el).style.setProperty('--needle', `${-66 + 132 * minutes / budget}deg`);
  }

  toggle(force) {
    const show = force ?? !this.open;
    if (show === this.open) return;
    if (show) {
      this.el.showModal();
      this.render();
      if (!this.result && !this.planVersion) this.plan();
    } else {
      this.el.close();
    }
  }

  async plan() {
    const version = ++this.planVersion;
    const d = DESTINATIONS.find((x) => x.id === this.dest);
    this.result = null;
    this.render();
    const result = await fetchRouteData(BASE.cell, d.cell, this.grid);
    if (version !== this.planVersion) return;
    this.result = result;
    this.render({ keepPage: this.tab === 'SUIT' });
  }

  // ------------------------------------------------------------ markup
  _shell() {
    return `<div class="wd">
      <div class="wd-strap" aria-hidden="true"></div>
      <div class="wd-lug" aria-hidden="true"></div>
      <div class="wd-roller" aria-hidden="true"></div>
      <div class="wd-case">
        <div class="wd-screws" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="wd-bezel">
          <div class="wd-screen">
            <div class="wd-toolbar">
              <nav class="wd-tabs" aria-label="Terminal screens">
                ${TABS.map((t) => `<button type="button" data-tab="${t}">${t}</button>`).join('')}
              </nav>
              <button type="button" class="wd-close" data-close aria-label="Close Planning Board" title="Close (P or Esc)">× Close</button>
            </div>
            <div class="wd-readouts">
              <span>Outside <b>${String(SITE.outsideTemperatureC).replace('-', '−')} °C</b> <small>SIM</small></span>
              <span>Suit O₂ <b data-oxygen></b></span>
            </div>
            <div class="wd-page" data-page></div>
            <footer class="wd-foot" data-foot></footer>
            <div class="wd-scan" aria-hidden="true"></div>
          </div>
        </div>
        <div class="wd-side">
          <button type="button" class="wd-selector" data-next aria-label="Next screen" title="Next screen (→)">
            <span class="wd-knob"></span>
            <span>NEXT</span>
          </button>
          <div class="wd-gauge" aria-hidden="true"><i data-needle></i></div>
          <div class="wd-vents" aria-hidden="true"></div>
          <div class="wd-power" aria-hidden="true">
            <span class="wd-lamp" data-lamp></span>
          </div>
        </div>
        <div class="wd-console" aria-hidden="true">
          <span class="wd-plate">EVA WRIST NAVIGATOR <b>MK II</b></span>
          <span class="wd-grille"></span>
        </div>
      </div>
      <div class="wd-keys"><span><kbd>←</kbd> <kbd>→</kbd> Change screen</span><span><kbd>P</kbd> Close</span></div>
    </div>`;
  }

  _bind() {
    const el = this.el;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.close !== undefined) return this.toggle(false);
      if (b.dataset.tab) this.tab = b.dataset.tab;
      if (b.dataset.next !== undefined) this.cycleTab(1);
      if (b.dataset.mapMode) this.mapMode = b.dataset.mapMode;
      if (b.dataset.stop !== undefined) {
        this.selectedStop = this.selectedStop === Number(b.dataset.stop) ? undefined : Number(b.dataset.stop);
        for (const button of el.querySelectorAll('[data-stop]')) {
          button.setAttribute('aria-pressed', String(Number(button.dataset.stop) === this.selectedStop));
        }
        $('[data-stop-status]', el).textContent = this.selectedStop === undefined
          ? 'Select a checkpoint to highlight it'
          : `On map · ${stopName(this.mission.route.stops[this.selectedStop])}`;
        this._drawMap();
        return;
      }
      if (b.dataset.dest) {
        if (this.dest === b.dataset.dest) return;
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
      this.render({ keepPage: true });
    });
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) this.toggle();
        return;
      }
      if (!this.open) return;
      e.stopImmediatePropagation();
      if (e.target instanceof HTMLInputElement) return;
      const key = e.key.toLowerCase();
      if (key === 'arrowright' || key === 'e' || key === 'arrowleft' || key === 'q') {
        e.preventDefault();
        this.cycleTab(key === 'arrowright' || key === 'e' ? 1 : -1);
        this.render();
      }
    }, { capture: true });
    window.addEventListener('resize', () => this.open && this._drawMap());
  }

  cycleTab(direction) {
    const index = TABS.indexOf(this.tab);
    this.tab = TABS[(index + direction + TABS.length) % TABS.length];
  }

  // ------------------------------------------------------------ render
  render({ keepPage = false } = {}) {
    const el = this.el;
    const route = this.result?.route ?? null;
    const p = predict(route, this.suit, this.siteMinutes);
    const v = this.result ? p.verdict : '…';

    for (const b of el.querySelectorAll('[data-tab]')) {
      b.setAttribute('aria-pressed', String(b.dataset.tab === this.tab));
    }
    const lamp = $('[data-lamp]', el);
    lamp.className = `wd-lamp ${v === 'GO' ? 'go' : v === 'CAUTION' ? 'caution' : v === '…' ? '' : 'nogo'}`;

    const page = $('[data-page]', el);
    if (keepPage) {
      for (const m of SUIT.materials) {
        $(`[data-value="${m.id}"]`, page).textContent = `${this.suit[m.id]} ${m.unit}`;
      }
      $('[data-mass]', page).textContent = `${p.massKg.toFixed(1)} KG`;
      $('[data-custom]', page).hidden = this.preset !== 'custom';
      for (const button of page.querySelectorAll('[data-preset]')) {
        button.setAttribute('aria-pressed', String(button.dataset.preset === this.preset));
      }
    } else {
      const screen = this.tab === 'MAP' ? `MAP:${this.mapMode}` : this.tab;
      const sameTab = page.dataset.screen === screen;
      const scroll = page.scrollTop;
      const focused = document.activeElement?.dataset;
      const key = ['dest', 'preset', 'min', 'suit', 'mapMode', 'stop'].find((name) => focused?.[name] !== undefined);
      if (this.tab === 'MAP') page.innerHTML = this._mapPage(route);
      if (this.tab === 'SUIT') page.innerHTML = this._suitPage(p);
      if (this.tab === 'STATUS') page.innerHTML = this._statusPage(route, p, v);
      page.dataset.screen = screen;
      page.scrollTop = sameTab ? scroll : 0;
      if (key) {
        const attribute = key === 'mapMode' ? 'map-mode' : key;
        const replacement = (sameTab || key === 'mapMode') && $(`[data-${attribute}="${focused[key]}"]`, page);
        (replacement || $(`[data-tab="${this.tab}"]`, el)).focus({ preventScroll: true });
      }
    }

    const o2Frac = route ? Math.max(0, p.o2.left) / p.o2.budget : 0;
    this.updateReadouts();
    const foot = $('[data-foot]', el);
    if (this.tab === 'MAP' && this.mapMode === 'traverse') {
      const stop = this.mission?.route.stops[this.selectedStop];
      const label = stop && stopName(stop);
      foot.innerHTML = `<span data-stop-status aria-live="polite">${label ? `On map · ${label}` : 'Select a checkpoint to highlight it'}</span>`;
    } else {
      foot.innerHTML = `
        <span>Return O₂ ${route ? hm(Math.max(0, p.o2.left)) : '—'}</span>
        <span class="wd-meter"><i style="width:${o2Frac * 100}%"></i></span>
        <span aria-live="polite">${v === 'NO ROUTE' ? 'NO PATH' : v}</span>`;
    }

    if (this.tab === 'MAP') this._drawMap();
  }

  _mapPage(route) {
    const modes = `<div class="wd-chips wd-map-modes" role="group" aria-label="Map view">
      <button data-map-mode="traverse" aria-pressed="${this.mapMode === 'traverse'}">Rover route</button>
      <button data-map-mode="targets" aria-pressed="${this.mapMode === 'targets'}">Plan a side trip</button>
    </div>`;
    if (this.mapMode === 'traverse') return modes + this._traversePage();
    const d = DESTINATIONS.find((x) => x.id === this.dest);
    const steps = route ? directions(route.path, this.grid?.cellSizeM ?? 10) : [];
    const hz = route?.hazard_warnings ?? [];
    return `${modes}<div class="wd-map">
      <div class="wd-nav">
        <h2 class="wd-h">Choose a side trip from habitat</h2>
        ${DESTINATIONS.map((x) => `<button class="wd-item" aria-pressed="${x.id === this.dest}" data-dest="${x.id}">${x.name}</button>`).join('')}
        <h2 class="wd-h">Directions from habitat</h2>
        ${
          !this.result
            ? '<div class="wd-dim">CALCULATING…</div>'
            : !route
              ? '<div class="wd-warn">NO SAFE PATH</div>'
              : `<ol class="wd-steps">${steps.map((s) => `<li>Head ${s.dir.toLowerCase()} ${Math.round(s.m)} m</li>`).join('')}<li>Arrive · ${d.name}</li></ol>
                 ${hz.length ? hz.map((h) => `<div class="wd-warn">⚠ ${h} on route</div>`).join('') : '<div class="wd-dim wd-note">No hazards on path</div>'}`
        }
      </div>
      <figure class="wd-mapbox">
        <figcaption class="wd-h"><span>Side trip to ${d.name}</span><span>↑ N</span></figcaption>
        <canvas data-grid width="280" height="140" aria-label="Route from the habitat to the selected destination"></canvas>
        <div class="wd-maplegend"><span>⌂ Habitat</span><span>◆ Destination</span><span>⚠ Hazard</span><span>▓ Closed</span></div>
        <p class="wd-grid-note">The dashed line leads from habitat to the selected destination across a simulated survey grid.</p>
      </figure>
    </div>`;
  }

  _traversePage() {
    const stops = this.mission?.route.stops;
    if (!stops) return '<p class="wd-dim">Loading rover checkpoints…</p>';
    const gates = stops.filter((stop) => stop.kind === 'gate').length;
    const stations = stops.filter((stop) => stop.kind === 'station' && !stop.ref.final).length;
    return `<p class="wd-checkpoint-count"><b>${stops.length} stops</b> · ${stations} science · ${gates} gates · habitat return</p>
      <div class="wd-map wd-traverse">
        <figure class="wd-mapbox">
          <figcaption class="wd-h"><span>Terrain relief</span><span>↖ N</span></figcaption>
          <canvas data-traverse width="400" height="265" aria-label="Green terrain relief of the rover route"></canvas>
          <div class="wd-maplegend"><span>◇ Science station</span><span>▲ Hazard gate</span><span>■ Habitat</span></div>
        </figure>
        <section class="wd-stop-panel" aria-label="Rover checkpoints">
          <h2 class="wd-h">Rover checkpoints</h2>
          <ol class="wd-checkpoints">
            ${stops.map((stop, index) => {
              const icon = stop.kind === 'gate' ? '▲' : stop.ref.final ? '■' : '◇';
              return `<li><button class="wd-item" data-stop="${index}" aria-pressed="${index === this.selectedStop}">
                <span aria-hidden="true">${icon}</span>${stopName(stop)}
              </button></li>`;
            }).join('')}
          </ol>
        </section>
      </div>`;
  }

  _suitPage(p) {
    const sliders = SUIT.materials
      .map(
        (m) => `<label class="wd-slider"><span>${m.name}</span><b data-value="${m.id}">${this.suit[m.id]} ${m.unit}</b>
          <input type="range" data-suit="${m.id}" min="${m.min}" max="${m.max}" step="${m.step}" value="${this.suit[m.id]}" /></label>`,
      )
      .join('');
    return `<div class="wd-suit">
      <div>
      <h2 class="wd-h">Suit presets</h2>
      ${SUIT_PRESETS.map(
        (s) => `<button class="wd-item big" aria-pressed="${this.preset === s.id}" data-preset="${s.id}">
          <b>${s.name}</b><small>${s.tagline}</small></button>`,
      ).join('')}
      </div>
      <div>
        <h2 class="wd-h">Fine-tune layers</h2>${sliders}
        <div class="wd-row"><span>Suit mass</span><b data-mass>${p.massKg.toFixed(1)} KG</b><em data-custom ${this.preset === 'custom' ? '' : 'hidden'}>CUSTOM</em></div>
      </div>
    </div>`;
  }

  _statusPage(route, p, v) {
    const doseWord = p.dose.usv > 500 ? 'HIGH' : p.dose.usv > 200 ? 'MED' : 'LOW';
    const line = (label, frac, val) => `<div class="wd-bar"><span>${label}</span><code>${blocks(frac)}</code><b>${val}</b></div>`;
    return `<div class="wd-status">
      <h2 class="wd-h">EVA forecast</h2>
      <div class="wd-verdict">${v === 'NO ROUTE' ? 'NO PATH' : v}</div>
      <div class="wd-say">${this.result ? verdictLine(p, this.preset) : 'CALCULATING…'}</div>
      ${route ? `
        ${line('O2 NEEDED', p.o2.used / p.o2.budget, `${hm(p.o2.used)} / ${hm(p.o2.budget)}`)}
        ${line('BATTERY', p.battery.used / p.battery.budget, `${Math.round(p.battery.used)} / ${p.battery.budget} WH`)}
        ${line('RADIATION', p.dose.usv / 600, `${Math.round(p.dose.usv)} µSV ${doseWord}`)}
        ${p.covered.map((c) => `<div class="wd-ok">✓ ${c.toUpperCase()}</div>`).join('')}` : ''}
      <div class="wd-h">TIME AT TARGET</div>
      <div class="wd-chips">${SITE_CHOICES.map((m) => `<button aria-pressed="${this.siteMinutes === m}" data-min="${m}">${hm(m)}</button>`).join('')}</div>
      <div class="wd-dim small">ROUTE: ${this.result?.source === 'api' ? 'ROUTING API' : this.result ? 'OFFLINE PLANNER' : '--'} · SUIT VALUES ARE GAME ASSUMPTIONS</div>
    </div>`;
  }

  _drawMap() {
    const overview = $('[data-traverse]', this.el);
    if (overview && this.open) {
      this.relief ??= new TraverseRelief(this.mission.route);
      this.relief.draw(overview, this.selectedStop);
      return;
    }
    const canvas = $('[data-grid]', this.el);
    const g = this.grid;
    if (!canvas || !g || !this.open) return;
    const w = canvas.clientWidth;
    if (!w) return;
    const cell = w / g.width;
    const h = cell * g.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(w * dpr);
    const height = Math.round(h * dpr);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const G = '#a4f67c';
    const DIM = '#8ab47b50';
    const at = ([c, r]) => [(c + 0.5) * cell, (r + 0.5) * cell];
    const text = (t, x, y, color = G, size = Math.max(9, cell * 0.32)) => {
      ctx.font = `600 ${size}px monospace`;
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
    // Hazard names for the selected route appear next to its directions.
    for (const k of Object.keys(g.hazardLabels)) {
      const [x, y] = at(k.split(',').map(Number));
      ctx.strokeStyle = '#d6ffba';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(x, y, cell * 0.43, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      text('⚠', x, y, '#d6ffba');
    }
    for (const b of g.blockedCells || []) {
      const [x, y] = at([b.col, b.row]);
      text('▓', x, y, '#a4f67c70', cell * 0.8);
    }
    // recommended route
    const route = this.result?.route;
    if (route) {
      ctx.strokeStyle = G;
      ctx.lineWidth = Math.max(2.5, cell * 0.12);
      ctx.setLineDash([cell * 0.35, cell * 0.2]);
      ctx.shadowColor = G;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      route.path.forEach((pt, i) => (i ? ctx.lineTo(...at(pt)) : ctx.moveTo(...at(pt))));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
    }
    // Show the destination chosen in the list alongside the route.
    const target = DESTINATIONS.find((item) => item.id === this.dest);
    text('◆', ...at(target.cell), G, cell * 0.72);
    const [hx, hy] = at(BASE.cell);
    text('⌂', hx, hy, G, cell * 0.7);
    text('BASE', hx, hy + cell * 0.65, G, Math.max(8, cell * 0.26));
  }
}
