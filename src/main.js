import * as THREE from 'three';
import { ICON } from './map/icons.ts';
import './ui/weatherControl.css';
import { Terrain, featureMasks, sampleContext } from './world/terrain.js';
import { Route, RouteVisuals } from './world/route.js';
import { ROVER } from './config/mission.js';
import { createRocks, createHabitat } from './world/scenery.js';
import { createSky, createEnvironment, DustMotes, WheelDust, SUN_DIR, HORIZON } from './world/atmosphere.js';
import { Rover } from './rover/rover.js';
import { drawNav, drawTraverse, drawScience, drawLife } from './rover/screens.js';
import { LAYERS, layerById } from './data/layers.js';
import { Mission } from './sim/mission.js';
import { Input } from './sim/input.js';
import { RoverAudio } from './sim/audio.js';
import { MapRenderer, bearingTo } from './ui/mapRenderer.js';
import { Hud } from './ui/hud.js';
import { PlanningBoard } from './ui/planningBoard.js';
import { mountHabitat } from './ui/habitat.js';
import { heightGrid, missionHeight, outcrop, worldPosition, sampleMinutes, imagery, observationSource } from './data/galeSite.js';
import { clamp, damp, DEG, formatDist } from './core/math.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const planningBoard = new PlanningBoard();
document.getElementById('boardBtn').addEventListener('click', () => planningBoard.toggle(true));
const weatherButtons = document.querySelectorAll('[data-open-weather]');
for (const button of weatherButtons) {
  button.querySelector('.weather-symbol').innerHTML = ICON.wind;
  button.addEventListener('click', () => planningBoard.toggle(true, 'map'));
}

