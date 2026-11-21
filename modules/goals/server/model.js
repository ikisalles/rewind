// Data shapes, validation and progress math for Goals & Objectives. No I/O.
//
//   GoalCycle   → planning/review period (draft → review → published → archived)
//   Objective   → qualitative outcome, scoped to the organization, a group or a team
//   KeyResult   → verifiable measure of an Objective
//   GoalCheckIn → immutable periodic update of a Key Result
//   Initiative  → effort that contributes to a Key Result (done ≠ KR achieved)
//
// People, groups and teams are never copied here: objectives only keep ids
// that point to the canonical model (core users/teams, foundation groups).

import { str, isDate } from '@rewind/core';

export const CYCLE_KINDS = { quarter: 'Quarterly', semester: 'Semiannual', year: 'Annual', custom: 'Custom' };
export const CYCLE_STATUS = ['draft', 'review', 'published', 'archived'];

export const OBJECTIVE_STATUS = [
  'draft', 'proposed', 'active', 'at_risk', 'off_track',
  'achieved', 'partially_achieved', 'not_achieved', 'cancelled', 'archived',
];
// final statuses: set by people at the end (never computed automatically)
export const FINAL_STATUS = ['achieved', 'partially_achieved', 'not_achieved', 'cancelled', 'archived'];
// statuses in which owners are reminded to check in
export const LIVE_STATUS = ['active', 'at_risk', 'off_track'];

export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const SCOPES = ['org', 'group', 'team'];
// who can read an objective: everyone in the company, or only its scope
export const VISIBILITY = ['org', 'scope'];

export const KR_TYPES = ['number', 'percent', 'duration', 'count', 'milestone'];
export const DIRECTIONS = ['increase', 'decrease', 'maintain'];
export const FREQUENCIES = { weekly: 7, biweekly: 14, monthly: 30 };
export const CHECKIN_STATUS = ['on_track', 'at_risk', 'off_track'];

export const INITIATIVE_STATUS = ['planned', 'in_progress', 'done', 'cancelled'];

// Where a goal can link to (Entity Linking). Internal targets are resolved by
// the target module's own API, so its permissions apply on each follow.
export const LINK_TARGETS = {
  retro_board: { label: 'Retrospective', internal: true },
  gmud_change: { label: 'Change (GMUD)', internal: true },
  pr: { label: 'Pull request', internal: false },
  issue: { label: 'Issue', internal: false },
  release: { label: 'Release', internal: false },
  incident: { label: 'Incident', internal: false },
  metric: { label: 'Metric', internal: false },
  document: { label: 'Document', internal: false },
};
export const LINK_RELATIONSHIPS = ['relates_to', 'supports', 'measures', 'implements', 'derived_from', 'discussed_in'];

export const ENTITY_TYPES = { objective: 'goal.objective', kr: 'goal.key_result', initiative: 'goal.initiative' };

export const PERMISSIONS = [
  { key: 'goals:read', label: 'Goals: see objectives limited to a scope', module: 'goals' },
  { key: 'goals:write', label: 'Goals: create and edit any objective', module: 'goals' },
  { key: 'goals:export', label: 'Goals: export objectives', module: 'goals' },
  { key: 'goals:admin', label: 'Goals: manage cycles and close reviews', module: 'goals' },
];

const pick = (list, v, fallback) => (list.includes(v) ? v : fallback);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, 60)).filter(Boolean))];
const tags = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((t) => str(t, 40)).filter(Boolean))].slice(0, 20);
const day = (v, fallback = null) => (v === null ? null : isDate(v) ? v : fallback);

export function cleanCycle(input = {}, prev = {}) {
  return {
    name: str(input.name, 120) || prev.name || '',
    kind: Object.hasOwn(CYCLE_KINDS, input.kind) ? input.kind : prev.kind || 'quarter',
    startDate: day(input.startDate, prev.startDate || null),
    endDate: day(input.endDate, prev.endDate || null),
    status: pick(CYCLE_STATUS, input.status, prev.status || 'draft'),
    template: input.template !== undefined ? str(input.template, 2000) : prev.template || '',
    closingRules: input.closingRules !== undefined ? str(input.closingRules, 2000) : prev.closingRules || '',
  };
}

export function assertValidCycle(c) {
  if (!c.name) return 'Enter the cycle name';
  if (!c.startDate || !c.endDate) return 'Enter the start and end dates';
  if (c.endDate < c.startDate) return 'The cycle ends before it starts';
  return null;
}

