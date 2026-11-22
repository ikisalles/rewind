// The board's backlog and sprints (tabs inside the board) and its source settings
// (inside "Edit board"). Manual issues use the fields Jira shows by default
// when creating an issue; Jira issues are read-only copies, synced on demand.
import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, field, badge, modal, attempt, confirmDialog, avatar, fmtDate, fmtDateTime } from '@rewind/web/ui.js';

const TYPES = { story: 'Story', task: 'Task', bug: 'Bug', epic: 'Epic', subtask: 'Sub-task' };
const STATUS = { todo: ['To Do', 'neutral'], in_progress: ['In Progress', 'info'], done: ['Done', 'success'] };
const PRIORITY = { highest: ['Highest', 'danger'], high: ['High', 'warning'], medium: ['Medium', 'neutral'], low: ['Low', 'info'], lowest: ['Lowest', 'info'] };

const opts = (map, value, empty) => [
  empty !== undefined ? h('option', { value: '' }, empty) : null,
  ...Object.entries(map).map(([v, l]) => h('option', { value: v, selected: v === value }, Array.isArray(l) ? l[0] : l)),
];
const val = (form, name) => form.querySelector(`[name="${name}"]`)?.value ?? '';

// ------------------------------------------------------------------ tabs in the board
// "Backlog": sprint containers (active + planned) above the backlog, like Jira;
// issues move by drag and drop. "Current sprint" appears while a sprint is
// active: its goal, dates and issues by status. Completing a sprint opens its
// retrospective (retro's own dialog, through ctx.newRetro).
export async function boardTabs(ctx) {
  const data = await load(ctx.board).catch(() => null);
  const active = data?.sprints.find((s) => s.status === 'active');
  return [
    { id: 'backlog', label: 'Backlog', render: (el) => backlogTab(el, ctx) },
    active ? { id: 'current', label: 'Current sprint', render: (el) => currentTab(el, ctx) } : null,
  ];
}

const load = async (board) => ({ ...(await get(`/api/issues/boards/${board.id}`)), boardId: board.id });
const openSprints = (data) => data.sprints.filter((s) => s.status !== 'completed');
const TYPE_ICON = { story: ['▮', 'story'], task: ['✓', 'task'], bug: ['●', 'bug'], epic: ['⚡', 'epic'], subtask: ['↳', 'subtask'] };
const PRIO_ICON = { highest: '⇈', high: '↑', medium: '=', low: '↓', lowest: '⇊' };
const points = (list) => list.reduce((n, i) => n + (i.storyPoints || 0), 0);
const filters = { q: '', type: '', epic: '', assignee: '' };

function rerenderBoard(ctx) {
  ctx.reload?.(); // tabs may change (Current sprint appears / disappears)
}

