import * as THREE from 'three';
import { ROUTE_POINTS, STATIONS, AREA_HAZARDS, HAB, ROVER, SLOPE_CLASSES } from '../config/mission.js';
import { clamp, DEG } from '../core/math.js';

// ---------------------------------------------------------------------------
// Route model: arc-length sampled spline + an automatic hazard analysis that
// evaluates the hand-planned traverse against the elevation data.
// ---------------------------------------------------------------------------

export class Route {
  constructor(terrain, { points = ROUTE_POINTS, stations = STATIONS, areaHazards = AREA_HAZARDS, exact = false, approach = null } = {}) {
    this.terrain = terrain;
    const pts = points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    let curve;
    if (exact) {
      curve = new THREE.CurvePath();
      for (let i = 1; i < pts.length; i++) curve.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
    } else {
      curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      curve.arcLengthDivisions = 4000;
    }
    if (approach) {
      const original = curve;
      const added = approach.curve.getLength();
      const remaining = original.getLength() - approach.joinAt;
      const length = added + remaining;
      curve = {
        getLength: () => length,
        getPoint: (t) => {
          const distance = t * length;
          return distance <= added ? approach.curve.getPointAt(distance / added)
            : original.getPointAt(clamp((approach.joinAt + distance - added) / (approach.joinAt + remaining), 0, 1));
        },
      };
    }
    this.exactPath = exact || approach ? curve : null;
    this.length = curve.getLength();
    const steps = exact ? Math.ceil(this.length / 2) * 2 : Math.ceil(this.length);
    this.step = this.length / steps;
    const spaced = this.exactPath
      ? Array.from({ length: steps + 1 }, (_, i) => curve.getPoint(i / steps))
      : curve.getSpacedPoints(steps);
    this.count = spaced.length;
    this.x = new Float32Array(this.count);
    this.z = new Float32Array(this.count);
    this.h = new Float32Array(this.count);
    this.tx = new Float32Array(this.count);
    this.tz = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.x[i] = spaced[i].x;
      this.z[i] = spaced[i].z;
      this.h[i] = terrain.heightAt(spaced[i].x, spaced[i].z);
    }
    for (let i = 0; i < this.count; i++) {
      const a = Math.max(0, i - 1);
      const b = exact && i === steps / 2 ? i : Math.min(this.count - 1, i + 1);
      let dx = this.x[b] - this.x[a];
      let dz = this.z[b] - this.z[a];
      const len = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / len;
      this.tz[i] = dz / len;
    }

