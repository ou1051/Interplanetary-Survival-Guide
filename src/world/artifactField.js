import * as THREE from 'three';
import { mulberry32 } from '../core/math.js';
import { RARITY } from '../sim/artifacts.js';

// ---------------------------------------------------------------------------
// Artifacts in the world: the find itself on the ground, a ring in its rarity
// colour, a floating marker and a thin light beam that can be seen from afar.
// Collected finds lift off and fade.
// ---------------------------------------------------------------------------

function displaced(geo, amount, seed) {
  const r = mulberry32(seed);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + (r() - 0.5) * amount);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function banded(color, accent) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 64;
  const g = c.getContext('2d');
  for (let y = 0; y < 64; y += 8) {
    g.fillStyle = (y / 8) % 2 ? accent : color;
    g.fillRect(0, y, 16, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function beamTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  // alphaMap reads the green channel: black (top) is clear, white (bottom) opaque.
  grad.addColorStop(0, 'rgb(0,0,0)');
  grad.addColorStop(1, 'rgb(255,255,255)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

export function artifactMesh(def, seed = 1) {
  const group = new THREE.Group();
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, flatShading: true, ...extra });
  const add = (geo, material, x = 0, y = 0, z = 0, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  const r = mulberry32(seed);
  switch (def.shape) {
    case 'crystal': {
      const m = mat(def.color, { roughness: 0.25, metalness: 0.1, emissive: def.accent, emissiveIntensity: 0.15 });
      for (let i = 0; i < 4; i++) {
        add(new THREE.ConeGeometry(0.05 + r() * 0.03, 0.22 + r() * 0.16, 6), m, (r() - 0.5) * 0.14, 0.12, (r() - 0.5) * 0.14, (r() - 0.5) * 0.7, (r() - 0.5) * 0.7);
      }
      add(displaced(new THREE.IcosahedronGeometry(0.11, 0), 0.3, seed), mat('#5a4636'), 0, 0.04, 0);
      break;
    }
    case 'slab':
      add(new THREE.BoxGeometry(0.42, 0.12, 0.28), new THREE.MeshStandardMaterial({ map: banded(def.color, def.accent), roughness: 0.85 }), 0, 0.06, 0, 0, 0.1);
      break;
    case 'spheres': {
      const m = mat(def.color, { roughness: 0.45, flatShading: false, metalness: 0.2 });
      for (let i = 0; i < 7; i++) add(new THREE.SphereGeometry(0.045 + r() * 0.035, 12, 10), m, (r() - 0.5) * 0.3, 0.05, (r() - 0.5) * 0.3);
      break;
    }
    case 'bead':
      add(new THREE.SphereGeometry(0.12, 24, 18), mat(def.color, { roughness: 0.08, metalness: 0.25, flatShading: false, emissive: def.accent, emissiveIntensity: 0.12 }), 0, 0.12, 0);
      break;
    case 'metal':
      add(displaced(new THREE.IcosahedronGeometry(0.17, 1), 0.35, seed), mat(def.color, { metalness: 0.9, roughness: 0.32 }), 0, 0.12, 0);
      add(new THREE.OctahedronGeometry(0.05, 0), mat(def.accent, { emissive: def.accent, emissiveIntensity: 0.4 }), 0.08, 0.2, -0.06);
      break;
    case 'vein': {
      add(displaced(new THREE.BoxGeometry(0.4, 0.16, 0.3, 3, 2, 3), 0.25, seed), mat('#6a4d3b'), 0, 0.08, 0);
      add(new THREE.BoxGeometry(0.42, 0.035, 0.06), mat(def.color, { emissive: def.accent, emissiveIntensity: 0.25 }), 0, 0.16, 0.02, 0, 0.15);
      break;
    }
    default:
      add(displaced(new THREE.IcosahedronGeometry(0.17, 1), 0.4, seed), mat(def.color), 0, 0.11, 0);
      add(new THREE.IcosahedronGeometry(0.05, 0), mat(def.accent), 0.09, 0.2, 0.04);
  }
  return group;
}

export class ArtifactField {
  constructor(scene, artifacts) {
    this.group = new THREE.Group();
    this.group.name = 'artifacts';
    scene.add(this.group);
    const beamTex = beamTexture();
    this.items = artifacts.map((a, i) => {
      const color = new THREE.Color(RARITY[a.rarity].color);
      const g = new THREE.Group();
      g.position.set(a.x, a.y, a.z);
      const find = artifactMesh(a, i * 13 + 5);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 0.95, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0),
        new THREE.MeshBasicMaterial({ color, toneMapped: false }));
      marker.position.y = 1.4;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 9, 8, 1, true),
        new THREE.MeshBasicMaterial({ color, alphaMap: beamTex, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      beam.position.y = 4.5;
      g.add(find, ring, marker, beam);
      this.group.add(g);
      return { artifact: a, group: g, find, ring, marker, beam, lift: 0 };
    });
  }

  // near: the artifact in reach (highlighted), viewer: camera world position
  update(dt, time, near, viewer) {
    for (const it of this.items) {
      const a = it.artifact;
      if (a.collected) {
        if (!it.group.visible) continue;
        it.lift += dt;
        it.find.position.y = it.lift * 2.2;
        it.find.scale.setScalar(Math.max(0.01, 1 - it.lift * 1.2));
        it.ring.material.opacity = Math.max(0, 0.7 - it.lift);
        it.beam.material.opacity = Math.max(0, 0.55 - it.lift);
        it.marker.visible = false;
        if (it.lift > 1) it.group.visible = false;
        continue;
      }
      const hot = near === a;
      it.marker.position.y = 1.4 + Math.sin(time * 2 + it.group.position.x) * 0.1;
      it.marker.rotation.y = time * 1.6;
      it.marker.scale.setScalar(hot ? 1.5 : 1);
      it.ring.scale.setScalar(hot ? 1 + 0.08 * Math.sin(time * 8) : 1);
      it.find.rotation.y = hot ? time * 0.8 : 0;
      // Beams guide from afar and step aside up close.
      const d = viewer ? Math.hypot(viewer.x - a.x, viewer.z - a.z) : 100;
      it.beam.material.opacity = 0.55 * Math.min(1, Math.max(0.15, (d - 4) / 25));
    }
  }
}
