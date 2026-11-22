// Data shapes, metric definitions and the pure computations of Engineering
// Metrics. No I/O.
//
//   MetricDefinition   → versioned formula, unit, window, minimum sample
//   MetricSource       → GitHub (synced) or API/webhook (pushed); health + last sync
//   MetricEvent        → normalized PR / deployment / incident, with its source
//   TeamMetricScope    → repository/service ↔ team (or group), validFrom/validTo
//   MetricAnnotation   → relevant event on a team's (or the org's) timeline
//   MetricGoalLink     → metric ↔ key result: baseline, target, direction, window
//   Experiment         → hypothesis, action, owner, observed result
//   Insight            → computed from rules, with evidence (never stored scores)
//
// Metrics describe the system of work. Nothing here is per person: events keep
// no author, and no view or API aggregates by individual.

import { str, isDate } from '@rewind/core';

export const EVENT_TYPES = ['pull_request', 'deployment', 'incident'];
export const DEPLOY_STATUS = ['success', 'failure', 'rolled_back'];
export const SOURCE_TYPES = ['github', 'api'];
export const SCOPE_KINDS = ['repository', 'service'];
export const OWNER_TYPES = ['team', 'group'];
export const DIRECTIONS = ['increase', 'decrease'];
export const EXPERIMENT_STATUS = ['planned', 'running', 'concluded', 'abandoned'];
export const LEAD_TIME_STARTS = ['first_commit', 'pr_opened', 'pr_merged'];
export const PRODUCTION = ['production', 'prod'];

export const PERMISSIONS = [
  { key: 'metrics:read', label: 'Engineering metrics: see every team and the whole organization', module: 'metrics' },
  { key: 'metrics:admin', label: 'Engineering metrics: manage sources, repository mapping and definitions', module: 'metrics' },
];

// Version 1 of each definition. Changing a formula setting bumps the version
// and keeps the previous one in the history (spec §8).
export const DEFAULT_DEFINITIONS = {
  deployment_frequency: {
    name: 'Deployment frequency',
    formula: 'Count of successful deployments to production in the period, divided by the number of weeks',
    unit: 'deployments / week',
    sources: ['github deployments', 'api'],
    minSample: 1,
  },
  lead_time: {
    name: 'Lead time for changes',
    formula: 'Median time from the configured start milestone to the production deployment that shipped the change',
    unit: 'hours',
    sources: ['github deployments', 'api'],
    minSample: 5,
    leadTimeStart: 'pr_opened',
  },
  change_failure_rate: {
    name: 'Change failure rate',
    formula: 'Production deployments that failed, were rolled back or caused an attributed incident, divided by all production deployments',
    unit: '%',
    sources: ['github deployments', 'api', 'incidents (api)'],
    minSample: 5,
  },
  mttr: {
    name: 'Mean time to restore (MTTR)',
    formula: 'Median time between incident start (detection) and restoration',
    unit: 'hours',
    sources: ['incidents (api)'],
    minSample: 3,
  },
  throughput: {
    name: 'Throughput',
    formula: 'Pull requests merged in the period, divided by the number of weeks',
    unit: 'merged pull requests / week',
    sources: ['github pull requests', 'api'],
    minSample: 1,
  },
  pr_cycle_time: {
    name: 'PR cycle time',
    formula: 'Median time from pull request opened to merged; split into waiting for first review and review → merge',
    unit: 'hours',
    sources: ['github pull requests', 'api'],
    minSample: 5,
  },
};
export const METRIC_KEYS = Object.keys(DEFAULT_DEFINITIONS);

const iso = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const nums = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
const strs = (v, max = 120) => [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean))].slice(0, 200);

export const normRepo = (v) => str(v, 200).toLowerCase();
export const isProduction = (env) => PRODUCTION.includes(String(env || '').toLowerCase());

// ------------------------------------------------------------ events
// Event ids are derived from (source, type, external id): receiving the same
// event twice overwrites it instead of counting it twice (idempotent ingestion).
export function eventId(sourceId, type, externalId) {
  return `${sourceId}.${type}.${String(externalId).replace(/[^\w.-]/g, '_')}`.slice(0, 240);
}

