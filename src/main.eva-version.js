console.log('MAIN MARKER 2026-11-15');
import * as THREE from 'three';
import { Terrain, featureMasks, sampleContext, setDEM, hasRealDEM } from './world/terrain.js';
import { loadDEM } from './data/dem.js';
import { autoRoute } from './world/autoroute.js';
import { Route, RouteVisuals } from './world/route.js';
import * as scenery from './world/scenery.js';
import { createSky, createEnvironment, DustMotes, WheelDust, SUN_DIR, HORIZON } from './world/atmosphere.js';
import { Weather } from './world/weather.js';
import { Rover } from './rover/rover.js';
import { drawNav, drawTraverse, drawScience, drawLife } from './rover/screens.js';
import { LAYERS, layerById, loadLayerRasters } from './data/layers.js';
import { Mission } from './sim/mission.js';
import { Input } from './sim/input.js';
import { RoverAudio } from './sim/audio.js';
import { MapRenderer, bearingTo } from './ui/mapRenderer.js';
import { Hud } from './ui/hud.js';
import { clamp, damp, DEG } from './core/math.js';
import { HelmetVisor } from './ui/helmet.js';
import { RouteSites, placeAlongRoute } from './world/sites.js';
import { EvaWalk, IDLE_INPUT } from './world/eva.js';

