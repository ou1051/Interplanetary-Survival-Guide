// @ts-nocheck
// ---------------------------------------------------------------------------
// Helmet visor overlay: gold-tinted visor, dark helmet shell in the corners, soft
// reflections that drift as you look around, breath fog, and dust that settles on
// the glass when a storm builds. Pure DOM/CSS/canvas: it has NO dependency on the
// game code, and it never blocks the mouse.
//
//   import { HelmetVisor } from './ui/helmet.js';
//   const visor = new HelmetVisor({ weather });   // weather is optional (from weather.js)
//   // every frame:  visor.update(dt);
//   // optional:     visor.setLook(yawRadians, pitchRadians);  visor.setGlare(0..1)
//
//   key J toggles the visor on/off (change with keys: { toggle: 'x' })
// ---------------------------------------------------------------------------

export class HelmetVisor {
  constructor({ parent = null, weather = null, zIndex = 3, keys = {}, strength = 1 } = {}) {
    this.weather = weather;
    this.keys = { toggle: 'j', ...keys };
    this.strength = strength;
    this.dust = 0;
    this._drawnDust = -1;
    this.visible = true;

    const style = document.createElement('style');
    style.id = 'isg-visor-style';
    style.textContent = `
      #isg-visor{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:${zIndex}}
      #isg-visor>*{position:absolute;pointer-events:none}
      #isg-visor .vz-frame{left:-6%;top:-7%;width:112%;height:114%;border-radius:30%/28%;
        box-shadow:inset 0 0 120px 34px rgba(0,0,0,.42), 0 0 0 220vmax rgba(9,6,5,.86)}
      #isg-visor .vz-tint{inset:0;background:
        radial-gradient(ellipse at 50% 42%, rgba(255,200,120,0) 46%, rgba(255,168,76,.10) 100%),
        linear-gradient(180deg, rgba(255,214,150,.05), rgba(255,160,70,.04))}
      #isg-visor .vz-shine{left:-30%;top:-30%;width:160%;height:160%;will-change:transform;transition:transform .12s linear}
      #isg-visor .vz-shine.a{background:linear-gradient(115deg,transparent 38%,rgba(255,255,255,.075) 44%,rgba(255,255,255,.015) 50%,transparent 56%)}
      #isg-visor .vz-shine.b{background:linear-gradient(118deg,transparent 60%,rgba(255,240,220,.05) 63%,transparent 66%)}
      #isg-visor .vz-breath{left:30%;right:30%;bottom:-6%;height:34%;border-radius:50%;
        background:radial-gradient(ellipse at 50% 100%, rgba(235,243,255,.20), rgba(235,243,255,0) 65%);
        opacity:0;animation:vz-breath 4.6s ease-in-out infinite}
      @keyframes vz-breath{0%,100%{opacity:0;transform:scale(.9)}45%{opacity:.85;transform:scale(1.05)}}
      #isg-visor .vz-dust{inset:0;width:100%;height:100%}
      #isg-visor .vz-glare{inset:0;opacity:0;transition:opacity .2s;
        background:radial-gradient(ellipse at 74% 22%, rgba(255,245,225,.55), rgba(255,245,225,0) 42%)}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'isg-visor';
    root.innerHTML = `
      <div class="vz-tint"></div>
      <div class="vz-shine a"></div><div class="vz-shine b"></div>
      <div class="vz-glare"></div>
      <canvas class="vz-dust"></canvas>
      <div class="vz-breath"></div>
      <div class="vz-frame"></div>`;
    (parent || document.body).appendChild(root);
    this.root = root;
    this.shineA = root.querySelector('.vz-shine.a');
    this.shineB = root.querySelector('.vz-shine.b');
    this.glare = root.querySelector('.vz-glare');
    this.canvas = root.querySelector('.vz-dust');
    this.ctx = this.canvas.getContext ? this.canvas.getContext('2d') : null;
    root.style.opacity = String(strength);

    // fixed pseudo-random specks, each with the dust level at which it first appears
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    this.specks = Array.from({ length: 280 }, () => ({
      x: rnd(), y: rnd(), r: 0.6 + rnd() ** 2.2 * 5.5, a: 0.10 + rnd() * 0.30, t: rnd() ** 0.8, streak: rnd() < 0.25 ? 1 + rnd() * 5 : 0,
    }));

    this._resize = () => {
      this.canvas.width = Math.round(window.innerWidth * Math.min(window.devicePixelRatio || 1, 1.5));
      this.canvas.height = Math.round(window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5));
      this._drawnDust = -1;
    };
    window.addEventListener('resize', this._resize);
    this._resize();

    this._onKey = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key.toLowerCase() === this.keys.toggle) this.setVisible(!this.visible);
    };
    window.addEventListener('keydown', this._onKey);
  }

  setVisible(v) {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }
  /** shift the reflections a little as the player looks around (radians) */
  setLook(yaw = 0, pitch = 0) {
    const x = Math.max(-1, Math.min(1, yaw)) * 70;
    const y = Math.max(-1, Math.min(1, pitch)) * 40;
    this.shineA.style.transform = `translate(${x}px,${y}px)`;
    this.shineB.style.transform = `translate(${x * 1.6}px,${y * 1.3}px)`;
  }
  setGlare(v) {
    this.glare.style.opacity = String(Math.max(0, Math.min(1, v)));
  }
  setDust(v) {
    this.dust = Math.max(0, Math.min(1, v));
  }

  update(dt = 0) {
    if (this.weather && this.weather.cur) this.dust = this.weather.cur.dust;
    if (Math.abs(this.dust - this._drawnDust) > 0.02) this._drawDust();
  }

  _drawDust() {
    this._drawnDust = this.dust;
    const g = this.ctx;
    if (!g) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const k = this.dust;
    if (k < 0.03) return;
    const s = W / 1280;
    for (const p of this.specks) {
      if (p.t > k) continue;
      const fade = Math.min(1, (k - p.t) * 6);
      const x = p.x * W;
      const y = p.y * H;
      const r = p.r * s * (0.7 + k * 0.8);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(201,148,103,${p.a * fade})`);
      grd.addColorStop(1, 'rgba(201,148,103,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(x, y, r, r * (1 + p.streak), 0, 0, Math.PI * 2);
      g.fill();
    }
    // a faint overall film of dust on the glass in a storm
    g.fillStyle = `rgba(196,140,98,${0.10 * k})`;
    g.fillRect(0, 0, W, H);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._resize);
    this.root.remove();
    const st = document.getElementById('isg-visor-style');
    if (st) st.remove();
  }
}