import './siteTopology.css';

// ---------------------------------------------------------------------------
// Site Topology Module:
//   1) Interactive 3D-shaded Mars Globe with 5 candidate landing sites.
//      - Top-left card shows the selected site's Name, coordinates, and Preview Picture.
//      - Left / Right Arrow keys switch the selected site and smoothly rotate the globe.
//      - Clicking a site or pressing Enter zooms in to the Topography Assessment UI.
//   2) Zoomed-in Site Topography UI (powered by jezero_crater.tif pipeline assets):
//      - Toggleable features: Heights (Elevation), Steepness (Slopes/Hitches), Craters.
//      - Live cursor inspection of elevation, slope degrees, crater depth, and cost.
//      - Path selection + "Deploy Rover to 3D Surface" handoff into the 3D rover sandbox.
// ---------------------------------------------------------------------------

export const MARS_SITES = [
  {
    id: 'jezero',
    code: 'SITE 01',
    name: 'Jezero Crater · River Delta',
    coords: '18.38° N, 77.58° E',
    lat: 18.38,
    lon: 77.58,
    summary: 'Western braided river delta & ancient lakebed deposits. High biosignature potential.',
    previewFilter: 'none',
    defaultApproach: 'intermediate',
  },
  {
    id: 'gale',
    code: 'SITE 02',
    name: 'Gale Crater · Vera Rubin Ridge',
    coords: '5.40° S, 137.80° E',
    lat: -5.40,
    lon: 137.80,
    summary: 'Hematite-bearing layered ridge at the base of Aeolis Mons (Mount Sharp).',
    previewFilter: 'hue-rotate(-14deg) saturate(1.15)',
    defaultApproach: 'intermediate',
  },
  {
    id: 'valles',
    code: 'SITE 03',
    name: 'Valles Marineris · Candor Chasma',
    coords: '6.50° S, 289.20° E',
    lat: -6.50,
    lon: 289.20,
    summary: 'Deep tectonic canyon floor with steep fault scarps and layered sulfate mesas.',
    previewFilter: 'hue-rotate(18deg) contrast(1.1)',
    defaultApproach: 'longer',
  },
  {
    id: 'olympus',
    code: 'SITE 04',
    name: 'Olympus Mons · Caldera Flank',
    coords: '18.65° N, 226.20° E',
    lat: 18.65,
    lon: 226.20,
    summary: 'Basaltic shield volcano aureole, lava tubes, and steep basal scarp hitches.',
    previewFilter: 'hue-rotate(-28deg) contrast(1.12)',
    defaultApproach: 'shortest',
  },
  {
    id: 'hellas',
    code: 'SITE 05',
    name: 'Hellas Planitia · Dao Vallis',
    coords: '42.40° S, 70.50° E',
    lat: -42.40,
    lon: 70.50,
    summary: 'Deepest impact basin on Mars with ancient glaciated outflow channels.',
    previewFilter: 'hue-rotate(32deg) saturate(1.08)',
    defaultApproach: 'intermediate',
  },
];

export const TOPO_PATHS = [
  {
    id: 'shortest',
    name: 'Direct / Shortest Path',
    distance: '1.56 km',
    maxSlope: '16.4°',
    color: '#ff9e64',
    note: 'Crosses moderate delta slope hitches; fastest transit time.',
    points: [
      [0.52, 0.78],
      [0.44, 0.63],
      [0.35, 0.48],
      [0.42, 0.34],
      [0.58, 0.28],
      [0.72, 0.42],
      [0.66, 0.62],
      [0.52, 0.78],
    ],
  },
  {
    id: 'intermediate',
    name: 'Recommended Balanced Loop',
    distance: '1.80 km',
    maxSlope: '11.8°',
    color: '#73e8ff',
    note: 'Skirts deep craters and steep scarps while visiting all 4 stations.',
    points: [
      [0.52, 0.78],
      [0.39, 0.68],
      [0.29, 0.52],
      [0.36, 0.32],
      [0.56, 0.24],
      [0.74, 0.38],
      [0.70, 0.60],
      [0.52, 0.78],
    ],
  },
  {
    id: 'longer',
    name: 'Low-Gradient Safe Detour',
    distance: '2.09 km',
    maxSlope: '8.9°',
    color: '#c49bff',
    note: 'Wide berth around western delta cliffs and deep impact depressions.',
    points: [
      [0.52, 0.78],
      [0.33, 0.74],
      [0.22, 0.56],
      [0.31, 0.28],
      [0.55, 0.20],
      [0.78, 0.35],
      [0.74, 0.62],
      [0.52, 0.78],
    ],
  },
];

function layerImageFilename(heights, steepness, craters) {
  if (heights && steepness && craters) return './jezero/combined.png';
  if (heights && steepness && !craters) return './jezero/heights_steepness.png';
  if (heights && !steepness && craters) return './jezero/heights_craters.png';
  if (!heights && steepness && craters) return './jezero/steepness_craters.png';
  if (heights && !steepness && !craters) return './jezero/heights.png';
  if (!heights && steepness && !craters) return './jezero/steepness.png';
  if (!heights && !steepness && craters) return './jezero/craters.png';
  return './jezero/base.png';
}

