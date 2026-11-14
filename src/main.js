import * as THREE from 'three';
import { Terrain, featureMasks, sampleContext } from './world/terrain.js';
import { Route, RouteVisuals } from './world/route.js';
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
import { clamp, damp, DEG } from './core/math.js';
import { ROUTE_OPTIONS, VISIBILITY_FOG, ASSIGNMENT, STATIONS, SCOUT_PINS, LIFE_SUPPORT } from './config/mission.js';
import { Game } from './sim/game.js';
import { planRoundTrip, routeBounds } from './sim/routeApi.js';
import { MissionMapScreen } from './ui/missionScreenHost.js';
import { LaunchDesk } from './ui/launchDesk.js';
import { showOutcome } from './ui/finale.js';
import { startJourney } from './journey/Journey.js';

const $ = (id) => document.getElementById(id);

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

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
  status('GENERATING TERRAIN…');
  await nextFrame();
  const terrain = new Terrain();
  scene.add(terrain.group);

  status('PLANNING ROUTES…');
  await nextFrame();
  const game = Game.load();
  // Every route option is analysed up front (the mission map compares them);
  // the 3D world, rover mission and HUD are built for the selected one.
  const routes = Object.fromEntries(ROUTE_OPTIONS.map((o) => [o.id, new Route(terrain, o)]));
  // Third option: the team's route API plans a round trip over the same terrain.
  const plannerBounds = routeBounds(routes.survival);
  const setPlannerRoute = (res) => {
    const i = ROUTE_OPTIONS.findIndex((o) => o.id === 'planner');
    if (!res) {
      if (i >= 0) ROUTE_OPTIONS.splice(i, 1);
      delete routes.planner;
      return;
    }
    if (i >= 0) ROUTE_OPTIONS[i] = res.option;
    else ROUTE_OPTIONS.push(res.option);
    routes.planner = new Route(terrain, res.option);
  };
  status('ASKING ROUTE PLANNER…');
  setPlannerRoute(await planRoundTrip(terrain, plannerBounds, game.run.revealed));
  const routeSig = (r) => (r ? JSON.stringify(r.option.points) : '');
  const builtRouteId = routes[game.run.routeId] ? game.run.routeId : 'survival';
  const route = routes[builtRouteId];
  const builtSig = routeSig(route);
  let visuals = new RouteVisuals(route, terrain);
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

  const baseMap = new MapRenderer(terrain, routes.survival);
  const map = baseMap.withRoute(route);
  const mission = new Mission(route, terrain, hab.userData.antennaTop);
  const input = new Input(viewport);
  const audio = new RoverAudio();
  const hud = new Hud({ route, mission, mapRenderer: map, layers: LAYERS, input });
  document.querySelectorAll('#touch button').forEach((b) => input.bindButton(b, b.dataset.v));
  // keep keyboard shortcuts from re-triggering whatever button was clicked last
  document.addEventListener('click', (e) => e.target.closest && e.target.closest('button') && e.target.closest('button').blur());

  // ---------------------------------------------------------------- layers
  let layer = null;
  const setLayer = (id) => {
    const next = layerById(id);
    if (!next || next === layer) return;
    layer = next;
    terrain.applyLayer(layer);
    baseMap.setLayer(layer);
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
    if (type === 'state' && p.state === 'complete') setTimeout(() => endRehearsal(false), 1400);
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

  // ================================================================ game flow
  // brief → mission map ⇄ launch desk → rehearsal (3D traverse) → debrief → map
  //       → launch → liftoff → outcome (retry / new weather)
  let mode = 'brief';
  let rehearsalCtx = null;
  const hideAll = () => {
    for (const id of ['brief', 'debrief', 'outcome', 'hud']) $(id).classList.add('hidden');
    planner.hide();
    desk.hide();
  };

  // Ground view of a scouting site, rendered from the same terrain.
  const snapshot = (pin) => {
    const [cx, cz] = pin.camera;
    const [tx, tz] = pin.at;
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    const cam = new THREE.PerspectiveCamera(48, w / h, 0.5, 8000);
    cam.position.set(cx, terrain.heightAt(cx, cz) + 1.8, cz);
    cam.lookAt(tx, terrain.heightAt(tx, tz) - 4, tz);
    const vis = [visuals.group.visible, rover.root.visible];
    visuals.group.visible = false;
    rover.root.visible = false;
    sky.position.copy(cam.position);
    sun.target.position.set(tx, terrain.heightAt(tx, tz), tz);
    sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 150);
    sun.target.updateMatrixWorld();
    const fog = scene.fog.density;
    scene.fog.density = VISIBILITY_FOG.clear;
    renderer.render(scene, cam);
    const out = document.createElement('canvas');
    out.width = 640;
    out.height = 400;
    const sw = Math.min(w, (h * 640) / 400);
    const sh = (sw * 400) / 640;
    out.getContext('2d').drawImage(renderer.domElement, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, 640, 400);
    scene.fog.density = fog;
    [visuals.group.visible, rover.root.visible] = vis;
    return out.toDataURL('image/jpeg', 0.86);
  };

  // Mission map: the map module's screen (src/map) — globe + site plan — driven by this game.
  const planner = new MissionMapScreen({
    container: $('missionScreen'),
    game,
    routes,
    terrain,
    bounds: plannerBounds,
    snapshot,
    onRehearse: () => requestRehearsal(),
    onDesk: () => openDesk(),
  });
  const desk = new LaunchDesk({
    game,
    onBack: () => openPlanner(),
    onRehearse: () => requestRehearsal(),
    onLaunch: (w) => {
      hideAll();
      mode = 'liftoff';
      startJourney({ renderer, introduction: false, onComplete: openOutcome });
    },
    onEnd: () => openOutcome(),
  });

  // The selected route glows in the background world while planning.
  // Scouting changes what the planner knows: ask the route API again.
  let plannedFor = game.run.revealed.join();
  game.onChange(async (run) => {
    if (run.revealed.join() === plannedFor) {
      if (mode === 'planner') planner.render();
      return;
    }
    plannedFor = run.revealed.join();
    setPlannerRoute(await planRoundTrip(terrain, plannerBounds, run.revealed));
    if (!routes[run.routeId]) game.chooseRoute('survival', 'Survival route');
    game.save(); // refresh listeners (background route ribbon) with the new plan
    if (mode === 'planner') planner.render();
  });
  game.onChange((run) => {
    if (run.outcome === 'expired' && mode === 'planner') openOutcome();
    if (mode !== 'rehearsal' && mission.state === 'brief' && visuals.route !== routes[run.routeId]) {
      scene.remove(visuals.group);
      visuals = new RouteVisuals(routes[run.routeId], terrain);
      scene.add(visuals.group);
    }
  });

  function showAssignmentBrief() {
    hideAll();
    mode = 'brief';
    $('briefEyebrow').textContent = 'NASA SPACE APPS · INTERPLANETARY SURVIVAL GUIDE';
    $('briefTitle').innerHTML = 'FREELANCE ASTRONAUT<span>First assignment · Martian Map</span>';
    $('briefLede').innerHTML = `Your first paid job for the <b>${ASSIGNMENT.client}</b>: ${ASSIGNMENT.brief} Scout the ground, choose a route, rehearse the traverse in the rover — then decide when to launch, or hold for better weather.`;
    const items = [
      ['SITE', 'Vera Rubin Ridge'],
      ['SCI STATIONS', STATIONS.length],
      ['ROUTE OPTIONS', ROUTE_OPTIONS.length],
      ['SCOUT SITES', SCOUT_PINS.length],
      ['LAUNCH WINDOWS', game.scenario.windows.length],
      ['LAST WINDOW', `turn ${Math.max(...game.scenario.windows.map((w) => w.lastOpenTurn))}`],
      ['EVA BUDGET', `${LIFE_SUPPORT.evaHours} h O₂`],
      ['WEATHER', 'Simulated'],
    ];
    $('briefGrid').innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    $('briefSteps').innerHTML = ['scout the ground', 'choose a route', 'rehearse in the rover', 'launch or hold']
      .map((t, i) => `<span><kbd>${i + 1}</kbd> ${t}</span>`)
      .join('');
    $('briefBack').classList.add('hidden');
    $('brief').classList.remove('hidden');
    hud.ready(() => openPlanner(), game.run.turn || game.run.decisions.length ? 'CONTINUE MISSION ▸' : 'OPEN MISSION MAP ▸');
  }

  function showRehearsalBrief() {
    hideAll();
    mode = 'brief';
    const w = game.windowById(game.run.rehearsalWindowId);
    const vis = game.forecast(w).walk.visibility;
    $('briefEyebrow').textContent = `REHEARSAL · PLAN REVISION ${game.run.planRevision}`;
    $('briefTitle').innerHTML = `REHEARSAL<span>${route.option.name} · ${w.label} · ${vis} visibility</span>`;
    $('briefLede').innerHTML = `Drive the <b>${route.option.name.toLowerCase()}</b> in the rover. Stop at every science station, acknowledge each hazard gate and return to the habitat with at least ${LIFE_SUPPORT.reserveMinutes} min of O₂ in reserve. A complete run approves the surface plan.`;
    hud.fillBriefing();
    $('briefSteps').innerHTML = `<span><kbd>W</kbd> drive</span><span><kbd>A</kbd><kbd>D</kbd> steer</span><span><kbd>C</kbd> cruise</span>
      <span><kbd>⇧</kbd> time ×3</span><span><kbd>E</kbd> hold for tasks</span><span><kbd>Enter</kbd> confirm</span><span><kbd>X</kbd> end rehearsal</span>`;
    $('briefBack').classList.remove('hidden');
    $('briefBack').onclick = () => {
      game.run.pendingRehearsal = false;
      game.save();
      openPlanner();
    };
    $('brief').classList.remove('hidden');
    hud.ready(() => beginRehearsal(), 'BEGIN REHEARSAL ▸');
  }

  function openPlanner() {
    if (game.run.outcome !== 'planning') return openOutcome();
    hideAll();
    mode = 'planner';
    scene.fog.density = VISIBILITY_FOG.clear;
    planner.show();
  }

  function openDesk() {
    hideAll();
    mode = 'desk';
    desk.show();
  }

  function openOutcome() {
    hideAll();
    mode = 'outcome';
    showOutcome(game, {
      onRetry: () => {
        game.retry();
        location.reload();
      },
      onNewWeather: () => {
        game.newWeather();
        location.reload();
      },
    });
  }

  function requestRehearsal() {
    if (game.run.outcome !== 'planning') return;
    const same = builtRouteId === game.run.routeId && routeSig(routes[game.run.routeId]) === builtSig;
    if (same && mission.state === 'brief') return showRehearsalBrief();
    // The rover world is built for one route and one run: rebuild it.
    game.run.pendingRehearsal = true;
    game.save();
    location.reload();
  }

  function beginRehearsal() {
    const w = game.windowById(game.run.rehearsalWindowId);
    const visibility = game.forecast(w).walk.visibility;
    rehearsalCtx = { planRevision: game.run.planRevision, routeId: builtRouteId, windowId: w.id, visibility };
    scene.fog.density = VISIBILITY_FOG[visibility];
    hideAll();
    mode = 'rehearsal';
    audio.start();
    hud.showHud();
    mission.start();
    hud.log(`Rehearsal · ${w.label} · ${visibility} visibility (simulated)`, visibility === 'clear' ? 'info' : 'warn');
    input.resetLook();
  }

  function endRehearsal(aborted) {
    if (mode !== 'rehearsal') return;
    mode = 'debrief';
    const stations = route.stations.filter((s) => !s.final);
    const result = {
      ...rehearsalCtx,
      stationsDone: stations.filter((s) => s.done).length,
      stationsTotal: stations.length,
      returned: !aborted && mission.state === 'complete',
      aborted,
      met: mission.met,
      o2Remaining: mission.o2Remaining,
      distance: mission.distance,
    };
    if (aborted) mission.state = 'complete';
    game.recordRehearsal(result);
    hud.toggleMap(false);
    hud.showDebrief(() => openPlanner(), {
      title: aborted ? 'REHEARSAL ENDED' : 'TRAVERSE COMPLETE',
      approval: game.approval(),
    });
    $('restartBtn').textContent = 'MISSION MAP ▸';
  }
  $('abortBtn').addEventListener('click', () => endRehearsal(true));

  if (game.run.outcome !== 'planning') openOutcome();
  else if (game.run.pendingRehearsal) showRehearsalBrief();
  else {
    if (sessionStorage.getItem('isg-flight-preview-v1')) showAssignmentBrief();
    else {
      hideAll();
      mode = 'journey';
      startJourney({ renderer, onComplete: () => {
        sessionStorage.setItem('isg-flight-preview-v1', 'seen');
        showAssignmentBrief();
      } });
    }
  }

  // debug / automated testing hook: advance the simulation with a fixed step
  const simulate = (seconds, o = {}) => {
    const fake = { throttle: o.throttle ?? true, brake: false, steer: o.steer ?? 0, action: o.action ?? false, boost: o.boost ?? false };
    for (let t = 0; t < seconds; t += 1 / 30) mission.update(1 / 30, fake, view.pitch);
    return { s: +mission.s.toFixed(1), v: +mission.speed.toFixed(2), state: mission.state };
  };
  window.__isg = { mission, route, routes, rover, terrain, input, setLayer, hud, simulate, game, planner, desk };

  function frame() {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.05);
    time += dt;
    if (mode === 'journey' || mode === 'liftoff') {
      input.endFrame();
      requestAnimationFrame(frame);
      return;
    }

    // ---- discrete inputs
    if (!$('brief').classList.contains('hidden') && input.hit('enter') && !beginBtn.disabled) beginBtn.click();
    if (mode === 'rehearsal') {
      if (input.hit('x')) endRehearsal(true);
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
      if (input.hit('enter')) mission.acknowledge();
    }

    // ---- simulation
    if (mode === 'rehearsal') mission.update(dt, input, view.pitch);

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

    // ---- driver's head
    if (mode !== 'rehearsal' && mission.state === 'brief') {
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

    if (mode === 'rehearsal') hud.update(dt, view);
    audio.update(simSpeed, roughness);
    input.endFrame();

    // the mission map covers the whole screen with its own WebGL globe: don't render underneath it
    if (!['planner', 'journey', 'liftoff'].includes(mode)) renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

init().catch((err) => {
  console.error(err);
  const b = document.getElementById('beginBtn');
  if (b) b.textContent = `ERROR: ${err.message}`;
});
