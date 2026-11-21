// One objective: facts, key results with progress and check-in history,
// initiatives, links (resolved through each target's own API) and history.
import { get, del } from '@rewind/web/api.js';
import { h, mount, button, pageHeader, section, attempt, confirmDialog, fmtDate, fmtDateTime, badge } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import {
  CHECKIN_STATUS, DIRECTIONS, FREQUENCIES, INITIATIVE_STATUS, KR_TYPES, PRIORITY, RELATIONSHIPS, VISIBILITY, FINAL,
  krValue, loadDirectory, pairBadge, personChip, personName, progressBar, prose, scopeName, statusBadge,
} from '../lib.js';
import { openCheckInForm, openInitiativeForm, openKrForm, openLinkForm, openObjectiveForm } from './forms.js';

const EVENT_LABEL = {
  'goal.objective.created': 'created the objective',
  'goal.objective.published': 'published the objective',
  'goal.objective.status_changed': 'changed the status',
  'goal.objective.owner_changed': 'changed the owner',
  'goal.objective.updated': 'edited the objective',
  'goal.objective.closed': 'closed the objective in the cycle review',
  'goal.kr.created': 'added a key result',
  'goal.kr.updated': 'edited a key result',
  'goal.kr.target_changed': 'changed a baseline/target',
  'goal.kr.deleted': 'removed a key result',
  'goal.checkin.created': 'checked in',
  'goal.initiative.created': 'added an initiative',
  'goal.initiative.updated': 'edited an initiative',
  'goal.initiative.status_changed': 'changed an initiative status',
  'goal.initiative.deleted': 'removed an initiative',
  'goal.link.created': 'added a link',
  'goal.link.deleted': 'removed a link',
};

