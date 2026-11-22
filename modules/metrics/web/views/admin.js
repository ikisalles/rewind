// Company settings → Engineering metrics: sources (GitHub / API), repository
// and service mapping with history, versioned definitions and data quality.
import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, section, table, modal, field, attempt, confirmDialog, fmtDate, fmtDateTime, badge } from '@rewind/web/ui.js';
import { cat, loadCatalog, select, val, today, SOURCE_STATUS, LEAD_TIME_STARTS } from '../lib.js';

export async function adminTab(root) {
  await loadCatalog(true);
  const draw = async () => {
    const [{ sources, runs }, { scopes }, { definitions }, quality] = await Promise.all([
      get('/api/metrics/sources'), get('/api/metrics/scopes'), get('/api/metrics/definitions'), get('/api/metrics/quality'),
    ]);
    const owner = (s) => (s.ownerType === 'team' ? cat().teams : cat().groups).find((x) => x.id === s.ownerId)?.name || '—';
    mount(
      root,
      section(
        'Data sources',
        h('p', { class: 'muted' }, 'GitHub is read with your own token (My account → Integrations → GitHub), read-only. Pipelines and incident tools push events to an API source with its token.'),
        table(
          ['Source', 'Repositories', 'Status', 'Last sync', ''],
          sources.map((s) => [
            h('div', {}, h('strong', {}, s.name), h('div', { class: 'muted' }, s.type === 'github' ? 'GitHub' : 'API / webhook')),
            s.repositories.join(', ') || 'Any',
            h('span', {}, badge(...(SOURCE_STATUS[s.status] || [s.status])), s.lastError ? h('div', { class: 'muted' }, s.lastError) : null),
            s.lastSyncAt ? fmtDateTime(s.lastSyncAt) : '—',
            h(
              'span',
              {},
              s.type === 'github' ? button('Sync now', { size: 'sm', onClick: async () => (await attempt(() => post(`/api/metrics/sources/${s.id}/sync`), 'Synced')) && draw() }) : null,
              s.type === 'api' ? button('New token', { size: 'sm', onClick: async () => { const r = await attempt(() => post(`/api/metrics/sources/${s.id}/token`)); if (r) showToken(r); } }) : null,
              button('', { iconName: 'trash', variant: 'ghost', size: 'sm', title: 'Remove source', onClick: async () => (await confirmDialog('Remove this source? Events already received stay.', { danger: true, confirmLabel: 'Remove' })) && (await attempt(() => del(`/api/metrics/sources/${s.id}`))) && draw() }),
            ),
          ]),
          { empty: 'No sources yet.' },
        ),
        button('Add source', { iconName: 'plus', size: 'sm', onClick: () => sourceForm(draw) }),
      ),
      section(
        'Repositories and services → teams',
        h('p', { class: 'muted' }, 'Ownership is never inferred from directory groups. To hand a repository over, end the association and create a new one: past periods keep their attribution.'),
        table(
          ['Repository / service', 'Owner', 'Environments', 'Valid', ''],
          scopes.map((s) => [
            `${s.name}${s.kind === 'service' ? ' (service)' : ''}`,
            `${s.ownerType === 'group' ? 'Group' : 'Team'}: ${owner(s)}`,
            s.environments.join(', ') || 'All',
            `${fmtDate(s.validFrom)} → ${s.validTo ? fmtDate(s.validTo) : 'now'}`,
            s.validTo && s.validTo < today()
              ? h('span', { class: 'muted' }, 'Ended')
              : h('span', {}, button('End', { size: 'sm', onClick: async () => (await attempt(() => post(`/api/metrics/scopes/${s.id}/end`, { validTo: today(-1) < s.validFrom ? s.validFrom : today(-1) }), 'Ended')) && draw() }),
                  button('', { iconName: 'trash', variant: 'ghost', size: 'sm', title: 'Delete (only if it attributed no events)', onClick: async () => (await attempt(() => del(`/api/metrics/scopes/${s.id}`))) && draw() })),
          ]),
          { empty: 'Nothing mapped yet.' },
        ),
        button('Map repository or service', { iconName: 'plus', size: 'sm', onClick: () => scopeForm(draw) }),
      ),
      section(
        'Metric definitions',
        table(
          ['Metric', 'Formula', 'Unit', 'Minimum sample', 'Version', ''],
          definitions.map((d) => [d.name, d.formula, d.unit, String(d.minSample), `v${d.version}${d.changedAt ? ` · ${fmtDate(d.changedAt)}` : ''}`, button('Edit', { size: 'sm', onClick: () => definitionForm(d, draw) })]),
        ),
      ),
      section(
        'Data quality',
        h('p', {}, `Last 30 days: ${quality.last30Days.runs} runs · ${quality.last30Days.received} events received · ${quality.last30Days.duplicates} duplicates ignored · ${quality.last30Days.late} late · ${quality.last30Days.rejected} rejected · ${quality.last30Days.failedSyncs} failed syncs. Raw events are kept ${quality.retentionDays} days.`),
        quality.unmapped.length ? h('div', { class: 'metrics-warning' }, h('strong', {}, 'Seen in events but not mapped to a team: '), quality.unmapped.join(', ')) : null,
        table(
          ['Repository / service', 'Owner', 'Has source', 'Events (30 d)', 'Production deployments (30 d)'],
          quality.coverage.map((r) => [r.name, owner(r), r.hasSource ? 'Yes' : badge('No', 'danger'), String(r.eventsLast30Days), String(r.productionDeploymentsLast30Days)]),
          { empty: 'Nothing mapped yet.' },
        ),
        runs.length
          ? h('details', {}, h('summary', {}, 'Recent runs'), table(['When', 'Kind', 'Created', 'Updated', 'Duplicates', 'Rejected / errors'], runs.slice(0, 20).map((r) => [fmtDateTime(r.startedAt), r.kind, String(r.created), String(r.updated), String(r.duplicates), [...(r.errors || []), ...r.rejected.map((x) => `${x.externalId || '#' + x.index}: ${x.error}`)].join('; ') || '—'])))
          : null,
      ),
    );
  };
  await draw();
}

