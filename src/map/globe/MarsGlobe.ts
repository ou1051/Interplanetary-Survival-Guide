import './cesiumBase';
import {
  Cartesian3,
  Color,
  Credit,
  DirectionalLight,
  Ellipsoid,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  ImageryLayer,
  Ion,
  Rectangle,
  RequestScheduler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { IMAGERY, SOURCES, type TileSource } from './catalog';
import { PaintedMarsProvider, TintedImageryProvider, workerSupported } from './colorize';
import { createMarsTerrain, type MarsTerrain } from './elevation';

// NASA orbital imagery on MOLA/HRSC + HiRISE terrain for the habitat console.
// No Cesium ion services are used; relief decoding and colour compositing run in a worker.

export interface GlobeOptions {
  exaggeration?: number;
  creditContainer?: HTMLElement;
}

const MARS = Ellipsoid.MARS;

export class MarsGlobe {
  readonly viewer: Viewer;
  private destroyed = false;
  private terrain: MarsTerrain | null = null;
  private providers: { dispose(): void }[] = [];
  private light: DirectionalLight;

  constructor(container: HTMLElement, opts: GlobeOptions = {}) {
    Ion.defaultAccessToken = ''; // never reach Cesium ion
    // both data hosts speak HTTP/2; Cesium's default of 18 parallel requests is conservative
    RequestScheduler.requestsByServer['trek.nasa.gov:443'] = 32;
    RequestScheduler.requestsByServer['astro.arcgis.com:443'] = 32;
    Ellipsoid.default = MARS;

    this.viewer = new Viewer(container, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      terrainProvider: new EllipsoidTerrainProvider({ ellipsoid: MARS }),
      creditContainer: opts.creditContainer,
      skyBox: false,
      skyAtmosphere: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
    });
    const v = this.viewer;
    const scene = v.scene;
    const globe = scene.globe;
    scene.backgroundColor = Color.BLACK;
    globe.baseColor = Color.fromCssColorString('#6b3a22');
    globe.tileCacheSize = 400;
    globe.depthTestAgainstTerrain = true;
    scene.fog.enabled = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.sun) scene.sun.show = false; // the light follows the camera (below), not Earth's sun

    // Camera-relative light; close to the surface, the imagery's own shadows take over.
    this.light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 2.2 });
    scene.light = this.light;
    globe.enableLighting = true;
    globe.dynamicAtmosphereLighting = true;
    globe.dynamicAtmosphereLightingFromSun = false;
    globe.lightingFadeOutDistance = 2.0e6;
    globe.lightingFadeInDistance = 6.0e6;
    globe.showGroundAtmosphere = false;
    scene.preRender.addEventListener(() => this.aimLight());
    scene.screenSpaceCameraController.minimumZoomDistance = 250;
    scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000;
    v.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    const coll = v.imageryLayers;
    for (const src of IMAGERY) {
      coll.add(new ImageryLayer(this.provider(src), {
        alpha: src.alpha ?? 1,
        minimumTerrainLevel: src.minViewLevel,
        colorToAlpha: src.blackIsNoData ? Color.BLACK : undefined,
        colorToAlphaThreshold: 0.01,
        ...src.tone,
      }));
    }
    this.loadTerrain();
    scene.verticalExaggeration = opts.exaggeration ?? 1.5;
  }

  private provider(src: TileSource): UrlTemplateImageryProvider {
    const viaWorker = workerSupported();
    if (src.painted) {
      if (!viaWorker) return this.provider(SOURCES.viking); // old browsers: the raw mosaic
      const painted = new PaintedMarsProvider(MARS, src.credit);
      this.providers.push(painted);
      return painted;
    }
    const options = {
      url: src.url,
      tilingScheme: new GeographicTilingScheme({ ellipsoid: MARS }),
      tileWidth: src.tileSize,
      tileHeight: src.tileSize,
      maximumLevel: src.maxLevel,
      rectangle: src.bbox ? Rectangle.fromDegrees(src.bbox.west, src.bbox.south, src.bbox.east, src.bbox.north) : undefined,
      credit: new Credit(src.credit),
    };
    let p: UrlTemplateImageryProvider;
    if (src.colorize && viaWorker) {
      const tinted = new TintedImageryProvider(options, { url: src.url, tileSize: src.tileSize, blackIsNoData: !!src.blackIsNoData });
      this.providers.push(tinted);
      p = tinted;
    } else p = new UrlTemplateImageryProvider(options);
    p.errorEvent.addEventListener((err: { retry?: boolean }) => {
      // Local mosaics legitimately 404 at their edges; do not retry missing tiles.
      err.retry = false;
    });
    return p;
  }

  private async loadTerrain(): Promise<void> {
    try {
      const terrain = await createMarsTerrain(MARS);
      if (this.destroyed) {
        terrain.dispose();
        return;
      }
      this.terrain = terrain;
      this.viewer.scene.terrainProvider = terrain.provider;
    } catch (e) {
      console.warn('[globe] terrain unavailable', e);
    }
    if (!this.destroyed) this.viewer.scene.requestRender();
  }

  /** Aim the light from above-left of the viewer (set every frame before rendering). */
  private aimLight() {
    const c = this.viewer.camera;
    const d = this.light.direction;
    Cartesian3.multiplyByScalar(c.directionWC, 0.62, d);
    const r = Cartesian3.multiplyByScalar(c.rightWC, 0.66, new Cartesian3());
    const u = Cartesian3.multiplyByScalar(c.upWC, -0.42, new Cartesian3());
    Cartesian3.add(d, r, d);
    Cartesian3.add(d, u, d);
    Cartesian3.normalize(d, d);
  }

  destroy(): void {
    this.destroyed = true;
    this.terrain?.dispose();
    this.providers.forEach((p) => p.dispose());
    this.viewer.destroy();
  }
}
