// "My account": the signed-in person's own page. Basic info (read-only for now) and personal
// integrations (Jira, GitHub), whose tokens are write-only: once saved, only their last
// characters are shown.
import { get, post, put, del, patch, session } from '../api.js';
import { THEMES, themeColors, applyTheme } from '../theme.js';
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
  ['password', 'Password', 'lock'],
  ['appearance', 'Appearance', 'palette'],
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
  if (current === 'password') return passwordForm(body);
  if (current === 'appearance') return appearance(body);
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
    managedNotice(),
  );
}

// People who sign in through a provider (the company's SSO or Google/Microsoft/GitHub): their
// account and groups come from there, not from Rewind.
function managedNotice() {
  const { managedBy, teams, user } = store.me;
  if (!managedBy?.length) return null;
  const how = managedBy.join(' and ');
  const groupTeams = teams.filter((t) => t.groupKey && user.teamIds.includes(t.id));
  return h(
    'div',
    { class: 'panel stack-sm managed-notice' },
    h('div', { class: 'managed-head' }, icon('lock', 16), h('strong', {}, `Your account is managed by ${how}`)),
    h('p', { class: 'small' }, `You sign in with ${how}. Your name, email and the groups you belong to come from there, not from Rewind: they are managed in ${how} by your company's administrators. A new name or new groups show up here the next time you sign in.`),
    groupTeams.length
      ? h('p', { class: 'small' }, 'Teams from your groups: ', groupTeams.map((t, i) => [i ? ', ' : '', h('strong', {}, t.name)]), '.')
      : null,
    h('p', { class: 'muted small' }, 'Leaving a group there doesn’t remove you from its team here: ask a Rewind admin.'),
  );
}

// ------------------------------------------------------------------ password
// Change your Rewind password (the current one is asked for), or create one if you have only
// signed in through a provider. Not offered when the company requires its sign-in provider.
function passwordForm(root) {
  const state = store.me.password || { set: true, usable: true };
  if (!state.usable) {
    return mount(
      root,
      h(
        'div',
        { class: 'panel stack-sm managed-notice' },
        h('div', { class: 'managed-head' }, icon('lock', 16), h('strong', {}, 'Your company signs in with its provider')),
        h('p', { class: 'small' }, `${store.me.org.name} requires its sign-in provider, so Rewind passwords aren't used. To change your password, change it there.`),
      ),
    );
  }
  const input = (name, autocomplete, attrs = {}) => h('input', { name, type: 'password', autocomplete, required: true, maxlength: 200, ...attrs });
  const current = state.set ? input('current', 'current-password') : null;
  const next = input('password', 'new-password', { minlength: 8 });
  const confirm = input('confirm', 'new-password', { minlength: 8 });
  const saveBtn = button(state.set ? 'Change password' : 'Create password', { type: 'submit', variant: 'primary' });
  const form = h(
    'form',
    {
      class: 'panel stack',
      onSubmit: async (e) => {
        e.preventDefault();
        confirm.setCustomValidity(next.value === confirm.value ? '' : 'The passwords don’t match');
        if (!form.reportValidity()) return;
        saveBtn.disabled = true;
        const r = await attempt(
          () => put('/api/me/password', { current: current?.value || '', password: next.value }),
          state.set ? 'Password changed' : 'Password created: you can also sign in with your email',
        );
        saveBtn.disabled = false;
        if (!r) return current?.focus();
        store.me.password = { ...state, set: true };
        passwordForm(root);
      },
    },
    h(
      'div',
      {},
      h('h3', {}, state.set ? 'Change password' : 'Create a password'),
      h(
        'p',
        { class: 'muted small' },
        state.set
          ? 'The password you use to sign in to Rewind with your email. You stay signed in on this and your other devices.'
          : 'You sign in through a provider. A Rewind password lets you also sign in with your email.',
      ),
    ),
    current ? field('Current password', current) : null,
    field('New password', next, 'At least 8 characters'),
    field('Confirm new password', confirm),
    h('div', { class: 'form-actions' }, saveBtn),
  );
  confirm.addEventListener('input', () => confirm.setCustomValidity(''));
  mount(root, form);
}

// ------------------------------------------------------------------ appearance
// Your theme, for you only. Picking one only marks it; it's applied when you save.
function appearance(root) {
  const saved = THEMES[store.me.user.theme] ? store.me.user.theme : 'dark';
  let picked = saved;
  const saveBtn = button('Save', { type: 'submit', variant: 'primary', disabled: true });
  const cards = Object.entries(THEMES).map(([id, t]) =>
    h(
      'label',
      { class: `theme-card${id === picked ? ' selected' : ''}`, 'data-theme-id': id },
      h('input', { type: 'radio', name: 'theme', value: id, checked: id === picked, onChange: () => pick(id) }),
      h('span', { class: 'theme-card-head' }, h('strong', {}, t.label), id === saved ? badge('Current', 'accent') : null),
      themeThumbnail(themeColors(id)),
    ),
  );
  const pick = (id) => {
    picked = id;
    for (const c of cards) c.classList.toggle('selected', c.dataset.themeId === id);
    saveBtn.disabled = picked === saved;
  };
  const form = h(
    'form',
    {
      class: 'panel stack',
      onSubmit: async (e) => {
        e.preventDefault();
        const r = await attempt(() => patch('/api/me', { theme: picked }), `${THEMES[picked].label} theme applied`);
        if (!r) return;
        store.me.user.theme = picked;
        applyTheme(picked);
        appearance(root);
      },
    },
    h('div', {}, h('h3', {}, 'Theme'), h('p', { class: 'muted small' }, 'Only for you: everyone in your company picks their own. It changes when you save.')),
    h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme' }, cards),
    h('div', { class: 'form-actions' }, saveBtn),
  );
  mount(root, form);
}

// A small picture of Rewind in a theme's colors: top bar, menu, a card with an accent button.
function themeThumbnail(c) {
  const line = (w, color = c.muted) => h('span', { class: 'tt-line', style: { width: w, background: color } });
  return h(
    'span',
    { class: 'theme-thumb', style: { background: c.bg, borderColor: c.border }, 'aria-hidden': 'true' },
    h('span', { class: 'tt-top', style: { background: c.bg, borderColor: c.border } }, h('span', { class: 'tt-logo', style: { background: c.text } }), h('span', { class: 'tt-avatar', style: { background: c.accent } })),
    h(
      'span',
      { class: 'tt-body' },
      h('span', { class: 'tt-menu', style: { background: c.surface, borderColor: c.border } }, h('span', { class: 'tt-item', style: { background: c.accent + '33' } }), line('70%'), line('55%'), line('62%')),
      h(
        'span',
        { class: 'tt-main' },
        line('40%', c.text),
        h('span', { class: 'tt-card', style: { background: c.surface, borderColor: c.border } }, line('80%', c.text), line('60%'), line('45%', c.link), h('span', { class: 'tt-btn', style: { background: c.accent } })),
        h('span', { class: 'tt-card', style: { background: c.surface2, borderColor: c.border } }, line('70%'), h('span', { class: 'tt-dots' }, h('span', { style: { background: c.success } }), h('span', { style: { background: c.danger } }))),
      ),
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
