import { mulberry32 } from '../core/math.js';
import { HAB } from '../config/mission.js';

// ---------------------------------------------------------------------------
// Space artifacts: rocks, crystals and meteorites the crew collects on foot.
// Each station holds the finds its science is about; rarer finds are hidden
// away from the planned route to reward exploring. Descriptions are short,
// real Mars science; the finds themselves are simulated.
// ---------------------------------------------------------------------------

export const RARITY = {
  common: { label: 'Common', color: '#9fe8ff', points: 100 },
  rare: { label: 'Rare', color: '#b9a2ff', points: 250 },
  epic: { label: 'Epic', color: '#ff9ad5', points: 500 },
  legendary: { label: 'Legendary', color: '#ffd76a', points: 1000 },
};

// shape: rock · crystal · slab · spheres · bead · metal · vein
export const CATALOG = [
  { id: 'olivine-basalt', name: 'Olivine basalt', rarity: 'common', shape: 'rock', color: '#3b3a32', accent: '#5d7a3c',
    about: 'Dark volcanic rock rich in olivine. Olivine weathers quickly in water, so finding it fresh says this floor stayed dry.' },
  { id: 'olivine-crystal', name: 'Olivine crystal', rarity: 'rare', shape: 'crystal', color: '#7aa63a', accent: '#c4e27a',
    about: 'A gem-quality olivine grain. Its iron and magnesium ratio records how hot the lava was.' },
  { id: 'vesicular-basalt', name: 'Vesicular basalt', rarity: 'common', shape: 'rock', color: '#4a3a33', accent: '#7a5a48',
    about: 'Basalt full of gas bubbles frozen as the lava cooled near the surface.' },
  { id: 'laminated-mudstone', name: 'Laminated mudstone', rarity: 'common', shape: 'slab', color: '#a77657', accent: '#d9a985',
    about: 'Thin layers settled from still water at the bottom of an ancient lake. The best rock to preserve signs of life.' },
  { id: 'clay-nodule', name: 'Clay nodule', rarity: 'rare', shape: 'spheres', color: '#c9b29a', accent: '#efe0cc',
    about: 'Smectite clay forms only with long-lasting liquid water. Clays like this drew rovers to Jezero and Gale.' },
  { id: 'ripple-sandstone', name: 'Ripple sandstone', rarity: 'common', shape: 'slab', color: '#b98a62', accent: '#e2b98c',
    about: 'Sand ripples turned to stone. The ripple shape tells which way the water flowed.' },
  { id: 'impact-glass', name: 'Impact glass bead', rarity: 'rare', shape: 'bead', color: '#2d3a40', accent: '#7fd2ff',
    about: 'Rock melted by a meteorite impact and quenched into glass. On Earth such glass can trap ancient organic matter.' },
  { id: 'shocked-pyroxene', name: 'Shocked pyroxene', rarity: 'common', shape: 'rock', color: '#5b4637', accent: '#8f6c52',
    about: 'Crystals cracked by the shock wave of the impact that dug the crater.' },
  { id: 'iron-meteorite', name: 'Iron meteorite', rarity: 'epic', shape: 'metal', color: '#6b6e73', accent: '#c9ced4',
    about: 'An iron-nickel core fragment of a shattered asteroid. Curiosity and Opportunity both found irons like this on Mars.' },
  { id: 'ventifact', name: 'Ventifact', rarity: 'common', shape: 'crystal', color: '#7d5a44', accent: '#b88a68',
    about: 'A rock sand-blasted into sharp facets by billions of years of Martian wind.' },
  { id: 'hematite-spherules', name: 'Hematite spherules', rarity: 'rare', shape: 'spheres', color: '#5a5f6a', accent: '#9aa3b2',
    about: '"Blueberries": iron-oxide balls that grew in groundwater. Opportunity found fields of them at Meridiani.' },
  { id: 'ridge-dust', name: 'Ridge-top dust core', rarity: 'common', shape: 'bead', color: '#c28a5c', accent: '#f0b884',
    about: 'Fine global dust, a mix from all over Mars. It tells future crews what clogs their seals and lungs.' },
  { id: 'vrr-hematite', name: 'Vera Rubin hematite', rarity: 'rare', shape: 'slab', color: '#7a3d35', accent: '#c06a58',
    about: 'Hard hematite-bearing rock that holds up Vera Rubin Ridge in Gale Crater.' },
  { id: 'gale-mudstone', name: 'Gale lake mudstone', rarity: 'common', shape: 'slab', color: '#9b7258', accent: '#cfa384',
    about: 'Mudstone from a lake that filled Gale Crater for millions of years.' },
  { id: 'sulfate-vein', name: 'Calcium sulfate vein', rarity: 'rare', shape: 'vein', color: '#e9e2d6', accent: '#ffffff',
    about: 'White mineral veins left by groundwater flowing through cracks long after the lake dried.' },
  { id: 'stony-meteorite', name: 'Stony meteorite', rarity: 'epic', shape: 'rock', color: '#2b2522', accent: '#8a6d58',
    about: 'A chondrite with a dark fusion crust. Its grains are older than Mars itself.' },
  { id: 'pallasite', name: 'Pallasite', rarity: 'legendary', shape: 'metal', color: '#8a8e70', accent: '#d4e86a',
    about: 'Olivine crystals set in iron-nickel metal, from the boundary between an asteroid core and mantle. One of the rarest meteorites known.' },
  { id: 'gypsum-rosette', name: 'Gypsum rosette', rarity: 'rare', shape: 'crystal', color: '#e8dccb', accent: '#ffffff',
    about: 'Petal-shaped gypsum crystals that grow as salty water evaporates.' },
  { id: 'jarosite-crust', name: 'Jarosite crust', rarity: 'rare', shape: 'vein', color: '#c7a23a', accent: '#f0d36a',
    about: 'A yellow sulfate that forms only in acidic water. Opportunity used it to show Meridiani was once wet.' },
  { id: 'opaline-silica', name: 'Opaline silica', rarity: 'epic', shape: 'bead', color: '#e4eef2', accent: '#a9e8ff',
    about: 'Silica deposited by hot springs, the kind of place where life on Earth may have begun.' },
  { id: 'manganese-oxide', name: 'Manganese oxide coating', rarity: 'rare', shape: 'rock', color: '#1f1b1d', accent: '#5d4e6b',
    about: 'Manganese oxides need oxygen-rich water to form, a surprise on early Mars.' },
  { id: 'carbonate-nodule', name: 'Carbonate nodule', rarity: 'epic', shape: 'spheres', color: '#d9c4a8', accent: '#fff1dd',
    about: 'Carbonates lock carbon dioxide out of the air. They help explain where the thick early atmosphere went.' },
];
export const byId = Object.fromEntries(CATALOG.map((a) => [a.id, a]));

