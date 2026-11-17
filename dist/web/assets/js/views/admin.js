import { get, post, patch, del } from '../api.js';
import { h, mount, button, field, badge, table, modal, avatar, attempt, confirmDialog, copyText, fmtDateTime, icon, toast, pageHeader, section } from '../ui.js';
import { applyTheme, TOKENS, PRESETS, DEFAULT_THEME } from '../theme.js';
import { store, loadMe } from '../app.js';

const TABS = [
  ['company', 'Company', 'building'],
  ['members', 'Members', 'user'],
  ['teams', 'Teams', 'team'],
  ['invites', 'Invites', 'mail'],
  ['appearance', 'Appearance', 'palette'],
];

export async function adminView(root, { params }) {
  if (store.me.user.role !== 'admin') {
    mount(root, pageHeader('Administration'), h('p', { class: 'muted' }, 'Only admins can access this area.'));
    return;
  }
  const tab = params.tab || 'company';
  const body = h('div', {});
  mount(
    root,
    pageHeader('Administration', [], [[store.me.org.name]]),
    h('div', { class: 'tabs' }, TABS.map(([id, label, ic]) => h('a', { href: `#/admin/${id}`, class: `tab${tab === id ? ' active' : ''}` }, icon(ic, 14), label))),
    body,
  );
  const views = { company, members, teams, invites, appearance };
  const reload = () => adminView(root, { params });
  return (views[tab] || company)(body, reload);
}

// ------------------------------------------------------------------ company
async function company(root, reload) {
  const { org } = store.me;
  const form = h(
    'form',
    {
      class: 'stack panel narrow',
      onSubmit: async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        const body = { name: data.name };
        if (org.domain) body.autoJoin = data.autoJoin === 'on';
        if (await attempt(() => patch('/api/org', body), 'Company updated')) {
          await loadMe();
          reload();
        }
      },
    },
    field('Company name', h('input', { name: 'name', value: org.name, required: true, maxlength: 80 })),
    field(
      'Verified domain',
      h('input', { value: org.domain ? `@${org.domain}` : 'None (company created manually)', disabled: true }),
      'The domain is set when the company is created through social sign-in (Google, Microsoft, GitHub).',
    ),
    h(
      'label',
      { class: `switch${org.domain ? '' : ' disabled'}` },
      h('input', { type: 'checkbox', name: 'autoJoin', checked: org.autoJoin, disabled: !org.domain }),
      h('span', { class: 'switch-ui' }),
      h('span', {}, h('strong', {}, 'Automatic sign-in by domain'), h('span', { class: 'muted small block' }, org.domain ? `People with an @${org.domain} email join on their own, in their group's team.` : 'Only available for companies with a verified domain.')),
    ),
    h('div', {}, button('Save', { type: 'submit', variant: 'primary' })),
  );
  mount(root, section('Company', form));
}

// ------------------------------------------------------------------ members
async function members(root, reload) {
  const [{ members: list }, { teams: allTeams }, { requests }] = await Promise.all([get('/api/org/members'), get('/api/teams'), get('/api/org/requests')]);
  const teamName = (id) => allTeams.find((t) => t.id === id)?.name;

  const edit = (m) => {
    const dlg = modal({
      title: `Edit ${m.name}`,
      body: h(
        'form',
        {
          id: 'member-form',
          class: 'stack',
          onSubmit: async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const body = { role: fd.get('role'), teamIds: fd.getAll('teamIds') };
            if (await attempt(() => patch(`/api/org/members/${m.id}`, body), 'Member updated')) {
              dlg.close();
              if (m.id === store.me.user.id) await loadMe();
              reload();
            }
          },
        },
        field('Role', h('select', { name: 'role' }, h('option', { value: 'member', selected: m.role === 'member' }, 'Member'), h('option', { value: 'admin', selected: m.role === 'admin' }, 'Admin'))),
        h('fieldset', { class: 'checks' }, h('legend', {}, 'Teams'), allTeams.map((t) => h('label', {}, h('input', { type: 'checkbox', name: 'teamIds', value: t.id, checked: m.teamIds.includes(t.id) }), t.name))),
      ),
      actions: [
        m.id !== store.me.user.id &&
          button('Remove from company', {
            variant: 'danger-ghost',
            iconName: 'trash',
            onClick: async () => {
              if (!(await confirmDialog(`Remove ${m.name} from the company?`, { danger: true, confirmLabel: 'Remove' }))) return;
              if (await attempt(() => del(`/api/org/members/${m.id}`), 'Member removed')) {
                dlg.close();
                reload();
              }
            },
          }),
        h('button', { class: 'btn btn-primary', type: 'submit', form: 'member-form' }, 'Save'),
      ],
    });
  };

  mount(
    root,
    requests.length ? requestsSection(requests, allTeams, reload) : null,
    section(
      `Members (${list.length})`,
      table(
        ['Name', 'Email', 'Role', 'Teams', 'Sign-in', ''],
        list.map((m) =>
          h(
            'tr',
            {},
            h('td', {}, h('span', { class: 'person' }, avatar(m), m.name)),
            h('td', {}, m.email),
            h('td', {}, m.role === 'admin' ? badge('Admin', 'accent') : badge('Member')),
            h('td', {}, m.teamIds.map(teamName).filter(Boolean).join(', ') || h('span', { class: 'muted' }, '—')),
            h('td', {}, m.providers.length ? m.providers.join(', ') : 'password'),
            h('td', { class: 'right' }, button('', { iconName: 'edit', variant: 'ghost', size: 'xs', title: 'Edit', onClick: () => edit(m) })),
          ),
        ),
      ),
    ),
  );
}

