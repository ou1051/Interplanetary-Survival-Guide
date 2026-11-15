# Interplanetary Survival Guide — Martian Map

**Team Gohan · NASA Space Apps Heilbronn 2026**

[Play the prototype](https://ou1051.github.io/Interplanetary-Survival-Guide/) · [View the demo slides (PDF)](https://ou1051.github.io/Interplanetary-Survival-Guide/demo/martian-map.pdf) · [Official challenge: Interplanetary Survival Guide: Martian Map](https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/)

At Gale Crater, would you take the 2.37 km route over steeper ground or drive another 680 m for a gentler crossing? In this browser-based Marswalk rehearsal, you choose a route in the habitat, drive it, and decide how much science you can do before you need to head home. The map brings orbital imagery and elevation into the same decision as science stops and simulated oxygen, daylight, and battery limits.

## Try a mission

1. **Enter habitat → Review route.** Pick one of five sites on the globe: Gale Crater, Jezero Crater, Aeolis Mons (Mount Sharp), Valles Marineris, or Olympus Mons. Start with **Gale Crater · Vera Rubin Ridge** to reproduce the example below.
2. Select **Open Route Briefing → Find Safest Path**. The planner compares three round trips through the same four science stops. At Gale, **Safest** shows 3.05 km and a maximum modeled slope of 9.4°; **Balanced**, 2.59 km and 12.4°; **Direct Shortest**, 2.37 km and 35.4°. Toggle **View Site Analysis** to inspect the terrain behind the choice.
3. Select a route and **Go outside · Deploy Rover**. Press **M** for the map or **P** for the wrist navigator. Stop the rover and press **F** to get out. Hold **E** near a find to collect it, then return to the habitat and press **Enter** to see what you brought back.

## NASA data and what we simulate

| Source | What it contributes |
| --- | --- |
| [Mars Reconnaissance Orbiter: HiRISE Gale stereo terrain and orbital image](https://www.uahirise.org/dtm/dtm.php?ID=PSP_009149_1750) · NASA/JPL-Caltech/University of Arizona, distributed through [USGS](https://stac.astrogeology.usgs.gov/docs/data/mars/hirise_dtms/) | A 640 m Gale crop (elevation resampled at 4 m) contributes relief and image detail at Vera Rubin Ridge. The site pipeline blends these inputs with regional terrain and Context Camera (CTX) imagery; route-card slopes are estimates from the resulting model. |
| [NASA Mars Trek](https://trek.nasa.gov/mars/) and [NASA’s Mars globe assets](https://github.com/nasa/NASA-3D-Resources) | Orbital imagery provides regional context. The globe combines Viking/MOLA colour with Mars Global Surveyor laser-altimeter (MOLA) relief to place the five sites on the planet. |
| [Curiosity Mastcam, Sol 1790, PIA21851](https://science.nasa.gov/photojournal/looking-up-at-layers-of-vera-rubin-ridge-on-sol-1790/) · NASA/JPL-Caltech/MSSS | The panorama shows sedimentary layers at Vera Rubin Ridge and gives the Gale sampling tasks a geological reference. It is a regional observation, not a photo from a simulated station. |

The planner estimates route costs from processed terrain and modeled hazards. The drive uses simplified relief scaled for the rehearsal; the Jezero driving terrain is procedural. Habitats, station placements, weather, life support, and sample results are simulated. These estimates are for comparing choices in the game, not for navigating on Mars.

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

## Routing API

Run `npm run api` to plan a route or recalculate the remaining leg after a hazard update. For grid fields, consumable units and runnable requests, see the [routing API reference](docs/api/routing.md).

## Controls

The planned route is a guide, not a rail: drive and walk anywhere. At a science station, complete the planned instrument observations or get out and collect its assigned finds on foot. To choose a particular instrument, hold its row in the station card. The row shows the result or explains what blocks the work. Release before starting another task. Rarer finds hide away from the route. Unsurveyed ground can hide an obstacle that stops the rover until you deal with it (Enter). When a station is done and more lie ahead, pick the next leg on the wrist navigator (`P`). Return to the habitat and press Enter to end the EVA.

| Key | Driving | On foot |
| --- | --- | --- |
| `W` / `↑` | drive | walk forward |
| `S` / `↓` / `Space` | brake (hold at a standstill to reverse) | walk back (`S` / `↓`) |
| `A` `D` / `←` `→` | steer | step sideways |
| `Shift` (hold) | time ×3 · short boost that refills; off on hazard ground and near a station | run |
| `F` | get out (rover stopped) | board the rover (within 3 m) |
| `E` (hold) | run the next instrument task while parked at a station | collect the find in reach, or run the next station task |
| `T` | view: first person → third person → overhead | same |
| `I` | artifact collection | same |
| `C` | cruise control | |
| `Enter` | deal with an obstacle · end the EVA at the habitat · open the leg check | same |
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
  co-pilot astronaut in a procedural Apollo-style EVA suit (your own suited legs below you), hand controller that follows your input, and four live displays — heading-up
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

## Simulation layers

In the rover, the optical, thermal-inertia and mineralogy scanner colours are illustrative; they do not represent measured THEMIS temperatures or CRISM mineral detections. The scanner samplers and legends are in [src/data/layers.js](src/data/layers.js).

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
  data/galeSite.js    archived Gale terrain and Curiosity reference
  data/siteDatasets.js site assets, stations and driveable terrain
  ui/siteTopology.js  globe, site briefing and three route policies
  world/terrain.js    terrain mesh and surface sampling
  world/route.js      route spline, hazard analysis, ribbon / beacons / gates
  world/scenery.js    instanced rocks, habitat, ascent vehicle
  world/atmosphere.js Mars sky, image-based lighting, dust motes, wheel dust
  rover/rover.js      cockpit model, suspension, animation
  rover/screens.js    in-cabin displays (canvas textures)
  rover/suitGeometry.js  procedural EVA suit (folds, bent-knee legs, backpack, visor), no three.js
  rover/astronaut.js  three.js meshes for the suit, seated co-pilot and driver's legs
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

- **データ:** ゲール・クレーターの地形には HiRISE の標高データと軌道画像を使用しています。Curiosity の写真は地層を理解するための地域資料です。表示される斜度はモデルによる推定値で、天候、酸素消費、採取結果はシミュレーションです。
- **遊び方:** 「Enter habitat」→「Review route」で地点を選び、「Open Route Briefing」→「Find Safest Path」でルートを比較してから出発します。停車中に `F` で降車し、試料のそばで `E` を長押しして採取します。