export function cleanObjective(input = {}, prev = {}) {
  const has = (k) => input[k] !== undefined;
  return {
    title: has('title') ? str(input.title, 200) : prev.title || '',
    purpose: has('purpose') ? str(input.purpose, 2000) : prev.purpose || '',
    context: has('context') ? str(input.context, 4000) : prev.context || '',
    cycleId: has('cycleId') ? str(input.cycleId, 60) || null : prev.cycleId || null,
    ownerId: has('ownerId') ? str(input.ownerId, 60) || null : prev.ownerId || null,
    collaboratorIds: has('collaboratorIds') ? ids(input.collaboratorIds) : prev.collaboratorIds || [],
    scopeType: has('scopeType') ? pick(SCOPES, input.scopeType, 'org') : prev.scopeType || 'org',
    scopeId: has('scopeId') ? str(input.scopeId, 60) || null : prev.scopeId || null,
    parentId: has('parentId') ? str(input.parentId, 60) || null : prev.parentId || null,
    priority: has('priority') ? pick(PRIORITIES, input.priority, 'medium') : prev.priority || 'medium',
    status: has('status') ? pick(OBJECTIVE_STATUS, input.status, prev.status || 'draft') : prev.status || 'draft',
    startDate: has('startDate') ? day(input.startDate) : prev.startDate || null,
    dueDate: has('dueDate') ? day(input.dueDate) : prev.dueDate || null,
    tags: has('tags') ? tags(input.tags) : prev.tags || [],
    risks: has('risks') ? str(input.risks, 2000) : prev.risks || '',
    successCriteria: has('successCriteria') ? str(input.successCriteria, 2000) : prev.successCriteria || '',
    visibility: has('visibility') ? pick(VISIBILITY, input.visibility, 'org') : prev.visibility || 'org',
  };
}

export function assertValidObjective(o) {
  if (!o.title) return 'Enter the objective title';
  if (o.scopeType !== 'org' && !o.scopeId) return `Choose the ${o.scopeType}`;
  if (!o.ownerId) return 'Choose the owner';
  if (o.startDate && o.dueDate && o.dueDate < o.startDate) return 'The due date is before the start date';
  return null;
}

export function cleanKeyResult(input = {}, prev = {}) {
  const has = (k) => input[k] !== undefined;
  const type = has('type') ? pick(KR_TYPES, input.type, 'number') : prev.type || 'number';
  const milestones = has('milestones')
    ? (Array.isArray(input.milestones) ? input.milestones : []).slice(0, 50).map((m, i) => ({
        id: str(m?.id, 60) || `m${i + 1}`,
        label: str(m?.label, 200),
        done: Boolean(m?.done),
      })).filter((m) => m.label)
    : prev.milestones || [];
  return {
    description: has('description') ? str(input.description, 300) : prev.description || '',
    type,
    unit: has('unit') ? str(input.unit, 30) : prev.unit || (type === 'percent' ? '%' : ''),
    baseline: has('baseline') ? num(input.baseline) : prev.baseline ?? null,
    target: has('target') ? num(input.target) : prev.target ?? null,
    current: has('current') ? num(input.current) : prev.current ?? null,
    direction: has('direction') ? pick(DIRECTIONS, input.direction, 'increase') : prev.direction || 'increase',
    rangeMin: has('rangeMin') ? num(input.rangeMin) : prev.rangeMin ?? null,
    rangeMax: has('rangeMax') ? num(input.rangeMax) : prev.rangeMax ?? null,
    milestones,
    ownerId: has('ownerId') ? str(input.ownerId, 60) || null : prev.ownerId || null,
    frequency: has('frequency') ? (Object.hasOwn(FREQUENCIES, input.frequency) ? input.frequency : 'weekly') : prev.frequency || 'weekly',
    source: has('source') ? str(input.source, 200) || 'manual' : prev.source || 'manual',
    confidence: has('confidence') ? clampConfidence(input.confidence) : prev.confidence ?? null,
  };
}

const clampConfidence = (v) => {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.min(10, Math.round(n)));
};

export function assertValidKeyResult(kr) {
  if (!kr.description) return 'Describe the key result';
  if (kr.type === 'milestone') {
    if (!kr.milestones.length) return 'Add at least one verifiable milestone';
    return null;
  }
  if (kr.direction === 'maintain') {
    if (kr.rangeMin === null || kr.rangeMax === null) return 'A "keep within range" key result needs the minimum and maximum';
    if (kr.rangeMax < kr.rangeMin) return 'The range maximum is below the minimum';
    return null;
  }
  if (kr.baseline === null || kr.target === null) return 'Enter the baseline and the target';
  if (kr.direction === 'increase' && kr.target <= kr.baseline) return 'To increase, the target must be above the baseline';
  if (kr.direction === 'decrease' && kr.target >= kr.baseline) return 'To reduce, the target must be below the baseline';
  if (kr.type === 'percent' && kr.unit && kr.unit !== '%') return 'A percentage key result uses the "%" unit';
  return null;
}

