// Modals to create and edit objectives, key results, initiatives, check-ins and links.
import { get, post, patch } from '@rewind/web/api.js';
import { h, mount, button, field, modal } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import {
  CHECKIN_STATUS, DIRECTIONS, FREQUENCIES, INITIATIVE_STATUS, KR_TYPES, OBJECTIVE_STATUS, PRIORITY, RELATIONSHIPS, SCOPES, VISIBILITY,
  directory, formData, input, loadDirectory, select, textarea,
} from '../lib.js';

const err = (msg) => h('p', { class: 'goals-error', role: 'alert' }, msg);

function formModal({ title, body, submitLabel = 'Save', onSubmit, wide = true }) {
  const msg = h('div', {});
  const form = h('form', { class: 'goals-form' }, body, h('div', { class: 'wide' }, msg));
  const m = modal({
    title,
    wide,
    body: form,
    actions: [
      button('Cancel', { onClick: () => m.close() }),
      button(submitLabel, { variant: 'primary', onClick: () => form.requestSubmit() }),
    ],
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(msg);
    try {
      await onSubmit(formData(form));
      m.close();
    } catch (x) {
      mount(msg, err(x.message || 'Something went wrong'));
    }
  });
  return m;
}

const people = () => directory().people.map((p) => [p.id, p.name]);

function peopleChecks(name, selected = []) {
  return h(
    'div',
    { class: 'goals-checks' },
    directory().people.map((p) =>
      h('label', {}, h('input', { type: 'checkbox', name, value: p.id, 'data-multi': '1', checked: selected.includes(p.id) }), p.name),
    ),
  );
}

// ------------------------------------------------------------------ objective
export async function openObjectiveForm({ objective = null, cycles, objectives = [], defaults = {}, onSaved }) {
  await loadDirectory();
  let boards = [];
  if (!objective) {
    try {
      boards = (await get('/api/boards')).boards || [];
    } catch {
      boards = []; // retro off or no access
    }
  }
  const o = objective || { scopeType: 'org', ownerId: store.me.user.id, priority: 'medium', visibility: 'org', collaboratorIds: [], ...defaults };
  const scopeIdWrap = h('div', {});
  const drawScope = (type, value) => {
    if (type === 'org') return mount(scopeIdWrap, h('input', { type: 'hidden', name: 'scopeId', value: '' }));
    const list = type === 'team' ? directory().teams : directory().groups;
    mount(scopeIdWrap, field(SCOPES[type], select('scopeId', list.map((x) => [x.id, x.name]), value, { empty: `Choose the ${type}…`, required: true })));
  };
  const scopeType = select('scopeType', SCOPES, o.scopeType, { onChange: (e) => drawScope(e.target.value, null) });
  drawScope(o.scopeType, o.scopeId);
  const openCycles = cycles.filter((c) => c.status !== 'archived' || c.id === o.cycleId);
  const parents = objectives.filter((x) => x.id !== o.id).map((x) => [x.id, x.title]);

  formModal({
    title: objective ? 'Edit objective' : 'New objective',
    submitLabel: objective ? 'Save' : 'Create',
    body: [
      h('div', { class: 'wide' }, field('Title', input('title', o.title, { required: true, maxlength: 200, placeholder: 'What do we want to change?' }))),
      h('div', { class: 'wide' }, field('Purpose', textarea('purpose', o.purpose, { placeholder: 'Why it matters' }))),
      h('div', { class: 'wide' }, field('Context', textarea('context', o.context))),
      field('Cycle', select('cycleId', openCycles.map((c) => [c.id, c.name]), o.cycleId, { empty: 'No cycle' })),
      field('Priority', select('priority', PRIORITY, o.priority)),
      field('Level', scopeType),
      scopeIdWrap,
      field('Owner', select('ownerId', people(), o.ownerId, { required: true }), 'Coordinates the outcome; doesn\'t need to do all the work.'),
      field('Aligned to (optional)', select('parentId', parents, o.parentId, { empty: 'No parent objective' })),
      h('div', { class: 'wide' }, field('Collaborators', peopleChecks('collaboratorIds', o.collaboratorIds))),
      objective ? field('Status', select('status', OBJECTIVE_STATUS, o.status)) : field('Status', select('status', { draft: 'Draft', proposed: 'Proposed' }, o.status || 'draft')),
      field('Visibility', select('visibility', VISIBILITY, o.visibility)),
      field('Start', input('startDate', o.startDate, { type: 'date' })),
      field('Due date', input('dueDate', o.dueDate, { type: 'date' })),
      h('div', { class: 'wide' }, field('Success criteria', textarea('successCriteria', o.successCriteria))),
      h('div', { class: 'wide' }, field('Risks', textarea('risks', o.risks))),
      h('div', { class: 'wide' }, field('Tags', input('tags', (o.tags || []).join(', '), { placeholder: 'reliability, growth' }), 'Separated by commas')),
      !objective && boards.length
        ? h('div', { class: 'wide' }, field('Comes from a retrospective (optional)', select('derivedFromBoard', boards.map((b) => [b.id, b.name]), null, { empty: '—' }), 'Turns a learning or recurring theme into an objective.'))
        : null,
    ],
    onSubmit: async (d) => {
      const body = { ...d, tags: d.tags, collaboratorIds: d.collaboratorIds || [] };
      if (d.derivedFromBoard) body.derivedFrom = { type: 'retro_board', id: d.derivedFromBoard };
      delete body.derivedFromBoard;
      const r = objective ? await patch(`/api/goals/objectives/${objective.id}`, body) : await post('/api/goals/objectives', body);
      onSaved?.(r.objective);
    },
  });
}

