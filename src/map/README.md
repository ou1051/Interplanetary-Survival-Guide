# Mission map & scouting (`src/map/`, Person 3)

The first screen of *Freelance Astronaut*. It has two views behind one app bar:

- **Globe:** a 3D Mars made of real orbital data, with click-to-fly. The player
  finds the assignment area (Vera Rubin Ridge, Gale Crater) on the real planet.
- **Site plan:** the job card, scouting pins, map layers, waypoints and the route
  choice that leads into rehearsal.

```bash
npm run dev            # open http://localhost:5173/map.html
npm test               # routing, physics, API and map checks (npm test -- map for this module)
npm run typecheck
```

Open `/map.html#site` for the synthetic planning grid, or `/map.html#gap` for the
disconnected-site fixture (`#dev` adds a small fixture switch). The globe streams real orbital imagery and terrain.
The site demo runs the same pathfinder as the [routing API](../../docs/api/routing.md)
in the browser, so it also works on a static host. You can select a round trip;
on-foot rehearsal is unavailable in the standalone demo and selecting a route does not approve it.

## 3D globe (`globe/`)

| Layer | Source | Resolution | Deepest level |
| --- | --- | --- | --- |
| Base colour | Viking MDIM 2.1 (NASA/USGS, Mars Trek) | 232 m/px | 7 |
| Colour relief | MOLA + HRSC colour hillshade (Mars Trek) | 200 m/px | 8 |
| Global detail | MRO CTX mosaic, Murray Lab (Esri OnMars) | 5 m/px | 12 |
| Gale detail | MRO CTX block-adjusted mosaic (Mars Trek) | 6 m/px | 12 |
| Assignment detail | MRO HiRISE Curiosity traverse mosaic (Mars Trek) | 25 cm/px source | 16 |
| Jezero detail | MRO HiRISE global mosaic (Esri OnMars) | 25 cm/px source | 17 |
| Relief | Mars 200 m DEM, MOLA + HRSC (Esri OnMars, LERC) | 200 m grid | 7 |
| Relief detail | HiRISE stereo DTM mosaic (Esri OnMars, LERC) | ~1 m grid, where DTMs exist | 15 |

- **Endpoints and levels.** These were read from each service's WMTS capabilities
  or REST metadata. Every limit was then checked by requesting real tiles at the site.
  The CTX metadata advertises level 17, but tiles stop at 12. Requests past a cache's
  end come back without CORS headers, so the levels are capped. The Esri HiRISE
  imagery cache is sparse and has no tile map, so it is only requested inside a
  checked box (Jezero crater).
- **Natural colour (`colorize.ts`, `colorWorker.ts`).** CTX and HiRISE are greyscale.
  Each detail tile keeps its own luminance and takes hue and saturation from the
  Viking colour under it (canvas `color` blending). This runs in a worker on an
  `OffscreenCanvas`. On the main thread, uploading canvases as textures froze
  flights for about 1 s.
- **Lighting and sky.** A studio light follows the camera and gives the disc a soft
  terminator in orbit. It fades out below about 2,000 km, where the photographs'
  own shadows take over. Cesium only builds stars and an atmosphere for Earth, so
  both are created here, with a thin, dust-reddened Mars limb.
