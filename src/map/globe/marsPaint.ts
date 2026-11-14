// ---------------------------------------------------------------------------
// "Painted" Mars: the globe's base surface, designed rather than displayed.
//
// Colour: Viking MDIM 2.1 is a superb albedo map but a poor colour reference:
// measured over the whole planet its median ground is a greyish mauve
// (≈ 130, 99, 94), dark regions are purple-grey and frost/cloud is bluish.
// We keep only its *albedo* (luminance, percentiles 1 %…99 % ≈ 46…208) and map
// it onto a palette drawn from true-colour views of Mars (Emirates Mars Mission
// EXI, Hubble, Mars Express): dark basaltic sand → umber, dusty plains → ochre
// and butterscotch, frost and polar ice → off-white. Bluish, bright pixels in
// Viking (frost, ice, clouds) blend towards ice.
//
// Relief: hillshade from the MOLA/HRSC 200 m DEM, sun from the north-west,
// exaggerated at planetary scale so craters, volcanoes and canyons read from
// orbit, flattening towards true scale as you zoom in.
// Pure functions (no DOM, no Cesium): run in the worker and in unit tests.
// ---------------------------------------------------------------------------

import { sampleRaster, tileRect, type SourceRaster } from './dem';

export const PAINT_TILE = 256;
/** Deepest painted level (Viking colour ends at 7; relief keeps helping a bit beyond). */
export const PAINT_MAX_LEVEL = 8;
const M_PER_DEG = (2 * Math.PI * 3_396_190) / 360;

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Albedo palette: position along Viking luminance (0 = 1st pct, 1 = 99th pct) → colour. */
export const PALETTE: [number, RGB][] = [
  [0.0, hex('#1a110c')],
  [0.1, hex('#382419')], // dark basaltic sand: Syrtis Major, Acidalia, Meridiani
  [0.22, hex('#5e3a25')],
  [0.33, hex('#8a5232')], // the median plains
  [0.42, hex('#a8643a')],
  [0.55, hex('#c07c4a')], // dusty highlands: Tharsis, Arabia
  [0.7, hex('#d49c6b')],
  [0.86, hex('#e0b98f')],
  [1.0, hex('#eccfae')], // the brightest dust stays butterscotch; only ice is white
];
export const ICE: RGB = hex('#f3f1ee');
export const LUMA_LO = 46;
export const LUMA_HI = 208;

