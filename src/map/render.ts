import type { Cell, Observation, RoutePlan, Run, Site } from './contracts';
import { cellKey, elevationAt, isMapped, sameCell, type Stop } from './grid';
import type { Backdrop } from './siteImagery';

// Canvas renderer for the site plan. Stateless: everything comes in `RenderState`.
// Look: Apple Maps satellite mode. Real imagery full-bleed, the planning grid as
// a lit focus area, cased route lines, round glyph markers, haloed labels.

export interface Layers {
  imagery: boolean;
  slope: boolean;
  evidence: boolean;
}

export type Mode = { kind: 'select' } | { kind: 'add' } | { kind: 'move'; index: number };

export interface RenderState {
  site: Site;
  slopes: (number | null)[];
  run: Run;
  routes: RoutePlan[];
  layers: Layers;
  texture: HTMLImageElement | null;
  /** Real orbital imagery around the grid (sites with `geo`). */
  backdrop?: Backdrop | null;
  hover: Cell | null;
  cursor: Cell | null;
  showCursor: boolean;
  mode: Mode;
  unreachable: Stop[];
  focusCell: Cell | null;
  time: number;
}

export interface View {
  ox: number;
  oy: number;
  px: number; // pixels per cell
  w: number;
  h: number;
}

// Apple system colours (dark appearance).
export const ROUTE_COLORS = ['#0a84ff', '#bf5af2', '#64d2ff'];
const C = {
  bg: '#0b0b0c',
  label: '#ffffff',
  halo: 'rgba(0, 0, 0, 0.62)',
  base: '#1c1c1e',
  station: '#ff9f0a',
  pinNew: '#ffd60a',
  pinSeen: '#30d158',
  waypoint: '#ffffff',
  evidence: 'rgba(100, 210, 255, 0.16)',
  evidenceEdge: 'rgba(100, 210, 255, 0.7)',
  danger: '#ff453a',
  grid: 'rgba(255, 255, 255, 0.13)',
  frame: 'rgba(255, 255, 255, 0.7)',
};
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif';

export function computeView(site: Site, w: number, h: number, pad = { l: 24, r: 24, t: 24, b: 24 }): View {
  const px = Math.max(8, Math.floor(Math.min((w - pad.l - pad.r) / site.width, (h - pad.t - pad.b) / site.height)));
  const gw = px * site.width;
  const gh = px * site.height;
  return { px, w, h, ox: Math.round(pad.l + (w - pad.l - pad.r - gw) / 2), oy: Math.round(pad.t + (h - pad.t - pad.b - gh) / 2) };
}

export const cellCenter = (v: View, c: Cell) => ({ x: v.ox + (c.col + 0.5) * v.px, y: v.oy + (c.row + 0.5) * v.px });

export function cellAt(v: View, site: Site, x: number, y: number): Cell | null {
  const col = Math.floor((x - v.ox) / v.px);
  const row = Math.floor((y - v.oy) / v.px);
  if (col < 0 || row < 0 || col >= site.width || row >= site.height) return null;
  return { col, row };
}

export function slopeColor(deg: number): string {
  if (deg < 5) return 'rgba(48, 209, 88, 0.36)';
  if (deg < 15) return 'rgba(255, 214, 10, 0.42)';
  return 'rgba(255, 69, 58, 0.5)';
}

let hatch: CanvasPattern | null = null;
function hatchPattern(g: CanvasRenderingContext2D): CanvasPattern | null {
  if (hatch) return hatch;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const p = c.getContext('2d');
  if (!p) return null;
  p.fillStyle = 'rgba(12, 12, 14, 0.82)';
  p.fillRect(0, 0, 8, 8);
  p.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  p.lineWidth = 1;
  p.beginPath();
  p.moveTo(0, 8);
  p.lineTo(8, 0);
  p.stroke();
  hatch = g.createPattern(c, 'repeat');
  return hatch;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Map label: white text with a dark halo, no box (Apple Maps style). */
function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, weight = 600, size = 12) {
  g.save();
  g.font = `${weight} ${size}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.lineJoin = 'round';
  g.lineWidth = 3.5;
  g.strokeStyle = C.halo;
  g.strokeText(text, x, y);
  g.fillStyle = C.label;
  g.fillText(text, x, y);
  g.restore();
}

function shadow(g: CanvasRenderingContext2D, blur = 8, dy = 2, alpha = 0.45) {
  g.shadowColor = `rgba(0, 0, 0, ${alpha})`;
  g.shadowBlur = blur;
  g.shadowOffsetY = dy;
}

/** Round marker with white ring. */
function disc(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  g.save();
  shadow(g);
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.restore();
  g.beginPath();
  g.arc(x, y, r - 2, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
}

function glyphText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string) {
  g.fillStyle = color;
  g.font = `700 ${Math.round(size)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y + size * 0.04);
}

