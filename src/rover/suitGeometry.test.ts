import { describe, expect, it } from 'vitest';
import { buildSuitGraph, graphStats, solveLeg, SUIT_MATERIALS, SHIN, THIGH, type SuitNode } from './suitGeometry.js';

// forward kinematics in the sagittal plane, matching XYZ Euler pitch about +X
const ankleOf = (hip: [number, number], a: number, B: number): [number, number] => [
  hip[0] - THIGH * Math.cos(a) - SHIN * Math.cos(a + B),
  hip[1] - THIGH * Math.sin(a) - SHIN * Math.sin(a + B),
];

const walk = (n: SuitNode, f: (n: SuitNode) => void) => { f(n); n.kids.forEach((k) => walk(k, f)); };

describe('procedural EVA suit', () => {
  it('leg IK puts the ankle on a reachable target with the knee bent forward', () => {
    const hip: [number, number] = [0.88, 0];
    for (const target of [[0.2, 0.02], [0.78, 0.64], [0.5, 0.3]] as [number, number][]) {
      const { a, B } = solveLeg(hip, target);
      const [y, z] = ankleOf(hip, a, B);
      expect(y).toBeCloseTo(target[0], 3);
      expect(z).toBeCloseTo(target[1], 3);
      expect(B).toBeGreaterThan(0);
    }
  });

  it('builds a full suit with sane geometry and known materials', () => {
    const { root, helmet } = buildSuitGraph();
    expect(helmet).not.toBeNull();
    const stats = graphStats(root);
    expect(stats.tris).toBeGreaterThan(50_000);
    expect(stats.tris).toBeLessThan(400_000);
    walk(root, (n) => {
      if (!n.mesh) return;
      const { g, mat } = n.mesh;
      expect(SUIT_MATERIALS[mat]).toBeDefined();
      expect(g.N.length).toBe(g.P.length);
      expect(g.C?.length).toBe(g.P.length);
      expect(g.P.every(Number.isFinite)).toBe(true);
      expect(g.I.reduce((m, i) => Math.max(m, i), 0)).toBeLessThan(g.P.length / 3);
    });
  });

  it('the waist-down variant is just pelvis, legs and boots', () => {
    const full = graphStats(buildSuitGraph().root);
    const legs = buildSuitGraph({ upperBody: false });
    expect(legs.helmet).toBeNull();
    expect(graphStats(legs.root).tris).toBeLessThan(full.tris / 2);
  });
});
