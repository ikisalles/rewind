// End to end: the Node server's WebSocket endpoint with a real WebSocket client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '../node/server.js');

test('Node server: live updates over a WebSocket', { skip: typeof WebSocket === 'undefined' && 'needs a Node with a global WebSocket client' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rewind-live-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), REWIND_DATA_FILE: join(dir, 'data.json') }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((ok, ko) => {
      proc.stdout.on('data', (d) => String(d).includes('running') && ok());
      proc.on('exit', () => ko(new Error('server exited')));
    });
    const base = `http://127.0.0.1:${port}`;
    const call = async (method, path, body, token) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    };
    const { token } = await call('POST', '/api/auth/signup', { orgName: 'Live Co', name: 'Ana', email: 'ana@live.io', password: 'strong-pass' });
    const me = await call('GET', '/api/me', null, token);
    const { board } = await call('POST', '/api/boards', { name: 'B', teamId: me.org.defaultTeamId }, token);
    const { sprint } = await call('POST', `/api/boards/${board.id}/sprints`, { name: 'S', start: '2026-11-01', end: '2026-11-14', template: 'mad-sad-glad' }, token);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sprints/${sprint.id}/live`, ['rewind', token]);
    await new Promise((ok, ko) => ((ws.onopen = ok), (ws.onerror = () => ko(new Error('could not connect')))));
    assert.equal(ws.protocol, 'rewind');
    const next = () => new Promise((ok) => (ws.onmessage = (e) => ok(e.data)));

    let msg = next();
    ws.send('ping');
    assert.equal(await msg, 'pong');

    msg = next();
    await call('POST', `/api/sprints/${sprint.id}/notes`, { columnId: 'glad', text: 'live' }, token);
    assert.equal(JSON.parse(await msg).type, 'changed');

    // no access without a valid session
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/sprints/${sprint.id}/live`, ['rewind', 'nope']);
    await new Promise((ok) => ((bad.onerror = ok), (bad.onopen = () => ok(assert.fail('should not connect')))));
    ws.close();
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
