// "My account": the signed-in person's own page. Basic info (read-only for now) and personal
// integrations (Jira, GitHub), whose tokens are write-only: once saved, only their last
// characters are shown.
import { get, post, put, del, session } from '../api.js';
import { h, mount, button, field, badge, avatar, attempt, confirmDialog, fmtDateTime, icon, pageHeader } from '../ui.js';
import { store } from '../app.js';

const INTEGRATIONS = {
  jira: {
    name: 'Jira',
    icon: 'jira',
    intro: 'Connect your Jira Cloud account with an API token.',
    help: ['Create a token at ', h('a', { href: 'https://id.atlassian.com/manage-profile/security/api-tokens', target: '_blank', rel: 'noopener' }, 'id.atlassian.com → Security → API tokens'), '.'],
    fields: [
      ['site', 'Jira site', { placeholder: 'your-company.atlassian.net', required: true }, 'The address you use to open Jira.'],
      ['email', 'Atlassian account email', { type: 'email', placeholder: 'you@company.com', required: true }, 'Jira Cloud tokens work together with the email of the account that created them.'],
    ],
  },
  github: {
    name: 'GitHub',
    icon: 'github',
    intro: 'Connect your GitHub account with a personal access token.',
    help: ['Create a fine-grained token at ', h('a', { href: 'https://github.com/settings/personal-access-tokens', target: '_blank', rel: 'noopener' }, 'GitHub → Settings → Developer settings → Personal access tokens'), '.'],
    fields: [],
  },
};

const SECTIONS = [
  ['profile', 'Basic info', 'user'],
  ['integrations', 'Integrations', 'plug', Object.entries(INTEGRATIONS).map(([id, i]) => [`integrations/${id}`, i.name, i.icon])],
];

export async function accountView(root, { params }) {
  const current = params.provider ? `integrations/${params.provider}` : params.section || 'profile';
  const navItem = ([id, label, ic], sub = false) =>
    h('a', { href: `#/account/${id}`, class: `side-item${sub ? ' sub' : ''}${current === id ? ' active' : ''}` }, icon(ic, 14), label);
  const body = h('div', { class: 'account-body' });
  mount(
    root,
    pageHeader('My account', [button('Sign out', { variant: 'danger', iconName: 'logout', onClick: signOut })]),
    h(
      'div',
      { class: 'account-layout' },
      h('nav', { class: 'side-nav', 'aria-label': 'My account' }, SECTIONS.map(([id, label, ic, children]) => [navItem([id, label, ic]), (children || []).map((c) => navItem(c, true))])),
      body,
    ),
  );
  if (params.provider) {
    if (!INTEGRATIONS[params.provider]) return void (location.hash = '#/account/integrations');
    return integrationForm(body, params.provider);
  }
  if (current === 'integrations') return integrationsOverview(body);
  return profile(body);
}

async function signOut() {
  await post('/api/auth/logout').catch(() => {});
  session.clear();
  store.me = null;
  location.hash = '#/login';
  location.reload();
}

// ------------------------------------------------------------------ basic info
function profile(root) {
  const { user, org } = store.me;
  mount(
    root,
    h(
      'div',
      { class: 'panel stack' },
      h('div', { class: 'account-head' }, avatar(user, 48), h('div', {}, h('strong', {}, user.name), h('div', { class: 'muted small' }, user.email))),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'Name'), h('dd', {}, user.name),
        h('dt', {}, 'Email'), h('dd', {}, user.email),
        h('dt', {}, 'Company'), h('dd', {}, org.name),
        h('dt', {}, 'Role'), h('dd', {}, user.role === 'admin' ? badge('Admin', 'accent') : badge('Member')),
      ),
      h('p', { class: 'muted small' }, icon('lock', 12), ' Editing these details is not available yet.'),
    ),
  );
}

// ------------------------------------------------------------------ integrations
async function integrationsOverview(root) {
  mount(root, h('p', { class: 'muted' }, 'Loading…'));
  const { integrations } = await get('/api/me/integrations');
  mount(
    root,
    h('p', { class: 'muted' }, 'Personal connections to other tools. Only you can use your tokens, and they are never shown again after saving.'),
    h(
      'div',
      { class: 'integration-list' },
      Object.entries(INTEGRATIONS).map(([id, i]) =>
        h(
          'a',
          { href: `#/account/integrations/${id}`, class: 'panel integration-card' },
          icon(i.icon, 20),
          h('div', { class: 'grow' }, h('strong', {}, i.name), h('div', { class: 'muted small' }, i.intro)),
          integrations[id]?.configured ? badge('Connected', 'success', 'check') : badge('Not connected'),
        ),
      ),
    ),
  );
}

async function integrationForm(root, id) {
  const spec = INTEGRATIONS[id];
  mount(root, h('p', { class: 'muted' }, 'Loading…'));
  const saved = (await get('/api/me/integrations')).integrations[id];
  const render = (state) => {
    const form = h(
      'form',
      {
        class: 'panel stack narrow',
        onSubmit: async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(form));
          const res = await attempt(() => put(`/api/me/integrations/${id}`, data), `${spec.name} token saved`);
          if (res) render(res.integrations[id]);
        },
      },
      h(
        'div',
        { class: 'panel-head' },
        h('div', {}, h('h3', {}, icon(spec.icon, 14), ' ', spec.name), h('p', { class: 'muted small' }, spec.intro)),
        state.configured ? badge('Connected', 'success', 'check') : badge('Not connected'),
      ),
      spec.fields.map(([name, label, attrs, hint]) => field(label, h('input', { name, value: state[name] || '', maxlength: 200, ...attrs }), hint)),
      field(
        'Token',
        h('input', {
          name: 'token',
          type: 'password',
          autocomplete: 'off',
          maxlength: 2000,
          required: !state.configured,
          placeholder: state.configured ? `Saved (${state.tokenHint}). Type a new one to replace it.` : 'Paste the token',
        }),
        h('span', {}, ...spec.help),
      ),
      state.configured ? h('p', { class: 'muted small' }, `Last updated ${fmtDateTime(state.updatedAt)}.`) : null,
      h(
        'div',
        { class: 'form-actions' },
        button(state.configured ? 'Save changes' : 'Save token', { type: 'submit', variant: 'primary' }),
        state.configured
          ? button('Disconnect', {
              variant: 'danger-ghost',
              iconName: 'trash',
              onClick: async () => {
                if (!(await confirmDialog(`Remove your ${spec.name} token?`, { confirmLabel: 'Disconnect', danger: true }))) return;
                const res = await attempt(() => del(`/api/me/integrations/${id}`), `${spec.name} disconnected`);
                if (res) render(res.integrations[id]);
              },
            })
          : null,
      ),
    );
    mount(root, form);
  };
  render(saved);
}
