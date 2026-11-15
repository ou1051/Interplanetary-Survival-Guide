import { describe, expect, it } from 'vitest';
import { MARS_SITES_DATA, buildSiteSandboxPlan } from '../src/data/siteDatasets.js';

describe('site station display data', () => {
  it('supplies objective and rationale for rover displays on every site', () => {
    for (const site of MARS_SITES_DATA) {
      const { traverse } = buildSiteSandboxPlan(site, {});
      for (const station of traverse.route.stations.filter((s) => !s.final)) {
        expect(station.objective).toBeTruthy();
        expect(station.why[0]).toEqual(expect.any(String));
      }
    }
  });
});
