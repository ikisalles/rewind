// Company settings → Groups: manage groups (distinct from Teams, spec §2.2)
// and the memberships that attach people to them.
import { api, del, get, post, patch, put } from '@rewind/web/api.js';
import { h, mount, button, field, table, modal, attempt, confirmDialog, section, fmtDateTime } from '@rewind/web/ui.js';
import { isAdmin, store } from '@rewind/web/app.js';
import { sourceChip, personName, groupName } from './shared.js';

export async function groupsTab(root, reload) {
  if (!isAdmin()) return mount(root, h('p', { class: 'muted' }, 'Only admins can manage groups.'));
  const [dir, { groups }] = await Promise.all([
    get('/api/foundation/directory'),
    get('/api/foundation/groups'),
  ]);
  const roles = dir.roles;
  const users = dir.users;
  const teams = dir.teams;
  const memberships = dir.memberships;

  mount(
    root,
    section(
      'Groups',
      h('p', { class: 'fdn-hint' }, 'Groups organize people inside the company. They are separate from Teams (which are the units of work other modules attach to). A person can belong to many groups and many teams.'),
      h(
        'div',
        { class: 'fdn-inline', style: { marginBottom: '10px' } },
        button('New group', { variant: 'primary', iconName: 'plus', onClick: () => openGroupForm(reload) }),
      ),
      groups.length
        ? h(
            'div',
            { class: 'fdn-grid' },
            groups.map((g) => groupCard(g, memberships, users, roles, teams, reload)),
          )
        : h('p', { class: 'muted' }, 'No groups yet — create one to start organizing people.'),
    ),
    section(
      'Memberships',
      h('p', { class: 'fdn-hint' }, 'Memberships link a person to an organization, group or team, with a role and optional validity. Ending a membership keeps its history.'),
      h(
        'div',
        { class: 'fdn-inline', style: { marginBottom: '10px' } },
        button('New membership', { variant: 'primary', iconName: 'plus', onClick: () => openMembershipForm({ groups, teams, users, roles }, reload) }),
      ),
      membershipTable(memberships, { groups, teams, users, roles }, reload),
    ),
  );
}

function groupCard(group, memberships, users, roles, teams, reload) {
  const members = memberships.filter((m) => m.scopeType === 'group' && m.scopeId === group.id && !m.validTo);
  return h(
    'div',
    { class: 'fdn-card' },
    h(
      'div',
      { class: 'fdn-card-head' },
      h('h3', {}, group.name),
      sourceChip(group.source),
    ),
    group.description ? h('p', { class: 'fdn-muted' }, group.description) : null,
    h('p', { class: 'fdn-muted' }, `${members.length} active member${members.length === 1 ? '' : 's'}`),
    h(
      'div',
      { class: 'fdn-row-actions' },
      button('Edit', { onClick: () => openGroupForm(reload, group) }),
      button('Delete', {
        variant: 'danger',
        onClick: async () => {
          if (!(await confirmDialog(`Delete group "${group.name}"? Its memberships will be ended but kept for history.`, { danger: true, confirmLabel: 'Delete' }))) return;
          if (await attempt(() => del(`/api/foundation/groups/${group.id}`), 'Group deleted')) reload();
        },
      }),
    ),
  );
}

function openGroupForm(reload, group = null) {
  const m = modal({
    title: group ? `Edit group — ${group.name}` : 'New group',
    body: h(
      'form',
      {
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const body = { name: fd.get('name'), description: fd.get('description'), source: fd.get('source') };
          const run = group
            ? () => patch(`/api/foundation/groups/${group.id}`, body)
            : () => post('/api/foundation/groups', body);
          if (await attempt(run, group ? 'Group updated' : 'Group created')) {
            m.close();
            reload();
          }
        },
      },
      field('Name', h('input', { name: 'name', required: true, value: group?.name || '' })),
      field('Description', h('textarea', { name: 'description', rows: 3 }, group?.description || '')),
      field(
        'Source',
        h(
          'select',
          { name: 'source' },
          h('option', { value: 'manual', selected: (group?.source || 'manual') === 'manual' }, 'Manual (managed here)'),
          h('option', { value: 'synced', selected: group?.source === 'synced' }, 'Synced (managed by an identity provider)'),
          h('option', { value: 'hybrid', selected: group?.source === 'hybrid' }, 'Hybrid'),
        ),
        'Synced groups have their name and description managed by the provider.',
      ),
      h('div', { class: 'fdn-inline', style: { justifyContent: 'flex-end', marginTop: '8px' } }, button('Cancel', { onClick: () => m.close() }), button(group ? 'Save' : 'Create', { variant: 'primary', type: 'submit' })),
    ),
  });
}

