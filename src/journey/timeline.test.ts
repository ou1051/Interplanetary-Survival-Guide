import { describe, it, expect } from 'vitest';
import { chapterAt, DURATION, smooth } from './timeline.js';
describe('journey progression', () => {
  it('keeps departure, transfer and arrival in order at exact boundaries', () => {
    expect([0,8.99,9,26.99,27,DURATION].map(chapterAt)).toEqual([1,1,2,2,3,4]);
  });
  it('clamps camera interpolation to the trajectory endpoints', () => {
    expect(smooth(-1)).toBe(0);
    expect(smooth(2)).toBe(1);
    expect(smooth(.5)).toBe(.5);
  });
});
