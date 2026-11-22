// Data shapes and validation for Feedback & Recognition. No I/O.
//
//   Recognition            → kudos to one or more people, with an explicit audience
//   Feedback               → requested / offered / continuous / after an event
//   FeedbackRequest        → a question to people; answered by Feedback items
//   Reaction               → on recognitions only (no points, no ranking)
//   DevelopmentCommitment  → next step created explicitly, with owner and due date
//   PrivateNote            → 1:1 notes, stored under the author's own key space
//
// People, groups and teams are never copied: only ids of the canonical model.

import { str, isDate } from '@rewind/core';

export const DEFAULT_CATEGORIES = [
  { key: 'collaboration', label: 'Collaboration' },
  { key: 'quality', label: 'Quality' },
  { key: 'ownership', label: 'Ownership' },
  { key: 'learning', label: 'Learning' },
  { key: 'support', label: 'Support' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'continuous_improvement', label: 'Continuous improvement' },
];

// Who can see an item. "private" = only the participants.
export const RECOGNITION_AUDIENCES = ['private', 'team', 'group', 'org'];
// Feedback is never company-wide; team/group audiences are frozen at send
// time (a later membership change doesn't widen access, spec §9).
export const FEEDBACK_AUDIENCES = ['private', 'team', 'group'];

export const FEEDBACK_KINDS = ['requested', 'offered', 'continuous', 'after_event'];
export const REQUEST_STATUS = ['open', 'answered', 'closed', 'cancelled'];
export const COMMITMENT_STATUS = ['open', 'done', 'dropped'];
export const REACTIONS = ['👏', '🙌', '💡', '❤️', '🚀'];

// Where an item can link to; resolved through the target module's API.
export const LINK_TARGETS = {
  goal_objective: 'Objective',
  retro_board: 'Retrospective',
  gmud_change: 'Change (GMUD)',
  incident: 'Incident',
  delivery: 'Delivery',
};

export const PERMISSIONS = [
  { key: 'feedback:admin', label: 'Feedback: manage categories and policy (never grants access to private content)', module: 'feedback' },
];

const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, 60)).filter(Boolean))].slice(0, 50);

export function cleanAudience(input, allowed) {
  const type = allowed.includes(input?.type) ? input.type : 'private';
  return { type, id: type === 'team' || type === 'group' ? str(input?.id, 60) || null : null };
}

export function cleanLinks(v) {
  return (Array.isArray(v) ? v : [])
    .map((l) => ({ targetType: Object.hasOwn(LINK_TARGETS, l?.targetType) ? l.targetType : null, targetId: str(l?.targetId, 200) }))
    .filter((l) => l.targetType && l.targetId)
    .slice(0, 10);
}

export function cleanRecognition(input = {}, categories) {
  const keys = categories.map((c) => c.key);
  return {
    recipientIds: ids(input.recipientIds),
    category: keys.includes(input.category) ? input.category : null,
    context: str(input.context, 2000),
    contribution: str(input.contribution, 2000),
    impact: str(input.impact, 2000),
    audience: cleanAudience(input.audience, RECOGNITION_AUDIENCES),
    links: cleanLinks(input.links),
  };
}

export function assertValidRecognition(r) {
  if (!r.recipientIds.length) return 'Choose who you are recognizing';
  if (!r.category) return 'Choose a category';
  if (!r.contribution) return 'Describe the contribution you observed';
  if ((r.audience.type === 'team' || r.audience.type === 'group') && !r.audience.id) return `Choose the ${r.audience.type}`;
  return null;
}

export function cleanFeedback(input = {}) {
  return {
    kind: FEEDBACK_KINDS.includes(input.kind) ? input.kind : 'offered',
    recipientIds: ids(input.recipientIds),
    situation: str(input.situation, 2000),
    behavior: str(input.behavior, 2000),
    impact: str(input.impact, 2000),
    suggestion: str(input.suggestion, 2000),
    audience: cleanAudience(input.audience, FEEDBACK_AUDIENCES),
    links: cleanLinks(input.links),
  };
}

// The context → behavior → impact → next step structure guides, but isn't required.
export function assertValidFeedback(f) {
  if (!f.recipientIds.length) return 'Choose who receives this feedback';
  if (![f.situation, f.behavior, f.impact, f.suggestion].some(Boolean)) return 'Write the feedback';
  if ((f.audience.type === 'team' || f.audience.type === 'group') && !f.audience.id) return `Choose the ${f.audience.type}`;
  return null;
}

export function cleanRequest(input = {}) {
  return {
    question: str(input.question, 1000),
    context: str(input.context, 2000),
    recipientIds: ids(input.recipientIds),
    dueDate: isDate(input.dueDate) ? input.dueDate : null,
    remind: input.remind !== false,
  };
}

export function assertValidRequest(r) {
  if (!r.question) return 'Write your question';
  if (!r.recipientIds.length) return 'Choose who you are asking';
  return null;
}

export function cleanCommitment(input = {}, prev = {}) {
  const has = (k) => input[k] !== undefined;
  return {
    title: has('title') ? str(input.title, 300) : prev.title || '',
    ownerId: has('ownerId') ? str(input.ownerId, 60) || null : prev.ownerId || null,
    dueDate: has('dueDate') ? (isDate(input.dueDate) ? input.dueDate : null) : prev.dueDate || null,
    status: has('status') ? (COMMITMENT_STATUS.includes(input.status) ? input.status : 'open') : prev.status || 'open',
  };
}

export function assertValidCommitment(c) {
  if (!c.title) return 'Describe the next step';
  if (!c.ownerId) return 'Choose who is responsible';
  if (!c.dueDate) return 'Choose a due date';
  return null;
}

export function cleanCategories(v) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(v) ? v : []) {
    const label = str(c?.label, 60);
    const key = str(c?.key, 40) || label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
  }
  return out.slice(0, 30);
}
