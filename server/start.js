import { createServer } from 'node:http';
import { routeApi } from './routes.js';

const port = Number(process.env.PORT ?? 3001);
createServer((req, res) => routeApi(req, res, () => {
  res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not_found"}');
})).listen(port, () => console.log('Routing API listening on port', port));
