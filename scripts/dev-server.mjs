// scripts/dev-server.mjs — local preview without the Netlify CLI.
// `node scripts/build.js && node scripts/dev-server.mjs` → http://localhost:8888
// Serves dist/ and runs the edge functions in Node for /api/*. Local only: it
// stamps requests with the production origin so the origin check passes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import search from '../netlify/edge-functions/search.js';
import phd from '../netlify/edge-functions/phd.js';
import stats from '../netlify/edge-functions/stats.js';
import match from '../netlify/edge-functions/match.js';

const API = { '/api/search': search, '/api/phd': phd, '/api/stats': stats, '/api/match': match };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };
const DIST = path.resolve('dist');
const PORT = +process.env.PORT || 8888;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const fn = API[url.pathname];
  if (fn) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = { ...req.headers, origin: 'https://doctum.co.uk' };
    const r = await fn(new Request('https://doctum.co.uk' + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), { ip: req.socket.remoteAddress + Math.random(), site: { name: 'doctum' } });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body) res.write(c);
    return res.end();
  }
  let p = path.join(DIST, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(400); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404, { 'content-type': TYPES['.html'] }); return res.end(fs.readFileSync(path.join(DIST, '404.html'))); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  res.end(fs.readFileSync(p));
}).listen(PORT, () => console.log(`Doctum preview on http://localhost:${PORT}`));
