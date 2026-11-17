import { get, post, session, apiUrl } from '../api.js';
import { h, mount, button, field, icon, toast } from '../ui.js';
import { logo, SLOGAN, store } from '../app.js';

let configCache;
const loadConfig = async () => (configCache ??= await get('/api/config').catch(() => ({ providers: [], allowSignup: true })));

function card(...children) {
  return h('div', { class: 'auth-card' }, h('div', { class: 'auth-brand' }, logo(), h('p', { class: 'slogan' }, SLOGAN)), children);
}

const isLocal = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) || location.hostname.endsWith('.localhost');

function socialButtons(providers, invite) {
  if (!providers.length) {
    // Nothing configured: a hint for whoever runs Rewind locally; deployed instances just hide it.
    if (!isLocal()) return null;
    return h(
      'p',
      { class: 'notice small' },
      icon('info', 14),
      h('span', {}, 'Sign-in with Google, Microsoft or GitHub is not enabled on this server. Whoever runs it can turn it on by setting the provider credentials (see ', h('code', {}, '.env.example'), ').'),
    );
  }
  return h(
    'div',
    { class: 'stack-sm' },
    providers.map((p) =>
      h(
        'a',
        {
          class: 'btn btn-default btn-block',
          href: apiUrl(`/api/auth/oauth/${p.id}/start${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`),
        },
        icon(p.id === 'github' ? 'github' : 'user'),
        `Continue with ${p.label}`,
      ),
    ),
    h('div', { class: 'divider' }, h('span', {}, 'or')),
  );
}

function finish(token) {
  session.set(token);
  store.me = null;
  location.hash = '#/home';
}

function form(onSubmit, ...children) {
  const el = h('form', {
    class: 'stack',
    onSubmit: async (e) => {
      e.preventDefault();
      const btn = el.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(el)));
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    },
  }, children);
  return el;
}

export async function loginView(root) {
  if (session.get()) return void (location.hash = '#/home');
  const cfg = await loadConfig();
  mount(
    root,
    card(
      h('h1', {}, 'Sign in'),
      socialButtons(cfg.providers),
      form(
        async (data) => finish((await post('/api/auth/login', data)).token),
        field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
        button('Sign in', { type: 'submit', variant: 'primary', size: 'block' }),
      ),
      cfg.allowSignup && h('p', { class: 'muted small center' }, 'Is your company not on Rewind yet? ', h('a', { href: '#/signup' }, 'Register your company')),
    ),
  );
}

export async function signupView(root) {
  const cfg = await loadConfig();
  mount(
    root,
    card(
      h('h1', {}, 'Register your company'),
      h('p', { class: 'muted small' }, 'With social sign-in, your company and teams are created automatically from your domain and groups.'),
      socialButtons(cfg.providers),
      form(
        async (data) => {
          const r = await post('/api/auth/signup', data);
          if (r.status === 'pending') return void pendingView(root, r.orgName, data.email);
          finish(r.token);
        },
        field('Company name', h('input', { name: 'orgName', required: true, maxlength: 80 })),
        field('Your name', h('input', { name: 'name', required: true, maxlength: 80, autocomplete: 'name' })),
        field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        field('Password', h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), 'At least 8 characters'),
        button('Create company', { type: 'submit', variant: 'primary', size: 'block' }),
      ),
      h('p', { class: 'muted small center' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Sign in')),
    ),
  );
}

// The company name already exists: the request waits for one of its admins.
function pendingView(root, orgName, email) {
  mount(
    root,
    card(
      h('h1', {}, 'Request sent'),
      h('p', {}, h('strong', {}, orgName), ' is already on Rewind, so an admin needs to approve your access before you can sign in.'),
      h('p', { class: 'muted small' }, "We'll email ", h('strong', {}, email), ' when your request is reviewed. If you meant a different company, register again with another company name.'),
      h('a', { href: '#/login', class: 'btn btn-primary btn-block' }, 'Back to sign in'),
      h('p', { class: 'muted small center' }, h('a', { href: '#/signup', onClick: (e) => (e.preventDefault(), signupView(root)) }, 'Use a different company name')),
    ),
  );
}

export async function inviteView(root, { params }) {
  const [cfg, invite] = await Promise.all([loadConfig(), get(`/api/invites/${params.token}`).catch((e) => ({ error: e.message }))]);
  if (invite.error) {
    mount(root, card(h('h1', {}, 'Invite'), h('p', { class: 'muted' }, invite.error), h('a', { href: '#/login', class: 'btn btn-primary btn-block' }, 'Go to sign in')));
    return;
  }
  mount(
    root,
    card(
      h('h1', {}, `Join ${invite.orgName}`),
      h('p', { class: 'muted small' }, 'Invite for ', h('strong', {}, invite.email), invite.teamName ? [' on the team ', h('strong', {}, invite.teamName)] : null, '.'),
      socialButtons(cfg.providers, params.token),
      form(
        async (data) => finish((await post(`/api/invites/${params.token}/accept`, data)).token),
        field('Your name', h('input', { name: 'name', required: true, maxlength: 80, autocomplete: 'name' })),
        field('Create a password', h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
        button('Accept invite', { type: 'submit', variant: 'primary', size: 'block' }),
      ),
    ),
  );
}

export async function callbackView(root, { query }) {
  const error = query.get('error');
  if (error) {
    mount(root, card(h('h1', {}, "Couldn't sign you in"), h('p', { class: 'muted' }, error), h('a', { href: '#/login', class: 'btn btn-primary btn-block' }, 'Back to sign in')));
    return;
  }
  mount(root, card(h('p', { class: 'muted center' }, 'Signing in...')));
  try {
    finish((await post('/api/auth/exchange', { code: query.get('code') })).token);
  } catch (e) {
    mount(root, card(h('h1', {}, "Couldn't sign you in"), h('p', { class: 'muted' }, e.message), h('a', { href: '#/login', class: 'btn btn-primary btn-block' }, 'Back to sign in')));
  }
}
