// Company settings → Feedback: categories and whether company-wide kudos are allowed.
// This never grants access to anyone's private content.
import { put } from '@rewind/web/api.js';
import { h, mount, button, section, attempt } from '@rewind/web/ui.js';
import { load } from '../lib.js';

export async function settingsTab(root, reload) {
  const { catalog } = await load(true);
  if (!catalog.canManage) return mount(root, h('p', { class: 'muted' }, 'Only feedback admins can change this.'));
  const cats = catalog.categories.map((c) => ({ ...c }));
  const list = h('div', { class: 'fb-form' });
  const org = h('input', { type: 'checkbox', checked: catalog.allowOrgAudience });
  const draw = () => mount(list, cats.map((c, i) => h('div', { class: 'fb-row' }, h('input', { value: c.label, onInput: (e) => (c.label = e.target.value) }), button('', { iconName: 'x', variant: 'ghost', title: 'Remove', onClick: () => (cats.splice(i, 1), draw()) }))));
  draw();
  mount(root, section('Feedback & recognition',
    h('p', { class: 'fb-hint' }, 'Admins manage the policy, never the content: private feedback stays visible only to its participants.'),
    h('h3', {}, 'Recognition categories'), list,
    button('Add category', { size: 'sm', iconName: 'plus', onClick: () => (cats.push({ label: 'New category' }), draw()) }),
    h('label', { class: 'fb-row', style: { marginTop: '12px' } }, org, 'Allow recognitions visible to the whole company'),
    h('div', {}, button('Save', { variant: 'primary', onClick: async () => (await attempt(() => put('/api/feedback/settings', { categories: cats, allowOrgAudience: org.checked }), 'Saved')) && reload() })),
  ));
}
