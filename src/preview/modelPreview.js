import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEnvironment, SUN_DIR } from '../world/atmosphere.js';
import { buildRoverV2 } from '../rover/roverModelV2.js';
import { createMarkerPost } from '../world/markerPost.js';
import { Rover } from '../rover/rover.js';

// Standalone page to review the v2 rover and marker post before they replace the in-game models.
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#c99a74');
scene.fog = new THREE.Fog('#c99a74', 30, 90);
const env = createEnvironment(renderer);
scene.environment = env;
scene.environmentIntensity = 0.38;
scene.add(new THREE.HemisphereLight(0xe0b48c, 0x4a2618, 0.42));
const sun = new THREE.DirectionalLight(0xfff0dc, 3.3);
sun.position.copy(SUN_DIR).multiplyScalar(30);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 80 });
sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.02; sun.shadow.radius = 3;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#8a4f31', roughness: 0.95 }));
ground.receiveShadow = true;
scene.add(ground);

const v2 = buildRoverV2(env);
scene.add(v2.group);
const posts = [];
for (const [x, z] of [[2.6, -1.5], [-2.6, -1.5], [2.6, 2.5]]) {
  const p = createMarkerPost();
  p.group.position.set(x, 0, z);
  scene.add(p.group);
  posts.push(p.group);
}
const old = new Rover(env);
old.root.position.set(-4.5, 0, 0);
old.root.visible = false;
old.driver.visible = true; old.driverLegs.visible = false;
scene.add(old.root);

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const views = {
  hero: [[-4.2, 2.6, -5.2], [0, 1.0, 0]],
  front: [[0, 1.3, -7.5], [0, 1.2, 0]],
  side: [[7.5, 1.3, 0], [0, 1.2, 0]],
  top: [[0, 9, 0.01], [0, 0, 0]],
  post: [[1.6, 1.5, -3.9], [2.6, 0.85, -1.5]],
  compare: [[-2.2, 3.2, -8.5], [-2.2, 1.0, 0]],
};
function setView(name) {
  const [p, t] = views[name];
  camera.position.set(...p); controls.target.set(...t);
  old.root.visible = name === 'compare';
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === name));
}
document.getElementById('ui').addEventListener('click', (e) => { const v = e.target.dataset?.view; if (v) setView(v); });
setView('hero');

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop((t) => {
  for (const w of v2.wheels) w.spin.rotation.x = -t * 0.0008;
  controls.update();
  renderer.render(scene, camera);
});