// Normalizes one incoming event. Author/user fields are dropped on purpose.
export function cleanEvent(input = {}) {
  const type = EVENT_TYPES.includes(input.type) ? input.type : null;
  const base = {
    type,
    externalId: str(String(input.externalId ?? input.id ?? ''), 200),
    repository: normRepo(input.repository),
    service: str(input.service, 120).toLowerCase(),
    environment: str(input.environment, 60).toLowerCase(),
    url: /^https?:\/\//.test(input.url || '') ? str(input.url, 500) : '',
    title: str(input.title, 300),
  };
  if (type === 'pull_request') {
    return {
      ...base,
      number: Number.isInteger(input.number) ? input.number : null,
      firstCommitAt: iso(input.firstCommitAt),
      openedAt: iso(input.openedAt),
      firstReviewAt: iso(input.firstReviewAt),
      mergedAt: iso(input.mergedAt),
      occurredAt: iso(input.mergedAt) || iso(input.openedAt),
    };
  }
  if (type === 'deployment') {
    return {
      ...base,
      status: DEPLOY_STATUS.includes(input.status) ? input.status : 'success',
      sha: str(input.sha, 80),
      prNumbers: nums(input.prNumbers),
      gmudChangeId: str(input.gmudChangeId, 60) || null,
      occurredAt: iso(input.deployedAt || input.occurredAt),
    };
  }
  if (type === 'incident') {
    return {
      ...base,
      startedAt: iso(input.startedAt),
      restoredAt: iso(input.restoredAt),
      deploymentId: str(input.deploymentId, 240) || null,
      occurredAt: iso(input.startedAt),
    };
  }
  return base;
}

export function assertValidEvent(e) {
  if (!e.type) return `type must be one of ${EVENT_TYPES.join(', ')}`;
  if (!e.externalId) return 'externalId is required';
  if (!e.repository && !e.service) return 'repository or service is required';
  if (!e.occurredAt) return e.type === 'pull_request' ? 'openedAt is required' : e.type === 'deployment' ? 'deployedAt is required' : 'startedAt is required';
  if (e.type === 'incident' && e.restoredAt && e.restoredAt < e.startedAt) return 'restoredAt is before startedAt';
  return null;
}

// ------------------------------------------------------------ scopes
export function cleanScope(input = {}) {
  return {
    kind: SCOPE_KINDS.includes(input.kind) ? input.kind : 'repository',
    name: input.kind === 'service' ? str(input.name, 120).toLowerCase() : normRepo(input.name),
    ownerType: OWNER_TYPES.includes(input.ownerType) ? input.ownerType : 'team',
    ownerId: str(input.ownerId, 60) || null,
    environments: strs(input.environments, 60).map((x) => x.toLowerCase()),
    validFrom: isDate(input.validFrom) ? input.validFrom : null,
    validTo: isDate(input.validTo) ? input.validTo : null,
  };
}

export function assertValidScope(s) {
  if (!s.name) return s.kind === 'service' ? 'Name the service' : 'Choose the repository (owner/name)';
  if (s.kind === 'repository' && !/^[\w.-]+\/[\w.-]+$/.test(s.name)) return 'Repository must look like owner/name';
  if (!s.ownerId) return `Choose the ${s.ownerType}`;
  if (!s.validFrom) return 'Choose when the association starts';
  if (s.validTo && s.validTo < s.validFrom) return 'The end is before the start';
  return null;
}

// A scope covers an event when the names match and the event happened in its
// validity window: re-mapping a repository never rewrites past periods.
export function scopeCovers(scope, event) {
  const day = (event.occurredAt || '').slice(0, 10);
  if (!day || day < scope.validFrom || (scope.validTo && day > scope.validTo)) return false;
  if (scope.kind === 'repository' ? event.repository !== scope.name : event.service !== scope.name) return false;
  return !scope.environments.length || !event.environment || scope.environments.includes(event.environment);
}

// ------------------------------------------------------------ definitions
export function definitionOf(key, stored) {
  const base = { key, version: 1, ...DEFAULT_DEFINITIONS[key], excludeRepositories: [], history: [] };
  return stored ? { ...base, ...stored } : base;
}

export function cleanDefinitionPatch(key, input = {}) {
  const out = {};
  if (input.minSample !== undefined) out.minSample = Math.max(1, Math.min(1000, Number(input.minSample) | 0));
  if (input.excludeRepositories !== undefined) out.excludeRepositories = strs(input.excludeRepositories, 200).map(normRepo);
  if (key === 'lead_time' && input.leadTimeStart !== undefined && LEAD_TIME_STARTS.includes(input.leadTimeStart)) out.leadTimeStart = input.leadTimeStart;
  return out;
}

// ------------------------------------------------------------ other entities
export function cleanAnnotation(input = {}) {
  return {
    date: isDate(input.date) ? input.date : null,
    title: str(input.title, 200),
    note: str(input.note, 2000),
    scopeType: ['org', ...OWNER_TYPES].includes(input.scopeType) ? input.scopeType : 'team',
    scopeId: str(input.scopeId, 60) || null,
    metricKeys: strs(input.metricKeys, 40).filter((k) => METRIC_KEYS.includes(k)),
  };
}

