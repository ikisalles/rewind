// Improvement work: experiments (hypothesis → action → observed result) and
// key results fed by a metric (baseline, target, direction, window).
import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, pageHeader, section, table, modal, field, attempt, fmtDate, badge } from '@rewind/web/ui.js';
import { cat, loadCatalog, defName, fmtValue, select, val, EXPERIMENT_STATUS, today } from '../lib.js';

export async function improveView(root) {
  const c = await loadCatalog();
  const draw = async () => {
    const [{ experiments }, { goalLinks }] = await Promise.all([get('/api/metrics/experiments'), get('/api/metrics/goal-links')]);
    const team = (id) => c.teams.find((t) => t.id === id)?.name || '—';
    mount(
      root,
      pageHeader('Experiments & key results', [
        button('New experiment', { variant: 'primary', iconName: 'plus', onClick: () => experimentForm(null, draw) }),
        button('Feed a key result', { iconName: 'flag', onClick: () => goalLinkForm(draw) }),
      ], [h('a', { href: '#/metrics' }, '← Engineering metrics')]),
      section(
        'Experiments',
        h('p', { class: 'muted' }, 'Record what you tried and what you observed. A change in a metric during an experiment is a correlation, not proof of cause.'),
        table(
          ['Experiment', 'Team', 'Metrics', 'Period', 'Status', 'Observed result', ''],
          experiments.map((x) => [
            h('div', {}, h('strong', {}, x.title), h('div', { class: 'muted' }, `Hypothesis: ${x.hypothesis}`), x.action ? h('div', { class: 'muted' }, `Action: ${x.action}`) : null),
            team(x.teamId),
            x.metricKeys.map(defName).join(', ') || '—',
            `${x.startDate ? fmtDate(x.startDate) : '—'} → ${x.endDate ? fmtDate(x.endDate) : '—'}`,
            badge(...(EXPERIMENT_STATUS[x.status] || [x.status])),
            x.observedResult || '—',
            h('span', {}, button('', { iconName: 'edit', variant: 'ghost', size: 'sm', title: 'Edit', onClick: () => experimentForm(x, draw) }), button('', { iconName: 'trash', variant: 'ghost', size: 'sm', title: 'Delete', onClick: async () => (await attempt(() => del(`/api/metrics/experiments/${x.id}`))) && draw() })),
          ]),
          { empty: 'No experiments yet.' },
        ),
      ),
      section(
        'Key results fed by metrics',
        h('p', { class: 'muted' }, 'The key result references the metric definition and its version; the series stays here.'),
        table(
          ['Metric', 'Scope', 'Key result', 'Baseline → target', 'Current (window)', 'Progress', ''],
          goalLinks.map((g) => [
            h('div', {}, defName(g.metricKey), g.definitionChanged ? h('div', { class: 'muted' }, `Definition changed since v${g.definitionVersion}`) : null),
            g.scopeType === 'org' ? 'Organization' : team(g.scopeId),
            h('a', { href: `#/goals/${g.objectiveId}` }, `Objective ${g.objectiveId} · KR ${g.keyResultId}`),
            `${g.baseline} → ${g.target} (${g.direction === 'decrease' ? 'reduce' : 'increase'})`,
            g.current.insufficient ? `Not enough data (${g.current.sample})` : `${fmtValue(g.current.value)} · ${g.windowDays} days`,
            g.progress === null ? '—' : `${g.progress}%`,
            button('', { iconName: 'trash', variant: 'ghost', size: 'sm', title: 'Remove', onClick: async () => (await attempt(() => del(`/api/metrics/goal-links/${g.id}`))) && draw() }),
          ]),
          { empty: 'No key results are fed by metrics yet.' },
        ),
      ),
    );
  };
  await draw();
}

const metricChecks = (selected = []) =>
  h('div', { class: 'metrics-checks' }, cat().definitions.map((d) => h('label', {}, h('input', { type: 'checkbox', name: 'metricKeys', value: d.key, checked: selected.includes(d.key) }), ` ${d.name}`)));

