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
const KNEE = 0.14; // resting knee bend while standing
const KNEE_SWING = 0.95; // extra knee flex while the leg swings through
// The legs are built straight; the knee bend is applied in the vertex shader (see bendableLeg)
// so it can change every frame.
const LEGS = { 1: { a: 0, B: 0 }, '-1': { a: 0, B: 0 } };
const KNEE_Y = -0.36; // knee pivot in leg-mesh space (= -THIGH in suitGeometry.js)

// Same smooth-blended knee rotation suitGeometry.legMesh() bakes in, done on the GPU with a uniform.
function bendableLeg(mesh) {
  const uniform = { value: KNEE };
  const material = mesh.material.clone();
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uKnee = uniform;
    const bend = `
      float kt = clamp((position.y - (-0.31)) / (-0.41 - (-0.31)), 0.0, 1.0);
      float ka = uKnee * kt * kt * (3.0 - 2.0 * kt);
      float kc = cos(ka), ks = sin(ka);`;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uKnee;\nvoid main() {')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      ${bend}
      objectNormal = vec3(objectNormal.x, objectNormal.y * kc - objectNormal.z * ks, objectNormal.y * ks + objectNormal.z * kc);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        ${bend}
        float dy = transformed.y - (${KNEE_Y.toFixed(3)});
        float dz = transformed.z;
        transformed.y = ${KNEE_Y.toFixed(3)} + dy * kc - dz * ks;
        transformed.z = dy * ks + dz * kc;
      }`);
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${key ? key() : ''}|kneeBend`;
  mesh.material = material;
  return uniform;
}
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
      // the fabric leg is the largest mesh hanging directly off the hip
      const legMesh = hip.object.children.filter((c) => c.isMesh).sort((a, b) => b.geometry.attributes.position.count - a.geometry.attributes.position.count)[0];
      return {
        side, hip: hip.object, knee: P.knees[side].object, boot: P.boots[side].object,
        hip0: rest(hip), boot0: rest(P.boots[side]), bend: bendableLeg(legMesh),
      };
    });
    this.arms = [1, -1].map((side) => ({
      side,
      shoulder: P.shoulders[side].object, elbow: P.elbows[side].object,
      shoulder0: rest(P.shoulders[side]), elbow0: rest(P.elbows[side]),
    }));
    this.upper = P.upper.object;
    this.upper0 = this.upper.rotation.x;
    this.upper0y = this.upper.rotation.y;
    this.phase = 0;
    this.reach = 0;
    this._swing = 0;
  }

  // Walking speed in m/s drives the gait; standing still settles the pose.
  setWalk(speed, dt) {
    const amount = Math.min(1, speed / 1.8);
    // cadence rises with speed; a loping, low-gravity stride rather than a march
    this.phase += dt * (2.6 + speed * 2.2);
    // the swing follows the phase directly; only the stride size is smoothed
    this._amount = (this._amount ?? 0) + (amount - (this._amount ?? 0)) * Math.min(1, dt * 6);
    const a = this._amount;
    const s = Math.sin(this.phase) * a;
    this._swing = s;
    for (const leg of this.legs) {
      // Suit faces +Z inside the figure: a negative hip pitch swings the leg forward.
      const pitch = leg.hip0.x - s * leg.side * 0.55;
      leg.hip.rotation.x = pitch;
      // the knee folds while the leg swings forward (cos > 0 for this side) and straightens to plant
      const swing = Math.max(0, Math.cos(this.phase) * leg.side);
      const B = KNEE + KNEE_SWING * swing * swing * a + this.reach * 0.6;
      leg.knee.rotation.x = B;
      leg.bend.value = B;
      // keep the sole level with the ground through the swing
      leg.boot.rotation.x = leg.boot0.x - (pitch - leg.hip0.x) - B;
    }
    for (const arm of this.arms) {
      const reach = this.reach;
      // arms counter-swing with a slight lag, elbows flex more at speed
      const lag = Math.sin(this.phase - 0.35) * a;
      arm.shoulder.rotation.x = arm.shoulder0.x + lag * arm.side * 0.45 - reach * 0.95;
      arm.elbow.rotation.x = arm.elbow0.x - 0.3 * a - reach * 0.2;
    }
    // lean into the walk, sway the torso and roll the hips with each step
    this.upper.rotation.x = this.upper0 + 0.1 * a + this.reach * 0.55;
    this.upper.rotation.y = this.upper0y + Math.sin(this.phase) * 0.08 * a;
    this.body.rotation.z = Math.sin(this.phase) * 0.035 * a;
    // Swinging both legs from the hips lifts the feet; drop the body so the boots keep touching the
    // ground at full stride, plus a springy bound between steps (low gravity).
    const drop = LEG_LENGTH * (1 - Math.cos(s * 0.55)) * SCALE;
    this.body.position.y = -drop + Math.abs(Math.sin(this.phase)) * 0.05 * a;
  }

  // Bend down to pick something up (0 → 1); applied on the next setWalk().
  setReach(t) {
    this.reach = t;
  }
}