export class SiteTopologyWidget {
  /**
   * @param {HTMLElement} container
   * @param {{ onDeploy?: (selection: { site: typeof MARS_SITES[0], pathId: string }) => void }} options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.onDeploy = options.onDeploy;
    this.stage = 'globe'; // 'globe' | 'site'
    this.siteIndex = 0;
    this.selectedPathId = 'intermediate';

    // Toggleable topography layers
    this.showHeights = true;
    this.showSteepness = true;
    this.showCraters = true;

    // Topography map pan & zoom state (zoom 1.0..4.0, normalized center 0..1)
    this.topoZoom = 1.0;
    this.topoCenterX = 0.5;
    this.topoCenterY = 0.5;
    this.isDraggingTopo = false;
    this._dragState = null;

    // Globe rotation state (animated toward selected site)
    this.camLat = MARS_SITES[0].lat;
    this.camLon = MARS_SITES[0].lon;
    this.targetLat = MARS_SITES[0].lat;
    this.targetLon = MARS_SITES[0].lon;
    this.zoomFactor = 1.0;
    this.zoomingIn = false;

    this.gridData = null;
    this.images = new Map();
    this.hoverCell = null;
    this.lastPointerPos = null;
    this.pinScreenCoords = [];
    this._raf = 0;

    this._renderShell();
    this._bindEvents();
    this._loadAssets();
    this._scheduleDraw();
  }

  get selectedSite() {
    return MARS_SITES[this.siteIndex];
  }

  get selectedPath() {
    return TOPO_PATHS.find((p) => p.id === this.selectedPathId) || TOPO_PATHS[1];
  }

  _loadAssets() {
    fetch('./jezero/topography_grid.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          this.gridData = data;
          this._scheduleDraw();
        }
      })
      .catch(() => {});

    const files = [
      './jezero/base.png',
      './jezero/heights.png',
      './jezero/steepness.png',
      './jezero/craters.png',
      './jezero/heights_steepness.png',
      './jezero/heights_craters.png',
      './jezero/steepness_craters.png',
      './jezero/combined.png',
    ];
    for (const src of files) {
      const img = new Image();
      img.onload = () => this._scheduleDraw();
      img.src = src;
      this.images.set(src, img);
    }
  }

  _renderShell() {
    this.container.innerHTML = `
      <div class="st-root" data-stage="globe">
        <!-- STAGE 1: MARS GLOBE WITH 5 SITES & TOP-LEFT PREVIEW CARD -->
        <div class="st-globe-stage" data-globe-stage>
          <div class="st-globe-viewport">
            <canvas class="st-globe-canvas" data-globe-canvas width="680" height="440" aria-label="Interactive 3D Mars Globe with 5 landing sites"></canvas>

            <!-- Top-Left Site Preview Card -->
            <aside class="st-preview-card" data-preview-card aria-live="polite">
              <div class="st-preview-thumb-wrap">
                <img class="st-preview-img" data-preview-img src="./jezero/combined.png" alt="Topography preview of selected Mars site" />
                <span class="st-preview-badge" data-preview-code>SITE 01 / 05</span>
              </div>
              <div class="st-preview-meta">
                <b class="st-preview-name" data-preview-name>${MARS_SITES[0].name}</b>
                <small class="st-preview-coords" data-preview-coords>${MARS_SITES[0].coords}</small>
                <p class="st-preview-desc" data-preview-desc>${MARS_SITES[0].summary}</p>
                <div class="st-preview-actions">
                  <button type="button" class="st-nav-btn" data-site-prev title="Previous site (Left Arrow)">◀</button>
                  <button type="button" class="st-zoom-btn" data-site-zoom>Zoom In [Enter] →</button>
                  <button type="button" class="st-nav-btn" data-site-next title="Next site (Right Arrow)">▶</button>
                </div>
              </div>
            </aside>

            <!-- Bottom Site Pills Bar -->
            <div class="st-site-strip" role="tablist" aria-label="Mars expedition sites">
              ${MARS_SITES.map(
                (s, i) => `<button type="button" role="tab" class="st-site-pill" data-site-idx="${i}" aria-selected="${i === 0}">
                  <span>0${i + 1}</span> <b>${s.name.split('·')[0].trim()}</b>
                </button>`
              ).join('')}
            </div>
          </div>
          <div class="st-globe-footer">
            <span><kbd>←</kbd> <kbd>→</kbd> Switch site (1–5)</span>
            <span><kbd>Enter</kbd> or <b>Click site</b> to zoom in &amp; inspect topography</span>
          </div>
        </div>

        <!-- STAGE 2: ZOOMED-IN SITE TOPOGRAPHY & HAZARD ANALYZER (jezero_crater.tif) -->
        <div class="st-site-stage" data-site-stage hidden>
          <header class="st-site-header">
            <button type="button" class="st-back-btn" data-back-globe>← Mars Globe</button>
            <div class="st-site-title-block">
              <span class="st-site-kicker" data-zoom-code>SITE 01 · JEZERO DEM (500×500)</span>
              <h3 class="st-site-title" data-zoom-title>${MARS_SITES[0].name}</h3>
            </div>
            <div class="st-layer-toggles" role="group" aria-label="Toggleable topography layers">
              <button type="button" class="st-toggle-btn" data-toggle-layer="heights" aria-pressed="true">
                <i class="st-dot st-dot-heights"></i> Heights
              </button>
              <button type="button" class="st-toggle-btn" data-toggle-layer="steepness" aria-pressed="true">
                <i class="st-dot st-dot-steep"></i> Steepness
              </button>
              <button type="button" class="st-toggle-btn" data-toggle-layer="craters" aria-pressed="true">
                <i class="st-dot st-dot-crater"></i> Craters
              </button>
            </div>
          </header>

          <div class="st-site-body">
            <div class="st-topo-map-wrap">
              <div class="st-topo-canvas-wrap" data-topo-wrap>
                <canvas class="st-topo-canvas" data-topo-canvas width="500" height="500" aria-label="Jezero Crater topography and hazard map"></canvas>
                <div class="st-topo-controls" aria-label="Map zoom and pan controls">
                  <button type="button" data-topo-pan="up" title="Pan Up (Arrow Up)">↑</button>
                  <button type="button" data-topo-pan="down" title="Pan Down (Arrow Down)">↓</button>
                  <span class="st-ctrl-sep" aria-hidden="true"></span>
                  <button type="button" data-topo-zoom="out" title="Zoom Out (-)">−</button>
                  <span class="st-zoom-val" data-topo-zoom-label>100%</span>
                  <button type="button" data-topo-zoom="in" title="Zoom In (+)">+</button>
                  <button type="button" data-topo-zoom="reset" title="Reset View">Reset</button>
                </div>
                <div class="st-topo-hint">Drag or scroll to pan / zoom</div>
              </div>
              <div class="st-topo-readout" data-topo-readout>
                Hover over map to inspect height (m), steepness (°), and craters…
              </div>
              <div class="st-topo-legend">
                <span><i style="background:#2eb85c"></i> Safe (Cost 1)</span>
                <span><i style="background:#fac71f"></i> Moderate Steepness (Cost 5)</span>
                <span><i style="background:#26c7f2"></i> Shallow Crater (Cost 10)</span>
                <span><i style="background:#eb2929"></i> Severe Steepness (Cost 100)</span>
                <span><i style="background:#c72ee0"></i> Deep Crater (Cost 100)</span>
              </div>
            </div>

            <aside class="st-topo-sidebar">
              <div class="st-side-section">
                <div class="st-side-label">TOPOGRAPHY METRICS (jezero_crater.tif)</div>
                <div class="st-stat-grid">
                  <div><span>Elev Range</span><b>7.9 m – 255.0 m</b></div>
                  <div><span>Max Steepness</span><b>74.2°</b></div>
                  <div><span>Max Crater Depth</span><b>108.3 m</b></div>
                  <div><span>Grid Resolution</span><b>500 × 500 px</b></div>
                </div>
              </div>

              <div class="st-side-section">
                <div class="st-side-label">SELECT EXPEDITION PATH</div>
                <div class="st-path-list" role="radiogroup" aria-label="Select rover path">
                  ${TOPO_PATHS.map(
                    (p) => `<button type="button" class="st-path-card" data-path-id="${p.id}" aria-pressed="${p.id === this.selectedPathId}" style="--path-c:${p.color}">
                      <div class="st-path-head"><b>${p.name}</b><span>${p.distance}</span></div>
                      <small>${p.maxSlope} max slope · ${p.note}</small>
                    </button>`
                  ).join('')}
                </div>
              </div>

              <button type="button" class="st-deploy-btn" data-deploy-rover>
                Deploy Rover to 3D Surface <span>→</span>
              </button>
            </aside>
          </div>
        </div>
      </div>
    `;
  }

  _bindEvents() {
    this.container.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) {
        if (btn.hasAttribute('data-site-prev')) {
          this.selectSite(this.siteIndex - 1);
          return;
        }
        if (btn.hasAttribute('data-site-next')) {
          this.selectSite(this.siteIndex + 1);
          return;
        }
        if (btn.hasAttribute('data-site-zoom')) {
          this.zoomIntoSelectedSite();
          return;
        }
        if (btn.hasAttribute('data-site-idx')) {
          const idx = Number(btn.dataset.siteIdx);
          if (idx === this.siteIndex) {
            this.zoomIntoSelectedSite();
          } else {
            this.selectSite(idx);
          }
          return;
        }
        if (btn.hasAttribute('data-back-globe')) {
          this.returnToGlobe();
          return;
        }
        if (btn.hasAttribute('data-toggle-layer')) {
          const layer = btn.dataset.toggleLayer;
          if (layer === 'heights') this.showHeights = !this.showHeights;
          if (layer === 'steepness') this.showSteepness = !this.showSteepness;
          if (layer === 'craters') this.showCraters = !this.showCraters;
          btn.setAttribute(
            'aria-pressed',
            String(
              layer === 'heights'
                ? this.showHeights
                : layer === 'steepness'
                  ? this.showSteepness
                  : this.showCraters
            )
          );
          this._scheduleDraw();
          return;
        }
        if (btn.hasAttribute('data-path-id')) {
          this.selectedPathId = btn.dataset.pathId;
          for (const card of this.container.querySelectorAll('[data-path-id]')) {
            card.setAttribute('aria-pressed', String(card.dataset.pathId === this.selectedPathId));
          }
          this._scheduleDraw();
          return;
        }
        if (btn.hasAttribute('data-deploy-rover')) {
          this.deployToSurface();
          return;
        }
        if (btn.dataset.topoZoom) {
          const action = btn.dataset.topoZoom;
          if (action === 'in') this.setTopoZoom(this.topoZoom * 1.25);
          else if (action === 'out') this.setTopoZoom(this.topoZoom / 1.25);
          else this.resetTopoView();
          return;
        }
        if (btn.dataset.topoPan) {
          this.panTopoBy(0, btn.dataset.topoPan === 'up' ? -0.14 : 0.14);
          return;
        }
      }

      // Clicking the preview card also zooms into the selected site
      if (e.target.closest('[data-preview-card]') && !e.target.closest('button')) {
        this.zoomIntoSelectedSite();
      }
    });

    // Clicking on a site pin or the Mars globe
    const globeCanvas = this.container.querySelector('[data-globe-canvas]');
    globeCanvas.addEventListener('click', (e) => {
      const rect = globeCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      for (const pin of this.pinScreenCoords) {
        if (Math.hypot(x - pin.x, y - pin.y) < 26) {
          if (pin.index === this.siteIndex) {
            this.zoomIntoSelectedSite();
          } else {
            this.selectSite(pin.index);
          }
          return;
        }
      }
      // If clicking inside the globe disc, zoom into the currently selected site
      const cx = rect.width * 0.59;
      const cy = rect.height * 0.46;
      const r = Math.min(rect.width * 0.33, rect.height * 0.35);
      if (Math.hypot(x - cx, y - cy) <= r) {
        this.zoomIntoSelectedSite();
      }
    });

    // Hovering, panning, zooming, and clicking routes on the zoomed-in topography canvas
    const topoCanvas = this.container.querySelector('[data-topo-canvas]');
    const updateHoverFromPointer = (clientX, clientY) => {
      const rect = topoCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const sx = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const sy = Math.max(0, Math.min(rect.height, clientY - rect.top));
      this.lastPointerPos = { sx, sy };
      const { S, mapX, mapY } = this._getTopoTransform(rect.width, rect.height);
      const nx = Math.max(0, Math.min(0.9999, (sx - mapX) / S));
      const ny = Math.max(0, Math.min(0.9999, (sy - mapY) / S));
      this.hoverCell = { nx, ny };
      this._updateReadout();
    };

    topoCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = topoCanvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.isDraggingTopo = true;
      this._dragState = {
        pointerId: e.pointerId,
        startX: sx,
        startY: sy,
        startCenterX: this.topoCenterX,
        startCenterY: this.topoCenterY,
        moved: false,
      };
      topoCanvas.setPointerCapture(e.pointerId);
      topoCanvas.style.cursor = 'grabbing';
    });

    topoCanvas.addEventListener('pointermove', (e) => {
      const rect = topoCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (this.isDraggingTopo && this._dragState) {
        const dx = sx - this._dragState.startX;
        const dy = sy - this._dragState.startY;
        if (Math.hypot(dx, dy) > 4) this._dragState.moved = true;
        const { S } = this._getTopoTransform(rect.width, rect.height);
        this.topoCenterX = this._dragState.startCenterX - dx / S;
        this.topoCenterY = this._dragState.startCenterY - dy / S;
        this._getTopoTransform(rect.width, rect.height);
      }
      updateHoverFromPointer(e.clientX, e.clientY);
      this._scheduleDraw();
    });

    const endDrag = (e, allowClick) => {
      if (!this.isDraggingTopo) return;
      const wasMoved = this._dragState?.moved;
      if (topoCanvas.hasPointerCapture(e.pointerId)) {
        topoCanvas.releasePointerCapture(e.pointerId);
      }
      this.isDraggingTopo = false;
      this._dragState = null;
      topoCanvas.style.cursor = 'crosshair';
      if (allowClick && !wasMoved) {
        const rect = topoCanvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const { S, mapX, mapY } = this._getTopoTransform(rect.width, rect.height);
        const nx = (sx - mapX) / S;
        const ny = (sy - mapY) / S;
        let bestId = null;
        let bestDist = 0.06 / this.topoZoom;
        for (const path of TOPO_PATHS) {
          for (const [px, py] of path.points) {
            const d = Math.hypot(nx - px, ny - py);
            if (d < bestDist) {
              bestDist = d;
              bestId = path.id;
            }
          }
        }
        if (bestId) {
          this.selectedPathId = bestId;
          for (const card of this.container.querySelectorAll('[data-path-id]')) {
            card.setAttribute('aria-pressed', String(card.dataset.pathId === this.selectedPathId));
          }
          this._scheduleDraw();
        }
      }
    };

    topoCanvas.addEventListener('pointerup', (e) => endDrag(e, true));
    topoCanvas.addEventListener('pointercancel', (e) => endDrag(e, false));
    topoCanvas.addEventListener('pointerleave', () => {
      if (!this.isDraggingTopo) {
        this.hoverCell = null;
        this.lastPointerPos = null;
        this._scheduleDraw();
      }
    });

    topoCanvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = topoCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        this.setTopoZoom(this.topoZoom * factor, sx, sy);
        updateHoverFromPointer(e.clientX, e.clientY);
        this._scheduleDraw();
      },
      { passive: false }
    );

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._scheduleDraw());
      this._resizeObserver.observe(this.container);
    }
  }

  /**
   * Handle keyboard navigation when the Site Topology view is active/visible.
   * Returns true if the key event was handled.
   */
  handleKeyDown(event) {
    const key = event.key;
    if (this.stage === 'globe') {
      if (key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        this.selectSite(this.siteIndex - 1);
        return true;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        this.selectSite(this.siteIndex + 1);
        return true;
      }
      if (key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.zoomIntoSelectedSite();
        return true;
      }
    } else if (this.stage === 'site') {
      if (key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        this.returnToGlobe();
        return true;
      }
      if (key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.deployToSurface();
        return true;
      }
      if (key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        this.panTopoBy(0, -0.1);
        return true;
      }
      if (key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        this.panTopoBy(0, 0.1);
        return true;
      }
      if (key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        this.panTopoBy(-0.1, 0);
        return true;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        this.panTopoBy(0.1, 0);
        return true;
      }
      if (key === '+' || key === '=') {
        event.preventDefault();
        event.stopPropagation();
        this.setTopoZoom(this.topoZoom * 1.25);
        return true;
      }
      if (key === '-' || key === '_') {
        event.preventDefault();
        event.stopPropagation();
        this.setTopoZoom(this.topoZoom / 1.25);
        return true;
      }
    }
    return false;
  }

