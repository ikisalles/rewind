// Live updates for any page: a WebSocket to a channel when the server offers real-time
// (Durable Objects on Azion/Cloudflare, an in-process hub on Node/Docker), polling otherwise
// (and as a safety net). Messages only say "this changed": the page reloads through the API,
// so nobody receives data they couldn't read anyway.
//
//   const stop = keepUpdated(root, refresh, '/api/.../live', { busy, pollMs });
//
// Never repaints while someone is typing in the page, has a window open, or `busy()` says so
// (e.g. dragging a card): the update waits until they're done. Modules import it as
// `@rewind/web/live.js`.
import { get, session, apiUrl } from './api.js';

const POLL_MS = Math.max(2, Number(window.REWIND_CONFIG?.pollSeconds) || 4) * 1000;
const LIVE_FALLBACK_MS = 30_000; // safety poll while the live connection is up

const typing = (root) => {
  const el = document.activeElement;
  return el && root.contains(el) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(el.tagName);
};

let serverConfig;
export const liveAvailable = async () => (serverConfig ??= await get('/api/config').catch(() => ({}))).realtime === true;

// refresh(rev): reloads the page's data; rev is the revision the message announced (0 if none).
export function keepUpdated(root, refresh, liveUrl, { busy: extraBusy = () => false, pollMs = POLL_MS } = {}) {
  let stopped = false;
  let pending = false;
  let lastRefresh = Date.now();
  let ws = null;
  let live = false;
  let retry = 0;
  let reconnect = null;
  let ping = null;
  let pendingRev = 0;

  const busy = () => document.hidden || typing(root) || document.querySelector('.modal-overlay') || extraBusy();
  const run = (rev = 0) => {
    if (stopped || !root.isConnected) return;
    if (busy()) {
      pending = true;
      pendingRev = Math.max(pendingRev, rev);
      return;
    }
    const r = Math.max(pendingRev, rev);
    pending = false;
    pendingRev = 0;
    lastRefresh = Date.now();
    refresh(r).catch(() => {});
  };

  const timer = setInterval(() => {
    if (pending) return run();
    const every = live ? LIVE_FALLBACK_MS : pollMs;
    if (Date.now() - lastRefresh >= every) run();
  }, 1000);

  const connect = async () => {
    if (stopped || !liveUrl || !('WebSocket' in window) || !(await liveAvailable())) return;
    const token = session.get();
    if (!token || stopped) return;
    const url = new URL(apiUrl(liveUrl), location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(url, ['rewind', token]);
    ws.onopen = () => {
      live = true;
      retry = 0;
      ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25_000);
      run(); // catch up on anything that changed while connecting
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let rev = 0;
      try {
        rev = Number(JSON.parse(e.data).rev) || 0;
      } catch {
        /* older message format */
      }
      run(rev);
    };
    ws.onclose = () => {
      live = false;
      clearInterval(ping);
      if (!stopped) reconnect = setTimeout(connect, Math.min(60_000, 1000 * 2 ** retry++));
    };
  };
  connect();

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(reconnect);
    clearInterval(ping);
    ws?.close();
  };
}
