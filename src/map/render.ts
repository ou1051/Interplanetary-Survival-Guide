import type { Cell, Observation, RoutePlan, Run, Site } from './contracts';
import { cellKey, elevationAt, isMapped, sameCell, type Stop } from './grid';

// Canvas renderer for the mission map. Stateless: everything comes in `RenderState`.

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

export const ROUTE_COLORS = ['#5ad1ff', '#f2b25c'];
const C = {
  bg: '#0c0e11',
  grid: 'rgba(255,255,255,0.06)',
  ink: '#f4efe9',
  base: '#f4efe9',
  station: '#ffffff',
  pinNew: '#ffd27a',
  pinSeen: '#7ee0a8',
  evidence: 'rgba(90,209,255,0.18)',
  evidenceEdge: 'rgba(90,209,255,0.55)',
  danger: '#ff6b5b',
  wp: '#c9b8ff',
};

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
  if (deg < 5) return 'rgba(76, 201, 128, 0.42)';
  if (deg < 15) return 'rgba(242, 178, 92, 0.5)';
  return 'rgba(255, 107, 91, 0.58)';
}

let hatch: CanvasPattern | null = null;
function hatchPattern(g: CanvasRenderingContext2D): CanvasPattern | null {
  if (hatch) return hatch;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 10;
  const p = c.getContext('2d');
  if (!p) return null;
  p.fillStyle = '#16181c';
  p.fillRect(0, 0, 10, 10);
  p.strokeStyle = 'rgba(255,255,255,0.18)';
  p.lineWidth = 1.5;
  p.beginPath();
  p.moveTo(0, 10);
  p.lineTo(10, 0);
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

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, color = C.ink) {
  g.font = '600 12px Inter, ui-sans-serif, system-ui, sans-serif';
  const w = g.measureText(text).width + 14;
  roundRect(g, x - w / 2, y - 10, w, 20, 10);
  g.fillStyle = 'rgba(12,14,17,0.82)';
  g.fill();
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y + 0.5);
}

