import { LIFE_SUPPORT, SITE } from '../config/mission.js';
import { fieldGuidance } from '../sim/fieldGuidance.js';
import { TraverseRelief } from './traverseRelief.js';
import './planningBoard.css';

const $ = (selector, root) => root.querySelector(selector);
const TABS = [['guide', 'Guide'], ['map', 'Route']];
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
      this.showTab('guide');
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
              <span>Outside <b>${String(SITE.outsideTemperatureC).replace('-', '−')} °C</b> <small>SIM</small></span>
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

  cycleTab() { this.showTab(this.tab === 'guide' ? 'map' : 'guide'); }

  showTab(tab) {
    this.tab = tab;
    $('[data-guide]', this.el).hidden = tab !== 'guide';
    $('[data-route-view]', this.el).hidden = tab !== 'map';
    for (const button of this.el.querySelectorAll('[data-tab]')) {
      button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    }
    $('[data-tab="' + tab + '"]', this.el).focus({ preventScroll: true });
    this.updateField();
    if (tab === 'map') this.drawRoute();
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
