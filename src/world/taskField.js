import * as THREE from 'three';
import { mulberry32 } from '../core/math.js';

// ---------------------------------------------------------------------------
// In-world markers for the first-person station tasks: the rocks to scan
// with holographic target rings, a bedded slab for laser ranging, camera frame
// guides for panoramas and the radar line on the ground. Built when a task
// starts and removed when it ends.
// ---------------------------------------------------------------------------

const CYAN = new THREE.Color('#77edff');
const GREEN = new THREE.Color('#5cff9a');
const IDLE = new THREE.Color('#d6e6ea');

function rockGeometry(size, seed) {
  const r = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(size, 2);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 0.82 + 0.18 * Math.sin(v.x * 7 + seed) * Math.cos(v.z * 6 - seed) + (r() - 0.5) * 0.08;
    v.multiplyScalar(n);
    v.y *= 0.7;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function bandedTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d');
  const colors = ['#8b5c43', '#a8765a', '#6f4733', '#b98a6b', '#7c513b', '#9b6a4f'];
  for (let y = 0, i = 0; y < 256; i++) {
    const h = 14 + ((i * 37) % 23);
    g.fillStyle = colors[i % colors.length];
    g.fillRect(0, y, 64, h);
    y += h;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ring(radius, color) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.86, radius, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, side: THREE.DoubleSide, toneMapped: false }),
  );
  mesh.renderOrder = 5;
  return mesh;
}

export class TaskField {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'task-field';
    scene.add(this.group);
    this.items = [];
    this.task = null;
    this._q = new THREE.Quaternion();
  }

  clear() {
    for (const child of [...this.group.children]) {
      child.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose(); m.dispose(); });
      });
      this.group.remove(child);
    }
    this.items = [];
    this.task = null;
  }

  show(task, eye) {
    this.clear();
    this.task = task;
    if (task.kind === 'scan') this._scan(task, eye);
    else if (task.kind === 'pano') this._pano(task, eye);
    else if (task.kind === 'sweep') this._sweep(task);
  }

  _scan(task, eye) {
    task.targets.forEach((t, i) => {
      if (t.rock) {
        const rock = new THREE.Mesh(rockGeometry(t.rock, i * 7 + 3),
          new THREE.MeshStandardMaterial({ color: new THREE.Color('#5a4a44').offsetHSL(0, 0, (i % 3) * 0.05), roughness: 0.85, flatShading: true }));
        rock.position.set(t.ground.x, t.ground.y + t.rock * 0.15, t.ground.z);
        rock.rotation.y = i * 1.7;
        rock.castShadow = rock.receiveShadow = true;
        this.group.add(rock);
      }
      if (t.slab && t.bed === 0) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.3, 0.7),
          new THREE.MeshStandardMaterial({ map: bandedTexture(), roughness: 0.92 }));
        slab.position.set(t.slab.x, t.slab.y + 1.05, t.slab.z);
        slab.rotation.y = Math.atan2(eye.x - t.slab.x, eye.z - t.slab.z);
        slab.castShadow = slab.receiveShadow = true;
        this.group.add(slab);
      }
      const halo = ring(t.radius, CYAN);
      halo.position.set(t.pos.x, t.pos.y, t.pos.z);
      if (t.slab) {
        // Rings sit on the slab face, toward the crew.
        const toward = new THREE.Vector3(eye.x - t.slab.x, 0, eye.z - t.slab.z).normalize();
        halo.position.addScaledVector(toward, 0.4);
      }
      this.group.add(halo);
      this.items.push({ kind: 'target', ref: t, mesh: halo });
    });
  }

  _pano(task, eye) {
    for (const s of task.sectors) {
      const frame = new THREE.Group();
      const w = 5.6, h = 3.5, d = 24;
      const corner = (x, y) => new THREE.Vector3(x, y, 0);
      const pts = [];
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        // L-shaped corner marks, like a viewfinder.
        pts.push(corner(x * w / 2, y * h / 2), corner(x * w / 2 - x * 1.2, y * h / 2));
        pts.push(corner(x * w / 2, y * h / 2), corner(x * w / 2, y * h / 2 - y * 1.0));
      }
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: IDLE, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
      lines.renderOrder = 6;
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: GREEN, transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false }));
      fill.renderOrder = 5;
      frame.add(fill, lines);
      frame.position.set(eye.x + s.dir.x * d, eye.y + s.dir.y * d, eye.z + s.dir.z * d);
      frame.lookAt(eye.x, eye.y, eye.z);
      this.group.add(frame);
      this.items.push({ kind: 'frame', ref: s, lines, fill, flash: 0 });
    }
  }

  _sweep(task) {
    const n = task.samples.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    task.samples.forEach((s, i) => positions.set([s.pos.x, s.pos.y + 0.04, s.pos.z], i * 3));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }));
    const dots = new THREE.Points(geo, new THREE.PointsMaterial({ vertexColors: true, size: 0.28, sizeAttenuation: true, toneMapped: false }));
    line.renderOrder = dots.renderOrder = 4;
    this.group.add(line, dots);
    for (const end of [task.samples[0], task.samples.at(-1)]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.9, 8),
        new THREE.MeshStandardMaterial({ color: '#ff7a2a', emissive: '#ff5a10', emissiveIntensity: 0.6 }));
      post.position.set(end.pos.x, end.pos.y + 0.45, end.pos.z);
      this.group.add(post);
    }
    this.items.push({ kind: 'line', geo, colors });
  }

  update(dt, camera, time) {
    const task = this.task;
    if (!task) return;
    camera.getWorldQuaternion(this._q);
    for (const item of this.items) {
      if (item.kind === 'target') {
        const t = item.ref;
        const active = task.current === t;
        item.mesh.quaternion.copy(this._q); // rings face the viewer
        const pulse = active ? 1 + 0.08 * Math.sin(time * 6) : 1;
        const shrink = active ? 1 - 0.35 * t.lock : 1;
        item.mesh.scale.setScalar(pulse * shrink);
        item.mesh.material.color.copy(t.done ? GREEN : active ? (task.onTarget ? GREEN : CYAN) : IDLE);
        item.mesh.material.opacity = t.done ? 0.35 : active ? 0.95 : 0.4;
      } else if (item.kind === 'frame') {
        const s = item.ref;
        const near = task.near === s;
        item.lines.material.color.copy(s.done ? GREEN : near ? CYAN : IDLE);
        item.lines.material.opacity = s.done ? 0.5 : near ? 1 : 0.75;
        if (s.done && !item.captured) { item.captured = true; item.flash = 1; }
        item.flash = Math.max(0, item.flash - dt * 2.2);
        item.fill.material.opacity = item.flash * 0.45 + (s.done ? 0.08 : near ? 0.08 + 0.2 * (s.settle / task.settle) : 0.05);
        item.fill.material.color.copy(s.done || near ? GREEN : IDLE);
      } else if (item.kind === 'line') {
        const next = task.next;
        task.samples.forEach((s, i) => {
          const c = s.done ? GREEN : s === next ? IDLE : CYAN;
          const k = s === next ? 0.75 + 0.25 * Math.sin(time * 8) : 1;
          item.colors.set([c.r * k, c.g * k, c.b * k], i * 3);
        });
        item.geo.attributes.color.needsUpdate = true;
      }
    }
  }
}