export async function detailView(root, { params }) {
  await loadDirectory();
  const draw = async () => {
    const [v, { cycles }, { events }, catalog] = await Promise.all([
      get(`/api/goals/objectives/${params.id}`),
      get('/api/goals/cycles'),
      get(`/api/goals/objectives/${params.id}/history`),
      get('/api/goals/catalog'),
    ]);
    const { objective: o, keyResults: krs, initiatives, links, parent, children, canEdit } = v;
    const cycle = cycles.find((c) => c.id === o.cycleId);
    const closed = FINAL.includes(o.status);
    const reload = () => draw();

    const edit = async () => {
      const { objectives } = await get('/api/goals/objectives');
      openObjectiveForm({ objective: o, cycles, objectives, onSaved: reload });
    };
    const remove = async () => {
      if (!(await confirmDialog('Delete this draft objective?', { danger: true, confirmLabel: 'Delete' }))) return;
      if (await attempt(() => del(`/api/goals/objectives/${o.id}`), 'Objective deleted')) location.hash = '#/goals';
    };

    mount(
      root,
      pageHeader(
        o.title,
        canEdit
          ? [
              button('Edit', { iconName: 'edit', onClick: edit }),
              o.status === 'draft' ? button('Delete', { variant: 'danger', iconName: 'trash', onClick: remove }) : null,
            ]
          : [],
        [['Objectives', '#/goals'], [scopeName(o.scopeType, o.scopeId)]],
      ),
      h(
        'div',
        { class: 'goals-cols' },
        h(
          'div',
          {},
          section(
            'Objective',
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' } }, statusBadge(o.status), progressBar(o.progress), o.progress ? h('span', { class: 'muted', style: { fontSize: '12px' } }, `average of ${o.progress.computed}/${o.progress.total} computable key results — informative, never sets the status`) : null),
            o.purpose ? [h('strong', {}, 'Purpose'), prose(o.purpose)] : null,
            o.context ? [h('strong', {}, 'Context'), prose(o.context)] : null,
            o.successCriteria ? [h('strong', {}, 'Success criteria'), prose(o.successCriteria)] : null,
            o.risks ? [h('strong', {}, 'Risks'), prose(o.risks)] : null,
            o.outcome
              ? h('div', { class: 'goals-callout' }, h('div', {}, h('strong', {}, 'Cycle review: '), statusBadge(o.outcome.finalStatus)), prose(o.outcome.result), o.outcome.learnings ? [h('em', {}, 'Learnings'), prose(o.outcome.learnings)] : null)
              : null,
          ),
          section(
            `Key results (${krs.length})`,
            canEdit && !closed ? h('div', { style: { marginBottom: '8px' } }, button('Add key result', { iconName: 'plus', onClick: () => openKrForm({ objective: o, onSaved: reload }) })) : null,
            krs.length ? krs.map((kr) => krCard(o, kr, canEdit, closed, reload)) : h('p', { class: 'muted' }, 'No key results yet. How will success be measured?'),
          ),
          section(
            `Initiatives (${initiatives.length})`,
            h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Finishing an initiative doesn\'t mean the key result was achieved.'),
            canEdit ? h('div', { style: { marginBottom: '8px' } }, button('Add initiative', { iconName: 'plus', onClick: () => openInitiativeForm({ objective: o, krs, onSaved: reload }) })) : null,
            initiatives.length
              ? h(
                  'div',
                  { class: 'table-wrap' },
                  h(
                    'table',
                    { class: 'table' },
                    h('thead', {}, h('tr', {}, ['Initiative', 'Key result', 'Owner', 'Due', 'Status', ''].map((x) => h('th', {}, x)))),
                    h(
                      'tbody',
                      {},
                      initiatives.map((i) =>
                        h(
                          'tr',
                          {},
                          h('td', {}, h('strong', {}, i.title), i.expectedImpact ? h('div', { class: 'muted', style: { fontSize: '12px' } }, `Expected: ${i.expectedImpact}`) : null),
                          h('td', {}, krs.find((k) => k.id === i.krId)?.description || h('span', { class: 'muted' }, '—')),
                          h('td', { class: 'nowrap' }, personChip(i.ownerId)),
                          h('td', { class: 'nowrap' }, fmtDate(i.dueDate)),
                          h('td', {}, pairBadge(INITIATIVE_STATUS, i.status)),
                          h(
                            'td',
                            { class: 'nowrap' },
                            canEdit
                              ? [
                                  button('', { iconName: 'edit', variant: 'ghost', title: 'Edit', onClick: () => openInitiativeForm({ objective: o, krs, initiative: i, onSaved: reload }) }),
                                  button('', {
                                    iconName: 'trash', variant: 'ghost', title: 'Delete',
                                    onClick: async () => (await confirmDialog(`Delete "${i.title}"?`, { danger: true, confirmLabel: 'Delete' })) && (await attempt(() => del(`/api/goals/objectives/${o.id}/initiatives/${i.id}`), 'Initiative deleted')) && reload(),
                                  }),
                                ]
                              : null,
                          ),
                        ),
                      ),
                    ),
                  ),
                )
              : h('p', { class: 'muted' }, 'No initiatives yet.'),
          ),
        ),
        h(
          'div',
          {},
          section(
            'Details',
            h(
              'dl',
              { class: 'goals-facts' },
              h('dt', {}, 'Level'), h('dd', {}, scopeName(o.scopeType, o.scopeId)),
              h('dt', {}, 'Cycle'), h('dd', {}, cycle ? cycle.name : '—'),
              h('dt', {}, 'Owner'), h('dd', {}, personChip(o.ownerId)),
              h('dt', {}, 'Collaborators'), h('dd', {}, o.collaboratorIds.length ? o.collaboratorIds.map((id) => h('div', {}, personChip(id))) : '—'),
              h('dt', {}, 'Priority'), h('dd', {}, pairBadge(PRIORITY, o.priority)),
              h('dt', {}, 'Start'), h('dd', {}, fmtDate(o.startDate)),
              h('dt', {}, 'Due'), h('dd', {}, fmtDate(o.dueDate)),
              h('dt', {}, 'Visibility'), h('dd', {}, VISIBILITY[o.visibility]),
              h('dt', {}, 'Tags'), h('dd', {}, o.tags?.length ? o.tags.map((t) => badge(t)) : '—'),
              h('dt', {}, 'Aligned to'), h('dd', {}, parent ? (parent.restricted ? h('span', { class: 'goals-restricted' }, 'Restricted objective') : h('a', { href: `#/goals/${parent.id}` }, parent.title)) : '—'),
              h('dt', {}, 'Aligned here'), h('dd', {}, children.length ? children.map((c) => h('div', {}, h('a', { href: `#/goals/${c.id}` }, c.title))) : '—'),
            ),
          ),
          section('Links', linksBlock(o, krs, initiatives, links, catalog.linkTargets, canEdit, reload)),
          section(
            'History',
            events.length
              ? h('ul', { class: 'goals-history' }, events.slice(0, 50).map((e) => h('li', {}, h('span', { class: 'muted' }, fmtDateTime(e.occurredAt)), ' ', h('strong', {}, personName(e.actorId)), ' ', EVENT_LABEL[e.eventType] || h('code', {}, e.eventType), e.metadata?.reason ? h('div', { class: 'muted' }, `Reason: ${e.metadata.reason}`) : null)))
              : h('p', { class: 'muted' }, 'Nothing yet.'),
          ),
        ),
      ),
    );
  };
  await draw();
}

