/// <reference lib="webworker" />
// Off-main-thread Mars relief: fetch + LERC decode + resample, one message per
// display tile. Heights come back as a transferred Float32Array (no copy).
import Lerc from 'lerc';
import { createDemSampler, fetchLerc } from './demSource';

export interface DemRequest {
  id: number;
  x: number;
  y: number;
  level: number;
}

const sampler = createDemSampler({
  fetchTile: fetchLerc,
  decode: (buf) => {
    const d = Lerc.decode(buf);
    return { pixels: d.pixels[0], width: d.width, height: d.height, mask: d.mask ?? null };
  },
});

self.onmessage = async (e: MessageEvent<DemRequest>) => {
  const { id, x, y, level } = e.data;
  try {
    const r = await sampler.heightmap(x, y, level);
    (self as unknown as Worker).postMessage({ id, heights: r.heights, source: r.source }, [r.heights.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