// ------------------------------------------------------------------ Backlog tab
async function backlogTab(root, ctx) {
  const data = await load(ctx.board).catch((e) => ({ error: e.message }));
  if (data.error) return mount(root, h('p', { class: 'muted' }, data.error));
  const refresh = () => backlogTab(root, ctx);
  const jira = data.settings.source === 'jira';
  const epics = data.issues.filter((i) => i.issueType === 'epic');
  const people = data.members;
  const panel = h('aside', { class: 'iss-panel', hidden: true });
  const lists = h('div', { class: 'iss-lists' });

  const match = (i) => {
    const q = filters.q.trim().toLowerCase();
    return (!q || `${i.key} ${i.summary} ${(i.labels || []).join(' ')}`.toLowerCase().includes(q)) && (!filters.type || i.issueType === filters.type) && (!filters.epic || i.parentId === filters.epic) && (!filters.assignee || i.assigneeId === filters.assignee);
  };

  const draw = () => {
    const active = data.sprints.filter((s) => s.status === 'active');
    const planned = data.sprints.filter((s) => s.status === 'planned');
    const inBacklog = data.issues.filter((i) => !i.sprintId && i.issueType !== 'epic');
    mount(
      lists,
      [...active, ...planned].map((s) => container(s, data.issues.filter((i) => i.sprintId === s.id))),
      container(null, inBacklog),
    );
  };

  const container = (s, issues) => {
    const shown = issues.filter(match);
    const by = (st) => points(issues.filter((i) => i.status === st));
    const head = s
      ? h(
          'div',
          { class: 'iss-head' },
          h('div', { class: 'iss-title' }, h('strong', {}, s.name), ' ', h('span', { class: 'muted' }, `${s.startDate ? `${fmtDate(s.startDate)} – ${s.endDate ? fmtDate(s.endDate) : '…'} ` : ''}(${issues.length} issue${issues.length === 1 ? '' : 's'})`), s.goal ? h('div', { class: 'muted iss-goal' }, s.goal) : null),
          h('span', { class: 'iss-pts', title: 'Story points: to do · in progress · done' }, h('span', { class: 'p todo' }, String(by('todo'))), h('span', { class: 'p prog' }, String(by('in_progress'))), h('span', { class: 'p done' }, String(by('done')))),
          s.status === 'active'
            ? button('Complete sprint', { size: 'sm', onClick: () => completeSprint(s, issues, data, ctx) })
            : button('Start sprint', { size: 'sm', disabled: data.sprints.some((x) => x.status === 'active') || !issues.length, title: data.sprints.some((x) => x.status === 'active') ? 'Only one sprint can be in progress' : !issues.length ? 'Add issues first' : '', onClick: () => startSprint(s, issues, data, ctx) }),
          menu([
            ['Edit sprint', () => sprintForm(data, s, refresh)],
            s.status === 'planned' ? ['Delete sprint', async () => (await confirmDialog(`Delete ${s.name}? Its issues go back to the backlog.`, { danger: true, confirmLabel: 'Delete' })) && (await attempt(() => del(`/api/issues/boards/${data.boardId}/sprints/${s.id}`))) && refresh()] : null,
          ]),
        )
      : h('div', { class: 'iss-head' }, h('div', { class: 'iss-title' }, h('strong', {}, 'Backlog'), ' ', h('span', { class: 'muted' }, `(${issues.length} issue${issues.length === 1 ? '' : 's'})`)), h('span', { class: 'iss-pts' }, h('span', { class: 'p todo' }, String(by('todo'))), h('span', { class: 'p prog' }, String(by('in_progress'))), h('span', { class: 'p done' }, String(by('done')))), button('Create sprint', { size: 'sm', onClick: () => sprintForm(data, null, refresh) }));
    const box = h(
      'section',
      {
        class: `iss-box${s?.status === 'active' ? ' active' : ''}`,
        onDragover: (e) => (e.preventDefault(), box.classList.add('over')),
        onDragleave: () => box.classList.remove('over'),
        onDrop: async (e) => {
          e.preventDefault();
          box.classList.remove('over');
          const id = e.dataTransfer.getData('text/issue');
          const issue = data.issues.find((x) => x.id === id);
          if (!issue || (issue.sprintId || null) === (s?.id || null)) return;
          if (await attempt(() => patch(`/api/issues/boards/${data.boardId}/issues/${id}`, { sprintId: s?.id || null }))) {
            issue.sprintId = s?.id || null;
            draw();
          }
        },
      },
      head,
      h('div', { class: 'iss-rows' }, shown.length ? shown.map((i) => row(i)) : h('div', { class: 'iss-empty' }, s ? 'Plan a sprint by dragging issues here from the backlog.' : 'Your backlog is empty.')),
      jira ? null : h('button', { type: 'button', class: 'iss-create', onClick: () => issueForm(data, null, refresh, { sprintId: s?.id || null }) }, '+ Create issue'),
    );
    return box;
  };

  const row = (i) => {
    const epic = i.parentId && data.issues.find((x) => x.id === i.parentId);
    const who = people.find((p) => p.id === i.assigneeId) || (i.assigneeName ? { name: i.assigneeName } : null);
    const el = h(
      'div',
      { class: 'iss-row', draggable: 'true', tabindex: 0, onDragstart: (e) => e.dataTransfer.setData('text/issue', i.id), onClick: () => openPanel(i), onKeydown: (e) => e.key === 'Enter' && openPanel(i) },
      typeIcon(i.issueType),
      h('span', { class: `iss-key${i.status === 'done' ? ' done' : ''}` }, i.key),
      h('span', { class: 'iss-summary' }, i.summary),
      epic ? h('span', { class: 'iss-epic' }, epic.summary) : i.parentKey ? h('span', { class: 'iss-epic' }, i.parentKey) : null,
      h('span', { class: `iss-status ${i.status}` }, (i.statusName || STATUS[i.status]?.[0] || i.status).toUpperCase()),
      h('span', { class: 'iss-sp' }, i.storyPoints ?? '-'),
      h('span', { class: `iss-prio ${i.priority}`, title: PRIORITY[i.priority]?.[0] }, PRIO_ICON[i.priority] || ''),
      who ? h('span', { title: who.name }, avatar(who, 22)) : h('span', { class: 'iss-noone', title: 'Unassigned' }, ''),
    );
    if (panel.dataset.issue === i.id) el.classList.add('selected');
    return el;
  };

  const openPanel = (i) => {
    panel.dataset.issue = i.id;
    panel.hidden = false;
    root.querySelector('.iss-layout')?.classList.add('with-panel');
    issuePanel(panel, data, i, { close: () => ((panel.hidden = true), delete panel.dataset.issue, root.querySelector('.iss-layout')?.classList.remove('with-panel'), draw()), changed: refresh });
    draw();
  };

  const sel = (key, entries, label) => h('select', { onChange: (e) => ((filters[key] = e.target.value), draw()) }, h('option', { value: '' }, label), entries.map(([v, l]) => h('option', { value: v, selected: v === filters[key] }, l)));
  mount(
    root,
    h(
      'div',
      { class: 'issues-toolbar' },
      h('input', { type: 'search', placeholder: 'Search backlog', value: filters.q, onInput: (e) => ((filters.q = e.target.value), draw()) }),
      h('span', { class: 'iss-people' }, people.slice(0, 6).map((p) => h('button', { type: 'button', class: `iss-person${filters.assignee === p.id ? ' on' : ''}`, title: p.name, onClick: (e) => ((filters.assignee = filters.assignee === p.id ? '' : p.id), e.currentTarget.parentElement.querySelectorAll('.iss-person').forEach((b) => b.classList.toggle('on', b.title === p.name && filters.assignee === p.id)), draw()) }, avatar(p, 26)))),
      sel('epic', epics.map((e) => [e.id, e.summary]), 'Epic'),
      sel('type', Object.entries(TYPES), 'Type'),
      jira ? button('Sync from Jira', { iconName: 'jira', onClick: async () => (await attempt(() => post(`/api/issues/boards/${data.boardId}/sync`), 'Backlog synced')) && refresh() }) : null,
      jira ? h('span', { class: 'issues-sync' }, `Jira Team “${data.settings.jiraTeam}” · last sync ${data.sync.lastSyncAt ? fmtDateTime(data.sync.lastSyncAt) : 'never'}${data.sync.lastError ? ` · ${data.sync.lastError}` : ''}`) : null,
      epics.length ? h('span', { class: 'muted small iss-epics-note' }, `${epics.length} epic(s)`) : null,
    ),
    h('div', { class: 'iss-layout' }, lists, panel),
  );
  draw();
}

