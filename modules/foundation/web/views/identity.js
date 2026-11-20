// Company settings → Identity providers (spec §3). The actual SSO sign-in
// lives in the core (Sign-in & SSO). This tab is where the organization
// declares the directory/provisioning side, group mappings and the audit of
// sync runs. P0: structure in place, sync execution is future work.
import { del, get, post, patch } from '@rewind/web/api.js';
import { h, mount, button, field, table, modal, attempt, confirmDialog, section, fmtDateTime } from '@rewind/web/ui.js';
import { isAdmin } from '@rewind/web/app.js';
import { kindLabel } from './shared.js';

export async function identityTab(root, reload) {
  if (!isAdmin()) return mount(root, h('p', { class: 'muted' }, 'Only admins can configure identity providers.'));
  const [{ idps, kinds }, { mappings }, { runs }, dir, { identities }] = await Promise.all([
    get('/api/foundation/idps'),
    get('/api/foundation/mappings'),
    get('/api/foundation/sync-runs'),
    get('/api/foundation/directory'),
    get('/api/foundation/identities'),
  ]);

  mount(
    root,
    section(
      'Identity providers',
      h('p', { class: 'fdn-hint' }, 'Authentication and provisioning are distinct (spec §3.1). The core already handles sign-in / SSO per company; this tab declares the directory/provisioning side and the group mappings.'),
      h('div', { class: 'fdn-inline', style: { marginBottom: '10px' } }, button('New provider', { variant: 'primary', iconName: 'plus', onClick: () => openIdpForm(kinds, null, reload) })),
      idps.length
        ? h(
            'div',
            { class: 'fdn-grid' },
            idps.map((p) => idpCard(p, kinds, reload)),
          )
        : h('p', { class: 'muted' }, 'No identity provider configured yet.'),
    ),
    section(
      'Group mappings',
      h('p', { class: 'fdn-hint' }, 'Map an external group to an internal group, team or role. Role mappings must be explicit (spec §4.1).'),
      h('div', { class: 'fdn-inline', style: { marginBottom: '10px' } },
        idps.length
          ? button('New mapping', { variant: 'primary', iconName: 'plus', onClick: () => openMappingForm({ idps, groups: dir.groups, teams: dir.teams, roles: dir.roles }, reload) })
          : h('span', { class: 'muted' }, 'Add a provider first.'),
      ),
      table(
        ['Provider', 'External key', 'External name', 'Maps to', ''],
        mappings.map((mp) =>
          h(
            'tr',
            {},
            h('td', {}, idps.find((p) => p.id === mp.idpId)?.name || mp.idpId),
            h('td', {}, h('span', { class: 'fdn-code' }, mp.externalKey)),
            h('td', {}, mp.externalName || h('span', { class: 'muted' }, '—')),
            h('td', {}, mappingTargets(mp, dir)),
            h(
              'td',
              {},
              button('Delete', { variant: 'danger', onClick: async () => {
                if (!(await confirmDialog('Delete this mapping?', { danger: true, confirmLabel: 'Delete' }))) return;
                if (await attempt(() => del(`/api/foundation/mappings/${mp.id}`), 'Mapping deleted')) reload();
              } }),
            ),
          ),
        ),
      ),
    ),
    section(
      'External identities',
      h('p', { class: 'fdn-hint' }, "Stable link between an internal user and a provider's immutable subject. E-mail is not used as the link key (spec §3.4)."),
      table(
        ['Provider', 'Subject', 'User', 'Email', 'Last seen'],
        identities.map((i) =>
          h(
            'tr',
            {},
            h('td', {}, i.provider),
            h('td', {}, h('span', { class: 'fdn-code' }, i.subject)),
            h('td', {}, dir.users.find((u) => u.id === i.userId)?.name || i.userId),
            h('td', {}, i.email || h('span', { class: 'muted' }, '—')),
            h('td', {}, i.lastSeenAt ? fmtDateTime(i.lastSeenAt) : h('span', { class: 'muted' }, 'Never')),
          ),
        ),
      ),
    ),
    section(
      'Sync runs',
      h('p', { class: 'fdn-hint' }, 'Executions of directory sync, with their stats and provisioning events. Driven by connectors — none run yet in P0.'),
      table(
        ['Started', 'Provider', 'Status', 'Stats'],
        runs.map((r) =>
          h(
            'tr',
            {},
            h('td', {}, fmtDateTime(r.startedAt)),
            h('td', {}, idps.find((p) => p.id === r.idpId)?.name || r.idpId),
            h('td', {}, r.status),
            h('td', {}, r.stats ? h('span', { class: 'fdn-code' }, JSON.stringify(r.stats)) : h('span', { class: 'muted' }, '—')),
          ),
        ),
      ),
    ),
  );
}