// People who registered this company's name and wait for an admin's decision.
function requestsSection(requests, allTeams, reload) {
  const { org } = store.me;
  const after = async (r, msg) => {
    toast(r.emailSent ? msg : `${msg} (no email sent: email isn't configured)`, r.emailSent ? 'success' : 'info');
    await loadMe();
    reload();
  };

  const approve = (req) => {
    const dlg = modal({
      title: `Approve ${req.name}`,
      body: h(
        'form',
        {
          id: 'approve-form',
          class: 'stack',
          onSubmit: async (e) => {
            e.preventDefault();
            const teamIds = new FormData(e.target).getAll('teamIds');
            if (!teamIds.length) return void toast('Pick at least one team', 'error');
            const r = await attempt(() => post(`/api/org/requests/${req.id}/approve`, { teamIds }));
            if (r) {
              dlg.close();
              after(r, `${req.name} joined ${org.name}`);
            }
          },
        },
        h('p', { class: 'muted small' }, `${req.name} joins as a member and only sees the boards of the teams you pick.`),
        h('fieldset', { class: 'checks' }, h('legend', {}, 'Teams'), allTeams.map((t) => h('label', {}, h('input', { type: 'checkbox', name: 'teamIds', value: t.id, checked: t.id === org.defaultTeamId }), t.name))),
      ),
      actions: [button('Cancel', { onClick: () => dlg.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'approve-form' }, 'Approve')],
    });
  };

  const deny = async (req) => {
    const ok = await confirmDialog(`Deny ${req.name}'s access? They'll get an email and can't register ${org.name} again; they can still register a different company.`, { danger: true, confirmLabel: 'Deny access' });
    if (!ok) return;
    const r = await attempt(() => post(`/api/org/requests/${req.id}/deny`));
    if (r) after(r, `Access denied for ${req.name}`);
  };

  return section(
    `Access requests (${requests.length})`,
    h('p', { class: 'muted small section-hint' }, `These people tried to register a company named "${org.name}". They can only sign in after an admin approves.`),
    table(
      ['Name', 'Email', 'Requested', ''],
      requests.map((req) =>
        h(
          'tr',
          {},
          h('td', {}, h('span', { class: 'person' }, avatar(req), req.name)),
          h('td', {}, req.email),
          h('td', {}, fmtDateTime(req.createdAt)),
          h(
            'td',
            { class: 'right nowrap' },
            button('Deny', { variant: 'danger-ghost', size: 'sm', onClick: () => deny(req) }),
            ' ',
            button('Approve', { variant: 'primary', size: 'sm', iconName: 'check', onClick: () => approve(req) }),
          ),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ teams
async function teams(root, reload) {
  const [{ teams: list }, { members: people }] = await Promise.all([get('/api/teams'), get('/api/org/members')]);
  const count = (id) => people.filter((p) => p.teamIds.includes(id)).length;

  const edit = (team) => {
    const dlg = modal({
      title: team ? 'Edit team' : 'New team',
      body: h(
        'form',
        {
          id: 'team-form',
          class: 'stack',
          onSubmit: async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.target));
            const ok = await attempt(() => (team ? patch(`/api/teams/${team.id}`, data) : post('/api/teams', data)), team ? 'Team updated' : 'Team created');
            if (ok) {
              dlg.close();
              await loadMe();
              reload();
            }
          },
        },
        field('Name', h('input', { name: 'name', value: team?.name || '', required: true, maxlength: 80 })),
        team?.groupKey ? h('p', { class: 'muted small' }, `Synced with the group ${team.groupKey}. Members of that group join this team when they sign in.`) : null,
      ),
      actions: [
        team &&
          team.id !== store.me.org.defaultTeamId &&
          button('Delete', {
            variant: 'danger-ghost',
            iconName: 'trash',
            onClick: async () => {
              if (!(await confirmDialog(`Delete the team ${team.name}?`, { danger: true, confirmLabel: 'Delete' }))) return;
              if (await attempt(() => del(`/api/teams/${team.id}`), 'Team deleted')) {
                dlg.close();
                await loadMe();
                reload();
              }
            },
          }),
        h('button', { class: 'btn btn-primary', type: 'submit', form: 'team-form' }, 'Save'),
      ],
    });
  };

  mount(
    root,
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, 'Teams'), button('New team', { iconName: 'plus', onClick: () => edit(null) })),
      table(
        ['Team', 'Source', 'Members', 'Created', ''],
        list.map((t) =>
          h(
            'tr',
            {},
            h('td', { class: 'strong' }, t.name, t.id === store.me.org.defaultTeamId ? [' ', badge('Default')] : null),
            h('td', {}, t.groupKey ? badge(`Group ${t.groupKey.split(':')[0]}`, 'info') : badge('Manual')),
            h('td', {}, String(count(t.id))),
            h('td', {}, fmtDateTime(t.createdAt)),
            h('td', { class: 'right' }, button('', { iconName: 'edit', variant: 'ghost', size: 'xs', title: 'Edit', onClick: () => edit(t) })),
          ),
        ),
      ),
    ),
  );
}

