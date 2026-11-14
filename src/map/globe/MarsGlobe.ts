import './cesiumBase';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Credit,
  DirectionalLight,
  DistanceDisplayCondition,
  EasingFunction,
  Ellipsoid,
  EllipsoidTerrainProvider,
  EllipsoidalOccluder,
  Entity,
  GeographicTilingScheme,
  HeadingPitchRange,
  HeightReference,
  ImageryLayer,
  Ion,
  LabelStyle,
  Math as CMath,
  NearFarScalar,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SkyAtmosphere,
  SkyBox,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { COLOR_BASE, IMAGERY, PLACES, type ImageryStyle, type Place, type TileSource } from './catalog';
import { ColorBaseCache, ColorizedImageryProvider } from './colorize';
import { planFlight } from './flight';
import { createMarsTerrain, type MarsTerrain } from './elevation';
import type { ReliefSource } from './demSource';

// ---------------------------------------------------------------------------
// 3D Mars globe (CesiumJS): natural-colour orbital imagery (Viking colour with
// colour-matched CTX and HiRISE detail) on MOLA/HRSC + HiRISE DTM relief.
// Click anywhere: the camera flies there quickly. Click a place pin: flies to
// that place's framing. No Cesium ion services are used.
//
// Performance notes (measured in Chrome, Nov 2026):
//  - relief decoding lives in a Web Worker; before that, flights stalled the
//    main thread for 100–1000 ms at a time and the heap reached ~650 MB;
//  - MSAA is skipped on high-DPI screens (the native pixels already resolve
//    edges); FXAA only on 1× screens where it is cheap and helps;
//  - the render loop stops while the globe is hidden behind the site plan.
// ---------------------------------------------------------------------------

export interface CursorInfo {
  lat: number;
  lon: number;
  heightM: number | null;
  /** Finest relief loaded under the cursor. */
  relief: ReliefSource | null;
}

export interface CameraInfo {
  /** Height above the ground under the camera when terrain is known, else above the datum. */
  altitudeM: number;
  aboveGround: boolean;
  headingDeg: number;
  pitchDeg: number;
  lat: number;
  lon: number;
}

export interface GlobeEvents {
  onCursor?: (info: CursorInfo | null) => void;
  onCamera?: (info: CameraInfo) => void;
  onPlace?: (place: Place) => void;
  onFlyStart?: (target: { lat: number; lon: number }, screen?: { x: number; y: number }) => void;
  onTiles?: (pending: number) => void;
  onStatus?: (status: { terrain: 'loading' | 'ready' | 'off' | 'error'; imageryErrors: number }) => void;
}

export interface GlobeOptions extends GlobeEvents {
  styleId?: string;
  terrain?: boolean;
  exaggeration?: number;
  creditContainer?: HTMLElement;
}

const MARS = Ellipsoid.MARS;