function typeIcon(t) {
  const [glyph, cls] = TYPE_ICON[t] || TYPE_ICON.task;
  return h('span', { class: `iss-type ${cls}`, title: TYPES[t] || t }, glyph);
}

function menu(items) {
  const list = items.filter(Boolean);
  const pop = h('div', { class: 'iss-menu', hidden: true }, list.map(([label, fn]) => h('button', { type: 'button', onClick: () => ((pop.hidden = true), fn()) }, label)));
  return h('span', { class: 'iss-menu-wrap' }, button('', { iconName: 'more', variant: 'ghost', size: 'sm', title: 'More', onClick: (e) => (e.stopPropagation(), (pop.hidden = !pop.hidden)) }), pop);
}

// ------------------------------------------------------------------ side panel (issue detail)
function issuePanel(panel, data, i, { close, changed }) {
  const manual = i.source === 'manual';
  const people = new Map(data.members.map((m) => [m.id, m]));
  const sprint = data.sprints.find((s) => s.id === i.sprintId);
  const epic = i.parentId && data.issues.find((x) => x.id === i.parentId);
  const statusSel = manual
    ? h('select', { class: `iss-status-sel ${i.status}`, onChange: async (e) => (await attempt(() => patch(`/api/issues/boards/${data.boardId}/issues/${i.id}`, { status: e.target.value }))) && changed() }, opts(STATUS, i.status))
    : h('span', { class: `iss-status ${i.status}` }, (i.statusName || STATUS[i.status]?.[0]).toUpperCase());
  const who = people.get(i.assigneeId) || (i.assigneeName ? { name: i.assigneeName } : null);
  const rep = people.get(i.reporterId) || (i.reporterName ? { name: i.reporterName } : null);
  const detail = (label, value) => [h('dt', {}, label), h('dd', {}, value ?? h('span', { class: 'muted' }, 'None'))];
  mount(
    panel,
    h(
      'div',
      { class: 'iss-panel-head' },
      h('span', { class: 'iss-crumbs' }, epic ? [typeIcon('epic'), ` ${epic.key} / `] : null, typeIcon(i.issueType), ` ${i.key}`),
      h('span', {}, manual ? button('', { iconName: 'edit', variant: 'ghost', size: 'sm', title: 'Edit', onClick: () => issueForm(data, i, changed) }) : null, i.url ? button('', { iconName: 'link', variant: 'ghost', size: 'sm', title: 'Open in Jira', onClick: () => window.open(i.url, '_blank', 'noopener') }) : null, button('', { iconName: 'x', variant: 'ghost', size: 'sm', title: 'Close', onClick: close })),
    ),
    h('h2', { class: 'iss-panel-title' }, i.summary),
    h('div', {}, statusSel),
    h('h4', {}, 'Description'),
    i.description ? h('p', { class: 'iss-desc' }, i.description) : h('p', { class: 'muted' }, 'No description.'),
    h(
      'details',
      { class: 'iss-details', open: true },
      h('summary', {}, 'Details'),
      h(
        'dl',
        {},
        ...detail('Assignee', who ? h('span', { class: 'person' }, avatar(who, 20), who.name) : null),
        ...detail('Reporter', rep ? h('span', { class: 'person' }, avatar(rep, 20), rep.name) : null),
        ...detail('Labels', i.labels?.length ? h('span', { class: 'issues-labels' }, i.labels.map((l) => badge(l))) : null),
        ...detail('Sprint', sprint?.name || i.jiraSprint || null),
        ...detail('Priority', PRIORITY[i.priority] ? h('span', { class: `iss-prio ${i.priority}` }, `${PRIO_ICON[i.priority]} ${PRIORITY[i.priority][0]}`) : null),
        ...detail('Story points', i.storyPoints ?? null),
        ...detail('Due date', i.dueDate ? fmtDate(i.dueDate) : null),
        ...detail('Parent', epic ? `${epic.key} ${epic.summary}` : i.parentKey || null),
      ),
    ),
    h('p', { class: 'muted small' }, manual ? `Created ${fmtDateTime(i.createdAt)}` : `From Jira · synced ${fmtDateTime(i.syncedAt)}. Edit it in Jira.`),
  );
}

