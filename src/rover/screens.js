import { formatHM, formatDist } from '../core/math.js';
import { ZONE_COLORS } from '../ui/mapRenderer.js';
import { SLOPE_CLASSES, LIFE_SUPPORT } from '../config/mission.js';

// Diegetic displays on the rover console (drawn into CanvasTextures).

const CYAN = '#7fefff';
const DIM = 'rgba(127,239,255,0.55)';
const BG = '#03080a';
const FONT = 'ui-monospace, Menlo, Consolas, monospace';

function frame(g, W, H, title, right) {
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(127,239,255,0.08)';
  g.fillRect(0, 0, W, 30);
  g.fillStyle = CYAN;
  g.font = `600 17px ${FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(title, 12, 16);
  if (right) {
    g.textAlign = 'right';
    g.fillStyle = DIM;
    g.font = `15px ${FONT}`;
    g.fillText(right, W - 12, 16);
  }
  g.textBaseline = 'alphabetic';
}

function wrap(g, text, x, y, maxW, lh, maxLines = 4) {
  const words = text.split(' ');
  let line = '';
  let n = 0;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) {
      g.fillText(line, x, y + n * lh);
      line = w;
      if (++n >= maxLines) return;
    } else line = t;
  }
  if (line) g.fillText(line, x, y + n * lh);
}

const tiltColor = (a) => (Math.abs(a) >= SLOPE_CLASSES.danger ? ZONE_COLORS.danger : Math.abs(a) >= SLOPE_CLASSES.caution ? ZONE_COLORS.caution : CYAN);

export function drawNav(scr, map, mission, view) {
  const { ctx: g, canvas } = scr;
  const W = canvas.width;
  const H = canvas.height;
  map.drawNav(g, W, H, { x: view.x, z: view.z, heading: (view.headingDeg * Math.PI) / 180, s: mission.s, weather: mission.weather, front: mission.activeFront, obstacles: mission.detectedObstacles }, 130);
  g.fillStyle = 'rgba(3,8,10,0.78)';
  g.fillRect(0, 0, W, 34);
  g.fillStyle = CYAN;
  g.font = `600 18px ${FONT}`;
  g.textAlign = 'left';
  g.fillText(`NAV  HDG ${String(Math.round(view.headingDeg) % 360).padStart(3, '0')}°`, 12, 23);
  const next = mission.nextKnownStop;
  if (next) {
    g.textAlign = 'right';
    const label = next.kind === 'gate' ? 'GATE' : next.ref.final ? 'HAB' : next.ref.id;
    const at = next.ref.at ?? next.ref;
    const r = mission.rover;
    g.fillText(`${label} ${formatDist(Math.hypot(at.x - r.x, at.z - r.z))}`, W - 12, 23);
  }
  g.fillStyle = 'rgba(3,8,10,0.78)';
  g.fillRect(0, H - 28, W, 28);
  g.fillStyle = DIM;
  g.font = `14px ${FONT}`;
  g.textAlign = 'left';
  g.fillText(`LAYER ${map.layer ? map.layer.name : ''}`, 12, H - 9);
  g.textAlign = 'right';
  g.fillText(!mission.weather.limitsVisibility ? 'RINGS 50 m' : `VIS ≈ ${formatDist(mission.weather.visibilityM)}`, W - 12, H - 9);
  scr.tex.needsUpdate = true;
}

export function drawTraverse(scr, route, mission, view) {
  const { ctx: g, canvas } = scr;
  const W = canvas.width;
  const H = canvas.height;
  frame(g, W, H, 'TRAVERSE', mission.state.toUpperCase());
  // speed
  g.textAlign = 'left';
  g.fillStyle = '#e6fdff';
  g.font = `300 58px ${FONT}`;
  g.fillText((mission.speed * 3.6).toFixed(1), 14, 92);
  g.fillStyle = DIM;
  g.font = `15px ${FONT}`;
  g.fillText('km/h', 16, 114);
  const lim = Math.min(mission.limit, mission.weather.speedLimit) * 3.6;
  g.fillStyle = mission.governed ? ZONE_COLORS.caution : DIM;
  g.fillText(`LIMIT ${Math.round(lim)}`, 16, 136);
  // attitude
  g.textAlign = 'right';
  g.font = `600 22px ${FONT}`;
  g.fillStyle = tiltColor(view.pitch);
  g.fillText(`P ${view.pitch >= 0 ? '+' : ''}${view.pitch.toFixed(1)}°`, W - 14, 76);
  g.fillStyle = tiltColor(view.roll);
  g.fillText(`R ${view.roll >= 0 ? '+' : ''}${view.roll.toFixed(1)}°`, W - 14, 106);
  g.fillStyle = DIM;
  g.font = `14px ${FONT}`;
  g.fillText(`ELEV ${view.elev.toFixed(1)} m`, W - 14, 132);

  // look-ahead elevation profile (-40 m … +260 m)
  const x0 = 12, x1 = W - 12, y0 = 156, y1 = H - 24;
  const s0 = mission.s - 40;
  const s1 = mission.s + 260;
  let lo = Infinity, hi = -Infinity;
  for (let s = s0; s <= s1; s += 4) {
    const h = route.h[route.indexAt(s)];
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  hi = Math.max(hi, lo + 8);
  const X = (s) => x0 + ((s - s0) / (s1 - s0)) * (x1 - x0);
  const Y = (h) => y1 - ((h - lo) / (hi - lo)) * (y1 - y0);
  g.fillStyle = 'rgba(127,239,255,0.06)';
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.lineWidth = 3;
  for (let s = s0 + 4; s <= s1; s += 4) {
    const i = route.indexAt(s);
    const c = route.hazardClass[i];
    g.strokeStyle = s < mission.s ? 'rgba(200,210,215,0.4)' : c === 2 ? ZONE_COLORS.danger : c === 1 ? ZONE_COLORS.caution : CYAN;
    g.beginPath();
    g.moveTo(X(s - 4), Y(route.h[route.indexAt(s - 4)]));
    g.lineTo(X(s), Y(route.h[i]));
    g.stroke();
  }
  for (const st of route.stations) {
    if (st.s < s0 || st.s > s1) continue;
    g.fillStyle = st.done ? '#5cff9a' : '#56e0ff';
    g.fillRect(X(st.s) - 1, y0, 2, y1 - y0);
    g.font = `13px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(st.final ? 'HAB' : st.id, X(st.s), y0 - 3);
  }
  g.strokeStyle = '#fff';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(X(mission.s), y0);
  g.lineTo(X(mission.s), y1);
  g.stroke();
  g.fillStyle = DIM;
  g.font = `13px ${FONT}`;
  g.textAlign = 'left';
  g.fillText('NEXT 260 m', x0, H - 6);
  g.textAlign = 'right';
  g.fillText(`Δh ${(hi - lo).toFixed(0)} m`, x1, H - 6);
  scr.tex.needsUpdate = true;
}