// ------------------------------------------------------------------ key result
export async function openKrForm({ objective, kr = null, onSaved }) {
  await loadDirectory();
  const k = kr || { type: 'number', direction: 'increase', frequency: 'weekly', ownerId: objective.ownerId, milestones: [] };
  const numeric = h('div', { class: 'wide goals-form' });
  const milestones = h('div', { class: 'wide' });
  const drawKind = () => {
    const type = typeEl.value;
    const dir = dirEl.value;
    const isMilestone = type === 'milestone';
    mount(
      numeric,
      isMilestone
        ? null
        : dir === 'maintain'
          ? [field('Range minimum', input('rangeMin', k.rangeMin, { type: 'number', step: 'any', required: true })), field('Range maximum', input('rangeMax', k.rangeMax, { type: 'number', step: 'any', required: true }))]
          : [field('Baseline', input('baseline', k.baseline, { type: 'number', step: 'any', required: true })), field('Target', input('target', k.target, { type: 'number', step: 'any', required: true }))],
      !isMilestone && dir === 'maintain' && !kr ? field('Current value', input('current', k.current, { type: 'number', step: 'any' })) : null,
    );
    mount(
      milestones,
      isMilestone
        ? field('Milestones (one per line)', textarea('milestonesText', (k.milestones || []).map((m) => m.label).join('\n'), { rows: 4, required: true }), 'Each milestone must be verifiable. Progress = share of verified milestones.')
        : null,
    );
  };
  const typeEl = select('type', KR_TYPES, k.type, { onChange: drawKind });
  const dirEl = select('direction', DIRECTIONS, k.direction, { onChange: drawKind });
  const reason = kr ? h('div', { class: 'wide' }, field('Reason for changing baseline/target', textarea('reason', '', { rows: 2 }), 'Required when baseline, target, range, unit, type or direction change. The change is kept in history.')) : null;
  drawKind();

  formModal({
    title: kr ? 'Edit key result' : 'New key result',
    submitLabel: kr ? 'Save' : 'Add',
    body: [
      h('div', { class: 'wide' }, field('Measurable description', input('description', k.description, { required: true, maxlength: 300, placeholder: 'Reduce lead time for changes' }))),
      field('Kind', typeEl),
      field('Direction', dirEl),
      field('Unit', input('unit', k.unit, { maxlength: 30, placeholder: 'h, %, users…' })),
      field('Check-in frequency', select('frequency', FREQUENCIES, k.frequency)),
      numeric,
      milestones,
      field('Owner', select('ownerId', people(), k.ownerId)),
      field('Confidence (0–10)', input('confidence', k.confidence, { type: 'number', min: 0, max: 10 })),
      h('div', { class: 'wide' }, field('Data source', input('source', k.source && k.source !== 'manual' ? k.source : '', { placeholder: 'Manual (MVP) — e.g. dashboard URL' }))),
      reason,
    ],
    onSubmit: async (d) => {
      const body = { ...d };
      if (d.milestonesText !== undefined) {
        const prev = k.milestones || [];
        body.milestones = d.milestonesText.split('\n').map((l) => l.trim()).filter(Boolean).map((label, i) => {
          const same = prev.find((m) => m.label === label);
          return same || { id: `m${Date.now().toString(36)}${i}`, label, done: false };
        });
        delete body.milestonesText;
      }
      if (!body.source) body.source = 'manual';
      const base = `/api/goals/objectives/${objective.id}/krs`;
      const r = kr ? await patch(`${base}/${kr.id}`, body) : await post(base, body);
      onSaved?.(r.keyResult);
    },
  });
}

