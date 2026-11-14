import { expect, test } from 'vitest';
import { summarizeWalk } from './debrief.js';

const site = { walkBudgetSeconds: 300, stations: [{ id: 'ridge', name: 'Ridge' }, { id: 'rock', name: 'Adjacent rock' }] };
const result = { returnedToBase: true, observedStationIds: ['ridge', 'rock'], elapsedSeconds: 300, distanceM: 140 };

test('distinguishes a successful return, a missed station, an over-budget walk, and an early exit', () => {
  expect(summarizeWalk(site, result).title).toBe('Round trip complete');
  const partial = summarizeWalk(site, { ...result, observedStationIds: ['ridge'] });
  expect(partial.title).toBe('Round trip incomplete');
  expect(partial.details).toContain('Adjacent rock');
  expect(summarizeWalk(site, { ...result, elapsedSeconds: 300.1 }).details).toMatch(/budget/);
  expect(summarizeWalk(site, { ...result, returnedToBase: false }).title).toBe('Walk ended before returning to base');
});
