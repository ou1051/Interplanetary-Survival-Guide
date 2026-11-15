import { consumptionEstimate } from '../physics/traverse.js';
import { formatHM } from '../core/math.js';

// Used by both the parked station card and wrist navigator. Buttons remain mounted while forecasts update.
export function renderStationChoices(container, mission, onAction = () => {}) {
  const station = mission.currentStation;
  if (!station || !['station', 'stationDone'].includes(mission.state)) {
    container.replaceChildren();
    return;
  }
  if (!container.querySelector('.station-conditions')) {
    container.innerHTML = '<h3>CREW DECISION</h3><p class="station-conditions"></p><div class="station-actions"></div><div class="station-outcomes"></div>';
  }
  const weather = mission.weather;
  const outsideLeft = Math.max(0, (weather.exposureMinutes ?? Infinity) - mission.outsideMinutes);
  container.querySelector('.station-conditions').textContent = `${weather.label}${Number.isFinite(outsideLeft) ? ` · ${outsideLeft} min outside left in this cold spell` : ''} · choose a task to run, or hold E for the first unfinished task.`;
  const actions = container.querySelector('.station-actions');
  const options = mission.stationOptions;
  const key = `${station.id}:${options.map(option => option.id).join(',')}`;
  if (actions.dataset.key !== key) {
    const hadFocus = actions.contains(document.activeElement);
    actions.replaceChildren(...options.map(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'station-action';
      button.dataset.action = option.id;
      button.innerHTML = '<strong></strong><span class="decision-detail"></span><span class="decision-budget"></span><span class="decision-reason"></span>';
      button.addEventListener('click', () => {
        mission.chooseStationAction(option.id);
        renderStationChoices(container, mission, onAction);
        onAction();
      });
      return button;
    }));
    actions.dataset.key = key;
    if (hadFocus) actions.querySelector('button:not(:disabled)')?.focus();
  }
  options.forEach((option, i) => {
    const button = actions.children[i];
    button.disabled = !option.allowed;
    button.querySelector('strong').textContent = option.label;
    button.querySelector('.decision-detail').textContent = option.detail;
    const cost = consumptionEstimate(option.workMinutes * 60, { work: true }).oxygenMinutes + option.waitSeconds / 60;
    const f = option.forecast;
    button.querySelector('.decision-budget').textContent = `+${Math.ceil(option.workMinutes + option.waitSeconds / 60)} min · O₂ cost ${cost.toFixed(1)} min · HAB O₂ ${Math.floor(f.oxygenLeft)} min · battery ${f.batteryPct.toFixed(0)}% · home ${typeof f.backAt === 'number' ? formatHM(f.backAt) : f.backAt} · daylight ${Math.floor(f.daylightMinutes)} min`;
    button.querySelector('.decision-reason').textContent = option.reason;
  });
  const outcomes = container.querySelector('.station-outcomes');
  const results = mission.scienceResults.filter(result => result.station === station.id);
  const resultKey = JSON.stringify(results);
  if (outcomes.dataset.key !== resultKey) {
    outcomes.replaceChildren(...results.map(result => {
      const p = document.createElement('p');
      p.textContent = `${result.task}: ${result.result} · ${result.status}`;
      return p;
    }));
    outcomes.dataset.key = resultKey;
  }
}
