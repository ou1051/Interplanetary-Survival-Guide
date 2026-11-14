import { MissionScreen } from '../index';
import type { MapAction, RoutePlan, Run, Site } from '../contracts';
import { standInClock } from '../scouting';
import { SYNTHETIC_SITE, SYNTHETIC_SITE_BARRIER, SYNTHETIC_WINDOWS, initialRun } from './fixture';
import { standInPlanRoutes } from './standinPlanner';

// ---------------------------------------------------------------------------
// Demo harness for the map module. A STAND-IN for game flow (Person 6):
// it applies the agreed rules just enough to click through the screen.
//   - scouting a new observation adds one turn; reopening is free
//   - any edit to waypoints, station order or chosen route bumps the plan
//     revision and clears surface approval
//   - "Rehearse route" pretends the sandbox (Person 4) returned a pass
// ---------------------------------------------------------------------------

// Variant via #gap (works on static hosts and sandboxed previews); ?fixture=gap also accepted.
const wantsGap = () => location.hash === '#gap' || new URLSearchParams(location.search).get('fixture') === 'gap';
let site: Site = wantsGap() ? SYNTHETIC_SITE_BARRIER : SYNTHETIC_SITE;
let run: Run = initialRun(site);
let routes: RoutePlan[] = [];

const host = document.getElementById('map')!;
const screen = new MissionScreen(host, { site, onAction, initialView: location.hash === '#site' || wantsGap() ? 'site' : 'globe' });
const map = screen.map;

function replan() {
  routes = standInPlanRoutes(site, run.waypoints, run.stationOrder, run.revealedObservationIds);
  if (run.selectedRouteId && !routes.some((r) => r.id === run.selectedRouteId)) run.selectedRouteId = null;
}

function editPlan(patch: Partial<Run>) {
  run = { ...run, ...patch, planRevision: run.planRevision + 1, surfaceApproved: false };
}

function onAction(a: MapAction) {
  console.info('[map action]', a);
  switch (a.type) {
    case 'scout':
      if (!run.revealedObservationIds.includes(a.observationId)) {
        run = { ...run, turn: run.turn + 1, revealedObservationIds: [...run.revealedObservationIds, a.observationId] };
        replan();
      }
      break;
    case 'setWaypoints':
      editPlan({ waypoints: a.waypoints });
      replan();
      break;
    case 'setStationOrder':
      editPlan({ stationOrder: a.stationIds });
      replan();
      break;
    case 'chooseRoute':
      editPlan({ selectedRouteId: a.routeId });
      break;
    case 'startRehearsal':
      run = {
        ...run,
        latestRehearsal: {
          planRevision: a.planRevision,
          windowId: 'win-b',
          visibility: 'clear',
          observedStationIds: run.stationOrder.slice(),
          returnedToBase: true,
          elapsedSeconds: 240,
          distanceWalkedM: routes.find((r) => r.id === a.routeId)?.distanceM ?? 0,
        },
        surfaceApproved: true,
      };
      break;
  }
  push();
}

function push() {
  screen.update({ run, routes, windows: SYNTHETIC_WINDOWS, clock: standInClock(run.turn, SYNTHETIC_WINDOWS) });
}

// tiny dev switch: fixture variant + reset
const dev = document.getElementById('dev')!;
// developer switch only when asked for: map.html#dev (or #gap)
if (/dev|gap/.test(location.hash)) dev.style.display = 'flex';
dev.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b) return;
  if (b.dataset.fixture) {
    location.hash = b.dataset.fixture === 'gap' ? 'gap' : '';
  } else if (b.dataset.reset !== undefined) {
    run = initialRun(site);
    replan();
    push();
  }
});
dev.querySelectorAll<HTMLButtonElement>('[data-fixture]').forEach((b) =>
  b.classList.toggle('on', (b.dataset.fixture === 'gap') === (site === SYNTHETIC_SITE_BARRIER)),
);

window.addEventListener('hashchange', () => {
  const next = wantsGap() ? SYNTHETIC_SITE_BARRIER : SYNTHETIC_SITE;
  if (next === site) return;
  site = next;
  map.setSite(site);
  run = initialRun(site);
  replan();
  push();
  dev.querySelectorAll<HTMLButtonElement>('[data-fixture]').forEach((b) => b.classList.toggle('on', (b.dataset.fixture === 'gap') === (site === SYNTHETIC_SITE_BARRIER)));
});

replan();
push();
(window as unknown as { __map: unknown }).__map = { map, screen, get run() { return run; }, get routes() { return routes; }, onAction };
