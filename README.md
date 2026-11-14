# Freelance Astronaut — Martian Map

NASA Space Apps Challenge · *Interplanetary Survival Guide: Martian Map*

You are a space enthusiast on your **first paid assignment**: survey four science stations at a
delta-front landing site and decide when to launch. The game follows the Freelance Astronaut plan:

1. **Mission map** (opens first): scout sites to reveal ground views and hidden hazards. Each new
   site costs one preparation turn, and launch windows close as turns pass.
2. **Choose a route**: compare the *survival route* and the *direct route* by length, climb,
   max tilt, hazard gates and unscouted ground.
3. **Rehearse** the chosen route in the first-person 3D rover (the original Martian Map traverse),
   in the surface visibility forecast for the window you pick. A complete round trip with O₂ in
   reserve approves the surface plan; changing the route or scouting new ground on it clears it.
4. **Launch desk**: compare three fictional windows (Earth weather at departure, Mars at arrival
   and during the traverse). Launch, hold for a forecast update, or defer.
5. **Liftoff** and a decision debrief, then *Retry same weather* or *New weather*.

> The rover terrain, route grid, ground views and weather are synthetic placeholders. The separate
> scouting globe (`/map.html`) streams real Mars imagery and elevation.

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
docs/api/routing.md   HTTP contract, examples and model assumptions
server/
  start.js            standalone Node server
  routes.js           HTTP handlers and request validation
src/
  routes/pathfinding.js  A* search and live hazard rerouting
  physics/traverse.js    travel time and consumable estimates shared by routing and simulation
  config/mission.js   site, routes (survival + direct), stations, scouting sites, hazards (mock)
  sim/routeApi.js     asks the routing API for the planner route over the 3D terrain grid
  data/scenarios.js   launch-window weather scenarios (simulated; LLM output later)
  sim/game.js         the player's run: turns, scouting, route choice, approval, hold, launch
  ui/planner.js       mission map: scouting, route comparison, rehearsal conditions
  ui/launchDesk.js    three launch windows, hold / defer / launch
  ui/finale.js        liftoff animation + decision debrief
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