    this._analyse();
    this._placeStations(stations);
    this._buildZones(areaHazards);
    this._buildStops();
  }

  // Interpolated pose on the centreline at arc length s.
  sample(s, out = {}) {
    const f = clamp(s / this.step, 0, this.count - 1);
    const i = Math.min(Math.floor(f), this.count - 2);
    const t = f - i;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * t;
    if (this.exactPath) {
      const point = this.exactPath.getPoint(clamp(s / this.length, 0, 1));
      out.x = point.x;
      out.z = point.z;
    }
    let tx = this.tx[i] + (this.tx[i + 1] - this.tx[i]) * t;
    let tz = this.tz[i] + (this.tz[i + 1] - this.tz[i]) * t;
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l;
    out.tz = tz / l;
    out.rx = -out.tz; // right-hand vector (rover faces along the tangent)
    out.rz = out.tx;
    return out;
  }

  indexAt(s) {
    return clamp(Math.round(s / this.step), 0, this.count - 1);
  }

  nearestS(x, z) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.count; i++) {
      const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best * this.step;
  }

  _analyse() {
    const T = this.terrain;
    const n = this.count;
    const raw = new Float32Array(n);
    this.pitch = new Float32Array(n);
    this.roll = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 2);
      const b = Math.min(n - 1, i + 2);
      const run = (b - a) * this.step || 1;
      const pitch = Math.atan((this.h[b] - this.h[a]) / run);
      const rx = -this.tz[i];
      const rz = this.tx[i];
      const hr = T.heightAt(this.x[i] + rx * 0.9, this.z[i] + rz * 0.9);
      const hl = T.heightAt(this.x[i] - rx * 0.9, this.z[i] - rz * 0.9);
      const roll = Math.atan((hr - hl) / 1.8);
      this.pitch[i] = pitch * DEG;
      this.roll[i] = roll * DEG;
      raw[i] = Math.atan(Math.hypot(Math.tan(pitch), Math.tan(roll))) * DEG;
    }
    // Average over the rover footprint (~3 m).
    this.tilt = new Float32Array(n);
    const w = Math.max(1, Math.round(1.5 / this.step));
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let j = i - w; j <= i + w; j++) {
        if (j >= 0 && j < n) {
          s += raw[j];
          c++;
        }
      }
      this.tilt[i] = s / c;
    }
    let maxTilt = 0;
    let climb = 0;
    for (let i = 0; i < n; i++) maxTilt = Math.max(maxTilt, this.tilt[i]);
    for (let i = 1; i < n; i++) climb += Math.max(0, this.h[i] - this.h[i - 1]);
    this.stats = { maxTilt, climb, minH: Math.min(...this.h), maxH: Math.max(...this.h) };
  }

  _placeStations(stations) {
    this.stations = stations.map((st, idx) => ({
      ...st,
      index: idx,
      s: st.s ?? this.nearestS(st.at[0], st.at[1]),
      done: false,
      tasks: st.tasks.map((t) => ({ ...t, progress: 0, done: false })),
    }));
    this.stations.sort((a, b) => a.s - b.s);
    // The habitat is the final stop.
    this.stations.push({
      id: 'HAB',
      name: 'Habitat Airlock',
      at: [HAB.x, HAB.z],
      s: this.length - 0.6,
      final: true,
      objective: 'Return to the habitat, stow samples and complete dust-off before ingress.',
      why: ['End of traverse', 'Samples must be stowed inside the hab'],
      tasks: [{ label: 'Stow samples & dust-off', minutes: 20, result: 'Samples stowed · EVA complete', progress: 0, done: false }],
      done: false,
    });
    for (const st of this.stations) {
      const p = this.sample(st.s);
      st.x = p.x;
      st.z = p.z;
      st.h = this.terrain.heightAt(p.x, p.z);
    }
  }

  _buildZones(areaHazards) {
    const n = this.count;
    const cls = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      cls[i] = this.tilt[i] >= SLOPE_CLASSES.danger ? 2 : this.tilt[i] >= SLOPE_CLASSES.caution ? 1 : 0;
    }
    // Keep the habitat pad and the first/last few metres clean.
    const runs = (level, mergeGap, minLen) => {
      const out = [];
      let start = -1;
      for (let i = 0; i <= n; i++) {
        const on = i < n && cls[i] >= level;
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          out.push([start, i - 1]);
          start = -1;
        }
      }
      const merged = [];
      for (const r of out) {
        const last = merged[merged.length - 1];
        if (last && (r[0] - last[1]) * this.step < mergeGap) last[1] = r[1];
        else merged.push([...r]);
      }
      return merged.filter((r) => (r[1] - r[0] + 1) * this.step >= minLen);
    };

    const zones = [];
    const maxTiltIn = (a, b) => {
      let m = 0;
      for (let i = a; i <= b; i++) m = Math.max(m, this.tilt[i]);
      return m;
    };
    for (const [a, b] of runs(2, 18, 5)) {
      zones.push({
        id: `SLOPE-${zones.length + 1}`,
        kind: 'slope',
        type: 'STEEP SLOPE',
        severity: 'danger',
        s0: Math.max(0, a * this.step - 4),
        s1: Math.min(this.length, b * this.step + 4),
        maxTilt: maxTiltIn(a, b),
        limit: ROVER.dangerSlopeSpeed,
        procedure: [
          `Reduce speed to ≤ ${ROVER.dangerSlopeSpeed} m/s (${Math.round(ROVER.dangerSlopeSpeed * 3.6)} km/h)`,
          'Drive straight up/down the fall line — avoid side-slope',
          'Crew restraints checked · tools stowed',
        ],
        basis: 'Combined pitch/roll from the elevation model along the planned centreline',
      });
    }
    // Caution stretches, minus whatever is already covered by a danger zone.
    const dangerSpans = zones.map((z) => [z.s0, z.s1]);
    const pieces = [];
    for (const [a, b] of runs(1, 12, 6)) {
      let parts = [[a * this.step, b * this.step]];
      for (const [d0, d1] of dangerSpans) {
        parts = parts.flatMap(([p0, p1]) => {
          if (d1 <= p0 || d0 >= p1) return [[p0, p1]];
          const out = [];
          if (d0 > p0) out.push([p0, d0]);
          if (d1 < p1) out.push([d1, p1]);
          return out;
        });
      }
      pieces.push(...parts.filter(([p0, p1]) => p1 - p0 >= 6));
    }
    for (const [s0, s1] of pieces) {
      const a = Math.round(s0 / this.step);
      const b = Math.round(s1 / this.step);
      zones.push({
        id: `CAUTION-${zones.length + 1}`,
        kind: 'slope',
        type: 'MODERATE SLOPE',
        severity: 'caution',
        s0,
        s1,
        maxTilt: maxTiltIn(a, b),
        limit: ROVER.cautionSpeed,
        procedure: [],
        basis: 'Elevation model',
      });
    }
    for (const hz of areaHazards) {
      let a = -1;
      let b = -1;
      for (let i = 0; i < n; i++) {
        if (Math.hypot(this.x[i] - hz.cx, this.z[i] - hz.cz) < hz.radius) {
          if (a < 0) a = i;
          b = i;
        }
      }
      if (a < 0) continue;
      zones.push({
        ...hz,
        kind: 'area',
        s0: a * this.step,
        s1: b * this.step,
        maxTilt: maxTiltIn(a, b),
      });
    }
    zones.sort((p, q) => p.s0 - q.s0);
    let nc = 0;
    let nd = 0;
    for (const z of zones) if (z.kind === 'slope') z.id = z.severity === 'danger' ? `SLOPE-${++nd}` : `CAUTION-${++nc}`;
    this.zones = zones;
    this.hazardClass = cls;
  }

  // A "stop" is anything that halts the rover until the crew acts:
  // a station (science tasks) or a hazard gate (briefing acknowledgement).
  _buildStops() {
    const stops = [];
    for (const st of this.stations) stops.push({ kind: 'station', s: st.s, ref: st });
    for (const z of this.zones) {
      if (z.severity !== 'danger') continue;
      let s = Math.max(1, z.s0 - 10);
      // never put a gate behind a station that sits inside its approach
      for (const st of this.stations) if (st.s < z.s0 && st.s > s - 1) s = Math.min(z.s0, st.s + 1.5);
      z.gateS = s;
      stops.push({ kind: 'gate', s, ref: z });
    }
    stops.sort((a, b) => a.s - b.s || (a.kind === 'station' ? -1 : 1));
    this.stops = stops;
  }

  zonesAt(s) {
    return this.zones.filter((z) => s >= z.s0 && s <= z.s1);
  }

  speedLimitAt(s) {
    let lim = ROVER.maxSpeed;
    for (const z of this.zones) if (s >= z.s0 - 2 && s <= z.s1) lim = Math.min(lim, z.limit);
    return lim;
  }
}

