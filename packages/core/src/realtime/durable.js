// Real-time through Durable Objects: `namespace` is the binding of the RewindRoom class
// (Cloudflare: [[durable_objects.bindings]]; Azion Durable Objects expose the same interface).
export function durableRealtime(namespace) {
  const room = (channel) => namespace.get(namespace.idFromName(channel));
  return {
    publish: (channel, message) => room(channel).fetch('https://rewind-room/publish', { method: 'POST', body: JSON.stringify(message) }),
    // hands the browser's WebSocket upgrade request to the channel's room
    connect: (request, channel) => room(channel).fetch(request),
  };
}