// ------------------------------------------------------------------ Current sprint tab
async function currentTab(root, ctx) {
  const data = await load(ctx.board).catch((e) => ({ error: e.message }));
  if (data.error) return mount(root, h('p', { class: 'muted' }, data.error));
  const s = data.sprints.find((x) => x.status === 'active');
  if (!s) return rerenderBoard(ctx);
  const refresh = () => currentTab(root, ctx);
  const issues = data.issues.filter((i) => i.sprintId === s.id);
  const left = s.endDate ? Math.ceil((new Date(`${s.endDate}T23:59:59`) - Date.now()) / 864e5) : null;
  const col = (st) => {
    const list = issues.filter((i) => i.status === st);
    return h(
      'div',
      {
        class: 'iss-col',
        onDragover: (e) => e.preventDefault(),
        onDrop: async (e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData('text/issue');
          const i = issues.find((x) => x.id === id);
          if (!i || i.status === st || i.source !== 'manual') return;
          if (await attempt(() => patch(`/api/issues/boards/${data.boardId}/issues/${id}`, { status: st }))) refresh();
        },
      },
      h('div', { class: 'iss-col-head' }, `${STATUS[st][0].toUpperCase()} ${list.length}`),
      list.map((i) => {
        const who = data.members.find((p) => p.id === i.assigneeId) || (i.assigneeName ? { name: i.assigneeName } : null);
        return h(
          'div',
          { class: 'iss-card', draggable: i.source === 'manual' ? 'true' : 'false', onDragstart: (e) => e.dataTransfer.setData('text/issue', i.id), onClick: () => (i.source === 'manual' ? issueForm(data, i, refresh) : null) },
          h('div', {}, i.summary),
          h('div', { class: 'iss-card-foot' }, typeIcon(i.issueType), h('span', { class: 'iss-key' }, i.key), h('span', { class: `iss-prio ${i.priority}` }, PRIO_ICON[i.priority]), h('span', { class: 'iss-sp' }, i.storyPoints ?? '-'), who ? avatar(who, 22) : null),
        );
      }),
    );
  };
  mount(
    root,
    h(
      'div',
      { class: 'iss-current-head' },
      h('div', {}, h('h3', {}, s.name), h('div', { class: 'muted' }, `${fmtDate(s.startDate)} → ${fmtDate(s.endDate)}${left !== null ? ` · ${left >= 0 ? `${left} day(s) left` : `${-left} day(s) overdue`}` : ''}`), s.goal ? h('p', { class: 'iss-goal-box' }, h('strong', {}, 'Sprint goal: '), s.goal) : null),
      h('div', { class: 'iss-current-actions' }, h('span', { class: 'muted' }, `${points(issues.filter((i) => i.status === 'done'))}/${points(issues)} pts done · ${issues.filter((i) => i.status === 'done').length}/${issues.length} issues`), button('Complete sprint', { variant: 'primary', onClick: () => completeSprint(s, issues, data, ctx) })),
    ),
    h('div', { class: 'iss-columns' }, ['todo', 'in_progress', 'done'].map(col)),
  );
}

