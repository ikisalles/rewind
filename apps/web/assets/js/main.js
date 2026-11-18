// Shell: router, layout and menu. Core pages (sign-in, home, administration)
// live here; every other page comes from a module (see modules.js).
import { patch, session } from './api.js';
import { applyTheme } from './theme.js';
import { h, icon, mount, button, modal, avatar, attempt } from './ui.js';
import { APP_NAME, SLOGAN, store, loadMe, logo, footer } from './app.js';
import { MODULES } from './modules.js';
import { loginView, signupView, inviteView, callbackView } from './views/auth.js';
import { homeView } from './views/home.js';
import { adminView } from './views/admin.js';
import { accountView } from './views/account.js';

// --------------------------------------------------------------- modules
// Each module's stylesheet is added once, from the module's own folder.
for (const m of MODULES) {
  for (const href of m.styles) document.head.append(h('link', { rel: 'stylesheet', href: m.base + href }));
}

// --------------------------------------------------------------- routing
const routes = [
  ['/login', loginView, { public: true }],
  ['/signup', signupView, { public: true }],
  ['/invite/:token', inviteView, { public: true }],
  ['/auth/callback', callbackView, { public: true }],
  ['/home', homeView],
  ['/admin', adminView],
  ['/admin/:tab', adminView],
  ['/admin/teams/:teamId', adminView],
  ['/account', accountView],
  ['/account/:section', accountView],
  ['/account/integrations/:provider', accountView],
  ...MODULES.flatMap((m) => m.routes),
];
const aliases = MODULES.flatMap((m) => m.aliases || []);

function matchRoute(path) {
  for (const [pattern, view, opts = {}] of routes) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$');
    const m = path.match(re);
    if (m) return { view, opts, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

let cleanup = null;

async function render() {
  cleanup?.();
  cleanup = null;
  document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());

  const raw = location.hash.slice(1) || '/home';
  const [rawPath, qs] = raw.split('?');
  // modules may keep old links working (e.g. retro: #/retro -> #/boards)
  const path = aliases.reduce((p, [from, to]) => p.replace(from, to), rawPath);
  if (path !== rawPath) return void location.replace(`#${path}${qs ? `?${qs}` : ''}`);
  const query = new URLSearchParams(qs || '');
  const found = matchRoute(path);
  const app = document.getElementById('app');

  if (!found) {
    location.hash = '#/home';
    return;
  }

  if (found.opts.public) {
    applyTheme();
    const page = found.opts.bare ? h('div', { class: 'page-bare' }) : h('div', { class: 'auth-page' });
    mount(app, page);
    cleanup = await found.view(page, { params: found.params, query });
    return;
  }

  if (!session.get()) {
    location.hash = '#/login';
    return;
  }
  if (!store.me) {
    try {
      await loadMe();
    } catch {
      return; // api() already redirects on 401
    }
  }

  const content = h('main', { class: 'content' });
  mount(app, shell(content, path));
  cleanup = await found.view(content, { params: found.params, query });
  maybeOnboarding();
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  document.title = `${APP_NAME} — ${SLOGAN}`;
  render();
});

// --------------------------------------------------------------- layout
function shell(content, path) {
  const { user, org } = store.me;
  const isAdmin = user.role === 'admin';
  const drawer = h('nav', { class: 'drawer', 'aria-label': 'Main menu' });

  const item = (href, label, iconName, count = 0) =>
    h(
      'a',
      { href, class: `drawer-item${path.startsWith(href.slice(1)) ? ' active' : ''}`, onClick: () => toggle(false) },
      icon(iconName),
      label,
      count ? h('span', { class: 'count-pill', title: `${count} pending access request${count === 1 ? '' : 's'}` }, String(count)) : null,
    );

  mount(
    drawer,
    h('div', { class: 'drawer-section' }, 'Navigation'),
    item('#/home', 'Home', 'home'),
    MODULES.flatMap((m) => m.nav.map((n) => item(n.href, n.label, n.icon))),
    isAdmin && [
      h('div', { class: 'drawer-section' }, 'Administration'),
      item('#/admin/company', 'Company', 'building'),
      item('#/admin/modules', 'Modules', 'modules'),
      item('#/admin/members', 'Members', 'user', store.me.pendingRequests),
      item('#/admin/teams', 'Teams', 'team'),
      item('#/admin/invites', 'Invites', 'mail'),
      item('#/admin/appearance', 'Appearance', 'palette'),
    ],
  );

  const backdrop = h('div', { class: 'drawer-backdrop', onClick: () => toggle(false) });
  const toggle = (open) => document.body.classList.toggle('drawer-open', open ?? !document.body.classList.contains('drawer-open'));

  return h(
    'div',
    { class: 'shell' },
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'topbar-left' }, button('', { iconName: 'menu', variant: 'icon', title: 'Menu', onClick: () => toggle() }), logo(), h('span', { class: 'slogan' }, SLOGAN)),
      h(
        'div',
        { class: 'topbar-right' },
        h('span', { class: 'org-chip' }, icon('building', 14), org.name),
        h('a', { href: '#/account', class: `btn btn-icon${path.startsWith('/account') ? ' active' : ''}`, title: 'My account', 'aria-label': 'My account' }, avatar(user, 22)),
      ),
    ),
    drawer,
    backdrop,
    content,
    footer(),
  );
}

// First social sign-up of a company: ask whether colleagues may join automatically.
let asked = false;
function maybeOnboarding() {
  const { user, org } = store.me;
  if (asked || user.onboarding !== 'autoJoin') return;
  asked = true;
  const answer = (autoJoin) =>
    attempt(async () => {
      await patch('/api/org', { autoJoin });
      await loadMe();
      m.close();
    }, autoJoin ? `Automatic sign-in enabled for @${org.domain}` : 'All set, use invites to bring your team in');
  const m = modal({
    title: `Welcome to ${APP_NAME}!`,
    body: h(
      'div',
      { class: 'stack' },
      h('p', {}, 'We created the company ', h('strong', {}, org.name), ' from your account.'),
      h('p', {}, 'Should other people with an ', h('strong', {}, `@${org.domain}`), ' email join automatically when they sign in, straight into their group\'s team?'),
      h('p', { class: 'muted small' }, 'You can change this later in Administration → Company.'),
    ),
    actions: [
      button('No, invite only', { onClick: () => answer(false) }),
      button('Yes, allow it', { variant: 'primary', onClick: () => answer(true) }),
    ],
  });
}
