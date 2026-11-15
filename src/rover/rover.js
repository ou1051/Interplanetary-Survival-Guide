import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROVER } from '../config/mission.js';
import { damp, clamp } from '../core/math.js';
import { createSuitMaterials, createSeatedAstronaut } from './astronaut.js';

// ---------------------------------------------------------------------------
// Pressurised-suit, open-frame rover seen from the driver's seat (left side).
// Local frame: -Z forward, +X right, +Y up, origin on the ground at the centre.
// ---------------------------------------------------------------------------

const WHEEL_R = 0.41;
const WHEEL_X = 0.95;
const WHEEL_Z = 1.15;
export const EYE = new THREE.Vector3(-0.42, 1.6, 0.22);

function panelTexture(base = '#3a3e45', lines = '#24272c', stripe = true) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.025})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  g.strokeStyle = lines;
  g.lineWidth = 3;
  for (const v of [0, 128, 300, 512]) {
    g.beginPath(); g.moveTo(v, 0); g.lineTo(v, 512); g.stroke();
  }
  for (const v of [0, 200, 512]) {
    g.beginPath(); g.moveTo(0, v); g.lineTo(512, v); g.stroke();
  }
  g.fillStyle = '#6b7078';
  for (const [x, y] of [[10, 10], [118, 10], [10, 190], [118, 190], [138, 10], [290, 10], [138, 190], [290, 190], [310, 210], [500, 210], [310, 500], [500, 500]]) {
    g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
  }
  if (stripe) {
    for (let x = -40; x < 560; x += 36) {
      g.fillStyle = '#d9a21b';
      g.beginPath(); g.moveTo(x, 470); g.lineTo(x + 18, 470); g.lineTo(x + 40, 512); g.lineTo(x + 22, 512); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function meshTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#26282b';
  g.fillRect(0, 0, 256, 64);
  g.strokeStyle = '#b9bcc0';
  g.lineWidth = 2;
  for (let x = -64; x < 320; x += 12) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 64, 64); g.stroke();
    g.beginPath(); g.moveTo(x + 64, 0); g.lineTo(x, 64); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(5, 1);
  return t;
}

function tube(points, radius, mat, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'catmullrom', 0.2);
  const geo = new THREE.TubeGeometry(curve, Math.max(24, points.length * 16), radius, 10, closed);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

function screenCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { canvas, ctx: canvas.getContext('2d'), tex };
}

