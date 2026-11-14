import type { MapAction, MapInput, Site } from './contracts';
import { MissionMap } from './MissionMap';
import { clockMarkup } from './clock';
import { IMAGERY, PLACES, SOURCES, TERRAIN, coverageAt, type Place } from './globe/catalog';
import { breadcrumb, formatAltitude, formatHeight, formatLatLon, niceScale, metresPerPixel } from './globe/flight';
import type { CameraInfo, CursorInfo, MarsGlobe } from './globe/MarsGlobe';
import { ICON } from './icons';
import './screen.css';

// ---------------------------------------------------------------------------
// Mission screen = app bar + 3D Mars globe + the site planning map.
//   Globe:     real orbital data on real relief; click anywhere to fly there.
//   Site plan: the MissionMap (scouting, waypoints, routes) for the assignment.
// The globe (CesiumJS) is loaded on demand so the map can be used without it.
// ---------------------------------------------------------------------------

export type View = 'globe' | 'site';

export interface MissionScreenOptions {
  site: Site;
  onAction: (a: MapAction) => void;
  /** Load the 3D globe (false in unit tests / without WebGL). */
  globe?: boolean;
  /** Draw the 2D site map on canvas (false in unit tests: jsdom has no canvas). */
  drawMap?: boolean;
  initialView?: View;
}

const BAR_H = 52;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const EXAGGERATION = [1, 1.5, 3];

export class MissionScreen {
  readonly root: HTMLElement;
  readonly map: MissionMap;
  globe: MarsGlobe | null = null;
  private view: View;
  private input: MapInput | null = null;
  private site: Site;
  private styleId = IMAGERY[0].id;
  private terrainOn = true;
  private exaggeration = 1.5;
  private terrainStatus: 'loading' | 'ready' | 'off' | 'error' = 'loading';
  private cam: CameraInfo | null = null;
  private q: (s: string) => HTMLElement;
  private globeLoad: Promise<void> | null = null;
  private pop: 'style' | 'places' | null = null;

