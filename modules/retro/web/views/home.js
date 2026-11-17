// Retro widgets for the home page: needs your attention, my action items,
// latest retro results, team health, plus metrics, onboarding steps and housekeeping.
import { patch } from '@rewind/web/api.js';
import { h, button, badge, table, fmtDate, today, attempt, icon, section, plural } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import { createBoard } from './boards.js';

const ACTIONS_PREVIEW = 5;
const pct = (rate) => (rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`);

// Whole days from today (local) until an ISO date; negative when it is in the past.
const daysUntil = (iso) => Math.round((new Date(iso + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 864e5);

const myTeams = () => {
  const { user, teams } = store.me;
  return user.role === 'admin' ? teams : teams.filter((t) => user.teamIds.includes(t.id));
};
const teamName = (id) => store.me.teams.find((t) => t.id === id)?.name || '—';

export const home = {
  actions: () => [button('New board', { iconName: 'plus', onClick: () => createBoard(myTeams()), variant: 'default' })],

  metrics: ({ data }) => {
    const { boards, actions, health } = data.retro;
    // weighted across every recent sprint of every visible board
    const totals = health.flatMap((x) => x.sprints).reduce((acc, s) => ({ done: acc.done + s.actions.done, total: acc.total + s.actions.total }), { done: 0, total: 0 });
    return [
      ['Team boards', boards.length],
      ['Retros in progress', boards.filter((b) => b.lastSprint?.status === 'open').length],
      ['My open action items', actions.length],
      ['Action items done', totals.total ? Math.round((totals.done / totals.total) * 100) : '—', totals.total ? '% · last sprints' : undefined],
    ];
  },

  onboarding: ({ data }) => {
    const firstBoard = data.retro.boards[0];
    return [
      { key: 'board', title: 'Create a team board', hint: 'One board per team keeps its sprints together.', onClick: () => createBoard(myTeams()), cta: 'Create' },
      { key: 'sprint', title: 'Start the first sprint', hint: 'Pick the dates and columns, then share it with the team.', href: firstBoard ? `#/boards/${firstBoard.id}` : null },
      { key: 'finished', title: 'Finish your first retro', hint: 'Close it to get the top 3 and assign action items.' },
    ];
  },

  housekeeping: ({ data }) =>
    (data.admin?.retro?.staleBoards || []).slice(0, 5).map((b) => ({
      icon: 'history',
      title: `${b.name} has been quiet`,
      hint: b.hasSprints ? `Last sprint ended ${fmtDate(b.lastActivity)}.` : `Created ${fmtDate(b.lastActivity)}, no sprints yet.`,
      href: `#/boards/${b.id}`,
      cta: 'Open',
    })),

  sections: ({ data, refresh }) => {
    const { actions, attention, results, health } = data.retro;
    return [
      attention.length ? section('Needs your attention', h('div', { class: 'card-grid' }, attention.map(attentionCard))) : null,
      section(
        actions.length > ACTIONS_PREVIEW ? `My action items (${ACTIONS_PREVIEW} of ${actions.length})` : 'My action items',
        actionsPreview(actions, refresh),
        actions.length > ACTIONS_PREVIEW ? h('a', { href: '#/actions', class: 'see-all' }, `See all ${actions.length} action items →`) : null,
      ),
      results.length ? section('Latest retro results', h('div', { class: 'card-grid' }, results.map(resultCard))) : null,
      health.length ? section('Team health', healthTable(health, teamName)) : null,
    ];
  },
};

// ------------------------------------------------------------- needs your attention
function closingLabel(end) {
  const d = daysUntil(end);
  if (d < 0) return `Sprint ended ${plural(-d, 'day')} ago — finish the retro`;
  if (d === 0) return 'Sprint ends today — finish the retro';
  return `Sprint ends in ${plural(d, 'day')}`;
}

function attentionCard(item) {
  const todo = [
    item.needsNote && badge("You haven't added a note", 'accent', 'edit'),
    item.votesRemaining > 0 && badge(`${plural(item.votesRemaining, 'vote')} left`, 'info', 'heart'),
    item.closingSoon && badge(closingLabel(item.sprint.end), daysUntil(item.sprint.end) < 0 ? 'danger' : 'warning', 'flag'),
  ];
  const onlyClosing = item.closingSoon && !item.needsNote && !item.votesRemaining;
  return h(
    'a',
    { class: 'dash-card attention-card', href: `#/sprint/${item.sprint.id}` },
    h('div', { class: 'card-head' }, h('strong', {}, item.sprint.name), h('span', { class: 'muted small' }, item.board.name)),
    h('div', { class: 'muted small' }, `${fmtDate(item.sprint.start)} → ${fmtDate(item.sprint.end)}`),
    h('div', { class: 'card-tags' }, todo),
    h('span', { class: 'card-cta' }, onlyClosing ? 'Open retro →' : 'Join the retro →'),
  );
}

