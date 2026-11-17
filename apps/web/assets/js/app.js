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
  applyTheme(store.me.org.theme);
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
    h('span', { class: 'status-line' }, SLOGAN.toUpperCase()),
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
//     home: {                                        // optional widgets for the home page; ctx = { data, refresh }
//       actions: (ctx) => [nodes],                   //   buttons next to the greeting
//       metrics: (ctx) => [[label, value, unit?]],   //   tiles in "Overview"
//       onboarding: (ctx) => [{ key, title, hint, href | onClick }], // admin checklist; done = data.admin.onboarding[key]
//       housekeeping: (ctx) => [{ icon, title, hint, href, cta }],  // admin rows
//       sections: (ctx) => [nodes],                  //   the module's own sections
//     },
//   });

export function defineWebModule(mod) {
  if (!mod?.id) throw new Error('A web module needs an id');
  return Object.freeze({ routes: [], nav: [], styles: [], home: {}, ...mod, base: `./modules/${mod.id}/` });
}
