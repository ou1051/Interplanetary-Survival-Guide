import { UrlTemplateImageryProvider, type ImageryTypes, type Request } from 'cesium';
import { LruCache } from './dem';

// ---------------------------------------------------------------------------
// Natural-colour high-resolution imagery.
// CTX (5–6 m/px) and HiRISE red-band (25 cm/px) mosaics are greyscale. Shown as
// they are, the planet turns grey as you zoom in. We keep their *luminance*
// (all the detail) and take *hue and saturation* from the Viking colour mosaic
// under the same ground: canvas "color" blending, per tile. Viking's colour is
// low-frequency, so a 256 px Viking tile up to seven levels coarser is plenty.
// ---------------------------------------------------------------------------

export interface ColorBase {
  /** URL template ({z}/{y}/{x}) of a colour mosaic in the same geographic 2 × 1 tiling. */
  url: string;
  tileSize: number;
  maxLevel: number;
}

/** Which part of a colour tile lies under a detail tile (pixel rectangle in the colour tile). */
export function colorPatch(x: number, y: number, level: number, base: Pick<ColorBase, 'tileSize' | 'maxLevel'>) {
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

const fill = (url: string, z: number, y: number, x: number) => url.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x));

export class ColorBaseCache {
  private cache = new LruCache<Promise<ImageBitmap | null>>(96);
  constructor(readonly base: ColorBase) {}

  tile(level: number, y: number, x: number): Promise<ImageBitmap | null> {
    const key = `${level}/${y}/${x}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = fetch(fill(this.base.url, level, y, x))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? createImageBitmap(b) : null))
      .catch(() => null);
    this.cache.set(key, p);
    return p;
  }
}

/**
 * Luminance from `detail`, chroma from `color` (already cropped by the caller's
 * source rectangle), alpha from `detail`. `flipped` = Cesium's pre-flipped ImageBitmap.
 */
export function composite(
  detail: CanvasImageSource & { width: number; height: number },
  flipped: boolean,
  color: ImageBitmap | null,
  patch: { sx: number; sy: number; size: number },
  strength: number,
): HTMLCanvasElement {
  const w = detail.width;
  const h = detail.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const drawDetail = () => {
    if (!flipped) return g.drawImage(detail, 0, 0);
    g.save();
    g.translate(0, h);
    g.scale(1, -1);
    g.drawImage(detail, 0, 0);
    g.restore();
  };
  drawDetail();
  if (color) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.globalCompositeOperation = 'color';
    g.globalAlpha = strength;
    g.drawImage(color, patch.sx, patch.sy, patch.size, patch.size, 0, 0, w, h);
    // the blend fills transparent (no-data) pixels too: restore the detail's alpha
    g.globalCompositeOperation = 'destination-in';
    g.globalAlpha = 1;
    drawDetail();
  }
  return c;
}

/** One shared compositing worker for all colourised layers. */
class ColorWorker {
  private worker: Worker;
  private pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: unknown) => void }>();
  private next = 1;
  constructor() {
    this.worker = new Worker(new URL('./colorWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.bitmap) p.resolve(e.data.bitmap);
      else p.reject(new Error(e.data.error ?? 'colour worker failed'));
    };
  }
  run(detail: ImageBitmap, colorUrl: string, patch: { sx: number; sy: number; size: number }, strength: number): Promise<ImageBitmap> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, detail, colorUrl, patch, strength }, [detail]);
    });
  }
}

let shared: ColorWorker | null = null;
const workerSupported = () => typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof ImageBitmap !== 'undefined';

/** UrlTemplate provider whose greyscale tiles come back tinted with real Mars colour. */
export class ColorizedImageryProvider extends UrlTemplateImageryProvider {
  constructor(
    options: ConstructorParameters<typeof UrlTemplateImageryProvider>[0],
    private colors: ColorBaseCache,
    private strength = 0.9,
  ) {
    super(options);
  }

  override requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> | undefined {
    const detail = super.requestImage(x, y, level, request);
    if (!detail) return undefined; // throttled: Cesium will ask again
    const p = colorPatch(x, y, level, this.colors.base);
    return detail.then((img) => {
      if (img instanceof ImageBitmap && workerSupported()) {
        shared ??= new ColorWorker();
        const url = fill(this.colors.base.url, p.level, p.y, p.x);
        // On failure, show the tile greyscale rather than not at all.
        return shared.run(img, url, p, this.strength).catch(() => img);
      }
      // Fallback (no OffscreenCanvas / HTMLImageElement tiles): main-thread canvas.
      return this.colors.tile(p.level, p.y, p.x).then((color) => composite(img as ImageBitmap, false, color, p, this.strength));
    });
  }
}
