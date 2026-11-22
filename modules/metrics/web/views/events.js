// Drill-down: the source events behind an aggregate, and one event with its
// source and links (GMUD change, incident, objective, retrospective).
import { get, post, del } from '@rewind/web/api.js';
import { h, mount, button, pageHeader, section, table, modal, field, attempt, fmtDateTime, badge } from '@rewind/web/ui.js';
import { cat, loadCatalog, defName, EVENT_LABEL, select, val } from '../lib.js';

const when = (e) => (e.type === 'pull_request' ? e.mergedAt || e.openedAt : e.occurredAt);
const hrs = (a, b) => (a && b ? `${Math.round(((new Date(b) - new Date(a)) / 36e5) * 10) / 10} h` : '—');

export async function eventsView(root, { query }) {
  await loadCatalog();
  const metric = query.get('metric');
  const { events } = await get(`/api/metrics/events?${query.toString()}`);
  const back = h('a', { href: '#/metrics' }, '← Engineering metrics');
  mount(
    root,
    pageHeader(metric ? `${defName(metric)}: source events` : 'Source events', [], [back]),
    h('p', { class: 'muted' }, `${events.length} event(s) from ${query.get('from') || '—'} to ${query.get('to') || '—'}. Only events of teams you can see are listed.`),
    table(
      ['Type', 'What', 'Repository / service', 'Environment', 'When', 'Details'],
      events.map((e) => [
        EVENT_LABEL[e.type],
        h('a', { href: `#/metrics/events/${encodeURIComponent(e.id)}` }, e.title || e.externalId),
        e.repository || e.service,
        e.environment || '—',
        fmtDateTime(when(e)),
        e.type === 'pull_request'
          ? `cycle ${hrs(e.openedAt, e.mergedAt)}${e.firstReviewAt ? ` · first review after ${hrs(e.openedAt, e.firstReviewAt)}` : ''}`
          : e.type === 'deployment'
            ? h('span', {}, badge(e.status, e.status === 'success' ? 'success' : 'danger'), e.prNumbers?.length ? ` PRs ${e.prNumbers.map((n) => `#${n}`).join(' ')}` : '')
            : `restored after ${hrs(e.startedAt, e.restoredAt)}`,
      ]),
      { empty: 'No events in this period.' },
    ),
  );
}

const TARGET_HREF = { gmud_change: (id) => `#/changes/${id}`, goal_objective: (id) => `#/goals/${id}`, retro_board: (id) => `#/boards/${id}` };

export async function eventDetailView(root, { params }) {
  await loadCatalog();
  const draw = async () => {
    const { event: e, source, links } = await get(`/api/metrics/events/${encodeURIComponent(params.id)}`);
    const rows = [
      ['Type', EVENT_LABEL[e.type]],
      ['External id', e.externalId],
      ['Repository', e.repository || '—'],
      ['Service', e.service || '—'],
      ['Environment', e.environment || '—'],
      ['Source', source ? `${source.name} (${source.type})` : 'Removed source'],
      ['Received', fmtDateTime(e.receivedAt)],
      e.late ? ['Arrived late', 'Yes — more than 7 days after it happened'] : null,
      ...(e.type === 'pull_request'
        ? [['Opened', fmtDateTime(e.openedAt)], ['First review', e.firstReviewAt ? fmtDateTime(e.firstReviewAt) : '—'], ['Merged', e.mergedAt ? fmtDateTime(e.mergedAt) : 'Not merged']]
        : e.type === 'deployment'
          ? [['Deployed', fmtDateTime(e.occurredAt)], ['Result', e.status], ['Commit', e.sha || '—'], ['Pull requests', (e.prNumbers || []).map((n) => `#${n}`).join(' ') || '—']]
          : [['Started', fmtDateTime(e.startedAt)], ['Restored', e.restoredAt ? fmtDateTime(e.restoredAt) : 'Still open'], ['Caused by deployment', e.deploymentId || '—']]),
      ['Attributed to', (e.owners || []).map((o) => o.name || o.id).join(', ') || 'No team (unmapped)'],
    ].filter(Boolean);
    mount(
      root,
      pageHeader(e.title || e.externalId, [e.url ? button('Open at the source', { iconName: 'link', onClick: () => window.open(e.url, '_blank', 'noopener') }) : null].filter(Boolean), [h('a', { href: '#/metrics' }, '← Engineering metrics')]),
      h('dl', { class: 'metrics-detail' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      section(
        'Links',
        links.length
          ? h(
              'ul',
              {},
              links.map((l) =>
                h(
                  'li',
                  {},
                  `${cat().linkTargets[l.targetType] || l.targetType}: `,
                  TARGET_HREF[l.targetType] ? h('a', { href: TARGET_HREF[l.targetType](l.targetId) }, l.targetId) : l.targetId,
                  ' ',
                  button('', { iconName: 'x', variant: 'ghost', size: 'sm', title: 'Remove link', onClick: async () => (await attempt(() => del(`/api/metrics/events/${encodeURIComponent(e.id)}/links/${l.id}`))) && draw() }),
                ),
              ),
            )
          : h('p', { class: 'muted' }, 'Not linked to anything yet.'),
        button('Add link', { iconName: 'link', size: 'sm', onClick: () => addLink(e, draw) }),
      ),
    );
  };
  await draw();
}

function addLink(e, done) {
  const form = h(
    'form',
    { class: 'metrics-form' },
    field('Link to', select('targetType', cat().linkTargets, e.type === 'deployment' ? 'gmud_change' : 'incident')),
    field('Id', h('input', { name: 'targetId', required: true, placeholder: 'e.g. the GMUD change id' })),
  );
  const m = modal({
    title: 'Link this event',
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button('Link', { variant: 'primary', onClick: async () => (await attempt(() => post(`/api/metrics/events/${encodeURIComponent(e.id)}/links`, { targetType: val(form, 'targetType'), targetId: val(form, 'targetId') }), 'Linked')) && (m.close(), done()) }),
    ],
  });
}
