import * as THREE from 'three';
import { sampleContext } from '../world/terrain.js';
import { HAB } from '../config/mission.js';
import { clamp } from '../core/math.js';

// ---------------------------------------------------------------------------
// 2D cartography shared by the dashboard NAV screen and the full-screen map:
// a hill-shaded raster of the active data layer + the survival route on top.
// ---------------------------------------------------------------------------

export const ZONE_COLORS = { caution: '#ffc23d', danger: '#ff5a45' };

export class MapRenderer {
  constructor(terrain, route) {
    this.terrain = terrain;
    this.route = route;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < route.count; i++) {
      x0 = Math.min(x0, route.x[i]); x1 = Math.max(x1, route.x[i]);
      z0 = Math.min(z0, route.z[i]); z1 = Math.max(z1, route.z[i]);
    }
    const pad = 130;
    this.bounds = { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
    this.mpp = 2; // metres per pixel of the base raster
    this.w = Math.ceil((this.bounds.x1 - this.bounds.x0) / this.mpp);
    this.h = Math.ceil((this.bounds.z1 - this.bounds.z0) / this.mpp);
    this.base = document.createElement('canvas');
    this.base.width = this.w;
    this.base.height = this.h;
    this._buildRoutePath();
  }

  // Per-pixel sampling context + hillshade, computed once.
  _cache() {
    const { w, h, mpp, bounds: b } = this;
    const T = this.terrain;
    this.ctxs = new Array(w * h);
    this.shade = new Float32Array(w * h);
    // light from the NW, 45° altitude (cartographic convention)
    const lx = -0.5, ly = 0.7071, lz = -0.5;
    for (let j = 0; j < h; j++) {
      const z = b.z0 + j * mpp;
      for (let i = 0; i < w; i++) {
        const x = b.x0 + i * mpp;
        const ctx = sampleContext(T, x, z, { m: {} });
        this.ctxs[j * w + i] = ctx;
        const dx = (T.heightAt(x + mpp, z) - T.heightAt(x - mpp, z)) / (2 * mpp);
        const dz = (T.heightAt(x, z + mpp) - T.heightAt(x, z - mpp)) / (2 * mpp);
        const nl = Math.hypot(dx, 1, dz);
        this.shade[j * w + i] = clamp((-dx * lx + ly - dz * lz) / nl, 0, 1);
      }
    }
  }

  setLayer(layer) {
    if (!this.ctxs) this._cache();
    const { w, h } = this;
    const g = this.base.getContext('2d');
    const img = g.createImageData(w, h);
    const c = new THREE.Color();
    const rgb = { r: 0, g: 0, b: 0 };
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const idx = j * w + i;
        layer.color(this.ctxs[idx], c);
        c.getRGB(rgb, THREE.SRGBColorSpace);
        const k = 0.45 + 0.75 * this.shade[idx];
        const o = idx * 4;
        img.data[o] = clamp(rgb.r * 255 * k, 0, 255);
        img.data[o + 1] = clamp(rgb.g * 255 * k, 0, 255);
        img.data[o + 2] = clamp(rgb.b * 255 * k, 0, 255);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.layer = layer;
  }

  _buildRoutePath() {
    const R = this.route;
    this.segments = [];
    const sev = (s) => {
      let v = 0;
      for (const z of R.zones) if (s >= z.s0 && s <= z.s1) v = Math.max(v, z.severity === 'danger' ? 2 : 1);
      return v;
    };
    let cur = null;
    for (let i = 0; i < R.count; i += 2) {
      const s = i * R.step;
      const v = sev(s);
      if (!cur || cur.sev !== v) {
        if (cur) cur.pts.push([R.x[i], R.z[i], s]);
        cur = { sev: v, pts: [] };
        this.segments.push(cur);
      }
      cur.pts.push([R.x[i], R.z[i], s]);
    }
  }