function showToken(r) {
  const m = modal({
    title: 'Ingestion token',
    body: h('div', { class: 'metrics-form' },
      h('p', {}, 'Copy it now: it is shown only once.'),
      field('Endpoint', h('input', { readOnly: true, value: `${location.origin}${r.ingestUrl}` })),
      field('Authorization header', h('input', { readOnly: true, value: `Bearer ${r.token}` })),
      h('pre', { class: 'metrics-code' }, '{ "events": [ { "type": "deployment", "externalId": "run-123", "repository": "owner/name",\n  "environment": "production", "deployedAt": "2026-01-01T12:00:00Z", "status": "success",\n  "prNumbers": [42], "gmudChangeId": "..." } ] }'),
    ),
    actions: [button('Done', { variant: 'primary', onClick: () => m.close() })],
  });
}

function sourceForm(done) {
  const form = h('form', { class: 'metrics-form' },
    field('Type', select('type', { github: 'GitHub (sync)', api: 'API / webhook (push)' }, 'github')),
    field('Name', h('input', { name: 'name', placeholder: 'e.g. GitHub ACME, Deploy pipeline' })),
    field('Repositories', h('textarea', { name: 'repositories', rows: 3, placeholder: 'owner/name, one per line' }), 'Required for GitHub. For API sources, empty accepts any repository.'),
  );
  const m = modal({
    title: 'Add data source',
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button('Add', { variant: 'primary', onClick: async () => {
        const r = await attempt(() => post('/api/metrics/sources', { type: val(form, 'type'), name: val(form, 'name'), repositories: val(form, 'repositories').split(/[\s,]+/).filter(Boolean) }), 'Source added');
        if (!r) return;
        m.close();
        if (r.token) showToken(r);
        done();
      } }),
    ],
  });
}

function scopeForm(done) {
  const owners = [...cat().teams.map((t) => [`team:${t.id}`, `Team: ${t.name}`]), ...cat().groups.map((g) => [`group:${g.id}`, `Group: ${g.name}`])];
  const form = h('form', { class: 'metrics-form' },
    field('Kind', select('kind', { repository: 'Repository', service: 'Service' }, 'repository')),
    field('Name', h('input', { name: 'name', required: true, placeholder: 'owner/name or service name' })),
    field('Owner', select('owner', owners, owners[0]?.[0])),
    field('Environments', h('input', { name: 'environments', placeholder: 'empty = all (e.g. production, staging)' })),
    field('Valid from', h('input', { type: 'date', name: 'validFrom', value: today() }), 'An earlier date attributes past events to this owner.'),
  );
  const m = modal({
    title: 'Map repository or service',
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button('Map', { variant: 'primary', onClick: async () => {
        const [ownerType, ownerId] = val(form, 'owner').split(':');
        const r = await attempt(() => post('/api/metrics/scopes', { kind: val(form, 'kind'), name: val(form, 'name'), ownerType, ownerId, environments: val(form, 'environments').split(/[\s,]+/).filter(Boolean), validFrom: val(form, 'validFrom') }), 'Mapped');
        if (r) (m.close(), done());
      } }),
    ],
  });
}

function definitionForm(d, done) {
  const form = h('form', { class: 'metrics-form' },
    h('p', { class: 'muted' }, d.formula),
    field('Minimum sample', h('input', { type: 'number', name: 'minSample', value: d.minSample, min: 1 })),
    d.key === 'lead_time' ? field('Lead time starts at', select('leadTimeStart', LEAD_TIME_STARTS, d.leadTimeStart)) : null,
    field('Excluded repositories', h('input', { name: 'excludeRepositories', value: (d.excludeRepositories || []).join(', ') })),
    field('Why it changes', h('input', { name: 'reason', required: true }), 'Each change creates a new version; the previous one is kept.'),
  );
  const m = modal({
    title: `Edit: ${d.name}`,
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button('Save new version', { variant: 'primary', onClick: async () => {
        const body = { minSample: Number(val(form, 'minSample')), excludeRepositories: val(form, 'excludeRepositories').split(/[\s,]+/).filter(Boolean), reason: val(form, 'reason') };
        if (d.key === 'lead_time') body.leadTimeStart = val(form, 'leadTimeStart');
        const r = await attempt(() => patch(`/api/metrics/definitions/${d.key}`, body), 'Saved');
        if (r) (m.close(), done());
      } }),
    ],
  });
}
