// The Rewind API = core + the modules enabled here. Every runtime adapter
// (node/, cloudflare/, azion/) builds the app through createRewind().
//
// To add a module: create modules/<id> (see modules/retro), add it as a
// dependency in apps/api/package.json, import it below and add it to MODULES.
// Its web part is registered in apps/web/assets/js/modules.js.

import { createApp, CORE_SHARDS } from '@rewind/core';
import foundation from '@rewind/foundation/server';
import retro from '@rewind/retro/server';
import gmud from '@rewind/gmud/server';
import goals from '@rewind/goals/server';
import feedback from '@rewind/feedback/server';
import metrics from '@rewind/metrics/server';
import issues from '@rewind/issues/server';

// foundation comes first so other modules can rely on its routes being
// registered and its storage keys being read into the shared shard map.
export const MODULES = [foundation, retro, gmud, goals, feedback, metrics, issues];

// Which Durable Object owns each key kind (core + modules), for durableStorage().
export const SHARDS = Object.assign({}, CORE_SHARDS, ...MODULES.map((m) => m.shards));

// consistency: 'eventual' for stores whose reads may lag behind writes (Azion SQL read replicas).
// realtime: live updates (Durable Objects on Cloudflare/Azion, in-memory on Node); optional.
export function createRewind({ storage, env = {}, consistency, realtime }) {
  return createApp({ storage, env, modules: MODULES, consistency, realtime });
}