  // Draw the route (and markers) with a world→canvas transform function.
  _drawRoute(g, toPx, roverS, scale, opts = {}) {
    const lw = opts.lineWidth || 3;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // halo
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = lw + 3;
    g.beginPath();
    for (const seg of this.segments) seg.pts.forEach(([x, z], k) => {
      const [px, py] = toPx(x, z);
      if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    });
    g.stroke();
    for (const seg of this.segments) {
      const done = [];
      const todo = [];
      for (const p of seg.pts) (p[2] <= roverS ? done : todo).push(p);
      if (done.length && todo.length) todo.unshift(done[done.length - 1]);
      const col = seg.sev === 2 ? ZONE_COLORS.danger : seg.sev === 1 ? ZONE_COLORS.caution : '#5ce4ff';
      for (const [list, style, dash] of [[done, 'rgba(200,210,215,0.55)', []], [todo, col, seg.sev ? [6, 4] : []]]) {
        if (list.length < 2) continue;
        g.strokeStyle = style;
        g.lineWidth = lw;
        g.setLineDash(dash);
        g.beginPath();
        list.forEach(([x, z], k) => {
          const [px, py] = toPx(x, z);
          if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
        });
        g.stroke();
      }
    }
    g.setLineDash([]);

    // gates
    for (const z of this.route.zones) {
      if (z.severity !== 'danger') continue;
      const p = this.route.sample(z.gateS ?? z.s0);
      const [px, py] = toPx(p.x, p.z);
      g.save();
      g.translate(px, py);
      g.fillStyle = z.acknowledged ? 'rgba(255,190,80,0.5)' : ZONE_COLORS.danger;
      g.strokeStyle = '#000';
      g.lineWidth = 1.5;
      const s = opts.icon || 7;
      g.beginPath();
      g.moveTo(0, -s);
      g.lineTo(s * 0.95, s * 0.7);
      g.lineTo(-s * 0.95, s * 0.7);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#000';
      g.font = `bold ${Math.round(s * 1.1)}px ui-monospace, monospace`;
      g.textAlign = 'center';
      g.fillText('!', 0, s * 0.55);
      g.restore();
    }
    // stations
    for (const st of this.route.stations) {
      const [px, py] = toPx(st.x, st.z);
      const s = opts.icon || 7;
      g.fillStyle = st.final ? '#ffffff' : st.done ? '#5cff9a' : '#56e0ff';
      g.strokeStyle = '#041015';
      g.lineWidth = 2;
      g.beginPath();
      if (st.final) g.rect(px - s, py - s, s * 2, s * 2);
      else {
        g.moveTo(px, py - s * 1.2); g.lineTo(px + s * 1.2, py); g.lineTo(px, py + s * 1.2); g.lineTo(px - s * 1.2, py); g.closePath();
      }
      g.fill();
      g.stroke();
      if (opts.labels) {
        g.font = `600 ${opts.labelSize || 12}px ui-monospace, Menlo, monospace`;
        g.textAlign = 'left';
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(0,0,0,0.8)';
        const label = st.final ? 'HAB' : `${st.id} ${st.name}`;
        g.strokeText(label, px + s * 1.6, py + 4);
        g.fillStyle = '#e8f6fa';
        g.fillText(label, px + s * 1.6, py + 4);
      }
    }
  }

