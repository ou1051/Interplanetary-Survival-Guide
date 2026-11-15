import * as THREE from 'three';
import { ICON } from './map/icons.ts';
import './ui/weatherControl.css';
import { Terrain, featureMasks, sampleContext } from './world/terrain.js';
import { Route, RouteVisuals } from './world/route.js';
import { ROVER } from './config/mission.js';
import { createRocks, createHabitat } from './world/scenery.js';
import { createSky, createEnvironment, DustMotes, SUN_DIR, HORIZON, ZENITH } from './world/atmosphere.js';
import { Rover, EYE } from './rover/rover.js';
import { createPostFX } from './world/postfx.js';
import { drawNav, drawTraverse, drawScience, drawLife } from './rover/screens.js';
import { LAYERS, layerById } from './data/layers.js';
import { Mission, WALK } from './sim/mission.js';
import { CLEAR_WEATHER, WIND_DIRECTION, windSpeedAt } from './sim/weather.js';
import { placeArtifacts, loadCollection, recordFind, saveCollection } from './sim/artifacts.js';
import { Astronaut, EYE_HEIGHT } from './world/astronaut.js';
import { ArtifactField } from './world/artifactField.js';
import { CollectionView } from './ui/collection.js';
import { Input } from './sim/input.js';
import { RoverAudio } from './sim/audio.js';
import { MapRenderer, bearingTo } from './ui/mapRenderer.js';
import { Hud } from './ui/hud.js';
import { PlanningBoard } from './ui/planningBoard.js';
import { mountHabitat } from './ui/habitat.js';
import { heightGrid, missionHeight, outcrop, worldPosition, sampleMinutes, imagery, observationSource } from './data/galeSite.js';
import { clamp, damp, smoothstep, wrapAngle, DEG, formatDist } from './core/math.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const planningBoard = new PlanningBoard();
document.getElementById('boardBtn').addEventListener('click', () => planningBoard.toggle(true));
const weatherButtons = document.querySelectorAll('[data-open-weather]');
for (const button of weatherButtons) {
  button.querySelector('.weather-symbol').innerHTML = ICON.wind;
  button.addEventListener('click', () => planningBoard.toggle(true, 'map'));
}

mountHabitat(document.getElementById('habitat'), initSurface);

// The artifact collection opens from the habitat console and during an EVA.
const collection = new CollectionView();
document.getElementById('collectionBtn')?.addEventListener('click', () => collection.show());

const sourcesDialog = document.getElementById('sourcesDialog');
document.getElementById('sourcesBtn').addEventListener('click', () => sourcesDialog.showModal());
sourcesDialog.addEventListener('click', e => { if (e.target === sourcesDialog) sourcesDialog.close(); });

