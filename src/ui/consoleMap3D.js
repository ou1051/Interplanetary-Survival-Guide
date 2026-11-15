// ---------------------------------------------------------------------------
// 3D map for the habitat console: the team's Mars globe (src/map/globe —
// CesiumJS with NASA orbital imagery and Mars elevation) framed as a tilted
// view over the mission site, drawn with the routes, stations and the base.
// Drag to orbit (full 360°); the view slowly turns on its own until touched.
//
// Mission coordinates are local metres (x east, z south). They are placed on
// the real surface around Vera Rubin Ridge, the assignment area on the globe.
// ---------------------------------------------------------------------------

let anchor = { lat: -4.714, lon: 137.357 };
const MARS_R = 3396190;
const DEG = 180 / Math.PI;
const LIFT = 8; // metres above ground for lines and markers, so they sit together

// CesiumJS decodes terrain in web workers loaded from ./cesium/Workers. The one-file build has no such
// folder, and sandboxed previews (opaque origins, blocked blob: URLs) cannot start workers at all; in
// either case the globe would stop with a render error, so the console keeps its 2D map instead.
export function map3DSupport() {
  if (import.meta.env.MODE === 'single') return { ok: false, reason: 'The one-file build has no 3D globe data' };
  if (typeof Worker === 'undefined') return { ok: false, reason: 'Web workers are not available' };
  try {
    const url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    try {
      new Worker(url).terminate();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    return { ok: false, reason: `Web workers are blocked here (${error?.name ?? 'error'})` };
  }
  return { ok: true, reason: '' };
}

export async function mountConsoleMap3D(container, { onReady, onError } = {}) {
  if (import.meta.env.MODE === 'single') throw new Error('3D Mars is not part of the one-file build');
  const support = map3DSupport();
  if (!support.ok) throw new Error(support.reason);
  const [{ MarsGlobe }, C] = await Promise.all([import('../map/globe/MarsGlobe.ts'), import('cesium')]);
  const credits = document.createElement('div');
  credits.className = 'hab-map3d-credit';
  container.appendChild(credits);
  const globe = new MarsGlobe(container, { creditContainer: credits, exaggeration: 1.6 });
  const viewer = globe.viewer;
  const scene = viewer.scene;
  // A failure while rendering (a worker that cannot start, a lost GPU context) hands the console back to
  // the 2D map instead of leaving Cesium's error panel on screen.
  viewer.showRenderLoopErrors = false;
  scene.renderError.addEventListener((_scene, error) => {
    console.warn('3D Mars map stopped; showing the 2D map instead.', error);
    onError?.(error);
  });
  // A console-sized view needs fewer NASA tiles to stream.
  scene.globe.maximumScreenSpaceError = 6;
  scene.globe.preloadSiblings = false;
  // Render at CSS pixels (not 2-3x retina pixels), no multisampling, 30 fps: a console-sized map
  // looks the same, and the GPU does a fraction of the work while the view turns.
  viewer.useBrowserRecommendedResolution = true;
  viewer.resolutionScale = 1;
  scene.msaaSamples = 1;
  scene.postProcessStages.fxaa.enabled = true;
  viewer.targetFrameRate = 30;

  let entities = [];
  let lastPlan = null;
  let spinning = true;
  let speed = 0.12; // rad/s: a slow drift in the room view, faster when the console is zoomed in
  let pausedUntil = 0;
  let heading = 0.4;
  let center = null;
  let range = 1600;
  let origin = { x: 0, z: 0 };

  const toLonLat = (x, z) => [
    anchor.lon + ((x - origin.x) / (MARS_R * Math.cos(anchor.lat / DEG))) * DEG,
    anchor.lat - ((z - origin.z) / MARS_R) * DEG,
  ];
  const groundHeight = (lon, lat) => scene.globe.getHeight(C.Cartographic.fromDegrees(lon, lat));
  function frameCamera() {
    if (!center) return;
    const [lon, lat] = center;
    const h = groundHeight(lon, lat) ?? -4300 * (scene.verticalExaggeration || 1);
    viewer.camera.lookAt(
      C.Cartesian3.fromDegrees(lon, lat, h, C.Ellipsoid.MARS),
      new C.HeadingPitchRange(heading, C.Math.toRadians(-42), range),
    );
    scene.requestRender();
  }

  // gentle 360° turn until the player drags; resume a few seconds later
  scene.canvas.addEventListener('pointerdown', () => { pausedUntil = performance.now() + 6000; });
  scene.canvas.addEventListener('wheel', () => { pausedUntil = performance.now() + 6000; }, { passive: true });
  let last = performance.now();
  scene.preRender.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (spinning && ready && now > pausedUntil && center) {
      heading = (heading + dt * speed) % (Math.PI * 2);
      frameCamera();
    }
  });
  viewer.clock.onTick.addEventListener(() => spinning && scene.requestRender());

  function lineFrom(points, color, width, dashed) {
    const lonlat = points.map(([x, z]) => toLonLat(x, z));
    const heights = lonlat.map(([lon, lat]) => groundHeight(lon, lat));
    const positions = lonlat.map(([lon, lat], i) => C.Cartesian3.fromDegrees(lon, lat, (heights[i] ?? -6900) + LIFT, C.Ellipsoid.MARS));
    const col = C.Color.fromCssColorString(color);
    entities.push(viewer.entities.add({
      polyline: {
        // dynamic, so a re-seated line shows on the next frame instead of being rebuilt in a worker
        positions: new C.CallbackProperty(() => positions, false),
        arcType: C.ArcType.NONE,
        width,
        material: dashed
          ? new C.PolylineDashMaterialProperty({ color: col, dashLength: 12 })
          : new C.PolylineGlowMaterialProperty({ glowPower: 0.18, color: col }),
        // a planning map: where the route dips behind a ridge or under sharper terrain tiles that stream in
        // later, it still draws in the same colour, so no costly per-point ground sampling is needed
        depthFailMaterial: dashed ? new C.PolylineDashMaterialProperty({ color: col, dashLength: 12 }) : col,
      },
    }));
  }

  function marker([x, z], text, color) {
    const [lon, lat] = toLonLat(x, z);
    entities.push(viewer.entities.add({
      position: C.Cartesian3.fromDegrees(lon, lat, LIFT, C.Ellipsoid.MARS),
      point: {
        pixelSize: 9, color: C.Color.fromCssColorString(color), outlineColor: C.Color.fromCssColorString('#071022'), outlineWidth: 2,
        heightReference: C.HeightReference.RELATIVE_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text, font: '700 12px "Helvetica Neue", Arial, sans-serif',
        fillColor: C.Color.WHITE, outlineColor: C.Color.fromCssColorString('#071022'), outlineWidth: 4,
        style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -16),
        heightReference: C.HeightReference.RELATIVE_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));
  }

  /**
   * plan = { lines: [{ points: [[x,z]...], color, width, dashed }], markers: [{ at: [x,z], text, color }] }
   * Coordinates in local metres; the plan's bounding box is centred on the anchor.
   */
  function draw(plan) {
    lastPlan = plan;
    const previous = entities;
    entities = [];
    const nextAnchor = plan.anchor || { lat: -4.714, lon: 137.357 };
    const anchorChanged = Math.abs(nextAnchor.lat - anchor.lat) > 0.001 || Math.abs(nextAnchor.lon - anchor.lon) > 0.001;
    anchor = { lat: nextAnchor.lat, lon: nextAnchor.lon };
    const all = plan.lines.flatMap((l) => l.points).concat(plan.markers.map((m) => m.at));
    const xs = all.map((p) => p[0]);
    const zs = all.map((p) => p[1]);
    const newOrigin = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 120);
    const reframe = !center || anchorChanged || Math.abs(newOrigin.x - origin.x) > 1 || Math.abs(newOrigin.z - origin.z) > 1 || Math.abs(range - extent * 1.9) > 1;
    origin = newOrigin;
    center = toLonLat(origin.x, origin.z);
    range = extent * 1.9;
    if (reframe) frameCamera();
    for (const l of plan.lines) lineFrom(l.points, l.color, l.width ?? 4, l.dashed);
    for (const m of plan.markers) marker(m.at, m.text, m.color);
    for (const e of previous) viewer.entities.remove(e);
    scene.requestRender();
  }
  let reseat;
  // "ready" = the ground under the site has finished its first load; until then the 2D map shows
  let ready = false;
  let sawLoading = false;
  const markReady = () => {
    if (ready) return;
    ready = true;
    clearTimeout(readyFallback);
    onReady?.();
  };
  const readyFallback = setTimeout(() => lastPlan && markReady(), 12000); // slow network: show what we have
  // re-seat the lines each time a batch of (sharper) ground tiles finishes loading
  scene.globe.tileLoadProgressEvent.addEventListener((n) => {
    if (!lastPlan) return;
    if (n > 0) { sawLoading = true; return; }
    if (sawLoading) markReady(); // the queue for the site view (not the start-up globe) has drained
    clearTimeout(reseat);
    reseat = setTimeout(() => lastPlan && draw(lastPlan), 700); // tiles stream in while turning; settle first
  });

  return {
    draw,
    setSpin(on) { spinning = on; pausedUntil = 0; scene.requestRender(); },
    setSpeed(radPerSec) { speed = radPerSec; },
    get spinning() { return spinning; },
    get ready() { return ready; },
    destroy() { clearTimeout(reseat); clearTimeout(readyFallback); lastPlan = null; globe.destroy(); },
  };
}
