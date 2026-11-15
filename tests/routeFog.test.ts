import { expect, it } from 'vitest';
import { AdditiveBlending } from 'three';
import { RouteVisuals } from '../src/world/route.js';

it('wires beacon beams to scene fog while retaining additive light nearby', () => {
  const visuals = Object.assign(Object.create(RouteVisuals.prototype), {
    uniforms: { uTime: { value: 0 } },
  });
  const { material } = visuals._beam(0x56e0ff);
  expect(material.fog).toBe(true);
  expect(material.blending).toBe(AdditiveBlending);
  expect(material.uniforms).toHaveProperty('fogDensity');
  expect(material.vertexShader).toContain('#include <fog_vertex>');
  expect(material.fragmentShader).toContain('#include <fog_pars_fragment>');
  expect(material.fragmentShader).toContain('gl_FragColor.rgb *= 1.0 - fogFactor;');
});