function krCard(o, kr, canEdit, closed, reload) {
  const canCheckIn = !closed && (canEdit || kr.ownerId === store.me.user.id);
  const checkIns = kr.checkIns || [];
  return h(
    'div',
    { class: 'goals-kr' },
    h(
      'div',
      { class: 'goals-kr-head' },
      h('div', {}, h('strong', {}, kr.description), h('div', { class: 'goals-kr-sub' }, h('span', {}, KR_TYPES[kr.type]), h('span', {}, DIRECTIONS[kr.direction]), h('span', {}, krValue(kr)), h('span', {}, `Check-in: ${FREQUENCIES[kr.frequency]}`), kr.confidence !== null && kr.confidence !== undefined ? h('span', {}, `Confidence ${kr.confidence}/10`) : null, h('span', {}, 'Owner: ', personName(kr.ownerId)), kr.source && kr.source !== 'manual' ? h('span', {}, `Source: ${kr.source}`) : null)),
      h('div', {}, progressBar(kr.progress), kr.progress?.rule === 'range' ? h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Rule: inside the range = 100%') : kr.progress?.rule === 'milestones_done' ? h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Rule: share of verified milestones') : null),
    ),
    kr.type === 'milestone' ? h('ul', { class: 'goals-milestones' }, kr.milestones.map((m) => h('li', { class: m.done ? 'done' : '' }, m.label))) : null,
    kr.checkInDue ? h('div', { class: 'goals-due' }, 'Check-in due') : null,
    h(
      'div',
      { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      canCheckIn ? button('Check in', { variant: 'primary', size: 'sm', iconName: 'check', onClick: () => openCheckInForm({ objective: o, kr, onSaved: reload }) }) : null,
      canEdit && !closed ? button('Edit', { size: 'sm', iconName: 'edit', onClick: () => openKrForm({ objective: o, kr, onSaved: reload }) }) : null,
      canEdit && !closed && !checkIns.length
        ? button('Remove', { size: 'sm', variant: 'danger', onClick: async () => (await confirmDialog('Remove this key result?', { danger: true, confirmLabel: 'Remove' })) && (await attempt(() => del(`/api/goals/objectives/${o.id}/krs/${kr.id}`), 'Key result removed')) && reload() })
        : null,
    ),
    kr.targetHistory?.length
      ? h('details', {}, h('summary', { class: 'muted' }, `Baseline/target changes (${kr.targetHistory.length})`), h('ul', { class: 'goals-history' }, kr.targetHistory.map((t) => h('li', {}, `${fmtDateTime(t.at)} · ${personName(t.by)}: `, t.changed.map((k) => `${k} ${t.before[k] ?? '—'} → ${t.after[k] ?? '—'}`).join(', '), h('div', { class: 'muted' }, `Reason: ${t.reason}`)))))
      : null,
    checkIns.length
      ? h(
          'details',
          { open: checkIns.length <= 3 },
          h('summary', { class: 'muted' }, `Check-ins (${checkIns.length})`),
          h(
            'ul',
            { class: 'goals-checkins' },
            checkIns.map((ci) =>
              h(
                'li',
                { 'data-status': ci.status },
                h('div', {}, h('strong', {}, kr.type === 'milestone' ? `${ci.milestonesDone.length} milestone(s) verified` : `${ci.value}${kr.unit ? ` ${kr.unit}` : ''}`), ' ', pairBadge(CHECKIN_STATUS, ci.status), ' ', h('span', { class: 'muted' }, `${personName(ci.authorId)} · ${fmtDateTime(ci.createdAt)}`)),
                ci.evidence ? h('div', { class: 'goals-prose' }, ci.evidence) : null,
                ci.evidenceLinks?.length ? h('div', {}, ci.evidenceLinks.map((u) => h('div', {}, h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u)))) : null,
                ci.risks ? h('div', { class: 'muted' }, `Risks: ${ci.risks}`) : null,
                ci.blockers ? h('div', { class: 'muted' }, `Blockers: ${ci.blockers}`) : null,
                ci.nextSteps ? h('div', { class: 'muted' }, `Next: ${ci.nextSteps}`) : null,
              ),
            ),
          ),
        )
      : null,
  );
}

