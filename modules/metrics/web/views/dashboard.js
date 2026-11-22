// Team / group / organization dashboard: each metric with its definition,
// sample, sources, coverage and last update; gaps, delivery flow, insights
// and annotations. Comparison is the team with itself (previous period).
import { get, post, del } from '@rewind/web/api.js';
import { h, mount, button, pageHeader, section, modal, field, attempt, fmtDate, fmtDateTime, badge } from '@rewind/web/ui.js';
import { cat, loadCatalog, statusBadge, fmtValue, sparkline, downloadCsv, select, scopeLabel, today, val, LOWER_IS_BETTER, defName } from '../lib.js';

// the chosen scope and period survive going to a drill-down and back
const state = { scope: '', weeks: 12, repository: '', environment: '' };

const PERIODS = [['4', 'Last 4 weeks'], ['12', 'Last 12 weeks'], ['26', 'Last 26 weeks'], ['52', 'Last 52 weeks']];

export async function dashboardView(root) {
  const c = await loadCatalog(true);
  const scopes = [...(c.canReadAll ? [['org:', 'Organization']] : []), ...c.teams.map((t) => [`team:${t.id}`, `Team: ${t.name}`]), ...c.groups.map((g) => [`group:${g.id}`, `Group: ${g.name}`])];
  if (!scopes.some(([v]) => v === state.scope)) state.scope = scopes.find(([v]) => v.startsWith('team:'))?.[0] || scopes[0]?.[0] || '';

  const body = h('div', {});
  const query = () => {
    const [type, id] = state.scope.split(':');
    const p = new URLSearchParams({ scopeType: type, from: today(-(state.weeks * 7 - 1)), to: today() });
    if (id) p.set('scopeId', id);
    if (state.repository) p.set('repository', state.repository);
    if (state.environment) p.set('environment', state.environment);
    return p.toString();
  };

  const draw = async () => {
    if (!state.scope) return mount(body, h('p', { class: 'muted' }, "You aren't in a team with engineering metrics yet."));
    mount(body, h('p', { class: 'muted' }, 'Loading…'));
    const d = await attempt(() => get(`/api/metrics/dashboard?${query()}`));
    if (!d) return mount(body);
    mount(
      body,
      gaps(d),
      h('div', { class: 'metrics-grid' }, d.metrics.map((m) => card(m, query()))),
      section('Delivery flow', flow(d.flow)),
      d.insights.length ? section('Insights', insights(d.insights)) : null,
      section('Annotations', annotations(d, draw)),
      h('p', { class: 'muted metrics-foot' }, 'Metrics describe the system of work. They are never shown per person, and reporting incidents is never penalized.'),
    );
  };

  mount(
    root,
    pageHeader('Engineering metrics', [
      button('Export CSV', { iconName: 'download', onClick: () => downloadCsv(`/api/metrics/export?${query()}`, `metrics-${today()}.csv`) }),
      button('Events CSV', { iconName: 'download', variant: 'ghost', onClick: () => downloadCsv(`/api/metrics/export?kind=events&${query()}`, `metric-events-${today()}.csv`) }),
    ]),
    h(
      'div',
      { class: 'metrics-filters' },
      select('scope', scopes, state.scope, { onChange: (e) => ((state.scope = e.target.value), draw()) }),
      select('period', PERIODS, String(state.weeks), { onChange: (e) => ((state.weeks = Number(e.target.value)), draw()) }),
      h('input', { type: 'search', placeholder: 'Repository (owner/name)', value: state.repository, onChange: (e) => ((state.repository = e.target.value.trim()), draw()) }),
      h('input', { type: 'search', placeholder: 'Environment', value: state.environment, onChange: (e) => ((state.environment = e.target.value.trim()), draw()) }),
      h('a', { href: '#/metrics/improve', class: 'metrics-link' }, 'Experiments & key results →'),
    ),
    body,
  );
  await draw();
}

function gaps(d) {
  const cov = d.coverage;
  const lines = [];
  if (!cov.mapped) lines.push('No repositories or services are mapped to this scope yet. An admin maps them in Company settings → Engineering metrics.');
  for (const g of cov.gaps) lines.push(g);
  const head = h(
    'div',
    { class: 'metrics-coverage' },
    h('span', {}, `Coverage: ${cov.healthy}/${cov.mapped} mapped repositories/services with a healthy source · ${cov.withData} with data in the period`),
    h('span', { class: 'muted' }, `Last sync ${cov.lastSyncAt ? fmtDateTime(cov.lastSyncAt) : '—'} · last event received ${cov.lastEventAt ? fmtDateTime(cov.lastEventAt) : '—'}`),
  );
  return h('div', {}, head, lines.length ? h('div', { class: 'metrics-warning', role: 'status' }, h('strong', {}, 'Data gaps — missing data is not the same as no activity.'), h('ul', {}, lines.map((l) => h('li', {}, l)))) : null);
}