export function drawScience(scr, layer, readout, mission) {
  const { ctx: g, canvas } = scr;
  const W = canvas.width;
  const H = canvas.height;
  frame(g, W, H, 'SCIENCE', layer.name);
  g.textAlign = 'left';
  g.fillStyle = '#e6fdff';
  g.font = `600 26px ${FONT}`;
  g.fillText(readout, 14, 72);
  g.fillStyle = ZONE_COLORS.caution;
  g.font = `14px ${FONT}`;
  g.fillText(`SRC ${layer.source}`, 14, 96);
  const latest = mission.scienceResults.at(-1);
  const st = mission.currentStation ?? mission.nextStation;
  if (st) {
    g.fillStyle = DIM;
    g.font = `14px ${FONT}`;
    g.fillText(st.final ? 'RETURN' : `NEXT ${st.id} · ${st.name.toUpperCase()}`, 14, 130);
    g.fillStyle = CYAN;
    g.font = `16px ${FONT}`;
    wrap(g, st.objective, 14, 154, W - 28, 21, 3);
    if (latest) {
      g.fillStyle = latest.quality === 'dust-degraded' || latest.status !== 'complete' ? ZONE_COLORS.caution : CYAN;
      g.font = `14px ${FONT}`;
      wrap(g, `${latest.station} · ${latest.result}`, 14, 230, W - 28, 19, 2);
    } else if (st.why && st.why[0]) {
      g.fillStyle = DIM;
      g.font = `14px ${FONT}`;
      wrap(g, `▸ ${st.why[0]}`, 14, 230, W - 28, 19, 2);
    }
  }
  scr.tex.needsUpdate = true;
}

export function drawLife(scr, mission) {
  const { ctx: g, canvas } = scr;
  const W = canvas.width;
  const H = canvas.height;
  frame(g, W, H, 'SUIT', mission.comms.los ? 'LOS' : 'RELAY');
  const rows = [
    ['O₂', formatHM(mission.o2Remaining), mission.o2Remaining / (LIFE_SUPPORT.evaHours * 60)],
    ['PWR', `${mission.batteryPct.toFixed(0)}%`, mission.batteryPct / 100],
    ['DOSE', `${mission.dose.toFixed(0)}µSv`, null],
    ['CO₂', '0.4 kPa', 0.15],
  ];
  rows.forEach(([k, v, f], i) => {
    const y = 66 + i * 64;
    g.textAlign = 'left';
    g.fillStyle = DIM;
    g.font = `15px ${FONT}`;
    g.fillText(k, 12, y);
    g.textAlign = 'right';
    g.fillStyle = '#e6fdff';
    g.font = `600 22px ${FONT}`;
    g.fillText(v, W - 12, y);
    if (f !== null) {
      g.fillStyle = 'rgba(127,239,255,0.15)';
      g.fillRect(12, y + 12, W - 24, 6);
      g.fillStyle = f < 0.2 ? ZONE_COLORS.danger : f < 0.35 ? ZONE_COLORS.caution : CYAN;
      g.fillRect(12, y + 12, (W - 24) * Math.max(0, Math.min(1, f)), 6);
    }
  });
  scr.tex.needsUpdate = true;
}