  constructor(container: HTMLElement, private opts: MissionScreenOptions) {
    this.site = opts.site;
    this.view = opts.initialView ?? 'globe';
    this.root = document.createElement('div');
    this.root.className = 'ms';
    this.root.style.setProperty('--bar-h', `${BAR_H}px`);
    this.root.innerHTML = `
      <header class="ms-bar">
        <div class="ms-lead">
        <div class="ms-brand">
          <span class="ms-logo" aria-hidden="true"><svg viewBox="0 0 32 32"><defs><radialGradient id="msl" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#f0a070"/><stop offset=".6" stop-color="#c1673d"/><stop offset="1" stop-color="#6e2f17"/></radialGradient></defs><circle cx="16" cy="16" r="13" fill="url(#msl)"/><path d="M6 19.5c5.6-3 14.4-3 20 0" stroke="#fff3ea" stroke-width="1.6" fill="none" opacity=".7"/></svg></span>
          <span><b>Field Office</b><small>Freelance Astronaut</small></span>
        </div>
        <nav class="ms-crumbs" aria-label="Location"></nav>
        </div>
        <div class="ms-switch" role="tablist" aria-label="View">
          <button role="tab" data-view="globe">${ICON.globe}<span>Globe</span></button>
          <button role="tab" data-view="site">${ICON.grid}<span>Site plan</span></button>
        </div>
        <div class="ms-clock" aria-label="Preparation clock"></div>
      </header>
      <section class="ms-globe" aria-label="3D Mars globe">
        <div class="ms-cesium"></div>
        <div class="ms-ripples" aria-hidden="true"></div>
        <aside class="ms-assign"></aside>
        <div class="ms-tools" role="toolbar" aria-label="Map options">
          <button data-cmd="pop" data-pop="style" aria-haspopup="dialog" aria-expanded="false" title="Imagery and relief">${ICON.layers}<span>Map</span></button>
          <button data-cmd="pop" data-pop="places" aria-haspopup="dialog" aria-expanded="false" title="Places">${ICON.places}<span>Places</span></button>
        </div>
        <aside class="ms-explore" aria-label="Explore Mars" hidden></aside>
        <div class="ms-nav" role="group" aria-label="Camera">
          <button class="ms-compass" data-cmd="north" title="Reset north" aria-label="Reset north"><i></i><span>N</span></button>
          <span class="ms-nav-group">
            <button data-cmd="in" title="Zoom in" aria-label="Zoom in">${ICON.plus}</button>
            <button data-cmd="out" title="Zoom out" aria-label="Zoom out">${ICON.minus}</button>
          </span>
          <button data-cmd="home" title="Whole planet" aria-label="Whole planet">${ICON.globe}</button>
        </div>
        <footer class="ms-status">
          <span class="ms-coord" data-s="coord">—</span>
          <span data-s="elev"><small>Elevation</small> —</span>
          <span data-s="alt"><small>Altitude</small> —</span>
          <span class="ms-scale" data-s="scale"><i></i><em></em></span>
          <span class="ms-detail" data-s="detail"></span>
          <span class="ms-stream" data-s="stream" hidden><b></b>Loading</span>
        </footer>
        <div class="ms-credits" aria-label="Data credits"></div>
        <div class="ms-loading"><div class="ms-spinner"></div><span>Loading Mars…</span></div>
        <div class="ms-banner" role="status" hidden></div>
        <div class="ms-hint">Click anywhere to fly there · Drag to rotate · Scroll to zoom</div>
      </section>
      <section class="ms-site" aria-label="Site plan"></section>`;
    container.appendChild(this.root);
    this.q = (s) => this.root.querySelector(s) as HTMLElement;

    this.map = new MissionMap(this.q('.ms-site'), {
      site: this.site,
      onAction: opts.onAction,
      topInset: BAR_H,
      showClock: false,
      initialTab: 'scout',
      draw: opts.drawMap ?? true,
      deferBackdrop: true, // the globe's data goes first; see prefetch below
    });

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pop) {
        const opener = this.pop;
        this.setPop(null);
        this.focus(`[data-cmd="pop"][data-pop="${opener}"]`);
      }
    });
    this.renderExplore();
    this.setView(this.view, true);
  }

  // ------------------------------------------------------------------ public

  update(input: MapInput): void {
    this.input = input;
    this.map.update(input);
    this.q('.ms-clock').innerHTML = clockMarkup(input.run, input.windows);
    this.renderAssign();
  }

  setView(view: View, initial = false): void {
    this.view = view;
    this.root.dataset.view = view;
    this.root.querySelectorAll<HTMLButtonElement>('.ms-switch button').forEach((b) => {
      const on = b.dataset.view === view;
      b.setAttribute('aria-selected', String(on));
      b.classList.toggle('on', on);
    });
    (this.q('.ms-globe') as HTMLElement).inert = view !== 'globe';
    (this.q('.ms-site') as HTMLElement).inert = view !== 'site';
    if (view === 'globe' && this.opts.globe !== false) void this.ensureGlobe();
    this.globe?.setActive(view === 'globe');
    if (view === 'site') {
      this.map.prefetchBackdrop();
      window.dispatchEvent(new Event('resize')); // let the map re-measure
    }
    this.renderCrumbs();
    if (!initial) this.q(view === 'globe' ? '.ms-switch [data-view="globe"]' : '.ms-switch [data-view="site"]').focus();
  }

  destroy(): void {
    this.globe?.destroy();
    this.map.destroy();
    this.root.remove();
  }

  // ------------------------------------------------------------------ globe

  private ensureGlobe(): Promise<void> {
    if (this.globeLoad) return this.globeLoad;
    this.globeLoad = (async () => {
      try {
        const { MarsGlobe } = await import('./globe/MarsGlobe');
        this.globe = new MarsGlobe(this.q('.ms-cesium'), {
          styleId: this.styleId,
          terrain: this.terrainOn,
          exaggeration: this.exaggeration,
          creditContainer: this.q('.ms-credits'),
          onCursor: (c) => this.onCursor(c),
          onCamera: (c) => this.onCamera(c),
          onFlyStart: (_t, screen) => screen && this.ripple(screen.x, screen.y),
          onTiles: (n) => this.onTiles(n),
          onStatus: (s) => {
            this.terrainStatus = s.terrain;
            this.renderExplore();
            if (s.imageryErrors > 25) this.banner('Some imagery tiles could not be loaded. Check your connection.');
          },
        });
        this.globe.setActive(this.view === 'globe');
        this.root.classList.add('globe-ready');
      } catch (err) {
        console.error('[globe]', err);
        this.root.classList.add('globe-failed');
        this.banner('The 3D globe could not start (WebGL unavailable?). The site plan still works.', true);
      }
    })();
    return this.globeLoad;
  }

  private onCursor(c: CursorInfo | null) {
    const coord = this.q('[data-s="coord"]');
    const elev = this.q('[data-s="elev"]');
    const detail = this.q('[data-s="detail"]');
    if (!c) {
      coord.textContent = '—';
      elev.innerHTML = '<small>Elevation</small> —';
      return;
    }
    coord.textContent = formatLatLon(c.lat, c.lon);
    elev.innerHTML = `<small>Elevation</small> ${formatHeight(c.heightM)}`;
    const style = IMAGERY.find((s) => s.id === this.styleId)!;
    const finest = coverageAt(style, c.lon, c.lat).pop();
    const image = finest ? `${esc(finest.instrument.split(',')[0])} ${esc(finest.resolution.replace(' source', ''))}` : '';
    const relief = c.relief === 'hirise' ? 'HiRISE DTM ~1 m' : c.relief === 'mola' ? 'MOLA/HRSC 200 m' : '';
    detail.innerHTML = image ? `<small>Detail</small> ${image}${relief ? ` · ${relief}` : ''}` : '';
  }

  private onCamera(c: CameraInfo) {
    this.cam = c;
    this.q('[data-s="alt"]').innerHTML = `<small>${c.aboveGround ? 'Above ground' : 'Altitude'}</small> ${formatAltitude(c.altitudeM)}`;
    (this.q('.ms-compass i') as HTMLElement).style.transform = `rotate(${-c.headingDeg}deg)`;
    const mpp = this.globe?.metresPerPixel() ?? metresPerPixel(c.altitudeM, this.root.clientHeight || 800);
    const s = niceScale(mpp, 110);
    const scale = this.q('[data-s="scale"]');
    (scale.querySelector('i') as HTMLElement).style.width = `${Math.round(s.px)}px`;
    (scale.querySelector('em') as HTMLElement).textContent = s.label;
    this.renderCrumbs();
  }

  private onTiles(n: number) {
    const el = this.q('[data-s="stream"]');
    el.hidden = n === 0;
    (el.querySelector('b') as HTMLElement).textContent = String(n);
    if (n === 0 && !this.root.classList.contains('tiles-idle')) {
      this.root.classList.add('tiles-idle');
      // the globe has what it needs: warm up the site plan's imagery in idle time
      const idle = (window as Window & { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
      idle(() => this.map.prefetchBackdrop());
    }
  }

  private ripple(x: number, y: number) {
    const r = document.createElement('i');
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    this.q('.ms-ripples').appendChild(r);
    setTimeout(() => r.remove(), 900);
  }

  private banner(text: string, sticky = false) {
    const b = this.q('.ms-banner');
    b.textContent = text;
    b.hidden = false;
    if (!sticky) setTimeout(() => (b.hidden = true), 6000);
  }

  // ------------------------------------------------------------------ chrome

  private renderCrumbs() {
    const crumbs = this.view === 'site'
      ? ['Mars', 'Gale Crater', 'Vera Rubin Ridge', 'Site plan']
      : this.cam
        ? breadcrumb(PLACES, this.cam)
        : ['Mars'];
    this.q('.ms-crumbs').innerHTML = crumbs.map((c, i) => `<span${i === crumbs.length - 1 ? ' aria-current="location"' : ''}>${esc(c)}</span>`).join(`<i>${ICON.chevron}</i>`);
  }

  private renderAssign() {
    const a = this.site.assignment;
    const place = PLACES.find((p) => p.assignment)!;
    this.q('.ms-assign').innerHTML = `
      <div class="ms-kicker">Field assignment</div>
      <h1>${esc(a?.title ?? 'Assignment')}</h1>
      <p>${esc(a?.question ?? '')}</p>
      <button class="ms-where" data-cmd="fly-site" title="Fly to the site">
        <span class="ms-where-icon">${ICON.places}</span>
        <span><b>${esc(place.name)}</b>${esc(place.note.replace(/^Assignment area · /, ''))}</span>${ICON.locate}
      </button>
      <button class="ms-btn primary" data-cmd="open-site"><span>Plan the walk</span>${ICON.chevron}</button>
      ${this.site.synthetic ? '<p class="ms-fine">Orbital data is real. The planning grid is a synthetic placeholder until the site data pack lands.</p>' : ''}`;
  }

  private renderExplore() {
    const best = (id: string) => {
      const s = IMAGERY.find((x) => x.id === id)!;
      return s.stack[s.stack.length - 1].resolution.replace(' source', '');
    };
    const terrainNote =
      this.terrainStatus === 'loading'
        ? 'Loading elevation…'
        : this.terrainStatus === 'error'
          ? 'Elevation service unreachable'
          : this.terrainOn
            ? `${TERRAIN.resolution}, ${TERRAIN.detail.resolution} where HiRISE DTMs exist`
            : 'Flat sphere';
    const sources = [SOURCES.viking, SOURCES.ctxGlobal, SOURCES.galeCtx, SOURCES.curiosityHirise, SOURCES.jezeroHirise, SOURCES.colorRelief];
    const open = this.pop;
    this.q('.ms-explore').innerHTML = `
      <div class="ms-pane" data-pane="style" ${open === 'style' ? '' : 'hidden'}>
        <section>
          <h2>Imagery</h2>
          <div class="ms-options" role="radiogroup" aria-label="Imagery">
            ${IMAGERY.map(
              (s) => `<button role="radio" aria-checked="${s.id === this.styleId}" class="ms-opt ${s.id === this.styleId ? 'on' : ''}" data-cmd="style" data-id="${s.id}">
                <span class="ms-swatch" data-style="${s.id}"></span>
                <span class="ms-opt-t"><b>${esc(s.name)}</b><small>${esc(s.description)}</small></span><em>${esc(best(s.id))}</em></button>`,
            ).join('')}
          </div>
        </section>
        <section>
          <h2>Relief</h2>
          <button class="ms-toggle" role="switch" aria-checked="${this.terrainOn}" data-cmd="terrain">
            <span class="ms-opt-t"><b>3D terrain</b><small class="${this.terrainStatus === 'error' ? 'err' : ''}">${esc(terrainNote)}</small></span><i></i></button>
          <div class="ms-seg" role="group" aria-label="Vertical exaggeration" ${this.terrainOn ? '' : 'data-disabled'}>
            <span>Exaggeration</span>
            <span class="ms-seg-track">${EXAGGERATION.map((x) => `<button data-cmd="exag" data-x="${x}" aria-pressed="${x === this.exaggeration}" ${this.terrainOn ? '' : 'disabled'}>${x}×</button>`).join('')}</span>
          </div>
        </section>
        <details class="ms-sources">
          <summary>Data sources</summary>
          <ul>${sources.map((s) => `<li><b>${esc(s.instrument)}</b><span>${esc(s.mission)} · ${esc(s.resolution)}</span><small>${esc(s.credit)}</small></li>`).join('')}
            <li><b>Elevation</b><span>${esc(TERRAIN.mission)} · ${esc(TERRAIN.resolution)}</span><small>${esc(TERRAIN.credit)}</small></li>
            <li><b>Elevation detail</b><span>${esc(TERRAIN.detail.mission)} · ${esc(TERRAIN.detail.resolution)}</span><small>${esc(TERRAIN.detail.credit)}</small></li></ul>
        </details>
      </div>
      <div class="ms-pane ms-places" data-pane="places" ${open === 'places' ? '' : 'hidden'}>
        <h2>Places</h2>
        <ul>${PLACES.map(
          (p: Place) => `<li><button data-cmd="place" data-id="${p.id}" class="${p.assignment ? 'assign' : ''}">
            <i>${ICON.places}</i><span><b>${esc(p.name)}</b><small>${esc(p.note)}</small></span>${ICON.chevron}</button></li>`,
        ).join('')}</ul>
      </div>`;
  }

  private setPop(pop: 'style' | 'places' | null) {
    this.pop = pop;
    const panel = this.q('.ms-explore');
    panel.hidden = pop === null;
    panel.dataset.pop = pop ?? '';
    panel.querySelectorAll<HTMLElement>('.ms-pane').forEach((p) => (p.hidden = p.dataset.pane !== pop));
    this.root.querySelectorAll<HTMLElement>('[data-cmd="pop"]').forEach((b) => {
      const on = b.dataset.pop === pop;
      b.setAttribute('aria-expanded', String(on));
      b.classList.toggle('on', on);
    });
  }

  private onClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (this.pop && !target.closest('.ms-explore, [data-cmd="pop"]')) this.setPop(null);
    const v = target.closest<HTMLElement>('.ms-switch [data-view]');
    if (v) return this.setView(v.dataset.view as View);
    const b = target.closest<HTMLElement>('[data-cmd]');
    if (!b || !this.root.contains(b)) return;
    const g = this.globe;
    switch (b.dataset.cmd) {
      case 'pop': {
        const next = b.dataset.pop as 'style' | 'places';
        this.setPop(this.pop === next ? null : next);
        if (this.pop) (this.q('.ms-explore').querySelector(`[data-pane="${next}"] button`) as HTMLElement | null)?.focus();
        break;
      }
      case 'style':
        this.styleId = b.dataset.id!;
        g?.applyStyle(this.styleId);
        this.renderExplore();
        this.focus(`[data-cmd="style"][data-id="${this.styleId}"]`);
        break;
      case 'terrain':
        this.terrainOn = !this.terrainOn;
        this.terrainStatus = this.terrainOn ? 'loading' : 'off';
        void g?.setTerrain(this.terrainOn);
        this.renderExplore();
        this.focus('[data-cmd="terrain"]');
        break;
      case 'exag':
        this.exaggeration = Number(b.dataset.x);
        g?.setExaggeration(this.exaggeration);
        this.renderExplore();
        this.focus(`[data-cmd="exag"][data-x="${this.exaggeration}"]`);
        break;
      case 'place':
        g?.flyToPlace(b.dataset.id!);
        this.setPop(null);
        break;
      case 'fly-site':
        g?.flyToPlace(PLACES.find((p) => p.assignment)!.id);
        break;
      case 'open-site':
        this.setView('site');
        break;
      case 'north':
        g?.resetNorth();
        break;
      case 'in':
        g?.zoom(1);
        break;
      case 'out':
        g?.zoom(-1);
        break;
      case 'home':
        g?.home();
        break;
    }
  }

  private focus(sel: string) {
    (this.root.querySelector(sel) as HTMLElement | null)?.focus();
  }
}
