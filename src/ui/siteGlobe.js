import { SCOUT_PINS, AREA_HAZARDS, HAB } from '../config/mission.js';

// ---------------------------------------------------------------------------
// The team's 3D Mars globe (src/map/globe, CesiumJS + NASA orbital imagery and
// Mars elevation) inside the mission map, with this mission drawn on the real
// surface: habitat, science stations, scouting sites, known hazards and routes.
//
// The site is anchored at Vera Rubin Ridge, the assignment area on the globe.
// Local metres (x = east, z = −north, as in the 3D rehearsal) are converted to
// latitude/longitude around that anchor.
// ---------------------------------------------------------------------------

const ANCHOR = { lat: -4.714, lon: 137.357, x: 100, z: -350 }; // site centre ↔ Vera Rubin Ridge
const MARS_R = 3396190;
const DEG = 180 / Math.PI;

export function toLonLat(x, z) {
  const lat = ANCHOR.lat + ((-(z - ANCHOR.z)) / MARS_R) * DEG;
  const lon = ANCHOR.lon + ((x - ANCHOR.x) / (MARS_R * Math.cos(ANCHOR.lat / DEG))) * DEG;
  return [lon, lat];
}

export async function createSiteGlobe(container, { onPin } = {}) {
  const [{ MarsGlobe }, { IMAGERY }, C] = await Promise.all([
    import('../map/globe/MarsGlobe.ts'),
    import('../map/globe/catalog.ts'),
    import('cesium'),
  ]);
  const credits = document.createElement('div');
  credits.className = 'globe-credits';
  container.parentElement.appendChild(credits);
  const globe = new MarsGlobe(container, { creditContainer: credits });
  return new SiteGlobe(globe, C, IMAGERY, onPin);
}

class SiteGlobe {
  constructor(globe, C, imagery, onPin) {
    this.globe = globe;
    this.C = C;
    this.imagery = imagery;
    this.viewer = globe.viewer;
    this.entities = [];
    this.lineCache = new WeakMap();
    this.heightCache = new Map();
    // redraw lines on the real surface once the terrain under the site has loaded
    this.viewer.scene.globe.tileLoadProgressEvent.addEventListener((n) => {
      if (n === 0 && this.waitingForTiles && this.lastArgs) this.update(this.lastArgs);
    });
    const handler = new C.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((e) => {
      const picked = this.viewer.scene.pick(e.position);
      const id = picked && picked.id && picked.id.id;
      if (typeof id === 'string' && id.startsWith('scout:')) onPin?.(id.slice(6));
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  }

  get styles() {
    return this.imagery;
  }

  setStyle(id) {
    this.globe.applyStyle(id);
  }

  get styleId() {
    return this.globe.style.id;
  }

  /** Fly from orbit down to the mission site, framed on the real ground height. */
  async flyToSite(duration = 3.2) {
    const C = this.C;
    const [lon, lat] = toLonLat(ANCHOR.x, ANCHOR.z);
    let h = -4300; // approximate floor of Gale Crater near Vera Rubin Ridge, metres
    try {
      const [c] = await C.sampleTerrainMostDetailed(this.viewer.terrainProvider, [C.Cartographic.fromDegrees(lon, lat)]);
      if (Number.isFinite(c.height)) h = c.height;
    } catch {
      /* keep the estimate */
    }
    const ex = this.viewer.scene.verticalExaggeration || 1;
    const center = C.Cartesian3.fromDegrees(lon, lat, h * ex, C.Ellipsoid.MARS);
    this.viewer.camera.flyToBoundingSphere(new C.BoundingSphere(center, 0), {
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-62), 1500),
      duration,
      easingFunction: C.EasingFunction.QUADRATIC_IN_OUT,
    });
  }

  /** Gale Crater framing (the team's 'gale' place), where the 200 m/px global maps read well. */
  flyToGale() {
    this.globe.flyToPlace('gale', 2.2);
  }

  home() {
    this.globe.home();
  }

  // Ground heights (already including the globe's vertical exaggeration), read from the
  // loaded terrain tiles. Cesium's clamp-to-ground lines assume Earth, so lines and areas are
  // drawn just above these heights. Until the tiles under the site are loaded, an estimate is
  // used and the drawing is refreshed once loading settles.
  _heights(key, xz) {
    if (this.heightCache.has(key)) return { hs: this.heightCache.get(key), ok: true };
    const C = this.C;
    const ex = this.viewer.scene.verticalExaggeration || 1;
    let ok = true;
    const hs = xz.map(([x, z]) => {
      const h = this.viewer.scene.globe.getHeight(C.Cartographic.fromDegrees(...toLonLat(x, z)));
      if (h === undefined) {
        ok = false;
        return -4300 * ex;
      }
      return h;
    });
    if (ok) this.heightCache.set(key, hs);
    return { hs, ok };
  }