const STATION_FINDS = {
  delta: {
    S1: ['olivine-basalt', 'vesicular-basalt', 'olivine-crystal'],
    S2: ['laminated-mudstone', 'ripple-sandstone', 'clay-nodule'],
    S3: ['shocked-pyroxene', 'impact-glass', 'iron-meteorite'],
    S4: ['ventifact', 'ridge-dust', 'hematite-spherules'],
  },
  gale: { S1: ['gale-mudstone', 'vrr-hematite', 'sulfate-vein'] },
};
const WILD = ['stony-meteorite', 'pallasite', 'gypsum-rosette', 'jarosite-crust', 'opaline-silica', 'manganese-oxide', 'carbonate-nodule', 'hematite-spherules'];
const MINUTES = { common: 4, rare: 6, epic: 8, legendary: 10 };

export const siteKey = (site) => (/gale/i.test(site?.name ?? '') ? 'gale' : 'delta');

function slopeAt(terrain, x, z) {
  if (terrain.slopeAt) return terrain.slopeAt(x, z, 2);
  const gx = (terrain.heightAt(x + 2, z) - terrain.heightAt(x - 2, z)) / 4;
  const gz = (terrain.heightAt(x, z + 2) - terrain.heightAt(x, z - 2)) / 4;
  return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
}

