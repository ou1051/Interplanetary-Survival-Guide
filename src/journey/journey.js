import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { CHAPTERS, TOTAL_DURATION, chapterAt, ease } from './timeline.js';
import { mulberry32 } from '../core/math.js';
import './journey.css';

const mix = THREE.MathUtils.lerp;
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const material = (color, metalness = 0, roughness = .6) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
function mesh(parent, geometry, mat, x = 0, y = 0, z = 0) {
  const object = new THREE.Mesh(geometry, mat); object.position.set(x, y, z);
  object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
}
const box = (p, m, x, y, z, w, h, d) => mesh(p, new THREE.BoxGeometry(w, h, d), m, x, y, z);
function beam(parent, a, b, radius, mat) {
  const delta = b.clone().sub(a);
  const o = mesh(parent, new THREE.CylinderGeometry(radius, radius, delta.length(), 12), mat);
  o.position.copy(a).add(b).multiplyScalar(.5); o.quaternion.setFromUnitVectors(v(0, 1, 0), delta.normalize()); return o;
}
function label(text, color = '#bcebe7', size = 512) {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size / 4;
  const c = canvas.getContext('2d'); c.fillStyle = color; c.font = `500 ${size / 13}px monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, size / 2, size / 8);
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map, transparent: true, side: THREE.DoubleSide });
}

function padScene() {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#718d9a'); scene.fog = new THREE.Fog('#879ba0', 140, 650);
  scene.add(new THREE.HemisphereLight(0xcceaff, 0x444633, 2.2));
  const sun = new THREE.DirectionalLight(0xffe5b7, 4); sun.position.set(-55, 70, 30); scene.add(sun);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 65, bottom: -40, far: 200 });
  const steel = material('#69777a', .72, .34), white = material('#e3e1d5', .45, .27), dark = material('#192a31', .6, .35);
  const ground = material('#60675a'); box(scene, ground, 0, -1, 0, 1600, 2, 1600);
  box(scene, material('#839194', .2), 0, .1, 0, 42, .5, 48);
  const ocean = mesh(scene, new THREE.PlaneGeometry(1800, 900), material('#507582', .65, .2), 0, -.25, -550); ocean.rotation.x = -Math.PI / 2;
  const rocket = new THREE.Group(); scene.add(rocket);
  mesh(rocket, new THREE.CylinderGeometry(3.2, 3.3, 42, 64), white, 0, 24, 0);
  mesh(rocket, new THREE.ConeGeometry(3.2, 11, 64), white, 0, 50.5, 0);
  for (const y of [4, 13, 26, 39, 44]) mesh(rocket, new THREE.CylinderGeometry(3.24, 3.24, .18, 64), steel, 0, y, 0);
  mesh(rocket, new THREE.CylinderGeometry(3.3, 3.7, 3, 64), dark, 0, 2, 0);
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    const fin = box(rocket, steel, Math.cos(angle) * 3.2, 7, Math.sin(angle) * 3.2, .2, 8, 4); fin.rotation.y = -angle;
    const engine = mesh(rocket, new THREE.CylinderGeometry(.6, 1, 2, 24), dark, Math.cos(angle) * 1.7, .6, Math.sin(angle) * 1.7);
  }
  const badge = mesh(rocket, new THREE.PlaneGeometry(2.5, .65), label('ARES / 01', '#1d3339'), 0, 31, 3.31);
  box(rocket, dark, 0, 41, 3.08, 2.8, 1.35, .35);
  // A skeletal launch tower and a real, traversable crew access arm.
  for (const x of [10, 16]) for (const z of [-4, 4]) beam(scene, v(x, 0, z), v(x, 55, z), .26, steel);
  for (let y = 4; y < 55; y += 5) {
    box(scene, steel, 13, y, 0, 7, .25, 9);
    beam(scene, v(10, y, 4), v(16, y + 5, 4), .12, white);
    beam(scene, v(10, y, -4), v(16, y + 5, -4), .12, white);
    beam(scene, v(16, y, -4), v(16, y + 5, 4), .12, white);
  }
  box(scene, dark, 7, 39.8, 0, 12, .5, 3.6);
  for (const z of [-1.7, 1.7]) {
    beam(scene, v(2.8, 41.1, z), v(13, 41.1, z), .07, white);
    for (let x = 3; x <= 13; x += 1.5) beam(scene, v(x, 39.9, z), v(x, 41.1, z), .055, white);
  }
  for (let i = 0; i < 30; i++) box(scene, white, 3 + i * .32, 40.07, 0, .035, .03, 3.1);
  const hatch = mesh(scene, new THREE.CircleGeometry(1.4, 48), dark, 3.23, 41.4, 0); hatch.rotation.y = Math.PI / 2;
  // Ground infrastructure gives the launch site a human scale.
  for (let i = 0; i < 5; i++) {
    mesh(scene, new THREE.CylinderGeometry(3, 3, 9, 24), white, -35 - i * 9, 4.5, -24);
    mesh(scene, new THREE.SphereGeometry(3, 24, 16), white, -35 - i * 9, 9, -24);
  }
  for (let i = 0; i < 8; i++) box(scene, material(i % 2 ? '#596668' : '#889499'), -50 + i * 18, 4, 50, 12, 8, 20);
  beam(scene, v(-80, 0, -40), v(-80, 55, -40), .35, steel);
  const sunDisc = mesh(scene, new THREE.SphereGeometry(12, 32, 16), new THREE.MeshBasicMaterial({ color: '#ffebc1' }), -160, 95, -250);
  return scene;
}

// Generated fallback maps remain usable offline. They are explicitly illustrative.
function planetTexture(mars) {
  const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 1024;
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(canvas.width, canvas.height);
  const noise = new SimplexNoise({ random: mulberry32(mars ? 1234 : 42) });
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const lon = x / canvas.width * Math.PI * 2, lat = (y / canvas.height - .5) * Math.PI;
    const nx = Math.cos(lon) * Math.cos(lat), ny = Math.sin(lat), nz = Math.sin(lon) * Math.cos(lat);
    let n = 0, a = 1, f = 2.7;
    for (let o = 0; o < 5; o++) { n += a * noise.noise3d(nx * f, ny * f, nz * f); a *= .5; f *= 2; }
    let rgb;
    if (mars) { const t = n * .4 + .6; rgb = [141 + 64 * t, 67 + 48 * t, 39 + 34 * t]; }
    else if (Math.abs(lat) > 1.35) rgb = [197, 217, 216];
    else if (n > .14) rgb = [49 + n * 35, 76 + n * 29, 48 + n * 13];
    else rgb = [12, 43 + n * 8, 67 + n * 12];
    const i = (y * canvas.width + x) * 4;
    pixels.data[i] = rgb[0]; pixels.data[i + 1] = rgb[1]; pixels.data[i + 2] = rgb[2]; pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8; return texture;
}
function planet(parent, radius, mars) {
  const surface = mesh(parent, new THREE.SphereGeometry(radius, 128, 96), new THREE.MeshStandardMaterial({ map: planetTexture(mars), roughness: 1 }));
  const glow = new THREE.ShaderMaterial({
    uniforms: { tint: { value: new THREE.Color(mars ? '#d98c59' : '#70beff') } },
    vertexShader: 'varying vec3 n; varying vec3 eye; void main(){vec4 p=modelViewMatrix*vec4(position,1.); n=normalize(normalMatrix*normal);eye=normalize(-p.xyz);gl_Position=projectionMatrix*p;}',
    fragmentShader: 'varying vec3 n; varying vec3 eye; uniform vec3 tint; void main(){float rim=pow(1.-abs(dot(normalize(n),normalize(eye))),3.);gl_FragColor=vec4(tint,rim*.6);}',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  mesh(surface, new THREE.SphereGeometry(radius * 1.015, 96, 64), glow);
  return surface;
}

function flightScene() {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#02060b');
  scene.add(new THREE.HemisphereLight(0xc5d9eb, 0x252631, 1.2));
  const sunlight = new THREE.DirectionalLight(0xffeed5, 3.5); sunlight.position.set(-80, 65, 50); scene.add(sunlight);
  const rand = mulberry32(8801), coords = [];
  for (let i = 0; i < 4500; i++) {
    const theta = rand() * Math.PI * 2, zz = rand() * 2 - 1, rr = Math.sqrt(1 - zz * zz);
    coords.push(Math.cos(theta) * rr * 700, zz * 700, Math.sin(theta) * rr * 700);
  }
  const starsGeo = new THREE.BufferGeometry(); starsGeo.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
  const stars = new THREE.Points(starsGeo, new THREE.PointsMaterial({ color: '#d4e5f1', size: 1, sizeAttenuation: true })); scene.add(stars);
  const earth = planet(scene, 60, false), mars = planet(scene, 45, true);
  let disposed = false;
  new THREE.TextureLoader().load(new URL('../../public/textures/earth-atmosphere.jpg', import.meta.url).href, texture => {
    if (disposed) { texture.dispose(); return; }
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
    earth.material.map.dispose(); earth.material.map = texture; earth.material.needsUpdate = true;
  }, undefined, () => { /* Keep the illustrative fallback if image decoding fails. */ });
  const cabin = new THREE.Group(); scene.add(cabin);
  const shell = material('#d8ddd8', .28, .46), graphite = material('#152329', .45, .36), edge = material('#405058', .75, .27);
  box(cabin, graphite, 0, -1.1, 0, 7.4, .3, 12);
  box(cabin, shell, -3.6, 2, 0, .3, 6.4, 10); box(cabin, shell, 3.6, 2, 0, .3, 6.4, 10);
  box(cabin, graphite, 0, 5.1, 0, 7.4, .3, 10);
  // Windshield has open geometry, so the view always has real depth.
  for (const x of [-3.45, 3.45]) beam(cabin, v(x, -.5, -3.5), v(x * .75, 5, -3.5), .16, edge);
  beam(cabin, v(-3.4, .35, -3.5), v(3.4, .35, -3.5), .16, edge);
  beam(cabin, v(-2.6, 4.9, -3.5), v(2.6, 4.9, -3.5), .18, edge);
  beam(cabin, v(0, 4.9, -3.5), v(0, 3.8, -3.5), .07, edge);
  const teal = new THREE.MeshBasicMaterial({ color: '#8ff4e1' });
  for (const x of [-3.35, 3.35]) {
    box(cabin, teal, x, 3.8, .1, .035, .07, 7);
    for (let z = -2; z < 5; z += 1.5) {
      box(cabin, edge, x, 1.8, z, .15, 3.7, .055);
      box(cabin, graphite, x, 1.6, z + .6, .19, 1.8, .95);
    }
  }
  const dash = box(cabin, graphite, 0, -.02, -1.6, 6.5, .55, 2.5); dash.rotation.x = .14;
  const screenCanvas = document.createElement('canvas'); screenCanvas.width = 1536; screenCanvas.height = 512;
  const screenTexture = new THREE.CanvasTexture(screenCanvas); screenTexture.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTexture });
  const display = mesh(cabin, new THREE.PlaneGeometry(5.8, 1.93), screenMat, 0, .25, -1.7); display.rotation.x = -Math.PI / 2 + .27;
  for (let i = 0; i < 20; i++) {
    const x = -2.8 + i * .3;
    box(cabin, i % 5 === 0 ? new THREE.MeshBasicMaterial({ color: '#ffb679' }) : teal, x, .13, -.22, .06, .04, .12);
  }
  mesh(cabin, new THREE.PlaneGeometry(2.8, .7), label('ARES · FLIGHT SYSTEMS'), 0, 4.5, -3.25);
  for (const x of [-1, 1]) {
    const sleeve = mesh(cabin, new THREE.CapsuleGeometry(.2, .8, 6, 16), shell, x, -.3, 2.1); sleeve.rotation.x = -.8;
    const glove = mesh(cabin, new THREE.CapsuleGeometry(.19, .24, 6, 16), shell, x, .12, 1.7); glove.rotation.x = -1;
    mesh(cabin, new THREE.SphereGeometry(.1, 16, 12), shell, x - Math.sign(x) * .18, .15, 1.62);
    const grip = mesh(cabin, new THREE.CylinderGeometry(.065, .08, .5, 12), graphite, x, .22, 1.51); grip.rotation.x = -.2;
    box(cabin, edge, x, -.7, 2.5, .7, .25, 2);
  }
  const cabinLight = new THREE.PointLight('#b3f5e9', 8, 10); cabinLight.position.set(0, 3, 2); scene.add(cabinLight);
  const terrainGeo = new THREE.PlaneGeometry(1800, 1800, 200, 200); terrainGeo.rotateX(-Math.PI / 2);
  const noise = new SimplexNoise({ random: mulberry32(121) }); const pos = terrainGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const flat = Math.min(1, Math.hypot(x, z) / 110);
    pos.setY(i, flat * (noise.noise(x / 130, z / 130) * 24 + noise.noise(x / 35, z / 35) * 4));
  }
  terrainGeo.computeVertexNormals();
  const terrain = mesh(scene, terrainGeo, material('#af6944'), 0, -120, -280);
  const descent = new THREE.Group(); terrain.add(descent);
  for (let i = 0; i < 140; i++) {
    const x = (rand() - .5) * 700, z = (rand() - .5) * 700, scale = 1 + rand() * 5;
    if (Math.hypot(x, z) < 80) continue;
    const rock = mesh(descent, new THREE.DodecahedronGeometry(scale, 0), material('#81543e'), x, 0, z); rock.rotation.set(rand(), rand(), rand());
  }
  return { scene, cabin, earth, mars, terrain, stars, screenCanvas, screenTexture, disposePending: () => { disposed = true; } };
}

export class Journey {
  constructor({ renderer, input, onComplete }) {
    this.renderer = renderer; this.input = input; this.onComplete = onComplete;
    this.elapsed = 0; this.active = false; this.done = false; this.paused = false; this.speed = 1; this.lastChapter = -1;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.pad = padScene(); this.flight = flightScene();
    this.camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, .06, 2400);
    this.look = new THREE.Vector2(); this.clock = 0;
    this.el = document.getElementById('journey');
    this.el.querySelector('#journeySkip').onclick = () => this.finish();
    this.el.querySelector('#journeyPause').onclick = () => this.togglePause();
    this.el.querySelector('#journeyNext').onclick = () => this.next();
    this.el.querySelector('#journeySpeed').onclick = (e) => { this.speed = this.speed === 1 ? 3 : 1; e.currentTarget.textContent = `${this.speed}× speed`; };
    this.el.querySelector('#journeySound').onclick = () => this.toggleAudio();
    this.el.querySelector('#journeyMotion').onclick = (e) => { this.reduced = !this.reduced; e.currentTarget.setAttribute('aria-pressed', String(this.reduced)); e.currentTarget.textContent = this.reduced ? 'Motion: reduced' : 'Motion: full'; };
    this.el.querySelector('#journeyMotion').textContent = this.reduced ? 'Motion: reduced' : 'Motion: full';
    this.el.querySelector('#journeyMotion').setAttribute('aria-pressed', String(this.reduced));
    this.el.querySelector('#journeyChapters').innerHTML = CHAPTERS.map((c, i) => `<span data-chapter="${i}"><i>${String(i + 1).padStart(2, '0')}</i>${c.name}</span>`).join('');
    this.visibilityHandler = () => { if (document.hidden && this.active && !this.paused) this.togglePause(); };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }
  start() {
    if (this.active || this.done) return;
    this.active = true; this.elapsed = 0;
    document.getElementById('brief').classList.add('hidden');
    this.el.classList.remove('hidden'); document.body.classList.add('in-flight');
    this.input.resetLook(); this.el.querySelector('#journeyPause').focus();
  }
  togglePause() {
    this.paused = !this.paused;
    this.el.querySelector('#journeyPause').textContent = this.paused ? 'Resume' : 'Pause';
    this.el.querySelector('#journeyPause').setAttribute('aria-pressed', String(this.paused));
    if (this.gain) this.gain.gain.setTargetAtTime(this.paused || !this.soundEnabled ? 0 : .018, this.audio.currentTime, .15);
  }
  next() {
    const stage = chapterAt(this.elapsed);
    if (stage.index === CHAPTERS.length - 1) this.finish();
    else { this.elapsed = stage.start + stage.duration; this.input.resetLook(); }
  }
  toggleAudio() {
    if (!this.audio) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) { this.el.querySelector('#journeySound').textContent = 'Audio unavailable'; return; }
      this.audio = new Context(); this.osc = this.audio.createOscillator(); this.gain = this.audio.createGain();
      this.osc.type = 'sine'; this.osc.frequency.value = 54; this.gain.gain.value = 0;
      this.osc.connect(this.gain).connect(this.audio.destination); this.osc.start();
    }
    this.soundEnabled = !this.soundEnabled;
    this.audio.resume().catch(() => {});
    this.gain.gain.setTargetAtTime(this.soundEnabled && !this.paused ? .018 : 0, this.audio.currentTime, .2);
    this.el.querySelector('#journeySound').textContent = this.soundEnabled ? 'Sound: on' : 'Sound: off';
    this.el.querySelector('#journeySound').setAttribute('aria-pressed', String(this.soundEnabled));
  }
  finish() {
    if (this.done) return;
    this.done = true; this.active = false;
    this.el.classList.add('hidden'); document.body.classList.remove('in-flight', 'at-launch');
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.flight.disposePending();
    if (this.audio) this.audio.close().catch(() => {});
    // The Mars renderer reuses the same canvas; release the launch sequence's GPU allocations.
    const geometries = new Set(), materials = new Set(), textures = new Set();
    for (const scene of [this.pad, this.flight.scene]) scene.traverse((o) => {
      if (o.geometry) geometries.add(o.geometry);
      for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) if (mat) { materials.add(mat); if (mat.map) textures.add(mat.map); }
      if (o.shadow) o.shadow.dispose();
    });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
    this.onComplete();
  }
  drawScreen(stage) {
    const c = this.flight.screenCanvas.getContext('2d');
    c.fillStyle = '#061419'; c.fillRect(0, 0, 1536, 512);
    c.strokeStyle = '#275057'; c.lineWidth = 2;
    for (const x of [512, 1024]) { c.beginPath(); c.moveTo(x, 20); c.lineTo(x, 490); c.stroke(); }
    c.fillStyle = '#8dc1bf'; c.font = '20px monospace';
    c.fillText('01 / FLIGHT DIRECTOR', 35, 50); c.fillText('02 / TRANSFER', 550, 50); c.fillText('03 / VEHICLE', 1060, 50);
    c.fillStyle = '#e0f4eb'; c.font = 'bold 40px monospace'; c.fillText(stage.name.toUpperCase(), 35, 112);
    c.font = '21px monospace'; c.fillText('GUIDANCE    NOMINAL', 35, 385); c.fillText('CABIN       SEALED', 35, 435);
    c.strokeStyle = '#8de5d3'; c.lineWidth = 3;
    c.beginPath(); c.arc(260, 245, 85, 0, Math.PI * 2); c.moveTo(135, 245); c.lineTo(385, 245); c.moveTo(260, 150); c.lineTo(260, 340); c.stroke();
    c.strokeStyle = '#4b8589'; c.beginPath(); c.ellipse(765, 250, 155, 80, -.45, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#96e8dc'; c.beginPath(); c.arc(650, 305, 13, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ec9d70'; c.beginPath(); c.arc(890, 195, 18, 0, Math.PI * 2); c.fill();
    c.font = '18px monospace'; c.fillText('SCHEMATIC · NOT TO SCALE', 580, 435);
    const fields = [['CABIN', '101 kPa'], ['OXYGEN', 'NOMINAL'], ['THERMAL', 'NOMINAL'], ['POWER', 'NOMINAL']];
    fields.forEach(([key, value], i) => { c.fillStyle = '#7aa6aa'; c.font = '20px monospace'; c.fillText(key, 1060, 145 + i * 85); c.fillStyle = '#c8efe4'; c.font = '26px monospace'; c.fillText(value, 1250, 145 + i * 85); });
    this.flight.screenTexture.needsUpdate = true;
  }
  render(dt) {
    if (this.done) return false;
    if (this.active && !this.paused) this.clock += dt; this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    if (!this.active) {
      this.camera.position.set(38, 34, 63); this.camera.lookAt(-12, 27, 0);
      this.renderer.render(this.pad, this.camera); return true;
    }
    if (this.input.hit('escape', ' ')) this.togglePause();
    if (!this.paused) this.elapsed += dt * this.speed;
    const stage = chapterAt(this.elapsed), p = ease(stage.progress), f = this.flight;
    if (stage.complete) { this.finish(); return false; }
    if (stage.index !== this.lastChapter) {
      this.lastChapter = stage.index; this.input.resetLook();
      this.el.querySelector('#journeyTitle').textContent = stage.title;
      this.el.querySelector('#journeyCaption').textContent = stage.caption;
      this.el.querySelector('#journeyStatus').textContent = stage.label;
      this.el.querySelector('#journeyDetail').textContent = stage.detail;
      this.el.querySelector('#journeyNext').textContent = stage.id === 'land' ? 'Begin surface mission →' : 'Next chapter →';
      this.el.querySelectorAll('[data-chapter]').forEach(el => { el.classList.toggle('current', +el.dataset.chapter === stage.index); el.classList.toggle('passed', +el.dataset.chapter < stage.index); });
      this.drawScreen(stage);
    }
    this.el.querySelector('#journeyProgress').style.width = `${this.elapsed / TOTAL_DURATION * 100}%`;
    this.el.querySelector('#journeyTime').textContent = `${Math.floor(this.elapsed).toString().padStart(2, '0')} / ${TOTAL_DURATION} SEC`;
    this.look.lerp(new THREE.Vector2(this.input.look.yaw, this.input.look.pitch), 1 - Math.exp(-dt * 8));
    if (stage.id === 'board') {
      this.camera.position.set(mix(12, 2.8, p), 41.7 + (this.reduced ? 0 : Math.sin(p * 60) * .035), 0);
      this.camera.lookAt(-2, 41.4, -.05);
      this.camera.rotateY(this.look.x * .5); this.camera.rotateX(this.look.y * .5);
      this.renderer.render(this.pad, this.camera); return true;
    }
    this.camera.position.set(0, 1.65, 3.5); this.camera.rotation.set(.06 + this.look.y * .55, this.look.x * .65, 0, 'YXZ');
    const shake = stage.id === 'launch' && !this.reduced ? Math.sin(stage.progress * Math.PI) * .013 : 0;
    this.camera.position.x += Math.sin(this.elapsed * 46) * shake;
    this.camera.position.y += Math.cos(this.elapsed * 57) * shake;
    f.earth.visible = ['launch', 'orbit', 'cruise'].includes(stage.id);
    f.mars.visible = ['cruise', 'approach'].includes(stage.id); f.terrain.visible = stage.id === 'land';
    f.stars.visible = stage.id !== 'land'; f.scene.fog = null;
    f.scene.background.set(stage.id === 'land' ? '#ba8f74' : '#02060b');
    f.earth.position.set(-15, -50, -100); f.earth.scale.setScalar(1);
    f.earth.rotation.y = this.elapsed * .004; f.mars.rotation.y = .4 + this.elapsed * .003;
    if (stage.id === 'launch') {
      f.scene.background.set(new THREE.Color('#8cbdcc').lerp(new THREE.Color('#02060b'), p));
      f.earth.position.set(0, mix(-365, -52, p), -160); f.earth.scale.setScalar(mix(6, 1.4, p));
    } else if (stage.id === 'orbit') {
      f.earth.position.set(mix(0, -22, p), mix(-52, -48, p), mix(-120, -130, p)); f.earth.scale.setScalar(1.4);
    } else if (stage.id === 'cruise') {
      f.earth.position.set(-60 - p * 100, -30, -150 - p * 500); f.earth.scale.setScalar(1.4 - p);
      f.mars.position.set(15, 10, -650 + p * 350); f.mars.scale.setScalar(.25 + p * .35);
    } else if (stage.id === 'approach') {
      f.mars.scale.setScalar(1); f.mars.position.set(mix(15, 0, p), mix(5, -17, p), mix(-220, -80, p));
    } else if (stage.id === 'land') {
      f.scene.fog = new THREE.Fog('#ba8f74', 100, 900);
      f.terrain.position.y = mix(-140, -5, p); f.terrain.position.z = mix(-180, 0, p);
    }
    this.renderer.render(f.scene, this.camera); return true;
  }
}
