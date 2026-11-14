// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissionMap } from './MissionMap';
import type { MapAction, MapInput, RoutePlan, Run, Site } from './contracts';
import { SYNTHETIC_SITE as SITE, SYNTHETIC_SITE_BARRIER as GAP, SYNTHETIC_WINDOWS as WINS, initialRun } from './dev/fixture';
import { standInClock } from './scouting';

// Saved example planner outputs (Person 2's planner is not needed for these tests).
const SHORT: RoutePlan = {
  id: 'route-distance', policy: 'distance', distanceM: 141.4, maxSegmentSlopeDeg: 21.8, limitedCoverageM: 141.4,
  stationIds: ['st-ridge', 'st-rock'], comparison: 'Fewest metres from base and back.',
  cells: [{ col: 1, row: 3 }, { col: 4, row: 3 }, { col: 7, row: 2 }, { col: 7, row: 4 }, { col: 1, row: 3 }],
};
const GENTLE: RoutePlan = {
  id: 'route-terrain', policy: 'terrain', distanceM: 171.4, maxSegmentSlopeDeg: 0, limitedCoverageM: 151.4,
  stationIds: ['st-ridge', 'st-rock'], comparison: 'Avoids steep steps and unscouted cells where it can.',
  cells: [{ col: 1, row: 3 }, { col: 4, row: 1 }, { col: 7, row: 2 }, { col: 7, row: 4 }, { col: 4, row: 5 }, { col: 1, row: 3 }],
};

let host: HTMLElement;
let actions: MapAction[];
let map: MissionMap;

function mount(site: Site = SITE) {
  map = new MissionMap(host, { site, onAction: (a) => actions.push(a), draw: false });
  return map;
}
function input(run: Run, routes: RoutePlan[] = [SHORT, GENTLE]): MapInput {
  return { run, routes, windows: WINS, clock: standInClock(run.turn, WINS) };
}
const $ = (sel: string) => host.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[];
const click = (el: Element | null) => (el as HTMLElement).click();
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const text = () => host.textContent!.replace(/\s+/g, ' ');

beforeEach(() => {
  document.body.innerHTML = '<div id="h"></div>';
  host = document.getElementById('h')!;
  actions = [];
});
afterEach(() => map?.destroy());

describe('map · job card and clock', () => {
  it('opens on the assignment with both stations and a synthetic label', () => {
    mount().update(input(initialRun()));
    expect($('.mm-job h1').textContent).toBe('Ridge and bedrock contact');
    expect($$('.mm-stations li').map((l) => l.textContent!.trim())).toEqual(['1Ridge', '2Bedrock']);
    expect($('.mm-tag').textContent).toMatch(/synthetic/i);
  });
  it('shows the turn and which windows are open, closing or closed', () => {
    mount().update(input({ ...initialRun(), turn: 4 }));
    expect($('.mm-turn b').textContent).toBe('4');
    expect($$('.mm-wins li').map((l) => l.className)).toEqual(['closed', 'soon', 'open']);
  });
});