function pinImage(color: string, ring: string, size = 44): string {
  const s = size;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s * 1.25}" viewBox="0 0 40 50">
    <defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity=".5"/></filter></defs>
    <path filter="url(#f)" d="M20 47 C20 47 5 30 5 19 a15 15 0 1 1 30 0 C35 30 20 47 20 47z" fill="${color}" stroke="${ring}" stroke-width="2.5"/>
    <circle cx="20" cy="19" r="5.5" fill="${ring}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export class MarsGlobe {
  readonly viewer: Viewer;
  private events: GlobeEvents;
  private layers: ImageryLayer[] = [];
  private styleId: string;
  private terrainOn: boolean;
  private handler: ScreenSpaceEventHandler;
  private imageryErrors = 0;
  private terrainState: 'loading' | 'ready' | 'off' | 'error' = 'off';
  private placeEntities = new Map<string, Entity>();
  private lastCursor = 0;
  private destroyed = false;
  private terrain: MarsTerrain | null = null;
  private colors = new ColorBaseCache(COLOR_BASE);
  private light: DirectionalLight;
  private cameraQueued = false;

  constructor(container: HTMLElement, opts: GlobeOptions = {}) {
    this.events = opts;
    this.styleId = opts.styleId ?? IMAGERY[0].id;
    this.terrainOn = opts.terrain ?? true;

    Ion.defaultAccessToken = ''; // never reach Cesium ion
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
      msaaSamples: (window.devicePixelRatio || 1) >= 2 ? 1 : 4,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      useBrowserRecommendedResolution: false,
    });
    const v = this.viewer;
    const scene = v.scene;
    const globe = scene.globe;
    const dpr = window.devicePixelRatio || 1;
    v.resolutionScale = Math.min(dpr, 2);
    scene.postProcessStages.fxaa.enabled = dpr < 2;
    scene.backgroundColor = Color.BLACK;
    globe.baseColor = Color.fromCssColorString('#6b3a22');
    globe.maximumScreenSpaceError = 2;
    globe.tileCacheSize = 400;
    globe.depthTestAgainstTerrain = true;
    scene.fog.enabled = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.sun) scene.sun.show = false; // the light follows the camera (below), not Earth's sun

    // Studio sunlight: from above-left of the viewer, so the disc shows a soft
    // terminator on the far limb in orbit. Lighting fades out below ~2,000 km,
    // where the imagery's own shadows take over (as in the real photographs).
    this.light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 2.2 });
    scene.light = this.light;
    globe.enableLighting = true;
    globe.dynamicAtmosphereLighting = true;
    globe.dynamicAtmosphereLightingFromSun = false;
    globe.lightingFadeOutDistance = 2.0e6;
    globe.lightingFadeInDistance = 6.0e6;
    // No ground haze: on the Earth-tuned model it greys the whole disc; Mars'
    // thin atmosphere shows from orbit only as a faint limb (below).
    globe.showGroundAtmosphere = false;
    // A pale limb glow against space. Cesium only builds its sky (stars,
    // atmosphere) for the Earth ellipsoid, so both are created here for Mars.
    scene.skyBox = SkyBox.createEarthSkyBox(); // Tycho-2 star catalogue; nothing Earth-specific
    const sky = new SkyAtmosphere(MARS);
    sky.perFragmentAtmosphere = true;
    sky.atmosphereLightIntensity = 14;
    sky.atmosphereRayleighCoefficient = new Cartesian3(16e-6, 10e-6, 6.5e-6); // dust reddens, not blues
    sky.atmosphereMieCoefficient = new Cartesian3(6e-6, 6e-6, 6e-6);
    sky.atmosphereRayleighScaleHeight = 11000; // Mars' scale height is ~11 km
    sky.atmosphereMieScaleHeight = 6000;
    sky.atmosphereMieAnisotropy = 0.8;
    sky.saturationShift = -0.15;
    scene.skyAtmosphere = sky;
    if (/dev/.test(location.hash)) (window as unknown as Record<string, unknown>).__cesium = { Cartesian3, Color, scene, sky };
    scene.preRender.addEventListener(() => this.aimLight());
    scene.screenSpaceCameraController.minimumZoomDistance = 250;
    scene.screenSpaceCameraController.maximumZoomDistance = 40_000_000;
    v.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    this.applyStyle(this.styleId);
    this.setTerrain(this.terrainOn);
    this.setExaggeration(opts.exaggeration ?? 1.5);
    this.addPlaces();

    // initial framing: the hemisphere around the assignment
    const home = PLACES.find((p) => p.assignment)!;
    v.camera.setView({ destination: Cartesian3.fromDegrees(home.lon, home.lat - 6, 11_000_000, MARS) });

    this.handler = new ScreenSpaceEventHandler(scene.canvas);
    this.handler.setInputAction((e: { position: Cartesian2 }) => this.onClick(e.position), ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((e: { endPosition: Cartesian2 }) => this.onMove(e.endPosition), ScreenSpaceEventType.MOUSE_MOVE);

    v.camera.percentageChanged = 0.002;
    v.camera.changed.addEventListener(() => this.queueCamera());
    v.camera.moveEnd.addEventListener(() => this.queueCamera());
    scene.globe.tileLoadProgressEvent.addEventListener((n: number) => this.events.onTiles?.(n));
    this.emitCamera();
  }

  // ------------------------------------------------------------------ data

  get style(): ImageryStyle {
    return IMAGERY.find((s) => s.id === this.styleId) ?? IMAGERY[0];
  }

  applyStyle(id: string): void {
    const style = IMAGERY.find((s) => s.id === id) ?? IMAGERY[0];
    this.styleId = style.id;
    const coll = this.viewer.imageryLayers;
    for (const l of this.layers) coll.remove(l, true);
    this.layers = style.stack.map((src) => {
      const layer = new ImageryLayer(this.provider(src), {
        alpha: src.alpha ?? 1,
        minimumTerrainLevel: src.minViewLevel,
        colorToAlpha: src.blackIsNoData ? Color.BLACK : undefined,
        colorToAlphaThreshold: 0.01,
        ...src.tone,
      });
      coll.add(layer);
      return layer;
    });
    this.viewer.scene.requestRender();
  }

  private provider(src: TileSource): UrlTemplateImageryProvider {
    const options = {
      url: src.url,
      tilingScheme: new GeographicTilingScheme({ ellipsoid: MARS }),
      tileWidth: src.tileSize,
      tileHeight: src.tileSize,
      maximumLevel: src.maxLevel,
      rectangle: src.bbox ? Rectangle.fromDegrees(src.bbox.west, src.bbox.south, src.bbox.east, src.bbox.north) : undefined,
      credit: new Credit(src.credit),
    };
    const p = src.colorize ? new ColorizedImageryProvider(options, this.colors) : new UrlTemplateImageryProvider(options);
    p.errorEvent.addEventListener((err: { retry?: boolean; timesRetried?: number }) => {
      // local mosaics legitimately 404 at their edges; count real failures only
      if ((err.timesRetried ?? 0) === 0) {
        this.imageryErrors++;
        this.emitStatus();
      }
      err.retry = false;
    });
    return p;
  }

  async setTerrain(on: boolean): Promise<void> {
    this.terrainOn = on;
    const scene = this.viewer.scene;
    const previous = this.terrain;
    if (!on) {
      scene.terrainProvider = new EllipsoidTerrainProvider({ ellipsoid: MARS });
      this.terrain = null;
      previous?.dispose();
      this.terrainState = 'off';
      this.emitStatus();
      return;
    }
    if (previous) return;
    this.terrainState = 'loading';
    this.emitStatus();
    try {
      const terrain = await createMarsTerrain(MARS);
      if (this.destroyed || !this.terrainOn) {
        terrain.dispose();
        return;
      }
      this.terrain = terrain;
      scene.terrainProvider = terrain.provider;
      this.terrainState = 'ready';
    } catch (e) {
      console.warn('[globe] terrain unavailable', e);
      this.terrainState = 'error';
    }
    this.emitStatus();
    scene.requestRender();
  }

  setExaggeration(x: number): void {
    this.viewer.scene.verticalExaggeration = x;
    this.viewer.scene.requestRender();
  }

  private addPlaces() {
    for (const p of PLACES) {
      const show = p.showBelowM ? new DistanceDisplayCondition(0, p.showBelowM) : undefined;
      const e = this.viewer.entities.add({
        id: `place:${p.id}`,
        position: Cartesian3.fromDegrees(p.lon, p.lat, 0, MARS),
        billboard: {
          image: p.assignment ? pinImage('#e8794a', '#fff3ea', 46) : pinImage('rgba(18,20,24,0.92)', '#f4efe9', 34),
          verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, // never clipped by relief; far side hidden by updatePins()
          scaleByDistance: new NearFarScalar(2e4, 1.1, 1.2e7, 0.7),
          distanceDisplayCondition: show,
        },
        label: {
          text: p.name,
          font: '600 13px Inter, ui-sans-serif, system-ui, sans-serif',
          fillColor: Color.fromCssColorString('#f4efe9'),
          outlineColor: Color.fromCssColorString('#0c0e11'),
          outlineWidth: 4,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.TOP,
          pixelOffset: new Cartesian2(0, 8),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, // never clipped by relief; far side hidden by updatePins()
          translucencyByDistance: new NearFarScalar(1.5e6, 1, p.assignment ? 3e7 : 9e6, p.assignment ? 1 : 0),
          distanceDisplayCondition: show,
        },
      });
      this.placeEntities.set(p.id, e);
    }
  }

  // ------------------------------------------------------------------ camera

  /** Fly to a place's predefined framing. */
  flyToPlace(id: string, durationS?: number): void {
    const p = PLACES.find((x) => x.id === id);
    if (!p) return;
    this.events.onFlyStart?.({ lat: p.lat, lon: p.lon });
    this.flyAround(p.lat, p.lon, p.range, p.pitchDeg, durationS ?? 1.8, this.viewer.camera.heading);
  }

  private flyAround(lat: number, lon: number, range: number, pitchDeg: number, duration: number, heading: number, height?: number) {
    const h = height ?? this.terrainHeight(lat, lon) ?? 0;
    const target = Cartesian3.fromDegrees(lon, lat, h * this.viewer.scene.verticalExaggeration, MARS);
    this.viewer.camera.flyToBoundingSphere(new BoundingSphere(target, 0), {
      offset: new HeadingPitchRange(heading, CMath.toRadians(pitchDeg), range),
      duration,
      easingFunction: EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  home(): void {
    const p = PLACES.find((x) => x.assignment)!;
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(p.lon, p.lat - 6, 11_000_000, MARS),
      orientation: { heading: 0, pitch: CMath.toRadians(-90), roll: 0 },
      duration: 1.4,
      easingFunction: EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  resetNorth(): void {
    const c = this.viewer.camera;
    const center = this.centerPick();
    if (!center) {
      c.flyTo({ destination: c.position, orientation: { heading: 0, pitch: c.pitch, roll: 0 }, duration: 0.6 });
      return;
    }
    const range = Cartesian3.distance(c.position, center);
    c.flyToBoundingSphere(new BoundingSphere(center, 0), { offset: new HeadingPitchRange(0, c.pitch, range), duration: 0.6 });
  }

  zoom(direction: 1 | -1): void {
    const c = this.viewer.camera;
    const center = this.centerPick();
    const dist = center ? Cartesian3.distance(c.position, center) : c.positionCartographic.height;
    if (direction > 0) c.zoomIn(dist * 0.45);
    else c.zoomOut(dist * 0.8);
    this.viewer.scene.requestRender();
  }

  private centerPick(): Cartesian3 | undefined {
    const canvas = this.viewer.scene.canvas;
    return this.pickGround(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
  }

  // ------------------------------------------------------------------ input

  private pickGround(pos: Cartesian2): Cartesian3 | undefined {
    const scene = this.viewer.scene;
    const ray = this.viewer.camera.getPickRay(pos);
    const hit = ray ? scene.globe.pick(ray, scene) : undefined;
    return hit ?? this.viewer.camera.pickEllipsoid(pos, MARS);
  }

  private onClick(pos: Cartesian2) {
    const picked = this.viewer.scene.pick(pos) as { id?: Entity } | undefined;
    const id = picked?.id?.id;
    if (typeof id === 'string' && id.startsWith('place:')) {
      const place = PLACES.find((p) => `place:${p.id}` === id)!;
      this.flyToPlace(place.id);
      this.events.onPlace?.(place);
      return;
    }
    const hit = this.pickGround(pos);
    if (!hit) return;
    const carto = Cartographic.fromCartesian(hit, MARS);
    const lat = CMath.toDegrees(carto.latitude);
    const lon = CMath.toDegrees(carto.longitude);
    const cam = this.viewer.camera;
    const plan = planFlight(Cartesian3.distance(cam.position, hit));
    this.events.onFlyStart?.({ lat, lon }, { x: pos.x, y: pos.y });
    this.flyAround(lat, lon, plan.range, plan.pitchDeg, plan.duration, cam.heading, carto.height / this.viewer.scene.verticalExaggeration);
  }

  private onMove(pos: Cartesian2) {
    const now = performance.now();
    if (now - this.lastCursor < 40) return;
    this.lastCursor = now;
    const hit = this.pickGround(pos);
    if (!hit) {
      this.events.onCursor?.(null);
      return;
    }
    const c = Cartographic.fromCartesian(hit, MARS);
    const ex = this.viewer.scene.verticalExaggeration || 1;
    const lat = CMath.toDegrees(c.latitude);
    const lon = CMath.toDegrees(c.longitude);
    const t = this.terrainState === 'ready' ? this.terrain : null;
    this.events.onCursor?.({ lat, lon, heightM: t ? c.height / ex : null, relief: t ? t.sourceAt(lon, lat) : null });
  }

  private terrainHeight(lat: number, lon: number): number | undefined {
    const h = this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat));
    return h === undefined ? undefined : h / (this.viewer.scene.verticalExaggeration || 1);
  }

  /** Hide pins on the far side of the planet (depth testing is off so relief never clips them). */
  private updatePins() {
    const occluder = new EllipsoidalOccluder(MARS, this.viewer.camera.positionWC);
    const now = this.viewer.clock.currentTime;
    for (const e of this.placeEntities.values()) {
      const p = e.position?.getValue(now);
      if (!p) continue;
      const visible = occluder.isPointVisible(p);
      if (e.show !== visible) e.show = visible;
    }
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

  /** Camera read-outs at most once per animation frame (they pick the globe). */
  private queueCamera() {
    if (this.cameraQueued) return;
    this.cameraQueued = true;
    requestAnimationFrame(() => {
      this.cameraQueued = false;
      if (!this.destroyed) this.emitCamera();
    });
  }

  /** Stop rendering while hidden (e.g. behind the site plan); resume when shown. */
  setActive(active: boolean): void {
    if (this.destroyed) return;
    this.viewer.useDefaultRenderLoop = active;
    if (active) this.viewer.scene.requestRender();
  }

  private emitCamera() {
    this.updatePins();
    const c = this.viewer.camera;
    const carto = c.positionCartographic;
    const ground = this.viewer.scene.globe.getHeight(carto);
    this.events.onCamera?.({
      altitudeM: ground === undefined ? carto.height : carto.height - ground,
      aboveGround: ground !== undefined,
      headingDeg: CMath.toDegrees(c.heading),
      pitchDeg: CMath.toDegrees(c.pitch),
      lat: CMath.toDegrees(carto.latitude),
      lon: CMath.toDegrees(carto.longitude),
    });
  }

  private emitStatus() {
    this.events.onStatus?.({ terrain: this.terrainState, imageryErrors: this.imageryErrors });
  }

  /** Ground metres per CSS pixel near the bottom-centre of the view (for the scale bar). */
  metresPerPixel(): number | null {
    const canvas = this.viewer.scene.canvas;
    const y = canvas.clientHeight * 0.78;
    const x = canvas.clientWidth / 2;
    const a = this.pickGround(new Cartesian2(x - 50, y));
    const b = this.pickGround(new Cartesian2(x + 50, y));
    if (!a || !b) return null;
    return Cartesian3.distance(a, b) / 100;
  }

  get terrainStatus() {
    return this.terrainState;
  }

  destroy(): void {
    this.destroyed = true;
    this.handler.destroy();
    this.terrain?.dispose();
    this.viewer.destroy();
  }
}
