// The contract every Rewind module follows.
//
//   export default defineModule({
//     id: 'retro',                       // unique; also its key in /api/dashboard
//     name: 'Retro',
//     description: 'Agile retrospectives', // shown in Administration → Modules
//     required: true,                    // can't be turned off by a company (default false)
//     defaultEnabled: true,              // optional modules: on until an admin turns them off (default true)
//     keyPrefixes: ['board:'],           // storage keys that should exist when looked up by id/token;
//                                        //   on eventually consistent stores a miss is read again
//     shards: { note: 'sprint' },        // on Durable Object storage, which object owns each key kind:
//                                        //   "note:<sprintId>:<id>" lives in the object "sprint:<sprintId>"
//     register(core) {                    // called once when the app starts
//       core.route('GET', '/api/boards', handler);
//       return {
//         dashboard: async (c) => data,          // optional: the module's part of /api/dashboard
//         adminDashboard: async (c) => ({       // optional: admin-only part
//           onboarding: { someStep: true },     //   merged into admin.onboarding
//           ...rest,                            //   available as admin[<id>]
//         }),
//         beforeTeamDelete: async (c, teamId) => {}, // optional: throw (fail) to block it
//       };
//     },
//   });
//
// `core` gives the module what it needs from the platform without exposing
// storage keys of other modules: see `services` in app.js.

export function defineModule(mod) {
  if (!mod?.id || !/^[a-z][a-z0-9-]*$/.test(mod.id)) throw new Error('A module needs an id like "retro"');
  if (typeof mod.register !== 'function') throw new Error(`Module ${mod.id} needs a register(core) function`);
  return Object.freeze({ name: mod.id, description: '', required: false, keyPrefixes: [], shards: {}, ...mod });
}
