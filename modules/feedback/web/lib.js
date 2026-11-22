// Shared pieces of the Feedback & Recognition pages: catalog, people picker
// (search by name/e-mail, add a whole team/group), live audience preview, links.
import { get, post } from '@rewind/web/api.js';
import { h, mount, avatar, field } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';

let catalog = null;
let people = null;
export async function load(force = false) {
  if (!catalog || force) [catalog, people] = await Promise.all([get('/api/feedback/catalog'), get('/api/feedback/people')]);
  return { catalog, people };
}
export const cat = () => catalog;
export const personName = (id) => people?.people.find((p) => p.id === id)?.name || (id ? 'Former member' : '—');
export const personChip = (id) => h('span', { class: 'person' }, avatar(people?.people.find((p) => p.id === id) || { name: '?' }, 20), personName(id));
export const names = (ids) => ids.map(personName).join(', ');
export const categoryLabel = (key) => catalog?.categories.find((c) => c.key === key)?.label || key;

export const AUDIENCE = { private: 'Only participants', team: 'A team', group: 'A group', org: 'Everyone in the company' };
export const KINDS = { requested: 'Requested', offered: 'Offered', continuous: 'Continuous', after_event: 'After an event' };
export const REQUEST_STATUS = { open: ['Open', 'info'], answered: ['Answered', 'success'], closed: ['Closed', 'neutral'], cancelled: ['Cancelled', 'neutral'] };

export function audienceText(a) {
  if (a.type === 'team') return `Team: ${people?.teams.find((t) => t.id === a.id)?.name || '—'}`;
  if (a.type === 'group') return `Group: ${people?.groups.find((g) => g.id === a.id)?.name || '—'}`;
  return AUDIENCE[a.type];
}

// Recipients: search box + checkboxes; "add team/group" ticks its members.
export function peoplePicker(selected = new Set()) {
  const me = store.me.user.id;
  const list = h('div', { class: 'fb-people' });
  const q = h('input', { type: 'search', placeholder: 'Search by name or e-mail', onInput: () => draw() });
  let matches = null;
  const draw = async () => {
    const term = q.value.trim();
    matches = term ? new Set((await get(`/api/feedback/people?q=${encodeURIComponent(term)}`)).people.map((p) => p.id)) : null;
    mount(list, people.people.filter((p) => p.id !== me && (!matches || matches.has(p.id) || selected.has(p.id))).map((p) =>
      h('label', {}, h('input', { type: 'checkbox', checked: selected.has(p.id), onChange: (e) => (e.target.checked ? selected.add(p.id) : selected.delete(p.id)) }), avatar(p, 18), p.name)));
  };
  const addScope = h('select', { onChange: (e) => {
    const [type, id] = e.target.value.split(':');
    const scope = (type === 'team' ? people.teams : people.groups).find((x) => x.id === id);
    for (const uid of scope?.memberIds || []) if (uid !== me) selected.add(uid);
    e.target.value = '';
    draw();
  } }, h('option', { value: '' }, 'Add a whole team/group…'),
    people.teams.map((t) => h('option', { value: `team:${t.id}` }, `Team: ${t.name}`)),
    people.groups.map((g) => h('option', { value: `group:${g.id}` }, `Group: ${g.name}`)));
  draw();
  return { el: h('div', {}, h('div', { class: 'fb-row' }, q, addScope), list), selected };
}

// Audience selector with the "who will see this" preview (spec §4.1).
export function audiencePicker({ kind, types, recipients, initial = { type: 'private' } }) {
  const scope = h('span', {});
  const preview = h('div', { class: 'fb-preview', 'aria-live': 'polite' });
  const value = { ...initial };
  const refresh = async () => {
    try {
      const r = await post('/api/feedback/audience-preview', { kind, audience: value, recipientIds: [...recipients] });
      mount(preview, h('strong', {}, 'Who will see it: '), r.summary, ` (${r.count} ${r.count === 1 ? 'person' : 'people'})`);
    } catch (e) {
      mount(preview, h('span', { class: 'fb-error' }, e.message));
    }
  };
  const drawScope = () => {
    if (value.type !== 'team' && value.type !== 'group') return mount(scope);
    const mineOnly = (x) => x.memberIds.includes(store.me.user.id);
    const list = (value.type === 'team' ? people.teams : people.groups).filter(mineOnly);
    if (!list.some((x) => x.id === value.id)) value.id = list[0]?.id || null;
    mount(scope, h('select', { onChange: (e) => ((value.id = e.target.value), refresh()) }, list.map((x) => h('option', { value: x.id, selected: x.id === value.id }, x.name))));
  };
  const typeSel = h('select', { onChange: (e) => ((value.type = e.target.value), drawScope(), refresh()) }, types.map((t) => h('option', { value: t, selected: t === value.type }, AUDIENCE[t])));
  drawScope();
  refresh();
  return { el: field('Audience', h('div', {}, h('div', { class: 'fb-row' }, typeSel, scope), preview)), value, refresh };
}

// Optional links to goals, retros, GMUDs, incidents or a delivery.
export function linksPicker() {
  const rows = [];
  const wrap = h('div', {});
  const add = () => {
    const type = h('select', {}, Object.entries(catalog.linkTargets).map(([k, v]) => h('option', { value: k }, v)));
    const id = h('input', { placeholder: 'Id or URL of the item' });
    rows.push({ type, id });
    wrap.append(h('div', { class: 'fb-row' }, type, id));
  };
  return {
    el: field('Links (optional)', h('div', {}, wrap, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: add }, '+ Link to an objective, retro, GMUD…'))),
    value: () => rows.map((r) => ({ targetType: r.type.value, targetId: r.id.value.trim() })).filter((l) => l.targetId),
  };
}

// links keep only an id: titles come from the target module, with the viewer's permissions
export function linkChip(l) {
  const slot = h('span', { class: 'fb-link' }, `${catalog?.linkTargets[l.targetType] || l.targetType}…`);
  const label = catalog?.linkTargets[l.targetType] || l.targetType;
  const resolve = {
    goal_objective: async () => { const { objective } = await get(`/api/goals/objectives/${l.targetId}`); return [objective.title, `#/goals/${objective.id}`]; },
    retro_board: async () => { const { board } = await get(`/api/boards/${l.targetId}`); return [board.name, `#/boards/${board.id}`]; },
    gmud_change: async () => { const { change } = await get(`/api/gmud/changes/${l.targetId}`); return [`${change.number} ${change.title || ''}`, `#/changes/${change.id}`]; },
  }[l.targetType];
  if (!resolve) {
    const url = /^https?:\/\//.test(l.targetId) ? l.targetId : null;
    mount(slot, `${label}: `, url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url) : l.targetId);
  } else {
    resolve().then(([t, href]) => mount(slot, `${label}: `, h('a', { href }, t)), () => mount(slot, `${label}: `, h('em', { class: 'muted' }, 'restricted or unavailable')));
  }
  return slot;
}

export const prose = (t) => (t ? h('p', { class: 'fb-prose' }, t) : null);
