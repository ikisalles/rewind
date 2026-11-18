// The change (GMUD) model: its sections, how each one is cleaned up when saved, the risk matrix,
// which approvals a change needs, the status workflow and what is still missing to submit.
import { str } from '@rewind/core';
import { valid as validVersion, DEFAULT_POLICY, highestBump } from './semver.js';

export const STATUSES = ['draft', 'submitted', 'in_review', 'approved', 'rejected', 'scheduled', 'in_progress', 'completed', 'failed', 'rolled_back', 'cancelled'];
export const CHANGE_TYPES = ['major', 'minor', 'patch'];
export const CATEGORIES = ['feature', 'bugfix', 'security', 'refactoring', 'infrastructure', 'dependency'];
export const LEVELS = ['low', 'medium', 'high', 'critical'];
export const LIKELIHOOD = ['low', 'medium', 'high'];
export const ENVIRONMENTS = ['development', 'staging', 'production'];
export const STRATEGIES = ['rolling', 'blue_green', 'canary', 'feature_flag', 'manual'];
export const STEP_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'skipped'];
export const ROLES = ['technical', 'change', 'security'];
export const DEPLOY_STATUSES = ['planned', 'in_progress', 'succeeded', 'failed', 'rolled_back'];

const levelRank = (l) => LEVELS.indexOf(l);

// The content of a change can only be edited while it is a draft.
export const EDITABLE = ['draft'];
// Execution (checklist, deployments) is tracked once the change is approved.
export const EXECUTABLE = ['approved', 'scheduled', 'in_progress', 'completed', 'failed'];
export const OPEN = ['draft', 'submitted', 'in_review', 'approved', 'scheduled', 'in_progress'];

// action -> [from statuses, to status]
export const TRANSITIONS = {
  withdraw: [['submitted', 'in_review'], 'draft'],
  schedule: [['approved'], 'scheduled'],
  start: [['approved', 'scheduled'], 'in_progress'],
  complete: [['in_progress'], 'completed'],
  fail: [['in_progress'], 'failed'],
  rollback: [['in_progress', 'failed', 'completed'], 'rolled_back'],
  cancel: [['draft', 'submitted', 'in_review', 'approved', 'scheduled'], 'cancelled'],
  revise: [['rejected'], 'draft'],
};

export const DEFAULT_STEPS = [
  ['Pre-deployment validation', 'Service health, backups and dependencies.'],
  ['Deploy', 'Deploy each service / release.'],
  ['Smoke tests', 'Critical flows work.'],
  ['Post-deployment monitoring', 'Errors, latency and availability.'],
];

export const DEFAULT_SETTINGS = {
  // who decides for each role: people and/or teams (groups); anyone in a listed team may decide.
  // Nobody and no team listed = any admin.
  approvers: { technical: [], change: [], security: [] },
  approverTeams: { technical: [], change: [], security: [] },
  rules: {
    technical: true, // always required
    changeEnvironments: ['production'], // change approver needed in these environments...
    changeMinRisk: 'high', // ...or from this risk level up
    securityCategories: ['security'], // security approval for these categories or when flagged
  },
  allowSelfApproval: false,
  semver: { ...DEFAULT_POLICY },
};

// ------------------------------------------------------------------ cleaning input
const pick = (v, list, fallback = '') => (list.includes(v) ? v : fallback);
const bool = (v) => v === true || v === 'true' || v === 'on';
const text = (v, max = 4000) => str(v, max);
const list = (v, max = 30, each = 80) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => str(x, each)).filter(Boolean).slice(0, max);
const dateTime = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v || '') ? v : '');
const url = (v) => {
  const s = str(v, 500);
  try {
    return s && ['http:', 'https:'].includes(new URL(s).protocol) ? s : '';
  } catch {
    return '';
  }
};
const links = (v) => (Array.isArray(v) ? v : []).map((l) => ({ label: str(l?.label, 120), url: url(l?.url) })).filter((l) => l.url).slice(0, 20);

