// Shared web context for the shell and every module: config, the signed-in
// person, brand pieces and the module contract. Modules import it as
// `@rewind/web/app.js` (see the import map in index.html).

import { get } from './api.js';
import { applyTheme } from './theme.js';
import { h, icon } from './ui.js';

export const cfg = window.REWIND_CONFIG || {};
export const APP_NAME = cfg.appName || 'Rewind';
export const SLOGAN = cfg.slogan || 'listening to and giving a voice to the team';

// Shared app state: the signed-in person, their company and its teams.
export const store = { me: null };

export async function loadMe() {
  store.me = await get('/api/me');
  applyTheme(store.me.user.theme); // each person's own theme
  return store.me;
}

export const isAdmin = () => store.me?.user.role === 'admin';

export function logo() {
  return h('a', { class: 'logo', href: '#/home', 'aria-label': APP_NAME }, h('span', { class: 'logo-mark' }, APP_NAME.toUpperCase()));
}

export function footer() {
  return h(
    'footer',
    { class: 'footer' },
    h('span', {}, `© ${new Date().getFullYear()} ${APP_NAME}`),
    h(
      'nav',
      { class: 'footer-links' },
      h('a', { href: cfg.repoUrl || '#', target: '_blank', rel: 'noopener' }, 'Source code'),
      h('a', { href: '#/home' }, 'Home'),
      h('a', { href: cfg.repoUrl || '#', target: '_blank', rel: 'noopener', class: 'btn btn-icon', 'aria-label': 'GitHub' }, icon('github')),
    ),
    h('span', { class: 'footer-slogan' }, SLOGAN),
  );
}

// ---------------------------------------------------------------- module contract
//
//   export default defineWebModule({
//     id: 'retro',                                   // same id as the server module
//     name: 'Retro',
//     styles: ['retro.css'],                         // relative to the module's web folder
//     routes: [['/boards', boardsView], ['/s/:token', publicView, { public: true, bare: true }]],
//     nav: [{ href: '#/boards', label: 'Boards', icon: 'board' }],
//     navSection: 'Change management',              // optional: the menu items get their own section
//     admin: [{ id: 'gmuds', label: 'GMUDs', icon: 'change', view: (root, reload) => {} }], // optional:
//                                                    //   tabs in Administration (admins only, while the module is on)
//     home: {                                        // optional widgets for the home page; ctx = { data, refresh }
//       actions: (ctx) => [nodes],                   //   buttons next to the greeting
//       metrics: (ctx) => [[label, value, unit?]],   //   tiles in "Overview"
//       onboarding: (ctx) => [{ key, title, hint, href | onClick }], // admin checklist; done = data.admin.onboarding[key]
//       housekeeping: (ctx) => [{ icon, title, hint, href, cta }],  // admin rows
//       sections: (ctx) => [nodes],                  //   the module's own sections
//     },
//     slots: {                                       // optional: pieces shown inside another module's pages,
//       'retro.board': (ctx) => [nodes],             //   at the named extension points that module offers
//                                                    //   (a point may accept promises; see the offering module)
//     },                                             //   (only while this module is on for the company)
//   });

const defined = [];
export function defineWebModule(mod) {
  if (!mod?.id) throw new Error('A web module needs an id');
  // the module's folder, relative to this file: works in development and in versioned builds (_v/<hash>/)
  const out = Object.freeze({ routes: [], nav: [], styles: [], home: {}, admin: [], slots: {}, ...mod, base: new URL(`../../modules/${mod.id}/`, import.meta.url).href });
  defined.push(out);
  return out;
}

// What the enabled modules contribute to an extension point (see "slots" above).
// The module offering the point only knows its name, never who fills it.
export function slot(point, ctx) {
  return defined.filter((m) => m.slots[point] && store.me?.modules?.includes(m.id)).flatMap((m) => m.slots[point](ctx) || []);
}

// Administration tabs added by the modules the company has on.
export function moduleAdminTabs(modules) {
  return modules.filter((m) => store.me?.modules?.includes(m.id)).flatMap((m) => m.admin);
}
