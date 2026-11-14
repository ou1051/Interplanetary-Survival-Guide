import * as THREE from 'three';
import { mulberry32 } from '../core/math.js';

// Sun position (late afternoon, low in the WSW → long shadows).
const SUN_EL = 24 * (Math.PI / 180);
const SUN_AZ = 250 * (Math.PI / 180); // from north, clockwise
export const SUN_DIR = new THREE.Vector3(
  Math.cos(SUN_EL) * Math.sin(SUN_AZ),
  Math.sin(SUN_EL),
  -Math.cos(SUN_EL) * Math.cos(SUN_AZ),
).normalize();

export const HORIZON = new THREE.Color('#d2a07a');
export const ZENITH = new THREE.Color('#7a5440');

const skyVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // always at the far plane
  }
`;
const skyFrag = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float t = pow(clamp(h, 0.0, 1.0), 0.42);
    vec3 col = mix(uHorizon, uZenith, t);
    vec3 ground = uHorizon * vec3(0.72, 0.62, 0.55);
    if (h < 0.0) col = mix(uHorizon, ground, smoothstep(0.0, -0.2, h));
    float c = dot(d, normalize(uSun));
    // Martian sky: a pale bluish aureole around the sun, warm haze elsewhere
    col = mix(col, vec3(0.62, 0.66, 0.70), pow(max(c, 0.0), 22.0) * 0.6);
    col += vec3(0.55, 0.42, 0.30) * pow(max(c, 0.0), 5.0) * 0.25;
    float disc = smoothstep(0.99982, 0.99992, c);
    col += vec3(1.0, 0.96, 0.9) * disc * 14.0;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createSky() {
  const geo = new THREE.SphereGeometry(10, 48, 24);
  const mat = new THREE.ShaderMaterial({
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    uniforms: {
      uSun: { value: SUN_DIR.clone() },
      uHorizon: { value: HORIZON.clone() },
      uZenith: { value: ZENITH.clone() },
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'sky';
  return mesh;
}

// Image-based lighting for the metal rover parts, rendered from the sky itself.
export function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const sky = createSky();
  sky.scale.setScalar(50);
  envScene.add(sky);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(400, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#7b4a32') }),
  );
  ground.position.y = -2;
  envScene.add(ground);
  const rt = pmrem.fromScene(envScene, 0.02);
  pmrem.dispose();
  return rt.texture;
}

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Floating dust motes around the viewer (wrapped in a box that follows the camera).
export class DustMotes {
  constructor(count = 900, box = 36) {
    this.box = box;
    const r = mulberry32(7);
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (r() - 0.5) * box;
      pos[i * 3 + 1] = (r() - 0.5) * box * 0.4;
      pos[i * 3 + 2] = (r() - 0.5) * box;
    }
    this.base = pos.slice();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.05,
        map: softDot(),
        color: 0xe8c6a0,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.points.frustumCulled = false;
    this.wind = new THREE.Vector3(1.4, 0.05, 0.6);
    this.offset = new THREE.Vector3();
  }

  update(dt, center) {
    this.offset.addScaledVector(this.wind, dt);
    const arr = this.points.geometry.attributes.position.array;
    const B = this.box;
    const wrap = (v) => ((((v + B / 2) % B) + B) % B) - B / 2;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = center.x + wrap(this.base[i] + this.offset.x - center.x);
      arr[i + 1] = center.y + wrap(this.base[i + 1] + this.offset.y + Math.sin(this.offset.x * 0.3 + i) * 0.2 - center.y) * 0.4;
      arr[i + 2] = center.z + wrap(this.base[i + 2] + this.offset.z - center.z);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// Ballistic dust kicked up by the wheels (Mars g = 3.71 m/s²).
export class WheelDust {
  constructor(max = 700) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.22,
        map: softDot(),
        color: 0xc99467,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
    this.rand = mulberry32(3);
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -9999;
  }

  emit(x, y, z, vx, vz, speed) {
    const r = this.rand;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x + (r() - 0.5) * 0.3;
    this.pos[i * 3 + 1] = y + 0.05;
    this.pos[i * 3 + 2] = z + (r() - 0.5) * 0.3;
    this.vel[i * 3] = vx * (0.5 + r() * 0.6) + (r() - 0.5) * 0.6;
    this.vel[i * 3 + 1] = 0.6 + r() * 1.2 * Math.min(1, speed / 3);
    this.vel[i * 3 + 2] = vz * (0.5 + r() * 0.6) + (r() - 0.5) * 0.6;
    this.life[i] = 1.2 + r() * 1.0;
  }

  update(dt, groundAt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const o = i * 3;
      this.vel[o + 1] -= 3.71 * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const g = groundAt(this.pos[o], this.pos[o + 2]);
      if (this.pos[o + 1] < g || this.life[i] <= 0) {
        this.life[i] = 0;
        this.pos[o + 1] = -9999;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