  selectSite(index) {
    const count = MARS_SITES.length;
    this.siteIndex = ((index % count) + count) % count;
    const site = this.selectedSite;
    this.targetLat = site.lat;
    this.targetLon = site.lon;
    this.selectedPathId = site.defaultApproach || 'intermediate';

    // Update top-left preview card
    const q = (s) => this.container.querySelector(s);
    q('[data-preview-code]').textContent = `${site.code} / 0${count}`;
    q('[data-preview-name]').textContent = site.name;
    q('[data-preview-coords]').textContent = site.coords;
    q('[data-preview-desc]').textContent = site.summary;
    const img = q('[data-preview-img]');
    img.style.filter = site.previewFilter;

    for (const pill of this.container.querySelectorAll('[data-site-idx]')) {
      pill.setAttribute('aria-selected', String(Number(pill.dataset.siteIdx) === this.siteIndex));
    }
    for (const card of this.container.querySelectorAll('[data-path-id]')) {
      card.setAttribute('aria-pressed', String(card.dataset.pathId === this.selectedPathId));
    }

    this._scheduleDraw();
  }

  zoomIntoSelectedSite() {
    if (this.stage === 'site' || this.zoomingIn) return;
    this.zoomingIn = true;
    const start = performance.now();
    const animateZoom = (now) => {
      const t = Math.min(1, (now - start) / 340);
      this.zoomFactor = 1 + t * t * 1.65;
      this._drawGlobe();
      if (t < 1) {
        requestAnimationFrame(animateZoom);
      } else {
        this.zoomingIn = false;
        this.zoomFactor = 1.0;
        this.stage = 'site';
        this.resetTopoView();
        const site = this.selectedSite;
        const q = (s) => this.container.querySelector(s);
        q('.st-root').dataset.stage = 'site';
        q('[data-globe-stage]').hidden = true;
        q('[data-site-stage]').hidden = false;
        q('[data-zoom-code]').textContent = `${site.code} · ${site.coords} · JEZERO DEM`;
        q('[data-zoom-title]').textContent = site.name;
        this._scheduleDraw();
      }
    };
    requestAnimationFrame(animateZoom);
  }

