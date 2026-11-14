import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAPTERS, TOTAL_DURATION, chapterAt, ease } from './timeline.js';
test('all chapters begin exactly on their boundary and end at landing', () => {
  let elapsed = 0;
  for (const c of CHAPTERS) {
    assert.equal(chapterAt(elapsed).id, c.id);
    assert.equal(chapterAt(elapsed).progress, 0);
    assert.equal(chapterAt(elapsed + c.duration - .001).id, c.id);
    elapsed += c.duration;
  }
  assert.equal(chapterAt(TOTAL_DURATION).complete, true);
  assert.equal(chapterAt(TOTAL_DURATION + 100).progress, 1);
});
test('invalid time cannot poison camera interpolation', () => {
  for (const t of [-1, NaN, Infinity]) assert.equal(chapterAt(t).progress, 0);
  assert.equal(ease(-1), 0); assert.equal(ease(2), 1);
  assert.equal(ease(.5), .5);
});
