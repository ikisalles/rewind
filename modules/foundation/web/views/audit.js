// Company settings → Audit log. Shows AuditRecords and domain events the
// foundation and other modules produced. Read-only.
import { get } from '@rewind/web/api.js';
import { h, mount, table, section, fmtDateTime } from '@rewind/web/ui.js';
import { isAdmin } from '@rewind/web/app.js';
import { personName } from './shared.js';

export async function auditTab(root) {
  if (!isAdmin()) return mount(root, h('p', { class: 'muted' }, 'Only admins can see the audit log.'));
  const [{ records }, { events }, dir] = await Promise.all([
    get('/api/foundation/audit?limit=200'),
    get('/api/foundation/events?limit=200'),
    get('/api/foundation/directory'),
  ]);

  mount(
    root,
    section(
      'Audit log',
      h('p', { class: 'fdn-hint' }, 'Administrative actions and sync operations are kept here (spec §8).'),
      table(
        ['When', 'Actor', 'Action', 'Target', 'Diff'],
        records.map((r) =>
          h(
            'tr',
            { class: 'fdn-audit-row' },
            h('td', {}, fmtDateTime(r.at)),
            h('td', {}, personName(dir.users, r.actorId)),
            h('td', {}, h('span', { class: 'fdn-code' }, r.action)),
            h('td', {}, r.target ? h('span', { class: 'fdn-code' }, r.target) : h('span', { class: 'muted' }, '—')),
            h('td', {}, h('div', { class: 'fdn-audit-diff' }, summarize(r))),
          ),
        ),
      ),
    ),
    section(
      'Domain events',
      h('p', { class: 'fdn-hint' }, 'Immutable events produced by every module (spec §5.3). Corrections create new events.'),
      table(
        ['When', 'Actor', 'Entity', 'Event', 'Source'],
        events.map((e) =>
          h(
            'tr',
            {},
            h('td', {}, fmtDateTime(e.recordedAt)),
            h('td', {}, personName(dir.users, e.actorId)),
            h('td', {}, h('span', { class: 'fdn-code' }, `${e.entityType}:${e.entityId}`)),
            h('td', {}, h('span', { class: 'fdn-code' }, e.eventType)),
            h('td', {}, e.source),
          ),
        ),
      ),
    ),
  );
}

function summarize(r) {
  if (r.after && r.before) {
    const keys = new Set([...Object.keys(r.after || {}), ...Object.keys(r.before || {})]);
    const diff = [];
    for (const k of keys) {
      const a = JSON.stringify(r.before?.[k]);
      const b = JSON.stringify(r.after?.[k]);
      if (a !== b) diff.push(`${k}: ${a ?? '—'} → ${b ?? '—'}`);
      if (diff.length >= 4) break;
    }
    return diff.join('\n') || '—';
  }
  if (r.after) return 'created';
  if (r.before) return 'removed';
  return '—';
}