// ------------------------------------------------------------------ check-in
export function openCheckInForm({ objective, kr, onSaved }) {
  const isMilestone = kr.type === 'milestone';
  formModal({
    title: `Check-in: ${kr.description}`,
    submitLabel: 'Record check-in',
    body: [
      h('p', { class: 'muted wide' }, 'Check-ins are permanent: to correct one, record a new check-in.'),
      isMilestone
        ? h('div', { class: 'wide' }, field('Verified milestones', h('div', { class: 'goals-checks' }, kr.milestones.map((m) => h('label', {}, h('input', { type: 'checkbox', name: 'milestonesDone', value: m.id, 'data-multi': '1', checked: m.done }), m.label)))))
        : field(`Current value${kr.unit ? ` (${kr.unit})` : ''}`, input('value', kr.current, { type: 'number', step: 'any', required: true })),
      field('Status', select('status', CHECKIN_STATUS, 'on_track')),
      field('Confidence (0–10)', input('confidence', kr.confidence, { type: 'number', min: 0, max: 10 })),
      h('div', { class: 'wide' }, field('Evidence', textarea('evidence', '', { placeholder: 'What shows this value? (report, dashboard, result)' }))),
      h('div', { class: 'wide' }, field('Evidence links', textarea('evidenceLinks', '', { rows: 2, placeholder: 'https://… (one per line)' }))),
      h('div', { class: 'wide' }, field('Risks', textarea('risks', '', { rows: 2 }))),
      h('div', { class: 'wide' }, field('Blockers', textarea('blockers', '', { rows: 2 }))),
      h('div', { class: 'wide' }, field('Next steps', textarea('nextSteps', '', { rows: 2 }))),
    ],
    onSubmit: async (d) => {
      const body = { ...d, evidenceLinks: (d.evidenceLinks || '').split('\n').map((s) => s.trim()).filter(Boolean), milestonesDone: d.milestonesDone || [] };
      const r = await post(`/api/goals/objectives/${objective.id}/krs/${kr.id}/checkins`, body);
      onSaved?.(r);
    },
  });
}

// ------------------------------------------------------------------ initiative
export async function openInitiativeForm({ objective, krs, initiative = null, onSaved }) {
  await loadDirectory();
  const i = initiative || { status: 'planned', ownerId: store.me.user.id };
  formModal({
    title: initiative ? 'Edit initiative' : 'New initiative',
    submitLabel: initiative ? 'Save' : 'Add',
    body: [
      h('div', { class: 'wide' }, field('Initiative', input('title', i.title, { required: true, maxlength: 200, placeholder: 'Project, effort or experiment' }))),
      h('div', { class: 'wide' }, field('Description', textarea('description', i.description))),
      field('Contributes to key result', select('krId', krs.map((k) => [k.id, k.description]), i.krId, { empty: 'Not tied to a key result' })),
      field('Owner', select('ownerId', people(), i.ownerId)),
      field('Due date', input('dueDate', i.dueDate, { type: 'date' })),
      field('Status', select('status', INITIATIVE_STATUS, i.status), 'Finishing an initiative doesn\'t mean the key result was achieved.'),
      h('div', { class: 'wide' }, field('Expected impact', textarea('expectedImpact', i.expectedImpact, { rows: 2 }))),
    ],
    onSubmit: async (d) => {
      const base = `/api/goals/objectives/${objective.id}/initiatives`;
      const r = initiative ? await patch(`${base}/${initiative.id}`, d) : await post(base, d);
      onSaved?.(r.initiative);
    },
  });
}

// ------------------------------------------------------------------ link
export async function openLinkForm({ objective, krs, initiatives, targets, onSaved }) {
  // internal targets come from the target module's API, so only what this
  // person can see is offered
  const [boards, changes] = await Promise.all([
    get('/api/boards').then((r) => r.boards || [], () => []),
    get('/api/gmud/changes').then((r) => r.changes || [], () => []),
  ]);
  const options = { retro_board: boards.map((b) => [b.id, b.name]), gmud_change: changes.map((c) => [c.id, `${c.number} ${c.title || ''}`.trim()]) };
  const sources = [
    [`objective:${objective.id}`, `Objective: ${objective.title}`],
    ...krs.map((k) => [`kr:${k.id}`, `Key result: ${k.description}`]),
    ...initiatives.map((i) => [`initiative:${i.id}`, `Initiative: ${i.title}`]),
  ];
  const targetWrap = h('div', { class: 'wide goals-form' });
  const drawTarget = (type) => {
    const t = targets[type];
    if (!t) return mount(targetWrap);
    if (t.internal) {
      const opts = options[type] || [];
      return mount(targetWrap, h('div', { class: 'wide' }, opts.length ? field(t.label, select('targetId', opts, null, { empty: 'Choose…', required: true })) : h('p', { class: 'muted' }, `No ${t.label.toLowerCase()} available to you.`)));
    }
    mount(targetWrap, field('URL', input('url', '', { type: 'url', required: true, placeholder: 'https://' })), field('Label', input('label', '', { maxlength: 200 })));
  };
  const typeEl = select('targetType', Object.entries(targets).map(([k, v]) => [k, v.label]), 'gmud_change', { onChange: (e) => drawTarget(e.target.value) });
  drawTarget('gmud_change');
  formModal({
    title: 'Link',
    submitLabel: 'Link',
    body: [
      h('div', { class: 'wide' }, field('From', select('source', sources, `objective:${objective.id}`))),
      field('To', typeEl),
      field('Relationship', select('relationshipType', RELATIONSHIPS, 'relates_to')),
      targetWrap,
    ],
    onSubmit: async (d) => {
      const [entity, entityId] = d.source.split(':');
      const r = await post(`/api/goals/objectives/${objective.id}/links`, { ...d, entity, entityId });
      onSaved?.(r.link);
    },
  });
}
