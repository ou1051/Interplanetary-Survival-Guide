// @ts-nocheck
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural astronaut: white suit, gold visor, life-support backpack, jointed legs
// and arms. Origin at the feet, faces -Z, about 1.9 m tall. No textures, no assets.
//
//   const a = createAstronaut();
//   scene.add(a.root);
//   a.animate(dt, { speed, airborne });   // every frame
//   a.setClimb(u)                         // 0..1, stepping over the rover's side rail
// ---------------------------------------------------------------------------

const std = (color, roughness = 0.55, metalness = 0.1, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function createAstronaut() {
  const white = std(0xe9e6df, 0.6, 0.05);
  const grey = std(0x8c8f94, 0.45, 0.6);
  const dark = std(0x23262b, 0.7, 0.2);
  const orange = std(0xff7a2a, 0.5, 0.1);
  const gold = std(0xd9a441, 0.15, 1.0);
  const lamp = std(0x9ff0ff, 0.4, 0, { emissive: 0x56e0ff, emissiveIntensity: 2 });

  const root = new THREE.Group();
  root.name = 'astronaut';
  const body = new THREE.Group(); // pelvis pivot
  body.position.y = 0.85;
  root.add(body);

  const cap = (r, len, m, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 12), m);
    o.position.set(x, y, z);
    return o;
  };

  // torso + chest unit
  body.add(cap(0.21, 0.3, white, 0, 0.34, 0));
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.06), grey);
  chest.position.set(0, 0.42, -0.21);
  body.add(chest);
  for (let i = 0; i < 3; i++) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.02), i === 1 ? lamp : orange);
    l.position.set(-0.07 + i * 0.07, 0.44, -0.245);
    body.add(l);
  }
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.225, 0.07, 20), orange);
  belt.position.set(0, 0.06, 0);
  body.add(belt);

  // life-support backpack
  const pack = new THREE.Group();
  pack.position.set(0, 0.36, 0.27);
  pack.add(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.56, 0.22), white));
  for (const sx of [-1, 1]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 12), grey);
    tank.position.set(sx * 0.12, 0, 0.14);
    pack.add(tank);
  }
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 6), dark);
  antenna.position.set(0.17, 0.4, 0.05);
  pack.add(antenna);
  body.add(pack);

  // head: helmet + gold visor
  const head = new THREE.Group();
  head.position.set(0, 0.8, 0);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.25, 28, 20), white);
  head.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.258, 28, 16, Math.PI * 1.5 - 0.95, 1.9, 0.38, 1.35), gold);
  head.add(visor);
  const neck = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 8, 20), grey);
  neck.rotation.x = Math.PI / 2;
  neck.position.y = -0.2;
  head.add(neck);
  const lampL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.04), lamp);
  lampL.position.set(0.2, 0.1, -0.12);
  head.add(lampL);
  body.add(head);

  // limbs (pivot groups so they can swing)
  const limb = (x, y, upperLen, lowerLen, r, endMat, isLeg) => {
    const hip = new THREE.Group();
    hip.position.set(x, y, 0);
    hip.add(cap(r, upperLen - 2 * r, white, 0, -upperLen / 2, 0));
    const knee = new THREE.Group();
    knee.position.y = -upperLen;
    knee.add(cap(r * 0.92, lowerLen - 2 * r * 0.92, white, 0, -lowerLen / 2, 0));
    if (isLeg) {
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.27), endMat);
      boot.position.set(0, -lowerLen - 0.03, -0.04);
      knee.add(boot);
    } else {
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), endMat);
      glove.position.set(0, -lowerLen - 0.03, 0);
      knee.add(glove);
    }
    hip.add(knee);
    body.add(hip);
    return { hip, knee };
  };
  const legL = limb(-0.12, 0, 0.4, 0.4, 0.085, dark, true);
  const legR = limb(0.12, 0, 0.4, 0.4, 0.085, dark, true);
  const armL = limb(-0.3, 0.55, 0.28, 0.27, 0.07, orange, false);
  const armR = limb(0.3, 0.55, 0.28, 0.27, 0.07, orange, false);

  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  let phase = 0;
  let t = 0;
  let climb = 0;
  const smooth = { k: 0 };

  function animate(dt, { speed = 0, airborne = false } = {}) {
    t += dt;
    const k = clamp(speed / 1.6, 0, 2.2);
    smooth.k += (k - smooth.k) * Math.min(1, dt * 10);
    const kk = smooth.k;
    phase += dt * (3.2 + speed * 1.3) * (kk > 0.05 ? 1 : 0);
    const s = Math.sin(phase);

    if (climb > 0) return; // climb pose owns the joints

    if (airborne) {
      legL.hip.rotation.x += (-0.35 - legL.hip.rotation.x) * Math.min(1, dt * 12);
      legR.hip.rotation.x += (0.45 - legR.hip.rotation.x) * Math.min(1, dt * 12);
      legL.knee.rotation.x += (-0.5 - legL.knee.rotation.x) * Math.min(1, dt * 12);
      legR.knee.rotation.x += (-0.2 - legR.knee.rotation.x) * Math.min(1, dt * 12);
      armL.hip.rotation.x += (-0.9 - armL.hip.rotation.x) * Math.min(1, dt * 10);
      armR.hip.rotation.x += (-0.9 - armR.hip.rotation.x) * Math.min(1, dt * 10);
      return;
    }
    const ease = Math.min(1, dt * 14);
    legL.hip.rotation.x += (s * 0.62 * kk - legL.hip.rotation.x) * ease;
    legR.hip.rotation.x += (-s * 0.62 * kk - legR.hip.rotation.x) * ease;
    legL.knee.rotation.x += (-Math.max(0, -s) * 0.95 * kk - legL.knee.rotation.x) * ease;
    legR.knee.rotation.x += (-Math.max(0, s) * 0.95 * kk - legR.knee.rotation.x) * ease;
    armL.hip.rotation.x += (-s * 0.55 * kk - armL.hip.rotation.x) * ease;
    armR.hip.rotation.x += (s * 0.55 * kk - armR.hip.rotation.x) * ease;
    armL.knee.rotation.x += (-0.25 - 0.2 * kk - armL.knee.rotation.x) * ease;
    armR.knee.rotation.x += (-0.25 - 0.2 * kk - armR.knee.rotation.x) * ease;
    body.position.y = 0.85 + Math.abs(s) * 0.035 * kk;
    body.rotation.x = 0.04 * kk;
    body.scale.y = 1 + Math.sin(t * 1.7) * 0.004 * (1 - Math.min(1, kk));
  }

  /** u in 0..1: stepping over the side rail of the rover (also used backwards to board) */
  function setClimb(u) {
    climb = u > 0 && u < 1 ? u : 0;
    if (!climb) return;
    const lift = Math.sin(Math.min(1, u * 1.6) * Math.PI);
    legL.hip.rotation.x = -1.1 * lift;
    legL.knee.rotation.x = -1.0 * lift;
    legR.hip.rotation.x = 0.2 * Math.sin(u * Math.PI);
    legR.knee.rotation.x = -0.1;
    armL.hip.rotation.x = -1.2 + 0.7 * u;
    armR.hip.rotation.x = -1.2 + 0.7 * u;
    armL.knee.rotation.x = -0.4;
    armR.knee.rotation.x = -0.4;
    body.rotation.x = 0.28 * Math.sin(u * Math.PI);
    body.position.y = 0.85;
  }

  return { root, animate, setClimb, eyeHeight: 1.67, parts: { body, head, legL, legR, armL, armR } };
}