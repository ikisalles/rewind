import { api, apiUrl, get, post, patch, del } from '../api.js';
import { h, mount, button, field, badge, table, modal, avatar, attempt, confirmDialog, copyText, fmtDateTime, icon, toast, pageHeader, section } from '../ui.js';
import { store, loadMe, moduleAdminTabs } from '../app.js';
import { MODULES } from '../modules.js';

// Reads can lag a moment behind writes (database replicas), so what was just decided here
// is kept for a minute: a decided request never comes back, an approved person shows up at once.
const RECENT_MS = 60_000;
const decidedRequests = new Map(); // request id -> time
const approvedMembers = new Map(); // member id -> { member, at }
const recent = (at) => Date.now() - at < RECENT_MS;

// pending access requests: on "Company settings" in the menu and on "Members" in the page
function setRequestsBadge(n) {
  for (const item of document.querySelectorAll('.drawer a[href="#/admin"], .side-nav a[href="#/admin/members"]')) {
    item.querySelector('.count-pill')?.remove();
    if (n > 0) item.append(h('span', { class: 'count-pill' }, String(n)));
  }
}

const SECTIONS = [
  ['company', 'Company', 'building'],
  ['modules', 'Modules', 'modules'],
  ['members', 'Members', 'user'],
  ['teams', 'Teams', 'team'],
  ['invites', 'Invites', 'mail'],
  ['signin', 'Sign-in & SSO', 'lock'],
];

// Company settings: same layout as My account, a menu on the left and the section on the right.
// Modules add their own sections under "Modules" (only while the company has them on).
export async function adminView(root, { params }) {
  if (store.me.user.role !== 'admin') {
    mount(root, pageHeader('Company settings'), h('p', { class: 'muted' }, 'Only admins can access this area.'));
    return;
  }
  const current = params.teamId ? 'teams' : params.tab || 'company';
  const extra = moduleAdminTabs(MODULES);
  const known = [...SECTIONS.map(([id]) => id), ...extra.map((t) => t.id)];
  // a section that isn't there (e.g. of a module that was turned off) opens Company
  if (!known.includes(current)) return void location.replace('#/admin/company');

  const navItem = (id, label, ic, sub = false) =>
    h(
      'a',
      { href: `#/admin/${id}`, class: `side-item${sub ? ' sub' : ''}${current === id ? ' active' : ''}` },
      icon(ic, 14),
      label,
      id === 'members' && store.me.pendingRequests ? h('span', { class: 'count-pill' }, String(store.me.pendingRequests)) : null,
    );
  const body = h('div', { class: 'account-body settings-body' });
  mount(
    root,
    pageHeader('Company settings', [], [[store.me.org.name]]),
    h(
      'div',
      { class: 'account-layout' },
      h(
        'nav',
        { class: 'side-nav', 'aria-label': 'Company settings' },
        SECTIONS.map(([id, label, ic]) => [navItem(id, label, ic), id === 'modules' ? extra.map((t) => navItem(t.id, t.label, t.icon, true)) : null]),
      ),
      body,
    ),
  );
  const views = { company, members, teams, invites, modules, signin, ...Object.fromEntries(extra.map((t) => [t.id, t.view])) };
  const reload = () => adminView(root, { params });
  if (params.teamId) return teamDetail(body, params.teamId);
  return views[current](body, reload);
}