function drawPin(g: CanvasRenderingContext2D, x: number, y: number, s: number, seen: boolean, emphasis: boolean) {
  const col = seen ? C.pinSeen : C.pinNew;
  g.save();
  g.translate(x, y);
  if (emphasis) {
    g.beginPath();
    g.arc(0, -s * 0.9, s * 1.25, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fill();
  }
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(-s * 0.15, -s * 0.35, -s * 0.75, -s * 0.6, -s * 0.75, -s * 1.05);
  g.arc(0, -s * 1.05, s * 0.75, Math.PI, 0);
  g.bezierCurveTo(s * 0.75, -s * 0.6, s * 0.15, -s * 0.35, 0, 0);
  g.closePath();
  g.fillStyle = seen ? col : 'rgba(12,14,17,0.85)';
  g.strokeStyle = col;
  g.lineWidth = 2;
  g.fill();
  g.stroke();
  g.beginPath();
  if (seen) {
    g.strokeStyle = '#0c0e11';
    g.lineWidth = 2;
    g.moveTo(-s * 0.3, -s * 1.05);
    g.lineTo(-s * 0.05, -s * 0.8);
    g.lineTo(s * 0.35, -s * 1.3);
    g.stroke();
  } else {
    g.arc(0, -s * 1.05, s * 0.25, 0, Math.PI * 2);
    g.fillStyle = col;
    g.fill();
  }
  g.restore();
}

function evidenceCells(site: Site, run: Run): Observation[] {
  return site.observations.filter((o) => run.revealedObservationIds.includes(o.id));
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

  // --- base layer: orbital image, or neutral elevation shading
  g.save();
  roundRect(g, gx, gy, gw, gh, 10);
  g.clip();
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
        const l = 22 + t * 26;
        g.fillStyle = `hsl(24, 22%, ${l}%)`;
        g.fillRect(gx + col * px, gy + row * px, px + 0.5, px + 0.5);
      }
    }
  }

  // --- slope overlay
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

  // --- missing data is always visible, never flat
  const pat = hatchPattern(g);
  for (let row = 0; row < site.height; row++) {
    for (let col = 0; col < site.width; col++) {
      if (isMapped(site, { col, row })) continue;
      g.fillStyle = pat ?? '#16181c';
      g.fillRect(gx + col * px, gy + row * px, px + 0.5, px + 0.5);
    }
  }

  // --- grid
  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let col = 1; col < site.width; col++) {
    g.moveTo(gx + col * px + 0.5, gy);
    g.lineTo(gx + col * px + 0.5, gy + gh);
  }
  for (let row = 1; row < site.height; row++) {
    g.moveTo(gx, gy + row * px + 0.5);
    g.lineTo(gx + gw, gy + row * px + 0.5);
  }
  g.stroke();

  // --- evidence coverage
  if (s.layers.evidence) {
    for (const o of evidenceCells(site, run)) {
      for (const c of o.characterizedCells) {
        g.fillStyle = C.evidence;
        g.fillRect(gx + c.col * px + 2, gy + c.row * px + 2, px - 4, px - 4);
        g.strokeStyle = C.evidenceEdge;
        g.setLineDash([4, 3]);
        g.strokeRect(gx + c.col * px + 2.5, gy + c.row * px + 2.5, px - 5, px - 5);
        g.setLineDash([]);
      }
    }
  }
  g.restore();

  // frame
  roundRect(g, gx + 0.5, gy + 0.5, gw - 1, gh - 1, 10);
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.lineWidth = 1;
  g.stroke();

  // --- routes (unselected first, dashed)
  const ordered = s.routes.map((r, i) => ({ r, i })).sort((a, b) => Number(a.r.id === run.selectedRouteId) - Number(b.r.id === run.selectedRouteId));
  for (const { r, i } of ordered) {
    if (r.cells.length < 2) continue;
    const sel = r.id === run.selectedRouteId;
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    const off = s.routes.length > 1 ? (i === 0 ? -1 : 1) * Math.max(2, px * 0.05) : 0;
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    if (sel) {
      g.shadowColor = color;
      g.shadowBlur = 12;
    }
    g.strokeStyle = color;
    g.globalAlpha = sel || !run.selectedRouteId ? 1 : 0.55;
    g.lineWidth = sel ? 4 : 2.5;
    g.setLineDash(sel ? [] : [7, 6]);
    g.beginPath();
    r.cells.forEach((c, k) => {
      const p = cellCenter(v, c);
      if (k === 0) g.moveTo(p.x + off, p.y + off);
      else g.lineTo(p.x + off, p.y + off);
    });
    g.stroke();
    g.restore();
  }

  // --- camera → pictured feature (camera position is not the feature)
  if (s.layers.evidence) {
    for (const o of evidenceCells(site, run)) {
      if (!o.cameraCell) continue;
      const a = cellCenter(v, o.cameraCell);
      const b = cellCenter(v, o.cell);
      g.save();
      g.strokeStyle = 'rgba(126,224,168,0.8)';
      g.setLineDash([3, 4]);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(12,14,17,0.9)';
      g.strokeStyle = 'rgba(126,224,168,0.9)';
      roundRect(g, a.x - 8, a.y - 6, 16, 12, 3);
      g.fill();
      g.stroke();
      g.beginPath();
      g.arc(a.x, a.y, 3, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
  }

  // --- unreachable stops
  for (const u of s.unreachable) {
    const p = cellCenter(v, u.cell);
    const pulse = 0.5 + 0.5 * Math.sin(s.time * 4);
    g.beginPath();
    g.arc(p.x, p.y, px * 0.42 + pulse * 3, 0, Math.PI * 2);
    g.strokeStyle = C.danger;
    g.lineWidth = 2.5;
    g.stroke();
  }

  // --- base
  {
    const p = cellCenter(v, site.base);
    const r = Math.max(9, px * 0.22);
    roundRect(g, p.x - r, p.y - r, r * 2, r * 2, 5);
    g.fillStyle = C.base;
    g.fill();
    g.fillStyle = '#0c0e11';
    g.font = `700 ${Math.round(r)}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('B', p.x, p.y + 1);
    label(g, 'Base', p.x, p.y + r + 16);
  }

  // --- stations
  for (const st of site.stations) {
    const p = cellCenter(v, st.cell);
    const r = Math.max(10, px * 0.24);
    g.save();
    g.translate(p.x, p.y);
    g.rotate(Math.PI / 4);
    g.fillStyle = 'rgba(12,14,17,0.9)';
    g.strokeStyle = C.station;
    g.lineWidth = 2.5;
    g.fillRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4);
    g.strokeRect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4);
    g.restore();
    const order = run.stationOrder.indexOf(st.id);
    g.fillStyle = C.station;
    g.font = `700 ${Math.round(r * 0.8)}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(order >= 0 ? String(order + 1) : '·', p.x, p.y + 1);
    label(g, st.name, p.x, p.y + r + 16);
  }

  // --- waypoints
  run.waypoints.forEach((w, i) => {
    const p = cellCenter(v, w);
    const r = Math.max(8, px * 0.17);
    const moving = s.mode.kind === 'move' && s.mode.index === i;
    g.beginPath();
    g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fillStyle = moving ? 'rgba(201,184,255,0.25)' : '#0c0e11';
    g.fill();
    g.strokeStyle = C.wp;
    g.lineWidth = 2;
    g.setLineDash(moving ? [3, 3] : []);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = C.wp;
    g.font = `700 ${Math.round(r)}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(i + 1), p.x, p.y + 1);
  });

  // --- scouting pins
  for (const o of site.observations) {
    const p = cellCenter(v, o.cell);
    const seen = run.revealedObservationIds.includes(o.id);
    const emph = sameCell(s.focusCell, o.cell) || sameCell(s.hover, o.cell);
    drawPin(g, p.x, p.y + px * 0.22, Math.max(10, px * 0.2), seen, emph);
  }

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
  if (s.hover) outline(s.hover, 'rgba(255,255,255,0.45)', []);
  if (s.showCursor && s.cursor) outline(s.cursor, s.mode.kind === 'select' ? '#ffffff' : C.wp, [5, 4]);

  // --- north arrow + scale bar
  g.save();
  g.fillStyle = 'rgba(244,239,233,0.85)';
  g.font = '600 11px Inter, system-ui, sans-serif';
  g.textAlign = 'center';
  const nx = gx + gw - 18;
  const ny = gy + 16;
  g.beginPath();
  g.moveTo(nx, ny - 8);
  g.lineTo(nx + 6, ny + 6);
  g.lineTo(nx, ny + 3);
  g.lineTo(nx - 6, ny + 6);
  g.closePath();
  g.fill();
  g.fillText('N', nx, ny + 19);
  const cells = Math.max(1, Math.round(80 / px));
  const bar = cells * px;
  const by = gy + gh + 14;
  if (by + 10 < v.h) {
    g.fillRect(gx, by, bar, 2);
    g.fillRect(gx, by - 4, 1.5, 8);
    g.fillRect(gx + bar - 1.5, by - 4, 1.5, 8);
    g.textAlign = 'left';
    g.fillText(`${cells * site.cellSizeM} m`, gx + bar + 8, by + 4);
  }
  g.restore();
}

export const coveredKeys = (site: Site, run: Run): Set<string> => {
  const s = new Set<string>();
  for (const o of evidenceCells(site, run)) o.characterizedCells.forEach((c) => s.add(cellKey(c)));
  return s;
};
