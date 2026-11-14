import * as THREE from 'three';

// ---------------------------------------------------------------------------
// A science station checkpoint beside the route: landing pad with edge markings,
// signal mast with an ID sign and beacon, instrument tripod, sample cache, a
// small solar panel and corner flags marking the work area.
// Built in the station's local frame (origin at the station on the route).
// ---------------------------------------------------------------------------

const OFFSET = 8.5; // metres from the route centreline to the pad centre
const mats = {};
function mat(key, make) {
  mats[key] ??= make();
  return mats[key];
}
const white = () => mat('white', () => new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.55, metalness: 0.15 }));
const metal = () => mat('metal', () => new THREE.MeshStandardMaterial({ color: 0xc9cdd2, roughness: 0.35, metalness: 0.7 }));
const dark = () => mat('dark', () => new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.6, metalness: 0.3 }));
const orange = () => mat('orange', () => new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0x5a1e00, roughness: 0.5 }));
const panel = () => mat('panel', () => new THREE.MeshStandardMaterial({ color: 0x1b2a4a, roughness: 0.25, metalness: 0.7, emissive: 0x050a18 }));
const pad = () => mat('pad', () => new THREE.MeshStandardMaterial({ color: 0x6d6a66, roughness: 0.95 }));

function signTexture(station) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b3d91';
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = '#fc3d21';
  ctx.fillRect(0, 0, 18, 256);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 120px "Helvetica Neue", Arial, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(station.id, 48, 22);
  ctx.font = 'bold 34px "Helvetica Neue", Arial, sans-serif';
  const name = station.name.toUpperCase();
  ctx.fillText(name.length > 22 ? `${name.slice(0, 21)}…` : name, 48, 156);
  ctx.fillStyle = '#c7d4ea';
  ctx.font = '600 22px "Helvetica Neue", Arial, sans-serif';
  ctx.fillText('SCIENCE STATION · WORK AREA', 48, 206);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function createStationPost(station, route, terrain) {
  const p = route.sample(station.s);
  // pad on the right-hand side of the direction of travel
  const cx = p.x + p.rx * OFFSET;
  const cz = p.z + p.rz * OFFSET;
  const local = (x, z) => terrain.heightAt(x, z) - station.h;
  const post = new THREE.Group();
  post.position.set(cx - station.x, local(cx, cz), cz - station.z);
  // local +Z of the post points at the route 18 m before the station, so the sign faces the arriving crew
  const from = route.sample(Math.max(0, station.s - 18));
  post.rotation.y = Math.atan2(from.x - cx, from.z - cz);

  const shadow = (mesh) => { mesh.castShadow = true; mesh.receiveShadow = true; return mesh; };

  // landing pad with alternating edge markings
  // deep base so the pad meets the ground on sloped sites
  const base = shadow(new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.5, 0.9, 40), pad()));
  base.position.y = 0.12 - 0.45;
  post.add(base);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.22), i % 2 ? white() : orange());
    mark.position.set(Math.cos(a) * 2.85, 0.135, Math.sin(a) * 2.85);
    mark.rotation.y = -a + Math.PI / 2;
    post.add(mark);
  }

  // signal mast with ID sign and beacon lamp (the lamp colour shows the station state)
  const mast = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.8, 10), metal()));
  mast.position.set(-1.9, 1.9, 1.2);
  post.add(mast);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 0.95),
    new THREE.MeshStandardMaterial({ map: signTexture(station), roughness: 0.6, side: THREE.DoubleSide, emissive: 0xffffff, emissiveIntensity: 0.18, emissiveMap: null }),
  );
  sign.material.emissiveMap = sign.material.map;
  sign.position.set(-0.85, 2.55, 1.24);
  post.add(sign);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.05, 0.05), dark());
  frame.position.set(-0.85, 2.55, 1.2);
  post.add(frame);
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x56e0ff, emissiveIntensity: 3 }),
  );
  lamp.position.set(-1.9, 3.9, 1.2);
  post.add(lamp);

  // instrument tripod
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 6), metal()));
    leg.position.set(1.2 + Math.cos(a) * 0.3, 0.8, -0.6 + Math.sin(a) * 0.3);
    leg.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
    post.add(leg);
  }
  const head = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.26), white()));
  head.position.set(1.2, 1.62, -0.6);
  post.add(head);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 12), dark());
  lens.rotation.x = Math.PI / 2;
  lens.position.set(1.2, 1.62, -0.42);
  post.add(lens);

  // sample cache box with an orange band
  const cache = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.5, 0.55), white()));
  cache.position.set(0.2, 0.37, 1.4);
  post.add(cache);
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.87, 0.1, 0.57), orange());
  band.position.set(0.2, 0.42, 1.4);
  post.add(band);

  // small solar panel on a post
  const stand = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.9, 8), metal()));
  stand.position.set(1.6, 0.55, 1.1);
  post.add(stand);
  const solar = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.8), panel()));
  solar.position.set(1.6, 1.0, 1.1);
  solar.rotation.x = -0.5;
  post.add(solar);

  // corner flags around the work area
  const flagShape = new THREE.Shape();
  flagShape.moveTo(0, 0);
  flagShape.lineTo(0.45, -0.14);
  flagShape.lineTo(0, -0.28);
  flagShape.closePath();
  const flagGeo = new THREE.ShapeGeometry(flagShape);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
    const fx = Math.cos(a) * 4.4;
    const fz = Math.sin(a) * 4.4;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.4, 6), metal());
    pole.position.set(fx, 0.7, fz);
    post.add(pole);
    const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0xff7a1a, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(fx, 1.38, fz);
    post.add(flag);
  }
  return { group: post, lamp };
}
