# Routing API

Run `npm run api` to serve the JSON endpoints on port 3001 (set `PORT` to change it). The same endpoints are available on the UI origin during `npm run dev` and `npm run preview`. A deployed static Pages client needs a Node host for the API.

**3D and UI handoff.** Send the user's start and end cells as zero-based `[column, row]` pairs. The server loads the mock grid from `public/cost_matrix.json` at startup. It uses the grid format below, plus optional `hazardLabels` keyed by `"column,row"`.

```sh
curl -s http://localhost:3001/api/route-data -H 'Content-Type: application/json' \
  -d '{"start":[12,4],"end":[13,6]}'
```

Draw `path` in order, including both endpoints. Show `oxygen_cost` in minutes of suit supply and `battery_drain` in watt-hours. Each named hazard on the path appears once in `hazard_warnings`. Invalid coordinates return HTTP 400 and an impassable or unreachable endpoint returns HTTP 422. For static demos, `public/route_data.json` contains the response to the example request.

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