  returnToGlobe() {
    this.stage = 'globe';
    this.zoomFactor = 1.0;
    const q = (s) => this.container.querySelector(s);
    q('.st-root').dataset.stage = 'globe';
    q('[data-site-stage]').hidden = true;
    q('[data-globe-stage]').hidden = false;
    this._scheduleDraw();
  }

  deployToSurface() {
    if (this.onDeploy) {
      this.onDeploy({
        site: this.selectedSite,
        pathId: this.selectedPathId,
        path: this.selectedPath,
      });
    }
  }

  _updateReadout() {
    const readout = this.container.querySelector('[data-topo-readout]');
    if (!readout || !this.hoverCell) return;
    const { nx, ny } = this.hoverCell;
    const col500 = Math.min(499, Math.floor(nx * 500));
    const row500 = Math.min(499, Math.floor(ny * 500));

    if (this.gridData) {
      const gx = Math.min(this.gridData.width - 1, Math.floor(nx * this.gridData.width));
      const gy = Math.min(this.gridData.height - 1, Math.floor(ny * this.gridData.height));
      const elev = this.gridData.elevation[gy][gx];
      const slope = this.gridData.slope[gy][gx];
      const crater = this.gridData.crater[gy][gx];
      const cost = this.gridData.cost[gy][gx];
      const tag =
        cost >= 100
          ? 'SEVERE HAZARD'
          : cost === 10
            ? 'SHALLOW CRATER'
            : cost === 5
              ? 'MODERATE STEEPNESS'
              : 'SAFE TERRAIN';
      readout.textContent = `Cell [${col500}, ${row500}] · Height: ${elev.toFixed(1)} m · Steepness: ${slope.toFixed(1)}° · Crater Depth: ${crater >= 0 ? '+' : ''}${crater.toFixed(1)} m · Cost: ${cost} (${tag})`;
    } else {
      readout.textContent = `Cell [${col500}, ${row500}] · Inspecting jezero_crater.tif DEM`;
    }
  }

