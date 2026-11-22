// Issue shapes and validation. No I/O.
//
//   BoardBacklogSettings → where the board's issues come from: manual or Jira (Team filter)
//   Issue                → always part of one board (key iss:{boardId}:{id});
//                          the fields are the ones Jira shows by default on "Create issue"
import { str, isDate } from '@rewind/core';

export const SOURCES = ['manual', 'jira'];
export const ISSUE_TYPES = ['story', 'task', 'bug', 'epic', 'subtask'];
export const STATUSES = ['todo', 'in_progress', 'done'];
export const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'];

const labels = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((x) => str(String(x), 40).replace(/\s+/g, '-')).filter(Boolean))].slice(0, 20);

export function cleanSettings(input = {}, prev = {}) {
  const has = (k) => input[k] !== undefined;
  const prefix = has('keyPrefix') ? str(input.keyPrefix, 10).toUpperCase().replace(/[^A-Z0-9]/g, '') : prev.keyPrefix;
  return {
    source: has('source') ? (SOURCES.includes(input.source) ? input.source : 'manual') : prev.source || 'manual',
    jiraTeam: has('jiraTeam') ? str(input.jiraTeam, 120) : prev.jiraTeam || '',
    jiraProject: has('jiraProject') ? str(input.jiraProject, 20).toUpperCase().replace(/[^A-Z0-9_]/g, '') : prev.jiraProject || '',
    keyPrefix: prefix || 'ISS',
  };
}

export function assertValidSettings(s) {
  if (s.source === 'jira' && !s.jiraTeam) return 'Enter the Jira Team whose issues this board shows';
  return null;
}

// Jira Cloud: the "Team" field (Atlassian teams) is queried as Team[Team].
// A team id (uuid) is matched exactly; anything else is matched by name.
export function jqlFor(s) {
  const q = (v) => `"${v.replace(/["\\]/g, '')}"`;
  const team = /^[0-9a-f-]{36}$/i.test(s.jiraTeam) ? `"Team[Team]" = ${q(s.jiraTeam)}` : `"Team[Team]" in teamsByName(${q(s.jiraTeam)})`;
  return [team, s.jiraProject ? `project = ${q(s.jiraProject)}` : null].filter(Boolean).join(' AND ') + ' ORDER BY Rank ASC';
}

export function cleanIssue(input = {}, prev = {}) {
  const has = (k) => input[k] !== undefined;
  const pick = (k, fn, d) => (has(k) ? fn(input[k]) : prev[k] ?? d);
  const points = (v) => (v === '' || v === null ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 10) / 10 : null);
  return {
    issueType: pick('issueType', (v) => (ISSUE_TYPES.includes(v) ? v : 'story'), 'story'),
    summary: pick('summary', (v) => str(v, 255), ''),
    description: pick('description', (v) => str(v, 10000), ''),
    status: pick('status', (v) => (STATUSES.includes(v) ? v : 'todo'), 'todo'),
    priority: pick('priority', (v) => (PRIORITIES.includes(v) ? v : 'medium'), 'medium'),
    assigneeId: pick('assigneeId', (v) => str(v, 60) || null, null),
    reporterId: pick('reporterId', (v) => str(v, 60) || null, null),
    labels: pick('labels', labels, []),
    storyPoints: pick('storyPoints', points, null),
    dueDate: pick('dueDate', (v) => (isDate(v) ? v : null), null),
    parentId: pick('parentId', (v) => str(v, 60) || null, null),
    sprintId: pick('sprintId', (v) => str(v, 60) || null, null),
  };
}

export function assertValidIssue(i) {
  if (!i.summary) return 'Enter the summary';
  return null;
}

// Jira issue → backlog issue (read-only copy; people are kept as display names).
const STATUS_CATEGORY = { new: 'todo', indeterminate: 'in_progress', done: 'done' };
export function fromJira(j, site) {
  const f = j.fields || {};
  const type = String(f.issuetype?.name || '').toLowerCase().replace(/[-\s]/g, '');
  const text = (doc) => (typeof doc === 'string' ? doc : (doc?.content || []).map((b) => (b.content || []).map((x) => x.text || '').join('')).join('\n'));
  return {
    key: j.key,
    externalId: j.id,
    url: `${site}/browse/${j.key}`,
    issueType: ISSUE_TYPES.includes(type) ? type : type === 'subtask' || f.issuetype?.subtask ? 'subtask' : 'task',
    summary: str(f.summary, 255),
    description: str(text(f.description), 10000),
    status: STATUS_CATEGORY[f.status?.statusCategory?.key] || 'todo',
    statusName: str(f.status?.name, 60),
    priority: PRIORITIES.includes(String(f.priority?.name || '').toLowerCase()) ? f.priority.name.toLowerCase() : 'medium',
    assigneeName: str(f.assignee?.displayName, 120) || null,
    reporterName: str(f.reporter?.displayName, 120) || null,
    labels: labels(f.labels),
    storyPoints: null,
    dueDate: isDate(f.duedate) ? f.duedate : null,
    parentKey: f.parent?.key || null,
    jiraSprint: str((f.sprint || f.customfield_10020?.[0])?.name, 120) || null,
    updatedAtSource: f.updated || null,
  };
}

// Delivery sprint: planned → active (started) → completed. Only one active per
// board. Completing it is what opens the board's retrospective.
export const SPRINT_STATUS = ['planned', 'active', 'completed'];

export function cleanSprint(input = {}, prev = {}) {
  const has = (k) => input[k] !== undefined;
  return {
    name: has('name') ? str(input.name, 80) : prev.name || '',
    goal: has('goal') ? str(input.goal, 500) : prev.goal || '',
    startDate: has('startDate') ? (isDate(input.startDate) ? input.startDate : null) : prev.startDate || null,
    endDate: has('endDate') ? (isDate(input.endDate) ? input.endDate : null) : prev.endDate || null,
  };
}

export function assertValidSprint(s) {
  if (!s.name) return 'Enter the sprint name';
  if (s.startDate && s.endDate && s.endDate < s.startDate) return 'The end date must be after the start date';
  return null;
}
