// Company settings → Roles & permissions (spec §4). Lists the built-in roles,
// lets admins create custom ones and edit permissions per organization.
import { api, del, get, post, patch } from '@rewind/web/api.js';
import { h, mount, button, field, table, modal, attempt, confirmDialog, section } from '@rewind/web/ui.js';
import { isAdmin } from '@rewind/web/app.js';
import { scopeLabel } from './shared.js';

export async function rolesTab(root, reload) {
  if (!isAdmin()) return mount(root, h('p', { class: 'muted' }, 'Only admins can manage roles.'));
  const [{ roles }, catalog] = await Promise.all([get('/api/foundation/roles'), get('/api/foundation/catalog')]);
  const permissions = catalog.permissions;

  mount(
    root,
    section(
      'Roles & permissions',
      h('p', { class: 'fdn-hint' }, 'Permissions are checked by the backend on every operation (spec §1.6). Built-in roles cover the usual needs; create custom ones to match your organization.'),
      h('div', { class: 'fdn-inline', style: { marginBottom: '10px' } }, button('New role', { variant: 'primary', iconName: 'plus', onClick: () => openRoleForm(permissions, null, reload) })),
      table(
        ['Role', 'Scope', 'Permissions', 'Kind', ''],
        roles.map((r) =>
          h(
            'tr',
            {},
            h('td', {}, h('div', {}, h('strong', {}, r.name)), r.key ? h('small', { class: 'fdn-code' }, r.key) : null),
            h('td', {}, scopeLabel(r.scope)),
            h('td', {}, r.permissions?.length ? h('span', { class: 'fdn-code' }, r.permissions.join(', ')) : h('span', { class: 'muted' }, '—')),
            h('td', {}, r.builtin ? h('span', { class: 'muted' }, 'Built-in') : h('span', {}, 'Custom')),
            h(
              'td',
              {},
              button('Edit', { onClick: () => openRoleForm(permissions, r, reload) }),
              r.builtin ? null : button('Delete', {
                variant: 'danger',
                onClick: async () => {
                  if (!(await confirmDialog(`Delete role "${r.name}"?`, { danger: true, confirmLabel: 'Delete' }))) return;
                  if (await attempt(() => del(`/api/foundation/roles/${r.key}`), 'Role deleted')) reload();
                },
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

function openRoleForm(permissions, role, reload) {
  const selected = new Set(role?.permissions || []);
  const m = modal({
    title: role ? `Edit role — ${role.name}` : 'New role',
    body: h(
      'form',
      {
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const body = {
            key: fd.get('key'),
            name: fd.get('name'),
            description: fd.get('description'),
            scope: fd.get('scope'),
            permissions: fd.getAll('permissions'),
          };
          const run = role
            ? () => patch(`/api/foundation/roles/${role.key}`, body)
            : () => post('/api/foundation/roles', body);
          if (await attempt(run, role ? 'Role updated' : 'Role created')) {
            m.close();
            reload();
          }
        },
      },
      field('Key', h('input', { name: 'key', required: true, value: role?.key || '', pattern: '[a-z][a-z0-9_]*', disabled: role ? true : false }), 'Lowercase, underscores. Stable: used by the backend.'),
      role ? h('input', { type: 'hidden', name: 'key', value: role.key }) : null,
      field('Name', h('input', { name: 'name', required: true, value: role?.name || '' })),
      field('Scope', h(
        'select',
        { name: 'scope' },
        ['org', 'group', 'team'].map((s) => h('option', { value: s, selected: (role?.scope || 'org') === s }, scopeLabel(s))),
      )),
      field('Description', h('textarea', { name: 'description', rows: 2 }, role?.description || '')),
      h(
        'fieldset',
        { class: 'checks' },
        h('legend', {}, 'Permissions'),
        h(
          'div',
          { class: 'fdn-perm-grid' },
          permissions.map((p) =>
            h('label', {},
              h('input', { type: 'checkbox', name: 'permissions', value: p.key, checked: selected.has(p.key) }),
              h('span', {}, p.label),
              h('small', { class: 'fdn-code' }, ` ${p.key}`),
            ),
          ),
        ),
      ),
      h('div', { class: 'fdn-inline', style: { justifyContent: 'flex-end', marginTop: '8px' } }, button('Cancel', { onClick: () => m.close() }), button(role ? 'Save' : 'Create', { variant: 'primary', type: 'submit' })),
    ),
  });
}