const { createRocks, createHabitat } = scenery;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const fmtHM = (s) =>
  `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;

async function init() {
  const T0 = performance.now();
  const viewport = document.getElementById('viewport');
  const beginBtn = document.getElementById('beginBtn');
  const status = (t) => (beginBtn.textContent = t);

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  viewport.appendChild(renderer.domElement);

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
  status('LOADING MARS DEM…');
  await nextFrame();
  let dem = null;
  try {
    dem = await loadDEM();
    setDEM(dem);
  } catch (e) {
    console.warn('[ISG] no DEM found, using procedural terrain', e);
  }

  status('GENERATING TERRAIN…');
  await nextFrame();
  const terrain = new Terrain();
  scene.add(terrain.group);
  console.info(`[ISG] terrain: ${hasRealDEM() ? 'REAL DEM' : 'procedural placeholder'}`);

  if (hasRealDEM() && new URLSearchParams(location.search).get('route') !== 'manual') {
    status('PLANNING TRAVERSE ON REAL SLOPES…');
    await nextFrame();
    const report = autoRoute(terrain);
    if (report.ok) console.info('[ISG] auto-route', report);
    else console.warn('[ISG] auto-route failed, keeping manual route:', report.reason);
  }

  if (dem) {
    status('LOADING DATA LAYERS…');
    await nextFrame();
    console.info('[ISG] layer rasters', await loadLayerRasters(dem));
  }

  status('PLANNING ROUTE…');
  await nextFrame();
  const route = new Route(terrain);
  const visuals = new RouteVisuals(route, terrain);
  scene.add(visuals.group);

  status('PLACING ROCKS…');
  await nextFrame();
  const rocks = createRocks(terrain, route);
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

  // ---------------------------------------------------------------- systems
  const map = new MapRenderer(terrain, route);
  const mission = new Mission(route, terrain, hab.userData.antennaTop);
  const input = new Input(viewport);
  const audio = new RoverAudio();
  const hud = new Hud({ route, mission, mapRenderer: map, layers: LAYERS, input });
  const weather = new Weather({
    renderer, scene, sun, hemi, sky, motes,
    onLog: (t, tone = 'info') => hud.log(t, tone),
  });

  const visor = new HelmetVisor({ weather });

  const heightAt = (x, z) => terrain.heightAt(x, z);
  const sites = new RouteSites({
    heightAt,
    sites: placeAlongRoute({ route, count: 5, heightAt }),
    onNear: (s) => hud.log(`Passing ${s.name} (concept): ${s.note}`, 'info'),
  });
  scene.add(sites.group);

  // ---------------------------------------------------------------- EVA
  // Habitat door: uses HAB exported from scenery.js if it exists, otherwise the hab object position.
  const HAB = scenery.HAB ?? { x: hab.position.x, z: hab.position.z };
  console.info('[ISG] habitat door ref:', HAB.x, HAB.z);

  const eva = new EvaWalk({
    scene,
    camera,
    domElement: renderer.domElement,
    roverRoot: rover.root,
    heightAt,
    habitat: { x: HAB.x, z: HAB.z + 0.5, outX: 0, outZ: -1, radius: 6 },
    sun,
    hemi,
    sunDir: SUN_DIR,
    canExit: () => mission.speed < 0.3 && mission.state !== 'brief',
    onExit: () => { mission.cruise = false; },
    onLog: (t, tone) => hud.log(t, tone),
    onView: (v) => visor.setVisible?.(v !== 'third'),
    getStatus: () => ({
      o2: fmtHM(mission.o2Remaining),
      power: `${mission.batteryPct.toFixed(0)} %`,
      dose: `${mission.dose.toFixed(0)} µSv`,
      comms: mission.comms.los ? 'LOS' : 'RELAY',
    }),
  });

  // ---------------------------------------------------------------- controls
  document.querySelectorAll('#touch button').forEach((b) => input.bindButton(b, b.dataset.v));
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b) b.blur();
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
  hud.fillBriefing();
  hud.ready(() => {
    audio.start();
    hud.showHud();
    mission.start();
    input.resetLook();
  });

  // debug / automated testing hook
  const simulate = (seconds, o = {}) => {
    const fake = { throttle: o.throttle ?? true, brake: false, steer: o.steer ?? 0, action: o.action ?? false, boost: o.boost ?? false };
    for (let t = 0; t < seconds; t += 1 / 30) mission.update(1 / 30, fake, view.pitch);
    return { s: +mission.s.toFixed(1), v: +mission.speed.toFixed(2), state: mission.state };
  };
  window.__isg = { renderer, scene, camera, mission, route, rover, terrain, input, setLayer, hud, simulate, weather, eva, sites, visor };
  console.info('[ISG] EVA initialized:', eva);

  // ================================================================ FRAME LOOP
  function frame() {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    time += dt;

    // ---- discrete inputs
    if (mission.state === 'brief' && input.hit('enter') && !beginBtn.disabled) beginBtn.click();
    if (mission.state !== 'brief') {
      for (const l of LAYERS) if (input.hit(l.key)) setLayer(l.id);
      if (input.hit('m')) hud.toggleMap();
      if (input.hit('escape')) hud.toggleMap(false);
      if (input.hit('h')) hud.toggleHidden();
      if (input.hit('n')) hud.log(audio.toggleMute() ? 'Audio muted' : 'Audio on', 'info');
      if (input.hit('k')) weather.togglePanel();
      if (input.hit('t')) weather.cyclePreset();
      if (input.hit('g')) weather.cycleDust();

      // rover-only keys: ignored while walking
      if (!eva.active) {
        if (input.hit('v')) input.resetLook();
        if (input.hit('l')) {
          lightsOn = !lightsOn;
          rover.setHeadlights(lightsOn);
          hud.log(`Headlights ${lightsOn ? 'ON' : 'OFF'}`, 'info');
        }
        if (input.hit('c') && mission.state === 'drive') {
          mission.cruise = !mission.cruise;
          hud.log(`Cruise ${mission.cruise ? 'ON' : 'OFF'}`, 'info');
        }
        if (input.hit('enter')) mission.acknowledge();
      }
    }
    weather.setVisible(mission.state !== 'brief');
    weather.update(dt);
    visor.update(dt);

    // ---- simulation (rover gets idle input while the astronaut walks)
    const drive = eva.active ? IDLE_INPUT : input;
    mission.update(dt, drive, view.pitch);

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
      speed: mission.speed * (mission.boosting && mission.state === 'drive' ? 3 : 1),
      throttle: mission.state === 'drive' && (drive.throttle || mission.cruise) ? 1 : 0,
      brake: drive.brake ? 1 : 0,
      steer: mission.state === 'drive' ? drive.steer : 0,
      roughness,
      lookTarget: copilotLook,
    });

    // ---- driver's head (only when not walking)
    if (mission.state === 'brief') {
      look.yaw = Math.sin(time * 0.18) * 0.55;
      look.pitch = -0.05 + Math.sin(time * 0.11) * 0.05;
    } else if (!eva.active) {
      look.yaw += (input.look.yaw - look.yaw) * damp(12, dt);
      look.pitch += (input.look.pitch - look.pitch) * damp(12, dt);
    }
    if (!eva.active) camera.rotation.set(-0.1 + look.pitch, look.yaw, 0, 'YXZ');

    // ---- EVA updates the camera itself, so run it before reading the camera position
    eva.update(dt);

    camera.updateMatrixWorld(true);
    camera.getWorldPosition(camWorld);

    // ---- environment follows the viewer (camera, not rover, so shadows work while walking)
    sky.position.copy(camWorld);
    sun.target.position.set(camWorld.x, eva.active ? camWorld.y - 1.7 : rover.root.position.y, camWorld.z);
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 150);
    motes.update(dt, camWorld);

    // ---- wheel dust
    const simSpeed = mission.speed * (mission.boosting ? 3 : 1);
    if (simSpeed > 0.25 && !eva.active) {
      rover.wheelContacts(contacts);
      const n = simSpeed * dt * 9;
      for (const c of contacts) {
        const k = n + (Math.random() < n % 1 ? 1 : 0);
        for (let i = 0; i < Math.floor(k); i++) {
          wheelDust.emit(c.x, c.y, c.z, p.tx * simSpeed * 0.35, p.tz * simSpeed * 0.35, simSpeed);
        }
      }
    }
    wheelDust.update(dt, (wx, wz) => terrain.heightAt(wx, wz));

    visuals.update(time, mission.s, station ? station.id : null);
    hab.userData.beacon.visible = Math.sin(time * 2.4) > -0.2;

    // ---- route sites (use the walker's position when on foot)
    sites.update(time, eva.active ? { x: camWorld.x, z: camWorld.z } : { x, z });

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

init().catch((err) => {
  console.error(err);
  const b = document.getElementById('beginBtn');
  if (b) b.textContent = `ERROR: ${err.message}`;
});