export class Rover {
  constructor(envMap) {
    this.root = new THREE.Group(); // world pose (yaw/pitch/roll)
    this.root.rotation.order = 'YXZ';
    this.body = new THREE.Group(); // chassis-mounted parts (vibration applied here)
    this.root.add(this.body);

    const M = {
      frame: new THREE.MeshStandardMaterial({ color: 0xb7bcc4, metalness: 0.85, roughness: 0.3, envMap, envMapIntensity: 1.0 }),
      frameDark: new THREE.MeshStandardMaterial({ color: 0x5c6168, metalness: 0.7, roughness: 0.45, envMap }),
      deck: new THREE.MeshStandardMaterial({ map: panelTexture(), metalness: 0.35, roughness: 0.62, envMap, envMapIntensity: 0.6 }),
      console: new THREE.MeshStandardMaterial({ map: panelTexture('#2b2f36', '#1b1d21', false), metalness: 0.3, roughness: 0.55, envMap, envMapIntensity: 0.5 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xd6a648, metalness: 1.0, roughness: 0.26, envMap, envMapIntensity: 1.2 }),
      suit: new THREE.MeshStandardMaterial({ color: 0xece9e2, roughness: 0.82, metalness: 0.0, envMap, envMapIntensity: 0.35 }),
      seat: new THREE.MeshStandardMaterial({ color: 0x40444b, roughness: 0.9, metalness: 0.1 }),
      wheel: new THREE.MeshStandardMaterial({ map: meshTexture(), metalness: 0.75, roughness: 0.45, envMap }),
      tread: new THREE.MeshStandardMaterial({ color: 0x8d9197, metalness: 0.9, roughness: 0.35, envMap }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.05, transmission: 0, transparent: true, opacity: 0.07, envMap, envMapIntensity: 1.5, depthWrite: false }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 0.4 }),
      ledGreen: new THREE.MeshBasicMaterial({ color: 0x3dff8b, toneMapped: false }),
      ledAmber: new THREE.MeshBasicMaterial({ color: 0xffb02e, toneMapped: false }),
      ledRed: new THREE.MeshBasicMaterial({ color: 0xff4436, toneMapped: false }),
      ledBlue: new THREE.MeshBasicMaterial({ color: 0x55dfff, toneMapped: false }),
    };
    this.M = M;
    this.suitM = createSuitMaterials(envMap);

    this._buildChassis();
    this._buildWheels();
    this._buildCage();
    this._buildConsole();
    this._buildSeatsAndCrew();
    this._buildEquipment();

    this.body.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = o.castShadow !== false;
        o.receiveShadow = true;
      }
    });

    // Driver's eye.
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 30000);
    this.camera.rotation.order = 'YXZ';
    this.cameraMount = new THREE.Group();
    this.cameraMount.position.copy(EYE);
    this.cameraMount.add(this.camera);
    this.body.add(this.cameraMount);

    // Headlights.
    this.headlights = [];
    for (const x of [-0.55, 0.55]) {
      const l = new THREE.SpotLight(0xfff0d8, 0, 60, 0.42, 0.55, 1.4);
      l.position.set(x, 0.92, -1.62);
      l.target.position.set(x * 1.6, 0.0, -14);
      this.body.add(l, l.target);
      this.headlights.push(l);
    }

    this.pose = { y: 0, pitch: 0, roll: 0, yaw: 0, init: false };
    this.wheelSpin = 0;
    this.time = 0;
  }

  _buildChassis() {
    const { body, M } = this;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.08, 3.1), M.frameDark);
    floor.position.set(0, 0.62, 0);
    body.add(floor);
    // front deck (visible over the console) with hazard stripe at the nose
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.1, 0.95), M.deck);
    deck.position.set(0, 0.74, -1.18);
    body.add(deck);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.22, 0.08), M.frameDark);
    nose.position.set(0, 0.68, -1.68);
    body.add(nose);
    // side rails
    for (const sx of [-1, 1]) {
      body.add(tube([[sx * 0.84, 0.66, -1.66], [sx * 0.86, 0.68, 0], [sx * 0.84, 0.66, 1.55]], 0.035, M.frame));
    }
    // rear deck with gold-foil battery / thermal boxes
    const rear = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.1, 0.7), M.deck);
    rear.position.set(0, 0.74, 1.25);
    body.add(rear);
    const batt = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.32, 0.5), M.gold);
    batt.position.set(-0.4, 0.95, 1.28);
    const batt2 = batt.clone();
    batt2.position.x = 0.4;
    body.add(batt, batt2);
    // fenders over all four wheels (front ones frame the view)
    const fenderGeo = new THREE.CylinderGeometry(WHEEL_R + 0.1, WHEEL_R + 0.1, 0.34, 28, 1, true, 0, Math.PI);
    const fenderMat = M.frame.clone();
    fenderMat.side = THREE.DoubleSide;
    fenderGeo.rotateZ(Math.PI / 2);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const f = new THREE.Mesh(fenderGeo, fenderMat);
        f.position.set(sx * WHEEL_X, WHEEL_R + 0.02, sz * WHEEL_Z);
        body.add(f);
      }
    }
    // headlamp housings on the nose
    for (const x of [-0.55, 0.55]) {
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.12, 20), M.frameDark);
      housing.rotation.x = Math.PI / 2;
      housing.position.set(x, 0.88, -1.6);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.075, 20), M.lamp);
      lens.position.set(x, 0.88, -1.665);
      lens.rotation.y = Math.PI;
      body.add(housing, lens);
      this.lampLenses = (this.lampLenses || []).concat(lens);
    }
  }

  _buildWheels() {
    const { body, M } = this;
    this.wheels = [];
    const tireGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.24, 36, 1, true);
    tireGeo.rotateZ(Math.PI / 2);
    const chevrons = [];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      for (const side of [-1, 1]) {
        const g = new THREE.BoxGeometry(0.11, 0.025, 0.05);
        g.rotateY(side * 0.5);
        g.translate(side * 0.055, WHEEL_R + 0.01, 0);
        g.rotateX(a);
        chevrons.push(g);
      }
    }
    const treadGeo = mergeGeometries(chevrons);
    const hubGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.26, 20);
    hubGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.TorusGeometry(WHEEL_R - 0.01, 0.018, 8, 40);
    rimGeo.rotateY(Math.PI / 2);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const pivot = new THREE.Group(); // steering + suspension
        pivot.position.set(sx * WHEEL_X, WHEEL_R, sz * WHEEL_Z);
        const spin = new THREE.Group();
        spin.add(new THREE.Mesh(tireGeo, M.wheel));
        spin.add(new THREE.Mesh(treadGeo, M.tread));
        spin.add(new THREE.Mesh(hubGeo, M.frameDark));
        for (const off of [-0.12, 0.12]) {
          const rim = new THREE.Mesh(rimGeo, M.frame);
          rim.position.x = off;
          spin.add(rim);
        }
        pivot.add(spin);
        // suspension arms back to the chassis
        const arm = tube([[0, 0, 0], [-sx * 0.2, 0.12, -sz * 0.05], [-sx * 0.38, 0.24, -sz * 0.18]], 0.025, M.frame);
        pivot.add(arm);
        body.add(pivot);
        this.wheels.push({ pivot, spin, sx, sz, offset: 0 });
      }
    }
  }

  _buildCage() {
    const { body, M } = this;
    const r = 0.028;
    // front hoop (frames the windscreen view) and rear hoop
    body.add(tube([[-0.82, 0.68, -0.6], [-0.83, 1.55, -0.52], [-0.72, 1.94, -0.44], [0, 1.99, -0.43], [0.72, 1.94, -0.44], [0.83, 1.55, -0.52], [0.82, 0.68, -0.6]], r, M.frame));
    body.add(tube([[-0.82, 0.68, 0.98], [-0.83, 1.55, 0.95], [-0.72, 1.94, 0.93], [0, 1.99, 0.93], [0.72, 1.94, 0.93], [0.83, 1.55, 0.95], [0.82, 0.68, 0.98]], r, M.frame));
    // longitudinal top rails + diagonal braces
    for (const sx of [-1, 1]) {
      body.add(tube([[sx * 0.72, 1.94, -0.44], [sx * 0.72, 1.96, 0.25], [sx * 0.72, 1.94, 0.93]], r * 0.9, M.frame));
      // low side rail (arm rest height) between the hoops
      body.add(tube([[sx * 0.83, 1.05, -0.56], [sx * 0.84, 1.08, 0.2], [sx * 0.83, 1.05, 0.96]], r * 0.7, M.frame));
    }
    // top equipment rack over the rear half
    const rack = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.03, 0.75), M.frameDark);
    rack.position.set(0, 2.0, 0.56);
    body.add(rack);
    for (let i = -3; i <= 3; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.75), M.frame);
      slat.position.set(i * 0.2, 2.03, 0.56);
      body.add(slat);
    }
    // antennas & instruments on the rack (silhouettes visible when looking up)
    const ant = (x, z, h, rad = 0.008) => {
      const a = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, h, 6), M.frame);
      a.position.set(x, 2.03 + h / 2, z);
      body.add(a);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(rad * 2.2, 8, 6), M.ledRed);
      tip.position.set(x, 2.03 + h, z);
      body.add(tip);
      return tip;
    };
    this.antennaTip = ant(-0.6, 0.3, 0.95);
    ant(-0.45, 0.32, 0.7);
    ant(0.62, 0.3, 0.82);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.suit);
    dome.position.set(0.2, 2.03, 0.55);
    body.add(dome);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.22), M.gold);
    box.position.set(-0.15, 2.11, 0.62);
    body.add(box);
    // high-gain antenna (umbrella dish) on a mast behind the crew
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 1.0, 8), M.frame);
    mast.position.set(0.55, 2.5, 1.12);
    body.add(mast);
    const dish = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.16, 24, 1, true), M.suit);
    dish.material = M.suit.clone();
    dish.material.side = THREE.DoubleSide;
    dish.position.set(0.55, 3.02, 1.12);
    dish.rotation.x = -0.6;
    body.add(dish);
  }

  _buildConsole() {
    const { body, M } = this;
    // pedestal + angled control/display console in front of the crew
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.3, 0.22), M.console);
    pedestal.position.set(-0.03, 0.8, -0.7);
    body.add(pedestal);
    const panel = new THREE.Group();
    panel.position.set(-0.03, 1.03, -0.7);
    panel.rotation.x = -0.82; // face tilted up toward the crew
    body.add(panel);
    const face = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.36, 0.06), M.console);
    panel.add(face);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(1.44, 0.03, 0.14), M.frameDark);
    lip.position.set(0, 0.19, 0.03);
    panel.add(lip);

    // three live displays: NAV (driver), TRAVERSE (centre), SCIENCE (co-pilot)
    this.screens = {
      nav: screenCanvas(512, 352),
      traverse: screenCanvas(448, 288),
      science: screenCanvas(448, 288),
    };
    const addScreen = (scr, x, w, h) => {
      const bezel = new THREE.Mesh(new THREE.BoxGeometry(w + 0.03, h + 0.03, 0.012), M.frameDark);
      bezel.position.set(x, 0, 0.034);
      panel.add(bezel);
      const mat = new THREE.MeshBasicMaterial({ map: scr.tex, toneMapped: false });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(x, 0, 0.042);
      m.castShadow = false;
      panel.add(m);
      scr.mesh = m;
    };
    addScreen(this.screens.nav, -0.39, 0.42, 0.29);
    addScreen(this.screens.traverse, 0.05, 0.32, 0.206);
    addScreen(this.screens.science, 0.43, 0.32, 0.206);

    // indicator LEDs and toggle switches along the lower edge
    this.leds = [];
    const ledGeo = new THREE.SphereGeometry(0.0045, 8, 6);
    const ledMats = [M.ledGreen, M.ledGreen, M.ledBlue, M.ledAmber, M.ledGreen, M.ledRed, M.ledGreen, M.ledBlue];
    for (let i = 0; i < 16; i++) {
      const led = new THREE.Mesh(ledGeo, ledMats[i % ledMats.length]);
      led.position.set(-0.62 + i * 0.083, -0.162, 0.034);
      panel.add(led);
      this.leds.push(led);
    }
    for (let i = 0; i < 7; i++) {
      const sw = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.022, 6), M.frame);
      sw.rotation.x = Math.PI / 2;
      sw.position.set(0.3 + i * 0.03, 0.155, 0.045);
      panel.add(sw);
    }


    // hand controller (T-handle) between the seats — animated with input
    this.stick = new THREE.Group();
    this.stick.position.set(0.0, 0.86, -0.12);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.26, 10), M.frameDark);
    shaft.position.y = 0.13;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.15, 12), M.seat);
    grip.rotation.z = Math.PI / 2;
    grip.position.y = 0.27;
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.05, 14), M.seat);
    this.stick.add(shaft, grip, boot);
    body.add(this.stick);
    const armrest = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.55), M.console);
    armrest.position.set(0, 0.78, 0.15);
    body.add(armrest);

    // pillar tablets (life support readout on the driver's A-pillar)
    this.screens.life = screenCanvas(256, 320);
    const tab = new THREE.Group();
    tab.position.set(-0.8, 1.08, -0.56);
    tab.rotation.set(-0.35, 0.75, 0);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.185, 0.012), M.frameDark);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.135, 0.17), new THREE.MeshBasicMaterial({ map: this.screens.life.tex, toneMapped: false }));
    scr.position.z = 0.009;
    tab.add(back, scr);
    body.add(tab);
    const tab2 = tab.clone();
    tab2.position.x = 0.8;
    tab2.rotation.y = -0.75;
    tab2.children[1].material = new THREE.MeshBasicMaterial({ map: this.screens.life.tex, toneMapped: false });
    body.add(tab2);
  }

  _buildSeatsAndCrew() {
    const { body, M } = this;
    for (const sx of [-1, 1]) {
      const seat = new THREE.Group();
      seat.position.set(sx * 0.42, 0.84, 0.28);
      const pan = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.52), M.seat);
      const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.66, 0.06), M.seat);
      backrest.position.set(0, 0.34, 0.28);
      backrest.rotation.x = 0.16;
      const frame = tube([[-0.27, 0, -0.26], [-0.27, 0, 0.27], [-0.27, 0.66, 0.38], [0.27, 0.66, 0.38], [0.27, 0, 0.27], [0.27, 0, -0.26]], 0.015, M.frame);
      seat.add(pan, backrest, frame);
      body.add(seat);
      // footrest
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.03, 0.28), M.frameDark);
      foot.position.set(sx * 0.42, 0.7, -0.55);
      body.add(foot);
    }

    // Driver's own suited legs (seen when looking down). Hidden when the driver is
    // out of the rover or drawn whole for the outside views.
    this.driverLegs = createSeatedAstronaut(this.suitM, { seatX: -0.42, upperBody: false }).group;
    body.add(this.driverLegs);
    // The whole driver, for the third-person and overhead views (hidden in first person).
    this.driver = createSeatedAstronaut(this.suitM, { seatX: -0.42 }).group;
    this.driver.visible = false;
    body.add(this.driver);


    // Co-pilot astronaut in the right seat; the helmet turns to look at things.
    const copilot = createSeatedAstronaut(this.suitM, { seatX: 0.42 });
    this.copilotHead = copilot.head;
    body.add(copilot.group);
  }

  _buildEquipment() {
    const { body, M } = this;
    // front-mounted survey camera on a short mast (centre of the deck)
    const cam = new THREE.Group();
    cam.position.set(0.12, 0.79, -1.42);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.1, 8), M.frame);
    post.position.y = 0.05;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.15), M.suit);
    head.position.y = 0.13;
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.06, 16), M.frameDark);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.13, -0.1);
    cam.add(post, head, lens);
    body.add(cam);
    // tool carrier & sample bags on the deck sides
    const toolbox = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.42), M.gold);
    toolbox.position.set(0.52, 0.87, -1.15);
    body.add(toolbox);
    const bag = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.2, 12), M.suit);
    bag.position.set(-0.6, 0.89, -1.3);
    body.add(bag);
  }

  // Place the rover on the terrain. (x, z) is the chassis centre, yaw heading.
  setPose(x, z, yaw, terrain, dt) {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const fx = -sin;
    const fz = -cos;
    const rx = cos;
    const rz = -sin;
    const h = (a, b) => terrain.heightAt(x + fx * a + rx * b, z + fz * a + rz * b);
    const hFL = h(WHEEL_Z, -WHEEL_X);
    const hFR = h(WHEEL_Z, WHEEL_X);
    const hBL = h(-WHEEL_Z, -WHEEL_X);
    const hBR = h(-WHEEL_Z, WHEEL_X);
    const hF = (hFL + hFR) / 2;
    const hB = (hBL + hBR) / 2;
    const hL = (hFL + hBL) / 2;
    const hR = (hFR + hBR) / 2;
    const y = (hF + hB) / 2;
    const pitch = Math.atan2(hF - hB, WHEEL_Z * 2);
    const roll = Math.atan2(hR - hL, WHEEL_X * 2);

    const P = this.pose;
    if (!P.init || dt <= 0) {
      Object.assign(P, { y, pitch, roll, yaw, init: true });
    } else {
      const k = damp(14, dt);
      P.y += (y - P.y) * k;
      P.pitch += (pitch - P.pitch) * damp(9, dt);
      P.roll += (roll - P.roll) * damp(9, dt);
      let dy = yaw - P.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      P.yaw += dy * damp(10, dt);
    }
    this.root.position.set(x, P.y, z);
    this.root.rotation.set(P.pitch, P.yaw, P.roll, 'YXZ');

    // Individual wheel articulation relative to the chassis plane.
    const plane = (sz, sx) => y + Math.sin(pitch) * sz * WHEEL_Z + Math.sin(roll) * sx * WHEEL_X;
    const actual = { '-1,-1': hFL, '1,-1': hFR, '-1,1': hBL, '1,1': hBR };
    for (const w of this.wheels) {
      const target = clamp(actual[`${w.sx},${w.sz}`] - plane(-w.sz, w.sx), -0.18, 0.18);
      w.offset += (target - w.offset) * damp(18, dt || 1);
      w.pivot.position.y = WHEEL_R + w.offset;
    }
    return { pitch: pitch * (180 / Math.PI), roll: roll * (180 / Math.PI) };
  }

  animate(dt, { speed, throttle, brake, steer, roughness, lookTarget }) {
    this.time += dt;
    this.wheelSpin += (speed * dt) / WHEEL_R;
    for (const w of this.wheels) {
      w.spin.rotation.x = -this.wheelSpin;
      w.pivot.rotation.y = w.sz * steer * 0.22; // 4-wheel steering
    }
    // hand controller follows the crew's input
    const tx = (throttle - brake) * 0.32;
    this.stick.rotation.x += (-tx - this.stick.rotation.x) * damp(10, dt);
    this.stick.rotation.z += (-steer * 0.3 - this.stick.rotation.z) * damp(10, dt);

    // chassis vibration (felt through the seat)
    const v = clamp(speed / 4.5, 0, 1);
    const t = this.time;
    const amp = (0.004 + roughness * 0.02) * v;
    this.body.position.y = amp * (Math.sin(t * 27) * 0.6 + Math.sin(t * 41.3) * 0.4);
    this.body.rotation.z = amp * 0.6 * Math.sin(t * 19.7);
    this.body.rotation.x = amp * 0.5 * Math.sin(t * 23.1);

    // co-pilot glances toward the next target, sometimes at the driver
    if (lookTarget !== undefined) {
      const phase = Math.sin(t * 0.21) + Math.sin(t * 0.13);
      const desired = phase > 1.3 ? 0.9 : clamp(lookTarget, -0.9, 1.1);
      this.copilotHead.rotation.y += (desired - this.copilotHead.rotation.y) * damp(2.2, dt);
      this.copilotHead.rotation.x = 0.06 * Math.sin(t * 0.7);
    }
    // blinking LEDs
    if (this.leds) {
      for (let i = 0; i < this.leds.length; i++) {
        this.leds[i].visible = i % 5 !== 0 || Math.sin(t * (2 + i * 0.3) + i) > -0.3;
      }
    }
    this.antennaTip.visible = Math.sin(t * 3.2) > 0;
  }

  setHeadlights(on) {
    for (const l of this.headlights) l.intensity = on ? 40 : 0;
    for (const l of this.lampLenses) l.material.emissiveIntensity = on ? 4 : 0.4;
  }

  wheelContacts(out = []) {
    out.length = 0;
    const v = new THREE.Vector3();
    for (const w of this.wheels) {
      v.set(w.sx * WHEEL_X, 0.02, w.sz * WHEEL_Z);
      this.root.localToWorld(v);
      out.push({ x: v.x, y: v.y, z: v.z, rear: w.sz > 0 });
    }
    return out;
  }
}
