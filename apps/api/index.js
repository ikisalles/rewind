// The Rewind API = core + the modules enabled here. Every runtime adapter
// (node/, cloudflare/, azion/) builds the app through createRewind().
//
// To add a module: create modules/<id> (see modules/retro), add it as a
// dependency in apps/api/package.json, import it below and add it to MODULES.
// Its web part is registered in apps/web/assets/js/modules.js.

import { createApp, CORE_SHARDS } from '@rewind/core';
import retro from '@rewind/retro/server';
import gmud from '@rewind/gmud/server';

export const MODULES = [retro, gmud];

// Which Durable Object owns each key kind (core + modules), for durableStorage().
export const SHARDS = Object.assign({}, CORE_SHARDS, ...MODULES.map((m) => m.shards));

// consistency: 'eventual' for stores whose reads may lag behind writes (Azion SQL read replicas).
// realtime: live updates (Durable Objects on Cloudflare/Azion, in-memory on Node); optional.
export function createRewind({ storage, env = {}, consistency, realtime }) {
  return createApp({ storage, env, modules: MODULES, consistency, realtime });
}