// ------------------------------------------------------------------ sprint dialogs
function sprintForm(data, s, done) {
  const base = `/api/issues/boards/${data.boardId}/sprints`;
  const form = h(
    'form',
    { id: 'issues-sprint-form', class: 'issues-form', onSubmit: (e) => (e.preventDefault(), save()) },
    h('div', { class: 'full' }, field('Sprint name', h('input', { name: 'name', value: s?.name || '', placeholder: 'Leave empty for "Sprint N"', maxlength: 80 }))),
    h('div', { class: 'full' }, field('Sprint goal', h('textarea', { name: 'goal', rows: 2 }, s?.goal || ''))),
    field('Start date', h('input', { type: 'date', name: 'startDate', value: s?.startDate || '' })),
    field('End date', h('input', { type: 'date', name: 'endDate', value: s?.endDate || '' })),
  );
  const save = async () => {
    const body = { goal: val(form, 'goal'), startDate: val(form, 'startDate') || null, endDate: val(form, 'endDate') || null };
    if (val(form, 'name') || s) body.name = val(form, 'name');
    const r = await attempt(() => (s ? patch(`${base}/${s.id}`, body) : post(base, body)), s ? 'Sprint updated' : 'Sprint created');
    if (r) (m.close(), done());
  };
  const m = modal({ title: s ? `Edit ${s.name}` : 'Create sprint', body: form, actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'issues-sprint-form' }, s ? 'Save' : 'Create')] });
}

