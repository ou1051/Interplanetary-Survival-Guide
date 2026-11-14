// ---------------------------------------------------------------------------
// 3D map for the habitat console: the team's Mars globe (src/map/globe —
// CesiumJS with NASA orbital imagery and Mars elevation) framed as a tilted
// view over the mission site, drawn with the routes, stations and the base.
// Drag to orbit (full 360°); the view slowly turns on its own until touched.
//
// Mission coordinates are local metres (x east, z south). They are placed on
// the real surface around Vera Rubin Ridge, the assignment area on the globe.
// ---------------------------------------------------------------------------

const ANCHOR = { lat: -4.714, lon: 137.357 };
const MARS_R = 3396190;
const DEG = 180 / Math.PI;
const LIFT = 8; // metres above ground for lines and markers, so they sit together

export async function mountConsoleMap3D(container, { onReady } = {}) {
  const [{ MarsGlobe }, C] = await Promise.all([import('../map/globe/MarsGlobe.ts'), import('cesium')]);
  const credits = document.createElement('div');
  credits.className = 'hab-map3d-credit';
  container.appendChild(credits);
  const globe = new MarsGlobe(container, { creditContainer: credits, exaggeration: 1.6 });
  const viewer = globe.viewer;
  const scene = viewer.scene;
  // Console-sized view: the globe defaults are tuned for full-screen exploring. Here a coarser detail
  // target means far fewer NASA tiles to stream, and the sky is never in frame, so skip drawing it.
  scene.globe.maximumScreenSpaceError = 6;
  scene.globe.preloadSiblings = false;
  scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  // Render at CSS pixels (not 2-3x retina pixels), no multisampling, 30 fps: a console-sized map
  // looks the same, and the GPU does a fraction of the work while the view turns.
  viewer.useBrowserRecommendedResolution = true;
  viewer.resolutionScale = 1;
  scene.msaaSamples = 1;
  scene.postProcessStages.fxaa.enabled = true;
  viewer.targetFrameRate = 30;
  // The globe's "Natural colour" style stacks five NASA layers. At Gale only three show: the painted
  // base (fills in while loading), the Gale CTX mosaic and the Curiosity HiRISE mosaic. Hidden layers
  // are never downloaded.
  const keep = /painted|Gale_CTX|curiosity_hirise/;
  const layers = Array.from({ length: viewer.imageryLayers.length }, (_, i) => viewer.imageryLayers.get(i));
  if (layers.some((l) => keep.test(String(l.imageryProvider?.url)))) {
    for (const l of layers) l.show = keep.test(String(l.imageryProvider?.url));
  }
  globe.handler?.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK); // no fly-to-click inside the console
  // the globe's own place pins (Vera Rubin Ridge etc.) would cover the site
  for (const e of [...viewer.entities.values]) if (String(e.id).startsWith('place:')) viewer.entities.remove(e);

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
    ANCHOR.lon + ((x - origin.x) / (MARS_R * Math.cos(ANCHOR.lat / DEG))) * DEG,
    ANCHOR.lat - ((z - origin.z) / MARS_R) * DEG,
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
    const all = plan.lines.flatMap((l) => l.points).concat(plan.markers.map((m) => m.at));
    const xs = all.map((p) => p[0]);
    const zs = all.map((p) => p[1]);
    const newOrigin = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 120);
    const reframe = !center || Math.abs(newOrigin.x - origin.x) > 1 || Math.abs(newOrigin.z - origin.z) > 1 || Math.abs(range - extent * 1.9) > 1;
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
    setActive(on) { globe.setActive(on); },
    destroy() { clearTimeout(reseat); clearTimeout(readyFallback); lastPlan = null; globe.destroy(); },
  };
}
