// Real-time inside one process (Node server, Docker, tests). The Node adapter does the
// WebSocket handshake itself: connect() answers with the channel to attach the socket to.
export const UPGRADE_HEADER = 'x-rewind-upgrade';

export function memoryRealtime() {
  const channels = new Map(); // channel -> Set<send(text)>
  return {
    publish(channel, message) {
      const text = JSON.stringify(message);
      for (const send of channels.get(channel) || []) {
        try {
          send(text);
        } catch {
          /* closed socket */
        }
      }
    },
    connect(_request, channel) {
      return new Response(null, { status: 200, headers: { [UPGRADE_HEADER]: channel } });
    },
    subscribe(channel, send) {
      if (!channels.has(channel)) channels.set(channel, new Set());
      channels.get(channel).add(send);
      return () => {
        channels.get(channel)?.delete(send);
        if (!channels.get(channel)?.size) channels.delete(channel);
      };
    },
    size: (channel) => channels.get(channel)?.size || 0,
  };
}
