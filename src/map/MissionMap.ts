import type { Cell, MapAction, MapInput, Observation, Site } from './contracts';
import { cellKey, clampCell, elevationAt, inBounds, isMapped, sameCell, slopeGrid, unreachableStops, type Connectivity, type Stop } from './grid';
import { observationThatChanged, planKey, planStops, routeCards, formatDistance, formatSlope, moveItem, replaceAt } from './compare';
import { previewScout, sourceFor, sourceKind, KIND_LABEL } from './scouting';
import { cellAt, computeView, render, ROUTE_COLORS, type Layers, type Mode, type View } from './render';
import { ICON } from './icons';
import { clockMarkup } from './clock';

// ---------------------------------------------------------------------------
// Mission map & scouting screen (Person 3).
//
//   const map = new MissionMap(el, { site, onAction });
//   map.update({ run, routes, windows, clock });   // whenever game state changes
//
// The map never mutates game state. It emits MapAction and waits for the next
// update(); game flow (Person 6) owns turns, revisions and approval.
// ---------------------------------------------------------------------------

export interface MissionMapOptions {
  site: Site;
  onAction: (action: MapAction) => void;
  /** Draw on a 2D canvas (false in unit tests: jsdom has no canvas). */
  draw?: boolean;
  initialTab?: Tab;
  maxWaypoints?: number;
  /** Neighbour rule used to explain unreachable stops; match the planner (default 8). */
  connectivity?: Connectivity;
  /** Show the turn/window clock (false when a host app bar already shows it). */
  showClock?: boolean;
  /** Pixels reserved at the top by a host app bar. */
  topInset?: number;
}

