// Shared pieces of the Goals pages: labels, badges, progress bars, the
// directory (people, teams, groups from the canonical model) and form helpers.
import { get } from '@rewind/web/api.js';
import { h, badge, avatar } from '@rewind/web/ui.js';

export const OBJECTIVE_STATUS = {
  draft: ['Draft', 'neutral'],
  proposed: ['Proposed', 'info'],
  active: ['Active', 'accent'],
  at_risk: ['At risk', 'warning'],
  off_track: ['Off track', 'danger'],
  achieved: ['Achieved', 'success'],
  partially_achieved: ['Partially achieved', 'info'],
  not_achieved: ['Not achieved', 'danger'],
  cancelled: ['Cancelled', 'neutral'],
  archived: ['Archived', 'neutral'],
};
export const FINAL = ['achieved', 'partially_achieved', 'not_achieved', 'cancelled', 'archived'];
export const CYCLE_STATUS = { draft: ['Draft', 'neutral'], review: ['In review', 'warning'], published: ['Published', 'success'], archived: ['Closed', 'neutral'] };
export const CYCLE_KINDS = { quarter: 'Quarterly', semester: 'Semiannual', year: 'Annual', custom: 'Custom' };
export const PRIORITY = { low: ['Low', 'neutral'], medium: ['Medium', 'info'], high: ['High', 'warning'], critical: ['Critical', 'danger'] };
export const SCOPES = { org: 'Organization', group: 'Group', team: 'Team' };
export const VISIBILITY = { org: 'Everyone in the company', scope: 'Only the group/team, owner and collaborators' };
export const KR_TYPES = { number: 'Number', percent: 'Percentage', duration: 'Duration', count: 'Count', milestone: 'Milestones' };
export const DIRECTIONS = { increase: 'Increase', decrease: 'Reduce', maintain: 'Keep within range' };
export const FREQUENCIES = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
export const CHECKIN_STATUS = { on_track: ['On track', 'success'], at_risk: ['At risk', 'warning'], off_track: ['Off track', 'danger'] };
export const INITIATIVE_STATUS = { planned: ['Planned', 'neutral'], in_progress: ['In progress', 'accent'], done: ['Done', 'success'], cancelled: ['Cancelled', 'neutral'] };
export const RELATIONSHIPS = { relates_to: 'Relates to', supports: 'Supports', measures: 'Measures', implements: 'Implements', derived_from: 'Derived from', discussed_in: 'Discussed in' };

export const pairBadge = (map, v) => (v ? badge(...(map[v] || [v, 'neutral'])) : h('span', { class: 'muted' }, '—'));
export const statusBadge = (s) => pairBadge(OBJECTIVE_STATUS, s);

// ------------------------------------------------------------------ directory
let dir = null;
export async function loadDirectory(force = false) {
  if (!dir || force) dir = await get('/api/goals/directory');
  return dir;
}
export const directory = () => dir || { people: [], teams: [], groups: [] };
export const personName = (id) => directory().people.find((p) => p.id === id)?.name || (id ? 'Former member' : '—');
export const personChip = (id) =>
  id ? h('span', { class: 'person' }, avatar(directory().people.find((p) => p.id === id) || { name: '?' }, 20), personName(id)) : h('span', { class: 'muted' }, '—');
export function scopeName(type, id) {
  if (type === 'org') return 'Organization';
  const list = type === 'team' ? directory().teams : directory().groups;
  return `${SCOPES[type]}: ${list.find((x) => x.id === id)?.name || '—'}`;
}

// ------------------------------------------------------------------ progress
// Shows the real value; only the bar is limited to 0–100% (spec §3.3).
export function progressBar(p, { small = false } = {}) {
  if (!p || p.ratio === null || p.ratio === undefined) {
    return h('span', { class: 'muted goals-noprogress', title: "Can't be calculated with these parameters" }, 'n/a');
  }
  const pct = Math.round(p.ratio * 100);
  const bar = Math.round((p.bar ?? 0) * 100);
  const tone = pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'low';
  return h(
    'span',
    { class: `goals-progress${small ? ' small' : ''}`, title: `${pct}%` },
    h('span', { class: 'goals-progress-track' }, h('span', { class: `goals-progress-fill ${tone}`, style: { width: `${bar}%` } })),
    h('span', { class: 'goals-progress-label' }, `${pct}%`),
  );
}

export function krValue(kr) {
  if (kr.type === 'milestone') return `${kr.milestones.filter((m) => m.done).length}/${kr.milestones.length} milestones`;
  const u = kr.unit ? ` ${kr.unit}` : '';
  if (kr.direction === 'maintain') return `${kr.current ?? '—'}${u} (range ${kr.rangeMin}–${kr.rangeMax}${u})`;
  return `${kr.current ?? '—'}${u} · ${kr.baseline}${u} → ${kr.target}${u}`;
}

// ------------------------------------------------------------------ form helpers
export function select(name, options, value, { empty = null, ...attrs } = {}) {
  const entries = Array.isArray(options) ? options : Object.entries(options).map(([v, l]) => [v, Array.isArray(l) ? l[0] : l]);
  return h(
    'select',
    { name, ...attrs },
    empty !== null ? h('option', { value: '' }, empty) : null,
    entries.map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
  );
}

export const input = (name, value, attrs = {}) => h('input', { name, value: value ?? '', ...attrs });
export const textarea = (name, value, attrs = {}) => h('textarea', { name, rows: 3, ...attrs }, value || '');

export function formData(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') {
      if (el.dataset.multi) (out[el.name] ||= []).push(...(el.checked ? [el.value] : []));
      else out[el.name] = el.checked;
    } else if (el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

// Plain text with line breaks kept: never parsed as HTML.
export const prose = (text) => (text ? h('p', { class: 'goals-prose' }, text) : null);
