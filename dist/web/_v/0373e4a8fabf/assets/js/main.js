// Shell: router, layout and menu. Core pages (sign-in, home, administration)
// live here; every other page comes from a module (see modules.js).
import { apiUrl, del, patch, session } from './api.js';
import { applyTheme } from './theme.js';
import { h, icon, mount, button, modal, avatar, attempt } from './ui.js';
import { APP_NAME, SLOGAN, store, loadMe, logo, footer } from './app.js';
import { MODULES } from './modules.js';
import { loginView, signupView, inviteView, callbackView } from './views/auth.js';
import { homeView } from './views/home.js';
import { adminView } from './views/admin.js';
import { accountView } from './views/account.js';

// the theme this browser remembers, before anything paints (each person's own, see theme.js)
applyTheme();

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
  // a module's pages only open when the company has the module on (see Administration → Modules)
  ...MODULES.flatMap((m) => m.routes.map(([p, view, opts = {}]) => [p, view, { ...opts, module: m.id }])),
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

  if (found.opts.module && !store.me.modules?.includes(found.opts.module)) {
    location.hash = '#/home';
    return;
  }

  const content = h('main', { class: 'content' });
  mount(app, shell(content, path));
  cleanup = await found.view(content, { params: found.params, query });
  maybeOnboarding();
  maybeSignInNotice();
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
  const enabled = MODULES.filter((m) => store.me.modules?.includes(m.id));

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
    h('div', { class: 'drawer-section' }, 'Workspace'),
    item('#/home', 'Home', 'home'),
    // modules without a navSection go under Workspace; the others get their own section
    enabled.filter((m) => !m.navSection).flatMap((m) => m.nav.map((n) => item(n.href, n.label, n.icon))),
    enabled.filter((m) => m.navSection).map((m) => [h('div', { class: 'drawer-section' }, m.navSection), m.nav.map((n) => item(n.href, n.label, n.icon))]),
    isAdmin && [
      h('div', { class: 'drawer-section' }, 'Administration'),
      // one entry: every company setting lives in that page (see views/admin.js)
      item('#/admin', 'Company settings', 'settings', store.me.pendingRequests),
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
      h('div', { class: 'topbar-left' }, button('', { iconName: 'menu', variant: 'icon', title: 'Menu', onClick: () => toggle() }), logo()),
      h(
        'div',
        { class: 'topbar-right' },
        // the company's logo when it has a sign-in connected (see Company settings → Company)
        h('span', { class: 'org-chip' }, org.logo?.url ? h('img', { class: 'org-logo', src: apiUrl(org.logo.url), alt: '', width: 16, height: 16 }) : icon('building', 14), org.name),
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
      h('p', { class: 'muted small' }, 'You can change this later in Company settings → Company.'),
    ),
    actions: [
      button('No, invite only', { onClick: () => answer(false) }),
      button('Yes, allow it', { variant: 'primary', onClick: () => answer(true) }),
    ],
  });
}

// The company changed how it signs in (Company settings → Sign-in & SSO): tell each person once.
let noticeShown = false;
function maybeSignInNotice() {
  const { user, org } = store.me;
  const n = user.notice;
  if (noticeShown || n?.type !== 'signin') return;
  noticeShown = true;
  const how = n.providers.join(' or ');
  const close = async () => {
    await del('/api/me/notice').catch(() => {});
    user.notice = null;
    m.close();
  };
  const m = modal({
    title: `${org.name} now signs in with ${how}`,
    body: h(
      'div',
      { class: 'stack' },
      h('p', {}, h('strong', {}, n.by || 'An admin'), ` set up ${how} for ${org.name}. Next time, type your email `, h('strong', {}, user.email), ' on the sign-in page and choose ', h('strong', {}, `Continue with ${n.providers[0]}`), ', using your work account.'),
      n.required && user.role !== 'admin' ? h('p', {}, 'Your Rewind password no longer works for this company.') : null,
      n.required && user.role === 'admin' ? h('p', { class: 'muted small' }, 'As an admin you keep your password for emergencies.') : null,
      h('p', { class: 'muted small' }, 'Everything you had on Rewind stays the same.'),
    ),
    actions: [button('Got it', { variant: 'primary', onClick: close })],
    onClose: () => del('/api/me/notice').catch(() => {}),
  });
}