function membershipTable(memberships, { groups, teams, users, roles }, reload) {
  const byDate = [...memberships].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const rows = byDate.map((m) => {
    const scope =
      m.scopeType === 'group'
        ? `Group: ${groupName(groups, m.scopeId)}`
        : m.scopeType === 'team'
          ? `Team: ${teams.find((t) => t.id === m.scopeId)?.name || '—'}`
          : 'Organization';
    const role = roles.find((r) => r.key === m.roleKey);
    const active = !m.validTo;
    return h(
      'tr',
      {},
      h('td', {}, personName(users, m.userId)),
      h('td', {}, scope),
      h('td', {}, role ? role.name : m.roleKey),
      h('td', {}, sourceChip(m.source)),
      h('td', {}, active ? h('span', { class: 'muted' }, 'Active') : h('span', { class: 'muted' }, `Ended ${fmtDateTime(m.validTo)}`)),
      h(
        'td',
        {},
        active
          ? button('End', {
              variant: 'ghost',
              onClick: async () => {
                if (!(await confirmDialog('End this membership? History is kept.'))) return;
                if (await attempt(() => del(`/api/foundation/memberships/${m.id}`), 'Membership ended')) reload();
              },
            })
          : null,
      ),
    );
  });
  return table(['Person', 'Scope', 'Role', 'Source', 'Status', ''], rows, { empty: 'No memberships yet.' });
}

function openMembershipForm({ groups, teams, users, roles }, reload) {
  const scopeField = h('select', { name: 'scopeType' });
  for (const [val, label] of [['org', 'Organization'], ['group', 'Group'], ['team', 'Team']]) {
    scopeField.append(h('option', { value: val }, label));
  }
  const scopeIdWrap = h('div');
  function renderScopeId() {
    scopeIdWrap.replaceChildren();
    const type = scopeField.value;
    if (type === 'org') return;
    const list = type === 'group' ? groups : teams;
    const sel = h('select', { name: 'scopeId', required: true });
    for (const it of list) sel.append(h('option', { value: it.id }, it.name));
    scopeIdWrap.append(field(type === 'group' ? 'Group' : 'Team', sel));
  }
  scopeField.addEventListener('change', renderScopeId);

  const roleSel = h('select', { name: 'roleKey', required: true });
  for (const r of roles) roleSel.append(h('option', { value: r.key }, `${r.name} — ${r.key}`));

  const userSel = h('select', { name: 'userId', required: true });
  for (const u of users) userSel.append(h('option', { value: u.id }, `${u.name} (${u.email})`));

  const m = modal({
    title: 'New membership',
    body: h(
      'form',
      {
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const scopeType = fd.get('scopeType');
          const body = {
            userId: fd.get('userId'),
            scopeType,
            scopeId: scopeType === 'org' ? store.me.org.id : fd.get('scopeId'),
            roleKey: fd.get('roleKey'),
            source: 'manual',
            validFrom: fd.get('validFrom') || '',
            validTo: fd.get('validTo') || '',
          };
          if (await attempt(() => post('/api/foundation/memberships', body), 'Membership created')) {
            m.close();
            reload();
          }
        },
      },
      field('Person', userSel),
      field('Scope', scopeField),
      scopeIdWrap,
      field('Role', roleSel),
      h('div', { class: 'fdn-inline' },
        field('Valid from', h('input', { type: 'datetime-local', name: 'validFrom' })),
        field('Valid to', h('input', { type: 'datetime-local', name: 'validTo' })),
      ),
      h('div', { class: 'fdn-inline', style: { justifyContent: 'flex-end', marginTop: '8px' } }, button('Cancel', { onClick: () => m.close() }), button('Create', { variant: 'primary', type: 'submit' })),
    ),
  });
}
