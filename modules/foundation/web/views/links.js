// Company settings → Entity links. Shows every EntityReference and lets admins
// prune. Modules create links through POST /api/foundation/links from their
// own pages (e.g. a goal that supports an objective).
import { del, get } from '@rewind/web/api.js';
import { h, mount, button, table, section, attempt, confirmDialog, fmtDateTime } from '@rewind/web/ui.js';
import { isAdmin } from '@rewind/web/app.js';
import { personName } from './shared.js';

export async function linksTab(root, reload) {
  if (!isAdmin()) return mount(root, h('p', { class: 'muted' }, 'Only admins can manage entity links.'));
  const [{ links }, dir] = await Promise.all([get('/api/foundation/links'), get('/api/foundation/directory')]);

  mount(
    root,
    section(
      'Entity links',
      h('p', { class: 'fdn-hint' }, 'A link never grants access to its target — the backend revalidates authorization on each follow (spec §5.1).'),
      table(
        ['When', 'Source', 'Target', 'Relationship', 'By', ''],
        [...links].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((l) =>
          h(
            'tr',
            {},
            h('td', {}, fmtDateTime(l.createdAt)),
            h('td', {}, h('span', { class: 'fdn-code' }, `${l.sourceType}:${l.sourceId}`)),
            h('td', {}, h('span', { class: 'fdn-code' }, `${l.targetType}:${l.targetId}`)),
            h('td', {}, h('span', { class: 'fdn-tag' }, l.relationshipType)),
            h('td', {}, personName(dir.users, l.createdBy)),
            h(
              'td',
              {},
              button('Delete', {
                variant: 'danger',
                onClick: async () => {
                  if (!(await confirmDialog('Delete this link?', { danger: true, confirmLabel: 'Delete' }))) return;
                  if (await attempt(() => del(`/api/foundation/links/${l.id}`), 'Link deleted')) reload();
                },
              }),
            ),
          ),
        ),
      ),
    ),
  );
}