mountHabitat(document.getElementById('habitat'), initSurface);

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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewport.appendChild(renderer.domElement);

  const input = new Input(viewport);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(HORIZON.clone(), 0.00042);
  const env = createEnvironment(renderer);
  scene.environment = env;
  scene.environmentIntensity = 0.55;

  const hemi = new THREE.HemisphereLight(0xe0b48c, 0x5a3020, 0.75);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -32; sc.right = 32; sc.top = 32; sc.bottom = -32; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0003;
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
  const wheelDust = new WheelDust();
  scene.add(wheelDust.points);

  const map = new MapRenderer(terrain, route);
  const mission = new Mission(route, terrain, hab.userData.antennaTop, {
    variableWeather: scenario === 'variable',
    frontSeconds: scenario === 'variable' ? plan.frontSeconds : 0,
  });
  const audio = new RoverAudio();
  const hud = new Hud({ route, mission, mapRenderer: map, layers: LAYERS, input });
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
    mission.s = 0;
    mission.lateral = 0;
    mission.yawOff = 0;
    mission.speed = 0;
    mission.cruise = false;
    mission.state = 'drive';
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
    if (type === 'state' && p.state === 'complete') setTimeout(() => hud.showDebrief(() => location.reload()), 1400);
    // finished a station with more ahead: the wrist navigator opens on the leg check
    if (type === 'state' && p.state === 'legcheck') planningBoard.toggle(true);
  });

  // ---------------------------------------------------------------- resize
  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 88 : 72;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------- state
  const p = {};
  const view = { x: 0, z: 0, pitch: 0, roll: 0, headingDeg: 0, elev: 0, camera };
  const look = { yaw: 0, pitch: 0 };
  const contacts = [];
  const camWorld = new THREE.Vector3();
  const ctx = { m: {} };
  let screenTimer = 0;
  let lightsOn = false;
  let roughness = 0;
  let lastPitch = 0;
  let time = 0;
  const timer = new THREE.Timer();
  timer.connect(document);

  console.info(`[ISG] world ready in ${Math.round(performance.now() - T0)} ms · rocks ${rocks.userData.count}`);
  document.getElementById('habitat').classList.add('hidden');
  audio.start();
  hud.showHud();
  document.getElementById('boardBtn').focus({ preventScroll: true });
  mission.start();
  if (plan.departureWaitSeconds > 0) mission.waitForWeather();
  input.resetLook();
  input.keys.clear();
  input.pressed.clear();
  const fieldAlert = document.getElementById('fieldAlert');
  const dustAt = route.length * 0.29;
  let lastWeather, lastFront;

  // debug / automated testing hook: advance the simulation with a fixed step
  const simulate = (seconds, o = {}) => {
    const fake = { throttle: o.throttle ?? true, brake: false, steer: o.steer ?? 0, action: o.action ?? false, boost: o.boost ?? false };
    for (let t = 0; t < seconds; t += 1 / 30) mission.update(1 / 30, fake, view.pitch);
    return { s: +mission.s.toFixed(1), v: +mission.speed.toFixed(2), state: mission.state };
  };
  window.__isg = { renderer, input, mission, route, rover, terrain, setLayer, hud, simulate, planningBoard };

  function frame() {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    time += dt;

    // ---- discrete inputs
    if (!planningBoard.open && mission.state !== 'brief') {
      for (const l of LAYERS) if (input.hit(l.key)) setLayer(l.id);
      if (input.hit('m')) hud.toggleMap();
      if (input.hit('escape')) hud.toggleMap(false);
      if (input.hit('h')) hud.toggleHidden();
      if (input.hit('v')) input.resetLook();
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
        if (mission.state === 'legcheck') planningBoard.toggle(true);
        else mission.acknowledge();
      }
    }

    // ---- simulation
    if (!planningBoard.open) mission.update(dt, input, view.pitch);
    if (route.retracesOutbound && scenario === 'dust' && !mission.aborted && !mission.dustWarning &&
        mission.state === 'drive' && mission.s >= dustAt && mission.s < route.length / 2) {
      mission.dustWarning = true;
      mission.speed = 0;
      mission.cruise = false;
      hud.log('Simulated dust front ahead. Open wrist navigation [P].', 'danger');
      planningBoard.toggle(true);
    }
    const weather = mission.weather;
    scene.fog.density = weather.fogDensity;
    if (planningBoard.open) planningBoard.updateField();
    const frontAhead = mission.activeFront && mission.s < mission.activeFront.to;
    if (weather !== lastWeather || frontAhead !== lastFront || mission.state === 'complete') {
      if (weather !== lastWeather || frontAhead !== lastFront) {
        const dustAhead = frontAhead && weather.label === 'Clear';
        const tone = weather.limitsVisibility || dustAhead ? 'dust' : Number.isFinite(weather.exposureMinutes) ? 'cold' : 'clear';
        for (const button of weatherButtons) button.dataset.tone = tone;
        document.getElementById('fieldWeather').textContent = dustAhead ? 'Dust ahead' : weather.label;
        lastFront = frontAhead;
      }
      let message = '';
      if (mission.state !== 'complete' && weather.label !== 'Clear') {
        message = mission.dustWarning ? 'Dust front ahead. Open your wrist navigator to return.'
          : Number.isFinite(weather.exposureMinutes) ? `Cold spell · Outside work limited to ${weather.exposureMinutes} min. Review tasks on your wrist navigator.`
          : `${weather.label} · Visibility ≈ ${formatDist(weather.visibilityM)} · Rover limit ${Math.round(weather.speedLimit * 3.6)} km/h`;
      }
      if (fieldAlert.textContent !== message) fieldAlert.textContent = message;
      lastWeather = weather;
    }

    route.sample(mission.s, p);
    const x = p.x + p.rx * mission.lateral;
    const z = p.z + p.rz * mission.lateral;
    const pathYaw = Math.atan2(-p.tx, -p.tz);
    const yaw = pathYaw - mission.yawOff;
    const att = rover.setPose(x, z, yaw, terrain, dt);
    mission.pos = { x, y: rover.root.position.y, z };

    const masks = featureMasks(x, z);
    const pitchRate = Math.abs(att.pitch - lastPitch) / Math.max(dt, 1e-3);
    lastPitch = att.pitch;
    roughness += (clamp(masks.ripple * 0.7 + masks.ejecta * 0.45 + pitchRate * 0.02, 0, 1) - roughness) * damp(4, dt);

    const station = mission.nextStation;
    const headingRad = -rover.pose.yaw;
    let copilotLook = 0;
    if (station) {
      let rel = bearingTo(x, z, station.x, station.z) - headingRad;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      copilotLook = -rel;
    }
    rover.animate(dt, {
      speed: mission.speed * (mission.boosting && mission.state === 'drive' ? ROVER.timeBoost : 1),
      throttle: mission.state === 'drive' && (input.throttle || mission.cruise) ? 1 : 0,
      brake: input.brake ? 1 : 0,
      steer: mission.state === 'drive' ? input.steer : 0,
      roughness,
      lookTarget: copilotLook,
    });

    // ---- driver's head
    if (mission.state === 'brief') {
      look.yaw = Math.sin(time * 0.18) * 0.55;
      look.pitch = -0.05 + Math.sin(time * 0.11) * 0.05;
    } else {
      look.yaw += (input.look.yaw - look.yaw) * damp(12, dt);
      look.pitch += (input.look.pitch - look.pitch) * damp(12, dt);
    }
    camera.rotation.set(-0.1 + look.pitch, look.yaw, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    camera.getWorldPosition(camWorld);

    // ---- environment follows the viewer
    sky.position.copy(camWorld);
    sun.target.position.set(x, rover.root.position.y, z);
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 150);
    motes.update(dt, camWorld);

    const simSpeed = mission.speed * (mission.boosting ? ROVER.timeBoost : 1);
    if (simSpeed > 0.25) {
      rover.wheelContacts(contacts);
      const n = simSpeed * dt * 9;
      for (const c of contacts) {
        let k = n + (Math.random() < n % 1 ? 1 : 0);
        for (let i = 0; i < Math.floor(k); i++) wheelDust.emit(c.x, c.y, c.z, p.tx * simSpeed * 0.35, p.tz * simSpeed * 0.35, simSpeed);
      }
    }
    wheelDust.update(dt, (wx, wz) => terrain.heightAt(wx, wz));

    visuals.update(time, mission.s, station ? station.id : null);
    hab.userData.beacon.visible = Math.sin(time * 2.4) > -0.2;

    // ---- view state for HUD / screens
    view.x = x;
    view.z = z;
    view.pitch = att.pitch;
    view.roll = att.roll;
    view.elev = rover.root.position.y;
    view.headingDeg = ((((headingRad - look.yaw) * DEG) % 360) + 360) % 360;
    const roverHeadingDeg = (((headingRad * DEG) % 360) + 360) % 360;

    screenTimer -= dt;
    if (screenTimer <= 0) {
      screenTimer = 0.1;
      const v2 = { ...view, headingDeg: roverHeadingDeg };
      drawNav(rover.screens.nav, map, mission, v2);
      drawTraverse(rover.screens.traverse, route, mission, view);
      sampleContext(terrain, x, z, ctx);
      drawScience(rover.screens.science, layer, layer.readout(ctx), mission);
      drawLife(rover.screens.life, mission);
    }

    if (mission.state !== 'brief') hud.update(dt, view);
    audio.update(simSpeed, roughness);
    input.endFrame();

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