// Start: name, goal and dates are confirmed here (shown in Current sprint).
function startSprint(s, issues, data, ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const plus = (d, n) => new Date(new Date(`${d}T12:00:00`).getTime() + n * 864e5).toISOString().slice(0, 10);
  const startIn = h('input', { type: 'date', name: 'startDate', value: s.startDate || today, required: true });
  const endIn = h('input', { type: 'date', name: 'endDate', value: s.endDate || plus(today, 13), required: true });
  const dur = h('select', { onChange: (e) => e.target.value && (endIn.value = plus(startIn.value, Number(e.target.value) * 7 - 1)) }, h('option', { value: '' }, 'Custom'), [1, 2, 3, 4].map((w) => h('option', { value: w, selected: w === 2 && !s.endDate }, `${w} week${w > 1 ? 's' : ''}`)));
  const form = h(
    'form',
    { id: 'issues-start-form', class: 'issues-form' },
    h('p', { class: 'full' }, `${issues.length} issue(s) and ${points(issues)} story point(s) will be included in this sprint.`),
    h('div', { class: 'full' }, field('Sprint name', h('input', { name: 'name', value: s.name, required: true }))),
    field('Duration', dur),
    h('span', {}),
    field('Start date', startIn),
    field('End date', endIn),
    h('div', { class: 'full' }, field('Sprint goal', h('textarea', { name: 'goal', rows: 3 }, s.goal || ''))),
  );
  const m = modal({
    title: `Start sprint`,
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button('Start', {
        variant: 'primary',
        onClick: async () => {
          const base = `/api/issues/boards/${data.boardId}/sprints/${s.id}`;
          if (val(form, 'name') !== s.name && !(await attempt(() => patch(base, { name: val(form, 'name') })))) return;
          if (await attempt(() => post(`${base}/start`, { startDate: val(form, 'startDate'), endDate: val(form, 'endDate'), goal: val(form, 'goal') }), 'Sprint started')) {
            m.close();
            ctx.selectTab?.('current');
            rerenderBoard(ctx);
          }
        },
      }),
    ],
  });
}

function completeSprint(s, issues, data, ctx) {
  const open = issues.filter((i) => i.status !== 'done');
  const targets = data.sprints.filter((x) => x.status === 'planned');
  const form = h(
    'form',
    { class: 'stack' },
    h('p', {}, `${issues.length - open.length} completed issue(s) · ${open.length} open issue(s).`),
    open.length ? field('Move open issues to', h('select', { name: 'moveOpenTo' }, h('option', { value: '' }, 'Backlog'), targets.map((t) => h('option', { value: t.id }, t.name)))) : null,
    h('p', { class: 'muted small' }, 'Completing the sprint starts its retrospective.'),
  );
  const m = modal({
    title: `Complete ${s.name}`,
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button('Complete sprint', {
        variant: 'primary',
        onClick: async () => {
          const r = await attempt(() => post(`/api/issues/boards/${data.boardId}/sprints/${s.id}/complete`, { moveOpenTo: val(form, 'moveOpenTo') || null }), 'Sprint completed');
          if (!r) return;
          m.close();
          ctx.selectTab?.('backlog');
          rerenderBoard(ctx);
          newRetro(ctx, r.sprint);
        },
      }),
    ],
  });
}

// The retro is retro's own dialog (templates, columns); this sprint is passed along.
function newRetro(ctx, s) {
  const today = new Date().toISOString().slice(0, 10);
  ctx.newRetro?.({ title: `Retro of ${s.name}`, initial: { name: `${s.name} retro`, start: s.startDate || today, end: s.endDate || today }, extraBody: { deliverySprintId: s.id } });
}

