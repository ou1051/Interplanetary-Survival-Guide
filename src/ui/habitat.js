import { deltaPlan, buildDeltaTraverse, buildDeltaApproaches } from '../data/deltaTraverse.js';
import { makeDeltaOverview } from './deltaOverview.js';
import { mountHabitatRoom } from './habitatRoom.js';
import { mountHabitatExterior } from './habitatExterior.js';
import { mountConsoleMap3D } from './consoleMap3D.js';
import { base, outcrop, gridPosition, imagery, observationSource, terrainSource, siteWidth, terrainSlope, planGaleRoutes } from '../data/galeSite.js';
import { SLOPE_CLASSES } from '../config/mission.js';
import './habitat.css';

const fmt = (n) => Math.round(n).toLocaleString('en');
const oxygen = (n) => {
  const minutes = Math.round(n);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};
const { caution, danger } = SLOPE_CLASSES;
const slopeKey = `Green <${caution}° · Amber ${caution}–${danger}° · Red ≥${danger}°`;
const routeName = (id) => id === 'recommended' ? 'Recommended' : 'Shortest';

export function mountHabitat(root, launch) {
  const plans = planGaleRoutes().map(plan => ({
    ...plan, name: `${routeName(plan.id)} route`, site: { name: 'Gale Crater · Vera Rubin Ridge', eva: 'EVA-01', sol: 214 },
  }));
  const original = { ...deltaPlan };
  let selected = original;
  let galeSelection = plans[0];
  let deltaMap, s1Map, approaches;
  let s1Focused = false;
  let approachChoice;
  let mode = 'orbital';
  let view3d = true;
  let map3d = null;
  let map3dLoading = null;
  root.innerHTML = `
    <div class="hab-stage hab-before-entry" inert>
      <canvas class="hab-room" data-room aria-hidden="true"></canvas>
      <header class="hab-overlay">
        <span>EVA-01 <b>·</b> <span data-site-name>DELTA FRONT</span></span>
        <span>Inside habitat</span>
      </header>
      <div class="hab-wall">
        <div class="hab-screen">
          <header class="hab-header"><h1>Mission briefing</h1><span class="hab-eva"><i></i> EVA-01</span><nav class="hab-nav" aria-label="Mission navigation">
            <a href="./map.html">Explore Mars</a>
            <button type="button" id="sourcesBtn">Mission &amp; sources</button>
            <button type="button" data-review-close>← Habitat view</button>
          </nav></header>
          <div class="hab-console-grid">
          <div class="hab-layout">
            <aside class="hab-metrics" aria-label="Selected route">
              <div><span>Objective</span><b data-objective-short>Visit four science stations</b></div>
              <div><span>Route</span><b data-route-name></b></div>
              <div><span>Round trip</span><b data-distance></b></div>
              <div><span>Max slope</span><b data-slope></b></div>
            </aside>
            <section class="hab-map" aria-label="Route comparison">
              <div class="hab-mapframe">
                <img src="${imagery.orbital}" alt="HiRISE orbital image of the Gale Crater demo area">
                <canvas width="640" height="400" aria-hidden="true"></canvas>
                <div class="hab-map3d" data-map3d hidden></div>
                <span class="hab-map3d-status" data-map3d-status hidden>Loading 3D Mars…</span>
                <button type="button" class="hab-pin" data-observation aria-label="Open Curiosity observation at the science stop">S1 ↗</button>
                <button type="button" class="hab-pin hab-s1" data-s1 aria-label="S1 · Crater Floor Unit">S1 ↗</button>
                <span class="hab-base">HAB</span><span class="hab-scale">50 m</span><span class="hab-north">↑ N</span>
              </div>
            </section>
          </div>
          <footer class="hab-mapbar">
            <div class="hab-layers" role="group" aria-label="Map layers">
              <button type="button" data-layer="orbital" aria-pressed="true" data-surface-layer>Terrain</button>
              <button type="button" data-layer="slope" aria-pressed="false">Slope</button>
            </div>
            <div class="hab-layers hab-viewmode" role="group" aria-label="Map view">
              <button type="button" data-view3d="3d" aria-pressed="true">3D</button>
              <button type="button" data-view3d="2d" aria-pressed="false">2D</button>
              <button type="button" data-spin aria-pressed="true" title="Turn the view around the site">⟳ 360°</button>
            </div>
            <a data-gale-only href="${terrainSource}" target="_blank" rel="noopener" aria-label="HiRISE source: NASA, JPL-Caltech, University of Arizona and USGS">HiRISE ↗</a>
          </footer>
          <div class="hab-mapcredit">
            <span data-layer-note>Orbital imagery</span>
            <span class="hab-key" data-route-key><i></i> Route · ▲ Hazard gate</span>
          </div>
          </div>
          <section class="hab-brief" aria-label="Choose a route" inert>
            <label class="hab-scenario">Mission site
              <select data-site-select><option value="delta">Original Delta Traverse</option><option value="gale"${plans.length ? '' : ' disabled'}>Gale Crater · Vera Rubin Ridge</option></select>
            </label>
            <section data-delta-brief>
              <h3 class="hab-objective">Original Delta Traverse</h3>
              <p data-delta-summary></p>
              <ol class="hab-delta-stations" data-delta-stations></ol>
              <div data-s1-overview><button type="button" class="hab-step" data-s1>Plan leg to S1 →</button></div>
              <div data-s1-picker hidden>
                <button type="button" class="hab-step" data-s1-back>← Full traverse</button>
                <h3>Habitat → S1 · Crater Floor Unit</h3>
                <div class="hab-routes hab-approaches" data-approaches role="group" aria-label="Approaches to S1"></div>
              </div>
            </section>
            <div data-gale-only>
            <h3 class="hab-objective">Sample a layered outcrop</h3>
            <p>Compare two visible sediment layers. Collect paired samples and return to the habitat.</p>
            <button type="button" class="hab-observation" data-observation>
              <img src="${imagery.mastcam}" alt="">
              <span><b>Curiosity field reference ↗</b><small>Mastcam · Sol 1790</small></span>
            </button>
            <h3>Choose a round trip</h3>
            <div class="hab-routes" role="group" aria-label="Route options">
              ${plans.map(plan => `<button type="button" data-plan="${plan.id}" aria-pressed="${plan === selected}">
                <b>${routeName(plan.id)}</b><span>${fmt(plan.distanceM)} m</span>
                <small>${plan.surfaceSlope.toFixed(1)}° max mapped slope</small></button>`).join('')}
            </div>
            <p class="hab-reason" data-reason></p>
            <label class="hab-scenario">Simulation conditions
              <select data-scenario><option value="clear">Nominal conditions</option><option value="dust">Dust front ahead</option></select>
            </label>
            </div>
            <button type="button" data-launch class="hab-launch">Go outside <span>→</span></button>
            <p class="hab-note" data-status role="status">Oxygen and weather are simulated.</p>
          </section>
          <button type="button" data-screen-open class="hab-screen-open" aria-label="Zoom in to mission map"></button>
        </div>
      </div>
      <button type="button" data-review-open class="hab-review"><kbd>E</kbd> Review route</button>
    </div>
    <section class="hab-intro" data-intro aria-labelledby="hab-intro-title">
      <canvas class="hab-exterior" data-exterior aria-hidden="true"></canvas>
      <div class="hab-intro-shade" aria-hidden="true"></div>
      <div class="hab-intro-card">
        <p class="hab-eyebrow">Interplanetary Survival Guide</p>
        <h1 id="hab-intro-title">Mars Surface<br>Operations</h1>
        <p>Plan a rover traverse from the habitat console. Visit the science stops and get back to the habitat with oxygen to spare.</p>
        <ol><li>Choose the original Delta Traverse or explore Gale Crater.</li><li>Drive the route and use your wrist navigator.</li><li>Complete the science tasks and return to the airlock.</li></ol>
        <button type="button" data-intro-enter>Enter habitat <span aria-hidden="true">→</span></button>
      </div>
    </section>
    <div class="hab-cut" data-cut aria-hidden="true"></div>
    <div class="hab-airlock" data-airlock hidden>
      <div class="hab-hatch" aria-hidden="true"></div>
      <div class="hab-airlock-status" role="status" tabindex="-1">
        <span class="hab-eyebrow">EVA-01 / Surface access</span>
        <strong>Airlock cycle</strong>
        <span data-airlock-progress>Sealing inner hatch…</span>
      </div>
    </div>
    <dialog data-photo-dialog class="hab-photo" aria-label="Curiosity field reference">
      <div><h2>Layers of Vera Rubin Ridge</h2><button type="button" data-photo-close>× Close</button></div>
      <img src="${imagery.mastcam}" alt="Curiosity Mastcam panorama showing distinct horizontal layers at the base of Vera Rubin Ridge">
      <p>Look for a boundary between two horizontal beds. Sample one rock above and one below it in the simulation. The archived photo is a regional reference.</p>
      <a href="${observationSource}" target="_blank" rel="noopener">Curiosity Mastcam · Sol 1790 · NASA/JPL-Caltech/MSSS ↗</a>
    </dialog>`;

  const query = (selector) => root.querySelector(selector);
  const canvas = query('.hab-mapframe canvas');
  const ctx = canvas.getContext('2d');
  const crop = { x: 376, y: 257, span: 220 };
  const scale = 640 / crop.span;
  const pixel = (cell) => {
    const [x, y] = gridPosition(cell);
    return [(x + siteWidth / 2 - crop.x) * scale, (y + siteWidth / 2 - crop.y) * scale];
  };
  const photo = query('.hab-mapframe > img');
  const cropHeight = crop.span * canvas.height / canvas.width;
  photo.style.width = `${siteWidth / crop.span * 100}%`;
  photo.style.height = `${siteWidth / cropHeight * 100}%`;
  photo.style.left = `${-crop.x / crop.span * 100}%`;
  photo.style.top = `${-crop.y / cropHeight * 100}%`;
  query('.hab-scale').style.width = `${50 / crop.span * 100}%`;
  for (const [selector, cell] of [['.hab-pin', outcrop], ['.hab-base', base]]) {
    const [x, y] = pixel(cell);
    const el = query(selector);
    el.style.left = `${x / 6.4}%`;
    el.style.top = `${y / canvas.height * 100}%`;
  }

  const slope = document.createElement('canvas');
  slope.width = slope.height = 160;
  const shade = slope.getContext('2d');
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
    const value = terrainSlope(x * 4 - 318, y * 4 - 318);
    shade.fillStyle = value >= danger ? '#ff7958ad' : value >= caution ? '#f3b65386' : '#68c69a48';
    shade.fillRect(x, y, 1, 1);
  }

  const tracks = plans.map(plan => {
    const path = new Path2D();
    plan.path.forEach((cell, index) => {
      const [x, y] = pixel(cell);
      if (index) path.lineTo(x, y);
      else path.moveTo(x, y);
    });
    return { plan, path };
  });
  function routeUnderPointer(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    ctx.save();
    ctx.lineWidth = 22;
    ctx.setLineDash([]);
    const match = tracks.find(({ plan, path }) => plan !== selected && ctx.isPointInStroke(path, x, y));
    ctx.restore();
    return match?.plan;
  }
  canvas.addEventListener('click', (event) => {
    if (!zoomed || launching) return;
    if (selected === original) {
      if (!s1Focused) return;
      const rect = canvas.getBoundingClientRect();
      const choice = s1Map.pick(ctx, (event.clientX - rect.left) * canvas.width / rect.width,
        (event.clientY - rect.top) * canvas.height / rect.height);
      if (choice) { approachChoice = choice; update(); }
      return;
    }
    const plan = routeUnderPointer(event);
    if (plan) {
      selected = galeSelection = plan;
      update();
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    canvas.style.cursor = selected !== original && routeUnderPointer(event) ? 'pointer' : '';
  });

  function update() {
    const delta = selected === original;
    if (delta && !deltaMap) {
      original.traverse = buildDeltaTraverse();
      const route = original.traverse.route;
      original.distanceM = route.length;
      original.surfaceSlope = route.stats.maxTilt;
      approaches = buildDeltaApproaches(original.traverse);
      deltaMap = makeDeltaOverview(route, canvas.width, canvas.height, approaches);
      query('[data-approaches]').innerHTML = approaches.map(option => `<button type="button" data-approach="${option.id}" style="--route-color:${option.color}">
        <b>${option.label}</b><span>${fmt(option.distance)} m</span><small>${option.detail} · ${option.maxTilt.toFixed(1)}° max tilt</small>
      </button>`).join('');
      const stations = route.stations.filter(stop => !stop.final);
      const gates = route.stops.filter(stop => stop.kind === 'gate').length;
      query('[data-delta-summary]').innerHTML = [
        ['Round trip', `${(route.length / 1000).toFixed(2)} km`],
        ['Science stations', stations.length],
        ['Hazard gates', gates],
        ['End point', 'Habitat'],
      ].map(([k, v]) => `<span class="hab-kv"><small>${k}</small><b>${v}</b></span>`).join('');
      query('[data-delta-stations]').innerHTML = stations.map((stop, i) => `<li><i>S${i + 1}</i>${stop.name}</li>`).join('');
    }
    for (const element of root.querySelectorAll('[data-gale-only], .hab-mapframe > img, .hab-pin:not(.hab-s1), .hab-base, .hab-scale')) {
      element.hidden = delta;
    }
    query('[data-delta-brief]').hidden = !delta;
    root.classList.toggle('hab-s1-focused', delta && s1Focused);
    query('[data-s1-picker]').hidden = !s1Focused;
    query('[data-s1-overview]').hidden = s1Focused;
    query('[data-delta-stations]').hidden = s1Focused;
    query('[data-delta-summary]').hidden = s1Focused;
    query('.hab-s1').hidden = !delta;
    query('[data-site-name]').textContent = selected.site.name;
    query('[data-objective-short]').textContent = delta ? 'Visit four science stations' : 'Sample layered outcrop';
    query('[data-surface-layer]').textContent = delta ? 'Terrain' : 'Orbital';
    query('[data-route-key]').textContent = delta ? 'Orange: Shortest · Cyan: Intermediate · Violet: Longer' : 'Solid: selected · Dashed: alternate';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (delta) {
      const map = s1Focused ? (s1Map ??= makeDeltaOverview(original.traverse.route, canvas.width, canvas.height, approaches, true)) : deltaMap;
      map.draw(ctx, mode, approachChoice);
      const pin = query('.hab-s1');
      pin.style.left = `${map.s1[0] / canvas.width * 100}%`;
      pin.style.top = `${map.s1[1] / canvas.height * 100}%`;
      for (const button of root.querySelectorAll('[data-approach]')) {
        button.setAttribute('aria-pressed', String(button.dataset.approach === approachChoice?.id));
      }
      query('[data-layer-note]').textContent = mode === 'slope' ? slopeKey : s1Focused ? 'Approach to S1 · Simulated terrain' : 'Original loop · Three approaches to S1';
    } else {
      if (mode === 'slope') ctx.drawImage(slope, crop.x / 4, crop.y / 4, crop.span / 4, cropHeight / 4, 0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.strokeStyle = '#c1f5ff28';
      ctx.lineWidth = 1;
      for (let x = 0; x < canvas.width; x += 73) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += 73) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
      }
      ctx.restore();
      for (const { plan, path } of [...tracks.filter(track => track.plan !== selected), ...tracks.filter(track => track.plan === selected)]) {
        ctx.lineJoin = ctx.lineCap = 'round';
        ctx.setLineDash(plan === selected ? [] : [6, 8]);
        ctx.strokeStyle = '#122027';
        ctx.lineWidth = 7;
        ctx.stroke(path);
        ctx.lineWidth = plan === selected ? 4 : 3;
        ctx.strokeStyle = plan.id === 'recommended' ? '#77edff' : '#ffc373';
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = plan === selected ? 10 : 0;
        ctx.stroke(path);
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
      }
      for (const cell of [base, outcrop]) {
        ctx.beginPath(); ctx.arc(...pixel(cell), 5, 0, 2 * Math.PI);
        ctx.fillStyle = '#cbf6ff'; ctx.fill();
        ctx.beginPath(); ctx.arc(...pixel(cell), 10, 0, 2 * Math.PI);
        ctx.strokeStyle = '#9eeaff'; ctx.lineWidth = 2; ctx.stroke();
      }
      query('[data-layer-note]').textContent = mode === 'slope'
        ? `${slopeKey} · derived from 4 m DEM`
        : `Orbital imagery · ${crop.span} m across`;
    }
    draw3D(delta);
    for (const button of root.querySelectorAll('[data-plan], [data-layer]')) {
      button.setAttribute('aria-pressed', String(button.dataset.plan === selected?.id || button.dataset.layer === mode));
    }
    query('[data-route-name]').textContent = delta ? 'Delta Front loop' : routeName(selected.id);
    query('[data-distance]').textContent = delta ? `${(selected.distanceM / 1000).toFixed(2)} km` : `${fmt(selected.distanceM)} m`;
    query('[data-slope]').textContent = selected ? `${selected.surfaceSlope.toFixed(1)}°` : '—';
    query('[data-launch]').disabled = !selected || (delta && (!s1Focused || !approachChoice));
    query('[data-launch]').hidden = delta && !s1Focused;
    query('[data-status]').textContent = delta ? (s1Focused && !approachChoice ? 'Choose an approach to unlock the airlock.' : '') : 'Oxygen and weather are simulated.';
    query('[data-reason]').textContent = delta ? '' :
      `${selected.id === 'recommended' ? 'Avoids steeper mapped ground.' : 'Covers less ground and crosses steeper slopes.'} Estimated O₂ after return: ${oxygen(selected.returnOxygen)}.`;
  }

  // ---------------------------------------------------------------- 3D map
  function ensureMap3D() {
    if (map3d || map3dLoading || !view3d) return;
    query('[data-map3d-status]').hidden = false;
    map3dLoading = mountConsoleMap3D(query('[data-map3d]'))
      .then((m) => { map3d = m; query('[data-map3d-status]').hidden = true; update(); })
      .catch((error) => { console.error(error); view3d = false; query('[data-map3d-status]').hidden = true; update(); });
  }
  function draw3D(delta) {
    const frame = query('.hab-mapframe');
    frame.classList.toggle('is-3d', view3d);
    query('[data-map3d]').hidden = !view3d;
    for (const b of root.querySelectorAll('[data-view3d]')) b.setAttribute('aria-pressed', String((b.dataset.view3d === '3d') === view3d));
    query('[data-spin]').hidden = !view3d;
    if (!view3d || !map3d) return;
    query('[data-spin]').setAttribute('aria-pressed', String(map3d.spinning));
    const lines = [];
    const markers = [];
    if (delta) {
      const route = original.traverse.route;
      if (!s1Focused) {
        const loop = [];
        for (let i = 0; i < route.count; i += 3) loop.push([route.x[i], route.z[i]]);
        lines.push({ points: loop, color: '#9fe7ff', width: 5 });
      }
      for (const option of approaches) {
        const pts = [];
        for (let i = 0; i <= 50; i++) { const p = option.traverse.route.sample(option.s1 * i / 50); pts.push([p.x, p.z]); }
        const on = approachChoice?.id === option.id;
        lines.push({ points: pts, color: option.color, width: on ? 6 : 3, dashed: !on && !!approachChoice });
      }
      route.stations.forEach((st, i) => markers.push({ at: [st.x, st.z], text: st.final ? 'HAB' : `S${i + 1}`, color: st.final ? '#ffffff' : '#9fe7ff' }));
    } else {
      for (const plan of plans) {
        const on = plan === selected;
        lines.push({ points: plan.path.map((cell) => gridPosition(cell)), color: plan.id === 'recommended' ? '#77edff' : '#ffc373', width: on ? 6 : 3, dashed: !on });
      }
      markers.push({ at: gridPosition(base), text: 'HAB', color: '#ffffff' });
      markers.push({ at: gridPosition(outcrop), text: 'S1 · Layered outcrop', color: '#9fe7ff' });
    }
    map3d.draw({ lines, markers });
  }

  const stage = query('.hab-stage');
  const wall = query('.hab-wall');
  const intro = query('[data-intro]');
  const enter = query('[data-intro-enter]');
  const airlock = query('[data-airlock]');
  const motionReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const room = mountHabitatRoom(query('[data-room]'), (bounds) => {
    for (const [key, value] of Object.entries(bounds)) stage.style.setProperty(`--screen-${key}`, `${value}%`);
  });
  stage.classList.toggle('hab-has-room', Boolean(room));
  // Outside first: the habitat at dusk. Entering flies to the lit window, cuts
  // inside through a warm flash, then pushes into the console screen.
  const exterior = mountHabitatExterior(query('[data-exterior]'));
  const cut = query('[data-cut]');
  let entering = false;
  const enterHabitat = async () => {
    if (entering) return;
    entering = true;
    enter.disabled = true;
    const still = motionReduced();
    if (!still) {
      query('.hab-intro-card').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-28px)' }],
        { duration: 260, easing: 'ease-in', fill: 'forwards' });
      query('.hab-intro-shade').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: 'ease-out', fill: 'forwards' });
      await exterior?.flyIn(1400);
      await cut.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-in', fill: 'forwards' }).finished;
    }
    intro.hidden = true;
    exterior?.dispose();
    stage.inert = false;
    stage.classList.remove('hab-before-entry');
    if (!still) {
      cut.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'ease-out', fill: 'forwards' });
      // lean in from the back of the room to the console monitor
      await new Promise((resolve) => {
        const t0 = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - t0) / 900);
          room?.setDolly(1 - (1 - t) ** 3);
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    } else room?.setDolly(1);
    ensureMap3D();
  };
  const brief = query('.hab-brief');
  const screenOpen = query('[data-screen-open]');
  const reviewOpen = query('[data-review-open]');
  const reviewClose = query('[data-review-close]');
  let zoomed = false;
  let zoomAnimation;
  function setZoom(open, trigger = reviewOpen) {
    if (zoomed === open || launching) return;
    zoomAnimation?.cancel();
    const before = wall.getBoundingClientRect();
    const scroll = root.scrollTop;
    zoomed = open;
    if (open) lastZoomTrigger = trigger;
    root.classList.toggle('hab-zoomed', open);
    brief.inert = !open;
    screenOpen.hidden = reviewOpen.hidden = open;
    reviewClose.hidden = !open;
    root.scrollTop = open ? 0 : scrollBeforeZoom;
    if (open) scrollBeforeZoom = scroll;
    const after = wall.getBoundingClientRect();
    if (!motionReduced()) {
      zoomAnimation = wall.animate([
        { transformOrigin: '0 0', transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
        { transformOrigin: '0 0', transform: 'none' },
      ], { duration: 340, easing: 'cubic-bezier(.22,.75,.18,1)' });
    }
    (open ? reviewClose : lastZoomTrigger).focus({ preventScroll: true });
  }
  let lastZoomTrigger = reviewOpen;
  let scrollBeforeZoom = 0;
  const observation = query('[data-photo-dialog]');
  let launching = false;
  window.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    if (event.key.toLowerCase() === 'e' && !event.repeat && !event.altKey && !event.ctrlKey &&
        !event.metaKey && intro.hidden && !root.classList.contains('hidden') && !zoomed) {
      event.preventDefault();
      setZoom(true);
    }
    if (event.key === 'Escape' && !root.classList.contains('hidden') && zoomed && !event.defaultPrevented) setZoom(false);
  });
  query('[data-site-select]').addEventListener('change', event => {
    selected = event.target.value === 'delta' ? original : galeSelection;
    mode = 'orbital';
    update();
  });
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || launching) return;
    if (button === enter) enterHabitat();
    if (button === reviewOpen || button === screenOpen) setZoom(true, button);
    if (button === reviewClose) setZoom(false);
    if (button.hasAttribute('data-s1') || button.hasAttribute('data-s1-back')) {
      const focus = button.hasAttribute('data-s1');
      if (!zoomed) setZoom(true, screenOpen);
      if (s1Focused !== focus) {
        s1Focused = focus;
        update();
        if (!motionReduced()) query('.hab-mapframe').animate([
          { opacity: .4, transform: focus ? 'scale(.93)' : 'scale(1.03)' },
          { opacity: 1, transform: 'none' },
        ], { duration: 310, easing: 'ease-out' });
        query(focus ? '[data-approach]' : '[data-s1-overview] button').focus({ preventScroll: true });
      }
    }
    if (button.dataset.approach) approachChoice = approaches.find(option => option.id === button.dataset.approach);
    if (button.dataset.layer) {
      mode = button.dataset.layer;
      if (mode === 'slope') view3d = false; // the slope layer is a 2D map
    }
    if (button.dataset.view3d) {
      view3d = button.dataset.view3d === '3d';
      if (view3d) { mode = 'orbital'; ensureMap3D(); }
    }
    if (button.hasAttribute('data-spin') && map3d) map3d.setSpin(!map3d.spinning);
    if (button.dataset.plan) selected = galeSelection = plans.find(plan => plan.id === button.dataset.plan);
    if (button.hasAttribute('data-observation')) observation.showModal();
    if (button.hasAttribute('data-photo-close')) observation.close();
    if (button.hasAttribute('data-launch') && selected && !button.disabled) {
      launching = true;
      button.textContent = 'Opening airlock…';
      stage.inert = true;
      airlock.hidden = false;
      root.scrollTop = 0;
      query('.hab-airlock-status').focus({ preventScroll: true });
      const progress = query('[data-airlock-progress]');
      const cycle = motionReduced() ? Promise.resolve() : airlock.animate(
        [{ opacity: .15 }, { opacity: 1 }], { duration: 570, easing: 'ease-out' }).finished;
      for (const control of root.querySelectorAll('button, select')) control.disabled = true;
      try {
        await cycle;
        await launch(selected === original ? approachChoice : selected, selected === original ? 'clear' : query('[data-scenario]').value, message => { progress.textContent = message; });
        if (!motionReduced()) document.getElementById('viewport').animate(
          [{ opacity: 0 }, { opacity: 1 }], { duration: 370, easing: 'ease-out' });
        room?.dispose();
      } catch (error) {
        console.error(error);
        launching = false;
        airlock.hidden = true;
        stage.inert = false;
        reviewClose.disabled = false;
        query('[data-status]').textContent = 'The 3D simulation could not start. Reload to retry.';
      }
      return;
    }
    update();
  });
  reviewClose.hidden = true;
  update();
}