// ------------------------------------------------------------------ company logo
// Shown next to the company name in the header while the company has a sign-in connected.
// It comes from the company's own website (the domain its sign-in uses).
function logoPanel(reload) {
  const { org } = store.me;
  const run = async (fn, msg) => {
    if (await attempt(fn, msg)) {
      await loadMe();
      window.dispatchEvent(new HashChangeEvent('hashchange')); // redraws the header
    }
  };
  return h(
    'div',
    { class: 'panel logo-panel narrow' },
    org.logo?.url ? h('img', { class: 'logo-preview', src: apiUrl(org.logo.url), alt: `${org.name} logo` }) : h('span', { class: 'logo-preview empty' }, icon('building', 22)),
    h(
      'div',
      { class: 'stack-sm grow' },
      org.logo?.url
        ? h('p', { class: 'small' }, 'From ', h('code', {}, org.logo.from), '. It shows next to the company name at the top of every page.')
        : h('p', { class: 'muted small' }, 'Once your company has a sign-in connected (Sign-in & SSO, or social sign-in with your domain), its logo is taken from your website and shown next to the company name.'),
      h(
        'div',
        { class: 'btn-group' },
        button(org.logo ? 'Fetch again' : 'Fetch from our website', { size: 'sm', iconName: 'download', onClick: () => run(() => post('/api/org/logo/refresh'), 'Logo updated') }),
        org.logo ? button('Remove', { size: 'sm', variant: 'danger-ghost', iconName: 'trash', onClick: () => run(() => del('/api/org/logo'), 'Logo removed') }) : null,
      ),
    ),
  );
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
  mount(root, section('Company', form), section('Logo', logoPanel(reload)));
}

