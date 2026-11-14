import { describe, expect, it } from 'vitest';
import {
  ScanTask, PanoTask, TuneTask, SweepTask, DrillTask, layoutTask, dirFromYawPitch, norm, sub, gradeFor, GRADE_POINTS,
} from '../src/sim/fieldTasks.js';
import { STATIONS } from '../src/config/mission.js';
import { Route } from '../src/world/route.js';
import { Mission } from '../src/sim/mission.js';

type V = { x: number; y: number; z: number };
const eye: V = { x: 0, y: 1.6, z: 0 };
const flat = () => 0;
const dt = 1 / 60;
const toward = (p: V) => norm(sub(p, eye));
// Smoothly rotate an aim vector toward a goal at most `rate` rad/s.
function turn(from: V, to: V, rate: number): V {
  const a = Math.acos(Math.min(1, Math.max(-1, from.x * to.x + from.y * to.y + from.z * to.z)));
  if (a < 1e-6) return to;
  const k = Math.min(1, (rate * dt) / a);
  return norm({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k });
}

describe('station task layout', () => {
  it('gives every configured station task a playable first-person mechanic', () => {
    const kinds = new Set(['scan', 'pano', 'tune', 'sweep', 'drill']);
    for (const station of STATIONS) {
      for (const task of station.tasks) {
        expect(kinds.has(task.kind)).toBe(true);
        const game = layoutTask(task, { eye, heading: 0, ground: flat, source: { x: 40, y: 9, z: 30 }, seed: 3 });
        expect(game.kind).toBe(task.kind);
        expect(game.progress).toBe(0);
      }
    }
  });

  it('places scan targets in front of the crew and the radar line on the ground', () => {
    const scan = layoutTask({ kind: 'scan', targets: 3 }, { eye, heading: 0, ground: flat, seed: 1 }) as ScanTask;
    for (const t of scan.targets) {
      const d = Math.hypot(t.pos.x - eye.x, t.pos.z - eye.z);
      expect(d).toBeGreaterThan(5);
      expect(d).toBeLessThan(12);
      expect(t.pos.z).toBeLessThan(0); // heading 0 looks along -Z
    }
    const sweep = layoutTask({ kind: 'sweep' }, { eye, heading: 0, ground: () => 2, seed: 1 }) as SweepTask;
    expect(sweep.samples.every((s) => Math.abs(s.pos.y - 2.05) < 1e-9)).toBe(true);
  });
});

