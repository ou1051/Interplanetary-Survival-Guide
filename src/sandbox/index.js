import { formatHMS } from '../core/math.js';
import { createWalk } from './walk.js';
import { createScene } from './scene.js';
import { createMap } from './map.js';
import './sandbox.css';

// Mount one rehearsal. Both the exit button and the returned function deliver its result once.
export function startRehearsal(root, options, onExit) {
  const { site, route, visibility, windowId } = options;
  const walk = createWalk(options);
  root.innerHTML = `<section class="walk-shell" aria-label="Walking rehearsal">
    <header class="walk-header"><div><small>Freelance astronaut</small><h1>Surface rehearsal</h1></div><button class="walk-secondary" data-exit>End walk</button></header>
    <div class="walk-layout"><div class="walk-world">
      <div class="walk-viewport" tabindex="0" aria-label="Walking controls"></div>
      <div class="walk-telemetry"><span data-heading></span><span data-time></span><span data-distance></span></div>
      <div class="walk-hint" role="status"></div>
    </div><aside class="walk-rail">
      <section><small>Navigation</small><canvas class="walk-map" width="450" height="350" aria-label="North-up map of base, planned route, field stations and your position"></canvas>
      <div class="walk-conditions"></div></section>
      <section><h2>Field observations</h2><div class="walk-stations"></div></section>
      <section class="walk-keys"><h2>Controls</h2><p><kbd>W</kbd> <kbd>S</kbd> walk forward / back<br><kbd>A</kbd> <kbd>D</kbd> step left / right<br><kbd>←</kbd> <kbd>→</kbd> turn · <kbd>E</kbd> record</p></section>
    </aside></div></section>`;
  const el = selector => root.querySelector(selector);
  const viewport = el('.walk-viewport');
  const scene = createScene(viewport, options);
  const drawMap = createMap(el('canvas.walk-map'), site, route);
  el('.walk-conditions').textContent = windowId + ' · ' + visibility + ' visibility (simulated)';
  const first = route.cells.find(cell => cell.col !== site.base.col || cell.row !== site.base.row);
  let heading = first ? Math.atan2(first.col - site.base.col, site.base.row - first.row) : 0;
  const entries = route.orderedStationIds.map(id => {
    const station = site.stations.find(item => item.id === id);
    const observation = site.observations.find(item => item.id === station.observationId);
    const source = site.sources.find(item => item.id === observation?.sourceId);
    const card = document.createElement('div');
    card.className = 'walk-station';
    const name = document.createElement('strong');
    name.textContent = station.name;
    const range = document.createElement('span');
    const record = document.createElement('button');
    record.className = 'walk-secondary';
    record.textContent = 'Record ' + station.name;
    card.append(name, range, record);
    let evidence;
    if (observation) {
      evidence = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Inspect evidence';
      const image = document.createElement('img');
      image.src = observation.imageUrl;
      image.alt = observation.caption;
      const caption = document.createElement('p');
      caption.textContent = observation.caption;
      evidence.append(summary, image, caption);
      if (observation.cameraCell) {
        const camera = document.createElement('p');
        camera.textContent = 'Camera cell (' + observation.cameraCell.col + ', ' + observation.cameraCell.row + ').';
        evidence.append(camera);
      }
      if (source) {
        const credit = document.createElement('p');
        credit.textContent = [source.mission, source.productId, source.scale, source.processingNote].filter(Boolean).join(' · ');
        if (source.url) {
          const link = document.createElement('a');
          link.href = source.url;
          link.textContent = ' Source';
          link.target = '_blank';
          link.rel = 'noopener';
          credit.append(link);
        }
        evidence.append(credit);
      }
      card.append(evidence);
    }
    el('.walk-stations').append(card);
    record.onclick = () => { walk.record(id); update(); };
    return { station, range, record, evidence };
  });
  const keys = new Set();
  const headingText = el('[data-heading]'), timeText = el('[data-time]'), distanceText = el('[data-distance]');
  const hint = el('.walk-hint');
  function update() {
    const bearing = (Math.round(heading * 180 / Math.PI) % 360 + 360) % 360;
    headingText.textContent = ['N','NE','E','SE','S','SW','W','NW'][Math.round(bearing / 45) % 8] + ' ' + bearing + '°';
    timeText.textContent = formatHMS(walk.elapsedSeconds);
    distanceText.textContent = Math.round(walk.distanceM) + ' m walked';
    let next;
    let nearest = Infinity;
    for (const { station, range, record, evidence } of entries) {
      const near = walk.nearby(station.cell);
      const distance = Math.hypot(walk.x - station.cell.col * site.cellSizeM, walk.z - station.cell.row * site.cellSizeM);
      const done = walk.observedStationIds.includes(station.id);
      range.textContent = done ? 'Recorded' : Math.ceil(distance) + ' m away';
      if (((done || !near) && record === document.activeElement) ||
          (!near && !done && evidence?.contains(document.activeElement))) viewport.focus({ preventScroll: true });
      record.hidden = done;
      record.disabled = !near;
      if (evidence) evidence.hidden = !(near || done);
      if (near && !done && distance < nearest) { next = station; nearest = distance; }
    }
    const prompt = next ? 'Press E to record ' + next.name + '.'
      : walk.observedStationIds.length === entries.length ? (walk.nearby(site.base) ? 'Back at base. End walk to see your result.' : 'Both observations recorded. Return to base.')
      : 'Visit each marked station and record within ' + site.stationRadiusM + ' m.';
    if (hint.textContent !== prompt) hint.textContent = prompt;
    return next;
  }
  const held = ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
  const events = new AbortController();
  const listener = { signal: events.signal };
  root.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (held.includes(event.code)) { event.preventDefault(); keys.add(event.code); }
    if (event.code === 'KeyE' && !event.repeat) {
      const next = update();
      if (next) { walk.record(next.id); update(); }
    }
  }, listener);
  window.addEventListener('keyup', event => keys.delete(event.code), listener);
  let previous = performance.now();
  window.addEventListener('blur', () => keys.clear(), listener);
  document.addEventListener('visibilitychange', () => { previous = performance.now(); keys.clear(); }, listener);
  let frameId, closed = false;
  function advance(now) {
    const dt = Math.max(0, (now - previous) / 1000);
    previous = now;
    if (document.hidden) return;
    const turn = Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft'));
    heading += turn * dt * Math.PI / 2;
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
    const right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    walk.step(forward * Math.sin(heading) + right * Math.cos(heading), -forward * Math.cos(heading) + right * Math.sin(heading), dt);
  }
  let nextHud = 0;
  function frame(now) {
    advance(now);
    scene.render(walk, heading);
    if (now >= nextHud) { update(); drawMap(walk, heading); nextHud = now + 100; }
    frameId = requestAnimationFrame(frame);
  }
  function end() {
    if (closed) return;
    closed = true;
    advance(performance.now());
    cancelAnimationFrame(frameId);
    events.abort();
    scene.dispose();
    root.replaceChildren();
    onExit(walk.result());
  }
  el('[data-exit]').onclick = end;
  viewport.focus();
  frame(performance.now());
  return end;
}
