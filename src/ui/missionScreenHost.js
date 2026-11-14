import { MissionScreen } from '../map/index.ts';
import { ROUTE_OPTIONS, SCOUT_PINS } from '../config/mission.js';
import { estimateRoute } from '../sim/routeApi.js';
import { attachSiteOverlay, toLonLat } from './siteGlobe.js';
import { makeGrid, buildSite, buildRoutePlans, buildMapInput, applyMapAction } from './missionAdapter.js';

// ---------------------------------------------------------------------------
// The mission map screen of the Freelance Astronaut flow: the map module's
// MissionScreen (globe + site plan, src/map) driven by this flow's Game.
// Same surface as the Planner it replaces: show(), hide(), render(), visible.
// ---------------------------------------------------------------------------

export class MissionMapScreen {
  constructor({ container, game, routes, terrain, bounds, snapshot, onRehearse, onDesk }) {
    Object.assign(this, { container, game, routes, terrain, snapshot, onRehearse, onDesk });
    this.grid = makeGrid(bounds);
    this.estimates = new WeakMap();
    this.overlay = null;
    this.screen = null; // built on first show(): the globe needs a visible, sized container
  }

  build() {
    // Ground views are rendered once from the rehearsal terrain (shown only after scouting).
    const snapshots = Object.fromEntries(SCOUT_PINS.map((p) => [p.id, this.snapshot(p)]));
    this.site = buildSite({ grid: this.grid, heightAt: (x, z) => this.terrain.heightAt(x, z), toLonLat, snapshots });
    this.screen = new MissionScreen(this.container, {
      site: this.site,
      onAction: (a) => this.onAction(a),
      planEditing: false, // the flow's route options fix waypoints and station order
      planLabel: 'Plan the traverse',
      onGlobeReady: (globe) => this.attachOverlay(globe),
    });
    this.screen.root.style.zIndex = '20';
  }

  get visible() {
    return !this.container.classList.contains('hidden');
  }

  show() {
    this.container.classList.remove('hidden');
    if (!this.screen) this.build();
    this.render();
    this.screen.globe?.setActive(this.screen.root.dataset.view === 'globe');
  }

  hide() {
    this.container.classList.add('hidden');
    this.screen?.globe?.setActive(false);
  }

  estimate(r) {
    if (!this.estimates.has(r)) this.estimates.set(r, estimateRoute(r));
    return this.estimates.get(r);
  }

  render() {
    if (!this.screen) return;
    const plans = buildRoutePlans({
      grid: this.grid,
      routes: this.routes,
      options: ROUTE_OPTIONS,
      revealed: this.game.run.revealed,
      estimate: (r) => this.estimate(r),
    });
    this.screen.update(buildMapInput({ game: this.game, plans }));
    this.drawOverlay();
  }

  onAction(a) {
    const next = applyMapAction(a, { game: this.game, routes: this.routes, options: ROUTE_OPTIONS });
    if (next === 'rehearse') this.onRehearse();
    else if (next === 'desk') this.onDesk();
    else this.render();
  }

  async attachOverlay(globe) {
    this.overlay = await attachSiteOverlay(globe, {
      // a scouting site clicked on the globe opens it in the site plan
      onPin: (id) => {
        this.screen.setView('site');
        this.screen.map.openObservation(id);
      },
    });
    this.drawOverlay();
  }

  drawOverlay() {
    if (!this.overlay) return;
    const run = this.game.run;
    const known = new Set(SCOUT_PINS.filter((p) => run.revealed.includes(p.id)).flatMap((p) => p.reveals));
    this.overlay.update({ routes: this.routes, selectedId: run.routeId, revealed: run.revealed, selectedPin: null, knownHazardIds: known });
  }
}