// ------------------------------------------------------------------ invites
async function invites(root, reload) {
  const [{ invites: list }, { teams: allTeams }] = await Promise.all([get('/api/invites'), get('/api/teams')]);
  const teamName = (id) => allTeams.find((t) => t.id === id)?.name || '—';

  const form = h(
    'form',
    {
      class: 'panel invite-form',
      onSubmit: async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(form));
        const emails = fd.emails.split(/[\s,;]+/).filter(Boolean);
        const r = await attempt(() => post('/api/invites', { emails, teamId: fd.teamId, role: fd.role }));
        if (!r) return;
        if (!r.invites.length) return toast('These people already have accounts', 'error');
        const sent = r.invites.filter((i) => i.emailSent).length;
        modal({
          title: 'Invites created',
          body: h(
            'div',
            { class: 'stack' },
            h('p', { class: 'muted small' }, sent ? `${sent} email(s) sent. You can also copy the links below.` : 'Email sending is not configured. Copy and send the links below.'),
            r.invites.map((i) => h('div', { class: 'copy-row' }, h('span', { class: 'copy-label' }, i.email), h('input', { readonly: true, value: i.url, 'aria-label': `Link for ${i.email}` }), button('', { iconName: 'copy', title: 'Copy', onClick: () => copyText(i.url) }))),
          ),
          onClose: reload,
        });
      },
    },
    field('Emails', h('textarea', { name: 'emails', rows: 2, required: true, placeholder: 'ana@company.com, bia@company.com' }), 'Separate with commas, spaces or new lines.'),
    h(
      'div',
      { class: 'grid-3' },
      field('Team', h('select', { name: 'teamId' }, allTeams.map((t) => h('option', { value: t.id, selected: t.id === store.me.org.defaultTeamId }, t.name)))),
      field('Role', h('select', { name: 'role' }, h('option', { value: 'member' }, 'Member'), h('option', { value: 'admin' }, 'Admin'))),
      h('div', { class: 'align-end' }, button('Send invites', { type: 'submit', variant: 'primary', iconName: 'userPlus' })),
    ),
  );

  mount(
    root,
    section('Invite people', form),
    section(
      `Pending invites (${list.length})`,
      table(
        ['Email', 'Team', 'Role', 'Sent', ''],
        list.map((i) =>
          h(
            'tr',
            {},
            h('td', {}, i.email),
            h('td', {}, teamName(i.teamId)),
            h('td', {}, i.role === 'admin' ? 'Admin' : 'Member'),
            h('td', {}, fmtDateTime(i.createdAt)),
            h(
              'td',
              { class: 'right nowrap' },
              button('', { iconName: 'copy', variant: 'ghost', size: 'xs', title: 'Copy link', onClick: () => copyText(i.url) }),
              button('', {
                iconName: 'trash',
                variant: 'ghost',
                size: 'xs',
                title: 'Revoke',
                onClick: async () => (await attempt(() => del(`/api/invites/${i.token}`), 'Invite revoked')) && reload(),
              }),
            ),
          ),
        ),
        { empty: 'No pending invites.' },
      ),
    ),
  );
}

