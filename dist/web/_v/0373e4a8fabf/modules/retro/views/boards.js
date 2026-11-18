import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, field, badge, table, modal, fmtDate, fmtDateTime, today, attempt, confirmDialog, pageHeader, section } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import { loadTemplates, templatePicker } from './templates.js';

export const statusBadge = (sprint) =>
  sprint.status === 'finished' ? badge('Finished', 'neutral', 'lock') : badge('Open', 'success', 'check');

// ------------------------------------------------------------- one board
export function sprintForm({ initial = {}, onSubmit, id, extra = null }) {
  const start = initial.start || today();
  const end = initial.end || new Date(Date.now() + 13 * 864e5).toISOString().slice(0, 10);
  return h(
    'form',
    {
      class: 'stack',
      id,
      onSubmit: async (e) => {
        e.preventDefault();
        await onSubmit(Object.fromEntries(new FormData(e.target)));
      },
    },
    field('Sprint name', h('input', { name: 'name', required: true, maxlength: 80, value: initial.name || '', placeholder: 'e.g. Sprint 42' })),
    h(
      'div',
      { class: 'grid-2' },
      field('Start date', h('input', { name: 'start', type: 'date', required: true, value: start })),
      field('End date', h('input', { name: 'end', type: 'date', required: true, value: end })),
    ),
    extra,
  );
}

export async function boardView(root, { params }) {
  const { board, sprints, canManage } = await get(`/api/boards/${params.boardId}`);
  const team = store.me.teams.find((t) => t.id === board.teamId);

  const create = async () => {
    const templates = await attempt(loadTemplates);
    if (!templates) return;
    const m = modal({
      title: 'New sprint',
      wide: true,
      body: [
        sprintForm({
          id: 'sprint-form',
          initial: { name: `Sprint ${sprints.length + 1}` },
          extra: templatePicker(templates),
          onSubmit: async ({ startMode, template, ...data }) => {
            const body = { ...data, template: startMode === 'blank' ? 'blank' : template };
            const r = await attempt(() => post(`/api/boards/${board.id}/sprints`, body), 'Sprint created');
            if (r) {
              m.close();
              location.hash = `#/sprint/${r.sprint.id}`;
            }
          },
        }),
        h('p', { class: 'muted small' }, 'Notes start hidden. You can change the columns and reveal the notes on the board.'),
      ],
      actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'sprint-form' }, 'Create sprint')],
    });
  };

  const rename = () => {
    const m = modal({
      title: 'Edit board',
      body: h(
        'form',
        {
          id: 'rename-form',
          class: 'stack',
          onSubmit: async (e) => {
            e.preventDefault();
            if (await attempt(() => patch(`/api/boards/${board.id}`, Object.fromEntries(new FormData(e.target))), 'Board updated')) {
              m.close();
              boardView(root, { params });
            }
          },
        },
        field('Name', h('input', { name: 'name', value: board.name, required: true, maxlength: 80 })),
      ),
      actions: [
        button('Delete board', {
          variant: 'danger-ghost',
          iconName: 'trash',
          onClick: async () => {
            if (!(await confirmDialog('Delete this board? It must have no sprints.', { danger: true, confirmLabel: 'Delete' }))) return;
            if (await attempt(() => del(`/api/boards/${board.id}`), 'Board deleted')) {
              m.close();
              location.hash = '#/boards';
            }
          },
        }),
        h('button', { class: 'btn btn-primary', type: 'submit', form: 'rename-form' }, 'Save'),
      ],
    });
  };

  mount(
    root,
    pageHeader(
      board.name,
      [canManage && button('', { iconName: 'settings', variant: 'icon', title: 'Edit board', onClick: rename }), button('New sprint', { iconName: 'plus', onClick: create })],
      [['Boards', '#/boards'], [team?.name || 'Team']],
    ),
    section(
      'Sprints',
      table(
        ['Sprint', 'Period', 'Status', 'Created'],
        sprints.map((s) =>
          h(
            'tr',
            { class: 'row-link', onClick: () => (location.hash = `#/sprint/${s.id}`) },
            h('td', {}, h('a', { href: `#/sprint/${s.id}`, class: 'strong' }, s.name)),
            h('td', {}, `${fmtDate(s.start)} → ${fmtDate(s.end)}`),
            h('td', {}, statusBadge(s)),
            h('td', {}, fmtDateTime(s.createdAt)),
          ),
        ),
        { empty: 'No sprints yet. Create the first one to start the retro.' },
      ),
    ),
  );
}

// ------------------------------------------------------------- boards list (#/boards)
export async function boardsListView(root) {
  const { user, teams } = store.me;
  const { boards } = await get('/api/boards');
  const teamName = (id) => teams.find((t) => t.id === id)?.name || '—';
  const myTeams = user.role === 'admin' ? teams : teams.filter((t) => user.teamIds.includes(t.id));

  mount(
    root,
    pageHeader('Boards', [button('New board', { iconName: 'plus', onClick: () => createBoard(myTeams), variant: 'default' })], [['Home', '#/home']]),
    section(
      'Team boards',
      table(
        ['Board', 'Team', 'Sprints', 'Latest sprint', 'Status', 'Created'],
        boards.map((b) =>
          h(
            'tr',
            { class: 'row-link', onClick: () => (location.hash = `#/boards/${b.id}`) },
            h('td', {}, h('a', { href: `#/boards/${b.id}`, class: 'strong' }, b.name)),
            h('td', {}, teamName(b.teamId)),
            h('td', {}, String(b.sprintCount)),
            h('td', {}, b.lastSprint ? h('a', { href: `#/sprint/${b.lastSprint.id}`, class: 'underline', onClick: (e) => e.stopPropagation() }, b.lastSprint.name) : h('span', { class: 'muted' }, '—')),
            h('td', {}, b.lastSprint ? statusBadge(b.lastSprint) : badge('No sprints')),
            h('td', {}, fmtDateTime(b.createdAt)),
          ),
        ),
        { empty: "No boards yet. Create your team's first board." },
      ),
    ),
  );
}

// ------------------------------------------------------------- new board
export function createBoard(myTeams) {
  const m = modal({
    title: 'New team board',
    body: h(
      'form',
      {
        class: 'stack',
        id: 'board-form',
        onSubmit: async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.target));
          const r = await attempt(() => post('/api/boards', data), 'Board created');
          if (r) {
            m.close();
            location.hash = `#/boards/${r.board.id}`;
          }
        },
      },
      field('Board name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'e.g. Payments Squad Retro' })),
      field('Team', h('select', { name: 'teamId', required: true }, myTeams.map((t) => h('option', { value: t.id }, t.name)))),
    ),
    actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'board-form' }, 'Create board')],
  });
}
