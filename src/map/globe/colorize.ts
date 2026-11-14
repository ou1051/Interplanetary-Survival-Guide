import { Credit, GeographicTilingScheme, UrlTemplateImageryProvider, type Ellipsoid, type ImageryTypes, type Request } from 'cesium';
import { PAINT_MAX_LEVEL, PAINT_TILE } from './marsPaint';
import { marsWorker, workerSupported, type MarsWorker } from './workerBridge';

// ---------------------------------------------------------------------------
// Imagery providers backed by the globe's worker (marsWorker.ts).
//
// PaintedMarsProvider   the designed base surface: Viking albedo mapped onto a
//                       true-colour palette, multiplied by MOLA shaded relief.
// TintedImageryProvider greyscale CTX/HiRISE tiles are pan-sharpened onto the
//                       painted surface (detail transfer): colour and brightness
//                       stay the painted ones, the mosaic adds its structure, so
//                       nothing jumps when detail takes over and mosaics with
//                       different processing meet without seams.
// Both return ImageBitmaps composited off the main thread (an earlier
// main-thread canvas version froze flights for ~1 s per batch of tiles).
// ---------------------------------------------------------------------------

export { workerSupported };
export { colorPatch } from './marsPaint';

/** The worker-painted Mars surface. It makes no requests itself: the worker fetches Viking + MOLA. */
export class PaintedMarsProvider extends UrlTemplateImageryProvider {
  private w: MarsWorker;
  constructor(ellipsoid: Ellipsoid, credit: string) {
    super({
      url: 'painted://{z}/{y}/{x}', // never fetched: requestImage is overridden
      tilingScheme: new GeographicTilingScheme({ ellipsoid }),
      tileWidth: PAINT_TILE,
      tileHeight: PAINT_TILE,
      maximumLevel: PAINT_MAX_LEVEL,
      credit: new Credit(credit),
      hasAlphaChannel: false,
    });
    this.w = marsWorker();
  }

  override requestImage(x: number, y: number, level: number): Promise<ImageryTypes> | undefined {
    return this.w.paint(x, y, level);
  }

  dispose() {
    this.w.release();
  }
}

/** UrlTemplate provider whose greyscale tiles come back in the painted surface's colour. */
export class TintedImageryProvider extends UrlTemplateImageryProvider {
  private w: MarsWorker;
  constructor(
    options: ConstructorParameters<typeof UrlTemplateImageryProvider>[0],
    private src: { url: string; tileSize: number; blackIsNoData: boolean },
  ) {
    super(options);
    this.w = marsWorker();
  }

  override requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> | undefined {
    const detail = super.requestImage(x, y, level, request);
    if (!detail) return undefined; // throttled: Cesium will ask again
    // the bitmap is transferred to the worker; a failure surfaces as a tile error
    return detail.then((img): ImageryTypes | Promise<ImageryTypes> => (img instanceof ImageBitmap ? this.w.tint(img, x, y, level, this.src) : img));
  }

  dispose() {
    this.w.release();
  }
}
