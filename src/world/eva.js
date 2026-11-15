// @ts-nocheck
import * as THREE from 'three';
import { createAstronaut } from './astronaut-eva.js';
import { createHabitatInterior } from './habitat-interior.js';

// ---------------------------------------------------------------------------
// EVA walk mode.
//
//   F      exit the rover  /  board it again  /  enter the habitat  /  leave it
//   WASD   walk (arrows turn)   Shift run   Space low-gravity jump   X first/third person
//   drag the mouse to look around
//
// States: rover -> exiting -> walking -> entering -> rover
//                              walking -> (fade) -> inside -> (fade) -> walking
//
// It does NOT edit any of your files. It takes the camera while you are on foot, and
// gives it back (same parent, same local transform) when you board again.
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
const G = 3.71; // Mars gravity, m/s^2
const WALK = 1.6;
const RUN = 3.4;
const JUMP = 3.2;
const EYE = 1.65;
const MAX_SLOPE = 32 * RAD;
const INTERIOR_Y = 4000;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const angLerp = (a, b, k) => a + ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * k;
const ease = (t) => t * t * (3 - 2 * t);

/** pass this to mission.update / rover.animate while on foot so the rover stays put */
export const IDLE_INPUT = Object.freeze({ throttle: false, brake: false, steer: 0, action: false, boost: false, look: Object.freeze({ yaw: 0, pitch: 0 }) });

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext && c.getContext('2d');
  if (!g) return null;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class EvaWalk {
  constructor({
    scene, camera, domElement, roverRoot, heightAt,
    habitat = null, // { x, z, outX, outZ, radius } door position and the unit vector pointing OUT of the door
    sun = null, sunDir = null, hemi = null,
    onLog = () => {}, onView = () => {}, onExit = () => {}, onBoard = () => {},
    onEnterHabitat = () => {}, onLeaveHabitat = () => {}, onStep = () => {},
    canExit = () => true, getStatus = null,
    keys = {}, tetherM = 120, exitLocal = new THREE.Vector3(2.4, 0, 0.3), ui = true, startView = 'third',
  }) {
    Object.assign(this, { scene, camera, domElement, roverRoot, heightAt, habitat, sun, sunDir, hemi, onLog, onView, onExit, onBoard, onEnterHabitat, onLeaveHabitat, onStep, canExit, getStatus, tetherM, exitLocal });
    this.keys = { interact: 'f', view: 'x', ...keys };
    this.viewMode = startView;
    this.state = 'rover';
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.12;
    this.faceYaw = 0;
    this.speed = 0;
    this.vdx = 0;
    this.vdz = -1;
    this.vy = 0;
    this.onGround = true;
    this.stride = 0;
    this.foot = 1;
    this.t = 0;
    this.sinceExit = 0;
    this.down = new Set();
    this.anim = null;
    this.fade = null;
    this.interior = null;
    this.saved = null;
    this.prompt = '';
    this._tetherWarn = 0;
    this._camSnap = true;

    this.astro = createAstronaut();
    this.astro.root.visible = false;
    scene.add(this.astro.root);
    this._buildFx();
    if (ui && typeof document !== 'undefined') this._buildUi();
    this._bind();
  }

  get active() {
    return this.state !== 'rover';
  }
  get inside() {
    return this.state === 'inside';
  }

  // ------------------------------------------------------------------ input
  _bind() {
    this._kd = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key === ' ' ? 'space' : e.key.toLowerCase();
      if (this.active && (k === 'space' || k.startsWith('arrow'))) e.preventDefault();
      if (!e.repeat) {
        if (k === this.keys.interact) this._interact();
        else if (k === this.keys.view && this.active) this.toggleView();
      }
      this.down.add(k);
    };
    this._ku = (e) => this.down.delete(e.key === ' ' ? 'space' : e.key.toLowerCase());
    this._blur = () => this.down.clear();
    window.addEventListener('keydown', this._kd);
    window.addEventListener('keyup', this._ku);
    window.addEventListener('blur', this._blur);

    // drag to look (only while on foot)
    this._drag = null;
    this._pd = (e) => {
      if (this.active && e.button === 0) this._drag = { x: e.clientX, y: e.clientY };
    };
    this._pm = (e) => {
      if (!this._drag || !this.active) return;
      this.yaw -= (e.clientX - this._drag.x) * 0.0042;
      this.pitch = clamp(this.pitch - (e.clientY - this._drag.y) * 0.0042, -1.0, 0.8);
      this._drag = { x: e.clientX, y: e.clientY };
    };
    this._pu = () => (this._drag = null);
    const el = this.domElement || window;
    el.addEventListener('pointerdown', this._pd);
    window.addEventListener('pointermove', this._pm);
    window.addEventListener('pointerup', this._pu);
  }

  dispose() {
    window.removeEventListener('keydown', this._kd);
    window.removeEventListener('keyup', this._ku);
    window.removeEventListener('blur', this._blur);
    (this.domElement || window).removeEventListener('pointerdown', this._pd);
    window.removeEventListener('pointermove', this._pm);
    window.removeEventListener('pointerup', this._pu);
    if (this.promptEl) this.promptEl.remove();
    if (this.fadeEl) this.fadeEl.remove();
    this.scene.remove(this.astro.root, this.puffs.points, this.printGroup);
  }

  isDown(...ks) {
    return ks.some((k) => this.down.has(k));
  }

  toggleView() {
    if (this.state === 'inside') return;
    this.viewMode = this.viewMode === 'third' ? 'first' : 'third';
    this._camSnap = true;
    this._applyView();
    this.onLog(`Camera: ${this.viewMode === 'third' ? 'third person' : 'first person'}`, 'info');
  }

  _applyView() {
    if (this.state === 'walking') {
      this.astro.root.visible = this.viewMode === 'third';
      this.onView(this.viewMode);
    }
  }

  // ------------------------------------------------------------------ actions
  _roverPos() {
    this.roverRoot.updateWorldMatrix(true, false);
    return this.roverRoot.getWorldPosition(new THREE.Vector3());
  }
  _distToRover() {
    const r = this._roverPos();
    return Math.hypot(this.pos.x - r.x, this.pos.z - r.z);
  }
  _distToDoor() {
    const h = this.habitat;
    return h ? Math.hypot(this.pos.x - h.x, this.pos.z - h.z) : Infinity;
  }

  /** what can be used from here: the rover or the habitat door (the closer one wins) */
  _nearTarget() {
    const dr = this._distToRover();
    const dd = this._distToDoor();
    const rOk = dr < 4.5;
    const dOk = !!this.habitat && dd < (this.habitat.radius ?? 6);
    if (rOk && dOk) return dr <= dd ? 'rover' : 'door';
    return rOk ? 'rover' : dOk ? 'door' : null;
  }

  _interact() {
    if (this.anim || this.fade) return;
    if (this.state === 'rover') {
      if (this.canExit()) this.exitRover();
    } else if (this.state === 'walking') {
      const near = this._nearTarget();
      if (near === 'rover') this.boardRover();
      else if (near === 'door') this._enterHabitat();
    } else if (this.state === 'inside') {
      if (this.pos.z > this.interior.exitZ && Math.abs(this.pos.x) < 1.2) this._leaveHabitat();
    }
  }

  exitRover() {
    const cam = this.camera;
    this.saved = { parent: cam.parent, p: cam.position.clone(), q: cam.quaternion.clone() };
    cam.updateWorldMatrix(true, false);
    const seat = cam.getWorldPosition(new THREE.Vector3());
    seat.y -= 0.95;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.roverRoot.getWorldQuaternion(new THREE.Quaternion()));
    this.yaw = Math.atan2(-fwd.x, -fwd.z);
    this.faceYaw = this.yaw;
    this.pitch = -0.1;
    this.scene.attach(cam);
    this.roverRoot.updateWorldMatrix(true, false);
    const out = this.roverRoot.localToWorld(this.exitLocal.clone());
    out.y = this.heightAt(out.x, out.z);
    this._startAnim(seat, out, 'out');
    this.state = 'exiting';
    this.sinceExit = 0;
    this.astro.root.visible = true;
    this._camSnap = true;
    this.onExit();
    this.onLog('EVA: stepping out of the rover', 'info');
  }

  boardRover() {
    const s = this.saved;
    s.parent.updateWorldMatrix(true, false);
    const seat = s.p.clone().applyMatrix4(s.parent.matrixWorld);
    seat.y -= 0.95;
    this._startAnim(this.pos.clone(), seat, 'in');
    this.state = 'entering';
    this.astro.root.visible = true;
    this._camSnap = true;
    this.onLog('EVA: boarding the rover', 'info');
  }

  _startAnim(p0, p2, kind) {
    const p1 = p0.clone().lerp(p2, 0.55);
    p1.y = Math.max(p0.y, p2.y) + 0.95;
    this.anim = { t: 0, dur: 2.1, p0: p0.clone(), p1, p2: p2.clone(), kind };
    this.pos.copy(p0);
  }

  _finishExit() {
    this.pos.copy(this.anim.p2);
    this.onGround = true;
    this.vy = 0;
    this.anim = null;
    this.astro.setClimb(0);
    this.state = 'walking';
    this._applyView();
    this._camSnap = true;
    this.onLog('Walk: WASD · Shift run · Space jump · X camera · F interact', 'info');
  }

  _finishBoard() {
    const s = this.saved;
    s.parent.add(this.camera);
    this.camera.position.copy(s.p);
    this.camera.quaternion.copy(s.q);
    this.anim = null;
    this.astro.setClimb(0);
    this.astro.root.visible = false;
    this.state = 'rover';
    this.speed = 0;
    this.onView('rover');
    this.onBoard();
    this.onLog('EVA complete: back aboard the rover', 'ok');
  }

  _enterHabitat() {
    this._startFade(() => {
      if (!this.interior) this.interior = createHabitatInterior({ getStatus: this.getStatus });
      const hab = this.interior;
      hab.group.position.set(0, INTERIOR_Y, 0);
      this.scene.add(hab.group);
      this.saved2 = { sun: this.sun ? this.sun.visible : true, hemi: this.hemi ? this.hemi.visible : true };
      if (this.sun) this.sun.visible = false;
      if (this.hemi) this.hemi.visible = false;
      this.astro.root.visible = false;
      // the interior is parked high above the terrain: make sure the camera can see that far
      this._farBackup = this.camera.far;
      if (this.camera.far < INTERIOR_Y + 2000) {
        this.camera.far = INTERIOR_Y + 2000;
        this.camera.updateProjectionMatrix();
      }
      this.pos.set(hab.spawn.x, INTERIOR_Y, hab.spawn.z);
      this.yaw = 0;
      this.pitch = 0;
      this.speed = 0;
      this.vy = 0;
      this.onGround = true;
      this.state = 'inside';
      this._camSnap = true;
      this.onView('inside');
      this.onEnterHabitat();
      this.onLog('Entered the habitat: airlock cycle complete', 'ok');
    });
    this.state = 'transition';
  }

  _leaveHabitat() {
    this._startFade(() => {
      this.scene.remove(this.interior.group);
      if (this._farBackup !== undefined && this.camera.far !== this._farBackup) {
        this.camera.far = this._farBackup;
        this.camera.updateProjectionMatrix();
      }
      if (this.sun) this.sun.visible = this.saved2 ? this.saved2.sun : true;
      if (this.hemi) this.hemi.visible = this.saved2 ? this.saved2.hemi : true;
      const h = this.habitat;
      this.pos.set(h.x + h.outX * 3.4, 0, h.z + h.outZ * 3.4);
      this.pos.y = this.heightAt(this.pos.x, this.pos.z);
      this.yaw = Math.atan2(-h.outX, -h.outZ);
      this.faceYaw = this.yaw;
      this.pitch = -0.1;
      this.speed = 0;
      this.state = 'walking';
      this._applyView();
      this._camSnap = true;
      this.onLeaveHabitat();
      this.onLog('Left the habitat: back on the surface', 'info');
    });
    this.state = 'transition';
  }

  _startFade(swap) {
    this.fade = { phase: 'out', t: 0, dur: 0.5, swap };
  }

  // ------------------------------------------------------------------ frame
  /** call once per frame, right before renderer.render() */
  update(dt) {
    this.t += dt;
    this._updateFade(dt);
    this._updateFx(dt);
    if (this.state === 'rover') {
      this._setPrompt(this.canExit() ? `[${this.keys.interact.toUpperCase()}] Exit the rover` : '');
      return;
    }
    this.sinceExit += dt;
    if (this.anim) this._updateAnim(dt);
    if (this.state === 'rover') return; // boarding just finished: the camera is back in the rover, do not touch it
    if (this.anim) {
      /* animating */
    } else if (this.state === 'walking') this._walk(dt, false);
    else if (this.state === 'inside') this._walk(dt, true);

    if (this.state === 'inside') this.interior.update(this.t, dt);
    this._avatar(dt);
    this._placeCamera(dt);
    this._lightFollow();
    this._promptLogic();
  }

  _updateFade(dt) {
    const f = this.fade;
    if (!f) return;
    f.t += dt;
    const a = clamp(f.t / f.dur, 0, 1);
    if (this.fadeEl) this.fadeEl.style.opacity = String(f.phase === 'out' ? a : 1 - a);
    if (a >= 1) {
      if (f.phase === 'out') {
        f.swap();
        f.phase = 'in';
        f.t = 0;
        f.dur = 0.6;
      } else this.fade = null;
    }
  }

  _updateAnim(dt) {
    const a = this.anim;
    a.t += dt;
    const u = clamp(a.t / a.dur, 0, 1);
    const e = ease(u);
    const k = 1 - e;
    const { p0, p1, p2 } = a; // quadratic bezier: out of the seat, over the rail, down to the ground (or back)
    this.pos.set(k * k * p0.x + 2 * k * e * p1.x + e * e * p2.x, k * k * p0.y + 2 * k * e * p1.y + e * e * p2.y, k * k * p0.z + 2 * k * e * p1.z + e * e * p2.z);
    this.astro.setClimb(a.kind === 'out' ? u : 1 - u);
    if (u >= 1) a.kind === 'out' ? this._finishExit() : this._finishBoard();
  }

  _walk(dt, indoors) {
    const fwdIn = (this.isDown('w', 'arrowup') ? 1 : 0) - (this.isDown('s', 'arrowdown') ? 1 : 0);
    const strafe = (this.isDown('d') ? 1 : 0) - (this.isDown('a') ? 1 : 0);
    this.yaw += ((this.isDown('arrowleft') ? 1 : 0) - (this.isDown('arrowright') ? 1 : 0)) * 1.8 * dt;
    const sprint = this.isDown('shift');
    let dx = -Math.sin(this.yaw) * fwdIn + Math.cos(this.yaw) * strafe;
    let dz = -Math.cos(this.yaw) * fwdIn - Math.sin(this.yaw) * strafe;
    const len = Math.hypot(dx, dz);
    if (len > 0) {
      dx /= len;
      dz /= len;
      this.vdx = dx;
      this.vdz = dz;
    }
    const target = len > 0 ? (sprint && !indoors ? RUN : WALK) : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 8);
    const step = this.speed * dt;
    if (step > 1e-5) {
      let nx = this.pos.x + this.vdx * step;
      let nz = this.pos.z + this.vdz * step;
      if (indoors) {
        const h = this.interior;
        if (!h.inside(nx, nz)) {
          if (h.inside(nx, this.pos.z)) nz = this.pos.z;
          else if (h.inside(this.pos.x, nz)) nx = this.pos.x;
          else {
            nx = this.pos.x;
            nz = this.pos.z;
          }
        }
      } else {
        const h1 = this.heightAt(nx, nz);
        const rise = h1 - this.heightAt(this.pos.x, this.pos.z);
        if (this.onGround && Math.atan2(rise, step) > MAX_SLOPE) {
          nx = this.pos.x;
          nz = this.pos.z;
          this.speed *= 0.3;
        }
        // tether: stay within reach of the rover
        const r = this._roverPos();
        const d = Math.hypot(nx - r.x, nz - r.z);
        if (d > this.tetherM) {
          const k = this.tetherM / d;
          nx = r.x + (nx - r.x) * k;
          nz = r.z + (nz - r.z) * k;
          if (this.t - this._tetherWarn > 4) {
            this._tetherWarn = this.t;
            this.onLog('Tether limit reached: return towards the rover', 'warn');
          }
        }
      }
      this.stride += Math.hypot(nx - this.pos.x, nz - this.pos.z);
      this.pos.x = nx;
      this.pos.z = nz;
    }

    // vertical: low-gravity jumps outdoors, flat floor indoors
    if (indoors) {
      this.pos.y = INTERIOR_Y;
      this.onGround = true;
    } else {
      const ground = this.heightAt(this.pos.x, this.pos.z);
      if (this.onGround && this.isDown('space')) {
        this.vy = JUMP;
        this.onGround = false;
        this._puff(this.pos.x, ground, this.pos.z, 6, 1.4);
      }
      if (this.onGround && this.pos.y - ground > 0.2) this.onGround = false; // walked off a ledge
      if (this.onGround) this.pos.y += (ground - this.pos.y) * Math.min(1, dt * 22);
      else {
        this.vy -= G * dt;
        this.pos.y += this.vy * dt;
        if (this.pos.y <= ground) {
          if (this.vy < -1.6) this._puff(this.pos.x, ground, this.pos.z, 12, 1.0 + Math.min(1.5, -this.vy * 0.25));
          this.pos.y = ground;
          this.vy = 0;
          this.onGround = true;
        }
      }
      // footsteps
      const strideLen = sprint ? 1.15 : 0.8;
      if (this.onGround && this.stride > strideLen) {
        this.stride = 0;
        this._footstep();
      }
    }
  }

  // ------------------------------------------------------------------ avatar + camera
  _avatar(dt) {
    const a = this.astro;
    if (this.state === 'inside' || this.state === 'transition') return;
    a.root.position.copy(this.pos);
    if (this.anim) this.faceYaw = this.yaw;
    else if (this.speed > 0.2) this.faceYaw = angLerp(this.faceYaw, Math.atan2(-this.vdx, -this.vdz), Math.min(1, dt * 9));
    a.root.rotation.y = this.faceYaw;
    if (!this.anim) a.animate(dt, { speed: this.speed, airborne: !this.onGround });
  }

  _placeCamera(dt) {
    const cam = this.camera;
    const first = this.state === 'inside' || (this.viewMode === 'first' && this.state === 'walking');
    cam.rotation.order = 'YXZ';
    if (first) {
      const eye = this.state === 'inside' ? this.interior.eyeHeight : EYE;
      cam.position.set(this.pos.x, this.pos.y + eye, this.pos.z);
      cam.rotation.set(this.pitch, this.yaw, 0);
      this._camSnap = false;
      return;
    }
    // third person orbit around the head
    const head = new THREE.Vector3(this.pos.x, this.pos.y + 1.55, this.pos.z);
    const p = this.anim ? -0.18 : this.pitch;
    const yaw = this.anim ? this.yaw - 0.55 : this.yaw; // slightly off to the side while stepping out
    const dist = this.anim ? 5.2 : 4.4;
    const f = new THREE.Vector3(-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
    const want = head.clone().addScaledVector(f, -dist);
    want.y = Math.max(want.y, this.heightAt(want.x, want.z) + 0.6);
    if (this._camSnap) cam.position.copy(want);
    else cam.position.lerp(want, 1 - Math.exp(-14 * dt));
    this._camSnap = false;
    cam.lookAt(head);
  }

  _lightFollow() {
    // keep the shadow frustum on the walker, not on the parked rover
    if (this.sun && this.sunDir && this.state !== 'inside' && this.state !== 'transition') {
      this.sun.target.position.copy(this.pos);
      this.sun.position.copy(this.pos).addScaledVector(this.sunDir, 150);
    }
  }

  // ------------------------------------------------------------------ prompts / UI
  _promptLogic() {
    let text = '';
    const F = this.keys.interact.toUpperCase();
    if (this.state === 'walking') {
      const near = this._nearTarget();
      if (near === 'rover') text = `[${F}] Board the rover`;
      else if (near === 'door') text = `[${F}] Enter the habitat`;
      else if (this.sinceExit < 7) text = 'WASD walk · Shift run · Space jump · X camera · drag to look';
    } else if (this.state === 'inside' && this.pos.z > this.interior.exitZ && Math.abs(this.pos.x) < 1.2) text = `[${F}] Exit the habitat`;
    this._setPrompt(text);
  }
  _setPrompt(text) {
    this.prompt = text;
    if (this.promptEl) {
      this.promptEl.textContent = text;
      this.promptEl.style.opacity = text ? '1' : '0';
    }
  }

  _buildUi() {
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;left:50%;bottom:17%;transform:translateX(-50%);z-index:35;padding:8px 16px;font:600 14px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.1em;color:#7fefff;background:rgba(3,8,10,.7);border:1px solid rgba(127,239,255,.35);pointer-events:none;opacity:0;transition:opacity .2s;white-space:nowrap';
    document.body.appendChild(p);
    this.promptEl = p;
    const f = document.createElement('div');
    f.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;z-index:60;pointer-events:none';
    document.body.appendChild(f);
    this.fadeEl = f;
  }

  // ------------------------------------------------------------------ dust puffs + footprints
  _buildFx() {
    const N = 96;
    this.puffN = N;
    this.puffPos = new Float32Array(N * 3).fill(-9999);
    this.puffVel = new Float32Array(N * 3);
    this.puffLife = new Float32Array(N);
    this.puffCursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.puffPos, 3));
    const map = typeof document !== 'undefined' ? softDot() : null;
    this.puffs = { points: new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.4, map, color: 0xc99467, transparent: true, opacity: 0.5, depthWrite: false })) };
    this.puffs.points.frustumCulled = false;
    this.scene.add(this.puffs.points);

    this.printGroup = new THREE.Group();
    this.scene.add(this.printGroup);
    const pg = new THREE.CircleGeometry(0.1, 12);
    this.prints = Array.from({ length: 44 }, () => {
      const m = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0x2a1a12, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      m.rotation.order = 'YXZ';
      m.scale.set(0.8, 1.7, 1);
      m.visible = false;
      m.userData.life = 0;
      this.printGroup.add(m);
      return m;
    });
    this.printCursor = 0;
  }

  _puff(x, y, z, n, power = 1) {
    for (let i = 0; i < n; i++) {
      const j = this.puffCursor;
      this.puffCursor = (this.puffCursor + 1) % this.puffN;
      const a = Math.random() * Math.PI * 2;
      const s = (0.3 + Math.random() * 0.8) * power;
      this.puffPos.set([x + (Math.random() - 0.5) * 0.3, y + 0.05, z + (Math.random() - 0.5) * 0.3], j * 3);
      this.puffVel.set([Math.cos(a) * s, 0.5 + Math.random() * 0.9 * power, Math.sin(a) * s], j * 3);
      this.puffLife[j] = 0.8 + Math.random() * 0.8;
    }
  }

  _footstep() {
    this.foot *= -1;
    const px = Math.cos(this.faceYaw) * 0.12 * this.foot;
    const pz = -Math.sin(this.faceYaw) * 0.12 * this.foot;
    const x = this.pos.x + px;
    const z = this.pos.z + pz;
    const m = this.prints[this.printCursor];
    this.printCursor = (this.printCursor + 1) % this.prints.length;
    m.position.set(x, this.heightAt(x, z) + 0.015, z);
    m.rotation.set(-Math.PI / 2, this.faceYaw, 0);
    m.userData.life = 30;
    m.visible = true;
    this._puff(x, this.pos.y, z, 3, 0.7);
    this.onStep(this.foot);
  }

  _updateFx(dt) {
    for (const m of this.prints) {
      if (!m.visible) continue;
      m.userData.life -= dt;
      m.material.opacity = clamp(m.userData.life / 6, 0, 1) * 0.38;
      if (m.userData.life <= 0) m.visible = false;
    }
    let any = false;
    for (let i = 0; i < this.puffN; i++) {
      if (this.puffLife[i] <= 0) continue;
      any = true;
      this.puffLife[i] -= dt;
      const o = i * 3;
      this.puffVel[o + 1] -= G * 0.5 * dt;
      this.puffPos[o] += this.puffVel[o] * dt;
      this.puffPos[o + 1] += this.puffVel[o + 1] * dt;
      this.puffPos[o + 2] += this.puffVel[o + 2] * dt;
      if (this.puffLife[i] <= 0) this.puffPos[o + 1] = -9999;
    }
    if (any) this.puffs.points.geometry.attributes.position.needsUpdate = true;
  }
}