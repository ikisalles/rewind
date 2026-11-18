// Shared pieces of the change (GMUD) pages: labels, badges, people and small form helpers.
import { get } from '@rewind/web/api.js';
import { h, badge, avatar, fmtDateTime, icon } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';

export const STATUS = {
  draft: ['Draft', 'neutral'],
  submitted: ['Submitted', 'info'],
  in_review: ['In review', 'warning'],
  approved: ['Approved', 'success'],
  rejected: ['Rejected', 'danger'],
  scheduled: ['Scheduled', 'info'],
  in_progress: ['In progress', 'accent'],
  completed: ['Completed', 'success'],
  failed: ['Failed', 'danger'],
  rolled_back: ['Rolled back', 'danger'],
  cancelled: ['Cancelled', 'neutral'],
};
export const STATUS_ICON = { approved: 'check', completed: 'check', rejected: 'x', failed: 'alert', rolled_back: 'undo', in_progress: 'play', scheduled: 'calendar' };

export const LEVEL = { low: ['Low', 'neutral'], medium: ['Medium', 'info'], high: ['High', 'warning'], critical: ['Critical', 'danger'] };
export const LIKELIHOOD = { low: 'Low', medium: 'Medium', high: 'High' };
export const TYPES = { major: 'Major', minor: 'Minor', patch: 'Patch' };
export const TYPE_HINT = { major: 'Breaking change (incompatible)', minor: 'New compatible feature', patch: 'Compatible fix' };
export const CATEGORIES = { feature: 'Feature', bugfix: 'Bugfix', security: 'Security', refactoring: 'Refactoring', infrastructure: 'Infrastructure', dependency: 'Dependency' };
export const ENVS = { development: 'Development', staging: 'Staging', production: 'Production' };
export const STRATEGIES = { rolling: 'Rolling', blue_green: 'Blue-Green', canary: 'Canary', feature_flag: 'Feature flag', manual: 'Manual' };
export const STEP_STATUS = { pending: ['Pending', 'neutral'], in_progress: ['In progress', 'accent'], done: ['Done', 'success'], failed: ['Failed', 'danger'], skipped: ['Skipped', 'neutral'] };
export const ROLES = { technical: 'Technical approver', change: 'Change approver', security: 'Security approval' };
export const DEPLOY_STATUS = { planned: ['Planned', 'neutral'], in_progress: ['In progress', 'accent'], succeeded: ['Succeeded', 'success'], failed: ['Failed', 'danger'], rolled_back: ['Rolled back', 'danger'] };
export const RELEASE_STATUS = { planned: ['Planned', 'info'], released: ['Released', 'success'], cancelled: ['Cancelled', 'neutral'], rolled_back: ['Rolled back', 'danger'] };

export const statusBadge = (s) => badge(...(STATUS[s] || [s, 'neutral']), STATUS_ICON[s]);
export const levelBadge = (l, prefix = '') => (l ? badge(`${prefix}${LEVEL[l]?.[0] || l}`, LEVEL[l]?.[1] || 'neutral') : h('span', { class: 'muted' }, '—'));
export const typeBadge = (t) => (t ? badge(TYPES[t] || t, t === 'major' ? 'danger' : t === 'minor' ? 'info' : 'neutral') : h('span', { class: 'muted' }, '—'));
export const pairBadge = (map, v) => (v ? badge(...(map[v] || [v, 'neutral'])) : h('span', { class: 'muted' }, '—'));
export const envLabel = (e) => ENVS[e] || '—';
export const dash = (v) => (v === null || v === undefined || v === '' ? h('span', { class: 'muted' }, '—') : v);
export const when = (local) => (local ? fmtDateTime(local) : '—');

// ------------------------------------------------------------------ people
let peopleCache = null;
export async function loadPeople(force = false) {
  if (!peopleCache || force) peopleCache = (await get('/api/gmud/people')).people;
  return peopleCache;
}
export const peopleReady = () => Boolean(peopleCache);
export const personById = (id) => peopleCache?.find((p) => p.id === id);
export const personName = (id) => personById(id)?.name || (id ? 'Former member' : '—');
export const personChip = (id) => (id ? h('span', { class: 'person' }, avatar(personById(id) || { name: '?' }, 20), personName(id)) : h('span', { class: 'muted' }, '—'));
export const teamName = (id) => store.me.teams.find((t) => t.id === id)?.name || '—';

// ------------------------------------------------------------------ form helpers
export function select(name, options, value, { empty = 'Select…', required = false, ...attrs } = {}) {
  const entries = Array.isArray(options) ? options : Object.entries(options).map(([v, l]) => [v, Array.isArray(l) ? l[0] : l]);
  return h(
    'select',
    { name, required, ...attrs },
    empty !== null ? h('option', { value: '' }, empty) : null,
    entries.map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
  );
}

export const peopleSelect = (name, value, opts = {}) => select(name, (peopleCache || []).map((p) => [p.id, p.name]), value, opts);

export function checkbox(name, label, checked, attrs = {}) {
  return h('label', { class: 'check-row' }, h('input', { type: 'checkbox', name, checked, ...attrs }), h('span', {}, label));
}

// Plain text with line breaks kept (descriptions, notes): never parsed as HTML.
export const prose = (text, empty = 'Not filled in.') => (text ? h('div', { class: 'prose' }, text) : h('p', { class: 'muted' }, empty));

export function kv(pairs) {
  return h('dl', { class: 'kv gmud-kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

export const versionsText = (repos) =>
  repos.length === 1 ? repos[0].nextVersion || '—' : repos.length ? `${repos.length} repos` : '—';

// Who can decide for a role, in words: people and teams (groups), or any admin.
export function approversText(settings, role) {
  const people = (settings.approvers[role] || []).map(personName);
  const teams = (settings.approverTeams?.[role] || []).map((id) => `${teamName(id)} (team)`);
  return [...people, ...teams].join(', ') || 'Any admin';
}

// "Ana Lima" or "Carl Souza for CAB": who decided, and through which team
export const decidedBy = (d) => (d.viaTeam ? `${personName(d.userId)} for ${teamName(d.viaTeam)}` : personName(d.userId));

// The approvals of a change in a list cell: per required role, who can approve (groups and
// people) or who decided. Drafts show the approvals they will need under today's rules.
export function approvalsCell(c, settings) {
  if (!c.required?.length) return h('span', { class: 'muted' }, '—');
  const SHORT = { technical: 'Technical', change: 'Change', security: 'Security' };
  return h(
    'div',
    { class: `approvals-cell${c.requiredPreview ? ' is-preview' : ''}`, title: c.requiredPreview ? 'Approvals this draft will need' : undefined },
    c.required.map((role) => {
      const d = (c.decisions || []).find((x) => x.role === role);
      const state = d ? d.decision : c.requiredPreview ? 'preview' : 'pending';
      const mark = { approved: ['check', 'success'], rejected: ['x', 'danger'], pending: ['clock', 'warning'], preview: ['clock', 'neutral'] }[state];
      return h(
        'div',
        { class: `approval-line is-${state}` },
        h('span', { class: `approval-mark ${mark[1]}`, 'aria-label': state }, icon(mark[0], 11)),
        h('strong', {}, SHORT[role] || role),
        h('span', { class: 'muted' }, d ? decidedBy(d) : approversText(settings, role)),
      );
    }),
  );
}

