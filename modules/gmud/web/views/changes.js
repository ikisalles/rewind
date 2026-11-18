// Changes: indicators for a period, filters and the table of GMUDs. "+ New change" creates a
// draft right away and opens its form (it saves itself as people type).
import { get, post } from '@rewind/web/api.js';
import { keepUpdated } from '@rewind/web/live.js';
import { h, mount, button, table, attempt, pageHeader, section, metric } from '@rewind/web/ui.js';
import { STATUS, TYPES, CATEGORIES, ENVS, LEVEL, statusBadge, levelBadge, typeBadge, envLabel, when, loadPeople, personChip, select, versionsText, approvalsCell } from '../lib.js';

const PERIODS = { 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months', all: 'All time' };
// filters survive going to a change and coming back
const state = { period: '90', status: '', type: '', category: '', repo: '', responsible: '', environment: '', risk: '', q: '' };

export async function createChange() {
  const r = await attempt(() => post('/api/gmud/changes', {}));
  if (r) location.hash = `#/changes/${r.change.id}/edit`;
}

export async function changesView(root) {
  let [{ changes, settings }, people] = await Promise.all([get('/api/gmud/changes'), loadPeople()]);
  const repos = [...new Set(changes.flatMap((c) => c.repos.map((r) => r.repo)))].sort();

  const body = h('div', {});
  const draw = () => {
    const since = state.period === 'all' ? '' : new Date(Date.now() - Number(state.period) * 864e5).toISOString();
    const inPeriod = changes.filter((c) => !since || c.createdAt >= since);
    const count = (...st) => inPeriod.filter((c) => st.includes(c.status)).length;
    const q = state.q.trim().toLowerCase();
    const rows = inPeriod.filter(
      (c) =>
        (!state.status || c.status === state.status) &&
        (!state.type || c.changeType === state.type) &&
        (!state.category || c.category === state.category) &&
        (!state.repo || c.repos.some((r) => r.repo === state.repo)) &&
        (!state.responsible || c.responsibleId === state.responsible) &&
        (!state.environment || c.environment === state.environment) &&
        (!state.risk || c.risk === state.risk) &&
        (!q || `${c.number} ${c.title} ${c.tags.join(' ')}`.toLowerCase().includes(q)),
    );
    mount(
      body,
      h(
        'div',
        { class: 'metrics gmud-metrics' },
        metric('Total in period', inPeriod.length),
        metric('Waiting for approval', count('submitted', 'in_review')),
        metric('Approved / scheduled', count('approved', 'scheduled')),
        metric('In progress', count('in_progress')),
        metric('Completed', count('completed')),
        metric('Failed / rolled back', count('failed', 'rolled_back')),
      ),
      section(
        `Changes (${rows.length})`,
        table(
          ['ID', 'Title', 'Version', 'Type', 'Repositories', 'Responsible', 'Environment', 'Window', 'Risk', 'Approvers', 'Status'],
          rows.map((c) =>
            h(
              'tr',
              { class: 'row-link', onClick: () => (location.hash = `#/changes/${c.id}`) },
              h('td', { class: 'nowrap mono' }, h('a', { href: `#/changes/${c.id}` }, c.number)),
              h('td', { class: 'gmud-title-cell' }, c.title || h('span', { class: 'muted' }, 'Untitled draft')),
              h('td', { class: 'nowrap mono', title: c.repos.map((r) => `${r.repo} ${r.nextVersion}`).join('\n') }, versionsText(c.repos)),
              h('td', {}, typeBadge(c.changeType)),
              h('td', { class: 'small' }, c.repos.map((r) => r.repo.split('/').pop()).join(', ') || h('span', { class: 'muted' }, '—')),
              h('td', { class: 'nowrap' }, personChip(c.responsibleId)),
              h('td', {}, envLabel(c.environment)),
              h('td', { class: 'nowrap' }, when(c.plannedAt)),
              h('td', {}, levelBadge(c.risk)),
              h('td', { class: 'approvers-cell' }, approvalsCell(c, settings)),
              h('td', {}, statusBadge(c.status)),
            ),
          ),
          { empty: changes.length ? 'No change matches these filters.' : 'No changes yet. Create the first one with “New change”.' },
        ),
      ),
    );
  };

  const filter = (key, el) => {
    el.value = state[key];
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => {
      state[key] = el.value;
      draw();
    });
    return el;
  };

  mount(
    root,
    pageHeader('Changes', [
      button('New change', { variant: 'primary', iconName: 'plus', onClick: createChange }),
    ], [['GMUD']]),
    h(
      'div',
      { class: 'gmud-filters' },
      filter('period', select('period', PERIODS, state.period, { empty: null, 'aria-label': 'Period' })),
      filter('q', h('input', { type: 'search', placeholder: 'Search ID, title or tag', 'aria-label': 'Search' })),
      filter('status', select('status', STATUS, state.status, { empty: 'Any status', 'aria-label': 'Status' })),
      filter('type', select('type', TYPES, state.type, { empty: 'Any type', 'aria-label': 'SemVer type' })),
      filter('category', select('category', CATEGORIES, state.category, { empty: 'Any category', 'aria-label': 'Category' })),
      filter('repo', select('repo', repos.map((r) => [r, r]), state.repo, { empty: 'Any repository', 'aria-label': 'Repository' })),
      filter('responsible', select('responsible', people.map((p) => [p.id, p.name]), state.responsible, { empty: 'Anyone', 'aria-label': 'Responsible' })),
      filter('environment', select('environment', ENVS, state.environment, { empty: 'Any environment', 'aria-label': 'Environment' })),
      filter('risk', select('risk', LEVEL, state.risk, { empty: 'Any risk', 'aria-label': 'Risk' })),
    ),
    body,
  );
  draw();
  // live: new changes, approvals and status changes of the company show up as they happen
  return keepUpdated(
    root,
    async () => {
      ({ changes, settings } = await get('/api/gmud/changes'));
      draw();
    },
    '/api/gmud/live',
    { pollMs: 15_000 },
  );
}