function experimentForm(x, done) {
  const teams = cat().teams.map((t) => [t.id, t.name]);
  const form = h(
    'form',
    { class: 'metrics-form' },
    field('Title', h('input', { name: 'title', value: x?.title || '', required: true })),
    x ? null : field('Team', select('teamId', teams, teams[0]?.[0])),
    field('Hypothesis', h('textarea', { name: 'hypothesis', rows: 2, placeholder: 'If we …, then … because …' }, x?.hypothesis || '')),
    field('Action', h('textarea', { name: 'action', rows: 2 }, x?.action || '')),
    field('Metrics to watch', metricChecks(x?.metricKeys)),
    h('div', { class: 'metrics-row' }, field('Start', h('input', { type: 'date', name: 'startDate', value: x?.startDate || today() })), field('End', h('input', { type: 'date', name: 'endDate', value: x?.endDate || '' }))),
    field('Status', select('status', EXPERIMENT_STATUS, x?.status || 'planned')),
    field('Observed result', h('textarea', { name: 'observedResult', rows: 2 }, x?.observedResult || ''), 'Required to conclude. Describe what you observed and other changes in the period.'),
  );
  const m = modal({
    title: x ? 'Edit experiment' : 'New experiment',
    wide: true,
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button('Save', {
        variant: 'primary',
        onClick: async () => {
          const body = {
            title: val(form, 'title'), hypothesis: val(form, 'hypothesis'), action: val(form, 'action'),
            metricKeys: [...form.querySelectorAll('[name="metricKeys"]:checked')].map((i) => i.value),
            startDate: val(form, 'startDate') || null, endDate: val(form, 'endDate') || null, status: val(form, 'status'), observedResult: val(form, 'observedResult'),
          };
          if (!x) body.teamId = val(form, 'teamId');
          const r = await attempt(() => (x ? patch(`/api/metrics/experiments/${x.id}`, body) : post('/api/metrics/experiments', body)), 'Saved');
          if (r) (m.close(), done());
        },
      }),
    ],
  });
}

async function goalLinkForm(done) {
  // objectives come from the Goals module's own API, when it's on
  const objectives = await get('/api/goals/objectives').then((r) => r.objectives, () => []);
  const teams = cat().teams.map((t) => [`team:${t.id}`, `Team: ${t.name}`]);
  const scopes = [...(cat().canAdmin ? [['org:', 'Organization']] : []), ...teams];
  const krSel = h('span', {});
  const form = h(
    'form',
    { class: 'metrics-form' },
    field('Metric', select('metricKey', cat().definitions.map((d) => [d.key, d.name]), 'lead_time')),
    field('Scope', select('scope', scopes, scopes[0]?.[0])),
    objectives.length
      ? field('Objective', select('objectiveId', objectives.map((o) => [o.id, o.title]), null, { empty: 'Choose…', onChange: (e) => loadKrs(e.target.value) }))
      : field('Objective id', h('input', { name: 'objectiveId', required: true })),
    field('Key result', krSel),
    h('div', { class: 'metrics-row' }, field('Baseline', h('input', { type: 'number', step: 'any', name: 'baseline' })), field('Target', h('input', { type: 'number', step: 'any', name: 'target' }))),
    h('div', { class: 'metrics-row' }, field('Direction', select('direction', { decrease: 'Reduce', increase: 'Increase' }, 'decrease')), field('Window (days)', h('input', { type: 'number', name: 'windowDays', value: 28, min: 7, max: 365 }))),
  );
  mount(krSel, h('input', { name: 'keyResultId', required: true }));
  async function loadKrs(id) {
    const r = await get(`/api/goals/objectives/${id}`).catch(() => null);
    const krs = r?.keyResults || r?.objective?.keyResults || [];
    mount(krSel, krs.length ? select('keyResultId', krs.map((k) => [k.id, k.title])) : h('input', { name: 'keyResultId', required: true }));
  }
  const m = modal({
    title: 'Feed a key result with a metric',
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button('Save', {
        variant: 'primary',
        onClick: async () => {
          const [scopeType, scopeId] = val(form, 'scope').split(':');
          const r = await attempt(
            () => post('/api/metrics/goal-links', { metricKey: val(form, 'metricKey'), scopeType, scopeId: scopeId || null, objectiveId: val(form, 'objectiveId'), keyResultId: val(form, 'keyResultId'), baseline: val(form, 'baseline'), target: val(form, 'target'), direction: val(form, 'direction'), windowDays: val(form, 'windowDays') }),
            'Linked',
          );
          if (r) (m.close(), done());
        },
      }),
    ],
  });
}
