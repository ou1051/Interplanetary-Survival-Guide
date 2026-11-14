import { site, route } from './fixture.js';
import { createMap } from './map.js';
import { startRehearsal } from './index.js';
import { summarizeWalk } from './debrief.js';
import { formatHMS } from '../core/math.js';

export function openDemo(root) {
  const windows = { Dawn: 'clear', Midday: 'hazy', Dusk: 'poor' };
  let chosen = route, revision = 1, windowId = 'Dawn', lastResult;
  document.title = 'Surface rehearsal · Interplanetary Survival Guide';
  function planning() {
    root.innerHTML = `<main class="walk-planning">
      <header><a href="?">← Rover simulation</a><small>Freelance astronaut · Field rehearsal</small></header>
      <div class="walk-brief"><section><small>Synthetic development fixture</small><h1>Rehearse the ridge walk</h1>
      <p>Walk from base to the ridge and adjacent rock. Record what you find at each station, then bring both observations back to base.</p>
      <dl><div><dt>Round trip</dt><dd>180 m</dd></div><div><dt>Walk budget</dt><dd>5 min</dd></div><div><dt>Record within</dt><dd>10 m</dd></div></dl>
      <label>Station order<select data-order><option value="forward">Ridge first</option><option value="reverse">Adjacent rock first</option></select></label>
      <label>Rehearsal window<select data-window><option>Dawn</option><option>Midday</option><option>Dusk</option></select></label>
      <button class="walk-primary" data-start>Start rehearsal</button>
      </section><figure><canvas width="450" height="350"></canvas>
      <figcaption>North-up practice grid · B fictional base · 1 ridge · 2 adjacent rock. Terrain and evidence are synthetic.</figcaption></figure></div>
      <section class="walk-result" aria-label="Rehearsal debrief" hidden><small>Field debrief</small><h2></h2><p data-detail></p><p data-metrics></p><p data-log></p><p data-plan></p></section>
      </main>`;
    const order = root.querySelector('[data-order]');
    const windowSelect = root.querySelector('[data-window]');
    const draw = () => createMap(root.querySelector('canvas'), site, chosen)({
      x: site.base.col * site.cellSizeM, z: site.base.row * site.cellSizeM,
    }, Math.atan2(chosen.cells[1].col - site.base.col, site.base.row - chosen.cells[1].row));
    order.value = chosen === route ? 'forward' : 'reverse';
    order.onchange = () => {
      chosen = order.value === 'forward' ? route : { ...route, id: 'practice-reverse',
        cells: [...route.cells].reverse(), orderedStationIds: [...route.orderedStationIds].reverse() };
      revision++;
      draw();
    };
    for (const option of windowSelect.options) {
      option.value = option.text;
      option.text += ' · ' + windows[option.value] + ' visibility';
    }
    windowSelect.value = windowId;
    windowSelect.onchange = () => { windowId = windowSelect.value; };
    draw();
    root.querySelector('[data-start]').onclick = () => {
      const options = { site, route: chosen, planRevision: revision, windowId, visibility: windows[windowId] };
      startRehearsal(root, options, result => {
        lastResult = { result, route: chosen };
        planning();
        const heading = root.querySelector('.walk-result h2');
        heading.tabIndex = -1;
        heading.focus();
      });
    };
    if (lastResult) {
      const { result, route: rehearsed } = lastResult;
      const { title, details } = summarizeWalk(site, result);
      const box = root.querySelector('.walk-result');
      box.hidden = false;
      box.querySelector('h2').textContent = title;
      box.querySelector('[data-detail]').textContent = details;
      box.querySelector('[data-log]').textContent = 'Recorded: ' +
        (result.observedStationIds.map(id => site.stations.find(station => station.id === id).name).join(', ') || 'none') +
        ' · ' + (result.returnedToBase ? 'Returned to base' : 'No base return');
      box.querySelector('[data-metrics]').textContent = Math.round(result.distanceM) + ' m walked in ' + formatHMS(result.elapsedSeconds) +
        ' · 1 m/s horizontal walking speed · 5 min budget';
      box.querySelector('[data-plan]').textContent = 'Plan revision ' + result.planRevision + ' · ' + result.windowId + ' · ' + result.visibility +
        ' visibility · ' + rehearsed.limitedCoverageDistanceM + ' m of the planned route have limited evidence.';
    }
  }
  planning();
}