function houseGlyph(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(0, -s * 0.55);
  g.lineTo(s * 0.55, -s * 0.05);
  g.lineTo(s * 0.38, -s * 0.05);
  g.lineTo(s * 0.38, s * 0.48);
  g.lineTo(s * 0.1, s * 0.48);
  g.lineTo(s * 0.1, s * 0.15);
  g.lineTo(-s * 0.1, s * 0.15);
  g.lineTo(-s * 0.1, s * 0.48);
  g.lineTo(-s * 0.38, s * 0.48);
  g.lineTo(-s * 0.38, -s * 0.05);
  g.lineTo(-s * 0.55, -s * 0.05);
  g.closePath();
  g.fill();
  g.restore();
}

/** Apple Maps–style balloon marker: round head over a short point. */
function balloon(g: CanvasRenderingContext2D, x: number, y: number, r: number, seen: boolean, emphasis: boolean) {
  const s = emphasis ? 1.12 : 1;
  const R = r * s;
  const cy = y - R * 1.55;
  g.save();
  shadow(g, 10, 3, 0.5);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x - R * 0.42, cy + R * 0.82);
  g.arc(x, cy, R, Math.PI * 0.72, Math.PI * 0.28);
  g.closePath();
  g.fillStyle = '#fff';
  g.fill();
  g.restore();
  g.beginPath();
  g.arc(x, cy, R - 2, 0, Math.PI * 2);
  g.fillStyle = seen ? C.pinSeen : C.pinNew;
  g.fill();
  // glyph: camera (to scout) or check (seen)
  g.save();
  g.translate(x, cy);
  const k = R / 13;
  g.lineWidth = 2 * k;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  if (seen) {
    g.strokeStyle = '#fff';
    g.beginPath();
    g.moveTo(-5 * k, 0.5 * k);
    g.lineTo(-1.5 * k, 4 * k);
    g.lineTo(5.5 * k, -3.5 * k);
    g.stroke();
  } else {
    g.fillStyle = '#1c1c1e';
    roundRect(g, -6.5 * k, -3.5 * k, 13 * k, 9 * k, 2 * k);
    g.fill();
    g.fillRect(-2.5 * k, -5.5 * k, 5 * k, 2.5 * k);
    g.beginPath();
    g.arc(0, 1 * k, 2.6 * k, 0, Math.PI * 2);
    g.fillStyle = C.pinNew;
    g.fill();
  }
  g.restore();
  // ground dot
  g.beginPath();
  g.arc(x, y, 2.5, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
}

function evidenceCells(site: Site, run: Run): Observation[] {
  return site.observations.filter((o) => run.revealedObservationIds.includes(o.id));
}

/** Chevrons along a polyline every `step` px (direction of travel). */
function chevrons(g: CanvasRenderingContext2D, pts: { x: number; y: number }[], step: number, size: number) {
  let carry = step * 0.5;
  g.save();
  g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  g.lineWidth = 1.8;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let d = carry;
    while (d < len) {
      const cx = a.x + ux * d;
      const cy = a.y + uy * d;
      g.beginPath();
      g.moveTo(cx - ux * size - uy * size, cy - uy * size + ux * size);
      g.lineTo(cx, cy);
      g.lineTo(cx - ux * size + uy * size, cy - uy * size - ux * size);
      g.stroke();
      d += step;
    }
    carry = d - len;
  }
  g.restore();
}