// Risk = likelihood × impact (1..3 each): 1–2 low, 3–4 medium, 6 high, 9 critical.
export function calculateRisk(probability, impact) {
  const p = LIKELIHOOD.indexOf(probability) + 1;
  const i = LIKELIHOOD.indexOf(impact) + 1;
  if (!p || !i) return null;
  const score = p * i;
  return score >= 9 ? 'critical' : score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low';
}

// The level shown everywhere: the one set by hand in Risk & Testing, or the calculated one.
// (overview.riskLevel: drafts saved before the level moved to the risk step)
export const riskLevel = (change) => change.risk.override || change.overview.riskLevel || change.risk.calculated || null;

// The change's description: one for the whole change (written in Code & Changes, next to the PRs
// it describes). overview.description: drafts saved before it moved there.
export const description = (change) => change.code.summary?.text || change.overview.description || '';

// The change type is the highest increment among its repositories.
export const changeTypeOf = (repos) => highestBump(repos.map((r) => r.bump).filter(Boolean)) || '';

const PR_FIELDS = (pr) => ({
  number: Number(pr.number) || 0,
  title: str(pr.title, 300),
  url: url(pr.url),
  body: str(pr.body, 3000),
  author: str(pr.author, 80),
  state: str(pr.state, 20),
  labels: list(pr.labels, 30, 60),
  reviewers: (Array.isArray(pr.reviewers) ? pr.reviewers : []).slice(0, 20).map((r) => ({ login: str(r?.login, 80), state: str(r?.state, 30) })),
  approvals: Number(pr.approvals) || 0,
  mergedAt: str(pr.mergedAt, 40),
  baseRef: str(pr.baseRef, 120),
  headRef: str(pr.headRef, 120),
  commits: Number(pr.commits) || 0,
  commitList: (Array.isArray(pr.commitList) ? pr.commitList : []).slice(0, 100).map((c) => ({ sha: str(c?.sha, 40), message: str(c?.message, 300), author: str(c?.author, 80) })),
  files: Number(pr.files) || 0,
  fileList: list(pr.fileList, 100, 300),
  additions: Number(pr.additions) || 0,
  deletions: Number(pr.deletions) || 0,
  checks: pr.checks && typeof pr.checks === 'object'
    ? { state: str(pr.checks.state, 20), total: Number(pr.checks.total) || 0, passed: Number(pr.checks.passed) || 0, failed: Number(pr.checks.failed) || 0, url: url(pr.checks.url) }
    : null,
  issues: (Array.isArray(pr.issues) ? pr.issues : []).slice(0, 20).map((i) => ({ number: Number(i?.number) || 0, url: url(i?.url), title: str(i?.title, 200) })),
});

function cleanRepo(r) {
  const repo = str(r?.repo, 140);
  if (!repo) return null;
  const prs = (Array.isArray(r.prs) ? r.prs : []).slice(0, 60).map(PR_FIELDS).filter((p) => p.number);
  const commits = prs.reduce((n, p) => n + p.commits, 0);
  return {
    repo,
    github: bool(r.github),
    currentVersion: validVersion(r.currentVersion) ? str(r.currentVersion, 60).replace(/^v/, '') : '',
    nextVersion: validVersion(r.nextVersion) ? str(r.nextVersion, 60).replace(/^v/, '') : '',
    bump: pick(r.bump, CHANGE_TYPES),
    confirmed: bool(r.confirmed),
    suggested: r.suggested && typeof r.suggested === 'object' ? { bump: pick(r.suggested.bump, CHANGE_TYPES), reasons: list(r.suggested.reasons, 20, 200) } : null,
    source: {
      mode: pick(r.source?.mode, ['prs', 'release', 'compare', 'manual'], 'manual'),
      base: str(r.source?.base, 120),
      head: str(r.source?.head, 120),
      tag: str(r.source?.tag, 120),
    },
    prs,
    stats: { prs: prs.length, commits: Number(r.stats?.commits) || commits, files: Number(r.stats?.files) || prs.reduce((n, p) => n + p.files, 0) },
  };
}