// ------------------------------------------------------------- my action items
function actionsPreview(actions, refresh) {
  const now = today();
  return table(
    ['', 'Action item', 'Board', 'Sprint', 'Due date'],
    actions.slice(0, ACTIONS_PREVIEW).map((a) =>
      h(
        'tr',
        {},
        h(
          'td',
          { class: 'check-cell' },
          h('input', {
            type: 'checkbox',
            'aria-label': 'Mark as done',
            onChange: async (e) => {
              e.target.disabled = true;
              if (await attempt(() => patch(`/api/sprints/${a.sprint.id}/actions/${a.id}`, { done: true }), 'Action item done')) refresh();
              else {
                e.target.checked = false;
                e.target.disabled = false;
              }
            },
          }),
        ),
        h('td', { class: 'strong' }, a.text),
        h('td', {}, h('a', { href: `#/boards/${a.board.id}` }, a.board.name)),
        h('td', {}, h('a', { href: `#/sprint/${a.sprint.id}`, class: 'underline' }, a.sprint.name)),
        h('td', {}, a.due ? (a.due < now ? badge(`${fmtDate(a.due)} · overdue`, 'danger') : fmtDate(a.due)) : h('span', { class: 'muted' }, 'No date')),
      ),
    ),
    { empty: 'No open action items for you. 🎉' },
  );
}

// ------------------------------------------------------------- latest retro results
function resultCard(r) {
  const { done, total } = r.actions;
  return h(
    'div',
    { class: 'dash-card result-card' },
    h('div', { class: 'card-head' }, h('a', { href: `#/sprint/${r.sprint.id}`, class: 'strong' }, r.sprint.name), h('span', { class: 'muted small' }, r.board.name)),
    h('div', { class: 'muted small' }, `Finished ${fmtDate(r.sprint.finishedAt || r.sprint.end)}`),
    r.top.length
      ? h(
          'ol',
          { class: 'top-list' },
          r.top.map((n) =>
            h(
              'li',
              {},
              h('span', { class: 'col-dot', style: { background: n.column?.color }, title: n.column?.title }),
              h('span', { class: n.text === null ? 'muted' : '' }, n.text === null ? 'Hidden note' : n.text),
              h('span', { class: 'votes muted small', title: plural(n.votes, 'vote') }, icon('heart', 12), String(n.votes)),
            ),
          ),
        )
      : h('div', { class: 'muted small' }, 'No notes in this retro.'),
    h(
      'div',
      { class: 'result-progress' },
      h('div', { class: 'small' }, total ? `Action items: ${done} of ${total} done` : 'No action items assigned'),
      total ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done }, h('span', { style: { width: `${(done / total) * 100}%` } })) : null,
    ),
  );
}

// ------------------------------------------------------------- team health
function healthTable(health, teamName) {
  return table(
    ['Board', 'Action items done', 'Participation', 'Carried over', 'Sprints'],
    health.map(({ board, sprints }) => {
      const last = sprints.at(-1);
      const done = sprints.map((s) => ({
        value: s.actions.rate,
        tip: `${s.sprint.name}: ${s.actions.total ? `${s.actions.done}/${s.actions.total} done (${pct(s.actions.rate)})` : 'no action items'}`,
      }));
      const part = sprints.map((s) => ({
        value: s.participation.rate,
        tip: `${s.sprint.name}: ${s.participation.authors} of ${s.participation.teamSize} people added notes (${pct(s.participation.rate)})`,
      }));
      const carriedTotal = sprints.reduce((n, s) => n + s.carried, 0);
      return h(
        'tr',
        {},
        h('td', {}, h('a', { href: `#/boards/${board.id}`, class: 'strong' }, board.name), h('div', { class: 'muted small' }, teamName(board.teamId))),
        h('td', {}, trendCell(done, last.actions.rate, 'Action items done per sprint')),
        h('td', {}, trendCell(part, last.participation.rate, 'Participation per sprint')),
        h(
          'td',
          {},
          carriedTotal ? h('span', { title: 'Unfinished action items kept for the next sprint, across these sprints' }, plural(carriedTotal, 'item')) : h('span', { class: 'muted' }, 'None'),
          sprints.some((s) => s.carried >= 2) ? h('div', {}, badge('Recurring', 'warning', 'history')) : null,
        ),
        h('td', { class: 'muted small' }, `Last ${sprints.length}`),
      );
    }),
  );
}

function trendCell(points, latest, label) {
  return h('div', { class: 'trend' }, sparkline(points, label), h('span', { class: 'trend-value' }, pct(latest)));
}

// Single-series sparkline for 0..1 rates. Gaps where a sprint has no data.
// Each point carries a hover target with a native tooltip.
function sparkline(points, label) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 96;
  const H = 28;
  const P = 4;
  const n = points.length;
  const x = (i) => (n === 1 ? W / 2 : P + (i * (W - 2 * P)) / (n - 1));
  const y = (v) => H - P - v * (H - 2 * P);
  const el = (tag, attrs, ...kids) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.append(...kids);
    return node;
  };

  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.value === null) return void (pen = false);
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`;
    pen = true;
  });

  const svg = el('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${label}: ${points.map((p) => p.tip).join('; ')}` });
  svg.append(el('line', { class: 'spark-base', x1: P, x2: W - P, y1: H - P, y2: H - P }));
  if (d) svg.append(el('path', { class: 'spark-line', d }));
  const lastIdx = points.findLastIndex((p) => p.value !== null);
  if (lastIdx >= 0) svg.append(el('circle', { class: 'spark-dot', cx: x(lastIdx), cy: y(points[lastIdx].value), r: 3 }));
  points.forEach((p, i) => {
    const hit = el('circle', { class: 'spark-hit', cx: x(i), cy: p.value === null ? H - P : y(p.value), r: Math.max(6, (W - 2 * P) / (2 * Math.max(1, n - 1))) });
    hit.append(el('title', {}, document.createTextNode(p.tip)));
    svg.append(hit);
  });
  return svg;
}