// ------------------------------------------------------------------ members
async function members(root, reload) {
  const [{ members: fetched }, { teams: allTeams }, { requests: pending }] = await Promise.all([get('/api/org/members'), get('/api/teams'), get('/api/org/requests')]);
  const requests = pending.filter((r) => !(decidedRequests.has(r.id) && recent(decidedRequests.get(r.id))));
  const list = [...fetched];
  for (const [id, { member, at }] of approvedMembers) if (recent(at) && !list.some((m) => m.id === id)) list.push({ avatar: null, role: 'member', providers: [], ...member });
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
  // update the screen right away: the decided request leaves the list and the menu badge
  const after = (req, r, msg) => {
    toast(r.emailSent ? msg : `${msg} (no email sent: email isn't configured)`, r.emailSent ? 'success' : 'info');
    decidedRequests.set(req.id, Date.now());
    if (r.member) approvedMembers.set(r.member.id, { member: r.member, at: Date.now() });
    store.me.pendingRequests = Math.max(0, (store.me.pendingRequests || 0) - 1);
    setRequestsBadge(store.me.pendingRequests);
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
              after(req, r, `${req.name} joined ${org.name}`);
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
    if (r) after(req, r, `Access denied for ${req.name}`);
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

// ------------------------------------------------------------------ modules
// What this Rewind has installed. Required modules are always on; the others are turned on
// or off for the whole company (their pages and menu items come and go with them).
async function modules(root) {
  const { modules: list } = await get('/api/org/modules');
  const toggle = async (m, input) => {
    input.disabled = true;
    const r = await attempt(() => patch(`/api/org/modules/${m.id}`, { enabled: input.checked }), `${m.name} turned ${input.checked ? 'on' : 'off'}`);
    if (!r) input.checked = !input.checked;
    else {
      await loadMe();
      window.dispatchEvent(new HashChangeEvent('hashchange')); // redraws the menu
      return;
    }
    input.disabled = false;
  };
  mount(
    root,
    section(
      'Modules',
      h('p', { class: 'muted small section-hint' }, 'Features available to your company. Each module adds its own pages to the menu.'),
      h(
        'div',
        { class: 'panel list-panel' },
        list.map((m) => {
          const input = h('input', { type: 'checkbox', name: `module-${m.id}`, checked: m.enabled, disabled: m.required, 'aria-describedby': `module-${m.id}-hint`, onChange: () => toggle(m, input) });
          return h(
            'div',
            { class: 'list-row module-row' },
            h(
              'label',
              { class: `switch${m.required ? ' locked' : ''}`, title: m.required ? `${m.name} can't be turned off for now` : undefined },
              input,
              h('span', { class: 'switch-ui' }),
              h('span', {}, h('strong', {}, m.name), h('span', { class: 'muted small block', id: `module-${m.id}-hint` }, m.description)),
            ),
            m.required ? badge('Always on', 'neutral', 'lock') : m.enabled ? badge('On', 'success', 'check') : badge('Off'),
          );
        }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ one team: its members
async function teamDetail(root, teamId) {
  const [{ teams: allTeams }, { members: fetched }] = await Promise.all([get('/api/teams'), get('/api/org/members')]);
  const team = allTeams.find((t) => t.id === teamId);
  if (!team) {
    mount(root, h('p', { class: 'muted' }, 'This team no longer exists. ', h('a', { href: '#/admin/teams' }, 'Back to teams')));
    return;
  }
  // local copy, updated from each answer: no refetch that could come back from a lagging replica
  let people = fetched;
  const teamName = (id) => allTeams.find((t) => t.id === id)?.name;
  const replace = (member) => {
    people = people.map((p) => (p.id === member.id ? { ...p, ...member } : p));
    if (member.id === store.me.user.id) loadMe().catch(() => {}); // your own teams decide which boards you see
  };

  // e.g. "Pagamentos" made in Rewind into "Payments" from the company's identity provider
  const mergeInto = () => {
    const targets = allTeams.filter((t) => t.id !== team.id && !(t.groupKey && team.groupKey && t.groupKey !== team.groupKey));
    if (!targets.length) return toast('No team to merge into (teams following different groups can’t be merged)', 'error');
    const sel = h('select', { name: 'into' }, targets.map((t) => h('option', { value: t.id }, `${t.name}${t.groupKey ? ` (group ${t.groupKey.split(':')[0]})` : ''}`)));
    const m = modal({
      title: `Merge ${team.name} into another team`,
      body: [
        field('Keep this team', sel),
        h('p', { class: 'muted small' }, `${team.name} goes away. Its members, boards, pending invites, changes and approver roles move to the team you keep${team.groupKey ? ', which will follow the same group' : ''}. This can't be undone.`),
      ],
      actions: [
        button('Cancel', { onClick: () => m.close() }),
        button('Merge', {
          variant: 'danger',
          iconName: 'merge',
          onClick: async () => {
            const into = targets.find((t) => t.id === sel.value);
            const r = await attempt(() => post(`/api/teams/${team.id}/merge`, { into: into.id }), `${team.name} merged into ${into.name}`);
            if (!r) return;
            m.close();
            await loadMe().catch(() => {});
            location.hash = `#/admin/teams/${into.id}`;
          },
        }),
      ],
    });
  };

  const draw = () => {
    const inTeam = people.filter((p) => p.teamIds.includes(team.id)).sort((a, b) => a.name.localeCompare(b.name));
    const others = people.filter((p) => !p.teamIds.includes(team.id)).sort((a, b) => a.name.localeCompare(b.name));
    const pick = h('select', { 'aria-label': 'Person to add', disabled: !others.length }, others.length ? others.map((p) => h('option', { value: p.id }, `${p.name} — ${p.email}`)) : h('option', {}, 'Everyone is already in this team'));
    const add = async () => {
      const userId = pick.value;
      const person = others.find((p) => p.id === userId);
      if (!person) return;
      const r = await attempt(() => post(`/api/teams/${team.id}/members`, { userId }), `${person.name} added to ${team.name}`);
      if (r) {
        replace(r.member);
        draw();
      }
    };
    const remove = async (p) => {
      const lastTeam = p.teamIds.length === 1;
      const msg = `Remove ${p.name} from ${team.name}?` + (lastTeam ? ' This is their only team: they will not see any board until they join another one.' : '');
      if (!(await confirmDialog(msg, { danger: true, confirmLabel: 'Remove' }))) return;
      const r = await attempt(() => del(`/api/teams/${team.id}/members/${p.id}`), `${p.name} removed from ${team.name}`);
      if (r) {
        replace(r.member);
        draw();
      }
    };

    mount(
      root,
      h(
        'section',
        { class: 'section' },
        h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/admin/teams' }, 'Teams'), h('span', {}, team.name)),
        h(
          'div',
          { class: 'section-row' },
          h('h2', { class: 'section-title' }, `${team.name} — ${inTeam.length} member${inTeam.length === 1 ? '' : 's'}`),
          h(
            'div',
            { class: 'btn-group' },
            team.id === store.me.org.defaultTeamId ? badge('Default team') : null,
            team.groupKey ? badge(`Group ${team.groupKey.split(':')[0]}`, 'info') : null,
            allTeams.length > 1 ? button('Merge into…', { size: 'sm', iconName: 'merge', onClick: mergeInto }) : null,
          ),
        ),
        team.groupKey ? h('p', { class: 'muted small section-hint' }, `Follows the group ${team.groupKey}: people in that group join this team when they sign in. A team made in Rewind with the same name as a group is linked to it automatically, never duplicated.`) : null,
        h('div', { class: 'panel team-add' }, h('label', { class: 'field-label' }, 'Add someone from the company'), h('div', { class: 'team-add-row' }, pick, button('Add to team', { variant: 'primary', iconName: 'plus', disabled: !others.length, onClick: add }))),
        table(
          ['Name', 'Email', 'Role', 'Other teams', ''],
          inTeam.map((p) =>
            h(
              'tr',
              {},
              h('td', {}, h('span', { class: 'person' }, avatar(p), p.name)),
              h('td', {}, p.email),
              h('td', {}, p.role === 'admin' ? badge('Admin', 'accent') : badge('Member')),
              h('td', {}, p.teamIds.filter((id) => id !== team.id).map(teamName).filter(Boolean).join(', ') || h('span', { class: 'muted' }, '—')),
              h('td', { class: 'right' }, button('Remove', { variant: 'danger-ghost', size: 'sm', iconName: 'x', onClick: () => remove(p) })),
            ),
          ),
          { empty: 'Nobody in this team yet. Add someone above.' },
        ),
      ),
    );
  };
  draw();
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
            { class: 'row-link', onClick: () => (location.hash = `#/admin/teams/${t.id}`) },
            h('td', {}, h('a', { href: `#/admin/teams/${t.id}`, class: 'strong' }, t.name), t.id === store.me.org.defaultTeamId ? [' ', badge('Default')] : null),
            h('td', {}, t.groupKey ? badge(`Group ${t.groupKey.split(':')[0]}`, 'info') : badge('Manual')),
            h('td', {}, String(count(t.id))),
            h('td', {}, fmtDateTime(t.createdAt)),
            h('td', { class: 'right' }, button('', { iconName: 'edit', variant: 'ghost', size: 'xs', title: 'Edit name', onClick: (e) => (e.stopPropagation(), edit(t)) })),
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

// ------------------------------------------------------------------ sign-in & SSO
// The company's own sign-in: its Google / Microsoft / GitHub apps or any OpenID Connect provider
// (Okta, Auth0, Keycloak...). Works alongside, or instead of, the platform's providers.
const SIGNIN = {
  google: {
    name: 'Google Workspace',
    help: ['Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID (Web application). ', 'Add the redirect URI below as an authorized redirect URI.'],
    groups: 'Read Google Groups to place people in teams (needs the Cloud Identity API).',
  },
  microsoft: {
    name: 'Microsoft Entra ID',
    help: ['Entra admin center → App registrations → New registration (Web). ', 'Add the redirect URI below, then create a client secret under Certificates & secrets.'],
    groups: 'Read group memberships to place people in teams (GroupMember.Read.All, admin consent).',
  },
  github: {
    name: 'GitHub',
    help: ['GitHub organization → Settings → Developer settings → OAuth Apps → New OAuth App. ', 'Use the redirect URI below as the authorization callback URL.'],
  },
  oidc: {
    name: 'SSO (OpenID Connect)',
    help: ['Okta, Auth0, Keycloak, JumpCloud, OneLogin or any OpenID Connect provider: create a web application (authorization code flow) ', 'with the redirect URI below, and give its issuer URL here.'],
    groups: 'Read the “groups” claim to place people in teams (the provider must send it).',
  },
};

async function signin(root, reload) {
  const data = await get('/api/org/auth');
  const { auth, ready, verifiedDomain, platform, redirectUris, emailEnabled, secretsEncrypted } = data;

  const providerCard = (id) => {
    const spec = SIGNIN[id];
    const cur = auth.providers[id];
    const on = ready.some((p) => p.id === id);
    const form = h(
      'form',
      {
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const d = Object.fromEntries(new FormData(form));
          const body = { ...d, enabled: d.enabled === 'on', fetchGroups: d.fetchGroups === 'on' };
          if (await attempt(() => api('PUT', `/api/org/auth/providers/${id}`, body), `${spec.name} saved`)) reload();
        },
      },
      h('p', { class: 'muted small' }, ...spec.help),
      h('div', { class: 'copy-row' }, h('span', { class: 'muted small copy-label' }, 'Redirect URI'), h('input', { value: redirectUris[id], readonly: true, 'aria-label': 'Redirect URI' }), button('', { iconName: 'copy', title: 'Copy', onClick: () => copyText(redirectUris[id]) })),
      id === 'oidc'
        ? h('div', { class: 'grid-2' }, field('Issuer URL', h('input', { name: 'issuer', value: cur?.issuer || '', placeholder: 'https://your-company.okta.com', required: true })), field('Button label', h('input', { name: 'label', value: cur?.label || '', placeholder: 'Okta', maxlength: 40 }), 'Shown as “Continue with …”.'))
        : null,
      h(
        'div',
        { class: 'grid-2' },
        field('Client ID', h('input', { name: 'clientId', value: cur?.clientId || '', required: true, autocomplete: 'off' })),
        field('Client secret', h('input', { name: 'clientSecret', type: 'password', autocomplete: 'off', required: !cur?.hasSecret, placeholder: cur?.hasSecret ? `Saved (${cur.secretHint}). Type a new one to replace it.` : '' })),
      ),
      id === 'microsoft' ? field('Tenant', h('input', { name: 'tenant', value: cur?.tenant || '', placeholder: 'organizations, or your tenant ID / domain' }), 'Your tenant ID keeps sign-in to your organization only.') : null,
      spec.groups ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', name: 'fetchGroups', checked: Boolean(cur?.fetchGroups) }), h('span', {}, spec.groups)) : null,
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'enabled', checked: cur ? cur.enabled : true }), h('span', { class: 'switch-ui' }), h('span', {}, h('strong', {}, 'Enabled'), h('span', { class: 'muted small block' }, 'Shown on the sign-in page to people of your company.'))),
      h(
        'div',
        { class: 'btn-group' },
        button(cur ? 'Save' : 'Set up', { type: 'submit', variant: 'primary' }),
        cur
          ? button('Remove', {
              variant: 'danger-ghost',
              iconName: 'trash',
              onClick: async () => {
                if (!(await confirmDialog(`Remove the ${spec.name} sign-in? People will sign in with the other options.`, { confirmLabel: 'Remove', danger: true }))) return;
                if (await attempt(() => del(`/api/org/auth/providers/${id}`), `${spec.name} removed`)) reload();
              },
            })
          : null,
      ),
    );
    return h(
      'details',
      { class: 'panel signin-provider', open: Boolean(cur) },
      h('summary', {}, h('strong', {}, spec.name), on ? badge('On', 'success', 'check') : cur ? badge('Off') : badge('Not set up')),
      form,
    );
  };

  const domainsInput = h('input', { name: 'domains', value: (auth.domains.length ? auth.domains : verifiedDomain ? [verifiedDomain] : []).join(', '), placeholder: 'acme.com, acme.com.br' });
  const policy = h(
    'form',
    {
      class: 'panel stack',
      onSubmit: async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(policy));
        const body = { domains: String(d.domains || '').split(',').map((x) => x.trim()).filter(Boolean), autoProvision: d.autoProvision === 'on', requireSso: d.requireSso === 'on' };
        if (body.requireSso && !auth.requireSso) {
          const msg = `Members will only sign in with ${ready.map((p) => p.label).join(' or ')}; their passwords stop working (admins keep theirs for emergencies). Everyone gets ${emailEnabled ? 'an email and ' : ''}a notice in the app explaining how to sign in now.`;
          if (!(await confirmDialog(msg, { confirmLabel: 'Require it and notify' }))) return;
        }
        const r = await attempt(() => api('PUT', '/api/org/auth/policy', body), 'Sign-in policy saved');
        if (!r) return;
        if (r.notified) toast(`${r.notified.people} people notified${r.notified.emailEnabled ? `, ${r.notified.emailed} by email` : ' in the app (email is not configured)'}`, 'success');
        reload();
      },
    },
    field('Company email domains', domainsInput, `People with these emails are sent to your company's sign-in.${verifiedDomain ? ` @${verifiedDomain} is your verified domain.` : ''}`),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'autoProvision', checked: auth.autoProvision }), h('span', { class: 'switch-ui' }), h('span', {}, h('strong', {}, 'Create accounts for new people'), h('span', { class: 'muted small block' }, 'Someone from these domains signing in with your provider for the first time joins as a member. Off: invite only.'))),
    h(
      'label',
      { class: `switch${ready.length ? '' : ' disabled'}` },
      h('input', { type: 'checkbox', name: 'requireSso', checked: auth.requireSso, disabled: !ready.length }),
      h('span', { class: 'switch-ui' }),
      h('span', {}, h('strong', {}, 'Require company sign-in'), h('span', { class: 'muted small block' }, ready.length ? 'Members can only sign in with your providers above. Admins keep their password for emergencies.' : 'Set up and enable a provider first.')),
    ),
    h(
      'div',
      { class: 'btn-group' },
      button('Save policy', { type: 'submit', variant: 'primary' }),
      ready.length
        ? button('Notify everyone again', {
            iconName: 'mail',
            onClick: async () => {
              if (!(await confirmDialog(`Send everyone ${emailEnabled ? 'an email and ' : ''}a notice explaining how to sign in with ${ready.map((p) => p.label).join(' or ')}?`))) return;
              const r = await attempt(() => post('/api/org/auth/notify'));
              if (r) toast(`${r.notified.people} people notified${r.notified.emailEnabled ? `, ${r.notified.emailed} by email` : ' in the app'}`, 'success');
            },
          })
        : null,
    ),
    auth.notifiedAt ? h('p', { class: 'muted small' }, `Last notice sent ${fmtDateTime(auth.notifiedAt)}.`) : null,
  );

  mount(
    root,
    section(
      'Your sign-in providers',
      h('p', { class: 'muted small section-hint' }, 'Bring your own identity provider: the credentials stay with your company, not with this Rewind installation. People of your company see these buttons after typing their email.'),
      !secretsEncrypted ? h('p', { class: 'notice small' }, icon('alert', 14), 'This server has no SECRETS_KEY: client secrets are stored without encryption. Ask whoever runs Rewind to set it.') : null,
      h('div', { class: 'stack' }, Object.keys(SIGNIN).map(providerCard)),
      platform.length ? h('p', { class: 'muted small', style: { marginTop: '10px' } }, `Also available on this Rewind, for everyone: ${platform.map((p) => p.label).join(', ')}.`) : null,
    ),
    section('Policy', policy, !emailEnabled ? h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'Email is not configured on this server: notices only show in the app.') : null),
  );
}