// Each section of the form, cleaned field by field. Unknown fields are dropped.
// Derived fields are not taken from the form: overview.changeType comes from the repositories.
export const SECTIONS = {
  overview: (d) => ({
    title: text(d.title, 160),
    category: pick(d.category, CATEGORIES),
    priority: pick(d.priority, LEVELS),
    responsibleId: str(d.responsibleId, 60),
    teamId: str(d.teamId, 60),
    environment: pick(d.environment, ENVIRONMENTS),
    plannedAt: dateTime(d.plannedAt),
    tags: list(d.tags, 20, 40),
  }),
  code: (d) => ({
    repos: (Array.isArray(d.repos) ? d.repos : []).slice(0, 20).map(cleanRepo).filter(Boolean),
    summary: { text: text(d.summary?.text, 8000), origin: pick(d.summary?.origin, ['generated', 'edited', 'manual'], 'manual') },
  }),
  risk: (d) => ({
    affectedSystems: text(d.affectedSystems, 500),
    affectedServices: text(d.affectedServices, 500),
    customerImpact: text(d.customerImpact, 1000),
    downtime: text(d.downtime, 200),
    dependencies: text(d.dependencies, 500),
    dataMigration: bool(d.dataMigration),
    probability: pick(d.probability, LIKELIHOOD),
    impact: pick(d.impact, LIKELIHOOD),
    override: pick(d.override, LEVELS), // '' = use the calculated level
    justification: text(d.justification, 2000),
    indicators: {
      infrastructure: bool(d.indicators?.infrastructure),
      database: bool(d.indicators?.database),
      api: bool(d.indicators?.api),
      security: bool(d.indicators?.security),
    },
  }),
  testing: (d) => ({
    unit: bool(d.unit),
    integration: bool(d.integration),
    e2e: bool(d.e2e),
    codeReview: bool(d.codeReview),
    ciChecks: bool(d.ciChecks),
    evidence: links(d.evidence),
    acceptance: text(d.acceptance, 2000),
    postDeploy: text(d.postDeploy, 2000),
  }),
  rollback: (d) => ({
    notApplicable: bool(d.notApplicable),
    justification: text(d.justification, 2000),
    strategy: text(d.strategy, 500),
    procedure: text(d.procedure, 4000),
    previousVersion: text(d.previousVersion, 200),
    ownerId: str(d.ownerId, 60),
    recoveryTime: text(d.recoveryTime, 100),
    triggers: text(d.triggers, 2000),
  }),
  execution: (d, current = {}) => ({
    strategy: pick(d.strategy, STRATEGIES),
    duration: text(d.duration, 100),
    ownerId: str(d.ownerId, 60),
    monitoringOwnerId: str(d.monitoringOwnerId, 60),
    pipeline: text(d.pipeline, 200),
    deploymentUrl: url(d.deploymentUrl),
    steps: (Array.isArray(d.steps) ? d.steps : current.steps || []).slice(0, 40).map(cleanStep).filter((s) => s.title),
  }),
};

export function cleanStep(s) {
  return {
    id: str(s?.id, 40),
    title: str(s?.title, 160),
    detail: str(s?.detail, 500),
    ownerId: str(s?.ownerId, 60),
    eta: dateTime(s?.eta),
    status: pick(s?.status, STEP_STATUSES, 'pending'),
    evidence: url(s?.evidence),
    notes: str(s?.notes, 1000),
  };
}

export function emptyChange() {
  return {
    overview: SECTIONS.overview({}),
    code: SECTIONS.code({}),
    risk: { ...SECTIONS.risk({}), calculated: null },
    testing: SECTIONS.testing({}),
    rollback: SECTIONS.rollback({}),
    execution: SECTIONS.execution({ steps: [] }),
    approvals: { required: [], decisions: [] },
  };
}