// ---------------------------------------------------------------------------
// Visuals: glowing route ribbon, distance stakes, station beacons, gate posts.
// ---------------------------------------------------------------------------

const ribbonVert = /* glsl */ `
  attribute float aS;
  attribute float aSide;
  attribute float aHaz;
  varying float vS;
  varying float vSide;
  varying float vHaz;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vS = aS; vSide = aSide; vHaz = aHaz;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const ribbonFrag = /* glsl */ `
  uniform float uTime;
  uniform float uRoverS;
  uniform float uOpacity;
  varying float vS;
  varying float vSide;
  varying float vHaz;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    vec3 cNorm = vec3(0.30, 0.92, 1.0);
    vec3 cCaut = vec3(1.0, 0.76, 0.22);
    vec3 cDang = vec3(1.0, 0.30, 0.22);
    vec3 col = vHaz > 1.5 ? cDang : (vHaz > 0.5 ? cCaut : cNorm);
    float side = abs(vSide);
    float ahead = vS - uRoverS;

    float edge = smoothstep(0.80, 0.93, side) * (1.0 - smoothstep(0.97, 1.0, side));
    float ph = fract((vS + 1.8 * side) / 7.0 - uTime * 0.55);
    float chev = smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.16, 0.24, ph));
    chev *= 1.0 - smoothstep(0.72, 0.86, side);

    float a = edge * 0.85 + chev * 0.4 + 0.05;
    float traveled = 1.0 - smoothstep(-3.0, 0.0, ahead);
    a *= mix(1.0, 0.22, traveled);
    col = mix(col, vec3(0.75, 0.8, 0.85), traveled * 0.7);
    // soft near the rover, fade the far route a bit but keep it readable
    a *= mix(0.35, 1.0, smoothstep(2.0, 18.0, abs(ahead)));
    a *= mix(0.45, 1.0, 1.0 - smoothstep(80.0, 600.0, abs(ahead)));
    gl_FragColor = vec4(col * 1.25, a * uOpacity);
    #include <fog_fragment>
  }