export function assertValidAnnotation(a) {
  if (!a.date) return 'Choose the date';
  if (!a.title) return 'Describe what happened';
  if (a.scopeType !== 'org' && !a.scopeId) return `Choose the ${a.scopeType}`;
  return null;
}

export function cleanGoalLink(input = {}) {
  return {
    metricKey: METRIC_KEYS.includes(input.metricKey) ? input.metricKey : null,
    scopeType: ['org', ...OWNER_TYPES].includes(input.scopeType) ? input.scopeType : 'team',
    scopeId: str(input.scopeId, 60) || null,
    objectiveId: str(input.objectiveId, 60) || null,
    keyResultId: str(input.keyResultId, 60) || null,
    baseline: Number.isFinite(Number(input.baseline)) && input.baseline !== '' && input.baseline !== null ? Number(input.baseline) : null,
    target: Number.isFinite(Number(input.target)) && input.target !== '' && input.target !== null ? Number(input.target) : null,
    direction: DIRECTIONS.includes(input.direction) ? input.direction : 'decrease',
    windowDays: Math.max(7, Math.min(365, Number(input.windowDays) | 0 || 28)),
  };
}

export function assertValidGoalLink(g) {
  if (!g.metricKey) return 'Choose the metric';
  if (!g.objectiveId || !g.keyResultId) return 'Choose the key result';
  if (g.scopeType !== 'org' && !g.scopeId) return `Choose the ${g.scopeType}`;
  if (g.baseline === null || g.target === null) return 'Set the baseline and the target';
  return null;
}

export function cleanExperiment(input = {}, prev = {}) {
  const has = (k) => input[k] !== undefined;
  const pick = (k, fn, d = '') => (has(k) ? fn(input[k]) : prev[k] ?? d);
  return {
    title: pick('title', (v) => str(v, 200)),
    hypothesis: pick('hypothesis', (v) => str(v, 2000)),
    action: pick('action', (v) => str(v, 2000)),
    ownerId: pick('ownerId', (v) => str(v, 60) || null, null),
    teamId: pick('teamId', (v) => str(v, 60) || null, null),
    metricKeys: pick('metricKeys', (v) => strs(v, 40).filter((k) => METRIC_KEYS.includes(k)), []),
    startDate: pick('startDate', (v) => (isDate(v) ? v : null), null),
    endDate: pick('endDate', (v) => (isDate(v) ? v : null), null),
    status: pick('status', (v) => (EXPERIMENT_STATUS.includes(v) ? v : 'planned'), 'planned'),
    observedResult: pick('observedResult', (v) => str(v, 2000)),
  };
}

export function assertValidExperiment(x) {
  if (!x.title) return 'Name the experiment';
  if (!x.hypothesis) return 'Write the hypothesis';
  if (!x.teamId) return 'Choose the team';
  if (!x.ownerId) return 'Choose who owns it';
  if (x.startDate && x.endDate && x.endDate < x.startDate) return 'The end is before the start';
  if (x.status === 'concluded' && !x.observedResult) return 'Record the observed result before concluding';
  return null;
}