export function render(g: CanvasRenderingContext2D, v: View, s: RenderState): void {
  const { site, run } = s;
  const { px } = v;
  g.clearRect(0, 0, v.w, v.h);
  g.fillStyle = C.bg;
  g.fillRect(0, 0, v.w, v.h);

  const gx = v.ox;
  const gy = v.oy;
  const gw = px * site.width;
  const gh = px * site.height;
  const ppm = px / site.cellSizeM; // pixels per metre
  const backdrop = s.layers.imagery ? (s.backdrop ?? null) : null;

  // --- real imagery, full-bleed, positioned in metres from the grid centre
  if (backdrop) {
    const cx = gx + gw / 2;
    const cy = gy + gh / 2;
    const e = backdrop.extent;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(backdrop.canvas as CanvasImageSource, cx + e.west * ppm, cy - e.north * ppm, (e.east - e.west) * ppm, (e.north - e.south) * ppm);
    // focus: dim everything outside the planning grid
    g.save();
    g.beginPath();
    g.rect(0, 0, v.w, v.h);
    g.rect(gx, gy, gw, gh);
    g.fillStyle = 'rgba(0, 0, 0, 0.34)';
    g.fill('evenodd');
    g.restore();
    // soft vignette at the screen edges
    const vg = g.createRadialGradient(cx, cy, Math.min(v.w, v.h) * 0.45, cx, cy, Math.max(v.w, v.h) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vg;
    g.fillRect(0, 0, v.w, v.h);
  }

  // --- inside the grid
  g.save();
  g.beginPath();
  g.rect(gx, gy, gw, gh);
  g.clip();
  if (!backdrop) {
    if (s.layers.imagery && s.texture && s.texture.complete && s.texture.naturalWidth) {
      g.drawImage(s.texture, gx, gy, gw, gh);
    } else {
      const hs = site.elevationM.filter((e): e is number => typeof e === 'number');
      const lo = Math.min(...hs, 0);
      const hi = Math.max(...hs, lo + 1);
      for (let row = 0; row < site.height; row++) {
        for (let col = 0; col < site.width; col++) {
          const e = elevationAt(site, { col, row });
          if (e === null) continue;
          const t = (e - lo) / (hi - lo);
          g.fillStyle = `hsl(22, 24%, ${20 + t * 24}%)`;
          g.fillRect(gx + col * px, gy + row * px, px + 0.5, px + 0.5);
        }
      }
    }
  }

  if (s.layers.slope) {
    for (let row = 0; row < site.height; row++) {
      for (let col = 0; col < site.width; col++) {
        const d = s.slopes[row * site.width + col];
        if (d === null || d === undefined) continue;
        g.fillStyle = slopeColor(d);
        g.fillRect(gx + col * px, gy + row * px, px + 0.5, px + 0.5);
      }
    }
  }

  // missing data is always visible, never flat
  const pat = hatchPattern(g);
  for (let row = 0; row < site.height; row++) {
    for (let col = 0; col < site.width; col++) {
      if (isMapped(site, { col, row })) continue;
      g.fillStyle = pat ?? 'rgba(12,12,14,0.85)';
      g.fillRect(gx + col * px, gy + row * px, px + 0.5, px + 0.5);
    }
  }

  // hairline grid (only every 5th line when cells are small, so the ground stays readable)
  const every = px < 28 ? 5 : 1;
  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let col = every; col < site.width; col += every) {
    g.moveTo(gx + col * px + 0.5, gy);
    g.lineTo(gx + col * px + 0.5, gy + gh);
  }
  for (let row = every; row < site.height; row += every) {
    g.moveTo(gx, gy + row * px + 0.5);
    g.lineTo(gx + gw, gy + row * px + 0.5);
  }
  g.stroke();

  if (s.layers.evidence) {
    for (const o of evidenceCells(site, run)) {
      for (const c of o.characterizedCells) {
        g.fillStyle = C.evidence;
        g.fillRect(gx + c.col * px + 1, gy + c.row * px + 1, px - 2, px - 2);
        g.strokeStyle = C.evidenceEdge;
        g.lineWidth = 1;
        g.strokeRect(gx + c.col * px + 3.5, gy + c.row * px + 3.5, px - 7, px - 7);
      }
    }
  }
  g.restore();

  // grid frame
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 12;
  g.strokeStyle = C.frame;
  g.lineWidth = 1.5;
  g.strokeRect(gx + 0.75, gy + 0.75, gw - 1.5, gh - 1.5);
  g.restore();

  // --- routes: casing + core; alternatives underneath and quieter
  const ordered = s.routes.map((r, i) => ({ r, i })).sort((a, b) => Number(a.r.id === run.selectedRouteId) - Number(b.r.id === run.selectedRouteId));
  for (const { r, i } of ordered) {
    if ((r.path ?? r.cells).length < 2) continue;
    const sel = r.id === run.selectedRouteId;
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    // fan parallel routes out symmetrically so overlapping legs stay distinguishable
    const off = (i - (s.routes.length - 1) / 2) * Math.max(3, Math.min(6, px * 0.08));
    const pts = (r.path ?? r.cells).map((c) => {
      const p = cellCenter(v, c);
      return { x: p.x + off, y: p.y + off };
    });
    const path = () => {
      g.beginPath();
      pts.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    };
    const quiet = !!run.selectedRouteId && !sel;
    const core = sel ? 6 : 4.5;
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.globalAlpha = quiet ? 0.6 : 1;
    shadow(g, 6, 1, 0.4);
    path();
    g.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    g.lineWidth = core + 2.5;
    g.stroke();
    g.shadowColor = 'transparent';
    path();
    g.strokeStyle = color;
    g.lineWidth = core;
    g.stroke();
    g.restore();
    if (sel) chevrons(g, pts, Math.max(36, px * 0.75), 3);
  }

  // --- camera → pictured feature (camera position is not the feature)
  if (s.layers.evidence) {
    for (const o of evidenceCells(site, run)) {
      if (!o.cameraCell) continue;
      const a = cellCenter(v, o.cameraCell);
      const b = cellCenter(v, o.cell);
      g.save();
      g.strokeStyle = 'rgba(100, 210, 255, 0.9)';
      g.setLineDash([2, 4]);
      g.lineWidth = 1.5;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.setLineDash([]);
      disc(g, a.x, a.y, 9, '#1c1c1e');
      g.fillStyle = '#64d2ff';
      roundRect(g, a.x - 4, a.y - 2.5, 8, 6, 1.5);
      g.fill();
      g.restore();
    }
  }

  // --- unreachable stops
  for (const u of s.unreachable) {
    const p = cellCenter(v, u.cell);
    const pulse = 0.5 + 0.5 * Math.sin(s.time * 4);
    g.beginPath();
    g.arc(p.x, p.y, px * 0.42 + pulse * 4, 0, Math.PI * 2);
    g.strokeStyle = C.danger;
    g.lineWidth = 2.5;
    g.stroke();
  }

  // labels go on last, above every line and marker
  const labels: [string, number, number][] = [];

  // --- base
  {
    const p = cellCenter(v, site.base);
    const r = Math.max(13, Math.min(18, px * 0.2));
    disc(g, p.x, p.y, r, C.base);
    houseGlyph(g, p.x, p.y, r * 0.95);
    labels.push(['Base', p.x, p.y + r + 5]);
  }

  // --- science stations
  for (const st of site.stations) {
    const p = cellCenter(v, st.cell);
    const r = Math.max(13, Math.min(18, px * 0.2));
    const order = run.stationOrder.indexOf(st.id);
    disc(g, p.x, p.y, r, C.station);
    glyphText(g, order >= 0 ? String(order + 1) : '·', p.x, p.y, r * 1.0, '#fff');
    labels.push([st.name, p.x, p.y + r + 5]);
  }

  // --- waypoints
  run.waypoints.forEach((w, i) => {
    const p = cellCenter(v, w);
    const r = Math.max(10, Math.min(13, px * 0.15));
    const moving = s.mode.kind === 'move' && s.mode.index === i;
    if (moving) {
      g.save();
      g.setLineDash([3, 3]);
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
    disc(g, p.x, p.y, r, C.waypoint);
    glyphText(g, String(i + 1), p.x, p.y, r * 1.05, ROUTE_COLORS[0]);
  });

  // --- scouting markers
  for (const o of site.observations) {
    const p = cellCenter(v, o.cell);
    const seen = run.revealedObservationIds.includes(o.id);
    const emph = sameCell(s.focusCell, o.cell) || sameCell(s.hover, o.cell);
    balloon(g, p.x, p.y + px * 0.25, Math.max(11, Math.min(14, px * 0.16)), seen, emph);
  }

  for (const [text, x, y] of labels) label(g, text, x, y);

  // --- hover / keyboard cursor
  const outline = (c: Cell, color: string, dash: number[]) => {
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.setLineDash(dash);
    roundRect(g, gx + c.col * px + 2, gy + c.row * px + 2, px - 4, px - 4, 6);
    g.stroke();
    g.restore();
  };
  if (s.hover) outline(s.hover, 'rgba(255,255,255,0.75)', []);
  if (s.showCursor && s.cursor) outline(s.cursor, s.mode.kind === 'select' ? '#ffffff' : ROUTE_COLORS[0], [5, 4]);

  // --- scale bar (Apple Maps: segmented, top-left of the grid)
  {
    const nice = [5, 10, 20, 25, 50, 100, 200];
    const target = 120 / ppm;
    const m = nice.reduce((best, n) => (Math.abs(n - target) < Math.abs(best - target) ? n : best), nice[0]);
    const bar = m * ppm;
    const x0 = gx;
    const y0 = gy - 14;
    if (y0 > 8) {
      g.save();
      shadow(g, 4, 0, 0.6);
      g.fillStyle = '#fff';
      g.fillRect(x0, y0, bar, 3);
      g.fillRect(x0, y0 - 4, 1.5, 7);
      g.fillRect(x0 + bar / 2 - 0.75, y0 - 2, 1.5, 5);
      g.fillRect(x0 + bar - 1.5, y0 - 4, 1.5, 7);
      g.restore();
      g.save();
      g.font = `600 11px ${FONT}`;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.lineWidth = 3;
      g.strokeStyle = C.halo;
      g.lineJoin = 'round';
      g.strokeText(`${m} m`, x0 + bar + 8, y0 + 1);
      g.fillStyle = '#fff';
      g.fillText(`${m} m`, x0 + bar + 8, y0 + 1);
      g.restore();
    }
  }
}

export const coveredKeys = (site: Site, run: Run): Set<string> => {
  const s = new Set<string>();
  for (const o of evidenceCells(site, run)) o.characterizedCells.forEach((c) => s.add(cellKey(c)));
  return s;
};
