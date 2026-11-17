// Local server: serves the web app (shell + modules, straight from the sources)
// and the API on the same port.
//   npm start            (data saved to .data/rewind.json)
// Environment variables are read from process.env (see .env.example).

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryStorage } from '@rewind/core/storage/memory';
import { memoryRealtime, UPGRADE_HEADER } from '@rewind/core/realtime/memory';
import { createRewind } from '../index.js';
import { acceptWebSocket } from './websocket.js';
import { webMounts, renderIndex, resolveFile } from '../../../scripts/web-layout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mounts = webMounts();
const shellDir = mounts[0].dir;
const dataFile = process.env.REWIND_DATA_FILE || join(root, '.data/rewind.json');
const port = Number(process.env.PORT || 8787);

// load .env if present (no dependency needed)
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// Memory storage persisted to a JSON file after every write.
const initial = existsSync(dataFile) ? JSON.parse(await readFile(dataFile, 'utf8')) : {};
const mem = memoryStorage(initial);
let saving = Promise.resolve();
const persist = () =>
  (saving = saving.then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    await writeFile(dataFile, JSON.stringify(Object.fromEntries(mem.data)));
  }));
const storage = {
  ...mem,
  put: async (...a) => (await mem.put(...a), persist()),
  delete: async (...a) => (await mem.delete(...a), persist()),
};

// live updates inside this process (one Node server = one set of connected browsers)
const realtime = memoryRealtime();
const app = createRewind({ storage, env: process.env, realtime });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    let file = resolveFile(decodeURIComponent(url.pathname), mounts);
    if (file && url.pathname.endsWith('/')) file = join(file, 'index.html');
    if (!file || !existsSync(file)) file = join(shellDir, 'index.html');
    let body = await readFile(file);
    if (file === join(shellDir, 'index.html')) body = renderIndex(body.toString('utf8'), mounts);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    console.error(e);
    res.writeHead(500).end('error');
  }
});

// WebSocket upgrades (live updates): the API checks access, then the socket joins the channel.
server.on('upgrade', async (req, socket) => {
  const refuse = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/')) return refuse(404, 'Not Found');
    const response = await app.fetch(new Request(url, { method: 'GET', headers: req.headers }));
    const channel = response.headers.get(UPGRADE_HEADER);
    if (!channel) return refuse(response.status, response.statusText || 'Refused');
    const ws = acceptWebSocket(req, socket, { protocol: 'rewind' });
    const unsubscribe = realtime.subscribe(channel, ws.send);
    ws.onText((text) => text === 'ping' && ws.send('pong'));
    ws.onClose(unsubscribe);
  } catch (e) {
    console.error(e);
    refuse(500, 'Internal Server Error');
  }
});

server.listen(port, () => console.log(`Rewind running at http://localhost:${port}`));