`;

const beamVert = /* glsl */ `
  varying float vY;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vY = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const beamFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uIntensity;
  varying float vY;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float rim = pow(1.0 - abs(dot(vN, vV)), 0.6);
    float fade = pow(1.0 - vY, 2.2);
    float pulse = 0.8 + 0.2 * sin(uTime * 2.5 - vY * 12.0);
    float a = (1.0 - rim) * fade * pulse * uIntensity;
    gl_FragColor = vec4(uColor * 1.4, a);
  }
`;

export class RouteVisuals {
  constructor(route, terrain) {
    this.route = route;
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uTime: { value: 0 }, uRoverS: { value: 0 }, uOpacity: { value: 1 } },
    ]);
    this._buildRibbon();
    this._buildStakes();
    this._buildBeacons();
    this._buildGates();
  }

  _hazAt(s) {
    let h = 0;
    for (const z of this.route.zones) {
      if (s >= z.s0 && s <= z.s1) h = Math.max(h, z.severity === 'danger' ? 2 : 1);
    }
    return h;
  }

  _buildRibbon() {
    const R = this.route;
    const sides = [-1, -0.5, 0, 0.5, 1];
    const half = 1.5;
    const cols = sides.length;
    const pos = new Float32Array(R.count * cols * 3);
    const aS = new Float32Array(R.count * cols);
    const aSide = new Float32Array(R.count * cols);
    const aHaz = new Float32Array(R.count * cols);
    for (let i = 0; i < R.count; i++) {
      const s = i * R.step;
      const rx = -R.tz[i];
      const rz = R.tx[i];
      const haz = this._hazAt(s);
      for (let j = 0; j < cols; j++) {
        const k = i * cols + j;
        const x = R.x[i] + rx * sides[j] * half;
        const z = R.z[i] + rz * sides[j] * half;
        pos[k * 3] = x;
        pos[k * 3 + 1] = this.terrain.heightAt(x, z) + 0.09;
        pos[k * 3 + 2] = z;
        aS[k] = s;
        aSide[k] = sides[j];
        aHaz[k] = haz;
      }
    }
    const idx = [];
    for (let i = 0; i < R.count - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
    geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
    geo.setAttribute('aHaz', new THREE.BufferAttribute(aHaz, 1));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: ribbonVert,
      fragmentShader: ribbonFrag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.ribbon = new THREE.Mesh(geo, mat);
    this.ribbon.renderOrder = 2;
    this.ribbon.frustumCulled = false;
    this.group.add(this.ribbon);
  }

  // Survey stakes along both sides of the corridor every 20 m (depth cue).
  _buildStakes() {
    const R = this.route;
    const every = 20;
    const n = Math.floor(R.length / every);
    const poleGeo = new THREE.CylinderGeometry(0.03, 0.04, 1.3, 6);
    poleGeo.translate(0, 0.65, 0);
    const capGeo = new THREE.BoxGeometry(0.16, 0.22, 0.03);
    capGeo.translate(0, 1.22, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xdedad2, roughness: 0.6, metalness: 0.2 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xff7a2a, emissive: 0xff5a10, emissiveIntensity: 0.6, roughness: 0.4 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, n * 2);
    const caps = new THREE.InstancedMesh(capGeo, capMat, n * 2);
    poles.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = {};
    let k = 0;
    for (let i = 1; i <= n; i++) {
      R.sample(i * every, p);
      const yaw = Math.atan2(-p.tx, -p.tz);
      q.setFromAxisAngle(up, yaw);
      for (const side of [-1, 1]) {
        const x = p.x + p.rx * side * 3.6;
        const z = p.z + p.rz * side * 3.6;
        m.compose(new THREE.Vector3(x, this.terrain.heightAt(x, z) - 0.05, z), q, new THREE.Vector3(1, 1, 1));
        poles.setMatrixAt(k, m);
        caps.setMatrixAt(k, m);
        k++;
      }
    }
    this.group.add(poles, caps);
  }

  _beam(color, height = 90, radius = 0.7) {
    const geo = new THREE.CylinderGeometry(radius, radius, height, 24, 1, true);
    geo.translate(0, height / 2, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      uniforms: { uColor: { value: new THREE.Color(color) }, uTime: this.uniforms.uTime, uIntensity: { value: 0.9 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    return mesh;
  }

  _buildBeacons() {
    this.beacons = [];
    const ringGeo = new THREE.RingGeometry(3.2, 3.6, 64);
    ringGeo.rotateX(-Math.PI / 2);
    for (const st of this.route.stations) {
      if (st.final) continue;
      const g = new THREE.Group();
      g.position.set(st.x, st.h, st.z);
      const beam = this._beam(0x56e0ff);
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0x56e0ff, transparent: true, opacity: 0.85, depthWrite: false, fog: true }),
      );
      ring.position.y = 0.15;
      // science marker tripod
      const tri = new THREE.Group();
      const legMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.6, roughness: 0.35 });
      for (let i = 0; i < 3; i++) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 6), legMat);
        const a = (i / 3) * Math.PI * 2;
        leg.position.set(Math.cos(a) * 0.3, 0.75, Math.sin(a) * 0.3);
        leg.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
        tri.add(leg);
      }
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x56e0ff, emissiveIntensity: 3 }),
      );
      lamp.position.y = 1.6;
      tri.add(lamp);
      tri.position.set(4.5, 0, 0);
      tri.traverse((o) => (o.castShadow = true));
      g.add(beam, ring, tri);
      this.group.add(g);
      this.beacons.push({ station: st, group: g, beam, ring, lamp });
    }
  }

  _buildGates() {
    this.gates = [];
    const postGeo = new THREE.CylinderGeometry(0.06, 0.07, 1.8, 8);
    postGeo.translate(0, 0.9, 0);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.5, metalness: 0.4 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff8a00, emissiveIntensity: 0.35 });
    const p = {};
    for (const z of this.route.zones) {
      if (z.severity !== 'danger') continue;
      this.route.sample(z.s0, p);
      const g = new THREE.Group();
      const lights = [];
      for (const side of [-1, 1]) {
        const x = p.x + p.rx * side * 3.2;
        const zz = p.z + p.rz * side * 3.2;
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(x, this.terrain.heightAt(x, zz) - 0.05, zz);
        post.castShadow = true;
        const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.35, 8), stripeMat);
        stripe.position.y = 1.2;
        post.add(stripe);
        const light = new THREE.Mesh(
          new THREE.SphereGeometry(0.11, 12, 10),
          new THREE.MeshStandardMaterial({ color: 0xff5040, emissive: 0xff3020, emissiveIntensity: 3 }),
        );
        light.position.y = 1.85;
        post.add(light);
        lights.push(light);
        g.add(post);
      }
      this.group.add(g);
      this.gates.push({ zone: z, group: g, lights });
    }
  }

  update(time, roverS, nextStationId) {
    this.uniforms.uTime.value = time;
    this.uniforms.uRoverS.value = roverS;
    for (const b of this.beacons) {
      const st = b.station;
      const isNext = st.id === nextStationId;
      const col = st.done ? 0x5cff9a : isNext ? 0x56e0ff : 0xbfd6e0;
      b.beam.material.uniforms.uColor.value.setHex(col);
      b.beam.material.uniforms.uIntensity.value = st.done ? 0.35 : isNext ? 1.0 : 0.45;
      b.ring.material.color.setHex(col);
      b.lamp.material.emissive.setHex(col);
    }
    const blink = Math.sin(time * 6) > 0 ? 3.2 : 0.4;
    for (const g of this.gates) {
      for (const l of g.lights) l.material.emissiveIntensity = g.zone.acknowledged ? 0.6 : blink;
    }
  }
}
