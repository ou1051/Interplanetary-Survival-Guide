// @ts-nocheck
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// STANDALONE sun-angle + dust-storm add-on. It does not replace any file: it takes
// the objects your scene already has and drives them. It reads the CURRENT look as
// its baseline, so with sun/dust at their defaults nothing changes.
//
//   keys   K  open/close the LIGHTING & DUST panel
//          T  cycle sun presets (morning, noon, afternoon, sunset)
//          G  cycle dust (clear, haze, storm)
//
//   const weather = new Weather({ renderer, scene, sun, sunDir, hemi, sky, motes });
//   ... every frame:  weather.update(dt);
//
//  required: renderer, scene, sun (DirectionalLight), sunDir (the THREE.Vector3 your code
//            uses for the sun direction; it is updated IN PLACE)
//  optional: hemi (HemisphereLight), sky (mesh whose material has uHorizon/uZenith),
//            motes ({ points, wind } floating dust), onLog(text, tone), keys, ui,
//            drivesSun (true = this module also positions the sun light from sunDir)
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
const angDiff = (to, from) => ((((to - from) % 360) + 540) % 360) - 180;

export const SUN_PRESETS = [
  { label: 'MORNING', el: 15, az: 95 },
  { label: 'NOON', el: 62, az: 180 },
  { label: 'AFTERNOON', el: 24, az: 250 },
  { label: 'SUNSET', el: 4, az: 278 },
];
export const DUST_PRESETS = [
  { label: 'CLEAR', v: 0 },
  { label: 'HAZE', v: 0.35 },
  { label: 'STORM', v: 0.9 },
];

const C = (h) => new THREE.Color(h);
const SUN_LOW = C(0xff9a55);
const SUN_DUST = C(0xd9a070);
const HEMI_DUST = C(0xc99a72);
const DUST_HORIZON = C('#b98560');
const DUST_ZENITH = C('#a77b5a');

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (az) => COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];

export class Weather {
  constructor({ renderer, scene, sun, sunDir, hemi = null, sky = null, motes = null, onLog = () => {}, keys = {}, ui = true, drivesSun = false }) {
    if (!renderer || !scene || !sun || !sunDir) throw new Error('Weather needs renderer, scene, sun and sunDir');
    Object.assign(this, { renderer, scene, sun, sunDir, hemi, sky, motes, onLog, drivesSun });
    this.keys = { panel: 'k', sun: 't', dust: 'g', ...keys };
    this.visible = true;

    // ---- capture the current look as the baseline
    const fog = scene.fog;
    this.fogKind = !fog ? 'none' : fog.density !== undefined ? 'exp2' : 'linear';
    const u = sky && sky.material && sky.material.uniforms ? sky.material.uniforms : null;
    this.skyU = u;
    this.base = {
      sunI: sun.intensity,
      sunColor: sun.color.clone(),
      hemiI: hemi ? hemi.intensity : 0,
      hemiColor: hemi ? hemi.color.clone() : null,
      env: scene.environmentIntensity !== undefined ? scene.environmentIntensity : 1,
      exposure: renderer.toneMappingExposure,
      fogColor: fog ? fog.color.clone() : null,
      fogDensity: fog && fog.density !== undefined ? fog.density : null,
      fogNear: fog && fog.near !== undefined ? fog.near : null,
      fogFar: fog && fog.far !== undefined ? fog.far : null,
      horizon: u && u.uHorizon ? u.uHorizon.value.clone() : null,
      zenith: u && u.uZenith ? u.uZenith.value.clone() : null,
      motesOpacity: motes ? motes.points.material.opacity : 0,
      motesSize: motes ? motes.points.material.size : 0,
      windX: motes ? motes.wind.x : 0,
      windZ: motes ? motes.wind.z : 0,
    };

    // starting sun angle = whatever the scene currently uses
    const el0 = Math.asin(clamp(sunDir.clone().normalize().y, -1, 1)) / RAD;
    const az0 = (((Math.atan2(sunDir.x, -sunDir.z) / RAD) % 360) + 360) % 360;
    this.el0 = clamp(el0, 3, 85);
    this.day0 = clamp(Math.sin(this.el0 * RAD) * 2.4, 0, 1);
    this.K0 = clamp(Math.sin(this.el0 * RAD) * 1.8, 0.06, 1);
    this.target = { el: this.el0, az: az0, dust: 0 };
    this.cur = { el: this.el0, az: az0, dust: 0 };
    this.readoutTimer = 0;

    if (ui && typeof document !== 'undefined') this._buildPanel();
    if (typeof window !== 'undefined') {
      this._onKey = (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const k = e.key.toLowerCase();
        if (k === this.keys.panel) this.togglePanel();
        else if (k === this.keys.sun) this.cyclePreset();
        else if (k === this.keys.dust) this.cycleDust();
      };
      window.addEventListener('keydown', this._onKey);
    }
    this.apply();
    this._sync();
  }

