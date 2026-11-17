// Minimal WebSocket server side for the Node adapter (RFC 6455), no dependencies.
// Enough for live updates: the server pushes text messages; the browser only sends
// "ping" (keep-alive) and close frames. Messages from the browser are not used otherwise.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

// Completes the handshake on a raw socket and returns { send(text), close(), onClose(fn), onText(fn) }.
export function acceptWebSocket(req, socket, { protocol } = {}) {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, protocol ? `Sec-WebSocket-Protocol: ${protocol}` : null]
      .filter(Boolean)
      .join('\r\n') + '\r\n\r\n',
  );
  socket.setNoDelay(true);

  const closeHandlers = [];
  const textHandlers = [];
  let open = true;
  let buffer = Buffer.alloc(0);

  const close = () => {
    if (!open) return;
    open = false;
    try {
      socket.end(frame(0x8));
    } catch {
      /* already gone */
    }
    closeHandlers.forEach((fn) => fn());
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // parse every complete frame in the buffer (browser frames are always masked)
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = buffer[1] & 0x80;
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) return close();
      if (opcode === 0x9) socket.write(frame(0xa, payload)); // ping -> pong
      if (opcode === 0x1) textHandlers.forEach((fn) => fn(payload.toString('utf8')));
    }
  });
  socket.on('close', () => {
    if (open) {
      open = false;
      closeHandlers.forEach((fn) => fn());
    }
  });
  socket.on('error', () => socket.destroy());

  return {
    send: (text) => open && socket.write(frame(0x1, Buffer.from(text, 'utf8'))),
    close,
    onClose: (fn) => closeHandlers.push(fn),
    onText: (fn) => textHandlers.push(fn),
  };
}
