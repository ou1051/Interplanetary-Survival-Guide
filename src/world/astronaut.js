import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The crew member in a surface suit, for the third-person view. Origin at the
// feet, facing -Z (same convention as the camera and the rover).
//   setWalk(speed, dt)  leg and arm swing with a light bob
//   setSeated(true)     pose for the rover's driver seat
// ---------------------------------------------------------------------------

export const EYE_HEIGHT = 1.68;

export class Astronaut {
  constructor(envMap) {
    const M = {
      suit: new THREE.MeshStandardMaterial({ color: 0xeeebe4, roughness: 0.8, metalness: 0, envMap, envMapIntensity: 0.4 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x9a9fa5, roughness: 0.55, metalness: 0.35, envMap }),
      stripe: new THREE.MeshStandardMaterial({ color: 0xd2562e, roughness: 0.6 }),
      visor: new THREE.MeshStandardMaterial({ color: 0xb08a3c, metalness: 1, roughness: 0.08, envMap, envMapIntensity: 1.2 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 1.2 }),
    };
    const cap = (r, l, mat) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 6, 12), mat);
      m.castShadow = true;
      return m;
    };
    this.root = new THREE.Group();
    this.root.name = 'astronaut';
    this.body = new THREE.Group();
    this.root.add(this.body);

    // Legs: hip → knee → boot, built around pivots so they can swing.
    this.legs = [-1, 1].map((side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.12, 0.96, 0);
      const thigh = cap(0.095, 0.3, M.suit);
      thigh.position.y = -0.22;
      const knee = new THREE.Group();
      knee.position.y = -0.46;
      const shin = cap(0.085, 0.3, M.suit);
      shin.position.y = -0.2;
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.3), M.dark);
      boot.position.set(0, -0.44, -0.05);
      boot.castShadow = true;
      knee.add(shin, boot);
      hip.add(thigh, knee);
      this.body.add(hip);
      return { hip, knee, side };
    });
    const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.2, 16), M.dark);
    pelvis.position.y = 1.0;
    const torso = cap(0.23, 0.32, M.suit);
    torso.position.y = 1.33;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.06), M.dark);
    chest.position.set(0, 1.36, -0.22);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.05, 16), M.stripe);
    band.position.y = 1.18;
    const plss = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.6, 0.22), M.suit);
    plss.position.set(0, 1.4, 0.3);
    const plssLid = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.2), M.dark);
    plssLid.position.set(0, 1.72, 0.3);
    for (const m of [pelvis, chest, band, plss, plssLid]) m.castShadow = true;
    this.body.add(pelvis, torso, chest, band, plss, plssLid);

    this.arms = [-1, 1].map((side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.31, 1.52, 0);
      const upper = cap(0.075, 0.24, M.suit);
      upper.position.y = -0.17;
      const elbow = new THREE.Group();
      elbow.position.y = -0.36;
      const fore = cap(0.068, 0.22, M.suit);
      fore.position.y = -0.15;
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), M.dark);
      glove.position.y = -0.33;
      glove.castShadow = true;
      elbow.add(fore, glove);
      shoulder.add(upper, elbow);
      this.body.add(shoulder);
      return { shoulder, elbow, side };
    });

    this.head = new THREE.Group();
    this.head.position.y = 1.8;
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.2, 28, 20), M.suit);
    shell.castShadow = true;
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.205, 28, 20, Math.PI * 1.15, Math.PI * 0.7, Math.PI * 0.22, Math.PI * 0.4), M.visor);
    const neck = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 10, 24), M.dark);
    neck.rotation.x = Math.PI / 2;
    neck.position.y = -0.14;
    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.06, 10), M.lamp);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(side * 0.17, 0.08, -0.06);
      this.head.add(lamp);
    }
    this.head.add(shell, visor, neck);
    this.body.add(this.head);

    this.phase = 0;
    this.seated = false;
  }

  setSeated(seated) {
    this.seated = seated;
    for (const leg of this.legs) {
      leg.hip.rotation.x = seated ? 1.5 : 0;
      leg.knee.rotation.x = seated ? -1.45 : 0;
    }
    for (const arm of this.arms) {
      arm.shoulder.rotation.x = seated ? 0.55 : 0;
      arm.elbow.rotation.x = seated ? 0.9 : 0;
      arm.shoulder.rotation.z = 0;
    }
    this.body.position.y = 0;
  }

  // Walking speed in m/s drives the gait; standing still settles the pose.
  setWalk(speed, dt) {
    if (this.seated) return;
    const amount = Math.min(1, speed / 1.4);
    this.phase += dt * (2.2 + speed * 2.4);
    const s = Math.sin(this.phase);
    for (const leg of this.legs) {
      const swing = s * leg.side;
      leg.hip.rotation.x += (swing * 0.55 * amount - leg.hip.rotation.x) * Math.min(1, dt * 12);
      const bend = Math.max(0, -swing) * 0.9 * amount + 0.05;
      leg.knee.rotation.x += (-bend - leg.knee.rotation.x) * Math.min(1, dt * 12);
    }
    for (const arm of this.arms) {
      const swing = -s * arm.side;
      arm.shoulder.rotation.x += (swing * 0.4 * amount - arm.shoulder.rotation.x) * Math.min(1, dt * 10);
      arm.shoulder.rotation.z = arm.side * 0.12;
      arm.elbow.rotation.x = 0.25 + 0.25 * amount;
    }
    this.body.position.y = Math.abs(Math.cos(this.phase)) * 0.045 * amount;
    this.body.rotation.x = -0.06 * amount;
  }

  // Bend down to pick something up (0 → 1).
  setReach(t) {
    if (this.seated) return;
    this.body.rotation.x = -0.5 * t;
    for (const arm of this.arms) arm.shoulder.rotation.x = 0.9 * t;
  }
}