function make(def, x, z, terrain, extra) {
  return { ...def, uid: `${extra.stationId ?? 'wild'}:${def.id}:${Math.round(x)}:${Math.round(z)}`, x, z, y: terrain.heightAt(x, z),
    minutes: MINUTES[def.rarity], note: `${RARITY[def.rarity].label} find`, collected: false, stationId: null, ...extra };
}

// Station finds ring each station; wild finds sit away from the route and each other.
export function placeArtifacts({ route, terrain, site, seed = 7 }) {
  const r = mulberry32(seed);
  const key = siteKey(site);
  const out = [];
  const stations = route.stations.filter((st) => !st.final);
  for (const st of stations) {
    const ids = STATION_FINDS[key][st.id] ?? [];
    ids.forEach((id, i) => {
      for (let attempt = 0; attempt < 24; attempt++) {
        const a = (i / ids.length) * Math.PI * 2 + r() * 1.2 + attempt * 0.7;
        const d = 9 + r() * 14;
        const x = st.x + Math.cos(a) * d, z = st.z + Math.sin(a) * d;
        if (attempt < 23 && slopeAt(terrain, x, z) > 18) continue;
        out.push(make(byId[id], x, z, terrain, { stationId: st.id }));
        break;
      }
    });
  }
  const b = terrain.innerBounds ?? { x0: -300, x1: 300, z0: -300, z1: 300 };
  const span = Math.min(b.x1 - b.x0, b.z1 - b.z0);
  const want = span > 1000 ? 7 : 4;
  const reach = Math.min(650, span / 2 - 40);
  const pool = WILD.filter((id) => !(STATION_FINDS[key] && Object.values(STATION_FINDS[key]).flat().includes(id)));
  const near = (x, z) => {
    let best = Infinity;
    for (let i = 0; i < route.count; i += 3) best = Math.min(best, (route.x[i] - x) ** 2 + (route.z[i] - z) ** 2);
    return Math.sqrt(best);
  };
  for (let tries = 0; tries < 4000 && out.filter((a) => !a.stationId).length < want; tries++) {
    const a = r() * Math.PI * 2, d = 70 + r() * (reach - 70);
    const x = HAB.x + Math.cos(a) * d, z = HAB.z + Math.sin(a) * d;
    if (x < b.x0 + 40 || x > b.x1 - 40 || z < b.z0 + 40 || z > b.z1 - 40) continue;
    if (near(x, z) < 35 || slopeAt(terrain, x, z) > 16) continue;
    if (stations.some((st) => Math.hypot(st.x - x, st.z - z) < 50)) continue;
    if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 80)) continue;
    const def = byId[pool[out.filter((o) => !o.stationId).length % pool.length]];
    out.push(make(def, x, z, terrain, {}));
  }
  return out;
}

// ---------------------------------------------------------------- collection (persistent)
const KEY = 'isg.collection.v1';
const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function loadCollection(store = storage()) {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? 'null');
    if (!raw || raw.version !== 1 || typeof raw.items !== 'object' || !raw.items) return { version: 1, items: {} };
    const items = {};
    for (const [id, v] of Object.entries(raw.items)) {
      if (byId[id] && Number.isFinite(v?.count) && v.count > 0) items[id] = { count: Math.floor(v.count), site: String(v.site ?? ''), at: String(v.at ?? '') };
    }
    return { version: 1, items };
  } catch {
    return { version: 1, items: {} };
  }
}

// Returns true when the artifact is new to the collection.
export function recordFind(collection, artifact, siteName, now = new Date()) {
  const item = collection.items[artifact.id];
  if (item) { item.count++; return false; }
  collection.items[artifact.id] = { count: 1, site: `${siteName}${artifact.stationId ? ` · ${artifact.stationId}` : ' · off-route'}`, at: now.toISOString().slice(0, 10) };
  return true;
}

export function saveCollection(collection, store = storage()) {
  try { store?.setItem(KEY, JSON.stringify(collection)); return true; } catch { return false; }
}
