import { CATALOG, RARITY, loadCollection } from '../sim/artifacts.js';
import { mulberry32 } from '../core/math.js';
import './collection.css';

// ---------------------------------------------------------------------------
// The crew's artifact collection: every find ever made in this browser, with
// undiscovered entries shown as silhouettes. Opened with I, the HUD button or
// the habitat console. Also shows the "find" toast during an EVA.
// ---------------------------------------------------------------------------

const icons = new Map();

// Small procedural drawing of a find, by shape.
export function artifactIcon(def, size = 96, silhouette = false) {
  const key = `${def.id}:${size}:${silhouette}`;
  if (icons.has(key)) return icons.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = mulberry32(def.id.length * 131 + def.id.charCodeAt(0));
  const s = size / 96;
  g.scale(s, s);
  const fill = (inner, outer, x = 48, y = 52, rad = 40) => {
    if (silhouette) return '#1b2a30';
    const grad = g.createRadialGradient(x - 10, y - 14, 4, x, y, rad);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    return grad;
  };
  if (!silhouette) {
    const glow = g.createRadialGradient(48, 52, 6, 48, 52, 46);
    glow.addColorStop(0, `${RARITY[def.rarity].color}55`);
    glow.addColorStop(1, `${RARITY[def.rarity].color}00`);
    g.fillStyle = glow;
    g.fillRect(0, 0, 96, 96);
  }
  const blob = (cx, cy, rad, points = 9, jag = 0.3) => {
    g.beginPath();
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2;
      const rr = rad * (1 - jag / 2 + r() * jag);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.78;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.closePath();
  };
  switch (def.shape) {
    case 'crystal':
      for (let i = 0; i < 4; i++) {
        g.save();
        g.translate(30 + i * 12, 70);
        g.rotate((i - 1.5) * 0.25);
        g.beginPath();
        const h = 34 + r() * 18;
        g.moveTo(-7, 0); g.lineTo(-7, -h); g.lineTo(0, -h - 10); g.lineTo(7, -h); g.lineTo(7, 0); g.closePath();
        g.fillStyle = silhouette ? '#1b2a30' : (() => { const lg = g.createLinearGradient(-7, 0, 7, 0); lg.addColorStop(0, def.color); lg.addColorStop(0.5, def.accent); lg.addColorStop(1, def.color); return lg; })();
        g.fill();
        g.restore();
      }
      break;
    case 'slab':
      g.save();
      g.translate(48, 54);
      g.rotate(-0.12);
      g.beginPath();
      g.roundRect(-36, -18, 72, 36, 6);
      g.clip();
      for (let i = 0; i < 6; i++) {
        g.fillStyle = silhouette ? '#1b2a30' : i % 2 ? def.accent : def.color;
        g.fillRect(-36, -18 + i * 6, 72, 6);
      }
      g.restore();
      break;
    case 'spheres':
      for (let i = 0; i < 7; i++) {
        const x = 26 + r() * 44, y = 38 + r() * 30, rad = 7 + r() * 7;
        g.beginPath();
        g.arc(x, y, rad, 0, Math.PI * 2);
        g.fillStyle = fill(def.accent, def.color, x, y, rad + 4);
        g.fill();
      }
      break;
    case 'bead':
      g.beginPath();
      g.arc(48, 52, 26, 0, Math.PI * 2);
      g.fillStyle = fill(def.accent, def.color, 48, 52, 30);
      g.fill();
      if (!silhouette) {
        g.beginPath();
        g.ellipse(39, 42, 7, 4, -0.6, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.fill();
      }
      break;
    case 'metal':
      blob(48, 54, 32, 8, 0.35);
      g.fillStyle = silhouette ? '#1b2a30' : (() => { const lg = g.createLinearGradient(20, 26, 76, 80); lg.addColorStop(0, '#e6e9ec'); lg.addColorStop(0.45, def.color); lg.addColorStop(1, '#2c2e31'); return lg; })();
      g.fill();
      if (!silhouette) for (let i = 0; i < 5; i++) { g.fillStyle = def.accent; g.fillRect(30 + r() * 34, 40 + r() * 24, 4, 4); }
      break;
    case 'vein':
      blob(48, 54, 32, 9, 0.3);
      g.fillStyle = fill('#8a6a55', '#4a3528');
      g.fill();
      if (!silhouette) {
        g.save();
        g.clip();
        g.strokeStyle = def.color;
        g.lineWidth = 7;
        g.beginPath(); g.moveTo(14, 70); g.lineTo(84, 38); g.stroke();
        g.restore();
      }
      break;
    default:
      blob(48, 54, 32, 9, 0.35);
      g.fillStyle = fill(def.accent, def.color);
      g.fill();
      if (!silhouette) for (let i = 0; i < 8; i++) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.arc(28 + r() * 40, 40 + r() * 28, 1.5 + r() * 2, 0, Math.PI * 2); g.fill(); }
  }
  const url = c.toDataURL();
  icons.set(key, url);
  return url;
}