function card(m, q) {
  const def = m.definition;
  const prev = m.previous.value;
  let delta = null;
  if (m.value !== null && prev !== null && prev !== undefined) {
    const diff = Math.round((m.value - prev) * 10) / 10;
    const good = diff === 0 ? null : LOWER_IS_BETTER.includes(m.key) ? diff < 0 : diff > 0;
    delta = h('span', { class: `metrics-delta ${good === null ? '' : good ? 'good' : 'bad'}`, title: `Previous period ${m.previous.from} → ${m.previous.to}` }, `${diff > 0 ? '+' : ''}${fmtValue(diff, def.unit)} vs previous period`);
  }
  const details = h(
    'details',
    { class: 'metrics-def' },
    h('summary', {}, 'Definition'),
    h(
      'dl',
      {},
      ...[
        ['Formula', def.formula],
        ['Unit', def.unit],
        ['Window', def.window],
        ['Sample', `${m.sample} (minimum ${def.minSample})`],
        ['Sources', def.sources.join(', ')],
        ['Version', `v${def.version}`],
        def.leadTimeStart ? ['Starts at', def.leadTimeStart.replace(/_/g, ' ')] : null,
        def.excludeRepositories?.length ? ['Excluded', def.excludeRepositories.join(', ')] : null,
        ['Last update', m.lastUpdated ? fmtDateTime(m.lastUpdated) : '—'],
      ]
        .filter(Boolean)
        .flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
    ),
  );
  return h(
    'div',
    { class: 'metrics-card' },
    h('div', { class: 'metrics-card-head' }, h('h3', {}, def.name), statusBadge(m.status)),
    h('div', { class: 'metrics-value' }, fmtValue(m.value, def.unit), def.unit !== 'hours' && def.unit !== '%' ? h('small', {}, ` ${def.unit}`) : null),
    m.insufficient ? h('div', { class: 'muted' }, `Not enough data: ${m.sample} of the ${def.minSample} needed`) : delta,
    m.breakdown && m.breakdown.withReviewData
      ? h('div', { class: 'muted' }, `Waiting for review ${fmtValue(m.breakdown.waitingForReview, 'hours')} · review → merge ${fmtValue(m.breakdown.reviewToMerge, 'hours')}`)
      : null,
    sparkline(m.series),
    h('div', { class: 'metrics-card-foot' }, details, h('a', { href: `#/metrics/events?metric=${m.key}&${q}` }, `See the ${m.sample} source events →`)),
  );
}

function flow(stages) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  return h(
    'div',
    { class: 'metrics-flow' },
    stages.map((s) => h('div', { class: 'metrics-flow-row' }, h('span', {}, s.label), h('span', { class: 'metrics-flow-bar' }, h('span', { style: { width: `${(100 * s.count) / max}%` } })), h('strong', {}, String(s.count)))),
  );
}

function insights(list) {
  return h(
    'ul',
    { class: 'metrics-insights' },
    list.map((i) =>
      h(
        'li',
        {},
        h('div', {}, badge(i.kind === 'trend' ? 'Trend' : i.kind === 'data' ? 'Data' : 'Hypothesis', i.kind === 'trend' ? 'info' : i.kind === 'data' ? 'warning' : 'accent'), ' ', h('strong', {}, i.title)),
        h('div', { class: 'muted' }, `Evidence: ${i.evidence}`),
        h('div', { class: 'muted' }, `Sources: ${i.sources.join(', ')} · ${i.period.from} → ${i.period.to}`),
        i.suggestion ? h('div', {}, i.suggestion) : null,
        h('div', { class: 'muted metrics-small' }, i.note),
      ),
    ),
  );
}

function annotations(d, redraw) {
  const add = () => {
    const form = h(
      'form',
      { class: 'metrics-form' },
      field('Date', h('input', { type: 'date', name: 'date', value: today(), required: true })),
      field('What happened', h('input', { name: 'title', required: true, placeholder: 'e.g. Holiday week, new CI runners, on-call change' })),
      field('Notes', h('textarea', { name: 'note', rows: 3 })),
    );
    const m = modal({
      title: 'Add annotation',
      body: form,
      actions: [
        button('Cancel', { onClick: () => m.close() }),
        button('Add', {
          variant: 'primary',
          onClick: async () => {
            const r = await attempt(() => post('/api/metrics/annotations', { date: val(form, 'date'), title: val(form, 'title'), note: val(form, 'note'), scopeType: d.scope.type, scopeId: d.scope.id }), 'Annotation added');
            if (r) (m.close(), redraw());
          },
        }),
      ],
    });
  };
  return h(
    'div',
    {},
    d.annotations.length
      ? h(
          'ul',
          { class: 'metrics-annotations' },
          d.annotations.map((a) =>
            h(
              'li',
              {},
              h('strong', {}, fmtDate(a.date)),
              ` ${a.title}`,
              a.scopeType === 'org' ? h('span', { class: 'muted' }, ' (organization)') : null,
              a.note ? h('div', { class: 'muted' }, a.note) : null,
              button('', { iconName: 'trash', variant: 'ghost', size: 'sm', title: 'Remove', onClick: async () => (await attempt(() => del(`/api/metrics/annotations/${a.id}`))) && redraw() }),
            ),
          ),
        )
      : h('p', { class: 'muted' }, `No annotations for ${scopeLabel(d.scope.type, d.scope.id)} in this period.`),
    button('Add annotation', { iconName: 'plus', size: 'sm', onClick: add }),
  );
}

export { cat, defName };