// Internal targets keep only their id; the title comes from the target
// module's API with the viewer's permissions (or shows as restricted).
function linksBlock(o, krs, initiatives, links, targets, canEdit, reload) {
  const resolve = async (l, slot) => {
    const t = targets[l.targetType];
    if (!t?.internal) return mount(slot, h('a', { href: l.metadata?.url || l.targetId, target: '_blank', rel: 'noopener noreferrer' }, l.metadata?.label || l.metadata?.url || l.targetId));
    try {
      if (l.targetType === 'retro_board') {
        const { board } = await get(`/api/boards/${l.targetId}`);
        mount(slot, h('a', { href: `#/boards/${board.id}` }, board.name));
      } else if (l.targetType === 'gmud_change') {
        const { change } = await get(`/api/gmud/changes/${l.targetId}`);
        mount(slot, h('a', { href: `#/changes/${change.id}` }, `${change.number} ${change.title || ''}`));
      }
    } catch {
      mount(slot, h('span', { class: 'goals-restricted' }, 'Restricted or unavailable'));
    }
  };
  const fromLabel = (l) => {
    const e = l.metadata?.entity;
    if (e === 'kr') return `KR: ${krs.find((k) => k.id === l.sourceId)?.description || '—'}`;
    if (e === 'initiative') return `Initiative: ${initiatives.find((i) => i.id === l.sourceId)?.title || '—'}`;
    return 'Objective';
  };
  return [
    canEdit ? h('div', { style: { marginBottom: '8px' } }, button('Add link', { iconName: 'link', size: 'sm', onClick: () => openLinkForm({ objective: o, krs, initiatives, targets, onSaved: reload }) })) : null,
    links.length
      ? links.map((l) => {
          const slot = h('span', { class: 'muted' }, '…');
          resolve(l, slot);
          return h(
            'div',
            { class: 'goals-link-row' },
            h('div', {}, h('div', { class: 'muted', style: { fontSize: '11px' } }, `${fromLabel(l)} · ${RELATIONSHIPS[l.relationshipType] || l.relationshipType} · ${targets[l.targetType]?.label || l.targetType}`), slot),
            canEdit ? button('', { iconName: 'x', variant: 'ghost', title: 'Remove link', onClick: async () => (await attempt(() => del(`/api/goals/objectives/${o.id}/links/${l.id}`), 'Link removed')) && reload() }) : null,
          );
        })
      : h('p', { class: 'muted' }, 'Link retrospectives, GMUDs, PRs, releases, incidents, metrics or documents.'),
  ];
}
