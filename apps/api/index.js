// The Rewind API = core + the modules enabled here. Every runtime adapter
// (node/, cloudflare/, azion/) builds the app through createRewind().
//
// To add a module: create modules/<id> (see modules/retro), add it as a
// dependency in apps/api/package.json, import it below and add it to MODULES.
// Its web part is registered in apps/web/assets/js/modules.js.

import { createApp } from '@rewind/core';
import retro from '@rewind/retro/server';

export const MODULES = [retro];

export function createRewind({ storage, env = {} }) {
  return createApp({ storage, env, modules: MODULES });
}