function idpCard(p, kinds, reload) {
  const kind = kinds.find((k) => k.key === p.kind);
  const cap = p.capabilities || kind?.capabilities || {};
  return h(
    'div',
    { class: 'fdn-card' },
    h(
      'div',
      { class: 'fdn-card-head' },
      h('h3', {}, p.name),
      h('span', { class: 'fdn-source', 'data-source': p.status === 'active' ? 'synced' : 'manual' }, p.status),
    ),
    h('p', { class: 'fdn-muted' }, kindLabel(kinds, p.kind), p.issuer ? ' · ' : '', p.issuer ? h('span', { class: 'fdn-code' }, p.issuer) : ''),
    h(
      'div',
      { class: 'fdn-inline' },
      cap.auth ? h('span', { class: 'fdn-tag' }, 'Auth') : null,
      cap.provisioning ? h('span', { class: 'fdn-tag' }, 'Provisioning') : null,
      cap.groups ? h('span', { class: 'fdn-tag' }, `Groups: ${cap.groups}`) : null,
    ),
    h(
      'div',
      { class: 'fdn-row-actions' },
      button('Edit', { onClick: () => openIdpForm(kinds, p, reload) }),
      button('Delete', { variant: 'danger', onClick: async () => {
        if (!(await confirmDialog(`Delete provider "${p.name}"?`, { danger: true, confirmLabel: 'Delete' }))) return;
        if (await attempt(() => del(`/api/foundation/idps/${p.id}`), 'Provider deleted')) reload();
      } }),
    ),
  );
}

function openIdpForm(kinds, idp, reload) {
  const m = modal({
    title: idp ? `Edit provider — ${idp.name}` : 'New identity provider',
    body: h(
      'form',
      {
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const body = {
            name: fd.get('name'),
            kind: fd.get('kind'),
            issuer: fd.get('issuer'),
            status: fd.get('status'),
          };
          const run = idp ? () => patch(`/api/foundation/idps/${idp.id}`, body) : () => post('/api/foundation/idps', body);
          if (await attempt(run, idp ? 'Provider updated' : 'Provider created')) {
            m.close();
            reload();
          }
        },
      },
      field('Name', h('input', { name: 'name', required: true, value: idp?.name || '' })),
      field('Kind', h('select', { name: 'kind' }, kinds.map((k) => h('option', { value: k.key, selected: (idp?.kind || 'oidc') === k.key }, k.label)))),
      field('Issuer / endpoint', h('input', { name: 'issuer', value: idp?.issuer || '', placeholder: 'https://example.okta.com' })),
      field('Status', h('select', { name: 'status' },
        ['draft', 'active', 'disabled'].map((s) => h('option', { value: s, selected: (idp?.status || 'draft') === s }, s)),
      )),
      h('div', { class: 'fdn-inline', style: { justifyContent: 'flex-end', marginTop: '8px' } }, button('Cancel', { onClick: () => m.close() }), button(idp ? 'Save' : 'Create', { variant: 'primary', type: 'submit' })),
    ),
  });
}

function openMappingForm({ idps, groups, teams, roles }, reload) {
  const m = modal({
    title: 'New mapping',
    body: h(
      'form',
      {
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const body = {
            idpId: fd.get('idpId'),
            externalKey: fd.get('externalKey'),
            externalName: fd.get('externalName'),
            mapsTo: {
              groupId: fd.get('groupId') || null,
              teamId: fd.get('teamId') || null,
              roleKey: fd.get('roleKey') || null,
            },
          };
          if (await attempt(() => post('/api/foundation/mappings', body), 'Mapping created')) {
            m.close();
            reload();
          }
        },
      },
      field('Provider', h('select', { name: 'idpId', required: true }, idps.map((p) => h('option', { value: p.id }, p.name)))),
      field('External key', h('input', { name: 'externalKey', required: true, placeholder: 'external group id or name' })),
      field('External name', h('input', { name: 'externalName' })),
      field('Internal group', h('select', { name: 'groupId' }, h('option', { value: '' }, '—'), groups.map((g) => h('option', { value: g.id }, g.name)))),
      field('Internal team', h('select', { name: 'teamId' }, h('option', { value: '' }, '—'), teams.map((t) => h('option', { value: t.id }, t.name)))),
      field('Internal role', h('select', { name: 'roleKey' }, h('option', { value: '' }, '—'), roles.map((r) => h('option', { value: r.key }, `${r.name} — ${r.key}`)))),
      h('div', { class: 'fdn-inline', style: { justifyContent: 'flex-end', marginTop: '8px' } }, button('Cancel', { onClick: () => m.close() }), button('Create', { variant: 'primary', type: 'submit' })),
    ),
  });
}

function mappingTargets(mp, dir) {
  const bits = [];
  if (mp.mapsTo?.groupId) bits.push(`Group: ${dir.groups.find((g) => g.id === mp.mapsTo.groupId)?.name || '—'}`);
  if (mp.mapsTo?.teamId) bits.push(`Team: ${dir.teams.find((t) => t.id === mp.mapsTo.teamId)?.name || '—'}`);
  if (mp.mapsTo?.roleKey) bits.push(`Role: ${dir.roles.find((r) => r.key === mp.mapsTo.roleKey)?.name || mp.mapsTo.roleKey}`);
  return bits.length ? bits.join(' · ') : h('span', { class: 'muted' }, 'No target yet');
}
