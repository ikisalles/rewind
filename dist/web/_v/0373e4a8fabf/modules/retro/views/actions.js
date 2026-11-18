import { get, patch } from '@rewind/web/api.js';
import { h, mount, table, fmtDate, attempt, badge, pageHeader, section } from '@rewind/web/ui.js';

export async function myActionsView(root) {
  const { actions } = await get('/api/actions/mine');
  const today = new Date().toISOString().slice(0, 10);

  mount(
    root,
    pageHeader('My action items', [], [['Home', '#/home']]),
    section(
      `Open (${actions.length})`,
      table(
        ['', 'Action item', 'Board', 'Sprint', 'Due date'],
        actions.map((a) =>
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
                  if (await attempt(() => patch(`/api/sprints/${a.sprint.id}/actions/${a.id}`, { done: e.target.checked }), 'Action item done')) {
                    myActionsView(root);
                  } else e.target.checked = false;
                },
              }),
            ),
            h('td', { class: 'strong' }, a.text),
            h('td', {}, h('a', { href: `#/boards/${a.board.id}` }, a.board.name)),
            h('td', {}, h('a', { href: `#/sprint/${a.sprint.id}`, class: 'underline' }, a.sprint.name)),
            h('td', {}, a.due ? (a.due < today ? badge(`${fmtDate(a.due)} · overdue`, 'danger') : fmtDate(a.due)) : h('span', { class: 'muted' }, 'No date')),
          ),
        ),
        { empty: 'No open action items for you. 🎉' },
      ),
    ),
  );
}
