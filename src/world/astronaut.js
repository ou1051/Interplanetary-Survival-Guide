import * as THREE from 'three';
import { createSuitMaterials, createSuitObject } from '../rover/astronaut.js';

// ---------------------------------------------------------------------------
// The crew member on foot, for the third-person views: the team's procedural
// EVA suit (src/rover/suitGeometry.js), standing, with a walking gait posed at
// runtime. Origin at the feet, facing -Z (same convention as the camera and
// the rover).
//   setWalk(speed, dt)  hip and arm swing with a light bob
//   setReach(t)         bend down to pick something up (0 → 1)
// The seated driver lives in the rover (Rover.driver / Rover.driverLegs).
// ---------------------------------------------------------------------------

export const EYE_HEIGHT = 1.68;

const SCALE = 0.95;
const LEG_LENGTH = 0.86; // hip joint to sole, suit units
const KNEE = 0.14; // the walking legs keep a slight bend (baked into the fabric mesh)
const LEGS = { 1: { a: 0, B: KNEE }, '-1': { a: 0, B: KNEE } };
const ARMS = { 1: { x: -0.08, y: 0, z: 0.2, e: -0.42, ez: 0 }, '-1': { x: -0.08, y: 0, z: 0.2, e: -0.42, ez: 0 } };

export class Astronaut {
  /**
   * @param {Record<string, THREE.Material>|THREE.Texture|null} materials suit materials from
   *   createSuitMaterials() (share the rover's), or an environment map to make new ones
   */
  constructor(materials = null) {
    const mats = materials && !materials.isTexture ? materials : createSuitMaterials(materials);
    const { object, graph } = createSuitObject(mats, { legs: LEGS, arms: ARMS, visorDown: true });
    this.root = new THREE.Group();
    this.root.name = 'astronaut';
    this.body = new THREE.Group(); // bob and lean
    this.root.add(this.body);
    const figure = new THREE.Group();
    figure.rotation.y = Math.PI; // the suit graph faces +Z
    figure.scale.setScalar(SCALE);
    figure.add(object);
    this.body.add(figure);
    object.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    // Stand the boots on the ground.
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(figure);
    figure.position.y = -box.min.y;

    const P = graph.parts;
    const rest = (n) => n.object.rotation.clone();
    this.legs = [1, -1].map((side) => {
      const hip = graph.hips.find((h) => Math.sign(h.p[0]) === side);
      return { side, hip: hip.object, boot: P.boots[side].object, hip0: rest(hip), boot0: rest(P.boots[side]) };
    });
    this.arms = [1, -1].map((side) => ({
      side,
      shoulder: P.shoulders[side].object, elbow: P.elbows[side].object,
      shoulder0: rest(P.shoulders[side]), elbow0: rest(P.elbows[side]),
    }));
    this.upper = P.upper.object;
    this.upper0 = this.upper.rotation.x;
    this.phase = 0;
    this.reach = 0;
    this._swing = 0;
  }

  // Walking speed in m/s drives the gait; standing still settles the pose.
  setWalk(speed, dt) {
    const amount = Math.min(1, speed / 1.4);
    this.phase += dt * (2.2 + speed * 2.4);
    const k = Math.min(1, dt * 10);
    this._swing += (Math.sin(this.phase) * amount - this._swing) * k;
    const s = this._swing;
    for (const leg of this.legs) {
      // Suit faces +Z inside the figure: a negative hip pitch swings the leg forward.
      const pitch = leg.hip0.x - s * leg.side * 0.42;
      leg.hip.rotation.x = pitch;
      // keep the sole level with the ground through the swing
      leg.boot.rotation.x = leg.boot0.x - (pitch - leg.hip0.x);
    }
    for (const arm of this.arms) {
      const reach = this.reach;
      arm.shoulder.rotation.x = arm.shoulder0.x + s * arm.side * 0.32 - reach * 0.95;
      arm.elbow.rotation.x = arm.elbow0.x - 0.18 * amount - reach * 0.2;
    }
    this.upper.rotation.x = this.upper0 + 0.06 * amount + this.reach * 0.55;
    // Swinging both legs from the hips lifts the feet; drop the body so the boots keep touching the
    // ground at full stride, with a light bounce between steps.
    const drop = LEG_LENGTH * (1 - Math.cos(s * 0.42)) * SCALE;
    this.body.position.y = -drop + Math.abs(Math.cos(this.phase)) * 0.012 * amount;
  }

  // Bend down to pick something up (0 → 1); applied on the next setWalk().
  setReach(t) {
    this.reach = t;
  }
}
