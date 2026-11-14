# Interplanetary Survival Guide — Martian Map

NASA Space Apps Challenge · *Interplanetary Survival Guide: Martian Map*

A **first-person 3D survival map** for a Mars EVA. You sit in the driver's seat of an open-frame,
pressurised-suit rover and drive a pre-planned **survival route** across a delta-front landing
site. The route is evaluated against the terrain: steep stretches and hazardous ground become
**hazard gates** you must acknowledge before continuing, and **science stations** stop the rover so
the crew can run their tasks. Consumables (O₂, rover power, radiation dose, comms, walk-back limit)
update as you go.

> ⚠️ **No NASA data is connected yet.** Terrain and data layers are procedural placeholders so the
> UI can be built first. Everything is structured so real datasets can be dropped in (see below).

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

Run `npm run api` to serve the two JSON endpoints on port 3001 (set `PORT` to change it). The same endpoints are available on the UI origin during `npm run dev` and `npm run preview`. A deployed static Pages client needs a Node host for the API.

**Plan a leg** with `POST /api/route`. Role 1 supplies the grid. Coordinates are zero-based cells, with columns increasing east and rows increasing south. `elevationM[row * width + col]` is elevation in metres. Use `null` for missing terrain. Optional `blockedCells` lists impassable cells. Optional `hazardCost` is a row-major array of nonnegative penalties: a value of 1 doubles the search cost of entering that cell.

```sh
curl -s http://localhost:3001/api/route -H 'Content-Type: application/json' -d '{
  "grid": {"width":5,"height":3,"cellSizeM":10,"elevationM":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]},
  "start": {"col":0,"row":1}, "goal": {"col":4,"row":1}
}'
```

**Respond to a storm** with `POST /api/reroute`. Supply the rover's current cell, the same goal and the new closure footprint. Each request uses a grid snapshot. Include previously active closures in `grid.blockedCells` on subsequent updates. The route and consumables are for the remaining leg.

```sh
curl -s http://localhost:3001/api/reroute -H 'Content-Type: application/json' -d '{
  "grid": {"width":5,"height":3,"cellSizeM":10,"elevationM":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]},
  "current": {"col":0,"row":1}, "goal": {"col":4,"row":1},
  "liveHazard": {"blockedCells":[{"col":2,"row":1}]}
}'
```

Both responses include `path` (ordered cells, including both endpoints), surface `distanceM`, `durationSeconds`, `oxygenMinutes` of suit supply consumed, `batteryWh` consumed and `maxSlopeDeg`. The examples above return a 40.0 m direct route (0.148 suit minutes, 3.87 Wh) and a 48.3 m detour (0.179 suit minutes, 4.67 Wh). An unreachable goal or a closed endpoint yields HTTP 422 and `{"error":"no_route"}`. Invalid grids or coordinates yield HTTP 400.

**Model.** Eight-neighbour A* minimizes travel time weighted by the destination-cell hazard penalty and keeps diagonals clear of blocked corners. Per-segment travel time uses surface distance and the rover's slope speed limits (4.5 m/s below 9°, 2.8 m/s from 9°, 1.6 m/s from 15°). The actual drain estimate uses unweighted driving time. The rover's shared energy model draws 110 W for onboard systems and 0.09 Wh per metre for traction, multiplied by `1 + 9 × max(0, sin(pitch))`. Oxygen uses one minute of suit supply per minute driving. These are game estimates for steady travel. Station work, pauses and acceleration are outside the route estimate.

Run `npm run test:routes` for the search, physics and HTTP checks.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` (hold) | drive along the survival route |
| `S` / `↓` / `Space` | brake |
| `A` `D` / `←` `→` | steer inside the route corridor (±5 m) |
| `C` | cruise control |
| `Shift` (hold) | time ×3 |
| `E` (hold) | run the active science task |
| `Enter` | acknowledge a hazard briefing / resume traverse |
| `1`–`4` | data layer: optical · slope · thermal inertia · mineralogy |
| `M` | full route map + elevation profile |
| `L` | headlights · `H` hide HUD · `V` recentre view · `N` mute |
| drag | look around the cabin (double-click to recentre) |

Touch devices get on-screen DRIVE / BRAKE / steer / TASK buttons.

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

The tool is honest about resolution: hazards smaller than the DEM grid are not detected, and the
map says so.

## Connecting real NASA data

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
src/
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
