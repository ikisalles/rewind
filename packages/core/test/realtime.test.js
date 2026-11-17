import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RewindRoom } from '../src/realtime/room.js';
import { durableRealtime } from '../src/realtime/durable.js';

// A tiny stand-in for the Workers runtime: WebSocketPair + a hibernation-capable state.
class FakeSocket {
  constructor() {
    this.sent = [];
    this.closed = null;
  }
  send(m) {
    this.sent.push(m);
  }
  close(code, reason) {
    this.closed = { code, reason };
  }
}
globalThis.WebSocketPair = class {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
};
// Workers' Response accepts status 101 + webSocket; Node's doesn't, so mimic it for the test.
const RealResponse = globalThis.Response;

function hibernatingState() {
  const sockets = [];
  return { acceptWebSocket: (ws) => sockets.push(ws), getWebSockets: () => sockets };
}

test('RewindRoom: accepts WebSockets and relays published messages to all of them', async () => {
  globalThis.Response = class extends RealResponse {
    constructor(body, init = {}) {
      super(body, init.status === 101 ? { ...init, status: 200 } : init);
      if (init.status === 101) Object.defineProperty(this, 'status', { value: 101 });
      this.webSocket = init.webSocket;
    }
  };
  try {
    const room = new RewindRoom(hibernatingState(), {});
    const upgrade = () => room.fetch(new Request('https://x/api/sprints/s1/live', { headers: { upgrade: 'websocket' } }));
    const a = await upgrade();
    const b = await upgrade();
    assert.equal(a.status, 101);
    assert.equal(a.headers.get('sec-websocket-protocol'), 'rewind');
    assert.ok(a.webSocket);
    assert.equal((await room.fetch(new Request('https://x/api/sprints/s1/live'))).status, 426);

    const res = await room.fetch(new Request('https://rewind-room/publish', { method: 'POST', body: '{"type":"changed"}' }));
    assert.deepEqual(await res.json(), { sent: 2 });
    for (const ws of room.connections()) assert.deepEqual(ws.sent, ['{"type":"changed"}']);

    // keep-alive
    const [first] = room.connections();
    room.webSocketMessage(first, 'ping');
    assert.equal(first.sent.at(-1), 'pong');
    void b;
  } finally {
    globalThis.Response = RealResponse;
  }
});

test('durableRealtime: one room per channel, publish and connect go to it', async () => {
  const calls = [];
  const namespace = {
    idFromName: (name) => `id:${name}`,
    get: (id) => ({ fetch: async (input, init) => (calls.push([id, typeof input === 'string' ? input : input.url, init?.method || 'GET']), new Response('{}')) }),
  };
  const rt = durableRealtime(namespace);
  await rt.publish('sprint:1', { type: 'changed' });
  await rt.connect(new Request('https://app/api/sprints/1/live'), 'sprint:1');
  assert.deepEqual(calls, [
    ['id:sprint:1', 'https://rewind-room/publish', 'POST'],
    ['id:sprint:1', 'https://app/api/sprints/1/live', 'GET'],
  ]);
});