async function initSurface(plan, scenario, status) {
  const T0 = performance.now();
  const viewport = document.getElementById('viewport');
  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft edges via sun.shadow.radius
  viewport.appendChild(renderer.domElement);

  const input = new Input(viewport);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(HORIZON.clone(), CLEAR_WEATHER.fogDensity);
  const dustHorizon = new THREE.Color('#c49368');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const env = createEnvironment(renderer);
  scene.environment = env;
  scene.environmentIntensity = 0.38;

  const hemi = new THREE.HemisphereLight(0xe0b48c, 0x4a2618, 0.42);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0dc, 3.3);
  const warmSun = sun.color.clone();
  const coldSun = new THREE.Color('#d5e5f6');
  const coldZenith = new THREE.Color('#777985');
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0002;
  sun.shadow.radius = 3;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);

  const sky = createSky();
  scene.add(sky);

  // ---------------------------------------------------------------- world
  status('GENERATING TERRAIN…');
  await nextFrame();
  const terrain = plan.traverse?.terrain ?? new Terrain({ height: missionHeight, inner: heightGrid });
  scene.add(terrain.group);

  status('PLANNING ROUTE…');
  await nextFrame();
  let route = plan.traverse?.route ?? new Route(terrain, { points: plan.points, exact: true, areaHazards: [], stations: [{
    id: 'S1', name: 'Layered outcrop', at: worldPosition(outcrop),
    objective: 'Use the Curiosity field reference to identify two beds and collect a sample from each.',
    why: ['Compare rock textures above and below the visible contact.'],
    observation: { image: imagery.mastcam, source: observationSource },
    tasks: [{ label: 'Collect paired samples', minutes: sampleMinutes, sampleCount: 2, result: 'Two samples bagged for comparison · simulation' }],
  }] });
  route.planName = plan.name;
  route.retracesOutbound = !plan.traverse;
  route.site = plan.site;
  let visuals = new RouteVisuals(route, terrain);
  scene.add(visuals.group);

  status('PLACING ROCKS…');
  await nextFrame();
  let rocks = createRocks(terrain, route);
  scene.add(rocks);
  const hab = createHabitat(terrain);
  scene.add(hab);

  status('ASSEMBLING ROVER…');
  await nextFrame();
  const rover = new Rover(env);
  scene.add(rover.root);
  const camera = rover.camera;

  const motes = new DustMotes();
  scene.add(motes.points);


  // ---------------------------------------------------------------- crew, finds
  // The driver as a whole figure: in the rover seat for the outside views
  // (rover.driver), walking when out of the rover. Same suit and materials as the rover crew.
  const walker = new Astronaut(rover.suitM);
  walker.root.visible = false;
  scene.add(walker.root);
  // World camera for walking and the outside views (the cockpit camera rides the rover).
  const freeCam = new THREE.PerspectiveCamera(72, 1, 0.05, 30000);
  freeCam.rotation.order = 'YXZ';
  scene.add(freeCam);
  const VIEWS = ['pov', 'chase', 'overhead'];
  const VIEW_NAMES = { pov: 'First person', chase: 'Third person', overhead: 'Overhead' };
  const zoom = { chase: { d: 7, min: 3.5, max: 16 }, overhead: { d: 24, min: 12, max: 60 } };
  let viewMode = 'pov';

  const mission = new Mission(route, terrain, hab.userData.antennaTop, {
    variableWeather: scenario === 'variable',
    frontSeconds: scenario === 'variable' ? plan.frontSeconds : 0,
  });
  const artifacts = placeArtifacts({ route, terrain, site: route.site, seed: Math.round(route.length) });
  mission.setArtifacts(artifacts);
  const field = new ArtifactField(scene, artifacts);
  const findsThisEva = [];
  const newThisEva = [];

  const map = new MapRenderer(terrain, route);
  const audio = new RoverAudio();
  const hud = new Hud({ route, mission, mapRenderer: map, layers: LAYERS, input, artifacts });
  document.querySelectorAll('#touch button').forEach((b) => input.bindButton(b, b.dataset.v));
  // keep keyboard shortcuts from re-triggering whatever button was clicked last
  document.addEventListener('click', (e) => {
    const button = e.target.closest?.('button');
    if (button && button.id !== 'boardBtn' && !button.hasAttribute('data-open-weather') && !planningBoard.el.contains(button)) button.blur();
  });

  // ---------------------------------------------------------------- layers
  let layer = null;
  const setLayer = (id) => {
    const next = layerById(id);
    if (!next || next === layer) return;
    layer = next;
    terrain.applyLayer(layer);
    map.setLayer(layer);
    hud.setLayer(layer);
  };
  status('RENDERING DATA LAYERS…');
  await nextFrame();
  setLayer('optical');
  planningBoard.connectTraverse(mission, { terrain, swapRoute });

  // A different path was picked for the leg ahead: rebuild everything drawn from the route.
  function swapRoute(next) {
    next.planName = route.planName;
    next.site = route.site;
    next.retracesOutbound = route.retracesOutbound;
    for (const old of [visuals.group, rocks]) {
      scene.remove(old);
      old.traverse((o) => { o.geometry?.dispose(); });
    }
    route = next;
    visuals = new RouteVisuals(route, terrain);
    scene.add(visuals.group);
    rocks = createRocks(terrain, route);
    scene.add(rocks);
    map.route = route;
    map._buildRoutePath();
    hud.route = route;
    document.getElementById('markers').innerHTML = '';
    hud._buildMarkers();
    mission.replaceRoute(route);
    if (window.__isg) window.__isg.route = route;
  }
  planningBoard.setDeployHandler(({ site, pathId }) => {
    const label = pathId.charAt(0).toUpperCase() + pathId.slice(1);
    route.planName = `${site.name.split('·')[0].trim()} · ${label} to S1`;
    route.site = { ...route.site, name: site.name };
    const siteEl = document.getElementById('siteName');
    if (siteEl) siteEl.textContent = site.name.toUpperCase();
    // The rover drives freely: only the plan's name and target change, the crew stays where it is.
    planningBoard.updateField();
    hud.log(`Survey target updated: ${route.planName}`, 'ok');
  });
  hud.onLayerClick((id) => {
    setLayer(id);
    hud.log(`Layer: ${layer.name} (${layer.source})`, 'info');
  });

  // ---------------------------------------------------------------- events
  mission.on((type, p) => {
    if (type === 'log') {
      hud.log(p.text, p.tone);
      audio.beep(p.tone === 'danger' ? 'danger' : p.tone === 'warn' ? 'warn' : p.tone === 'ok' ? 'ok' : 'info');
    }
    if (type === 'artifact') {
      const book = loadCollection();
      const isNew = recordFind(book, p.artifact, route.site?.name ?? 'Mars');
      saveCollection(book);
      findsThisEva.push(p.artifact);
      if (isNew) newThisEva.push(p.artifact);
      collection.announce(p.artifact, isNew);
    }
    if (type === 'state' && p.state === 'complete') {
      setTimeout(() => hud.showDebrief(() => {
        history.replaceState({ screen: 'briefing' }, '');
        location.reload();
      }, debriefSummary()), 1400);
    }
    // finished a station with more ahead: the wrist navigator opens on the leg check
    if (type === 'legcheck') planningBoard.toggle(true);
  });

  function debriefSummary() {
    const stations = mission.stations;
    const book = loadCollection();
    return {
      items: [
        ['WALKED', `${Math.round(mission.walked)} m`],
        ['ARTIFACTS', findsThisEva.length],
        ['STATIONS DONE', `${stations.filter((st) => st.done).length} / ${stations.length}`],
        ['COLLECTION', `${Object.keys(book.items).length} found`],
      ],
      note: findsThisEva.length
        ? `Collected ${findsThisEva.map((a) => a.name).join(', ')}.${newThisEva.length ? ` ${newThisEva.length} new to your collection.` : ''}`
        : 'No artifacts collected this EVA. Get out of the rover at a station to find some.',
      extra: { label: 'View collection', onClick: () => collection.show() },
    };
  }

  // ---------------------------------------------------------------- crew actions
  const crewBtn = document.getElementById('crewBtn');
  const viewBtn = document.getElementById('viewBtn');
  const collectBtn = document.getElementById('collectBtn');
  const endBtn = document.getElementById('endBtn');
  const lookChip = document.getElementById('lookChip');
  let collectHeld = false;

  function crewAction() {
    if (mission.state === 'drive') {
      if (!mission.canExit) { hud.log('Stop the rover before getting out', 'warn'); return; }
      // Keep facing the same way: the rover-relative look becomes a world heading.
      const worldYaw = rover.pose.yaw + look.yaw;
      if (mission.exitRover()) {
        input.look.yaw = look.yaw = worldYaw;
        input.look.pitch = look.pitch = clamp(look.pitch, -0.6, 0.6);
      }
    } else if (mission.state === 'walk') {
      if (!mission.canBoard) { hud.log(`Walk to the rover to board (${Math.round(Math.hypot(mission.walker.x - mission.rover.x, mission.walker.z - mission.rover.z))} m)`, 'warn'); return; }
      if (mission.boardRover()) {
        input.look.yaw = look.yaw = 0;
        input.look.pitch = look.pitch = 0;
      }
    }
  }
  function cycleView() {
    viewMode = VIEWS[(VIEWS.indexOf(viewMode) + 1) % VIEWS.length];
    // Outside views start behind the crew; first person faces forward.
    if (mission.state === 'drive') input.look.yaw = Math.round(input.look.yaw / (Math.PI * 2)) * Math.PI * 2;
    input.look.pitch = 0;
    hud.log(`View: ${VIEW_NAMES[viewMode]}`, 'info');
  }
  // Mouse clicks on these buttons leave keyboard focus on the 3D view (Enter, Space, E stay game keys).
  document.getElementById('evaActions').addEventListener('mousedown', (e) => e.preventDefault());
  crewBtn.addEventListener('click', crewAction);
  viewBtn.addEventListener('click', cycleView);
  endBtn.addEventListener('click', () => mission.endEva());
  document.getElementById('collectionHudBtn').addEventListener('click', () => collection.show());
  collectBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); collectHeld = true; });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) collectBtn.addEventListener(type, () => { collectHeld = false; });

  // Uncollected artifact within reach of the walker, nearest first.
  function artifactInReach() {
    if (mission.state !== 'walk') return null;
    let best = null, bd = WALK.reach;
    for (const a of artifacts) {
      if (a.collected) continue;
      const d = Math.hypot(a.x - mission.walker.x, a.z - mission.walker.z);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  // ---------------------------------------------------------------- post-processing (AO + bloom)
  const postfx = createPostFX(renderer, scene, camera);
  if (import.meta.env.DEV) window.__postfx = postfx; // console tuning: __postfx.ao.setDisplayMode('AO')

  // ---------------------------------------------------------------- resize
  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    postfx.setSize(w, h);
    for (const cam of [camera, freeCam]) {
      cam.aspect = w / h;
      cam.fov = w / h < 1 ? 88 : 72;
      cam.updateProjectionMatrix();
    }
  };
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------- state
  const view = { x: 0, z: 0, pitch: 0, roll: 0, headingDeg: 0, elev: 0, camera };
  const look = { yaw: 0, pitch: 0 };
  const camWorld = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const target = new THREE.Vector3();
  const ctx = { m: {} };
  let screenTimer = 0;
  let lightsOn = false;
  let roughness = 0;
  let lastPitch = 0;
  let time = 0;
  const timer = new THREE.Timer();
  timer.connect(document);

  console.info(`[ISG] world ready in ${Math.round(performance.now() - T0)} ms · rocks ${rocks.userData.count} · artifacts ${artifacts.length}`);
  document.getElementById('habitat').classList.add('hidden');
  audio.start();
  hud.showHud();
  // Keep keyboard focus on the 3D view: a focused button would also react to Enter or Space.
  // Dialogs hand focus back to whatever opened them, so take it back when they close.
  viewport.tabIndex = -1;
  viewport.focus({ preventScroll: true });
  for (const dialog of [collection.el, planningBoard.el]) {
    dialog.addEventListener('close', () => viewport.focus({ preventScroll: true }));
  }
  mission.start();
  if (plan.departureWaitSeconds > 0) mission.waitForWeather();
  input.resetLook();
  input.keys.clear();
  input.pressed.clear();
  const fieldAlert = document.getElementById('fieldAlert');
  const fieldWeatherEffect = document.getElementById('fieldWeatherEffect');
  const windBearing = Math.atan2(WIND_DIRECTION.x, -WIND_DIRECTION.z);
  const windCues = ['Tailwind ↑', 'Wind ↗', 'Crosswind →', 'Wind ↘', 'Headwind ↓', 'Wind ↙', 'Crosswind ←', 'Wind ↖'];
  const dustAt = route.length * 0.29;
  let lastWeather;

  // debug / automated testing hook: advance the simulation with a fixed step.
  // Driving follows the planned route ahead (autopilot); walking stands still.
  const simulate = (seconds, o = {}) => {
    for (let t = 0; t < seconds; t += 1 / 30) {
      const drive = mission.state === 'drive' ? mission.autopilot({ throttle: o.throttle ?? true, boost: o.boost ?? false }) : {};
      mission.update(1 / 30, drive, view.pitch);
    }
    return { s: +mission.s.toFixed(1), v: +mission.speed.toFixed(2), state: mission.state };
  };
  window.__isg = {
    renderer, input, mission, route, rover, terrain, setLayer, hud, simulate, artifacts, collection, planningBoard,
    crewAction, cycleView, get viewMode() { return viewMode; },
  };

  function frame() {
    timer.update();
    const elapsed = timer.getDelta();
    const dt = Math.min(elapsed, 0.05);
    time += dt;
    let paused = planningBoard.open || collection.open || sourcesDialog.open;

    // ---- discrete inputs
    if (!paused && mission.state !== 'brief') {
      for (const l of LAYERS) if (input.hit(l.key)) setLayer(l.id);
      if (input.hit('m')) hud.toggleMap();
      if (input.hit('escape')) hud.toggleMap(false);
      if (input.hit('h')) hud.toggleHidden();
      if (input.hit('v')) input.resetLook();
      if (input.hit('b')) input.lookBack();
      if (input.hit('t')) cycleView();
      if (input.hit('f')) crewAction();
      if (input.hit('i')) collection.show();
      if (input.hit('n')) hud.log(audio.toggleMute() ? 'Audio muted' : 'Audio on', 'info');
      if (input.hit('l')) {
        lightsOn = !lightsOn;
        rover.setHeadlights(lightsOn);
        hud.log(`Headlights ${lightsOn ? 'ON' : 'OFF'}`, 'info');
      }
      if (input.hit('c') && mission.state === 'drive') {
        mission.cruise = !mission.cruise;
        hud.log(`Cruise ${mission.cruise ? 'ON' : 'OFF'}`, 'info');
      }
      if (input.hit('enter')) {
        if (mission.state === 'gate') mission.acknowledge();
        else if (mission.atHome) mission.endEva();
        else if (mission.legPending) planningBoard.toggle(true);
      }
      // dev only: K ends the EVA wherever you are and shows the debrief (npm run dev; stripped from builds)
      if (import.meta.env.DEV && input.hit('k') && ['drive', 'walk', 'gate'].includes(mission.state)) {
        mission.legPending = null;
        mission.rover.speed = mission.speed = 0;
        mission.state = 'complete';
        mission.emit('log', { text: 'DEV: EVA ended early (K).', tone: 'info' });
        mission.emit('state', { state: 'complete' });
      }
    }

    // ---- simulation
    paused = planningBoard.open || collection.open || sourcesDialog.open;
    const onFoot = mission.state === 'walk';
    if (!paused) {
      if (onFoot) {
        const k = input;
        mission.update(dt, {
          forward: (k.down('w', 'arrowup') || k.virtual.throttle ? 1 : 0) - (k.down('s', 'arrowdown') || k.virtual.brake ? 1 : 0),
          strafe: (k.down('d', 'arrowright') || k.virtual.right ? 1 : 0) - (k.down('a', 'arrowleft') || k.virtual.left ? 1 : 0),
          run: k.down('shift'),
          viewYaw: look.yaw,
        }, view.pitch);
      } else mission.update(dt, input, view.pitch);
    }
    if (route.retracesOutbound && scenario === 'dust' && !mission.aborted && !mission.dustWarning &&
        mission.state === 'drive' && mission.s >= dustAt && mission.s < route.length / 2) {
      mission.dustWarning = true;
      mission.rover.speed = mission.speed = 0;
      mission.cruise = false;
      hud.log('Dust front · rover stopped. Open the wrist navigator [P] to return.', 'danger');
    }
    const weather = mission.weather;
    const windSpeed = windSpeedAt(weather, mission.met);
    const cold = Number.isFinite(weather.exposureMinutes);
    scene.fog.density += (weather.fogDensity - scene.fog.density) * damp(3, elapsed);
    // Use the contrast lost across 45 m of terrain to soften the sunlight and fill the sky with dust.
    const dust = 1 - Math.exp(-((45 * (scene.fog.density - CLEAR_WEATHER.fogDensity)) ** 2));
    scene.fog.color.copy(HORIZON).lerp(dustHorizon, dust);
    sky.material.uniforms.uHorizon.value.copy(scene.fog.color);
    sky.material.uniforms.uDust.value = dust;
    sun.intensity = 3.3 * (1 - 0.8 * dust);
    hemi.intensity = 0.42 + 0.6 * dust; // dust scatters light into the shadows
    if (planningBoard.open) planningBoard.updateField();
    if (weather !== lastWeather || mission.state === 'complete') {
      if (weather !== lastWeather) {
        sun.color.copy(cold ? coldSun : warmSun);
        sky.material.uniforms.uZenith.value.copy(cold ? coldZenith : ZENITH);
        const tone = weather.limitsVisibility ? 'dust' : cold ? 'cold' : 'clear';
        for (const button of weatherButtons) button.dataset.tone = tone;
        document.getElementById('fieldWeather').textContent = weather.label;
      }
      let message = '';
      if (mission.state !== 'complete' && weather.label !== 'Clear') {
        message = mission.dustWarning ? `Dust front · Visibility ≈ ${formatDist(weather.visibilityM)} · Rover stopped. Open Wrist navigator [P] to return.`
          : cold ? `Cold spell · Outside work limited to ${weather.exposureMinutes} min. Review tasks on your wrist navigator.`
          : `${weather.label} · Visibility ≈ ${formatDist(weather.visibilityM)} · Rover limit ${Math.round(weather.speedLimit * 3.6)} km/h`;
      }
      if (fieldAlert.textContent !== message) fieldAlert.textContent = message;
      lastWeather = weather;
    }

    // ---- station instruments and physical finds share truthful hold progress.
    const reach = artifactInReach();
    hud.updateHold(elapsed, { held: input.down('e') || collectHeld || input.virtual.action, reach, paused });
    const collecting = hud.hold;
    walker.setReach(collecting.target === reach && collecting.t ? Math.min(1, collecting.t * 3) : 0);

    // ---- rover pose (free driving)
    const R = mission.rover;
    const att = rover.setPose(R.x, R.z, R.heading, terrain, dt);
    const masks = featureMasks(R.x, R.z);
    const pitchRate = Math.abs(att.pitch - lastPitch) / Math.max(dt, 1e-3);
    lastPitch = att.pitch;
    roughness += (clamp(masks.ripple * 0.7 + masks.ejecta * 0.45 + pitchRate * 0.02, 0, 1) - roughness) * damp(4, dt);

    const station = mission.nextStation;
    const headingRad = -rover.pose.yaw;
    let copilotLook = 0;
    if (station) copilotLook = -wrapAngle(bearingTo(R.x, R.z, station.x, station.z) - headingRad);
    const driving = mission.state === 'drive';
    const roverSpeed = R.speed * (mission.boosting && driving ? ROVER.timeBoost : 1);
    rover.animate(dt, {
      speed: roverSpeed,
      throttle: driving && (input.throttle || mission.cruise) ? 1 : 0,
      brake: driving && input.brake ? 1 : 0,
      steer: driving ? R.steer / 0.5 : 0,
      roughness,
      lookTarget: copilotLook,
    });

    // ---- head / camera
    if (mission.state === 'brief') {
      look.yaw = Math.sin(time * 0.18) * 0.55;
      look.pitch = -0.05 + Math.sin(time * 0.11) * 0.05;
    } else {
      if (!paused) {
        const turn = (input.down('z') ? 1 : 0) - (input.down('x') ? 1 : 0);
        if (turn) input.turnHead(turn * 2.4 * dt);
        if (input.zoom && viewMode !== 'pov') {
          const z = zoom[viewMode];
          z.d = clamp(z.d * (1 + input.zoom * 0.12), z.min, z.max);
        }
      }
      input.zoom = 0;
      look.yaw += (input.look.yaw - look.yaw) * damp(12, dt);
      look.pitch += (input.look.pitch - look.pitch) * damp(12, dt);
    }
    // Who is shown: the cockpit legs in first person, the whole figure outside.
    const outside = viewMode !== 'pov';
    const inRover = !onFoot; // driving, or the EVA has ended with the crew aboard
    const frost = cold && !outside && mission.state !== 'complete' ? (onFoot ? 'visor' : 'windshield') : '';
    if (viewport.dataset.frost !== frost) viewport.dataset.frost = frost;
    let effect = '';
    if (cold) {
      const secondsLeft = Math.max(0, Math.ceil((weather.exposureMinutes - mission.outsideMinutes) * 60));
      effect = `EVA left ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
    } else if (windSpeed > 0) {
      // Wind direction is relative to the vehicle's nose, or the astronaut's heading on foot.
      const relative = wrapAngle(windBearing + (onFoot ? mission.walker.yaw : R.heading));
      const arrow = windCues[(8 + Math.round(relative / (Math.PI / 4))) % 8];
      effect = `${arrow} · ${Math.round(windSpeed)} m/s`;
    }
    if (fieldWeatherEffect.textContent !== effect) {
      fieldWeatherEffect.textContent = effect;
      fieldWeatherEffect.hidden = !effect;
    }
    rover.driverLegs.visible = inRover && !outside;
    rover.driver.visible = inRover && outside;
    walker.root.visible = onFoot && outside;
    const W = mission.walker;
    const groundW = terrain.heightAt(W.x, W.z);
    if (onFoot) {
      walker.root.position.set(W.x, groundW, W.z);
      if (W.speed > 0.15) walker.root.rotation.y += wrapAngle(Math.atan2(-W.vx, -W.vz) - walker.root.rotation.y) * damp(10, dt);
      walker.setWalk(W.speed, dt);
    }

    let activeCam = camera;
    let lean = 0;
    if (inRover && !outside) {
      const relYaw = wrapAngle(look.yaw);
      lean = smoothstep(0.9, 2.5, Math.abs(relYaw));
      rover.cameraMount.position.set(EYE.x - Math.sign(relYaw) * 0.14 * lean, EYE.y + 0.07 * lean, EYE.z - 0.06 * lean);
      camera.rotation.set(-0.1 + look.pitch, look.yaw, 0, 'YXZ');
    } else {
      activeCam = freeCam;
      if (onFoot && !outside) {
        const bob = Math.sin(walker.phase * 2) * 0.03 * Math.min(1, W.speed);
        freeCam.position.set(W.x, groundW + EYE_HEIGHT + bob, W.z);
        freeCam.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
      } else {
        // Orbit behind the crew: drag to circle, wheel to zoom. Overhead looks down from high above.
        const base = inRover ? rover.root.position : walker.root.position;
        target.set(base.x, base.y + (inRover ? 1.4 : 1.3), base.z);
        const yaw = (inRover ? rover.pose.yaw : 0) + look.yaw;
        const elev = viewMode === 'overhead' ? clamp(1.05 + look.pitch * 0.5, 0.55, 1.5) : clamp(0.32 + look.pitch * 0.7, 0.04, 1.35);
        const d = zoom[viewMode].d;
        freeCam.position.set(target.x + Math.sin(yaw) * Math.cos(elev) * d, target.y + Math.sin(elev) * d, target.z + Math.cos(yaw) * Math.cos(elev) * d);
        freeCam.position.y = Math.max(freeCam.position.y, terrain.heightAt(freeCam.position.x, freeCam.position.z) + 0.8);
        freeCam.lookAt(target);
      }
    }
    activeCam.updateMatrixWorld(true);
    activeCam.getWorldPosition(camWorld);
    activeCam.getWorldDirection(camDir);
    lookChip.classList.toggle('hidden', !(inRover && !outside && lean > 0.25));

    // ---- environment follows the viewer
    const focus = onFoot ? { x: W.x, y: groundW, z: W.z } : { x: R.x, y: rover.root.position.y, z: R.z };
    sky.position.copy(camWorld);
    sun.target.position.set(focus.x, focus.y, focus.z);
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 150);
    motes.update(reducedMotion.matches || paused ? 0 : dt, camWorld, dust, windSpeed);

    const simSpeed = Math.abs(roverSpeed);

    visuals.update(time, mission.s, station ? station.id : null);
    field.update(dt, time, reach, camWorld);
    hab.userData.beacon.visible = Math.sin(time * 2.4) > -0.2;

    // ---- view state for HUD / screens
    view.x = focus.x;
    view.z = focus.z;
    view.pitch = att.pitch;
    view.roll = att.roll;
    view.elev = focus.y;
    view.camera = activeCam;
    view.headingDeg = (((Math.atan2(camDir.x, -camDir.z) * DEG) % 360) + 360) % 360;
    const roverHeadingDeg = (((headingRad * DEG) % 360) + 360) % 360;

    screenTimer -= dt;
    if (screenTimer <= 0) {
      screenTimer = 0.1;
      const v2 = { ...view, x: R.x, z: R.z, headingDeg: roverHeadingDeg };
      drawNav(rover.screens.nav, map, mission, v2);
      drawTraverse(rover.screens.traverse, route, mission, view);
      sampleContext(terrain, R.x, R.z, ctx);
      drawScience(rover.screens.science, layer, layer.readout(ctx), mission);
      drawLife(rover.screens.life, mission);
    }

    // ---- crew action buttons
    const setButton = (el, show, text) => {
      if (el.hidden === show) el.hidden = !show;
      if (text !== undefined && el.textContent !== text) el.textContent = text;
    };
    setButton(crewBtn, driving || onFoot, driving ? 'Get out [F]' : mission.canBoard ? 'Board rover [F]' : 'Walk to the rover to board');
    crewBtn.disabled = driving ? !mission.canExit : !mission.canBoard;
    setButton(viewBtn, true, `View · ${VIEW_NAMES[viewMode]} [T]`);
    setButton(collectBtn, Boolean(reach), reach ? collecting.target === reach && collecting.reason ? `Unavailable · ${collecting.reason}` : `Hold to collect ${reach.name} [E]` : '');
    setButton(endBtn, mission.atHome && (driving || onFoot));
    hud.context = { reach, collecting: collecting.target === reach || collecting.target?.artifact === reach ? collecting.t / 0.9 : 0, view: viewMode };

    if (mission.state !== 'brief') hud.update(dt, view);
    audio.update(driving ? simSpeed : 0, roughness);
    input.endFrame();

    postfx.render(dt, activeCam);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
