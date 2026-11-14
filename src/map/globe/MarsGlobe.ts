import './cesiumBase';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Credit,
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
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { IMAGERY, PLACES, type ImageryStyle, type Place, type TileSource } from './catalog';
import { planFlight } from './flight';
import { createMarsTerrain } from './elevation';

// ---------------------------------------------------------------------------
// 3D Mars globe (CesiumJS) with real orbital imagery and MOLA/HRSC relief.
// Click anywhere: the camera flies there quickly. Click a place pin: flies to
// that place's framing. No Cesium ion services are used.
// ---------------------------------------------------------------------------

export interface CursorInfo {
  lat: number;
  lon: number;
  heightM: number | null;
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
      msaaSamples: 4,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      useBrowserRecommendedResolution: false,
    });
    const v = this.viewer;
    const scene = v.scene;
    v.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);
    scene.backgroundColor = Color.BLACK;
    scene.globe.baseColor = Color.fromCssColorString('#5a2f1d');
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.maximumScreenSpaceError = 1.5;
    scene.globe.tileCacheSize = 1200; // oblique views keep many tiles alive; avoid evict-and-refetch
    scene.globe.depthTestAgainstTerrain = true;
    scene.fog.enabled = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.skyAtmosphere) {
      // thin, dusty Martian limb instead of Earth's blue
      scene.skyAtmosphere.show = true;
      scene.skyAtmosphere.hueShift = -0.47;
      scene.skyAtmosphere.saturationShift = -0.35;
      scene.skyAtmosphere.brightnessShift = -0.25;
    }
    scene.postProcessStages.fxaa.enabled = true;
    scene.screenSpaceCameraController.minimumZoomDistance = 600;
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
    v.camera.changed.addEventListener(() => this.emitCamera());
    v.camera.moveEnd.addEventListener(() => this.emitCamera());
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
      });
      coll.add(layer);
      return layer;
    });
    this.viewer.scene.requestRender();
  }

  private provider(src: TileSource): UrlTemplateImageryProvider {
    const p = new UrlTemplateImageryProvider({
      url: src.url,
      tilingScheme: new GeographicTilingScheme({ ellipsoid: MARS }),
      tileWidth: src.tileSize,
      tileHeight: src.tileSize,
      maximumLevel: src.maxLevel,
      rectangle: src.bbox ? Rectangle.fromDegrees(src.bbox.west, src.bbox.south, src.bbox.east, src.bbox.north) : undefined,
      credit: new Credit(src.credit),
    });
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
    if (!on) {
      scene.terrainProvider = new EllipsoidTerrainProvider({ ellipsoid: MARS });
      this.terrainState = 'off';
      this.emitStatus();
      return;
    }
    this.terrainState = 'loading';
    this.emitStatus();
    try {
      const provider = await createMarsTerrain(MARS);
      if (this.destroyed || !this.terrainOn) return;
      scene.terrainProvider = provider;
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
    const terrain = this.terrainState === 'ready';
    this.events.onCursor?.({ lat: CMath.toDegrees(c.latitude), lon: CMath.toDegrees(c.longitude), heightM: terrain ? c.height / ex : null });
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
    this.viewer.destroy();
  }
}
