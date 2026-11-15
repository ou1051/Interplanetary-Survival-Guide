import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, SelectiveBloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, SMAAPreset } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

// ---------------------------------------------------------------------------
// Post-processing for the surface drive:
//   N8AO ambient occlusion → contact darkening under the rover, posts and rocks.
//   Selective bloom        → only real light sources glow (headlights, beacons,
//                            hazard lamps, antenna tips), never the dashboards.
//   ACES tone mapping      → moved from the renderer to the end of the chain so
//                            AO and bloom work on linear HDR colour.
// Materials that opt out of tone mapping (cockpit screens, LEDs) are pre-warped
// with the inverse ACES curve so they come out of the chain exactly as before.
// ---------------------------------------------------------------------------

// Exact inverse of three.js ACESFilmicToneMapping (same matrices and RRT/ODT fit).
const INVERSE_ACES = /* glsl */ `
  vec3 inverseACESFilmic(vec3 y) {
    const mat3 ACESOutputInv = mat3(
      vec3(0.64304, 0.05927, 0.00596),
      vec3(0.31119, 0.93144, 0.06393),
      vec3(0.04578, 0.00930, 0.93012));
    const mat3 ACESInputInv = mat3(
      vec3(1.76474, -0.14703, -0.03634),
      vec3(-0.67578, 1.16025, -0.16244),
      vec3(-0.08896, -0.01322, 1.19877));
    vec3 c = ACESOutputInv * clamp(y, 0.0, 0.985);
    vec3 A = c * 0.983729 - 1.0;
    vec3 B = c * 0.4329510 - 0.0245786;
    vec3 C = c * 0.238081 + 0.000090537;
    vec3 v = (-B - sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
    // no clamp: saturated screen colours sit outside the ACES gamut and need negative components
    return (ACESInputInv * v) * (0.6 / toneMappingExposure);
  }
`;

function keepUnmapped(material) {
  if (material.userData.inverseACES) return;
  material.userData.inverseACES = true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float toneMappingExposure;\n${INVERSE_ACES}\nvoid main() {`)
      .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = inverseACESFilmic(gl_FragColor.rgb);');
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${key ? key() : ''}|invACES`;
  material.needsUpdate = true;
}

// A mesh counts as a light source if it is visibly emissive (or an unlit LED-style red/amber tip).
function isLightSource(mesh) {
  const m = mesh.material;
  if (!m || Array.isArray(m)) return false;
  if (m.userData.bloom) return true; // explicitly tagged light sources
  if (m.emissive && m.emissiveIntensity >= 0.5) {
    const e = m.emissive;
    return e.r + e.g + e.b > 0.3;
  }
  return false;
}

export function createPostFX(renderer, scene, camera) {
  // Full-screen passes scale with pixel count: cap the internal resolution (Retina at 2× is 4× the work)
  // and anti-alias with SMAA instead of multisampled buffers.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const ao = new N8AOPostPass(scene, camera, 1, 1);
  Object.assign(ao.configuration, {
    aoRadius: 2.2,          // metres: rover undercarriage, post feet, rock bases
    distanceFalloff: 1.0,
    intensity: 4,
    color: new THREE.Color('#1c0c06'), // occlusion tinted like shaded regolith
    halfRes: true,
    depthAwareUpsampling: true,
    gammaCorrection: false, // linear chain; the final pass encodes sRGB
  });
  ao.setQualityMode('Low');
  composer.addPass(ao);

  const bloom = new SelectiveBloomEffect(scene, camera, {
    mipmapBlur: true,
    intensity: 1.6,
    luminanceThreshold: 0.35,
    luminanceSmoothing: 0.25,
    radius: 0.7,
  });
  bloom.ignoreBackground = true;
  const toneMap = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });
  const effects = new EffectPass(camera, bloom, toneMap, smaa);
  composer.addPass(effects);

  // Scan the scene for screens to protect and lights to bloom. Route visuals and
  // artifacts are rebuilt during play, so this re-runs twice a second
  // (also catches the headlight lenses switching on).
  const refresh = () => {
    const lights = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.toneMapped === false && !m.isShaderMaterial && !m.isRawShaderMaterial) keepUnmapped(m);
      if (isLightSource(o)) lights.push(o);
    });
    bloom.selection.set(lights);
  };
  refresh();
  let since = 0;
  let mainCamera = camera;

  return {
    composer,
    ao,
    bloom,
    setSize(w, h) { composer.setSize(w, h); },
    render(dt, activeCam) {
      if (activeCam !== mainCamera) {
        mainCamera = activeCam;
        composer.setMainCamera(activeCam);
        ao.camera = activeCam;
      }
      since += dt;
      if (since > 0.5) { since = 0; refresh(); }
      composer.render(dt);
    },
  };
}