// ------------------------------------------------------------------ create / edit (manual)
function issueForm(data, issue, done, defaults = {}) {
  const people = data.members.map((p) => [p.id, p.name]);
  const sel = (name, entries, value, empty) => h('select', { name }, empty !== undefined ? h('option', { value: '' }, empty) : null, entries.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const parents = data.issues.filter((x) => x.source === 'manual' && x.id !== issue?.id && x.issueType !== 'subtask').map((x) => [x.id, `${x.key} · ${x.summary}`]);
  const form = h(
    'form',
    { id: 'issue-form', class: 'issues-form', onSubmit: (e) => (e.preventDefault(), save()) },
    field('Issue type', h('select', { name: 'issueType' }, opts(TYPES, issue?.issueType || 'story'))),
    field('Status', h('select', { name: 'status' }, opts(STATUS, issue?.status || 'todo'))),
    h('div', { class: 'full' }, field('Summary', h('input', { name: 'summary', value: issue?.summary || '', required: true, maxlength: 255 }))),
    h('div', { class: 'full' }, field('Description', h('textarea', { name: 'description', rows: 5 }, issue?.description || ''))),
    field('Assignee', sel('assigneeId', people, issue?.assigneeId, 'Unassigned')),
    field('Reporter', sel('reporterId', people, issue?.reporterId, '—')),
    field('Priority', h('select', { name: 'priority' }, opts(PRIORITY, issue?.priority || 'medium'))),
    field('Labels', h('input', { name: 'labels', value: (issue?.labels || []).join(', '), placeholder: 'comma separated' })),
    field('Sprint', sel('sprintId', openSprints(data).map((s) => [s.id, s.name]), issue ? issue.sprintId : defaults.sprintId, 'Backlog (no sprint)')),
    field('Story points', h('input', { name: 'storyPoints', type: 'number', min: 0, step: 'any', value: issue?.storyPoints ?? '' })),
    field('Parent (epic)', sel('parentId', parents, issue?.parentId, 'None')),
    field('Due date', h('input', { name: 'dueDate', type: 'date', value: issue?.dueDate || '' })),
  );
  if (!issue) form.querySelector('[name="reporterId"]').value = '';
  const base = `/api/issues/boards/${data.boardId}/issues`;
  const save = async () => {
    const body = Object.fromEntries(['issueType', 'status', 'summary', 'description', 'assigneeId', 'priority', 'labels', 'sprintId', 'storyPoints', 'parentId', 'dueDate'].map((k) => [k, val(form, k)]));
    if (val(form, 'reporterId')) body.reporterId = val(form, 'reporterId');
    body.dueDate ||= null;
    const r = await attempt(() => (issue ? patch(`${base}/${issue.id}`, body) : post(base, body)), issue ? 'Issue updated' : 'Issue created');
    if (r) (m.close(), done());
  };
  const m = modal({
    title: issue ? `Edit ${issue.key}` : 'Create issue',
    wide: true,
    body: form,
    actions: [
      issue ? button('Delete', { variant: 'danger-ghost', iconName: 'trash', onClick: async () => { if (await confirmDialog(`Delete ${issue.key}?`, { danger: true, confirmLabel: 'Delete' })) { if (await attempt(() => del(`${base}/${issue.id}`), 'Issue deleted')) (m.close(), done()); } } }) : null,
      button('Cancel', { onClick: () => m.close() }),
      h('button', { class: 'btn btn-primary', type: 'submit', form: 'issue-form' }, issue ? 'Save' : 'Create'),
    ].filter(Boolean),
  });
}

// ------------------------------------------------------------------ board settings
export function backlogSettings({ board, canManage }) {
  if (!canManage) return [];
  const box = h('div', { class: 'issues-settings' }, h('p', { class: 'muted' }, 'Loading…'));
  get(`/api/issues/boards/${board.id}`).then(({ settings }) => {
    const jiraFields = h(
      'div',
      { class: 'stack' },
      field('Jira Team', h('input', { name: 'jiraTeam', value: settings.jiraTeam, placeholder: 'Team name or team id' }), 'Only issues of this Team (Jira field "Team") are shown. Sync uses your Jira account (My account → Integrations).'),
      field('Jira project (optional)', h('input', { name: 'jiraProject', value: settings.jiraProject, placeholder: 'e.g. PAY' })),
    );
    const prefix = field('Key prefix for new issues', h('input', { name: 'keyPrefix', value: settings.keyPrefix, maxlength: 10 }));
    const sourceSel = h('select', { name: 'source', onChange: (e) => toggle(e.target.value) }, h('option', { value: 'manual', selected: settings.source === 'manual' }, 'Manual: created here'), h('option', { value: 'jira', selected: settings.source === 'jira' }, 'Jira: read the issues of a Jira Team'));
    const toggle = (v) => (jiraFields.style.display = v === 'jira' ? '' : 'none');
    toggle(settings.source);
    mount(
      box,
      h('h3', {}, 'Backlog'),
      field('Where the issues come from', sourceSel),
      jiraFields,
      prefix,
      button('Save backlog settings', {
        onClick: async () => {
          const pick = (n) => box.querySelector(`[name="${n}"]`).value;
          await attempt(() => patch(`/api/issues/boards/${board.id}/settings`, { source: pick('source'), jiraTeam: pick('jiraTeam'), jiraProject: pick('jiraProject'), keyPrefix: pick('keyPrefix') }), 'Backlog settings saved');
        },
      }),
    );
  }, (e) => mount(box, h('p', { class: 'muted' }, e.message)));
  return [box];
}
