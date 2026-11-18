// Company settings → GMUDs (admins, while the module is on): who approves each role, when each
// approval is required, self-approval, and the SemVer suggestion policy.
import { get, api } from '@rewind/web/api.js';
import { h, mount, button, field, attempt, section, icon } from '@rewind/web/ui.js';
import { isAdmin, store } from '@rewind/web/app.js';
import { ROLES, LEVEL, ENVS, CATEGORIES, TYPES, loadPeople, select, checkbox } from '../lib.js';

export async function settingsTab(root, reload) {
  if (!isAdmin()) return mount(root, h('p', { class: 'muted' }, 'Only admins can change these settings.'));
  const [{ settings: s }, people] = await Promise.all([get('/api/gmud/settings'), loadPeople()]);
  const form = h(
    'form',
    {
      class: 'stack settings-form',
      onSubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = {
          approvers: Object.fromEntries(Object.keys(ROLES).map((r) => [r, fd.getAll(`approver-${r}`)])),
          approverTeams: Object.fromEntries(Object.keys(ROLES).map((r) => [r, fd.getAll(`approverTeam-${r}`)])),
          rules: {
            technical: fd.get('technical') === 'on',
            changeEnvironments: fd.getAll('changeEnvironments'),
            changeMinRisk: fd.get('changeMinRisk'),
            securityCategories: fd.getAll('securityCategories'),
          },
          allowSelfApproval: fd.get('allowSelfApproval') === 'on',
          semver: {
            useLabels: fd.get('useLabels') === 'on',
            useConventional: fd.get('useConventional') === 'on',
            breakingLabels: String(fd.get('breakingLabels') || '').split(','),
            fallback: fd.get('fallback'),
          },
        };
        if (await attempt(() => api('PUT', '/api/gmud/settings', body), 'GMUD settings saved')) reload();
      },
    },
    section(
      'Approvers',
      h('p', { class: 'muted small section-hint' }, 'Who can decide for each role: people, groups (teams), or both. Anyone in a selected team can decide. Nothing selected = any admin.'),
      h(
        'div',
        { class: 'approver-grid' },
        Object.entries(ROLES).map(([role, label]) =>
          h(
            'fieldset',
            { class: 'checks' },
            h('legend', {}, label),
            h('span', { class: 'approver-group muted small' }, 'Groups (teams)'),
            store.me.teams.map((t) => h('label', {}, h('input', { type: 'checkbox', name: `approverTeam-${role}`, value: t.id, checked: (s.approverTeams?.[role] || []).includes(t.id) }), icon('team', 14), t.name)),
            h('span', { class: 'approver-group muted small' }, 'People'),
            people.map((p) => h('label', {}, h('input', { type: 'checkbox', name: `approver-${role}`, value: p.id, checked: s.approvers[role].includes(p.id) }), p.name, p.role === 'admin' ? h('span', { class: 'muted small' }, ' · admin') : null)),
          ),
        ),
      ),
    ),
    section(
      'When each approval is required',
      h(
        'div',
        { class: 'panel stack' },
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'technical', checked: s.rules.technical }), h('span', { class: 'switch-ui' }), h('span', {}, h('strong', {}, 'Technical approval on every change'), h('span', { class: 'muted small block' }, 'If no rule applies, technical approval is required anyway.'))),
        h('fieldset', { class: 'checks inline-checks' }, h('legend', {}, 'Change approver: in these environments'), Object.entries(ENVS).map(([e, l]) => checkbox('changeEnvironments', l, s.rules.changeEnvironments.includes(e), { value: e }))),
        field('Change approver: from this risk level up', select('changeMinRisk', { ...Object.fromEntries(Object.entries(LEVEL).map(([k, v]) => [k, v[0]])), never: 'Never (only by environment)' }, s.rules.changeMinRisk, { empty: null })),
        h('fieldset', { class: 'checks inline-checks' }, h('legend', {}, 'Security approval: for these categories (and whenever “touches security” is checked)'), Object.entries(CATEGORIES).map(([c, l]) => checkbox('securityCategories', l, s.rules.securityCategories.includes(c), { value: c }))),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'allowSelfApproval', checked: s.allowSelfApproval }), h('span', { class: 'switch-ui' }), h('span', {}, h('strong', {}, 'Allow self-approval'), h('span', { class: 'muted small block' }, 'Off: whoever requested a change can’t approve it (recommended).'))),
      ),
    ),
    section(
      'SemVer suggestion policy',
      h(
        'div',
        { class: 'panel stack' },
        h('p', { class: 'muted small' }, 'How the next version is suggested from the pull requests. It is always a suggestion: the responsible person confirms each version.'),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'useLabels', checked: s.semver.useLabels }), h('span', { class: 'switch-ui' }), h('span', {}, h('strong', {}, 'Use labels'), h('span', { class: 'muted small block' }, 'semver:major, semver:minor, semver:patch and the breaking labels below.'))),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'useConventional', checked: s.semver.useConventional }), h('span', { class: 'switch-ui' }), h('span', {}, h('strong', {}, 'Use Conventional Commits titles'), h('span', { class: 'muted small block' }, 'feat: → minor, fix:/perf: → patch, “!” or BREAKING CHANGE → major.'))),
        h('div', { class: 'grid-2' }, field('Breaking-change labels', h('input', { name: 'breakingLabels', value: s.semver.breakingLabels.join(', ') }), 'Separated by commas.'), field('When nothing says anything', select('fallback', TYPES, s.semver.fallback, { empty: null }))),
      ),
    ),
    h('div', {}, button('Save settings', { type: 'submit', variant: 'primary' })),
  );
  mount(root, form);
}