  _routeLine(r) {
    if (this.lineCache.has(r)) return { line: this.lineCache.get(r), ok: true };
    const C = this.C;
    const xz = [];
    for (let i = 0; i < r.count; i += 3) xz.push([r.x[i], r.z[i]]);
    xz.push([r.x[r.count - 1], r.z[r.count - 1]]);
    const { hs, ok } = this._heights(JSON.stringify(r.option.points), xz);
    const line = xz.map(([x, z], i) => C.Cartesian3.fromDegrees(...toLonLat(x, z), hs[i] + 6, C.Ellipsoid.MARS));
    if (ok) this.lineCache.set(r, line);
    return { line, ok };
  }

  update(args) {
    const { routes, selectedId, revealed, selectedPin, knownHazardIds } = args;
    const C = this.C;
    this.lastArgs = args;
    const lines = {};
    let ready = true;
    for (const [id, r] of Object.entries(routes)) {
      const { line, ok } = this._routeLine(r);
      lines[id] = line;
      ready = ready && ok;
    }
    const areaKeys = [...SCOUT_PINS.map((p) => p.at), ...AREA_HAZARDS.map((h) => [h.cx, h.cz])];
    const area = this._heights('areas', areaKeys);
    const areaH = area.hs;
    this.waitingForTiles = !(ready && area.ok);
    const ents = this.viewer.entities;
    for (const e of this.entities) ents.remove(e);
    this.entities = [];
    const add = (o) => this.entities.push(ents.add(o));
    const pos = (x, z) => C.Cartesian3.fromDegrees(...toLonLat(x, z), 0, C.Ellipsoid.MARS);
    const near = new C.DistanceDisplayCondition(0, 60000);
    const label = (text, color, offsetY = -18) => ({
      text,
      font: '600 12px "SF Mono", ui-monospace, Menlo, monospace',
      fillColor: C.Color.fromCssColorString(color),
      outlineColor: C.Color.fromCssColorString('#05090b'),
      outlineWidth: 4,
      style: C.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new C.Cartesian2(0, offsetY),
      heightReference: C.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: near,
    });
    const point = (color, size, outline = '#05090b') => ({
      pixelSize: size,
      color: C.Color.fromCssColorString(color),
      outlineColor: C.Color.fromCssColorString(outline),
      outlineWidth: 2,
      heightReference: C.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      distanceDisplayCondition: near,
    });

    // scouted ground and known hazards
    SCOUT_PINS.forEach((p, k) => {
      if (!revealed.includes(p.id)) return;
      add({
        position: pos(...p.at),
        ellipse: {
          semiMajorAxis: p.radius,
          semiMinorAxis: p.radius,
          height: areaH[k] + 2,
          material: C.Color.fromCssColorString('#ffc23d').withAlpha(0.14),
          outline: true,
          outlineColor: C.Color.fromCssColorString('#ffc23d').withAlpha(0.7),
        },
      });
    });
    AREA_HAZARDS.forEach((hz, k) => {
      if (!knownHazardIds.has(hz.id)) return;
      add({
        position: pos(hz.cx, hz.cz),
        ellipse: {
          semiMajorAxis: hz.radius,
          semiMinorAxis: hz.radius,
          height: areaH[SCOUT_PINS.length + k] + 3,
          material: C.Color.fromCssColorString('#ff5a45').withAlpha(0.3),
          outline: true,
          outlineColor: C.Color.fromCssColorString('#ff5a45'),
        },
      });
    });

    // routes: selected glows cyan, others dashed
    for (const id of Object.keys(routes)) {
      const sel = id === selectedId;
      add({
        polyline: {
          positions: lines[id],
          arcType: C.ArcType.NONE,
          width: sel ? 8 : 3,
          depthFailMaterial: C.Color.fromCssColorString(sel ? '#5ce4ff' : '#d6fbff').withAlpha(0.35),
          material: sel
            ? new C.PolylineGlowMaterialProperty({ glowPower: 0.25, color: C.Color.fromCssColorString('#5ce4ff') })
            : new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString('#d6fbff').withAlpha(0.7), dashLength: 14 }),
        },
      });
    }

    // stations + habitat (from the selected route, so they sit on its line)
    const r = routes[selectedId];
    for (const st of r ? r.stations : []) {
      add({
        position: pos(st.x, st.z),
        point: point(st.final ? '#ffffff' : '#56e0ff', st.final ? 12 : 11),
        label: label(st.final ? 'HAB' : `${st.id} ${st.name}`, '#e8f6fa'),
      });
    }
    if (!r) add({ position: pos(HAB.x, HAB.z), point: point('#ffffff', 12), label: label('HAB', '#e8f6fa') });

    // scouting sites (clickable)
    for (const p of SCOUT_PINS) {
      const done = revealed.includes(p.id);
      const sel = selectedPin === p.id;
      add({
        id: `scout:${p.id}`,
        position: pos(...p.at),
        point: point(done ? '#ffc23d' : '#05090b', sel ? 18 : 15, done ? '#1a1205' : '#ffffff'),
        label: label(`${p.id} ${p.name}${done ? '' : ' ?'}`, done ? '#ffc23d' : '#ffffff', -22),
      });
    }
    this.viewer.scene.requestRender();
  }
}