describe('map · scouting', () => {
  it('previews the cost, emits scout on confirm, then reveals image, caption and source', () => {
    mount().update(input(initialRun()));
    click($('[data-act="pin"][data-id="obs-ridge-view"]'));
    expect($('.mm-confirm')).toBeTruthy();
    expect($('.mm-cost-n').textContent).toBe('1');
    expect($('.mm-cost span').textContent).toBe('Turn 0 → 1');
    expect($('.mm-alert').textContent).toBe('No departure window closes');
    expect(actions).toEqual([]);

    click($('[data-act="confirm-scout"]'));
    expect(actions).toEqual([{ type: 'scout', observationId: 'obs-ridge-view' }]);
    expect($('.mm-modal').hidden).toBe(true);

    // game flow applies the turn and reveals the observation
    map.update(input({ ...initialRun(), turn: 1, revealedObservationIds: ['obs-ridge-view'] }));
    const img = $('.mm-viewer img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(SITE.observations[0].imageUrl);
    expect($('.mm-caption').textContent).toBe(SITE.observations[0].caption);
    expect($('.mm-kind').textContent).toBe('Synthetic placeholder');
    expect($('.mm-facts').textContent).toContain('DEV-SKETCH-A');
    expect($('.mm-toast').textContent).toBe('Observation received · Turn 1');
  });

  it('reopening a scouted pin is free and shows the same image', () => {
    mount().update(input({ ...initialRun(), turn: 1, revealedObservationIds: ['obs-ridge-view'] }));
    click($('[data-act="pin"][data-id="obs-ridge-view"]'));
    expect($('.mm-confirm')).toBeNull();
    expect(($('.mm-viewer img') as HTMLImageElement).getAttribute('src')).toBe(SITE.observations[0].imageUrl);
    expect(actions).toEqual([]);
    expect($('.mm-turn b').textContent).toBe('1');
    expect($('[data-act="pin"][data-id="obs-ridge-view"] .mm-row-m').textContent).toBe('Seen');
  });

  it('names the exact window that would close', () => {
    mount().update(input({ ...initialRun(), turn: 2 }));
    click($('[data-act="pin"][data-id="obs-bedrock"]'));
    expect($('.mm-alert').textContent).toBe('Window A will close');
    expect($('.mm-alert').classList.contains('warn')).toBe(true);
  });

  it('warns when the request would use up the last opportunity', () => {
    mount().update(input({ ...initialRun(), turn: 6 }));
    click($('[data-act="pin"][data-id="obs-bedrock"]'));
    expect($('.mm-alert').textContent).toBe('Closes the last open window');
    expect($('.mm-alert').classList.contains('danger')).toBe(true);
  });

  it('Escape closes the dialog without spending a turn and returns focus', () => {
    mount().update(input(initialRun()));
    const row = $('[data-act="pin"][data-id="obs-rise"]');
    row.focus();
    click(row);
    key($('.mm-confirm'), 'Escape');
    expect($('.mm-modal').hidden).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(actions).toEqual([]);
  });

  it('the camera position is distinguished from the pictured feature', () => {
    const withCamera = SITE.observations.filter((o) => o.cameraCell);
    expect(withCamera.length).toBeGreaterThan(0);
    for (const o of withCamera) expect(o.cameraCell).not.toEqual(o.cell);
  });
});

describe('map · planning', () => {
  const planRun = (patch: Partial<Run> = {}) => ({ ...initialRun(), ...patch });
  beforeEach(() => {
    mount();
  });
  const openPlan = (run: Run, routes?: RoutePlan[]) => {
    map.update(input(run, routes));
    click($('[data-act="tab"][data-tab="plan"]'));
  };

  it('shows both route options with the three measures, and selecting emits chooseRoute', () => {
    openPlan(planRun());
    const cards = $$('.mm-route');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('141 m');
    expect(cards[0].textContent).toContain('21.8°');
    expect(cards[1].textContent).toContain('151 m');
    expect(cards.map((c) => c.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    click(cards[1]);
    expect(actions).toEqual([{ type: 'chooseRoute', routeId: 'route-terrain' }]);
  });

  it('works with a single route', () => {
    openPlan(planRun(), [SHORT]);
    expect($$('.mm-route')).toHaveLength(1);
    expect(text()).toContain('Both planning policies agree on this path.');
  });

  it('rehearsal needs a chosen route and carries the plan revision', () => {
    openPlan(planRun());
    expect(($('[data-act="rehearse"]') as HTMLButtonElement).disabled).toBe(true);
    map.update(input(planRun({ selectedRouteId: 'route-terrain', planRevision: 3 })));
    const btn = $('[data-act="rehearse"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    click(btn);
    expect(actions).toEqual([{ type: 'startRehearsal', routeId: 'route-terrain', planRevision: 3 }]);
  });

  it('a stale selection (route no longer offered) cannot be rehearsed', () => {
    openPlan(planRun({ selectedRouteId: 'gone' }));
    expect(($('[data-act="rehearse"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks rehearsal while selected routes are being recalculated', () => {
    const run = planRun({ selectedRouteId: 'route-terrain', planRevision: 4 });
    openPlan(run);
    map.update({ ...input(run), routesPending: true });
    expect(text()).toContain('Planning routes…');
    const btn = $('[data-act="rehearse"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    click(btn);
    expect(actions).toEqual([]);
    map.update(input(run));
    expect(($('[data-act="rehearse"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the approval state for the current revision', () => {
    const rehearsal = { planRevision: 2, windowId: 'win-b', visibility: 'clear' as const, observedStationIds: ['st-ridge'], returnedToBase: true, elapsedSeconds: 200, distanceWalkedM: 120 };
    openPlan(planRun({ planRevision: 2, latestRehearsal: rehearsal }));
    expect($('.mm-status').textContent).toBe('Rehearsal incomplete');
    map.update(input(planRun({ planRevision: 3, latestRehearsal: rehearsal })));
    expect($('.mm-status').textContent).toBe('Plan changed · rehearse again');
    map.update(input(planRun({ planRevision: 3, surfaceApproved: true })));
    expect($('.mm-status').textContent).toBe('Approved');
  });

  it('reorders stations', () => {
    openPlan(planRun());
    click($('[data-act="station-down"][data-index="0"]'));
    expect(actions).toEqual([{ type: 'setStationOrder', stationIds: ['st-rock', 'st-ridge'] }]);
  });

  it('adds a waypoint with the keyboard only', () => {
    openPlan(planRun());
    click($('[data-act="wp-add"]'));
    const canvas = $('.mm-canvas');
    expect(document.activeElement).toBe(canvas);
    key(canvas, 'ArrowUp'); // cursor starts at base (1,3)
    key(canvas, 'ArrowUp');
    key(canvas, 'ArrowRight');
    key(canvas, 'Enter');
    expect(actions).toEqual([{ type: 'setWaypoints', waypoints: [{ col: 2, row: 1 }] }]);
  });

  it('refuses a waypoint on base, a station or a duplicate, and lists it otherwise', () => {
    openPlan(planRun({ waypoints: [{ col: 3, row: 1 }] }));
    expect(map.waypointProblem({ col: 1, row: 3 }, null)).toBe('That is the base');
    expect(map.waypointProblem({ col: 7, row: 2 }, null)).toMatch(/station/);
    expect(map.waypointProblem({ col: 3, row: 1 }, null)).toMatch(/already a waypoint/);
    expect(map.waypointProblem({ col: 3, row: 1 }, 0)).toBeNull(); // moving onto itself is fine
    expect($$('.mm-stop .mm-wp')).toHaveLength(1);
  });

  it('moves and removes waypoints', () => {
    openPlan(planRun({ waypoints: [{ col: 3, row: 1 }, { col: 3, row: 5 }] }));
    click($('[data-act="wp-up"][data-index="1"]'));
    expect(actions.pop()).toEqual({ type: 'setWaypoints', waypoints: [{ col: 3, row: 5 }, { col: 3, row: 1 }] });
    click($('[data-act="wp-remove"][data-index="0"]'));
    expect(actions.pop()).toEqual({ type: 'setWaypoints', waypoints: [{ col: 3, row: 5 }] });
    click($('[data-act="wp-move"][data-index="0"]'));
    const canvas = $('.mm-canvas');
    key(canvas, 'ArrowLeft'); // from (3,1) → (2,1)
    key(canvas, 'Enter');
    expect(actions.pop()).toEqual({ type: 'setWaypoints', waypoints: [{ col: 2, row: 1 }, { col: 3, row: 5 }] });
  });

  it.each(['add', 'move'] as const)('clears %s mode after a synchronous waypoint update', (mode) => {
    map.destroy();
    let run = planRun({ waypoints: mode === 'move' ? [{ col: 3, row: 1 }] : [] });
    map = new MissionMap(host, {
      site: SITE, draw: false,
      onAction: (action) => {
        actions.push(action);
        if (action.type === 'setWaypoints') {
          run = { ...run, waypoints: action.waypoints };
          map.update(input(run));
        }
      },
    });
    openPlan(run);
    click($(`[data-act="wp-${mode}"]`));
    const canvas = $('.mm-canvas');
    key(canvas, mode === 'add' ? 'ArrowUp' : 'ArrowLeft');
    key(canvas, 'Enter');
    expect(actions).toHaveLength(1);
    expect(run.waypoints).toEqual([mode === 'add' ? { col: 1, row: 2 } : { col: 2, row: 1 }]);
    expect($('[data-act="wp-add"]').getAttribute('aria-pressed')).toBe('false');
    expect($('[data-act="wp-add"]').textContent).toContain('Add waypoint');
    expect($('.mm-stop.moving')).toBeNull();
    expect($('.mm-legend').textContent).not.toMatch(/Click a cell/);
    expect(canvas.classList.contains('placing')).toBe(false);
  });

  it('Escape cancels waypoint placement', () => {
    openPlan(planRun());
    click($('[data-act="wp-add"]'));
    key($('.mm-canvas'), 'Escape');
    key($('.mm-canvas'), 'Enter'); // now in select mode on the base cell
    expect(actions.filter((a) => a.type === 'setWaypoints')).toEqual([]);
  });

  it('names the observation that changed the comparison, and forgets it after a plan edit', () => {
    openPlan(planRun());
    const changed = { ...GENTLE, limitedCoverageM: 111.4 };
    map.update(input(planRun({ turn: 1, revealedObservationIds: ['obs-rise'] }), [SHORT, changed]));
    expect($('.mm-note.accent').textContent).toContain('Rise crossing');
    map.update(input(planRun({ turn: 1, revealedObservationIds: ['obs-rise'], waypoints: [{ col: 2, row: 1 }] }), [SHORT, changed]));
    expect($('.mm-note.accent')).toBeNull();
  });
});

describe('map · unreachable stops', () => {
  it('shows a clear empty state naming the stops beyond missing data', () => {
    mount(GAP);
    map.update(input(initialRun(GAP), []));
    click($('[data-act="tab"][data-tab="plan"]'));
    const empty = $('.mm-empty.danger');
    expect(empty.getAttribute('role')).toBe('alert');
    expect(empty.textContent).toContain('Ridge and Bedrock can’t be reached');
    expect($$('.mm-chip').map((c) => c.textContent!.trim())).toEqual(['Ridge', 'Bedrock']);
    expect(($('[data-act="rehearse"]') as HTMLButtonElement).disabled).toBe(true);
  });
  it('without a disconnected stop, says the planner returned nothing', () => {
    mount();
    map.update(input(initialRun(), []));
    click($('[data-act="tab"][data-tab="plan"]'));
    expect($('.mm-empty').textContent).toContain('No route options');
  });
  it('refuses to place a waypoint on missing data', () => {
    mount(GAP);
    map.update(input(initialRun(GAP), []));
    expect(map.waypointProblem({ col: 5, row: 3 }, null)).toBe('No terrain data in this cell');
  });
});

describe('map · layers', () => {
  it('toggles layers by button and by number keys on the map', () => {
    mount().update(input(initialRun()));
    const slope = $('[data-layer="slope"]');
    expect(slope.getAttribute('aria-pressed')).toBe('false');
    click(slope);
    expect($('[data-layer="slope"]').getAttribute('aria-pressed')).toBe('true');
    expect($('.mm-legend').textContent).toContain('5–15°');
    key($('.mm-canvas'), '1');
    expect($('[data-layer="imagery"]').getAttribute('aria-pressed')).toBe('false');
  });
});
