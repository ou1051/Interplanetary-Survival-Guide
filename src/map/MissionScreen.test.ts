// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionScreen } from './MissionScreen';
import type { MapAction } from './contracts';
import { SYNTHETIC_SITE, SYNTHETIC_WINDOWS, initialRun } from './dev/fixture';

let host: HTMLElement;
let screen: MissionScreen;
let actions: MapAction[];

beforeEach(() => {
  document.body.innerHTML = '<div id="h"></div>';
  host = document.getElementById('h')!;
  actions = [];
  screen = new MissionScreen(host, { site: SYNTHETIC_SITE, onAction: (a) => actions.push(a), globe: false, drawMap: false });
  screen.update({ run: { ...initialRun(), turn: 2 }, routes: [], windows: SYNTHETIC_WINDOWS });
});
afterEach(() => screen.destroy());

const $ = (s: string) => host.querySelector(s) as HTMLElement;

describe('map · mission screen', () => {
  it('opens on the globe with the assignment and real-data places', () => {
    expect($('.ms').dataset.view).toBe('globe');
    expect($('.ms-assign h1').textContent).toBe('Ridge and bedrock contact');
    expect($('.ms-where b').textContent).toBe('Vera Rubin Ridge');
    expect($('.ms-fine').textContent).toMatch(/synthetic placeholder/);
    const places = Array.from(host.querySelectorAll('.ms-places b')).map((b) => b.textContent);
    expect(places[0]).toBe('Vera Rubin Ridge');
    expect(places).toContain('Gale Crater');
  });

  it('shows the turn and windows once, in the app bar', () => {
    expect($('.ms-clock .mm-turn b').textContent).toBe('2');
    expect(Array.from(host.querySelectorAll('.ms-clock .mm-wins li')).map((l) => l.className)).toEqual(['soon', 'open', 'open']);
    expect($('.mm').classList.contains('no-clock')).toBe(true);
  });

  it('switches to the site plan and back, with the breadcrumb following', () => {
    $('[data-cmd="open-site"]').click();
    expect($('.ms').dataset.view).toBe('site');
    expect($('.ms-crumbs').textContent).toContain('Site plan');
    expect(($('.ms-site') as HTMLElement & { inert: boolean }).inert).toBe(false);
    expect(($('.ms-globe') as HTMLElement & { inert: boolean }).inert).toBe(true);
    $('.ms-switch [data-view="globe"]').click();
    expect($('.ms').dataset.view).toBe('globe');
  });

  it('the site plan still emits the map actions', () => {
    $('[data-cmd="open-site"]').click();
    ($('[data-act="pin"][data-id="obs-bedrock"]') as HTMLElement).click();
    expect($('.mm-alert').textContent).toBe('Window A will close');
    ($('[data-act="confirm-scout"]') as HTMLElement).click();
    expect(actions).toEqual([{ type: 'scout', observationId: 'obs-bedrock' }]);
  });

  it('imagery, relief and exaggeration controls keep their state', () => {
    $('[data-cmd="style"][data-id="viking"]').click();
    expect($('[data-cmd="style"][data-id="viking"]').getAttribute('aria-checked')).toBe('true');
    expect($('[data-cmd="style"][data-id="best"]').getAttribute('aria-checked')).toBe('false');
    $('[data-cmd="exag"][data-x="3"]').click();
    expect($('[data-cmd="exag"][data-x="3"]').getAttribute('aria-pressed')).toBe('true');
    $('[data-cmd="terrain"]').click();
    expect($('[data-cmd="terrain"]').getAttribute('aria-checked')).toBe('false');
    expect(($('[data-cmd="exag"][data-x="1"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists every data source with its mission and resolution', () => {
    const text = $('.ms-sources').textContent!;
    expect(text).toContain('HiRISE');
    expect(text).toContain('CTX');
    expect(text).toContain('Mars Express HRSC');
    expect(text).toContain('200 m grid');
  });
});
