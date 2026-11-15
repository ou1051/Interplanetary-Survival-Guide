export interface SuitGeometry { P: number[]; N: number[]; U: number[]; C: number[] | null; I: number[]; doubleSided?: boolean }
export interface SuitNode {
  p: number[]; r: number[]; s: number[];
  kids: SuitNode[];
  mesh: { g: SuitGeometry; mat: string } | null;
  tag?: boolean; disc?: number;
}
export interface LegPose { a: number; B: number }
export interface ArmPose { x: number; y?: number; z: number; e: number; ez?: number }
export interface SuitMaterialDef { color: number; kind: string; dirt: number; repeat?: number; normalScale?: number }

export const SUIT_MATERIALS: Record<string, SuitMaterialDef>;
export const DUST_COLOR: number;
export const THIGH: number;
export const SHIN: number;
export function solveLeg(hip: [number, number], ankle: [number, number], L1?: number, L2?: number): LegPose;
export function buildSuitGraph(o?: {
  upperBody?: boolean;
  legs?: Record<string, LegPose>;
  arms?: Record<string, ArmPose>;
  recline?: number;
  visorDown?: boolean;
}): {
  root: SuitNode;
  helmet: SuitNode | null;
  hips: SuitNode[];
  /** Joints to pose at runtime, keyed by side (1 = right, -1 = left); upper is null without an upper body. */
  parts: {
    upper: SuitNode | null;
    knees: Record<string, SuitNode>;
    boots: Record<string, SuitNode>;
    shoulders: Record<string, SuitNode>;
    elbows: Record<string, SuitNode>;
  };
};
export function graphStats(root: SuitNode): { meshes: number; verts: number; tris: number };
