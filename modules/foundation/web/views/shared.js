// Small helpers for the foundation admin views.
import { h, icon } from '@rewind/web/ui.js';

export const SOURCE_LABEL = { manual: 'Manual', synced: 'Synced', hybrid: 'Hybrid' };

export function sourceChip(source) {
  const s = source || 'manual';
  return h('span', { class: 'fdn-source', 'data-source': s }, SOURCE_LABEL[s] || s);
}

export function kindLabel(kinds, kind) {
  return kinds.find((k) => k.key === kind)?.label || kind;
}

export function scopeLabel(scope) {
  return { org: 'Organization', group: 'Group', team: 'Team' }[scope] || scope;
}

export function personName(users, id) {
  return users.find((u) => u.id === id)?.name || (id ? '—' : '');
}

export function teamName(teams, id) {
  return teams.find((t) => t.id === id)?.name || (id ? '—' : '');
}

export function groupName(groups, id) {
  return groups.find((g) => g.id === id)?.name || (id ? '—' : '');
}

export function iconPill(iconName, text) {
  return h('span', { class: 'fdn-tag' }, icon(iconName, 12), text);
}

export const required = (v) => (v && v.trim ? v.trim() : v);
