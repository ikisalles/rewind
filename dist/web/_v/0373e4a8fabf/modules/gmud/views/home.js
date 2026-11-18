// GMUD widgets for the home page: changes waiting for your decision, upcoming windows.
import { h, button, table, section } from '@rewind/web/ui.js';
import { statusBadge, levelBadge, envLabel, when, loadPeople, peopleReady, personChip } from '../lib.js';
import { createChange } from './changes.js';

// the tables show people's names: the first time, load them and draw the home page again
let loading = false;
const withPeople = (refresh) => {
  if (peopleReady() || loading) return;
  loading = true;
  loadPeople().then(refresh, () => {});
};

const changeTable = (list) =>
  table(
    ['ID', 'Title', 'Responsible', 'Environment', 'Window', 'Risk', 'Status'],
    list.map((c) =>
      h(
        'tr',
        { class: 'row-link', onClick: () => (location.hash = `#/changes/${c.id}`) },
        h('td', { class: 'mono nowrap' }, h('a', { href: `#/changes/${c.id}` }, c.number)),
        h('td', {}, c.title || h('span', { class: 'muted' }, 'Untitled draft')),
        h('td', { class: 'nowrap' }, personChip(c.responsibleId)),
        h('td', {}, envLabel(c.environment)),
        h('td', { class: 'nowrap' }, when(c.plannedAt)),
        h('td', {}, levelBadge(c.risk)),
        h('td', {}, statusBadge(c.status)),
      ),
    ),
  );

export const home = {
  actions: () => [button('New change', { iconName: 'change', onClick: createChange })],

  metrics: ({ data }) => [
    ['Changes awaiting you', data.gmud.awaitingMe.length],
    ['Changes waiting for approval', data.gmud.counts.waiting],
  ],

  housekeeping: ({ data }) =>
    (data.admin?.gmud?.overdue || []).slice(0, 5).map((c) => ({
      icon: 'clock',
      title: `${c.number}: the window has passed`,
      hint: `${c.title || 'Untitled'} was planned for ${when(c.plannedAt)} and is still ${c.status}.`,
      href: `#/changes/${c.id}`,
      cta: 'Open',
    })),

  sections: ({ data, refresh }) => (withPeople(refresh), [
    data.gmud.awaitingMe.length ? section('Changes waiting for your approval', changeTable(data.gmud.awaitingMe)) : null,
    data.gmud.upcoming.length ? section('Upcoming change windows', changeTable(data.gmud.upcoming)) : null,
    data.gmud.mine.length ? section('My open changes', changeTable(data.gmud.mine.slice(0, 8))) : null,
  ]),
};