// ------------------------------------------------------------------ appearance
async function appearance(root) {
  const base = { ...DEFAULT_THEME, ...(window.REWIND_CONFIG?.theme || {}) };
  let theme = { ...base, ...store.me.org.theme };
  const inputs = {};

  const set = (key, value) => {
    theme[key] = value;
    applyTheme(theme);
  };
  const loadPreset = (p) => {
    theme = { ...p };
    for (const { key } of TOKENS) {
      inputs[key].color.value = theme[key];
      inputs[key].hex.value = theme[key];
    }
    applyTheme(theme);
  };

  const rows = TOKENS.map(({ key, label }) => {
    const color = h('input', { type: 'color', value: theme[key], 'aria-label': label });
    const hex = h('input', { class: 'hex', value: theme[key], maxlength: 7, 'aria-label': `${label} (hex)` });
    color.addEventListener('input', () => ((hex.value = color.value), set(key, color.value)));
    hex.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(hex.value)) (color.value = hex.value), set(key, hex.value);
      else hex.value = theme[key];
    });
    inputs[key] = { color, hex };
    return h('div', { class: 'color-row' }, color, h('span', { class: 'color-label' }, label), hex);
  });

  const preview = h(
    'div',
    { class: 'preview panel' },
    h('div', { class: 'preview-top' }, h('span', { class: 'logo-mark small' }, (window.REWIND_CONFIG?.appName || 'Rewind').toUpperCase()), button('Button', { variant: 'primary', size: 'sm' })),
    h('div', { class: 'columns', style: { '--cols': 2 } },
      h('section', { class: 'column', style: { '--col': theme.success } }, h('header', { class: 'column-head' }, h('span', { class: 'col-dot' }), h('h3', {}, 'What went well')), h('article', { class: 'note', style: { '--col': '#22c55e' } }, h('p', { class: 'note-text' }, 'Faster deploys'), h('footer', { class: 'note-foot' }, h('span', { class: 'note-author' }, 'Ana'), h('button', { class: 'vote active' }, icon('heart', 13), '3')))),
      h('section', { class: 'column' }, h('header', { class: 'column-head' }, h('span', { class: 'col-dot' }), h('h3', {}, 'To improve')), h('article', { class: 'note masked' }, h('p', { class: 'note-text' }, h('span', { class: 'redacted' })), h('footer', { class: 'note-foot' }, h('span', { class: 'note-author' }, 'Hidden'))))),
    h('p', {}, badge('Open', 'success', 'check'), ' ', h('a', { href: '#/admin/appearance' }, 'A link')),
  );

  mount(
    root,
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, 'Company colors'), h('div', { class: 'btn-group' }, Object.entries(PRESETS).map(([name, p]) => button(name, { size: 'sm', onClick: () => loadPreset(p) })))),
      h(
        'div',
        { class: 'appearance' },
        h(
          'div',
          { class: 'panel stack-sm' },
          rows,
          h(
            'div',
            { class: 'btn-group' },
            button('Reset to default', { onClick: () => loadPreset(base) }),
            button('Save colors', {
              variant: 'primary',
              onClick: async () => {
                // store only what differs from the deployment default
                const diff = Object.fromEntries(Object.entries(theme).filter(([k, v]) => base[k] !== v));
                if (await attempt(() => patch('/api/org', { theme: diff }), 'Colors saved for the whole company')) await loadMe();
              },
            }),
          ),
        ),
        preview,
      ),
    ),
  );
  // leaving without saving restores the saved theme
  return () => applyTheme(store.me.org.theme);
}
