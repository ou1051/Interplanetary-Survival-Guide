import { expect, test } from 'vitest';
import { createMap } from './map.js';

test('labels the supplied site and distinguishes relative relief below the Mars datum', () => {
  const fills = [], labels = [];
  const context = new Proxy({}, { get(target, key) {
    if (key === 'fillRect') return () => fills.push(target.fillStyle);
    if (key === 'fillText') return label => labels.push(label);
    return target[key] ?? (() => {});
  } });
  const canvas = {width: 450, height: 350, getContext: () => context, setAttribute() {}};
  const site = {name: 'Test crop', width: 3, height: 1, cellSizeM: 10, elevationM: [-4400,-4396,null], base: {col: 0,row: 0}, stations: []};
  const draw = createMap(canvas, site, {cells: [site.base]});
  draw({x: 0,z: 0}, 0);
  expect(labels.join(' ')).toContain('Test crop');
  expect(new Set(fills.slice(1,4)).size).toBe(3);
});
