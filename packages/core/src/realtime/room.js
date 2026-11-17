// A real-time room as a Durable Object (Cloudflare interface; Azion Durable Objects use the same).
// One room per channel (e.g. "sprint:<id>"): browsers connect with a WebSocket, the API
// publishes to it after every change, and the room relays the message to everyone connected.
//
// Uses the WebSocket Hibernation API when available (the object sleeps while connections stay
// open), and the standard accept() API otherwise.

export const PROTOCOL = 'rewind';

export class RewindRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Set(); // only without hibernation
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/publish') {
      const message = await request.text();
      let sent = 0;
      for (const ws of this.connections()) {
        try {
          ws.send(message);
          sent++;
        } catch {
          /* closing socket */
        }
      }
      return new Response(JSON.stringify({ sent }), { headers: { 'content-type': 'application/json' } });
    }

    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    if (this.ctx.acceptWebSocket) {
      this.ctx.acceptWebSocket(server);
    } else {
      server.accept();
      this.sockets.add(server);
      server.addEventListener('message', (e) => this.webSocketMessage(server, e.data));
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('error', () => this.sockets.delete(server));
    }
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': PROTOCOL } });
  }

  connections() {
    return this.ctx.getWebSockets ? this.ctx.getWebSockets() : [...this.sockets];
  }

  // keep-alive from the browser
  webSocketMessage(ws, message) {
    if (message === 'ping') ws.send('pong');
  }

  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}
