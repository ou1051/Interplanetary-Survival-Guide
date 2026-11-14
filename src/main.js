import * as THREE from 'three';
import { Terrain, featureMasks, sampleContext } from './world/terrain.js';
import { Route, RouteVisuals } from './world/route.js';
import { createRocks, createHabitat } from './world/scenery.js';
import { createSky, createEnvironment, DustMotes, WheelDust, SUN_DIR, HORIZON } from './world/atmosphere.js';
import { Rover, EYE } from './rover/rover.js';
import { drawNav, drawTraverse, drawScience, drawLife } from './rover/screens.js';
import { LAYERS, layerById } from './data/layers.js';
import { Mission, WALK } from './sim/mission.js';
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
import { clamp, damp, smoothstep, wrapAngle, DEG } from './core/math.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const planningBoard = new PlanningBoard();
document.getElementById('boardBtn').addEventListener('click', () => planningBoard.toggle(true));

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
  const route = plan.traverse?.route ?? new Route(terrain, { points: plan.points, exact: true, areaHazards: [], stations: [{
    id: 'S1', name: 'Layered outcrop', at: worldPosition(outcrop),
    objective: 'Use the Curiosity field reference to identify two beds and collect a sample from each.',
    why: ['Compare rock textures above and below the visible contact.'],
    observation: { image: imagery.mastcam, source: observationSource },
    tasks: [{ label: 'Collect paired samples', minutes: sampleMinutes, sampleCount: 2, result: 'Two samples bagged for comparison · simulation' }],
  }] });
  route.planName = plan.name;
  route.retracesOutbound = !plan.traverse;
  route.site = plan.site;
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


  // ---------------------------------------------------------------- crew, finds
  // The driver as a whole figure: seated in the rover for the outside views,
  // walking when out of the rover.
  const walker = new Astronaut(env);
  walker.root.visible = false;
  scene.add(walker.root);
  const seated = new Astronaut(env);
  seated.setSeated(true);
  seated.root.position.set(-0.42, -0.08, 0.34);
  seated.root.visible = false;
  rover.body.add(seated.root);
  // World camera for walking and the outside views (the cockpit camera rides the rover).
  const freeCam = new THREE.PerspectiveCamera(72, 1, 0.05, 30000);
  freeCam.rotation.order = 'YXZ';
  scene.add(freeCam);
  const VIEWS = ['pov', 'chase', 'overhead'];
  const VIEW_NAMES = { pov: 'First person', chase: 'Third person', overhead: 'Overhead' };
  const zoom = { chase: { d: 7, min: 3.5, max: 16 }, overhead: { d: 24, min: 12, max: 60 } };
  let viewMode = 'pov';

  const mission = new Mission(route, terrain, hab.userData.antennaTop);
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
    if (button && button.id !== 'boardBtn' && !planningBoard.el.contains(button)) button.blur();
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
  planningBoard.connectTraverse(mission);
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
    if (type === 'state' && p.state === 'complete') setTimeout(() => hud.showDebrief(() => location.reload(), debriefSummary()), 1400);
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
  let collecting = { target: null, t: 0 };

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

  // ---------------------------------------------------------------- resize
  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
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
  const contacts = [];
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
  input.resetLook();
  input.keys.clear();
  input.pressed.clear();
  const fieldAlert = document.getElementById('fieldAlert');
  const dustAt = route.length * 0.29;
  let dustActive = false;

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
    renderer, input, mission, route, rover, terrain, setLayer, hud, simulate, artifacts, collection,
    crewAction, cycleView, get viewMode() { return viewMode; },
  };

  function frame() {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    time += dt;
    const paused = planningBoard.open || collection.open;

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
      if (input.hit('enter') && mission.atHome) mission.endEva();
    }

    // ---- simulation
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
      scene.fog.density = 0.008;
      dustActive = true;
      hud.log('Simulated dust front ahead. Open wrist navigation [P].', 'danger');
      planningBoard.toggle(true);
    }
    if (dustActive && mission.aborted) {
      scene.fog.density = 0.00042;
      dustActive = false;
    }
    if (planningBoard.open) planningBoard.updateField();
    const showAlert = mission.dustWarning && !mission.aborted && mission.state !== 'complete';
    fieldAlert.classList.toggle('hidden', !showAlert);

    // ---- collecting: hold E (or the button) next to an artifact
    const reach = artifactInReach();
    const holding = !paused && (input.down('e') || collectHeld || (onFoot && input.virtual.action));
    if (reach && holding) {
      if (collecting.target !== reach) collecting = { target: reach, t: 0 };
      collecting.t += dt;
      if (collecting.t >= 0.9) {
        mission.collect(reach);
        collecting = { target: null, t: 0 };
      }
    } else collecting = { target: null, t: 0 };
    walker.setReach(collecting.target ? Math.min(1, collecting.t * 3) : 0);

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
    const roverSpeed = R.speed * (mission.boosting && driving ? 3 : 1);
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
    rover.driverLegs.visible = inRover && !outside;
    seated.root.visible = inRover && outside;
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
    motes.update(dt, camWorld);

    const simSpeed = Math.abs(roverSpeed);
    if (simSpeed > 0.25) {
      rover.wheelContacts(contacts);
      const n = simSpeed * dt * 9;
      const fx = -Math.sin(R.heading) * Math.sign(R.speed), fz = -Math.cos(R.heading) * Math.sign(R.speed);
      for (const c of contacts) {
        const k = n + (Math.random() < n % 1 ? 1 : 0);
        for (let i = 0; i < Math.floor(k); i++) wheelDust.emit(c.x, c.y, c.z, fx * simSpeed * 0.35, fz * simSpeed * 0.35, simSpeed);
      }
    }
    wheelDust.update(dt, (wx, wz) => terrain.heightAt(wx, wz));

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
    setButton(collectBtn, Boolean(reach), reach ? `Hold to collect ${reach.name} [E]` : '');
    setButton(endBtn, mission.atHome && (driving || onFoot));
    hud.context = { reach, collecting: collecting.target ? collecting.t / 0.9 : 0, view: viewMode };

    if (mission.state !== 'brief') hud.update(dt, view);
    audio.update(driving ? simSpeed : 0, roughness);
    input.endFrame();

    renderer.render(scene, activeCam);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
