// Kudos feed (filters, reactions) and one recognition. No points, no rankings.
import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, pageHeader, section, attempt, confirmDialog, fmtDateTime, badge, modal } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import { AUDIENCE, audiencePicker, audienceText, cat, categoryLabel, linkChip, load, names, personChip, prose } from '../lib.js';
import { giveKudos } from './forms.js';

const state = { category: '', audience: '', mine: false };

export function recognitionCard(r, redraw) {
  const me = store.me.user.id;
  return h(
    'article',
    { class: 'fb-card' },
    h('div', { class: 'fb-card-head' }, personChip(r.authorId), h('span', { class: 'muted' }, 'recognized'), h('strong', {}, names(r.recipientIds)), badge(categoryLabel(r.category), 'accent')),
    r.context ? [h('div', { class: 'fb-label' }, 'Context'), prose(r.context)] : null,
    h('div', { class: 'fb-label' }, 'Contribution'), prose(r.contribution),
    r.impact ? [h('div', { class: 'fb-label' }, 'Impact'), prose(r.impact)] : null,
    r.links?.length ? h('div', { class: 'fb-meta' }, r.links.map(linkChip)) : null,
    h(
      'div',
      { class: 'fb-meta' },
      h('a', { href: `#/kudos/${r.id}` }, fmtDateTime(r.createdAt)),
      h('span', {}, `Visible to: ${audienceText(r.audience)}`),
      h('div', { class: 'fb-reactions' }, cat().reactions.map((e) =>
        h('button', { type: 'button', class: r.myReactions.includes(e) ? 'on' : '', 'aria-pressed': r.myReactions.includes(e) ? 'true' : 'false', onClick: async () => (await attempt(() => post(`/api/feedback/recognitions/${r.id}/reactions`, { emoji: e }))) && redraw() }, e, r.reactions[e] ? ` ${r.reactions[e]}` : ''))),
      r.authorId === me
        ? [
            button('Change audience', { size: 'sm', variant: 'ghost', onClick: () => changeAudience(r, redraw) }),
            button('Delete', { size: 'sm', variant: 'ghost', onClick: async () => (await confirmDialog('Delete this recognition?', { danger: true, confirmLabel: 'Delete' })) && (await attempt(() => del(`/api/feedback/recognitions/${r.id}`), 'Deleted')) && redraw() }),
          ]
        : null,
    ),
  );
}

function changeAudience(r, redraw) {
  const aud = audiencePicker({ kind: 'recognition', types: cat().recognitionAudiences, recipients: new Set(r.recipientIds), initial: r.audience });
  const m = modal({
    title: 'Change who sees it',
    body: h('div', {}, aud.el, h('p', { class: 'fb-hint' }, 'The change is recorded and the people recognized are told about it.')),
    actions: [button('Cancel', { onClick: () => m.close() }), button('Save', { variant: 'primary', onClick: async () => { if (await attempt(() => patch(`/api/feedback/recognitions/${r.id}/audience`, { audience: aud.value }), 'Audience changed')) { m.close(); redraw(); } } })],
  });
}

export async function kudosView(root) {
  await load();
  const body = h('div', {});
  const draw = async () => {
    const p = new URLSearchParams();
    if (state.category) p.set('category', state.category);
    if (state.audience) p.set('audience', state.audience);
    if (state.mine) p.set('mine', '1');
    const { recognitions } = await get(`/api/feedback/recognitions?${p}`);
    mount(body, recognitions.length ? h('div', { class: 'fb-feed' }, recognitions.map((r) => recognitionCard(r, draw))) : h('p', { class: 'muted' }, 'No recognitions to show yet.'));
  };
  mount(
    root,
    pageHeader('Kudos', [button('Recognize someone', { variant: 'primary', iconName: 'heart', onClick: () => giveKudos({ onSaved: draw }) })]),
    h(
      'div',
      { class: 'fb-row' },
      h('select', { onChange: (e) => ((state.category = e.target.value), draw()) }, h('option', { value: '' }, 'All categories'), cat().categories.map((c) => h('option', { value: c.key, selected: c.key === state.category }, c.label))),
      h('select', { onChange: (e) => ((state.audience = e.target.value), draw()) }, h('option', { value: '' }, 'Any audience'), Object.entries(AUDIENCE).map(([k, v]) => h('option', { value: k, selected: k === state.audience }, v))),
      h('label', { class: 'fb-row' }, h('input', { type: 'checkbox', checked: state.mine, onChange: (e) => ((state.mine = e.target.checked), draw()) }), 'Only mine'),
    ),
    section('Feed', body),
  );
  await draw();
}

export async function kudosDetailView(root, { params }) {
  await load();
  const draw = async () => {
    const r = await get(`/api/feedback/recognitions/${params.id}`).then((x) => x.recognition, () => null);
    if (!r) return mount(root, pageHeader('Recognition', [], [['Kudos', '#/kudos']]), h('p', { class: 'muted' }, "This recognition doesn't exist or isn't visible to you."));
    mount(root, pageHeader('Recognition', [], [['Kudos', '#/kudos']]), recognitionCard(r, draw),
      r.audienceHistory?.length ? section('Audience changes', h('ul', {}, r.audienceHistory.map((x) => h('li', {}, `${fmtDateTime(x.at)}: ${audienceText(x.from)} → ${audienceText(x.to)}`)))) : null);
  };
  await draw();
}