type Tab = 'scout' | 'plan';
type Dialog = { kind: 'confirm'; obsId: string } | { kind: 'viewer'; obsId: string } | null;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class MissionMap {
  readonly root: HTMLElement;
  private site: Site;
  private slopes: (number | null)[];
  private opts: Required<Omit<MissionMapOptions, 'site' | 'onAction'>> & Pick<MissionMapOptions, 'onAction'>;
  private input: MapInput | null = null;
  private layers: Layers = { imagery: true, slope: false, evidence: true };
  private mode: Mode = { kind: 'select' };
  private tab: Tab;
  private hover: Cell | null = null;
  private cursor: Cell | null = null;
  private showCursor = false;
  private focusCell: Cell | null = null;
  private dialog: Dialog = null;
  private dialogReturnFocus: HTMLElement | null = null;
  private pendingReveal: string | null = null;
  private changedBy: string | null = null;
  private snapshot: { routes: MapInput['routes']; revealed: string[]; planKey: string } | null = null;
  private unreachable: Stop[] = [];
  private jobCollapsed = false;
  private drag: { index: number; moved: boolean } | null = null;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private view: View | null = null;
  private texture: HTMLImageElement | null = null;
  private raf = 0;
  private ro: ResizeObserver | null = null;
  private toastTimer = 0;
  private disposers: (() => void)[] = [];

  private el: Record<'job' | 'clock' | 'layers' | 'panel' | 'legend' | 'tip' | 'modal' | 'toast' | 'live' | 'stage', HTMLElement>;

  constructor(container: HTMLElement, options: MissionMapOptions) {
    this.site = options.site;
    this.slopes = slopeGrid(this.site);
    this.opts = { draw: options.draw ?? true, initialTab: options.initialTab ?? 'scout', maxWaypoints: options.maxWaypoints ?? 6, connectivity: options.connectivity ?? 8, showClock: options.showClock ?? true, topInset: options.topInset ?? 0, onAction: options.onAction };
    this.tab = this.opts.initialTab;
    // small screens: start with the assignment folded so the map stays visible
    this.jobCollapsed = typeof window !== 'undefined' && window.innerWidth <= 900 && window.innerWidth > 0 && this.opts.draw;

    this.root = document.createElement('div');
    this.root.className = 'mm';
    this.root.innerHTML = `
      <div class="mm-stage">
        <canvas class="mm-canvas" tabindex="0" role="application"
          aria-label="Mission map. Arrow keys move the cell cursor, Enter selects, Escape cancels."></canvas>
        <div class="mm-tip" hidden></div>
      </div>
      <header class="mm-job"></header>
      <div class="mm-clock" aria-label="Preparation clock"></div>
      <nav class="mm-layers" aria-label="Map layers"></nav>
      <div class="mm-legend"></div>
      <aside class="mm-panel" aria-label="Scouting and route planning"></aside>
      <div class="mm-modal" hidden></div>
      <div class="mm-toast" role="status" aria-live="polite"></div>
      <div class="mm-sr" aria-live="polite"></div>`;
    this.root.style.setProperty('--mm-top', `${this.opts.topInset}px`);
    if (!this.opts.showClock) this.root.classList.add('no-clock');
    container.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.el = {
      stage: q('.mm-stage'),
      job: q('.mm-job'),
      clock: q('.mm-clock'),
      layers: q('.mm-layers'),
      panel: q('.mm-panel'),
      legend: q('.mm-legend'),
      tip: q('.mm-tip'),
      modal: q('.mm-modal'),
      toast: q('.mm-toast'),
      live: q('.mm-sr'),
    };
    this.canvas = q('.mm-canvas') as HTMLCanvasElement;
    if (this.opts.draw) this.ctx = this.canvas.getContext('2d');
    this.loadTexture();
    this.bind();
    this.renderLayers();
    this.renderLegend();
  }

  // ------------------------------------------------------------------ public

  update(input: MapInput): void {
    const prevPlanKey = this.input ? planKey(this.input.run) : null;
    this.input = input;
    const key = planKey(input.run);
    const next = { routes: input.routes, revealed: input.run.revealedObservationIds.slice(), planKey: key };
    const changed = observationThatChanged(this.snapshot, next);
    if (changed) this.changedBy = changed;
    else if (prevPlanKey !== null && prevPlanKey !== key) this.changedBy = null;
    if (!input.routesPending) this.snapshot = next;

    this.unreachable = !input.routes.length && !input.routesPending ? unreachableStops(this.site, planStops(this.site, input.run), this.opts.connectivity) : [];

    if (this.pendingReveal && input.run.revealedObservationIds.includes(this.pendingReveal)) {
      const id = this.pendingReveal;
      this.pendingReveal = null;
      this.toast(`Observation received · Turn ${input.run.turn}`);
      this.openDialog({ kind: 'viewer', obsId: id });
    }
    if (this.mode.kind === 'move' && this.mode.index >= input.run.waypoints.length) this.mode = { kind: 'select' };

    this.renderJob();
    this.renderClock();
    this.renderPanel();
    this.renderLegend();
    if (this.dialog?.kind === 'confirm') {
      this.renderDialog();
      this.el.modal.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    this.relayout();
  }

  /** Resize the canvas only when the free area around the cards changed. */
  private lastArea = '';
  private relayout() {
    const r = this.el.stage.getBoundingClientRect();
    const area = JSON.stringify([Math.round(r.width), Math.round(r.height), this.freeArea(r.width, r.height)]);
    if (area !== this.lastArea) this.resize();
    else this.draw();
  }

  /** Swap in a new site (e.g. when Person 1's real data replaces the fixture). */
  setSite(site: Site): void {
    this.site = site;
    this.slopes = slopeGrid(site);
    this.snapshot = null;
    this.changedBy = null;
    this.loadTexture();
    if (this.input) this.update(this.input);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.disposers.forEach((d) => d());
    this.root.remove();
  }

  // ------------------------------------------------------------------ actions

  private emit(a: MapAction) {
    this.opts.onAction(a);
  }

  private get run() {
    return this.input!.run;
  }

  private obs(id: string): Observation | undefined {
    return this.site.observations.find((o) => o.id === id);
  }

  private requestScout(o: Observation) {
    if (!this.input) return;
    if (this.run.revealedObservationIds.includes(o.id)) this.openDialog({ kind: 'viewer', obsId: o.id });
    else this.openDialog({ kind: 'confirm', obsId: o.id });
  }

  private confirmScout(id: string) {
    this.pendingReveal = id;
    this.closeDialog(false);
    this.announce('Requesting observation');
    this.emit({ type: 'scout', observationId: id });
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    if (mode.kind !== 'select') {
      this.showCursor = true;
      if (mode.kind === 'move') this.cursor = { ...this.run.waypoints[mode.index] };
      else this.cursor = this.cursor ?? { ...this.site.base };
      this.canvas.focus();
      this.announce(mode.kind === 'add' ? 'Choose a cell for the new waypoint' : `Choose a new cell for waypoint ${mode.index + 1}`);
    }
    this.renderPanel();
    this.renderLegend();
    this.canvas.classList.toggle('placing', mode.kind !== 'select');
    this.draw();
  }

  /** Validate and place a waypoint (new when index === null). */
  private placeWaypoint(cell: Cell, index: number | null): boolean {
    const run = this.run;
    const why = this.waypointProblem(cell, index);
    if (why) {
      this.toast(why, 'warn');
      return false;
    }
    const list = index === null ? [...run.waypoints, { ...cell }] : replaceAt(run.waypoints, index, cell);
    this.emit({ type: 'setWaypoints', waypoints: list });
    this.mode = { kind: 'select' };
    this.canvas.classList.remove('placing');
    this.announce(index === null ? `Waypoint ${list.length} added` : `Waypoint ${index + 1} moved`);
    return true;
  }

  waypointProblem(cell: Cell, index: number | null): string | null {
    const run = this.run;
    if (!inBounds(this.site, cell)) return 'Outside the mapped area';
    if (!isMapped(this.site, cell)) return 'No terrain data in this cell';
    if (sameCell(cell, this.site.base)) return 'That is the base';
    if (this.site.stations.some((s) => sameCell(s.cell, cell))) return 'A science station is already there';
    if (run.waypoints.some((w, i) => i !== index && sameCell(w, cell))) return 'There is already a waypoint there';
    if (index === null && run.waypoints.length >= this.opts.maxWaypoints) return `Up to ${this.opts.maxWaypoints} waypoints`;
    return null;
  }

  private activateCell(cell: Cell) {
    if (!this.input) return;
    if (this.mode.kind === 'add') return void this.placeWaypoint(cell, null);
    if (this.mode.kind === 'move') return void this.placeWaypoint(cell, this.mode.index);
    const pin = this.site.observations.find((o) => sameCell(o.cell, cell));
    if (pin) return this.requestScout(pin);
    const wi = this.run.waypoints.findIndex((w) => sameCell(w, cell));
    if (wi >= 0) {
      this.tab = 'plan';
      return this.setMode({ kind: 'move', index: wi });
    }
    const st = this.site.stations.find((s) => sameCell(s.cell, cell));
    if (st) return this.toast(`${st.name} · ${st.task ?? 'Science station'}`);
    if (sameCell(cell, this.site.base)) return this.toast('Base camp (fictional placement)');
  }

  // ------------------------------------------------------------------ events

  private bind() {
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: any) => void, opt?: AddEventListenerOptions) => {
      t.addEventListener(type, fn, opt);
      this.disposers.push(() => t.removeEventListener(type, fn, opt));
    };

    // delegated clicks for every button in the overlay UI
    on(this.root, 'click', (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b || !this.root.contains(b) || (b as HTMLButtonElement).disabled) return;
      this.onAct(b.dataset.act!, b.dataset);
    });

    const pos = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return this.view ? cellAt(this.view, this.site, e.clientX - r.left, e.clientY - r.top) : null;
    };
    on(this.canvas, 'pointermove', (e: PointerEvent) => {
      const c = pos(e);
      if (!sameCell(c, this.hover)) {
        this.hover = c;
        this.updateTip(e);
        this.draw();
      } else this.updateTip(e);
      if (this.drag && c) this.drag.moved = this.drag.moved || !sameCell(c, this.run.waypoints[this.drag.index]);
    });
    on(this.canvas, 'pointerleave', () => {
      this.hover = null;
      this.el.tip.hidden = true;
      this.draw();
    });
    on(this.canvas, 'pointerdown', (e: PointerEvent) => {
      const c = pos(e);
      this.showCursor = false;
      if (!c || !this.input || this.mode.kind !== 'select') return;
      const wi = this.run.waypoints.findIndex((w) => sameCell(w, c));
      if (wi >= 0) {
        this.drag = { index: wi, moved: false };
        this.canvas.setPointerCapture?.(e.pointerId);
      }
    });
    on(this.canvas, 'pointerup', (e: PointerEvent) => {
      const c = pos(e);
      const drag = this.drag;
      this.drag = null;
      if (!c) return;
      if (drag && drag.moved) {
        this.placeWaypoint(c, drag.index);
        return;
      }
      if (drag) {
        this.tab = 'plan';
        this.setMode({ kind: 'move', index: drag.index });
        return;
      }
      this.activateCell(c);
    });

    on(this.canvas, 'focus', () => {
      this.showCursor = true;
      this.cursor = this.cursor ?? { ...this.site.base };
      this.draw();
    });
    on(this.canvas, 'blur', () => {
      this.showCursor = false;
      this.draw();
    });
    on(this.canvas, 'keydown', (e: KeyboardEvent) => this.onCanvasKey(e));

    on(this.root, 'keydown', (e: KeyboardEvent) => {
      if (this.dialog) return this.onDialogKey(e);
      if (e.key === 'Escape' && this.mode.kind !== 'select') {
        e.preventDefault();
        this.setMode({ kind: 'select' });
        this.announce('Cancelled');
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.el.stage);
    }
    on(window, 'resize', () => this.resize());
    this.resize();
  }

  private onCanvasKey(e: KeyboardEvent) {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dc, dr] = moves[e.key];
      const base = this.cursor ?? this.site.base;
      this.cursor = clampCell(this.site, { col: base.col + dc, row: base.row + dr });
      this.showCursor = true;
      this.announce(this.describeCell(this.cursor));
      this.draw();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && this.cursor) {
      e.preventDefault();
      this.activateCell(this.cursor);
      return;
    }
    const layerKey: Record<string, keyof Layers> = { '1': 'imagery', '2': 'slope', '3': 'evidence' };
    if (layerKey[e.key]) {
      e.preventDefault();
      this.toggleLayer(layerKey[e.key]);
    }
  }

  private onAct(act: string, d: DOMStringMap) {
    const run = this.input?.run;
    switch (act) {
      case 'tab':
        this.tab = d.tab as Tab;
        this.renderPanel();
        this.focusKey(`tab:${this.tab}`);
        break;
      case 'layer':
        this.toggleLayer(d.layer as keyof Layers);
        this.focusKey(`layer:${d.layer}`);
        break;
      case 'job':
        this.jobCollapsed = !this.jobCollapsed;
        this.renderJob();
        this.relayout();
        this.focusKey('job');
        break;
      case 'pin': {
        const o = this.obs(d.id!);
        if (o) {
          this.focusCell = { ...o.cell };
          this.draw();
          this.requestScout(o);
        }
        break;
      }
      case 'locate': {
        const c = { col: Number(d.col), row: Number(d.row) };
        this.focusCell = c;
        this.cursor = { ...c };
        this.showCursor = true;
        this.canvas.focus();
        this.announce(this.describeCell(c));
        this.draw();
        break;
      }
      case 'confirm-scout':
        this.confirmScout(d.id!);
        break;
      case 'close-dialog':
        this.closeDialog(true);
        break;
      case 'view':
        this.openDialog({ kind: 'viewer', obsId: d.id! });
        break;
      case 'station-up':
      case 'station-down': {
        if (!run) break;
        const i = Number(d.index);
        const order = moveItem(run.stationOrder, i, act === 'station-up' ? i - 1 : i + 1);
        this.emit({ type: 'setStationOrder', stationIds: order });
        const j = act === 'station-up' ? i - 1 : i + 1;
        this.focusKey(`${act}:${j}`, `${act === 'station-up' ? 'station-down' : 'station-up'}:${j}`);
        break;
      }
      case 'wp-add':
        this.setMode(this.mode.kind === 'add' ? { kind: 'select' } : { kind: 'add' });
        break;
      case 'wp-move':
        this.setMode({ kind: 'move', index: Number(d.index) });
        break;
      case 'wp-up':
      case 'wp-down': {
        if (!run) break;
        const i = Number(d.index);
        const j = act === 'wp-up' ? i - 1 : i + 1;
        this.emit({ type: 'setWaypoints', waypoints: moveItem(run.waypoints, i, j) });
        this.focusKey(`${act}:${j}`, `${act === 'wp-up' ? 'wp-down' : 'wp-up'}:${j}`, `wp-move:${j}`);
        break;
      }
      case 'wp-remove': {
        if (!run) break;
        const i = Number(d.index);
        this.emit({ type: 'setWaypoints', waypoints: run.waypoints.filter((_, k) => k !== i) });
        this.announce(`Waypoint ${i + 1} removed`);
        this.focusKey(`wp-remove:${Math.min(i, run.waypoints.length - 2)}`, 'wp-add');
        break;
      }
      case 'route':
        if (run && d.id !== run.selectedRouteId) this.emit({ type: 'chooseRoute', routeId: d.id! });
        this.focusKey(`route:${d.id}`);
        break;
      case 'rehearse':
        if (run?.selectedRouteId && this.input!.routes.some((r) => r.id === run.selectedRouteId)) {
          this.emit({ type: 'startRehearsal', routeId: run.selectedRouteId, planRevision: run.planRevision });
        }
        break;
      case 'show-on-map': {
        const o = this.obs(d.id!);
        this.closeDialog(false);
        if (o) {
          this.layers.evidence = true;
          this.renderLayers();
          this.renderLegend();
          this.onAct('locate', { col: String(o.cell.col), row: String(o.cell.row) } as DOMStringMap);
        }
        break;
      }
    }
  }

  private toggleLayer(k: keyof Layers) {
    this.layers[k] = !this.layers[k];
    this.renderLayers();
    this.renderLegend();
    this.draw();
    this.announce(`${k === 'imagery' ? 'Orbital imagery' : k === 'slope' ? 'Terrain slope' : 'Rover evidence'} ${this.layers[k] ? 'on' : 'off'}`);
  }

  // ------------------------------------------------------------------ dialog

  private openDialog(d: NonNullable<Dialog>) {
    if (!this.dialog) this.dialogReturnFocus = document.activeElement as HTMLElement | null;
    this.dialog = d;
    this.renderDialog();
    const target = this.el.modal.querySelector<HTMLElement>('[data-autofocus]') ?? this.el.modal.querySelector<HTMLElement>('button');
    target?.focus();
  }

  private closeDialog(restoreFocus: boolean) {
    this.dialog = null;
    this.el.modal.hidden = true;
    this.el.modal.innerHTML = '';
    if (restoreFocus && this.dialogReturnFocus?.isConnected) this.dialogReturnFocus.focus();
    else if (restoreFocus) this.canvas.focus();
    this.dialogReturnFocus = null;
  }

  private onDialogKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeDialog(true);
      return;
    }
    if (e.key === 'Tab') {
      const items = Array.from(this.el.modal.querySelectorAll<HTMLElement>('button, a[href]'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  private renderDialog() {
    const d = this.dialog;
    if (!d || !this.input) return;
    const o = this.obs(d.obsId);
    if (!o) return;
    const m = this.el.modal;
    m.hidden = false;
    const title = esc(o.title ?? o.id);
    if (d.kind === 'confirm') {
      const p = previewScout(o, this.run, this.input.windows, this.input.clock);
      const closes = p.closes.map((w) => esc(w.label)).join(', ');
      m.innerHTML = `
        <div class="mm-scrim" data-act="close-dialog"></div>
        <section class="mm-sheet mm-confirm" role="dialog" aria-modal="true" aria-labelledby="mm-dlg-title">
          <div class="mm-kicker">Request observation</div>
          <h2 id="mm-dlg-title">${title}</h2>
          <div class="mm-cost">
            <div class="mm-cost-n">${p.cost}</div>
            <div><b>preparation turn</b><span>Turn ${p.turnNow} → ${p.turnAfter}</span></div>
          </div>
          ${
            p.closes.length
              ? `<p class="mm-alert ${p.closesLast ? 'danger' : 'warn'}">${p.closesLast ? 'Closes the last open window' : `${closes} will close`}</p>`
              : `<p class="mm-alert ok">No departure window closes</p>`
          }
          <div class="mm-actions">
            <button class="mm-btn ghost" data-act="close-dialog">Not now</button>
            <button class="mm-btn primary" data-act="confirm-scout" data-id="${esc(o.id)}" data-autofocus>Request</button>
          </div>
        </section>`;
      return;
    }
    const src = sourceFor(this.site, o);
    const kind = sourceKind(this.site, src, 'archived');
    const facts = src
      ? [src.mission, src.productId, src.scale, src.date].filter(Boolean).map((t) => `<span>${esc(String(t))}</span>`).join('')
      : '<span>Source not recorded</span>';
    m.innerHTML = `
      <div class="mm-scrim" data-act="close-dialog"></div>
      <section class="mm-sheet mm-viewer" role="dialog" aria-modal="true" aria-labelledby="mm-dlg-title">
        <figure><img src="${esc(o.imageUrl)}" alt="${esc(o.caption)}" /></figure>
        <div class="mm-viewer-body">
          <span class="mm-kind ${kind}">${KIND_LABEL[kind]}</span>
          <h2 id="mm-dlg-title">${title}</h2>
          <p class="mm-caption">${esc(o.caption)}</p>
          <div class="mm-facts">${facts}</div>
          ${src?.processingNote ? `<p class="mm-note">${esc(src.processingNote)}</p>` : ''}
          ${src?.url ? `<a class="mm-link" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${ICON.external}<span>Source product</span></a>` : ''}
          <p class="mm-free">Characterises ${o.characterizedCells.length} cell${o.characterizedCells.length === 1 ? '' : 's'} · reopening is free</p>
          <div class="mm-actions">
            <button class="mm-btn ghost" data-act="show-on-map" data-id="${esc(o.id)}">${ICON.target}<span>Show on map</span></button>
            <button class="mm-btn primary" data-act="close-dialog" data-autofocus>Done</button>
          </div>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------------ overlay UI

  private renderJob() {
    const a = this.site.assignment;
    const run = this.input?.run;
    const done = (id: string) =>
      !!run?.latestRehearsal && run.latestRehearsal.planRevision === run.planRevision && run.latestRehearsal.observedStationIds.includes(id);
    const synthetic = this.site.synthetic ? '<span class="mm-tag">Synthetic fixture</span>' : '';
    this.el.job.classList.toggle('collapsed', this.jobCollapsed);
    this.el.job.innerHTML = `
      <button class="mm-job-toggle" data-act="job" data-key="job" aria-expanded="${!this.jobCollapsed}">
        <span class="mm-kicker">Field assignment</span>${synthetic}${ICON.chevron}
      </button>
      ${
        this.jobCollapsed
          ? ''
          : `<h1>${esc(a?.title ?? this.site.name ?? 'Assignment')}</h1>
             <p>${esc(a?.question ?? 'Record both science stations and return to base.')}</p>
             <ul class="mm-stations">${this.site.stations
               .map(
                 (s, i) => `<li class="${done(s.id) ? 'done' : ''}"><span class="mm-dia">${i + 1}</span>${esc(s.name)}</li>`,
               )
               .join('')}</ul>`
      }`;
  }

  private renderClock() {
    if (!this.input || !this.opts.showClock) return;
    this.el.clock.innerHTML = clockMarkup(this.input.run, this.input.windows);
  }

  private renderLayers() {
    const item = (k: keyof Layers, icon: string, name: string, key: string) =>
      `<button class="mm-layer ${this.layers[k] ? 'on' : ''}" data-act="layer" data-layer="${k}" data-key="layer:${k}" aria-pressed="${this.layers[k]}" title="${name} (${key})">
        ${icon}<span>${name}</span></button>`;
    this.el.layers.innerHTML =
      item('imagery', ICON.imagery, 'Imagery', '1') + item('slope', ICON.slope, 'Slope', '2') + item('evidence', ICON.evidence, 'Evidence', '3');
  }

  private renderLegend() {
    const parts: string[] = [];
    if (this.mode.kind !== 'select') {
      parts.push(`<span class="mm-hint">${this.mode.kind === 'add' ? 'Click a cell to add a waypoint' : `Click a cell to move waypoint ${this.mode.index + 1}`} · Esc to cancel</span>`);
    } else {
      if (this.layers.slope) {
        parts.push('<span><i class="sw" style="background:#4cc980"></i>&lt; 5°</span>');
        parts.push('<span><i class="sw" style="background:#f2b25c"></i>5–15°</span>');
        parts.push('<span><i class="sw" style="background:#ff6b5b"></i>&gt; 15°</span>');
      }
      if (this.layers.evidence) parts.push('<span><i class="sw ev"></i>Scouted</span>');
      if (this.site.elevationM.some((e) => e === null)) parts.push('<span><i class="sw nodata"></i>No data</span>');
      const t = this.site.sources.find((s) => s.id === this.site.terrainSourceId);
      const kind = sourceKind(this.site, t, 'derived');
      parts.push(`<span class="mm-src">${KIND_LABEL[kind]}${t && !this.site.synthetic ? ` · ${esc(t.mission)} ${esc(t.scale)}` : ''} · ${this.site.cellSizeM} m cells</span>`);
    }
    this.el.legend.innerHTML = parts.join('');
  }

  private renderPanel() {
    if (!this.input) return;
    const active = document.activeElement as HTMLElement | null;
    const key = active && this.el.panel.contains(active) ? active.dataset.key : undefined;
    const tabs = (['scout', 'plan'] as Tab[])
      .map(
        (t) =>
          `<button role="tab" class="mm-tab ${this.tab === t ? 'on' : ''}" aria-selected="${this.tab === t}" data-act="tab" data-tab="${t}" data-key="tab:${t}">
            <span class="n">${t === 'scout' ? 1 : 2}</span>${t === 'scout' ? 'Scout' : 'Plan'}</button>`,
      )
      .join('');
    this.el.panel.innerHTML = `
      <div class="mm-tabs" role="tablist">${tabs}</div>
      <div class="mm-pane" role="tabpanel">${this.tab === 'scout' ? this.scoutPane() : this.planPane()}</div>
      ${this.tab === 'plan' ? this.planFooter() : ''}`;
    if (key) this.focusKey(key);
  }

  private scoutPane(): string {
    const run = this.run;
    const pins = this.site.observations
      .map((o) => {
        const seen = run.revealedObservationIds.includes(o.id);
        return `<li><button class="mm-row" data-act="pin" data-id="${esc(o.id)}" data-key="pin:${esc(o.id)}">
          <span class="mm-pin ${seen ? 'seen' : ''}"></span>
          <span class="mm-row-t">${esc(o.title ?? o.id)}</span>
          <span class="mm-row-m">${seen ? 'Seen' : '1 turn'}</span></button></li>`;
      })
      .join('');
    const stations = this.site.stations
      .map(
        (s, i) => `<li><button class="mm-row" data-act="locate" data-col="${s.cell.col}" data-row="${s.cell.row}" data-key="st:${esc(s.id)}">
          <span class="mm-dia sm">${i + 1}</span><span class="mm-row-t">${esc(s.name)}</span>
          <span class="mm-row-m">${ICON.target}</span></button></li>`,
      )
      .join('');
    const seen = run.revealedObservationIds.length;
    return `
      <p class="mm-lede">Each new rover observation costs one preparation turn. ${seen ? `${seen} of ${this.site.observations.length} scouted.` : 'Pick a pin to start.'}</p>
      <h3 class="mm-h">Observations</h3>
      <ul class="mm-list">${pins}</ul>
      <h3 class="mm-h">Science stations</h3>
      <ul class="mm-list">${stations}</ul>`;
  }

  private planPane(): string {
    const run = this.run;
    const input = this.input!;
    const stations = run.stationOrder
      .map((id, i) => {
        const s = this.site.stations.find((x) => x.id === id);
        if (!s) return '';
        return `<li class="mm-stop">
          <span class="mm-dia sm">${i + 1}</span><span class="mm-row-t">${esc(s.name)}</span>
          <span class="mm-ctl">
            <button class="mm-icon" data-act="station-up" data-index="${i}" data-key="station-up:${i}" ${i === 0 ? 'disabled' : ''} aria-label="Visit ${esc(s.name)} earlier">${ICON.up}</button>
            <button class="mm-icon" data-act="station-down" data-index="${i}" data-key="station-down:${i}" ${i === run.stationOrder.length - 1 ? 'disabled' : ''} aria-label="Visit ${esc(s.name)} later">${ICON.down}</button>
          </span></li>`;
      })
      .join('');
    const wps = run.waypoints
      .map((w, i) => {
        const moving = this.mode.kind === 'move' && this.mode.index === i;
        return `<li class="mm-stop ${moving ? 'moving' : ''}">
          <span class="mm-wp">${i + 1}</span><span class="mm-row-t">Waypoint <small>${w.col}, ${w.row}</small></span>
          <span class="mm-ctl">
            <button class="mm-icon" data-act="wp-move" data-index="${i}" data-key="wp-move:${i}" aria-label="Move waypoint ${i + 1}">${ICON.move}</button>
            <button class="mm-icon" data-act="wp-up" data-index="${i}" data-key="wp-up:${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move waypoint ${i + 1} earlier">${ICON.up}</button>
            <button class="mm-icon" data-act="wp-down" data-index="${i}" data-key="wp-down:${i}" ${i === run.waypoints.length - 1 ? 'disabled' : ''} aria-label="Move waypoint ${i + 1} later">${ICON.down}</button>
            <button class="mm-icon" data-act="wp-remove" data-index="${i}" data-key="wp-remove:${i}" aria-label="Remove waypoint ${i + 1}">${ICON.close}</button>
          </span></li>`;
      })
      .join('');
    const adding = this.mode.kind === 'add';
    return `
      <h3 class="mm-h">Stations <small>visit order</small></h3>
      <ul class="mm-list">${stations}</ul>
      <h3 class="mm-h">Waypoints <small>optional</small></h3>
      ${wps ? `<ul class="mm-list">${wps}</ul>` : ''}
      <button class="mm-btn ghost wide ${adding ? 'active' : ''}" data-act="wp-add" data-key="wp-add" aria-pressed="${adding}">
        ${ICON.plus}<span>${adding ? 'Choose a cell…' : 'Add waypoint'}</span></button>
      <h3 class="mm-h">Routes</h3>
      ${this.routesBlock(input)}`;
  }

  private routesBlock(input: MapInput): string {
    if (input.routesPending) return '<div class="mm-empty"><div class="mm-spin"></div><b>Planning routes…</b></div>';
    if (!input.routes.length) {
      if (this.unreachable.length) {
        const names = this.unreachable.map((u) => esc(u.label));
        return `<div class="mm-empty danger" role="alert">
          <b>${names.join(' and ')} can’t be reached</b>
          <span>No mapped path from base. Move or remove the stop.</span>
          <div class="mm-chips">${this.unreachable
            .map((u) => `<button class="mm-chip" data-act="locate" data-col="${u.cell.col}" data-row="${u.cell.row}" data-key="unreach:${esc(u.id)}">${ICON.target}${esc(u.label)}</button>`)
            .join('')}</div></div>`;
      }
      return '<div class="mm-empty"><b>No route options</b><span>The planner returned nothing for this plan.</span></div>';
    }
    const cards = routeCards(input.routes, input.run.selectedRouteId);
    const metric = (v: string, label: string, best: boolean) => `<div class="${best ? 'best' : ''}"><b>${v}</b><small>${label}</small></div>`;
    const html = cards
      .map((c, i) => {
        const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
        return `<button class="mm-route ${c.selected ? 'on' : ''}" role="radio" aria-checked="${c.selected}" data-act="route" data-id="${esc(c.id)}" data-key="route:${esc(c.id)}" style="--route:${color}">
          <span class="mm-route-head"><i class="mm-swatch"></i><span>${esc(c.label)}</span>${c.selected ? '<em>Selected</em>' : ''}</span>
          <span class="mm-metrics">
            ${metric(formatDistance(c.distanceM), 'distance', c.best.distance)}
            ${metric(formatSlope(c.maxSlopeDeg), 'max slope', c.best.slope)}
            ${metric(formatDistance(c.limitedM), 'low coverage', c.best.coverage)}
          </span>
          ${c.comparison ? `<span class="mm-cmp">${esc(c.comparison)}</span>` : ''}</button>`;
      })
      .join('');
    const single = cards.length === 1 ? '<p class="mm-note">Both planning policies agree on this path.</p>' : '';
    const changedObs = this.changedBy ? this.obs(this.changedBy) : null;
    const changed = changedObs
      ? `<p class="mm-note accent">Updated after scouting <button class="mm-inline" data-act="view" data-id="${esc(changedObs.id)}" data-key="changed">${esc(changedObs.title ?? changedObs.id)}</button></p>`
      : '';
    return `<div class="mm-routes" role="radiogroup" aria-label="Route options">${html}</div>${single}${changed}`;
  }

  private planFooter(): string {
    const run = this.run;
    const selected = this.input!.routes.some((r) => r.id === run.selectedRouteId);
    const last = run.latestRehearsal;
    let status = '<span class="mm-status">Not rehearsed</span>';
    if (run.surfaceApproved) status = '<span class="mm-status ok">Approved</span>';
    else if (last && last.planRevision === run.planRevision) status = '<span class="mm-status warn">Rehearsal incomplete</span>';
    else if (last) status = '<span class="mm-status warn">Plan changed · rehearse again</span>';
    return `<footer class="mm-foot">
      ${status}
      <button class="mm-btn primary" data-act="rehearse" data-key="rehearse" ${selected ? '' : 'disabled'}>
        ${ICON.play}<span>${selected ? 'Rehearse route' : 'Choose a route'}</span></button>
    </footer>`;
  }

  // ------------------------------------------------------------------ helpers

  /** Focus the first enabled element among the given data-key values. */
  private focusKey(...keys: string[]) {
    for (const key of keys) {
      const el = this.root.querySelector<HTMLElement>(`[data-key="${key.replace(/["\\]/g, '\\$&')}"]`);
      if (el && !(el as HTMLButtonElement).disabled) {
        el.focus();
        return;
      }
    }
  }

  private describeCell(c: Cell): string {
    const e = elevationAt(this.site, c);
    const parts = [`Cell ${c.col}, ${c.row}`];
    if (e === null) parts.push('no terrain data');
    else {
      parts.push(`${e.toFixed(1)} m`);
      const s = this.slopes[c.row * this.site.width + c.col];
      if (s !== null) parts.push(`slope ${s.toFixed(1)}°`);
    }
    const pin = this.site.observations.find((o) => sameCell(o.cell, c));
    if (pin) parts.push(`observation ${pin.title ?? pin.id}`);
    const st = this.site.stations.find((s) => sameCell(s.cell, c));
    if (st) parts.push(`station ${st.name}`);
    if (sameCell(c, this.site.base)) parts.push('base');
    return parts.join(' · ');
  }

  private updateTip(e: PointerEvent) {
    const tip = this.el.tip;
    if (!this.hover || this.drag) {
      tip.hidden = true;
      return;
    }
    const c = this.hover;
    const elev = elevationAt(this.site, c);
    const s = this.slopes[c.row * this.site.width + c.col];
    tip.innerHTML = elev === null ? '<b>No data</b>' : `<b>${elev.toFixed(1)} m</b>${s !== null ? `<span>${s.toFixed(1)}°</span>` : ''}`;
    const r = this.el.stage.getBoundingClientRect();
    tip.style.transform = `translate(${e.clientX - r.left + 14}px, ${e.clientY - r.top + 14}px)`;
    tip.hidden = false;
  }

  private toast(text: string, tone: 'info' | 'warn' = 'info') {
    const t = this.el.toast;
    t.textContent = text;
    t.className = `mm-toast show ${tone}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.className = 'mm-toast'), 2600);
  }

  private announce(text: string) {
    this.el.live.textContent = text;
  }

  // ------------------------------------------------------------------ canvas

  private loadTexture() {
    this.texture = null;
    if (!this.opts.draw || !this.site.textureUrl) return;
    const img = new Image();
    img.onload = () => this.draw();
    img.src = this.site.textureUrl;
    this.texture = img;
  }

  private resize() {
    const r = this.el.stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const free = this.freeArea(w, h);
    this.lastArea = JSON.stringify([w, h, free]);
    this.view = computeView(this.site, w, h, free);
    this.draw();
  }

  /** Padding that keeps the grid clear of the floating cards (measured, not guessed). */
  private freeArea(w: number, h: number) {
    const root = this.root.getBoundingClientRect();
    const rect = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - root.left, t: r.top - root.top, r: r.right - root.left, b: r.bottom - root.top, w: r.width, h: r.height };
    };
    const job = rect(this.el.job);
    const rail = rect(this.el.layers);
    const panel = rect(this.el.panel);
    const clock = rect(this.el.clock);
    if (!panel.w || !job.w) return { l: 24, r: 24, t: 24, b: 24 };
    const sheet = panel.t > h * 0.3; // narrow layout: panel is a bottom sheet
    if (sheet) {
      return { l: 12, r: 12, t: job.b + 12, b: h - Math.min(panel.t, rail.t || panel.t, clock.t || panel.t) + 12 };
    }
    return { l: Math.max(24, rail.r + 20), r: Math.max(24, w - panel.l + 24), t: Math.max(job.b, clock.b) + 20, b: 64 };
  }

  private draw() {
    if (!this.ctx || !this.view || !this.input) return;
    cancelAnimationFrame(this.raf);
    const frame = (t: number) => {
      const g = this.ctx!;
      const dpr = this.canvas.width / Math.max(1, this.view!.w);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      render(g, this.view!, {
        site: this.site,
        slopes: this.slopes,
        run: this.input!.run,
        routes: this.input!.routes,
        layers: this.layers,
        texture: this.texture,
        hover: this.hover,
        cursor: this.cursor,
        showCursor: this.showCursor,
        mode: this.mode,
        unreachable: this.unreachable,
        focusCell: this.focusCell,
        time: t / 1000,
      });
      if (this.unreachable.length) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
}

export { cellKey };
