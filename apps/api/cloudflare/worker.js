// Cloudflare Workers entry point.
// Static files (dist/web, from `npm run build:web`) are served by Workers Static Assets (binding ASSETS);
// /api/* goes to the Rewind app. Storage: D1 (binding DB, recommended) or KV (binding REWIND_KV).

import { sqlStorage, d1Driver } from '@rewind/core/storage/sql';
import { kvStorage } from '@rewind/core/storage/kv';
import { createRewind } from '../index.js';

let app;

function getApp(env) {
  if (!app) {
    const storage = env.DB ? sqlStorage(d1Driver(env.DB)) : env.REWIND_KV ? kvStorage(env.REWIND_KV) : null;
    if (!storage) throw new Error('Configure a D1 binding "DB" or a KV binding "REWIND_KV"');
    app = createRewind({ storage, env });
  }
  return app;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return getApp(env).fetch(request);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};