export function palette(t: number): RGB {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < PALETTE.length; i++) {
    const [t1, c1] = PALETTE[i];
    if (x <= t1) {
      const [t0, c0] = PALETTE[i - 1];
      const k = (x - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return PALETTE[PALETTE.length - 1][1];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Viking pixel → designed albedo colour. `lat` (°) gates ice: polar caps and
 * seasonal frost only exist poleward of ~55°; at low latitudes Viking's bright
 * bluish pixels are sunlit slopes and processing artefacts, not ice.
 */
export function albedo(r: number, g: number, b: number, lat = 90): RGB {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const base = palette((luma - LUMA_LO) / (LUMA_HI - LUMA_LO));
  // bright *and* bluish in Viking, at high latitude = frost or polar ice
  const ice = smooth(-0.02, 0.07, (b - r) / 255) * smooth(135, 185, luma) * smooth(52, 64, Math.abs(lat));
  if (ice <= 0) return base;
  const l = Math.min(1, luma / 215);
  return [
    base[0] + (ICE[0] * l - base[0]) * ice,
    base[1] + (ICE[1] * l - base[1]) * ice,
    base[2] + (ICE[2] * l - base[2]) * ice,
  ];
}

/** Vertical exaggeration for the hillshade at a display level. */
export const shadeExaggeration = (level: number) => Math.min(6, Math.max(1.5, 6 * 0.75 ** level));

/** DEM level read for a painted tile: ≈ one post per pixel, capped at the DEM depth. */
export const demLevelFor = (level: number, demMax = 7) => Math.max(0, Math.min(demMax, level - 1));

/** Allocation-free bilinear sample for unmasked rasters (the hillshade hot path). */
function bilinear(src: SourceRaster, lon: number, lat: number): number {
  if (src.mask) return sampleRaster(src, lon, lat);
  const { width: w, height: h, rect, pixels } = src;
  const u = (lon - rect.west) / (rect.east - rect.west);
  const v = (rect.north - lat) / (rect.north - rect.south);
  let fx = src.posts ? u * (w - 1) : u * w - 0.5;
  let fy = src.posts ? v * (h - 1) : v * h - 0.5;
  fx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
  fy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const a = pixels[y0 * w + x0];
  const b = pixels[y0 * w + x1];
  const c = pixels[y1 * w + x0];
  const d = pixels[y1 * w + x1];
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  const r = top + (bot - top) * ty;
  return Number.isFinite(r) && r > -1e20 ? r : sampleRaster(src, lon, lat);
}

// sun from the north-west, 38° above the horizon
const SUN_AZ = (315 * Math.PI) / 180;
const SUN_ALT = (38 * Math.PI) / 180;
const SX = Math.sin(SUN_AZ) * Math.cos(SUN_ALT); // east component
const SY = Math.cos(SUN_AZ) * Math.cos(SUN_ALT); // north component
const SZ = Math.sin(SUN_ALT);

/**
 * Shade factor per pixel (row 0 = north), 1 = flat ground. Heights come from
 * `dem` (any source tile containing the painted tile; its posts outside the
 * tile give seamless gradients at the edges).
 */
export function hillshade(dem: SourceRaster, x: number, y: number, level: number, size = PAINT_TILE): Float32Array {
  const rect = tileRect(x, y, level);
  const span = rect.east - rect.west;
  const dpp = span / size;
  const ex = shadeExaggeration(level);
  // heights at pixel centres, with a 1-pixel margin
  const n = size + 2;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const lat = rect.north - (j - 0.5) * dpp;
    for (let i = 0; i < n; i++) {
      const lon = rect.west + (i - 0.5) * dpp;
      h[j * n + i] = bilinear(dem, lon, lat);
    }
  }
  const out = new Float32Array(size * size);
  const dyM = dpp * M_PER_DEG;
  for (let j = 0; j < size; j++) {
    const lat = rect.north - (j + 0.5) * dpp;
    const dxM = dyM * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    for (let i = 0; i < size; i++) {
      const c = (j + 1) * n + (i + 1);
      const dzdx = ((h[c + 1] - h[c - 1]) / (2 * dxM)) * ex; // east
      const dzdy = ((h[c - n] - h[c + n]) / (2 * dyM)) * ex; // north
      const len = Math.hypot(dzdx, dzdy, 1);
      const lambert = (-dzdx * SX - dzdy * SY + SZ) / len;
      out[j * size + i] = Math.max(0, lambert) / SZ;
    }
  }
  return out;
}

/**
 * Paint a tile: RGBA, row 0 = north. `viking` is the colour tile's RGBA
 * (already cropped/scaled to the painted tile by the caller); `rect` gives the
 * latitudes (for ice).
 */
let lut: Float32Array | null = null;
/** Palette by Viking luminance (0…255), 3 floats each. */
function paletteLut(): Float32Array {
  if (lut) return lut;
  lut = new Float32Array(256 * 3);
  for (let l = 0; l < 256; l++) lut.set(palette((l - LUMA_LO) / (LUMA_HI - LUMA_LO)), l * 3);
  return lut;
}

export function paint(viking: Uint8ClampedArray, shade: Float32Array, size = PAINT_TILE, rect?: { north: number; south: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const pal = paletteLut();
  for (let p = 0; p < size * size; p++) {
    const k = p * 4;
    const vr = viking[k];
    const vg = viking[k + 1];
    const vb = viking[k + 2];
    const luma = 0.299 * vr + 0.587 * vg + 0.114 * vb;
    let r: number, g: number, b: number;
    const lat = rect ? rect.north - ((Math.floor(p / size) + 0.5) * (rect.north - rect.south)) / size : 90;
    if (luma > 135 && vb > vr - 6 && Math.abs(lat) > 52) {
      [r, g, b] = albedo(vr, vg, vb, lat); // rare: possible ice, full computation
    } else {
      const i = Math.min(255, Math.round(luma)) * 3; // common: palette lookup
      r = pal[i];
      g = pal[i + 1];
      b = pal[i + 2];
    }
    // soft light: shadows keep some sky fill, sunlit slopes brighten a little
    const s = shade[p];
    const f = s < 1 ? 0.55 + 0.45 * s : 1 + 0.22 * Math.min(1, s - 1);
    out[k] = r * f;
    out[k + 1] = g * f;
    out[k + 2] = b * f;
    out[k + 3] = 255;
  }
  return out;
}

/** Which part of a colour tile (tileSize px, levels ≤ maxLevel) lies under a detail tile. */
export function colorPatch(x: number, y: number, level: number, base: { tileSize: number; maxLevel: number }) {
  const v = Math.min(level, base.maxLevel);
  const shift = level - v;
  const n = 2 ** shift;
  const size = base.tileSize / n;
  return {
    level: v,
    x: x >> shift,
    y: y >> shift,
    sx: (x - ((x >> shift) << shift)) * size,
    sy: (y - ((y >> shift) << shift)) * size,
    size,
  };
}
