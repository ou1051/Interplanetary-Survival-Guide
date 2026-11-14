import { LIFE_SUPPORT } from '../config/mission.js';
import { fieldGuidance } from '../sim/fieldGuidance.js';
import { legOptions, temperatureAt } from '../sim/legCheck.js';
import { TraverseRelief } from './traverseRelief.js';
import './planningBoard.css';

const $ = (selector, root) => root.querySelector(selector);
const TABS = [['guide', 'Guide'], ['map', 'Route'], ['leg', 'Next leg']];
const hm = (min) => {
  const m = Math.max(0, Math.round(min));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

export class PlanningBoard {
  constructor() {
    this.tab = 'guide';
    this.el = document.createElement('dialog');
    this.el.id = 'planningBoard';
    this.el.className = 'pb';
    this.el.setAttribute('aria-label', 'EVA wrist navigator');
    this.el.innerHTML = this._shell();
    document.getElementById('app').appendChild(this.el);
    this._bind();
  }

  get open() { return this.el.open; }

  connectTraverse(mission) {
    this.mission = mission;
    this.relief = new TraverseRelief(mission.route);
  }

  toggle(show = !this.open) {
    if (!this.mission || this.open === show) return;
    if (show) {
      this.el.showModal();
      this.showTab(this.mission.state === 'legcheck' ? 'leg' : 'guide');
    } else this.el.close();
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
              <span>Outside <b data-temp></b> <small>SIM</small></span>
              <span>Local time <b data-lmst></b></span>
              <span>Suit O₂ <b data-oxygen></b></span>
            </div>
            <div class="wd-page">
              <section data-guide>
                <p class="wd-h">Field guidance <span data-plan-name></span></p>
                <h2 class="wd-verdict" data-advice></h2>
                <p class="wd-say" data-reason></p>
                <div class="wd-field-metrics">
                  <div><span>Next stop</span><b data-next-stop></b></div>
                  <div><span>Follow route</span><b data-bearing></b></div>
                  <div><span>Hazard ahead</span><b data-hazard></b></div>
                  <div><span>Est. O₂ on return</span><b data-home-o2></b></div>
                </div>
                <button type="button" class="wd-return" data-return>Turn around and return ↶</button>
              </section>
              <section data-leg hidden>
                <p class="wd-h">Leg check <span data-leg-where></span></p>
                <p class="wd-say" data-leg-say></p>
                <div class="wd-legs" data-leg-options role="radiogroup" aria-label="Next leg options"></div>
                <button type="button" class="wd-return wd-confirm" data-leg-confirm>Confirm leg →</button>
                <ul class="wd-checks" data-leg-checks></ul>
              </section>
              <section data-route-view hidden>
                <p class="wd-h">Selected traverse <span data-route-name></span></p>
                <canvas data-traverse width="400" height="240" aria-label="Selected route over mission terrain"></canvas>
                <p class="wd-maplegend">◇ Science stop · ▲ Hazard gate · ■ Habitat · ● Rover</p>
              </section>
            </div>
            <footer class="wd-foot"><span>Return reserve · ${LIFE_SUPPORT.reserveMinutes} min</span><span class="wd-meter"><i data-meter></i></span></footer>
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
    this.el.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-close')) this.toggle(false);
      else if (button.hasAttribute('data-return') && this.mission.returnToHabitat()) this.toggle(false);
      else if (button.dataset.tab) this.showTab(button.dataset.tab);
      else if (button.dataset.leg) { this.legChoice = button.dataset.leg; this.renderLeg(); }
      else if (button.hasAttribute('data-leg-confirm')) this.confirmLeg();
      else if (button.hasAttribute('data-next')) this.cycleTab();
    });

    window.addEventListener('keydown', (event) => {
      if (!this.mission || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.stopImmediatePropagation();
        event.preventDefault();
        if (!event.repeat) this.toggle();
      } else if (this.open) {
        event.stopImmediatePropagation();
        if (['arrowleft', 'arrowright', 'q', 'e'].includes(key)) {
          event.preventDefault();
          if (!event.repeat) this.cycleTab();
        }
      }
    }, { capture: true });
    window.addEventListener('resize', () => {
      if (this.open && this.tab === 'map') this.drawRoute();
    });
  }

  // The "Next leg" screen only exists while the rover is parked at a station waiting for a decision.
  get tabs() { return this.mission?.state === 'legcheck' ? ['leg', 'guide', 'map'] : ['guide', 'map']; }

  cycleTab() {
    const tabs = this.tabs;
    this.showTab(tabs[(tabs.indexOf(this.tab) + 1) % tabs.length]);
  }

  showTab(tab) {
    if (!this.tabs.includes(tab)) tab = this.tabs[0];
    this.tab = tab;
    $('[data-guide]', this.el).hidden = tab !== 'guide';
    $('[data-route-view]', this.el).hidden = tab !== 'map';
    $('[data-leg]', this.el).hidden = tab !== 'leg';
    for (const button of this.el.querySelectorAll('[data-tab]')) button.hidden = !this.tabs.includes(button.dataset.tab);
    if (tab === 'leg') this.renderLeg(true);
    for (const button of this.el.querySelectorAll('[data-tab]')) {
      button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    }
    $('[data-tab="' + tab + '"]', this.el).focus({ preventScroll: true });
    this.updateField();
    if (tab === 'map') this.drawRoute();
  }

  renderLeg(fresh = false) {
    const check = legOptions(this.mission);
    this.legCheck = check;
    if (fresh || !check.options.some((option) => option.id === this.legChoice)) this.legChoice = check.recommended.id;
    const chosen = check.options.find((option) => option.id === this.legChoice);
    const here = this.mission.currentStation;
    $('[data-leg-where]', this.el).textContent = `${here ? here.id : ''} · ${check.now} · ${check.temperature} °C`;
    $('[data-leg-say]', this.el).textContent = chosen.allowed
      ? (chosen.id === 'home' ? `Head home now: back at the airlock by ${chosen.backAt}.`
        : `${chosen.label}: about ${hm(chosen.legMinutes)}. Turning home after it would still get you back by ${chosen.backAt}.`)
      : `${chosen.label} is not allowed: ${chosen.reason.toLowerCase()}.`;
    $('[data-leg-options]', this.el).innerHTML = check.options.map((option) => `
      <button type="button" role="radio" data-leg="${option.id}" aria-checked="${option.id === this.legChoice}"
        class="${option.allowed ? '' : 'is-locked'}">
        <b>${option.allowed ? '' : '✕ '}${option.label}</b>
        <span>${option.detail}</span>
        <small>${option.allowed ? (option.id === 'home' ? `≈ ${hm(option.minutes)} · home by ${option.backAt}` : `≈ ${hm(option.legMinutes)} · safe return by ${option.backAt}`) : `Locked: ${option.reason}`}</small>
      </button>`).join('');
    $('[data-leg-checks]', this.el).innerHTML = chosen.checks.map((item) => `
      <li class="${item.ok ? 'ok' : 'fail'}" title="${item.rule}"><i>${item.ok ? '✓' : '✕'}</i><b>${item.label}</b><span>${item.value}</span>${item.ok ? '' : `<small>${item.rule}</small>`}</li>`).join('');
    const confirm = $('[data-leg-confirm]', this.el);
    confirm.disabled = !chosen.allowed;
    confirm.textContent = chosen.allowed ? `Confirm: ${chosen.label} →` : 'Choose an allowed leg';
  }

  confirmLeg() {
    const chosen = this.legCheck?.options.find((option) => option.id === this.legChoice);
    if (chosen && this.mission.chooseLeg(chosen)) this.toggle(false);
  }

  drawRoute() {
    this.relief.draw($('[data-traverse]', this.el), undefined, this.mission.s);
  }

  updateField() {
    const mission = this.mission;
    const guidance = fieldGuidance(mission);
    const budget = LIFE_SUPPORT.evaHours * 60;
    const percent = Math.max(0, mission.o2Remaining) / budget;
    const name = mission.route.planName;
    const values = {
      oxygen: `${Math.round(percent * 100)}% · ${hm(mission.o2Remaining)}`,
      'plan-name': name,
      'route-name': name,
      advice: guidance.advice,
      reason: guidance.reason,
      'next-stop': `${guidance.next} · ${guidance.distance} m`,
      bearing: `${guidance.direction} · ${guidance.degrees}°`,
      hazard: guidance.hazard,
      'home-o2': hm(guidance.returnOxygen),
      temp: `${Math.round(temperatureAt(mission.lmst))} °C`.replace('-', '−'),
      lmst: `${String(Math.floor(mission.lmst / 60) % 24).padStart(2, '0')}:${String(Math.floor(mission.lmst % 60)).padStart(2, '0')}`,
    };
    for (const [key, value] of Object.entries(values)) {
      const node = $(`[data-${key}]`, this.el);
      if (node.textContent !== value) node.textContent = value;
    }
    $('[data-return]', this.el).hidden = !guidance.canReturn;
    const needle = $('[data-needle]', this.el);
    needle.style.setProperty('--needle', `${-66 + percent * 132}deg`);
    $('[data-meter]', this.el).style.width = `${percent * 100}%`;
    $('[data-lamp]', this.el).classList.toggle('caution', guidance.advice !== 'Continue');
    // Repaint only when the rover moves far enough to change its map marker.
    const position = Math.round(mission.s);
    if (this.tab === 'map' && position !== this.mapPosition) {
      this.drawRoute();
      this.mapPosition = position;
    }
  }
}