// Progress of a key result (spec §3.3).
//   increase: (current - baseline) / (target - baseline)
//   decrease: (baseline - current) / (baseline - target)
//   maintain: explicit rule — 1 when current is inside [rangeMin, rangeMax], else 0
//   milestone: explicit rule — share of verified milestones
// Returns { ratio, bar, rule } where ratio is the real value (may be < 0 or
// > 1) and bar is clamped to [0, 1] for display only; ratio is null when the
// parameters don't allow a calculation.
export function progressOf(kr) {
  const none = { ratio: null, bar: null, rule: 'not_computable' };
  if (!kr) return none;
  if (kr.type === 'milestone') {
    const total = kr.milestones?.length || 0;
    if (!total) return none;
    const ratio = kr.milestones.filter((m) => m.done).length / total;
    return { ratio, bar: ratio, rule: 'milestones_done' };
  }
  const { baseline: b, target: t, current: c } = kr;
  if (kr.direction === 'maintain') {
    if (kr.rangeMin === null || kr.rangeMax === null || c === null || c === undefined) return { ...none, rule: 'range' };
    const inside = c >= kr.rangeMin && c <= kr.rangeMax;
    return { ratio: inside ? 1 : 0, bar: inside ? 1 : 0, rule: 'range', inRange: inside };
  }
  if ([b, t, c].some((v) => v === null || v === undefined || !Number.isFinite(v))) return none;
  if (t === b) return none;
  const ratio = kr.direction === 'decrease' ? (b - c) / (b - t) : (c - b) / (t - b);
  if (!Number.isFinite(ratio)) return none;
  return { ratio, bar: Math.max(0, Math.min(1, ratio)), rule: kr.direction };
}

// Objective progress is an informative average of its computable KRs; it never
// sets the objective's status (spec §6: no automatic final status).
export function objectiveProgress(krs) {
  const values = krs.map((kr) => progressOf(kr).ratio).filter((r) => r !== null);
  if (!values.length) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { ratio: avg, bar: Math.max(0, Math.min(1, avg)), computed: values.length, total: krs.length };
}

export function cleanCheckIn(input = {}, kr) {
  const milestoneIds = new Set((kr?.milestones || []).map((m) => m.id));
  return {
    value: num(input.value),
    milestonesDone: ids(input.milestonesDone).filter((id) => milestoneIds.has(id)),
    status: pick(CHECKIN_STATUS, input.status, 'on_track'),
    confidence: clampConfidence(input.confidence),
    evidence: str(input.evidence, 4000),
    evidenceLinks: (Array.isArray(input.evidenceLinks) ? input.evidenceLinks : [])
      .map((u) => str(u, 500))
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 10),
    risks: str(input.risks, 2000),
    blockers: str(input.blockers, 2000),
    nextSteps: str(input.nextSteps, 2000),
  };
}

export function assertValidCheckIn(ci, kr) {
  if (kr.type !== 'milestone' && ci.value === null) return 'Enter the current value';
  if (!ci.evidence && !ci.evidenceLinks.length) return 'Add evidence (a note or a link)';
  return null;
}

export function cleanInitiative(input = {}, prev = {}) {
  const has = (k) => input[k] !== undefined;
  return {
    title: has('title') ? str(input.title, 200) : prev.title || '',
    description: has('description') ? str(input.description, 2000) : prev.description || '',
    ownerId: has('ownerId') ? str(input.ownerId, 60) || null : prev.ownerId || null,
    dueDate: has('dueDate') ? day(input.dueDate) : prev.dueDate || null,
    status: has('status') ? pick(INITIATIVE_STATUS, input.status, 'planned') : prev.status || 'planned',
    expectedImpact: has('expectedImpact') ? str(input.expectedImpact, 1000) : prev.expectedImpact || '',
    krId: has('krId') ? str(input.krId, 60) || null : prev.krId || null,
  };
}

export function assertValidInitiative(i) {
  if (!i.title) return 'Enter the initiative title';
  return null;
}

export function cleanLinkInput(input = {}) {
  const targetType = Object.hasOwn(LINK_TARGETS, input.targetType) ? input.targetType : null;
  const url = str(input.url, 500);
  return {
    entity: Object.hasOwn(ENTITY_TYPES, input.entity) ? input.entity : 'objective',
    entityId: str(input.entityId, 60) || null,
    targetType,
    targetId: str(input.targetId, 200),
    url: /^https?:\/\//i.test(url) ? url : '',
    label: str(input.label, 200),
    relationshipType: pick(LINK_RELATIONSHIPS, input.relationshipType, 'relates_to'),
  };
}

export function assertValidLink(l) {
  if (!l.targetType) return 'Choose what to link to';
  if (LINK_TARGETS[l.targetType].internal) {
    if (!l.targetId) return 'Choose the item to link';
  } else if (!l.url) return 'Enter the link (https://…)';
  return null;
}

// Is a check-in due for this KR? Based on the frequency and the last check-in.
export function checkInDue(kr, lastCheckInAt, nowIso = new Date().toISOString()) {
  const days = FREQUENCIES[kr.frequency] || 7;
  const since = lastCheckInAt || kr.createdAt;
  if (!since) return true;
  return Date.parse(nowIso) - Date.parse(since) >= days * 864e5;
}
