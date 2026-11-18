import { get, post, session, apiUrl } from '../api.js';
import { h, mount, button, field, icon, toast, badge } from '../ui.js';
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

// The company's own sign-in buttons (Company settings → Sign-in & SSO).
function companyButtons(sso, orgId, { hint, invite } = {}) {
  if (!sso?.length) return null;
  return h(
    'div',
    { class: 'stack-sm' },
    sso.map((p) => {
      const qs = new URLSearchParams({ org: orgId, ...(hint ? { hint } : {}), ...(invite ? { invite } : {}) });
      return h('a', { class: 'btn btn-primary btn-block', href: apiUrl(`/api/auth/oauth/${p.id}/start?${qs}`) }, icon(p.id === 'github' ? 'github' : p.id === 'oidc' ? 'lock' : 'user'), `Continue with ${p.label}`);
    }),
  );
}

// Sign in: the email first, so people of a company with its own sign-in (SSO) get its buttons.
export async function loginView(root) {
  if (session.get()) return void (location.hash = '#/home');
  const cfg = await loadConfig();
  const emailStep = (prefill = '') =>
    mount(
      root,
      card(
        h('h1', {}, 'Sign in'),
        socialButtons(cfg.providers),
        form(
          async ({ email }) => passwordStep(email, await post('/api/auth/discover', { email })),
          field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email', value: prefill, autofocus: true })),
          button('Continue', { type: 'submit', variant: 'primary', size: 'block' }),
        ),
        cfg.allowSignup && h('p', { class: 'muted small center' }, 'Is your company not on Rewind yet? ', h('a', { href: '#/signup' }, 'Register your company')),
      ),
    );

  const passwordStep = (email, found) => {
    const message = h('div', {});
    const pwForm = found.password
      ? form(
          async (data) => {
            try {
              finish((await post('/api/auth/login', { email, password: data.password })).token);
            } catch (e) {
              if (e.code !== 'sso_required') throw e;
              mount(message, h('p', { class: 'notice small' }, icon('info', 14), e.message));
            }
          },
          field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password', autofocus: !found.sso.length })),
          button('Sign in', { type: 'submit', variant: found.sso.length ? 'default' : 'primary', size: 'block' }),
        )
      : null;
    mount(
      root,
      card(
        h('h1', {}, found.org ? `Sign in to ${found.org.name}` : 'Sign in'),
        h('p', { class: 'muted small' }, email, ' · ', h('button', { type: 'button', class: 'link-btn', onClick: () => emailStep(email) }, 'use another email')),
        companyButtons(found.sso, found.org?.id, { hint: email }),
        found.sso.length && pwForm ? h('div', { class: 'divider' }, h('span', {}, 'or with your password')) : null,
        !found.password ? h('p', { class: 'muted small' }, `${found.org.name} signs in with ${found.sso.map((p) => p.label).join(' or ')}: use your work account.`) : null,
        message,
        pwForm,
      ),
    );
  };

  emailStep();
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
      // what you're accepting: who, which team and which role
      h(
        'dl',
        { class: 'kv invite-summary' },
        h('dt', {}, 'Email'),
        h('dd', {}, invite.email),
        h('dt', {}, 'Team'),
        h('dd', {}, invite.teamName || 'Default team'),
        h('dt', {}, 'Role'),
        h('dd', {}, invite.role === 'admin' ? badge('Admin', 'accent') : badge('Member')),
      ),
      h(
        'p',
        { class: 'muted small' },
        invite.role === 'admin'
          ? 'As an admin you can manage the company: people, teams, invites, modules and appearance, and every board.'
          : "As a member you take part in your team's retros: write notes, vote and follow your action items.",
      ),
      // the company's own sign-in first; the platform's buttons only when the company has none
      invite.sso?.length ? companyButtons(invite.sso, invite.orgId, { hint: invite.email, invite: params.token }) : socialButtons(cfg.providers, params.token),
      invite.password !== false
        ? [
            invite.sso?.length ? h('div', { class: 'divider' }, h('span', {}, 'or create a password')) : null,
            form(
              async (data) => finish((await post(`/api/invites/${params.token}/accept`, data)).token),
              field('Your name', h('input', { name: 'name', required: true, maxlength: 80, autocomplete: 'name' })),
              field('Create a password', h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
              button('Accept invite', { type: 'submit', variant: 'primary', size: 'block' }),
            ),
          ]
        : h('p', { class: 'muted small' }, `${invite.orgName} signs in with ${invite.sso.map((p) => p.label).join(' or ')}: accept the invite with your work account.`),
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
