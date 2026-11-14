import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { routeApi } from './routes.js';

let server, url;
before(async () => {
  server = createServer((req, res) => routeApi(req, res, () => res.writeHead(404).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise(resolve => server.close(resolve)));
const grid = {width:5,height:3,cellSizeM:10,elevationM:Array(15).fill(0)};
const start = {col:0,row:1}, goal = {col:4,row:1};
const storm = {blockedCells:[{col:2,row:1}]};
function post(path, request) {
  return fetch(url + path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
}
test('route and live update use current position, avoid closure and return remaining oxygen and energy costs', async () => {
  const normal = await post('/api/route', {grid,start,goal});
  assert.equal(normal.status, 200);
  const route = await normal.json();
  assert.equal(route.distanceM, 40);
  assert.ok(route.oxygenMinutes > 0 && route.batteryWh > 0);
  const current = {col:1,row:1};
  const diverted = await post('/api/reroute', {grid,current,goal,liveHazard:storm});
  assert.equal(diverted.status, 200);
  const remaining = await diverted.json();
  assert.deepEqual(remaining.path[0], current);
  assert.deepEqual(remaining.path.at(-1), goal);
  assert.ok(!remaining.path.some(cell => cell.col === 2 && cell.row === 1));
  const direct = await (await post('/api/route', {grid,start:current,goal})).json();
  assert.ok(remaining.oxygenMinutes > direct.oxygenMinutes && remaining.batteryWh > direct.batteryWh);
  assert.deepEqual(await (await post('/api/route', {grid,start,goal})).json(), route);
});
test('a storm closing every crossing returns an explicit unreachable response', async () => {
  const blockedCells = [0,1,2].map(row => ({col:2,row}));
  const response = await post('/api/reroute', {grid,current:start,goal,liveHazard:{blockedCells}});
  assert.equal(response.status,422);
  assert.equal((await response.json()).error,'no_route');
});
test('invalid incoming grids and coordinates return 400', async () => {
  for (const body of [
    null, {grid:{...grid,elevationM:[0]},start,goal}, {grid:{...grid,hazardCost:Array(15).fill(-1)},start,goal},
    {grid:{...grid,elevationM:Array(15).fill('0')},start,goal}, {grid:{...grid,cellSizeM:0},start,goal},
    {grid:{...grid,blockedCells:[{col:-1,row:0}]},start,goal}, {grid,start:{col:0.5,row:1},goal}
  ]) assert.equal((await post('/api/route', body)).status,400);
  assert.equal((await post('/api/reroute',{grid,current:start,goal,liveHazard:{}})).status,400);
  const malformed = await fetch(url+'/api/route',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
  assert.equal(malformed.status,400);
});
test('endpoints require JSON POST and leave other paths to the host', async () => {
  assert.equal((await fetch(url+'/api/route')).status,405);
  assert.equal((await fetch(url+'/api/route',{method:'POST',body:'hello'})).status,415);
  assert.equal((await fetch(url+'/other')).status,404);
});
