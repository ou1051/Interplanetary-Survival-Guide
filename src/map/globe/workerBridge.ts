// Main-thread side of marsWorker.ts: one worker, promise per job.
import type { ReliefSource } from './demSource';

type Reply = { id: number; heights?: Float32Array; source?: ReliefSource; bitmap?: ImageBitmap; error?: string };

export const workerSupported = () =>
  typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';

class MarsWorker {
  private worker = new Worker(new URL('./marsWorker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: unknown) => void }>();
  private next = 1;
  private users = 0;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
  }

  private send(job: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...job, id }, transfer);
    });
  }

  heightmap(x: number, y: number, level: number) {
    return this.send({ type: 'heightmap', x, y, level }).then((r) => ({ heights: r.heights!, source: r.source ?? 'mola' }));
  }
  paint(x: number, y: number, level: number) {
    return this.send({ type: 'paint', x, y, level }).then((r) => r.bitmap!);
  }
  tint(detail: ImageBitmap, x: number, y: number, level: number, src: { url: string; tileSize: number; blackIsNoData: boolean }) {
    return this.send({ type: 'tint', detail, x, y, level, ...src }, [detail]).then((r) => r.bitmap!);
  }

  acquire() {
    this.users++;
    return this;
  }
  release() {
    if (--this.users > 0) return;
    this.worker.terminate();
    this.pending.forEach((p) => p.reject(new Error('disposed')));
    this.pending.clear();
    if (shared === this) shared = null;
  }
}

let shared: MarsWorker | null = null;
/** The shared worker; call release() when the user (globe, terrain) is destroyed. */
export function marsWorker(): MarsWorker {
  shared ??= new MarsWorker();
  return shared.acquire();
}
export type { MarsWorker };
