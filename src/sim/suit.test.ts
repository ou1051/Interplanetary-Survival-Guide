import { describe, expect, it } from 'vitest';
import { defaultSuit, predict, suitMass, SUIT } from './suit.js';

const route = { oxygen_cost: 2, battery_drain: 10, hazard_warnings: [] as string[] };

describe('planning board model', () => {
  it('adds layer mass to the base suit', () => {
    expect(suitMass({ insulation: 0, shielding: 0, abrasion: 0 })).toBe(SUIT.baseMassKg);
    expect(suitMass({ insulation: 10, shielding: 0, abrasion: 0 })).toBeCloseTo(SUIT.baseMassKg + 6);
  });

  it('heavier suits use more oxygen', () => {
    const light = predict(route, { insulation: 3, shielding: 0, abrasion: 0 });
    const heavy = predict(route, { insulation: 12, shielding: 20, abrasion: 100 });
    expect(heavy.o2.used).toBeGreaterThan(light.o2.used);
  });

  it('shielding lowers the dose and a radiation spike raises it', () => {
    const thin = predict(route, { ...defaultSuit(), shielding: 0 });
    const thick = predict(route, { ...defaultSuit(), shielding: 20 });
    expect(thick.dose.usv).toBeCloseTo(thin.dose.usv / 4);
    const spike = predict({ ...route, hazard_warnings: ['Radiation Spike'] }, defaultSuit());
    expect(spike.dose.usv).toBeGreaterThan(predict(route, defaultSuit()).dose.usv);
  });

  it('gives GO, CAUTION and NO-GO', () => {
    expect(predict(route, defaultSuit(), 60).verdict).toBe('GO');
    expect(predict({ ...route, hazard_warnings: ['Radiation Spike'] }, defaultSuit(), 60).verdict).toBe('CAUTION');
    expect(predict(route, defaultSuit(), 600).verdict).toBe('NO-GO');
    expect(predict(null, defaultSuit()).verdict).toBe('NO ROUTE');
  });

  it('warns about thin abrasion on loose regolith', () => {
    const p = predict({ ...route, hazard_warnings: ['Loose Regolith'] }, { ...defaultSuit(), abrasion: 0 });
    expect(p.warnings.map((w) => w.text).join()).toMatch(/regolith/i);
  });

  it('a suit that protects against the hazard turns it into GO', () => {
    const spike = { ...route, hazard_warnings: ['Radiation Spike'] };
    const shielded = predict(spike, { ...defaultSuit(), shielding: 18 });
    expect(shielded.verdict).toBe('GO');
    expect(shielded.covered[0]).toMatch(/radiation/i);
  });
});