  dispose() {
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    if (this.root) this.root.remove();
  }

  // ------------------------------------------------------------------ control
  setSun(el, az) {
    this.target.el = clamp(el, 3, 85);
    this.target.az = ((az % 360) + 360) % 360;
    this._sync();
  }
  setDust(v) {
    this.target.dust = clamp(v, 0, 1);
    this._sync();
  }
  setPreset(i) {
    const p = SUN_PRESETS[i];
    this.setSun(p.el, p.az);
    this.onLog(`Sun: ${p.label.toLowerCase()} · elevation ${p.el}° · shadows ${this._shadowText(p.el)}`, 'info');
  }
  cyclePreset() {
    let best = 0;
    let bd = Infinity;
    SUN_PRESETS.forEach((p, i) => {
      const d = Math.abs(p.el - this.target.el) + Math.abs(angDiff(p.az, this.target.az)) * 0.2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    this.setPreset((best + 1) % SUN_PRESETS.length);
  }
  setDustPreset(i) {
    this.setDust(DUST_PRESETS[i].v);
    const msg = ['Dust: clear sky', 'Dust: haze — visibility reduced', 'Dust storm — visibility and solar power collapse'][i];
    this.onLog(msg, i === 2 ? 'warn' : 'info');
  }
  cycleDust() {
    let best = 0;
    let bd = Infinity;
    DUST_PRESETS.forEach((p, i) => {
      const d = Math.abs(p.v - this.target.dust);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    this.setDustPreset((best + 1) % DUST_PRESETS.length);
  }
  togglePanel() {
    if (this.root) this.root.classList.toggle('open');
  }
  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    if (this.root) this.root.style.display = v ? '' : 'none';
  }
  _shadowText(el) {
    return `${(1 / Math.tan(Math.max(el, 1) * RAD)).toFixed(1)}× object height`;
  }

  // ------------------------------------------------------------------ update
  update(dt) {
    const c = this.cur;
    const t = this.target;
    const ks = ease(1.8, dt);
    c.el += (t.el - c.el) * ks;
    c.az = (c.az + angDiff(t.az, c.az) * ks + 360) % 360;
    c.dust += (t.dust - c.dust) * ease(0.7, dt);
    this.apply();
    this.readoutTimer -= dt;
    if (this.readoutTimer <= 0) {
      this.readoutTimer = 0.2;
      this._readout();
    }
  }

  apply() {
    const { el, az, dust } = this.cur;
    const b = this.base;
    const elR = el * RAD;
    const azR = az * RAD;
    const sinEl = Math.sin(elR);
    const day = clamp(sinEl * 2.4, 0, 1);
    // relative to the starting look, so defaults reproduce the baseline exactly
    const rel = (f) => f(day) / f(this.day0);
    const L = rel((d) => 0.28 + 0.72 * d);
    const dustCurve = dust ** 1.1;

    this.sunDir.set(Math.cos(elR) * Math.sin(azR), sinEl, -Math.cos(elR) * Math.cos(azR)).normalize();
    if (this.drivesSun && this.sun.target) {
      this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 150);
    }

    const directK = clamp(sinEl * 1.8, 0.06, 1) * (1 - 0.88 * dustCurve);
    this.sun.intensity = Math.min(b.sunI * 1.25, (b.sunI * directK) / this.K0);
    const warmth = clamp(1 - day - (1 - this.day0), 0, 1);
    this.sun.color.copy(b.sunColor).lerp(SUN_LOW, warmth).lerp(SUN_DUST, dust * 0.7);

    if (this.hemi) {
      this.hemi.intensity = b.hemiI * rel((d) => 0.6 + 0.4 * d) * (1 + 0.35 * dust);
      this.hemi.color.copy(b.hemiColor).lerp(HEMI_DUST, dust);
    }
    if (this.scene.environmentIntensity !== undefined) {
      this.scene.environmentIntensity = b.env * rel((d) => 0.5 + 0.5 * d) * (1 - 0.4 * dust);
    }

    const fog = this.scene.fog;
    const thick = 1 + 11 * dust ** 1.4;
    if (fog) {
      const col = b.fogColor.clone().lerp(DUST_HORIZON, dust * 0.9).multiplyScalar(Math.min(L, 1.15));
      fog.color.copy(col);
      if (this.fogKind === 'exp2') fog.density = b.fogDensity * thick;
      else {
        fog.far = b.fogFar / (1 + (thick - 1) * 0.7);
        fog.near = b.fogNear / (1 + (thick - 1) * 0.7);
      }
    }
    this.renderer.toneMappingExposure = b.exposure * rel((d) => 1 + 0.5 * (1 - d)) * (1 + 0.25 * dust);

    const u = this.skyU;
    if (u) {
      if (u.uSun) u.uSun.value.copy(this.sunDir);
      if (u.uHorizon && b.horizon) u.uHorizon.value.copy(b.horizon).lerp(DUST_HORIZON, dust * 0.9).multiplyScalar(Math.min(L, 1.15));
      if (u.uZenith && b.zenith) u.uZenith.value.copy(b.zenith).lerp(DUST_ZENITH, dust * 0.9).multiplyScalar(Math.min(L, 1.15));
      if (u.uDust) u.uDust.value = dust; // only exists if the sky shader supports it
      if (u.uAureole) u.uAureole.value = 0.8 + 0.5 * (1 - day);
    }

    if (this.motes) {
      this.motes.points.material.opacity = b.motesOpacity + 0.35 * dust;
      this.motes.points.material.size = b.motesSize + 0.1 * dust;
      this.motes.wind.x = b.windX + 9 * dust;
      this.motes.wind.z = b.windZ + 4 * dust;
    }
  }

  metrics() {
    const { el, az, dust } = this.cur;
    const thick = 1 + 11 * dust ** 1.4;
    let visibilityM = 3000 / thick;
    if (this.fogKind === 'exp2') visibilityM = 1.5 / (this.base.fogDensity * thick);
    else if (this.fogKind === 'linear') visibilityM = (this.base.fogFar * 0.8) / (1 + (thick - 1) * 0.7);
    return { el, az, dust, visibilityM, solarPct: Math.round(100 * Math.sin(el * RAD) * (1 - 0.92 * dust ** 0.9)) };
  }

  // ------------------------------------------------------------------ panel
  _buildPanel() {
    const old = document.getElementById('isg-wx');
    if (old) old.remove();
    const style = document.createElement('style');
    style.textContent = `
      #isg-wx{position:fixed;left:54px;top:42%;z-index:30;font:12px ui-monospace,Menlo,Consolas,monospace;color:#7fefff;letter-spacing:.08em;user-select:none}
      #isg-wx .pill{display:inline-block;cursor:pointer;padding:6px 10px;background:rgba(3,8,10,.62);border:1px solid rgba(127,239,255,.3)}
      #isg-wx .pill:hover{background:rgba(127,239,255,.15)}
      #isg-wx .box{display:none;margin-top:6px;width:292px;padding:10px 12px;background:rgba(3,8,10,.72);border:1px solid rgba(127,239,255,.25)}
      #isg-wx.open .box{display:block}
      #isg-wx .row{display:flex;gap:6px;margin:6px 0}
      #isg-wx button{flex:1;cursor:pointer;font:inherit;letter-spacing:.06em;color:#7fefff;background:rgba(127,239,255,.07);border:1px solid rgba(127,239,255,.3);padding:5px 0}
      #isg-wx button:hover{background:rgba(127,239,255,.2)}
      #isg-wx button.on{background:#7fefff;color:#03080a}
      #isg-wx label{display:flex;justify-content:space-between;margin-top:8px;color:rgba(127,239,255,.65)}
      #isg-wx input[type=range]{width:100%;accent-color:#7fefff;margin:2px 0}
      #isg-wx .ro{margin-top:8px;padding-top:6px;border-top:1px solid rgba(127,239,255,.2);color:rgba(127,239,255,.8);line-height:1.6}
      #isg-wx .hint{margin-top:4px;color:rgba(127,239,255,.45);font-size:11px}
    `;
    document.head.appendChild(style);

    const k = (s) => s.toUpperCase();
    const root = document.createElement('div');
    root.id = 'isg-wx';
    root.innerHTML = `
      <div class="pill">☀ LIGHTING &amp; DUST [${k(this.keys.panel)}]</div>
      <div class="box">
        <div class="row" data-g="sun">${SUN_PRESETS.map((p, i) => `<button data-i="${i}">${p.label}</button>`).join('')}</div>
        <label><span>SUN ELEVATION</span><span id="wx-el"></span></label>
        <input id="wx-el-in" type="range" min="3" max="85" step="1">
        <label><span>SUN AZIMUTH</span><span id="wx-az"></span></label>
        <input id="wx-az-in" type="range" min="0" max="359" step="1">
        <label><span>DUST</span><span id="wx-du"></span></label>
        <input id="wx-du-in" type="range" min="0" max="100" step="1">
        <div class="row" data-g="dust">${DUST_PRESETS.map((p, i) => `<button data-i="${i}">${p.label}</button>`).join('')}</div>
        <div class="ro" id="wx-ro"></div>
        <div class="hint">${k(this.keys.sun)} sun presets · ${k(this.keys.dust)} dust · ${k(this.keys.panel)} close</div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;

    for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'wheel', 'click']) root.addEventListener(ev, (e) => e.stopPropagation());
    root.querySelector('.pill').addEventListener('click', () => this.togglePanel());
    root.querySelectorAll('[data-g="sun"] button').forEach((b) => b.addEventListener('click', () => this.setPreset(+b.dataset.i)));
    root.querySelectorAll('[data-g="dust"] button').forEach((b) => b.addEventListener('click', () => this.setDustPreset(+b.dataset.i)));

    const el = root.querySelector('#wx-el-in');
    const az = root.querySelector('#wx-az-in');
    const du = root.querySelector('#wx-du-in');
    el.addEventListener('input', () => this.setSun(+el.value, +az.value));
    az.addEventListener('input', () => this.setSun(+el.value, +az.value));
    du.addEventListener('input', () => this.setDust(+du.value / 100));
    root.querySelectorAll('input,button').forEach((n) => {
      n.addEventListener('change', () => n.blur());
      n.addEventListener('pointerup', () => setTimeout(() => n.blur(), 0));
      n.addEventListener('keydown', (e) => e.preventDefault());
    });
    this.ui = { el, az, du };
  }

  _sync() {
    if (!this.root) return;
    const t = this.target;
    this.ui.el.value = Math.round(t.el);
    this.ui.az.value = Math.round(t.az) % 360;
    this.ui.du.value = Math.round(t.dust * 100);
    this.root.querySelectorAll('[data-g="sun"] button').forEach((b) => {
      const p = SUN_PRESETS[+b.dataset.i];
      b.classList.toggle('on', Math.abs(p.el - t.el) < 1.5 && Math.abs(angDiff(p.az, t.az)) < 1.5);
    });
    this.root.querySelectorAll('[data-g="dust"] button').forEach((b) => b.classList.toggle('on', Math.abs(DUST_PRESETS[+b.dataset.i].v - t.dust) < 0.03));
    this._readout();
  }

  _readout() {
    if (!this.root) return;
    const m = this.metrics();
    const t = this.target;
    this.root.querySelector('#wx-el').textContent = `${Math.round(t.el)}°`;
    this.root.querySelector('#wx-az').textContent = `${Math.round(t.az)}° ${compass(t.az)}`;
    this.root.querySelector('#wx-du').textContent = `${Math.round(t.dust * 100)}%`;
    const vis = m.visibilityM >= 1000 ? `${(m.visibilityM / 1000).toFixed(1)} km` : `${Math.round(m.visibilityM)} m`;
    this.root.querySelector('#wx-ro').innerHTML = `VISIBILITY ≈ ${vis}<br>SOLAR OUTPUT ${m.solarPct}%<br>SHADOWS ${this._shadowText(m.el)}`;
  }
}