describe('first-person mechanics', () => {
  it('scan locks each target only while the aim is held on it', () => {
    const task = layoutTask({ kind: 'scan', targets: 3 }, { eye, heading: 0, ground: flat, seed: 2 }) as ScanTask;
    let aim = dirFromYawPitch(Math.PI); // start facing backwards
    let events: (string | null)[] = [];
    for (let i = 0; i < 60 * 30 && !task.done; i++) {
      aim = turn(aim, toward(task.current!.pos), 2.5);
      events.push(task.update(dt, { eye, dir: aim }));
    }
    expect(task.done).toBe(true);
    expect(events.filter((e) => e === 'lock')).toHaveLength(2);
    expect(['S', 'A']).toContain(task.grade);

    const idle = layoutTask({ kind: 'scan', targets: 1 }, { eye, heading: 0, ground: flat, seed: 2 }) as ScanTask;
    for (let i = 0; i < 60 * 20; i++) idle.update(dt, { eye, dir: dirFromYawPitch(Math.PI) });
    expect(idle.done).toBe(false);
    expect(idle.progress).toBe(0);
  });

  it('panorama captures a frame only when the camera is held still on it', () => {
    const task = layoutTask({ kind: 'pano', frames: 6, arc: 360 }, { eye, heading: 0, ground: flat, seed: 1 }) as PanoTask;
    // Spinning fast through every frame never gets a sharp shot.
    let yaw = 0;
    for (let i = 0; i < 60 * 6; i++) { yaw += 4 * dt; task.update(dt, { dir: dirFromYawPitch(yaw, 0.035) }); }
    expect(task.progress).toBe(0);
    expect(task.penalty).toBeGreaterThan(0);
    // Turning to each frame and pausing captures them all.
    let aim = dirFromYawPitch(yaw, 0.035);
    for (const s of task.sectors) {
      for (let i = 0; i < 60 * 5 && !s.done; i++) {
        aim = turn(aim, s.dir, 1.2);
        task.update(dt, { dir: aim });
      }
    }
    expect(task.done).toBe(true);
  });

  it('tune has no marker: the signal peaks only toward the habitat', () => {
    const source = { x: 30, y: 5, z: 40 };
    const task = layoutTask({ kind: 'tune' }, { eye, heading: 0, ground: flat, source, seed: 1 }) as TuneTask;
    task.update(dt, { dir: dirFromYawPitch(0) });
    expect(task.signal).toBeLessThan(0.5);
    let aim = dirFromYawPitch(0);
    for (let i = 0; i < 60 * 10 && !task.done; i++) {
      aim = turn(aim, toward(source), 1.5);
      task.update(dt, { dir: aim });
    }
    expect(task.done).toBe(true);
    expect(task.signal).toBeGreaterThan(0.9);
  });

  it('radar sweep needs a steady trace from one end to the other', () => {
    const make = () => layoutTask({ kind: 'sweep' }, { eye, heading: 0, ground: flat, seed: 1 }) as SweepTask;
    const steady = make();
    let aim = toward(steady.samples.at(-1)!.pos); // start from the right-hand post
    for (let i = 0; i < 60 * 30 && !steady.done; i++) {
      const goal = steady.next ? toward(steady.next.pos) : toward(steady.samples.at(-1)!.pos);
      aim = turn(aim, goal, 0.5);
      steady.update(dt, { eye, dir: aim });
    }
    expect(steady.done).toBe(true);
    expect(steady.order).toBe(-1);

    const rushed = make();
    aim = toward(rushed.samples[0].pos);
    for (let i = 0; i < 60 * 4; i++) {
      aim = turn(aim, toward(rushed.samples.at(-1)!.pos), 3);
      rushed.update(dt, { eye, dir: aim });
    }
    expect(rushed.done).toBe(false);
    expect(rushed.penalty).toBeGreaterThan(0);
  });

  it('drill cuts cores inside the band and jams under constant full pressure', () => {
    const careful = new DrillTask({ cores: 2, seed: 2 });
    for (let i = 0; i < 60 * 60 && !careful.done; i++) careful.update(dt, { pressing: careful.pressure < careful.band.center });
    expect(careful.done).toBe(true);
    expect(careful.jams).toBe(0);
    const brute = new DrillTask({ seed: 2 });
    for (let i = 0; i < 60 * 10; i++) brute.update(dt, { pressing: true });
    expect(brute.jams).toBeGreaterThan(0);
    expect(brute.grade).not.toBe('S');
  });

  it('grades by time against par, with penalties', () => {
    expect(gradeFor(0.5)).toBe('S');
    expect(gradeFor(1)).toBe('A');
    expect(gradeFor(1)).not.toBe(gradeFor(1, 2));
    expect(GRADE_POINTS.S).toBeGreaterThan(GRADE_POINTS.C);
  });
});

it('adds graded points to the science score and finishes the station', () => {
  const terrain = { heightAt: () => 0 };
  const route = new Route(terrain, { points: [[0, -14], [0, -60], [0, -120]], exact: true, areaHazards: [], stations: [{
    id: 'S1', name: 'Test', at: [0, -60], tasks: [{ label: 'Scan', kind: 'scan', minutes: 5, result: 'ok' }, { label: 'Collect core', kind: 'drill', minutes: 5, result: 'ok' }],
  }] });
  const mission = new Mission(route, terrain, { x: 0, y: 0, z: 0 });
  mission.interactiveTasks = true;
  mission.start();
  const drive = { throttle: true, brake: false, steer: 0, action: true, boost: true };
  for (let i = 0; i < 5000 && mission.state !== 'station'; i++) if (!mission.acknowledge()) mission.update(1 / 30, drive, 0);
  expect(mission.state).toBe('station');
  for (let i = 0; i < 200; i++) mission.update(1 / 30, drive, 0);
  expect(mission.activeTask!.done).toBe(false); // holding E no longer does the work
  const [scan, core] = mission.nextStop!.ref.tasks;
  expect(mission.completeTask(core)).toBe(false); // tasks run in order
  expect(mission.completeTask(scan, { grade: 'S', points: 500 })).toBe(true);
  expect(mission.completeTask(core, { grade: 'B', points: 200 })).toBe(true);
  expect(mission.score).toBe(700);
  expect(mission.samples).toBe(1);
  expect(mission.state).toBe('stationDone');
});
