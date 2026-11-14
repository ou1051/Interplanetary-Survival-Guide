# Interplanetary Survival Guide — Martian Map

NASA Space Apps Challenge · *Interplanetary Survival Guide: Martian Map*

The app opens on **Mars Surface Operations**. Select **Enter habitat**, then **Review route** to open the planner. **Original Delta Traverse** is selected by default. Select **S1** to compare three approaches from the habitat, each trading distance against risk: **Shortest** (293 m) takes the direct line across *unsurveyed ground* that the map cannot resolve (possible boulders, soft sand, small ledges), so the rover stops for a briefing and creeps through it; **Intermediate** (322 m) bends around that patch over mapped ground; **Longer** (419 m) is a western detour over the gentlest slopes. All three join the original 1.8 km loop at S1. Choose **Go outside** to drive the selected route.

Select **Gale Crater · Vera Rubin Ridge** to compare a gentler route and a shorter route to a layered outcrop, consult a Curiosity observation, and collect paired samples. Select **Dust front ahead** before launch to try an early return in Gale. Press **P** or click **Wrist navigator** in either mission for the next stop, nearby hazards, and estimated oxygen on return.

For Gale Crater, the wall map and rover terrain share a crop of an archived Mars Reconnaissance Orbiter HiRISE elevation product. The two route cards report the steepest sampled terrain slope along each route. The rover also measures pitch and roll along the corridor, so its hazard gates use a different measure. The science stop and habitat are demo placements, and weather, oxygen and sample results are simulated.