export class CollectionView {
  constructor() {
    const dialog = document.createElement('dialog');
    dialog.id = 'collectionDialog';
    dialog.className = 'collection';
    dialog.setAttribute('aria-labelledby', 'collectionTitle');
    dialog.innerHTML = `
      <header class="source-header">
        <h2 id="collectionTitle">Artifact collection</h2>
        <p class="col-count" data-count></p>
        <button type="button" class="col-close" data-close aria-label="Close collection">×</button>
      </header>
      <div class="col-filter" role="group" aria-label="Filter by rarity" data-filter></div>
      <ul class="col-grid" data-grid></ul>
      <p class="col-note">Finds are simulated. Your collection is kept in this browser.</p>`;
    document.getElementById('app').appendChild(dialog);
    this.el = dialog;
    this.filter = 'all';
    this.session = new Set();
    dialog.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'i') { event.preventDefault(); dialog.close(); }
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
      const f = event.target.closest('[data-rarity]');
      if (f) { this.filter = f.dataset.rarity; this.render(); }
    });

    const toast = document.createElement('div');
    toast.className = 'find-toast';
    toast.hidden = true;
    toast.setAttribute('role', 'status');
    document.getElementById('app').appendChild(toast);
    this.toast = toast;
  }

  get open() { return this.el.open; }

  show() {
    this.render();
    if (!this.el.open) this.el.showModal();
  }
  toggle() {
    if (this.el.open) this.el.close();
    else this.show();
  }

  render() {
    const collection = loadCollection();
    const found = Object.keys(collection.items).length;
    this.el.querySelector('[data-count]').innerHTML = `<b>${found}</b> / ${CATALOG.length} discovered${this.session.size ? ` · <em>+${this.session.size} this EVA</em>` : ''}`;
    this.el.querySelector('[data-filter]').innerHTML = ['all', ...Object.keys(RARITY)].map((k) => `<button type="button" data-rarity="${k}" aria-pressed="${this.filter === k}">${k === 'all' ? 'All' : RARITY[k].label}</button>`).join('');
    const order = Object.keys(RARITY);
    const list = CATALOG.filter((d) => this.filter === 'all' || d.rarity === this.filter)
      .sort((a, b) => order.indexOf(a.rarity) - order.indexOf(b.rarity));
    this.el.querySelector('[data-grid]').innerHTML = list.map((d) => {
      const item = collection.items[d.id];
      const rarity = RARITY[d.rarity];
      if (!item) {
        return `<li class="col-card locked"><img src="${artifactIcon(d, 96, true)}" alt=""><div><b>Undiscovered</b><span style="color:${rarity.color}">${rarity.label}</span><p>Not found yet. ${d.rarity === 'common' ? 'Look around the science stations.' : 'Rarer finds hide away from the planned route.'}</p></div></li>`;
      }
      return `<li class="col-card ${this.session.has(d.id) ? 'fresh' : ''}" style="--rarity:${rarity.color}"><img src="${artifactIcon(d)}" alt=""><div>
        <b>${d.name}</b><span style="color:${rarity.color}">${rarity.label}${item.count > 1 ? ` · ×${item.count}` : ''}</span>
        <p>${d.about}</p><small>First found ${item.site} · ${item.at}</small></div></li>`;
    }).join('');
  }

  // Pickup feedback during an EVA.
  announce(artifact, isNew) {
    const rarity = RARITY[artifact.rarity];
    if (isNew) this.session.add(artifact.id);
    this.toast.innerHTML = `<img src="${artifactIcon(artifact, 64)}" alt=""><div><span style="color:${rarity.color}">${isNew ? 'New discovery · ' : ''}${rarity.label}</span><b>${artifact.name}</b><small>I · open collection</small></div>`;
    this.toast.style.setProperty('--rarity', rarity.color);
    this.toast.hidden = false;
    this.toast.classList.remove('pop');
    void this.toast.offsetWidth;
    this.toast.classList.add('pop');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.toast.hidden = true; }, 4200);
  }
}