- **Relief (`elevation.ts`, `demSource.ts`, `demWorker.ts`).** A custom heightmap
  provider. Fetching, LERC decoding and resampling run in a Web Worker.
  Display level L reads source level L−3, so one source tile serves 64 display tiles.
  HiRISE heights are used where valid and within 250 m of MOLA (that check rejects
  the pyramid's edge artefacts). The tiles are 513 × 513 *posts* (edge-registered).
  Cesium's ArcGIS provider can't be used: it rejects the Mars spatial reference,
  the metadata URL fails CORS, and its 513 × 513 meshes stall refinement.
- **Speed.** Measured in Chrome at 1440 × 900 on a 2× display. Flights used to
  stall for 100–1000 ms at a time, with a heap of about 650 MB. Now the p95 frame
  time is 17.6 ms and the heap is about 190 MB. The render loop pauses while the
  site plan is open. MSAA is skipped on 2× screens.
- **Clicking.** A click anywhere flies the camera to that point in 0.9–1.8 s. Each
  click moves closer; from orbit the view looks straight down, and near the ground it
  tilts to show the relief. Place pins and the *Places* list fly to framed views.
- **No Cesium ion.** No ion services and no access token are used.

## Site plan backdrop (`siteImagery.ts`)

A site with `geo` (the grid centre's latitude and longitude) is drawn on real MRO
HiRISE imagery. The tiles are stitched in metres around the grid, stretched with
percentile levels and tinted with the Viking colour of that ground. A coarse pass
loads first, then a sharp pass (about 16 cm/px) around the grid. The fixture places
its grid on Vera Rubin Ridge. Elevations, pins and stations stay synthetic, and the
legend says which parts are real.

## Design

`tokens.css` holds one token set for both views, based on Apple's Human Interface
Guidelines (dark mode). It covers the system font first (SF Pro on Apple devices,
Inter elsewhere, the same fallback as Puppertino), iOS text styles with SF tracking,
system colours, a 4 pt spacing grid, 44 pt rows, and translucent materials. Blur is
kept to a few small surfaces because it is costly over WebGL. The layout follows
Apple Maps: a centred segmented control, a left sidebar, map controls on the right,
and popovers instead of always-open panels.

## Using it

```ts
import { MissionScreen } from './map';

const screen = new MissionScreen(element, { site, onAction }); // app bar + globe + site plan
screen.update({ run, routes, windows, clock });                 // call on every state change
// or just the planning map: new MissionMap(element, { site, onAction })
```

The map never changes game state. It **emits** actions and waits for the next `update()`.

| Emits (`MapAction`) | When |
| --- | --- |
| `scout { observationId }` | Player confirms a new observation (preview shown first) |
| `setWaypoints { waypoints }` | Add, move (click or drag), reorder or remove a waypoint |
| `setStationOrder { stationIds }` | Reorder the two science stations |
| `chooseRoute { routeId }` | Player picks a route option |
| `startRehearsal { routeId, planRevision }` | "Rehearse route" with a route that is still offered |

| Consumes (`MapInput`) | From |
| --- | --- |
| `site` (constructor) | Person 1 · data pack (`site.json`) |
| `routes: RoutePlan[]`, `routesPending?` | Host supplies complete round-trip options |
| `rehearsalAvailable?` | Set to false if the host cannot start an on-foot rehearsal |
| `run`, `windows`, `clock: ClockPreview` | Person 6 · session and game clock |

`clock.turnAfter(cost)` and `clock.closingAt(turn)` come from game flow, so the preview
and the real turn always use the same calculation. `standInClock` reproduces the agreed
rule (open while `turn ≤ lastOpenTurn`, one turn per new observation) until `src/game/` lands.

## What the screen guarantees

- **Scouting:** a new pin shows its cost and the exact window that would close, or warns
  that it uses up the last one. Reopening a scouted pin is free and shows the same image.
- **Evidence:** the viewer labels each source (archived, derived, simulated or synthetic)
  with its mission, product and scale. A dotted line separates the camera position from
  the pictured feature. Revealed observations tint only their characterised cells.
- **Missing data** is drawn hatched on every layer, can't hold a waypoint and is never shown
  as flat ground.
- **Routes:** one card per option with distance, max segment slope and low-coverage
  distance. The shortest route minimizes surface distance. The terrain-aware route
  minimizes estimated rover travel time, with a 25% penalty for entering a cell that
  no revealed observation characterizes. This penalty does not inflate displayed metres.
  The best value per measure is highlighted only when there is a real choice.
  A single route is shown as "both policies agree". After a scout changes the comparison,
  the card names the observation that changed it.
- **Unreachable stops:** with no routes, the panel names the disconnected stops and rings
  them on the map.
- **Keyboard:** arrows move a cell cursor on the map, Enter acts on the cell, Esc cancels,
  and 1, 2, 3 toggle the layers. Every list is a plain button list for players who find
  precise map clicks hard. Dialogs trap focus and return it when closed.
- **Approval status** reflects the current plan revision (approved / incomplete / plan changed).

## Files

| File | Role |
| --- | --- |
| `contracts.ts` | Stand-ins for the shared types plus the map's own `MapAction` / `MapInput` |
| `MissionScreen.ts` | Toolbar, globe view, site-plan view |
| `tokens.css` · `screen.css` · `map.css` | Design tokens (Apple HIG) and the two views' styles |
| `siteImagery.ts` | Real HiRISE backdrop for geo-referenced sites |
| `MissionMap.ts` | The site planning component (DOM + canvas) |
| `globe/` | `MarsGlobe` (CesiumJS), data catalogue, flight maths, relief worker, colour worker |
| `render.ts` | Stateless canvas renderer |
| `grid.ts` · `scouting.ts` · `compare.ts` | Pure logic (slope, reachability, scout preview, route view models) |
| `dev/fixture.ts` | The **synthetic** 9 × 7 shared example from the plan (no NASA data) |
| `planRoutes.ts` | Joins legs through waypoints and stations back to base; compares shortest surface distance with terrain-aware travel time |
| `dev/demo.ts`, `/map.html` | Demo harness (stand-in for game flow) |

## Swapping in teammates' work

1. **Shared types (Person 6):** replace the bodies in `contracts.ts` with re-exports from `src/shared/`.
2. **Rehearsal:** handle `startRehearsal` in game flow and use the actual walk result to update approval.
3. **Real site (Person 1):** pass the loaded `site.json`, or call `map.setSite(site)`.
   Fill `kind` on each source so the viewer labels archived vs derived correctly.

The site plan and routing API both allow eight-neighbour moves. A diagonal is legal
only if both adjacent side cells are passable.