// ------------------------------------------------------------ computations
const HOUR = 36e5;
const hours = (a, b) => (new Date(b) - new Date(a)) / HOUR;
const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Monday-based weeks between from and to (inclusive), as YYYY-MM-DD.
export function weeksOf(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  for (; d.toISOString().slice(0, 10) <= to && out.length < 200; d.setUTCDate(d.getUTCDate() + 7)) out.push(d.toISOString().slice(0, 10));
  return out;
}
const weekOf = (at) => {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const inPeriod = (at, from, to) => at && at.slice(0, 10) >= from && at.slice(0, 10) <= to;

// One metric over a set of already-permitted, already-attributed events.
// Returns value + weekly series + the sample behind it; below the minimum
// sample the value is withheld (insufficient), never shown as zero.
export function computeMetric(key, def, events, { from, to }) {
  const excluded = new Set(def.excludeRepositories || []);
  const ev = events.filter((e) => !excluded.has(e.repository));
  const weeks = weeksOf(from, to);
  const nWeeks = Math.max(1, weeks.length);
  const prs = ev.filter((e) => e.type === 'pull_request');
  const deploys = ev.filter((e) => e.type === 'deployment' && isProduction(e.environment) && inPeriod(e.occurredAt, from, to));
  const incidents = ev.filter((e) => e.type === 'incident' && inPeriod(e.startedAt, from, to));
  const merged = prs.filter((e) => inPeriod(e.mergedAt, from, to));
  let sample = [];
  let value = null;
  let perWeek = () => null;
  let extra = {};

  const bucket = (items, at, fn) => (w) => {
    const these = items.filter((x) => weekOf(at(x)) === w);
    return fn(these);
  };

  if (key === 'deployment_frequency') {
    sample = deploys.filter((d) => d.status === 'success');
    value = sample.length / nWeeks;
    perWeek = bucket(sample, (x) => x.occurredAt, (xs) => xs.length);
  } else if (key === 'throughput') {
    sample = merged;
    value = sample.length / nWeeks;
    perWeek = bucket(sample, (x) => x.mergedAt, (xs) => xs.length);
  } else if (key === 'pr_cycle_time') {
    sample = merged.filter((p) => p.openedAt);
    const cyc = (p) => hours(p.openedAt, p.mergedAt);
    value = median(sample.map(cyc));
    const waits = sample.filter((p) => p.firstReviewAt);
    extra = {
      breakdown: {
        waitingForReview: round(median(waits.map((p) => hours(p.openedAt, p.firstReviewAt)))),
        reviewToMerge: round(median(waits.map((p) => hours(p.firstReviewAt, p.mergedAt)))),
        withReviewData: waits.length,
      },
    };
    perWeek = bucket(sample, (x) => x.mergedAt, (xs) => round(median(xs.map(cyc))));
  } else if (key === 'lead_time') {
    const start = def.leadTimeStart || 'pr_opened';
    const field = { first_commit: 'firstCommitAt', pr_opened: 'openedAt', pr_merged: 'mergedAt' }[start];
    const byRepoPr = new Map(prs.map((p) => [`${p.repository}#${p.number}`, p]));
    const pairs = [];
    for (const d of deploys.filter((x) => x.status === 'success')) {
      for (const n of d.prNumbers || []) {
        const p = byRepoPr.get(`${d.repository}#${n}`);
        const s = p?.[field] || (field === 'firstCommitAt' ? p?.openedAt : null);
        if (s && s <= d.occurredAt) pairs.push({ at: d.occurredAt, h: hours(s, d.occurredAt), eventIds: [d.id, p.id] });
      }
    }
    sample = pairs;
    value = median(pairs.map((x) => x.h));
    extra = { startMilestone: start, deploymentsWithoutPrs: deploys.filter((d) => d.status === 'success' && !(d.prNumbers || []).length).length };
    perWeek = bucket(pairs, (x) => x.at, (xs) => round(median(xs.map((x) => x.h))));
  } else if (key === 'change_failure_rate') {
    const caused = new Set(incidents.map((i) => i.deploymentId).filter(Boolean));
    const failed = (d) => d.status !== 'success' || caused.has(d.id);
    sample = deploys;
    value = deploys.length ? (100 * deploys.filter(failed).length) / deploys.length : null;
    extra = { failed: deploys.filter(failed).length };
    perWeek = bucket(deploys, (x) => x.occurredAt, (xs) => (xs.length ? round((100 * xs.filter(failed).length) / xs.length) : null));
  } else if (key === 'mttr') {
    sample = incidents.filter((i) => i.restoredAt);
    const t = (i) => hours(i.startedAt, i.restoredAt);
    value = median(sample.map(t));
    extra = { stillOpen: incidents.length - sample.length };
    perWeek = bucket(sample, (x) => x.startedAt, (xs) => round(median(xs.map(t))));
  }

  const insufficient = sample.length < (def.minSample || 1);
  return {
    key,
    value: insufficient ? null : round(value),
    unit: def.unit,
    sample: sample.length,
    minSample: def.minSample || 1,
    insufficient,
    series: weeks.map((w) => ({ week: w, value: insufficient ? null : perWeek(w) })),
    ...extra,
  };
}

// Sustained trend change: the last 3 weeks all moved the same way against the
// average of the earlier weeks by more than 20%. Evidence, not causality.
export function trendAlert(metric, def) {
  const vals = metric.series.map((p) => p.value);
  if (vals.length < 6 || metric.insufficient) return null;
  const last = vals.slice(-3);
  const before = vals.slice(0, -3).filter((v) => v !== null);
  if (last.some((v) => v === null) || before.length < 3) return null;
  const avg = before.reduce((a, b) => a + b, 0) / before.length;
  if (!avg) return null;
  const up = last.every((v) => v > avg * 1.2);
  const down = last.every((v) => v < avg * 0.8);
  if (!up && !down) return null;
  const lowerIsBetter = ['lead_time', 'change_failure_rate', 'mttr', 'pr_cycle_time'].includes(metric.key);
  return {
    metricKey: metric.key,
    direction: up ? 'up' : 'down',
    better: lowerIsBetter ? down : up,
    baseline: round(avg),
    recent: last,
    message: `${def.name} ${up ? 'rose' : 'fell'} for 3 weeks in a row against the earlier average (${round(avg)} ${def.unit}).`,
  };
}