export function cleanSettings(d = {}, current = DEFAULT_SETTINGS) {
  const approvers = Object.fromEntries(ROLES.map((r) => [r, list(d.approvers?.[r] ?? current.approvers[r], 50, 60)]));
  const approverTeams = Object.fromEntries(ROLES.map((r) => [r, list(d.approverTeams?.[r] ?? current.approverTeams?.[r] ?? [], 50, 60)]));
  const rules = d.rules || current.rules;
  const semver = d.semver || current.semver;
  return {
    approvers,
    approverTeams,
    rules: {
      technical: rules.technical !== false && rules.technical !== 'false',
      changeEnvironments: list(rules.changeEnvironments).filter((e) => ENVIRONMENTS.includes(e)),
      changeMinRisk: pick(rules.changeMinRisk, [...LEVELS, 'never'], 'high'),
      securityCategories: list(rules.securityCategories).filter((c) => CATEGORIES.includes(c)),
    },
    allowSelfApproval: bool(d.allowSelfApproval ?? current.allowSelfApproval),
    semver: {
      useLabels: bool(semver.useLabels),
      useConventional: bool(semver.useConventional),
      breakingLabels: list(semver.breakingLabels, 20, 60).map((l) => l.toLowerCase()),
      fallback: pick(semver.fallback, CHANGE_TYPES, 'patch'),
    },
  };
}

// ------------------------------------------------------------------ approvals
// Which approvals a change needs, from the company's rules. Technical first.
export function requiredApprovals(change, settings) {
  const { rules } = settings;
  const out = [];
  const level = riskLevel(change);
  if (rules.technical) out.push('technical');
  const byEnv = rules.changeEnvironments.includes(change.overview.environment);
  const byRisk = rules.changeMinRisk !== 'never' && level && levelRank(level) >= levelRank(rules.changeMinRisk);
  if (byEnv || byRisk) out.push('change');
  if (rules.securityCategories.includes(change.overview.category) || change.risk.indicators?.security) out.push('security');
  if (!out.length) out.push('technical'); // something always has to be approved
  return out;
}

// A person decides for a role when they are listed, or belong to a listed team (group).
// With nobody and no team listed, admins decide.
export function canDecideRole(settings, role, user) {
  const people = settings.approvers[role] || [];
  const teams = settings.approverTeams?.[role] || [];
  if (!people.length && !teams.length) return user.role === 'admin';
  return people.includes(user.id) || (user.teamIds || []).some((t) => teams.includes(t));
}

// Roles this person may decide on for this change (not yet decided).
export function rolesFor(change, user, settings) {
  if (!['submitted', 'in_review'].includes(change.status)) return [];
  if (!settings.allowSelfApproval && change.createdBy === user.id) return [];
  const decided = new Set(change.approvals.decisions.map((d) => d.role));
  return change.approvals.required.filter((role) => {
    if (decided.has(role)) return false;
    return canDecideRole(settings, role, user);
  });
}

// ------------------------------------------------------------------ readiness
// What is still missing before a draft can be submitted, per step of the form.
export function readiness(change) {
  const missing = [];
  const need = (step, ok, message) => !ok && missing.push({ step, message });
  const o = change.overview;
  need('overview', o.title, 'Title');
  need('overview', o.category, 'Category');
  need('overview', o.priority, 'Priority');
  need('overview', o.responsibleId, 'Responsible');
  need('overview', o.teamId, 'Team');
  need('overview', o.environment, 'Environment');
  need('overview', o.plannedAt, 'Planned date');
  const repos = change.code.repos;
  need('code', repos.length, 'At least one repository');
  need('code', description(change), 'Description of the change');
  for (const r of repos) {
    need('code', r.nextVersion, `${r.repo}: next version`);
    need('code', !r.nextVersion || r.confirmed, `${r.repo}: confirm version ${r.nextVersion}`);
  }
  need('risk', riskLevel(change), 'Risk level: likelihood and impact of a failure (or set the level)');
  if (o.environment === 'production') {
    const rb = change.rollback;
    need('risk', rb.notApplicable ? rb.justification : rb.strategy && rb.procedure, 'Production: rollback plan (strategy and procedure) or why it does not apply');
  }
  return { ok: !missing.length, missing };
}