  _rover(g, px, py, heading, size = 9, cone = 0) {
    g.save();
    g.translate(px, py);
    g.rotate(heading);
    if (cone) {
      const grd = g.createRadialGradient(0, 0, 0, 0, 0, cone);
      grd.addColorStop(0, 'rgba(255,255,255,0.35)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, cone, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6);
      g.closePath();
      g.fill();
    }
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -size);
    g.lineTo(size * 0.7, size * 0.8);
    g.lineTo(0, size * 0.35);
    g.lineTo(-size * 0.7, size * 0.8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  // Full overview, north-up. `view` = {x, z, heading(rad, 0 = north, cw+), s}
  drawOverview(g, W, H, view) {
    const b = this.bounds;
    const scale = Math.min(W / (b.x1 - b.x0), H / (b.z1 - b.z0));
    const ox = (W - (b.x1 - b.x0) * scale) / 2;
    const oy = (H - (b.z1 - b.z0) * scale) / 2;
    const toPx = (x, z) => [ox + (x - b.x0) * scale, oy + (z - b.z0) * scale];
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#05090b';
    g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base, ox, oy, this.w * this.mpp * scale, this.h * this.mpp * scale);
    // grid every 100 m
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    for (let x = Math.ceil(b.x0 / 100) * 100; x < b.x1; x += 100) {
      const [px] = toPx(x, 0);
      g.beginPath(); g.moveTo(px, oy); g.lineTo(px, oy + (b.z1 - b.z0) * scale); g.stroke();
    }
    for (let z = Math.ceil(b.z0 / 100) * 100; z < b.z1; z += 100) {
      const [, py] = toPx(0, z);
      g.beginPath(); g.moveTo(ox, py); g.lineTo(ox + (b.x1 - b.x0) * scale, py); g.stroke();
    }
    // area hazards
    for (const z of this.route.zones) {
      if (z.kind !== 'area') continue;
      const [px, py] = toPx(z.cx, z.cz);
      g.strokeStyle = 'rgba(255,90,69,0.85)';
      g.fillStyle = 'rgba(255,90,69,0.13)';
      g.setLineDash([5, 4]);
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(px, py, z.radius * scale, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }
    this._drawRoute(g, toPx, view.s, scale, { lineWidth: 3.5, labels: true, icon: 7, labelSize: 12 });
    const [rx, ry] = toPx(view.x, view.z);
    this._rover(g, rx, ry, view.heading, 10, 70);
    // north arrow + scale bar
    g.fillStyle = '#e8f6fa';
    g.font = '600 12px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillText('N', W - 26, 24);
    g.beginPath(); g.moveTo(W - 26, 30); g.lineTo(W - 20, 46); g.lineTo(W - 32, 46); g.closePath(); g.fill();
    const bar = 200 * scale;
    g.fillRect(16, H - 22, bar, 3);
    g.textAlign = 'left';
    g.fillText('200 m', 16, H - 28);
    return { toPx, scale };
  }

  // Heading-up moving map for the dashboard.
  drawNav(g, W, H, view, radius = 140) {
    const cx = W / 2;
    const cy = H * 0.66;
    const scale = (H * 0.6) / radius;
    const b = this.bounds;
    const cos = Math.cos(-view.heading);
    const sin = Math.sin(-view.heading);
    const toPx = (x, z) => {
      const dx = (x - view.x) * scale;
      const dz = (z - view.z) * scale;
      return [cx + dx * cos - dz * sin, cy + dx * sin + dz * cos];
    };
    g.fillStyle = '#04080a';
    g.fillRect(0, 0, W, H);
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-view.heading);
    g.globalAlpha = 0.9;
    g.drawImage(this.base, (b.x0 - view.x) * scale, (b.z0 - view.z) * scale, this.w * this.mpp * scale, this.h * this.mpp * scale);
    g.globalAlpha = 1;
    g.restore();
    // range rings
    g.strokeStyle = 'rgba(120,230,255,0.25)';
    g.lineWidth = 1;
    for (const r of [50, 100, 150]) {
      g.beginPath();
      g.arc(cx, cy, r * scale, 0, Math.PI * 2);
      g.stroke();
    }
    this._drawRoute(g, toPx, view.s, scale, { lineWidth: 5, labels: true, icon: 8, labelSize: 14 });
    this._rover(g, cx, cy, 0, 11);
    return { toPx };
  }

  // Elevation profile along the route with slope classes and stops.
  drawProfile(g, W, H, s, opts = {}) {
    const R = this.route;
    const pad = { l: 44, r: 12, t: 14, b: 22 };
    const minH = R.stats.minH - 2;
    const maxH = R.stats.maxH + 4;
    const X = (sv) => pad.l + (sv / R.length) * (W - pad.l - pad.r);
    const Y = (h) => pad.t + (1 - (h - minH) / (maxH - minH)) * (H - pad.t - pad.b);
    g.clearRect(0, 0, W, H);
    g.fillStyle = opts.bg || 'rgba(4,10,12,0.9)';
    g.fillRect(0, 0, W, H);
    // zone bands
    for (const z of R.zones) {
      g.fillStyle = z.severity === 'danger' ? 'rgba(255,90,69,0.22)' : 'rgba(255,194,61,0.14)';
      g.fillRect(X(z.s0), pad.t, Math.max(2, X(z.s1) - X(z.s0)), H - pad.t - pad.b);
    }
    // filled terrain profile
    g.beginPath();
    g.moveTo(X(0), Y(minH));
    for (let i = 0; i < R.count; i += 2) g.lineTo(X(i * R.step), Y(R.h[i]));
    g.lineTo(X(R.length), Y(minH));
    g.closePath();
    const grd = g.createLinearGradient(0, pad.t, 0, H - pad.b);
    grd.addColorStop(0, 'rgba(210,140,95,0.55)');
    grd.addColorStop(1, 'rgba(110,60,40,0.25)');
    g.fillStyle = grd;
    g.fill();
    // profile line coloured by tilt class
    g.lineWidth = 2;
    for (let i = 2; i < R.count; i += 2) {
      const c = R.hazardClass[i];
      g.strokeStyle = c === 2 ? ZONE_COLORS.danger : c === 1 ? ZONE_COLORS.caution : '#5ce4ff';
      g.beginPath();
      g.moveTo(X((i - 2) * R.step), Y(R.h[i - 2]));
      g.lineTo(X(i * R.step), Y(R.h[i]));
      g.stroke();
    }
    // stops
    g.font = '600 10px ui-monospace, monospace';
    g.textAlign = 'center';
    for (const st of R.stations) {
      g.fillStyle = st.done ? '#5cff9a' : st.final ? '#fff' : '#56e0ff';
      g.fillRect(X(st.s) - 1, pad.t, 2, H - pad.t - pad.b);
      g.fillText(st.final ? 'HAB' : st.id, X(st.s), H - 8);
    }
    // axis
    g.fillStyle = 'rgba(232,246,250,0.7)';
    g.textAlign = 'right';
    g.fillText(`${Math.round(maxH)} m`, pad.l - 6, pad.t + 8);
    g.fillText(`${Math.round(minH)} m`, pad.l - 6, H - pad.b);
    // rover position
    const px = X(s);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.5;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(px, pad.t); g.lineTo(px, H - pad.b); g.stroke();
    g.setLineDash([]);
    const i = R.indexAt(s);
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(px, Y(R.h[i]), 4, 0, Math.PI * 2); g.fill();
  }
}

export function bearingTo(fromX, fromZ, toX, toZ) {
  // 0 = north (-Z), clockwise positive, radians
  return Math.atan2(toX - fromX, -(toZ - fromZ));
}

export { HAB };
