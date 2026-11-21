// Objectives: filters (cycle, level, status, mine), indicators and the
// alignment tree (organization → group → team objectives).
import { get } from '@rewind/web/api.js';
import { h, mount, button, pageHeader, section, metric, fmtDate } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import { OBJECTIVE_STATUS, FINAL, SCOPES, loadDirectory, directory, personChip, progressBar, scopeName, select, statusBadge } from '../lib.js';
import { openObjectiveForm } from './forms.js';

// filters survive going to an objective and coming back
const state = { cycleId: null, scopeType: '', scopeId: '', status: '', mine: false, q: '' };

export async function objectivesView(root) {
  const [{ cycles }, { objectives }] = await Promise.all([get('/api/goals/cycles'), get('/api/goals/objectives'), loadDirectory()]);
  if (state.cycleId === null) {
    // default: the published cycle that contains today, else the newest one
    const today = new Date().toISOString().slice(0, 10);
    state.cycleId = (cycles.find((c) => c.status === 'published' && c.startDate <= today && c.endDate >= today) || cycles.find((c) => c.status !== 'archived'))?.id || '';
  }

  const body = h('div', {});
  const create = () =>
    openObjectiveForm({
      cycles,
      objectives,
      defaults: { cycleId: state.cycleId || null },
      onSaved: (o) => (location.hash = `#/goals/${o.id}`),
    });

  const draw = () => {
    const q = state.q.trim().toLowerCase();
    const rows = objectives.filter(
      (o) =>
        (!state.cycleId || o.cycleId === state.cycleId) &&
        (!state.scopeType || o.scopeType === state.scopeType) &&
        (!state.scopeId || o.scopeId === state.scopeId) &&
        (!state.status || o.status === state.status) &&
        (!state.mine || o.ownerId === store.me.user.id || o.collaboratorIds.includes(store.me.user.id)) &&
        (!q || `${o.title} ${(o.tags || []).join(' ')}`.toLowerCase().includes(q)),
    );
    const live = rows.filter((o) => !FINAL.includes(o.status));
    const count = (...st) => rows.filter((o) => st.includes(o.status)).length;

    // tree: roots are objectives whose parent isn't in the filtered set
    const ids = new Set(rows.map((o) => o.id));
    const childrenOf = (id) => rows.filter((o) => o.parentId === id);
    const node = (o, depth = 0) => {
      const kids = depth < 6 ? childrenOf(o.id) : [];
      return h('div', {}, card(o), kids.length ? h('div', { class: 'goals-children' }, kids.map((k) => node(k, depth + 1))) : null);
    };
    const order = { org: 0, group: 1, team: 2 };
    const roots = rows.filter((o) => !o.parentId || !ids.has(o.parentId)).sort((a, b) => order[a.scopeType] - order[b.scopeType] || a.title.localeCompare(b.title));

    mount(
      body,
      h(
        'div',
        { class: 'metrics' },
        metric('Objectives', rows.length),
        metric('In progress', live.length),
        metric('At risk / off track', count('at_risk', 'off_track')),
        metric('Achieved', count('achieved', 'partially_achieved')),
      ),
      section(
        `Objectives (${rows.length})`,
        roots.length ? h('div', { class: 'goals-tree' }, roots.map((o) => node(o))) : h('p', { class: 'muted' }, 'No objectives here yet.'),
      ),
    );
  };

  const scopeIdSel = h('span', {});
  const drawScopeId = () => {
    if (!state.scopeType || state.scopeType === 'org') return mount(scopeIdSel);
    const list = state.scopeType === 'team' ? directory().teams : directory().groups;
    mount(scopeIdSel, select('scopeIdFilter', list.map((x) => [x.id, x.name]), state.scopeId, { empty: `All ${state.scopeType}s`, onChange: (e) => ((state.scopeId = e.target.value), draw()) }));
  };
  drawScopeId();

  mount(
    root,
    pageHeader('Objectives', [button('New objective', { variant: 'primary', iconName: 'plus', onClick: create })]),
    h(
      'div',
      { class: 'goals-filters' },
      select('cycle', cycles.map((c) => [c.id, `${c.name}${c.status === 'archived' ? ' (closed)' : ''}`]), state.cycleId, { empty: 'All cycles', onChange: (e) => ((state.cycleId = e.target.value), draw()) }),
      select('scope', SCOPES, state.scopeType, { empty: 'All levels', onChange: (e) => ((state.scopeType = e.target.value), (state.scopeId = ''), drawScopeId(), draw()) }),
      scopeIdSel,
      select('status', OBJECTIVE_STATUS, state.status, { empty: 'Any status', onChange: (e) => ((state.status = e.target.value), draw()) }),
      h('label', { class: 'goals-check' }, h('input', { type: 'checkbox', checked: state.mine, onChange: (e) => ((state.mine = e.target.checked), draw()) }), h('span', {}, 'Mine')),
      h('input', { type: 'search', placeholder: 'Search title or tag', value: state.q, onInput: (e) => ((state.q = e.target.value), draw()) }),
    ),
    cycles.length ? null : h('p', { class: 'muted' }, 'No cycles yet. An admin can create one in Company settings → Goal cycles; objectives can also live without a cycle.'),
    body,
  );
  draw();
}

function card(o) {
  return h(
    'div',
    { class: 'goals-card', role: 'link', tabindex: 0, onClick: () => (location.hash = `#/goals/${o.id}`), onKeydown: (e) => e.key === 'Enter' && (location.hash = `#/goals/${o.id}`) },
    h('h3', {}, h('a', { href: `#/goals/${o.id}`, onClick: (e) => e.stopPropagation() }, o.title)),
    h('div', {}, statusBadge(o.status)),
    h(
      'div',
      { class: 'goals-meta' },
      h('span', {}, scopeName(o.scopeType, o.scopeId)),
      personChip(o.ownerId),
      h('span', {}, `${o.krCount} key result${o.krCount === 1 ? '' : 's'}`),
      o.dueDate ? h('span', {}, `Due ${fmtDate(o.dueDate)}`) : null,
      o.visibility === 'scope' ? h('span', { title: 'Only the group/team, owner and collaborators' }, 'Restricted') : null,
      progressBar(o.progress, { small: true }),
    ),
  );
}
