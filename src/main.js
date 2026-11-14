import * as THREE from 'three';
import { Terrain, featureMasks, sampleContext } from './world/terrain.js';
import { Route, RouteVisuals } from './world/route.js';
import { createRocks, createHabitat } from './world/scenery.js';
import { createSky, createEnvironment, DustMotes, WheelDust, SUN_DIR, HORIZON } from './world/atmosphere.js';
import { Rover, EYE } from './rover/rover.js';
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
import { clamp, damp, smoothstep, wrapAngle, DEG } from './core/math.js';
import { TaskRunner } from './ui/taskRunner.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const planningBoard = new PlanningBoard();
document.getElementById('boardBtn').addEventListener('click', () => planningBoard.toggle(true));

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
  const route = plan.traverse?.route ?? new Route(terrain, { points: plan.points, exact: true, areaHazards: [], stations: [{
    id: 'S1', name: 'Layered outcrop', at: worldPosition(outcrop),
    objective: 'Use the Curiosity field reference to identify two beds and collect a sample from each.',
    why: ['Compare rock textures above and below the visible contact.'],
    observation: { image: imagery.mastcam, source: observationSource },
    tasks: [{ label: 'Collect paired samples', kind: 'drill', minutes: sampleMinutes, sampleCount: 2, result: 'Two samples bagged for comparison · simulation' }],
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

  const map = new MapRenderer(terrain, route);
  const mission = new Mission(route, terrain, hab.userData.antennaTop);
  const audio = new RoverAudio();
  // Station tasks are played first-person (see src/sim/fieldTasks.js).
  mission.interactiveTasks = true;
  const tasks = new TaskRunner({ mission, scene, camera, terrain, rover, audio, habAntenna: hab.userData.antennaTop });
  const startTask = () => {
    if (planningBoard.open || tasks.active || !mission.activeTask) return;
    // Space presses the drill, so no button may keep the focus.
    document.getElementById('viewport').focus({ preventScroll: true });
    tasks.start();
  };
  const hud = new Hud({ route, mission, mapRenderer: map, layers: LAYERS, input, onTask: startTask });
  const lookChip = document.getElementById('lookChip');
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
    if (type === 'state' && p.state === 'complete') setTimeout(() => hud.showDebrief(() => location.reload(), scoreSummary()), 1400);
  });

  // Science score for the debrief, with a local best per site.
  function scoreSummary() {
    const graded = mission.grades.length;
    if (!graded) return {};
    const average = mission.score / graded;
    const rank = average >= 450 ? 'S' : average >= 300 ? 'A' : average >= 175 ? 'B' : 'C';
    const key = `isg.best.${route.site?.name ?? 'site'}`;
    let best = 0;
    try { best = Number(localStorage.getItem(key)) || 0; } catch { /* storage unavailable */ }
    const record = mission.score > best;
    try { if (record) localStorage.setItem(key, String(mission.score)); } catch { /* storage unavailable */ }
    return {
      score: [['SCIENCE SCORE', mission.score.toLocaleString('en')], ['RANK', rank], ['BEST', Math.max(best, mission.score).toLocaleString('en')]],
      note: `Grades ${[...new Set(mission.grades.map((g) => g.station))]
        .map((id) => `${id}: ${mission.grades.filter((g) => g.station === id).map((g) => g.grade).join(' ')}`).join(' · ')}${record ? ' · New best score!' : ''}`,
    };
  }

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
  const aimDir = new THREE.Vector3();
  let time = 0;
  const timer = new THREE.Timer();
  timer.connect(document);

  console.info(`[ISG] world ready in ${Math.round(performance.now() - T0)} ms · rocks ${rocks.userData.count}`);
  document.getElementById('habitat').classList.add('hidden');
  audio.start();
  hud.showHud();
  // Keep keyboard focus on the 3D view: a focused button would also react to
  // Enter (hazard briefings) and Space (drill pressure).
  viewport.tabIndex = -1;
  viewport.focus({ preventScroll: true });
  mission.start();
  input.resetLook();
  input.keys.clear();
  input.pressed.clear();
  const fieldAlert = document.getElementById('fieldAlert');
  const dustAt = route.length * 0.29;
  let dustActive = false;

  // debug / automated testing hook: advance the simulation with a fixed step
  const simulate = (seconds, o = {}) => {
    const fake = { throttle: o.throttle ?? true, brake: false, steer: o.steer ?? 0, action: o.action ?? false, boost: o.boost ?? false };
    for (let t = 0; t < seconds; t += 1 / 30) mission.update(1 / 30, fake, view.pitch);
    return { s: +mission.s.toFixed(1), v: +mission.speed.toFixed(2), state: mission.state };
  };
  window.__isg = { renderer, input, mission, route, rover, terrain, setLayer, hud, simulate, tasks };

  function frame() {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    time += dt;

    // ---- discrete inputs
    if (!planningBoard.open && mission.state !== 'brief') {
      for (const l of LAYERS) if (input.hit(l.key)) setLayer(l.id);
      if (input.hit('m')) hud.toggleMap();
      if (input.hit('escape')) {
        if (hud.overlayOpen || !tasks.active) hud.toggleMap(false);
        else tasks.cancel();
      }
      if (input.hit('h')) hud.toggleHidden();
      if (input.hit('v')) input.resetLook();
      if (input.hit('b')) input.lookBack();
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
      if (input.hit('enter')) mission.acknowledge();
      if (input.hit('e')) startTask();
    }
    // Touch TASK button: a tap starts the task, holding it presses the drill.
    if (input.hit('touch:action')) startTask();

    // ---- simulation
    if (!planningBoard.open) mission.update(dt, input, view.pitch);
    if (route.retracesOutbound && scenario === 'dust' && !mission.aborted && !mission.dustWarning &&
        mission.state === 'drive' && mission.s >= dustAt && mission.s < route.length / 2) {
      mission.dustWarning = true;
      mission.speed = 0;
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
      throttle: mission.state === 'drive' && (input.throttle || mission.cruise) ? 1 : 0,
      brake: input.brake ? 1 : 0,
      steer: mission.state === 'drive' ? input.steer : 0,
      roughness,
      lookTarget: copilotLook,
    });

    // ---- driver's head: a full 360° turn, leaning out of the seat to look aft
    input.lookLocked = tasks.lockLook;
    if (mission.state === 'brief') {
      look.yaw = Math.sin(time * 0.18) * 0.55;
      look.pitch = -0.05 + Math.sin(time * 0.11) * 0.05;
    } else {
      if (!planningBoard.open) {
        // Z / X turn the head. During a task the rover is parked, so WASD / arrows look too.
        const aiming = tasks.active && !tasks.lockLook;
        const yawKeys = (input.down('z') || (aiming && input.down('a', 'arrowleft')) ? 1 : 0) - (input.down('x') || (aiming && input.down('d', 'arrowright')) ? 1 : 0);
        const pitchKeys = aiming ? (input.down('w', 'arrowup') ? 1 : 0) - (input.down('s', 'arrowdown') ? 1 : 0) : 0;
        const speed = aiming ? 0.9 : 2.4;
        if (yawKeys || pitchKeys) input.turnHead(yawKeys * speed * dt, pitchKeys * speed * 0.7 * dt);
      }
      look.yaw += (input.look.yaw - look.yaw) * damp(12, dt);
      look.pitch += (input.look.pitch - look.pitch) * damp(12, dt);
    }
    const relYaw = wrapAngle(look.yaw);
    const lean = smoothstep(0.9, 2.5, Math.abs(relYaw));
    rover.cameraMount.position.set(EYE.x - Math.sign(relYaw) * 0.14 * lean, EYE.y + 0.07 * lean, EYE.z - 0.06 * lean);
    // Suit sway while aiming an instrument, drill vibration while drilling.
    const sway = tasks.sway;
    const shake = tasks.shake;
    const swayYaw = sway * (Math.sin(time * 1.1) * 0.75 + Math.sin(time * 2.7 + 1) * 0.3) + shake * (Math.random() - 0.5);
    const swayPitch = sway * (Math.cos(time * 0.9) * 0.55 + Math.sin(time * 3.3) * 0.25) + shake * (Math.random() - 0.5);
    camera.rotation.set(-0.1 + look.pitch + swayPitch, look.yaw + swayYaw, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    camera.getWorldPosition(camWorld);
    lookChip.classList.toggle('hidden', Math.abs(relYaw) < 1.25 || mission.state === 'brief');
    if (tasks.active && !planningBoard.open) {
      camera.getWorldDirection(aimDir);
      tasks.update(dt, {
        eye: camWorld, dir: aimDir,
        pressing: input.down(' ') || (input.look.dragging && tasks.lockLook) || input.virtual.action,
        breathing: input.down('shift'),
      });
    }

    // ---- environment follows the viewer
    sky.position.copy(camWorld);
    sun.target.position.set(x, rover.root.position.y, z);
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 150);
    motes.update(dt, camWorld);

    const simSpeed = mission.speed * (mission.boosting ? 3 : 1);
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
