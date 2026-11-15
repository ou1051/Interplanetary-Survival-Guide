import { renderStationChoices } from './stationChoices.js';
import { LIFE_SUPPORT } from '../config/mission.js';
import { fieldGuidance } from '../sim/fieldGuidance.js';
import { forecastReturn, legOptions, temperatureAt } from '../sim/legCheck.js';
import { legVariants, buildLoopRoute } from '../data/deltaTraverse.js';
import { SUIT, SUIT_PRESETS, defaultSuit, predict } from '../sim/suit.js';
import { mapWeatherLabel } from './mapRenderer.js';
import { TraverseRelief } from './traverseRelief.js';
import { SiteTopologyWidget } from './siteTopology.js';
import './planningBoard.css';

const $ = (selector, root) => root.querySelector(selector);
const TABS = [
  ['guide', 'Guide'],
  ['map', 'Route'],
  ['leg', 'Next leg'],
  ['topology', 'Site Topology'],
  ['suit', 'Suit Data'],
];
const hm = (min) => {
  const m = Math.max(0, Math.round(min));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export class PlanningBoard {
  constructor(options = {}) {
    this.tab = 'guide';
    this.onDeploy = options.onDeploy || null;
    this.preset = 'standard';
    this.suit = defaultSuit();
    this.siteMinutes = 60;

    this.el = document.createElement('dialog');
    this.el.id = 'planningBoard';
    this.el.className = 'pb';
    this.el.setAttribute('aria-label', 'EVA wrist navigator and mission tablet');
    this.el.innerHTML = this._shell();
    document.getElementById('app').appendChild(this.el);

    const topoHost = $('[data-topology-host]', this.el);
    this.topology = new SiteTopologyWidget(topoHost, {
      onDeploy: (selection) => {
        this.toggle(false);
        if (this.onDeploy) this.onDeploy(selection);
      },
    });

    this._bind();
    this._renderSuit();
  }

  get open() {
    return this.el.open;
  }

  setDeployHandler(fn) {
    this.onDeploy = fn;
  }

  connectTraverse(mission, { terrain = null, swapRoute = null } = {}) {
    this.mission = mission;
    this.terrain = terrain;
    this.swapRoute = swapRoute;
    this.relief = new TraverseRelief(mission.route);
  }

  toggle(show = !this.open, initialTab) {
    if (this.open === show) {
      if (show && initialTab) this.showTab(initialTab);
      return;
    }
    if (show) {
      this.el.showModal();
      const targetTab = initialTab || (this.mission?.state === 'legcheck' ? 'leg' : (this.mission ? 'guide' : 'topology'));
      this.showTab(targetTab);
    } else {
      this.el.close();
    }
  }

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
                ${TABS.map(([id, label]) => `<button type="button" data-tab="${id}">${label}</button>`).join('')}
              </nav>
              <button type="button" class="wd-close" data-close aria-label="Close wrist navigator" title="Close (P or Esc)">× Close</button>
            </div>
            <div class="wd-readouts">
              <span>Outside <b data-temp>−23 °C</b> <small>SIM</small></span>
              <span>Local time <b data-lmst>--:--</b></span>
              <span>Suit O₂ <b data-oxygen>100% · 8h 00m</b></span>
            </div>
            <div class="wd-page">
              <section data-guide>
                <p class="wd-h">Field guidance <span data-plan-name>Delta Front</span></p>
                <h2 class="wd-verdict" data-advice>Ready for deployment</h2>
                <p class="wd-say" data-reason>Select a landing site in Site Topology or begin surface traverse.</p>
                <div class="wd-field-metrics">
                  <div><span>Next stop</span><b data-next-stop>S1 · -- m</b></div>
                  <div><span>Follow route</span><b data-bearing>N · 0°</b></div>
                  <div><span>Hazard ahead</span><b data-hazard>Clear</b></div>
                  <div><span>O₂ if returning now</span><b data-home-o2>6h 30m</b></div>
                  <div><span>Inside HAB if returning now</span><b data-home-time></b></div>
                  <div><span>Battery if returning now</span><b data-home-power></b></div>
                </div>
                <button type="button" class="wd-return" data-return hidden>Turn around and return ↶</button>
              </section>
              <section data-leg hidden>
                <p class="wd-h">Next leg <span data-leg-where></span></p>
                <div class="wd-legmap" data-leg-mapbox><canvas data-leg-map width="560" height="105" aria-label="Paths to the next station"></canvas></div>
                <div class="wd-paths" data-leg-paths role="radiogroup" aria-label="Path to the next station"></div>
                <div class="wd-plans" data-leg-options role="radiogroup" aria-label="What to do at the next station"></div>
                <p class="wd-legstatus" data-leg-say></p>
                <ul class="wd-chips" data-leg-checks></ul>
                <button type="button" class="wd-return wd-confirm" data-leg-confirm>Confirm →</button>
              </section>
              <section data-route-view hidden>
                <p class="wd-h">Selected traverse <span data-route-name>Delta Front</span></p>
                <p class="wd-maplegend" data-route-weather></p>
                <canvas data-traverse width="400" height="240" aria-label="Selected route over mission terrain"></canvas>
                <p class="wd-maplegend">◇ Science stop · ▲ Hazard gate · ■ Habitat · ● Rover</p>
                <section data-weather-drive hidden aria-label="Weather decisions">
                  <p class="wd-maplegend" data-drive-cost></p>
                  <button type="button" class="wd-return" data-wait-weather>Wait in rover</button>
                  <p class="wd-maplegend" data-wait-cost></p>
                </section>
                <section class="station-decisions" data-field-science aria-label="Station decisions" hidden></section>
              </section>
              <section data-topology-view hidden>
                <div data-topology-host></div>
              </section>
              <section data-suit-view hidden>
                <div data-suit-host></div>
              </section>
            </div>
            <footer class="wd-foot"><span>Return reserve · ${LIFE_SUPPORT.reserveMinutes} min</span><span class="wd-meter"><i data-meter style="width:100%"></i></span></footer>
            <div class="wd-scan" aria-hidden="true"></div>
          </div>
        </div>
        <div class="wd-side">
          <button type="button" class="wd-selector" data-next aria-label="Next screen" title="Next screen">
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
          <span class="wd-plate">ASTRONAUT MISSION TABLET &amp; NAVIGATOR <b>MK II</b></span>
          <span class="wd-grille"></span>
        </div>
      </div>
      <div class="wd-keys"><span><kbd>←</kbd> <kbd>→</kbd> Switch site / screen</span><span><kbd>Enter</kbd> Select / Zoom</span><span><kbd>P</kbd> Close</span></div>
    </div>`;
  }

  _renderSuit() {
    const host = $('[data-suit-host]', this.el);
    if (!host) return;
    const routeEst = { oxygen_cost: 42, battery_drain: 280, hazard_warnings: ['Loose Regolith'] };
    const p = predict(routeEst, this.suit, this.siteMinutes);

    host.innerHTML = `
      <p class="wd-h">Astronaut Suit &amp; Crew Data <span>Verdict: ${p.verdict}</span></p>
      <div class="wd-suit-presets">
        ${SUIT_PRESETS.map(
          (s) => `<button type="button" class="wd-preset-btn ${this.preset === s.id ? 'on' : ''}" data-preset="${s.id}">
            <b>${s.name}</b><small>${s.tagline}</small>
          </button>`
        ).join('')}
      </div>
      <div class="wd-field-metrics" style="margin-top:8px">
        <div><span>Total Suit Mass</span><b>${p.massKg.toFixed(1)} kg</b></div>
        <div><span>Predicted O₂ Used</span><b>${hm(p.o2.used)} / ${hm(p.o2.budget)}</b></div>
        <div><span>Rover Battery Est.</span><b>${Math.round(p.battery.used)} / ${p.battery.budget} Wh</b></div>
        <div><span>Radiation Dose</span><b>${Math.round(p.dose.usv)} µSv</b></div>
      </div>
      <div class="wd-suit-sliders">
        ${SUIT.materials
          .map(
            (m) => `<label class="wd-suit-slider">
              <span>${m.name} (<b>${this.suit[m.id]} ${m.unit}</b>)</span>
              <input type="range" data-suit-mat="${m.id}" min="${m.min}" max="${m.max}" step="${m.step}" value="${this.suit[m.id]}" />
            </label>`
          )
          .join('')}
      </div>
    `;
  }

  _bind() {
    this.el.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-close')) this.toggle(false);
      else if (button.hasAttribute('data-return') && this.mission?.returnToHabitat()) this.toggle(false);
      else if (button.hasAttribute('data-wait-weather') && this.mission?.waitForWeather()) this.updateField(true);
      else if (button.dataset.tab) this.showTab(button.dataset.tab);
      else if (button.dataset.leg) { this.legChoice = button.dataset.leg; this.renderLeg(); }
      else if (button.dataset.path) { this.pathChoice = button.dataset.path; this.renderLeg(); }
      else if (button.hasAttribute('data-leg-confirm')) this.confirmLeg();
      else if (button.hasAttribute('data-next')) this.cycleTab();
      else if (button.dataset.preset) {
        this.preset = button.dataset.preset;
        const found = SUIT_PRESETS.find((p) => p.id === this.preset);
        if (found) this.suit = { ...found.suit };
        this._renderSuit();
      }
    });

    this.el.addEventListener('input', (event) => {
      const target = event.target;
      if (target && target.dataset?.suitMat) {
        this.suit[target.dataset.suitMat] = Number(target.value);
        this.preset = 'custom';
        this._renderSuit();
      }
    });

    window.addEventListener(
      'keydown',
      (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 'p') {
          if (!this.mission && !this.open) return;
          event.stopImmediatePropagation();
          event.preventDefault();
          if (!event.repeat) this.toggle();
        } else if (this.open) {
          // When on Site Topology tab, let Left/Right/Enter control the 5-site Mars Globe & Topography!
          if (this.tab === 'topology' && this.topology.handleKeyDown(event)) {
            return;
          }
          event.stopImmediatePropagation();
          if (['arrowleft', 'arrowright', 'q', 'e'].includes(key)) {
            event.preventDefault();
            if (!event.repeat) {
              const dir = key === 'arrowleft' || key === 'q' ? -1 : 1;
              this.cycleTab(dir);
            }
          }
        }
      },
      { capture: true }
    );

    window.addEventListener('resize', () => {
      if (this.open && this.tab === 'map') this.drawRoute();
      if (this.open && this.tab === 'topology') this.topology._scheduleDraw();
    });
  }

  // The "Next leg" screen only exists while the rover is parked at a station waiting for a decision.
  get tabs() {
    return this.mission?.state === 'legcheck'
      ? ['leg', 'guide', 'map', 'topology', 'suit']
      : ['guide', 'map', 'topology', 'suit'];
  }

  cycleTab(dir = 1) {
    const tabs = this.tabs;
    const idx = tabs.indexOf(this.tab);
    this.showTab(tabs[(idx + dir + tabs.length) % tabs.length]);
  }

  showTab(tab) {
    if (!this.tabs.includes(tab)) tab = this.tabs[0];
    this.tab = tab;
    $('[data-guide]', this.el).hidden = tab !== 'guide';
    $('[data-route-view]', this.el).hidden = tab !== 'map';
    $('[data-leg]', this.el).hidden = tab !== 'leg';
    $('[data-topology-view]', this.el).hidden = tab !== 'topology';
    $('[data-suit-view]', this.el).hidden = tab !== 'suit';
    for (const button of this.el.querySelectorAll('[data-tab]')) {
      button.hidden = !this.tabs.includes(button.dataset.tab);
      button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    }
    const tabBtn = $('[data-tab="' + tab + '"]', this.el);
    if (tabBtn) tabBtn.focus({ preventScroll: true });

    this.updateField(true);
    if (tab === 'leg') this.renderLeg(true);
    if (tab === 'topology') this.topology._scheduleDraw();
  }

  // The leg ahead: which station we stand at, where the leg goes, and its three paths (Delta loop only).
  _legContext() {
    const route = this.mission.route;
    const here = this.mission.currentStation;
    const stops = route.stations.filter((station) => !station.final);
    const index = stops.indexOf(here) + 1;
    const next = route.stations[stops.indexOf(here) + 1];
    const paths = route.legs && this.terrain ? legVariants(this.terrain, route.legs, index) : null;
    return { route, here, next, index, paths };
  }

  renderLeg(fresh = false) {
    const ctx = this._legContext();
    this.legCtx = ctx;
    if (fresh) this.pathChoice = 'planned';
    const path = ctx.paths?.find((p) => p.id === this.pathChoice) ?? null;
    let previewRoute = this.mission.route;
    if (path && path.id !== 'planned') {
      const legs = [...previewRoute.legs];
      legs[ctx.index] = path.curve;
      previewRoute = buildLoopRoute(this.terrain, legs);
    }
    const check = legOptions(this.mission, previewRoute);
    this.legCheck = check;
    if (fresh || !check.options.some((option) => option.id === this.legChoice)) this.legChoice = check.recommended.id;
    const chosen = check.options.find((option) => option.id === this.legChoice);

    $('[data-leg-where]', this.el).textContent = `${ctx.here?.id ?? ''} → ${ctx.next?.final ? 'HAB' : ctx.next?.id ?? 'HAB'} · ${check.now} · ${check.temperature} °C`.replace('-', '−');

    // 1. path to the next station (map + three cards)
    $('[data-leg-mapbox]', this.el).hidden = !ctx.paths;
    $('[data-leg-paths]', this.el).hidden = !ctx.paths;
    if (ctx.paths) {
      $('[data-leg-paths]', this.el).innerHTML = ctx.paths.map((p) => `
        <button type="button" role="radio" data-path="${p.id}" aria-checked="${p.id === this.pathChoice}" style="--path:${p.color}">
          <b>${p.label}</b>
          <span>${Math.round(p.distance)} m · ${p.minutes.toFixed(1)} min</span>
          <em class="lvl-${p.difficulty.toLowerCase()}">${p.difficulty}</em>
          <small>${p.danger ? `${p.danger} hazard stop${p.danger > 1 ? 's' : ''}` : 'No hazard stops'}</small>
        </button>`).join('');
      this._drawLegMap(ctx, path);
    }

    // 2. what to do at the next station
    $('[data-leg-options]', this.el).innerHTML = check.options.map((option) => `
      <button type="button" role="radio" data-leg="${option.id}" aria-checked="${option.id === this.legChoice}" class="${option.allowed ? '' : 'is-locked'}" title="${option.detail}">
        ${option.allowed ? '' : '✕ '}${option.short}
      </button>`).join('');

    // 3. one-line verdict + check chips
    const failed = chosen.checks.find((item) => !item.ok);
    const why = {
      oxygen: 'Not enough oxygen to keep the reserve',
      daylight: 'Too late: you would be back after twilight',
      cold: 'Too cold to work outside by then',
      battery: 'Rover battery would run too low',
      dust: 'Dust front coming: head home',
    };
    const say = $('[data-leg-say]', this.el);
    say.className = `wd-legstatus ${chosen.allowed ? 'ok' : 'fail'}`;
    say.textContent = chosen.allowed
      ? `✓ Safe · ${chosen.id === 'home' ? 'home' : 'could be home'} by ${chosen.backAt}`
      : `✕ ${why[failed.id]}`;
    const icon = { oxygen: 'O₂', daylight: 'Light', cold: 'Temp', battery: 'Batt', dust: 'Dust' };
    $('[data-leg-checks]', this.el).innerHTML = chosen.checks.map((item) => `
      <li class="${item.ok ? 'ok' : 'fail'}" title="${item.value} · ${item.rule}">${item.ok ? '✓' : '✕'} ${icon[item.id]}</li>`).join('');
    const confirm = $('[data-leg-confirm]', this.el);
    confirm.disabled = !chosen.allowed;
    confirm.textContent = chosen.allowed ? `Go: ${path ? `${path.label.toLowerCase()} path · ` : ''}${chosen.short.toLowerCase()} →` : 'Pick a green option';
  }

  // Top-down sketch of the leg: shaded terrain, the three paths, here and the next station.
  _drawLegMap(ctx, chosen) {
    const canvas = $('[data-leg-map]', this.el);
    const g = canvas.getContext('2d');
    const { width, height } = canvas;
    const pts = ctx.paths.flatMap((p) => Array.from({ length: 41 }, (_, i) => p.curve.getPointAt(i / 40)));
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const scale = Math.min((width - 40) / (Math.max(...xs) - Math.min(...xs) || 1), (height - 30) / (Math.max(...zs) - Math.min(...zs) || 1));
    const at = (x, z) => [width / 2 + (x - cx) * scale, height / 2 + (z - cz) * scale];
    const key = `${ctx.index}:${width}`;
    if (this._legMapKey !== key) {
      // hillshade once per leg, in the navigator's green
      const terrain = this.terrain;
      const img = g.createImageData(width, height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const wx = cx + (x - width / 2) / scale;
        const wz = cz + (y - height / 2) / scale;
        const dx = terrain.heightAt(wx + 3, wz) - terrain.heightAt(wx - 3, wz);
        const dz = terrain.heightAt(wx, wz + 3) - terrain.heightAt(wx, wz - 3);
        const k = Math.max(0, Math.min(1, 0.55 + dx * 0.12 + dz * 0.1));
        const o = (y * width + x) * 4;
        img.data.set([10 + 30 * k, 26 + 60 * k, 16 + 30 * k, 255], o);
      }
      this._legShade = img;
      this._legMapKey = key;
    }
    g.putImageData(this._legShade, 0, 0);
    for (const p of [...ctx.paths.filter((q) => q !== chosen), chosen].filter(Boolean)) {
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const q = p.curve.getPointAt(i / 60);
        const [x, y] = at(q.x, q.z);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.strokeStyle = p.color;
      g.globalAlpha = p === chosen ? 1 : 0.8;
      g.lineWidth = p === chosen ? 4 : 2.5;
      g.setLineDash(p === chosen ? [] : [7, 4]);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.setLineDash([]);
    const label = (q, text) => {
      const [x, y] = at(q.x, q.z);
      g.fillStyle = '#e8ffd8';
      g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
      g.font = 'bold 13px monospace';
      g.fillText(text, x + 8, y - 6);
    };
    label(ctx.paths[1].curve.getPointAt(0), `${ctx.here.id} · YOU`);
    label(ctx.paths[1].curve.getPointAt(1), ctx.next?.final ? 'HAB' : ctx.next?.id ?? 'HAB');
  }

  confirmLeg() {
    const chosen = this.legCheck?.options.find((option) => option.id === this.legChoice);
    if (!chosen?.allowed) return;
    const path = this.legCtx?.paths?.find((p) => p.id === this.pathChoice);
    if (path && path.id !== 'planned' && this.swapRoute) {
      const legs = [...this.mission.route.legs];
      legs[this.legCtx.index] = path.curve;
      this.swapRoute(buildLoopRoute(this.terrain, legs));
      this.relief = new TraverseRelief(this.mission.route);
    }
    if (this.mission.chooseLeg(chosen)) this.toggle(false);
  }

  drawRoute() {
    if (this.relief && this.mission) {
      this.relief.draw($('[data-traverse]', this.el), undefined, this.mission.s, this.mission.weather, this.mission.activeFront, this.mission.detectedObstacles);
    }
  }

  updateField(force = false) {
    if (!this.mission) return;
    const mission = this.mission;
    // Simulation is paused in the navigator until the crew takes an action.
    if (!force && this.lastFieldTime === mission.met && this.lastFieldState === mission.state) return;
    this.lastFieldTime = mission.met;
    this.lastFieldState = mission.state;
    const guidance = fieldGuidance(mission);
    const budget = LIFE_SUPPORT.evaHours * 60;
    const percent = Math.max(0, mission.o2Remaining) / budget;
    const name = mission.route.planName;
    const values = {
      oxygen: `${Math.round(percent * 100)}% · ${hm(mission.o2Remaining)}`,
      'plan-name': name,
      'route-name': name,
      'route-weather': mapWeatherLabel(mission.weather, mission.activeFront, mission.detectedObstacles),
      advice: guidance.advice,
      reason: guidance.reason,
      'next-stop': `${guidance.next} · ${guidance.distance} m`,
      bearing: `${guidance.direction} · ${guidance.degrees}°`,
      hazard: guidance.hazard,
      'home-o2': hm(guidance.returnOxygen),
      'home-time': guidance.returnForecast.backAt,
      'home-power': `${Math.floor(guidance.returnForecast.batteryPct)}%`,
      temp: `${Math.round(temperatureAt(mission.lmst) + mission.weather.temperatureOffsetC)} °C`.replace('-', '−'),
      lmst: `${String(Math.floor(mission.lmst / 60) % 24).padStart(2, '0')}:${String(Math.floor(mission.lmst % 60)).padStart(2, '0')}`,
    };
    for (const [key, value] of Object.entries(values)) {
      const node = $(`[data-${key}]`, this.el);
      if (node && node.textContent !== value) node.textContent = value;
    }
    $('[data-return]', this.el).hidden = !guidance.canReturn;
    const needle = $('[data-needle]', this.el);
    needle.style.setProperty('--needle', `${-66 + percent * 132}deg`);
    $('[data-meter]', this.el).style.width = `${percent * 100}%`;
    $('[data-lamp]', this.el).classList.toggle('caution', guidance.advice !== 'Continue');
    if (this.tab === 'map') {
      this.drawRoute();
      const science = $('[data-field-science]', this.el);
      science.hidden = !['station', 'stationDone'].includes(mission.state);
      if (!science.hidden) renderStationChoices(science, mission, () => this.updateField(true));
      const decision = $('[data-weather-drive]', this.el);
      decision.hidden = !['drive', 'gate'].includes(mission.state) || !(mission.waitSeconds > 0);
      if (!decision.hidden) {
        const wait = forecastReturn(mission, { waitSeconds: mission.waitSeconds });
        const drive = forecastReturn(mission);
        const budget = f => `HAB ${f.backAt} · O₂ ${Math.floor(f.oxygenLeft)} min · battery ${Math.floor(f.batteryPct)}% · ${Math.abs(Math.round(f.daylightMinutes))} min ${f.daylightMinutes >= 0 ? 'before' : 'after'} sunset`;
        $('[data-drive-cost]', this.el).textContent = `Continue now · ${budget(drive)}`;
        const button = $('[data-wait-weather]', this.el);
        button.disabled = !wait.reserveOK || wait.batteryPct < 10 || wait.daylightMinutes < -30;
        button.textContent = `Wait in rover · ${Math.ceil(mission.waitSeconds / 60)} min`;
        $('[data-wait-cost]', this.el).textContent = `${budget(wait)}${button.disabled ? ' · outside return limits' : ''}`;
      }
    }
  }
}