  _getTopoTransform(w, h) {
    const S = Math.max(w, h) * this.topoZoom;
    const minCX = w / (2 * S);
    const maxCX = 1 - minCX;
    const minCY = h / (2 * S);
    const maxCY = 1 - minCY;
    this.topoCenterX = Math.max(minCX, Math.min(maxCX, this.topoCenterX));
    this.topoCenterY = Math.max(minCY, Math.min(maxCY, this.topoCenterY));
    const mapX = w / 2 - this.topoCenterX * S;
    const mapY = h / 2 - this.topoCenterY * S;
    return { S, mapX, mapY };
  }

  _updateZoomLabel() {
    const label = this.container.querySelector('[data-topo-zoom-label]');
    if (label) label.textContent = `${Math.round(this.topoZoom * 100)}%`;
  }

  setTopoZoom(nextZoom, anchorX = null, anchorY = null) {
    const canvas = this.container.querySelector('[data-topo-canvas]');
    const clamped = Math.max(1.0, Math.min(4.0, nextZoom));
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width || canvas.clientWidth;
      const h = rect.height || canvas.clientHeight;
      if (w > 0 && h > 0) {
        const ax = anchorX ?? w / 2;
        const ay = anchorY ?? h / 2;
        const { S: oldS, mapX: oldMapX, mapY: oldMapY } = this._getTopoTransform(w, h);
        const nx = (ax - oldMapX) / oldS;
        const ny = (ay - oldMapY) / oldS;
        this.topoZoom = clamped;
        const newS = Math.max(w, h) * this.topoZoom;
        this.topoCenterX = nx + (w / 2 - ax) / newS;
        this.topoCenterY = ny + (h / 2 - ay) / newS;
        this._getTopoTransform(w, h);
      } else {
        this.topoZoom = clamped;
      }
    } else {
      this.topoZoom = clamped;
    }
    this._updateZoomLabel();
    this._scheduleDraw();
  }

  panTopoBy(dxNorm, dyNorm) {
    this.topoCenterX += dxNorm / this.topoZoom;
    this.topoCenterY += dyNorm / this.topoZoom;
    const canvas = this.container.querySelector('[data-topo-canvas]');
    if (canvas && canvas.clientWidth && canvas.clientHeight) {
      this._getTopoTransform(canvas.clientWidth, canvas.clientHeight);
    }
    this._scheduleDraw();
  }

  resetTopoView() {
    this.topoZoom = 1.0;
    this.topoCenterX = 0.5;
    this.topoCenterY = 0.5;
    this._updateZoomLabel();
    this._scheduleDraw();
  }

  _scheduleDraw() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => {
      if (this.stage === 'globe') {
        this._drawGlobe();
      } else {
        this._drawTopoMap();
      }
    });
  }

  _drawGlobe() {
    const canvas = this.container.querySelector('[data-globe-canvas]');
    if (!canvas) return;
    const w = canvas.clientWidth || 680;
    const h = canvas.clientHeight || 420;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.round(w * dpr));
    const targetH = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Smoothly interpolate camera toward target site
    const dLat = this.targetLat - this.camLat;
    let dLon = this.targetLon - this.camLon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    this.camLat += dLat * 0.22;
    this.camLon += dLon * 0.22;
    const stillAnimating = Math.abs(dLat) > 0.15 || Math.abs(dLon) > 0.15;

    ctx.clearRect(0, 0, w, h);

    // Deep space background with subtle stars
    const cx = w * 0.59;
    const cy = h * 0.46;
    const bgGrad = ctx.createRadialGradient(cx, cy, 20, cx, cy, w * 0.72);
    bgGrad.addColorStop(0, '#1a1210');
    bgGrad.addColorStop(0.55, '#0b1016');
    bgGrad.addColorStop(1, '#05080c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Deterministic background stars
    ctx.fillStyle = 'rgba(235, 245, 255, 0.55)';
    for (let i = 0; i < 48; i++) {
      const sx = ((i * 173 + 41) % Math.max(20, w - 20)) + 10;
      const sy = ((i * 97 + 23) % Math.max(20, h - 20)) + 10;
      const sr = i % 5 === 0 ? 1.6 : 1.0;
      ctx.fillRect(sx, sy, sr, sr);
    }

    const radius = Math.min(w * 0.33, h * 0.35) * this.zoomFactor;

    // Outer atmospheric halo
    const halo = ctx.createRadialGradient(cx, cy, radius * 0.88, cx, cy, radius * 1.16);
    halo.addColorStop(0, 'rgba(232, 118, 68, 0.32)');
    halo.addColorStop(0.6, 'rgba(195, 82, 45, 0.12)');
    halo.addColorStop(1, 'rgba(195, 82, 45, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.16, 0, Math.PI * 2);
    ctx.fill();

    // Mars sphere shaded body
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    const sphereGrad = ctx.createRadialGradient(
      cx - radius * 0.32,
      cy - radius * 0.28,
      radius * 0.08,
      cx + radius * 0.15,
      cy + radius * 0.15,
      radius * 1.08
    );
    sphereGrad.addColorStop(0, '#f09c67');
    sphereGrad.addColorStop(0.38, '#c96538');
    sphereGrad.addColorStop(0.75, '#7e3318');
    sphereGrad.addColorStop(1, '#2b1008');
    ctx.fillStyle = sphereGrad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

    const lat0 = (this.camLat * Math.PI) / 180;
    const lon0 = (this.camLon * Math.PI) / 180;

    // Draw Martian albedo patches (Syrtis Major, Tharsis, Valles Marineris, Hellas)
    const patches = [
      { lat: 10, lon: 70, rx: 0.26, ry: 0.18, color: 'rgba(62, 26, 14, 0.32)' },
      { lat: -15, lon: 140, rx: 0.32, ry: 0.16, color: 'rgba(72, 30, 16, 0.28)' },
      { lat: -8, lon: 285, rx: 0.38, ry: 0.10, color: 'rgba(52, 20, 11, 0.38)' },
      { lat: 20, lon: 225, rx: 0.22, ry: 0.22, color: 'rgba(255, 195, 145, 0.18)' },
      { lat: -42, lon: 70, rx: 0.25, ry: 0.20, color: 'rgba(255, 180, 130, 0.16)' },
    ];
    for (const p of patches) {
      const proj = this._projectLatLon(p.lat, p.lon, lat0, lon0, cx, cy, radius);
      if (proj.cosC > 0) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(
          proj.x,
          proj.y,
          radius * p.rx * proj.cosC,
          radius * p.ry * proj.cosC,
          0.25,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    // Draw latitude & longitude graticule lines
    ctx.strokeStyle = 'rgba(255, 228, 205, 0.16)';
    ctx.lineWidth = 1;
    for (let lonDeg = 0; lonDeg < 360; lonDeg += 30) {
      ctx.beginPath();
      let started = false;
      for (let latDeg = -80; latDeg <= 80; latDeg += 8) {
        const pt = this._projectLatLon(latDeg, lonDeg, lat0, lon0, cx, cy, radius);
        if (pt.cosC > 0) {
          if (!started) {
            ctx.moveTo(pt.x, pt.y);
            started = true;
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        } else {
          started = false;
        }
      }
      ctx.stroke();
    }
    for (let latDeg = -60; latDeg <= 60; latDeg += 30) {
      ctx.beginPath();
      let started = false;
      for (let lonDeg = 0; lonDeg <= 360; lonDeg += 8) {
        const pt = this._projectLatLon(latDeg, lonDeg, lat0, lon0, cx, cy, radius);
        if (pt.cosC > 0) {
          if (!started) {
            ctx.moveTo(pt.x, pt.y);
            started = true;
          } else {
            ctx.lineTo(pt.x, pt.y);
          }
        } else {
          started = false;
        }
      }
      ctx.stroke();
    }

    ctx.restore();

    // Globe rim stroke
    ctx.strokeStyle = 'rgba(255, 176, 124, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw all 5 Site Pins on the Mars Globe
    this.pinScreenCoords = [];
    MARS_SITES.forEach((site, idx) => {
      const pt = this._projectLatLon(site.lat, site.lon, lat0, lon0, cx, cy, radius);
      if (pt.cosC > -0.1) {
        this.pinScreenCoords.push({ index: idx, x: pt.x, y: pt.y });
        const isSelected = idx === this.siteIndex;

        if (isSelected) {
          // Target reticle rings around selected site
          ctx.strokeStyle = '#79f2d0';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 16, 0, Math.PI * 2);
          ctx.stroke();

          ctx.strokeStyle = 'rgba(121, 242, 208, 0.4)';
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 24, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = isSelected ? '#79f2d0' : '#ffb076';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, isSelected ? 6.5 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0d151c';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Site label next to pin
        const label = `${idx + 1}. ${site.name.split('·')[0].trim()}`;
        ctx.font = `${isSelected ? '700 12px' : '600 10.5px'} Inter, ui-monospace, monospace`;
        const textW = ctx.measureText(label).width;
        const lx = pt.x + 12;
        const ly = pt.y - 8;
        ctx.fillStyle = isSelected ? 'rgba(12, 28, 34, 0.92)' : 'rgba(12, 18, 24, 0.78)';
        ctx.fillRect(lx - 4, ly - 11, textW + 8, 16);
        if (isSelected) {
          ctx.strokeStyle = '#79f2d0';
          ctx.lineWidth = 1;
          ctx.strokeRect(lx - 4, ly - 11, textW + 8, 16);
        }
        ctx.fillStyle = isSelected ? '#9ef8df' : '#e2e8f0';
        ctx.fillText(label, lx, ly + 1);
      }
    });

    if (stillAnimating && !this.zoomingIn) {
      this._scheduleDraw();
    }
  }

  _projectLatLon(latDeg, lonDeg, lat0, lon0, cx, cy, radius) {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const cosC = Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(lon - lon0);
    const x = cx + radius * Math.cos(lat) * Math.sin(lon - lon0);
    const y = cy - radius * (Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(lon - lon0));
    return { x, y, cosC };
  }

  _drawTopoMap() {
    const canvas = this.container.querySelector('[data-topo-canvas]');
    if (!canvas) return;
    const w = canvas.clientWidth || 500;
    const h = canvas.clientHeight || 360;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.round(w * dpr));
    const targetH = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { S, mapX, mapY } = this._getTopoTransform(w, h);
    const src = layerImageFilename(this.showHeights, this.showSteepness, this.showCraters);
    const img = this.images.get(src);

    ctx.save();
    ctx.filter = this.selectedSite.previewFilter || 'none';
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, mapX, mapY, S, S);
    } else {
      ctx.fillStyle = '#1b272c';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();

    // Subtle survey grid overlay locked to the square map coordinates
    ctx.strokeStyle = 'rgba(200, 245, 255, 0.14)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const gx = mapX + (S / 5) * i;
      const gy = mapY + (S / 5) * i;
      ctx.beginPath();
      ctx.moveTo(gx, mapY);
      ctx.lineTo(gx, mapY + S);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mapX, gy);
      ctx.lineTo(mapX + S, gy);
      ctx.stroke();
    }

    // Draw candidate rover traverse paths over the topography
    for (const path of TOPO_PATHS) {
      const isSelected = path.id === this.selectedPathId;
      ctx.save();
      ctx.beginPath();
      path.points.forEach(([px, py], i) => {
        const sx = mapX + px * S;
        const sy = mapY + py * S;
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(isSelected ? [] : [6, 6]);
      ctx.strokeStyle = 'rgba(8, 15, 22, 0.85)';
      ctx.lineWidth = isSelected ? 7 : 4;
      ctx.stroke();

      ctx.strokeStyle = path.color;
      ctx.lineWidth = isSelected ? 3.8 : 2.2;
      if (isSelected) {
        ctx.shadowColor = path.color;
        ctx.shadowBlur = 8;
      }
      ctx.stroke();
      ctx.restore();
    }

    // Draw Habitat & Science Stations on the selected route
    const activePath = this.selectedPath;
    activePath.points.slice(0, -1).forEach(([px, py], idx) => {
      const x = mapX + px * S;
      const y = mapY + py * S;
      ctx.fillStyle = idx === 0 ? '#ffffff' : '#9ef8df';
      ctx.strokeStyle = '#0c1821';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, idx === 0 ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const tag = idx === 0 ? 'HAB' : `S${idx}`;
      ctx.font = '700 10px Inter, ui-monospace, monospace';
      ctx.fillStyle = '#0c1821';
      ctx.fillRect(x + 7, y - 8, 28, 14);
      ctx.fillStyle = '#e6faff';
      ctx.fillText(tag, x + 10, y + 2);
    });

    // Draw hover crosshair circle locked 1:1 to cursor position inside the map
    if (this.hoverCell) {
      const hx = mapX + this.hoverCell.nx * S;
      const hy = mapY + this.hoverCell.ny * S;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