- **Orbital and elevation**: [HiRISE DTEEC_009149_1750_009294_1750_U01 and PSP_009149_1750_RED_A_01_ORTHO](https://www.uahirise.org/dtm/dtm.php?ID=PSP_009149_1750), NASA/JPL-Caltech/University of Arizona, [USGS Analysis Ready Data](https://stac.astrogeology.usgs.gov/docs/data/mars/hirise_dtms/). The local assets are made from a 640 m crop in Mars 2015 equirectangular coordinates, with elevation resampled to 4 m and slopes derived from that grid. The wall display frames a 320 m portion. Outside the crop the simulation extends the edge elevations.
- **Science reference**: [Curiosity Mastcam Sol 1790, PIA21851](https://science.nasa.gov/photojournal/looking-up-at-layers-of-vera-rubin-ridge-on-sol-1790/), NASA/JPL-Caltech/MSSS. This is a regional reference for the visible bedding, not a photograph from the exact simulated station.
- **Globe**: [JPL Mars Trek](https://trek.nasa.gov/mars/) continues to provide imagery for the separate scouting map.

### References studied

- [Gale Marswalk Planner](https://github.com/sohaib1083/gale-marswalk-planner): separation of terrain evidence, routing and rehearsal assumptions.
- [Sol-3](https://github.com/PhewwcCoder/nasa-space-app-challenge): first-person exploration, mission chapters and source-linked learning.
- [NASA AMMOS 3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS): multiscale terrain architecture and resolution-aware rendering.
- [NASA Mars facts](https://science.nasa.gov/mars/facts/) and [Perseverance](https://science.nasa.gov/mission/mars-2020-perseverance/): scientific context.

This project is independent and is not endorsed by NASA.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/ (GitHub Pages-ready, relative paths)
npm run build:single # one self-contained file: dist-single/index.html
```

A GitHub Actions workflow (`.github/workflows/deploy.yml`) publishes `dist/` to GitHub Pages on
every push to `main`. Enable it once under **Settings → Pages → Source: GitHub Actions**.

Open `/map.html` for the Mars globe, or `/map.html#site` to go straight to the [scouting demo](src/map/README.md).

## Routing API

Run `npm run api` to plan a route or recalculate the remaining leg after a hazard update. For grid fields, consumable units and runnable requests, see the [routing API reference](docs/api/routing.md).

## Controls

The planned route is a guide, not a rail: drive and walk anywhere. Stop at a science station, get out and collect its artifacts on foot. Rarer finds hide away from the route. Return to the habitat and press Enter to end the EVA.

| Key | Driving | On foot |
| --- | --- | --- |
| `W` / `↑` | drive | walk forward |
| `S` / `↓` / `Space` | brake (hold at a standstill to reverse) | walk back (`S` / `↓`) |
| `A` `D` / `←` `→` | steer | step sideways |
| `Shift` (hold) | time ×3 | run |
| `F` | get out (rover stopped) | board the rover (within 3 m) |
| `E` (hold) | | collect the find in reach |
| `T` | view: first person → third person → overhead | same |
| `I` | artifact collection | same |
| `C` | cruise control | |
| `Enter` | end the EVA at the habitat | same |
| `1`–`4` | data layer: optical · slope · thermal inertia · mineralogy | same |
| `M` | full route map + elevation profile | same |
| `L` | headlights · `H` hide HUD · `V` recentre view · `N` mute | same |
| drag · `Z` `X` · `B` | look around a full 360° · look back | look around; orbit the camera in the outside views |
| wheel | zoom the third-person and overhead views | same |

Touch devices get on-screen DRIVE / BRAKE / steer / TASK buttons, plus Get out / Board, Hold to collect, View and Collection buttons.

### Artifacts

Each station has three finds tied to its science (for example olivine at the crater floor, mudstone at the delta front, an iron meteorite at the fresh crater). Off-route finds such as a pallasite or opaline silica sit away from the planned route. Light beams in the rarity colour show where they are. Hold `E` next to one to collect it. The collection (`I`, or **Collection** on the habitat console) keeps every find in this browser, with a short description of the real Mars science behind it. Finds are simulated.

## What the screen shows

- **Cockpit (diegetic):** roll cage, front deck, fenders and wheels with independent suspension,
  co-pilot astronaut, hand controller that follows your input, and four live displays — heading-up
  NAV map, TRAVERSE (speed, pitch/roll, look-ahead elevation profile), SCIENCE (value of the active
  layer under the rover + next station objective) and a SUIT tablet.
- **Helmet HUD:** compass tape with bearings to the next station and the habitat, life-support
  panel, navigation panel with speed governor and attitude, AR markers for stations and gates,
  route progress strip, comms log.
- **World:** glowing route ribbon (cyan = nominal, amber = caution, red = danger), survey stakes
  every 20 m, beacons at stations, blinking posts at hazard gates, habitat with comms mast.

## How the route is evaluated

`src/world/route.js` samples the planned spline every metre and computes **pitch** (along track)
and **roll** (across the 1.8 m wheel track) from the elevation model, averaged over the rover
footprint. Combined tilt ≥ 9° → *caution* (speed limit 10 km/h), ≥ 15° → *danger* (6 km/h + hazard
gate). Area hazards (ejecta block field, soft regolith) come from `AREA_HAZARDS` in the config.
Comms line-of-sight to the habitat mast is ray-marched over the same terrain.

Hazards smaller than the elevation grid are outside the scope of the slope analysis. The demo provides simulated guidance for the selected scenario.

## Optional simulation layers

| Placeholder | File | Replace with |
| --- | --- | --- |
| Elevation (`rawHeight`) | `src/world/terrain.js` | HiRISE DTM (1 m/px) or CTX DTM; MOLA for the horizon |
| Optical layer | `src/data/layers.js` | HiRISE / CTX orthoimage |
| Thermal inertia layer | `src/data/layers.js` | THEMIS night-time IR derived thermal inertia |
| Mineralogy layer | `src/data/layers.js` | CRISM / OMEGA spectral parameter maps |
| Route, stations, hazards | `src/config/mission.js` | your planned EVA |
| Dose rate | `src/config/mission.js` | MSL/RAD surface measurements |

Each layer exposes `source`, `future` and `legend`, which the UI already displays.

## Project structure

```
docs/api/routing.md   HTTP contract, examples and model assumptions
server/
  start.js            standalone Node server
  routes.js           HTTP handlers and request validation
src/
  routes/pathfinding.js  A* search and live hazard rerouting
  physics/traverse.js    travel time and consumable estimates shared by routing and simulation
  config/mission.js   site, route, stations, area hazards, rover & life-support numbers (mock)
  world/terrain.js    procedural DEM, grid mesh, exact surface sampling
  world/route.js      route spline, hazard analysis, ribbon / beacons / gates
  world/scenery.js    instanced rocks, habitat, ascent vehicle
  world/atmosphere.js Mars sky, image-based lighting, dust motes, wheel dust
  rover/rover.js      cockpit model, suspension, animation
  rover/screens.js    in-cabin displays (canvas textures)
  data/layers.js      data-layer samplers + legends
  sim/mission.js      traverse state machine + consumables
  sim/input.js        keyboard / mouse-look / touch
  ui/hud.js           helmet HUD, cards, map overlay, debrief
  ui/mapRenderer.js   hill-shaded 2D map, nav map, elevation profile
```

## Credits

- Built with [three.js](https://threejs.org/) and [Vite](https://vitejs.dev/).
- Design reference: [TarikurRahmann/Space-Rover-Simulator](https://github.com/TarikurRahmann/Space-Rover-Simulator)
  (MIT) — a Three.js rover with procedural rocks, dust particles and a telemetry HUD. This project
  takes that idea into a first-person cockpit with a route-based survival map.

---

### 日本語メモ

- **今の状態:** NASAデータ未接続。地形・データレイヤーはすべて手続き生成のダミーです。
- **遊び方:** `W` を押し続けるとルートに沿って前進します。危険ゲートで停止したら `Enter` で安全確認、科学ステーションでは `E` を長押ししてタスクを完了します。
- **実データの差し替え先:** 標高は `src/world/terrain.js` の `rawHeight`、各レイヤーは `src/data/layers.js` のサンプラー、ルートや地点は `src/config/mission.js`。

