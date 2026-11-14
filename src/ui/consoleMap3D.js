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

export async function mountConsoleMap3D(container) {
  const [{ MarsGlobe }, C] = await Promise.all([import('../map/globe/MarsGlobe.ts'), import('cesium')]);
  const credits = document.createElement('div');
  credits.className = 'hab-map3d-credit';
  container.appendChild(credits);
  const globe = new MarsGlobe(container, { creditContainer: credits, exaggeration: 1.6 });
  const viewer = globe.viewer;
  const scene = viewer.scene;
  globe.handler?.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK); // no fly-to-click inside the console
  // the globe's own place pins (Vera Rubin Ridge etc.) would cover the site
  for (const e of [...viewer.entities.values]) if (String(e.id).startsWith('place:')) viewer.entities.remove(e);

  let entities = [];
  let previous = []; // last draw's entities, excluded from height sampling until removed
  let lastPlan = null;
  let spinning = true;
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
  // height of the ground as it is actually drawn right now (finest loaded tiles), ignoring our own lines
  const drawnHeight = (lon, lat) => {
    const carto = C.Cartographic.fromDegrees(lon, lat);
    const h = scene.sampleHeightSupported ? scene.sampleHeight(carto, previous) : undefined;
    return h ?? scene.globe.getHeight(carto);
  };

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
    if (spinning && now > pausedUntil && center) {
      heading = (heading + dt * 0.12) % (Math.PI * 2);
      frameCamera();
    }
  });
  viewer.clock.onTick.addEventListener(() => spinning && scene.requestRender());

  function lineFrom(points, color, width, dashed) {
    // getHeight is cheap but reads a coarser terrain level than what is drawn; sampleHeight reads the
    // drawn ground but costs a small render per call. Use getHeight for the shape at every point and
    // correct it with ~40 drawn-ground samples, interpolated along the line.
    const lonlat = points.map(([x, z]) => toLonLat(x, z));
    const coarse = lonlat.map(([lon, lat]) => groundHeight(lon, lat));
    const step = Math.max(1, Math.ceil(points.length / 40));
    const keys = [];
    for (let i = 0; i < points.length; i += step) keys.push(i);
    if (keys.at(-1) !== points.length - 1) keys.push(points.length - 1);
    const fix = keys.map((i) => {
      const drawn = drawnHeight(...lonlat[i]);
      return drawn !== undefined && coarse[i] !== undefined ? Math.max(0, drawn - coarse[i]) : 0;
    });
    const heights = coarse.map((h, j) => {
      const k = Math.min(keys.length - 2, Math.max(0, Math.floor(j / step)));
      const i0 = keys[k]; const i1 = keys[k + 1] ?? i0;
      const t = i1 === i0 ? 0 : (j - i0) / (i1 - i0);
      return h === undefined ? undefined : h + fix[k] + ((fix[k + 1] ?? fix[k]) - fix[k]) * t;
    });
    // a little above the ground so finer terrain tiles loading in later don't swallow the line
    const positions = lonlat.map(([lon, lat], i) => C.Cartesian3.fromDegrees(lon, lat, (heights[i] ?? -6900) + LIFT, C.Ellipsoid.MARS));
    const col = C.Color.fromCssColorString(color);
    entities.push(viewer.entities.add({
      polyline: {
        // dynamic, so a re-seated line shows on the next frame instead of being rebuilt in a worker
        positions: new C.CallbackProperty(() => positions, true),
        arcType: C.ArcType.NONE,
        width,
        material: dashed
          ? new C.PolylineDashMaterialProperty({ color: col, dashLength: 12 })
          : new C.PolylineGlowMaterialProperty({ glowPower: 0.18, color: col }),
        depthFailMaterial: col.withAlpha(0.45),
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
    previous = entities;
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
    if (reframe) frameCamera(); // move first, so the ground under the route is in view for sampling
    for (const l of plan.lines) lineFrom(l.points, l.color, l.width ?? 4, l.dashed);
    for (const m of plan.markers) marker(m.at, m.text, m.color);
    for (const e of previous) viewer.entities.remove(e);
    previous = [];
    scene.requestRender();
  }
  let reseat;
  // re-seat the lines each time a batch of (sharper) ground tiles finishes loading
  scene.globe.tileLoadProgressEvent.addEventListener((n) => {
    if (n !== 0 || !lastPlan) return;
    clearTimeout(reseat);
    reseat = setTimeout(() => lastPlan && draw(lastPlan), 700); // tiles stream in while turning; settle first
  });

  return {
    draw,
    setSpin(on) { spinning = on; pausedUntil = 0; scene.requestRender(); },
    get spinning() { return spinning; },
    setActive(on) { globe.setActive(on); },
    destroy() { clearTimeout(reseat); lastPlan = null; globe.destroy(); },
  };
}
