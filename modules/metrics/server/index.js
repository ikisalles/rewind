// @rewind/metrics — Engineering Metrics (spec: 03-engineering-metrics.md).
//
// Consolidates signals of the engineering flow (pull requests, deployments,
// incidents) into versioned metric definitions, per team / group / org and
// period, to improve the system of work — never to rank people.
//
// The module owns only its own keys (met*:). Teams and people come from core
// services, groups/memberships/roles from the foundation (published helpers),
// and events, audit records and entity links are written with the
// foundation's helpers. Other modules (GMUD, Goals, Retro) are only referenced
// by id through entity links; their data is never read here.

import { defineModule, fail, json, newId, now, randomToken, str, isDate } from '@rewind/core';
import { recordAudit, recordEvent, createLink, deleteLink, K as FK } from '@rewind/foundation/server/events';
import { activeMemberships, hasPermission, loadPermissions, registerPermissions } from '@rewind/foundation/server/rbac';
import {
  DEPLOY_STATUS, DIRECTIONS, EVENT_TYPES, EXPERIMENT_STATUS, LEAD_TIME_STARTS, METRIC_KEYS, OWNER_TYPES, PERMISSIONS, SCOPE_KINDS, SOURCE_TYPES,
  assertValidAnnotation, assertValidEvent, assertValidExperiment, assertValidGoalLink, assertValidScope,
  cleanAnnotation, cleanDefinitionPatch, cleanEvent, cleanExperiment, cleanGoalLink, cleanScope,
  computeMetric, definitionOf, eventId, isProduction, normRepo, scopeCovers, trendAlert, weeksOf,
} from './model.js';
import { githubClient } from './github.js';

const K = {
  source: (o, id) => `metsrc:${o}:${id}`,
  sources: (o) => `metsrc:${o}:`,
  scope: (o, id) => `metscope:${o}:${id}`,
  scopes: (o) => `metscope:${o}:`,
  event: (o, id) => `metevt:${o}:${id}`,
  events: (o) => `metevt:${o}:`,
  definition: (o, key) => `metdef:${o}:${key}`,
  definitions: (o) => `metdef:${o}:`,
  annotation: (o, id) => `metann:${o}:${id}`,
  annotations: (o) => `metann:${o}:`,
  goalLink: (o, id) => `metgoal:${o}:${id}`,
  goalLinks: (o) => `metgoal:${o}:`,
  experiment: (o, id) => `metexp:${o}:${id}`,
  experiments: (o) => `metexp:${o}:`,
  run: (o, id) => `metrun:${o}:${id}`,
  runs: (o) => `metrun:${o}:`,
};

// Where an event can link to; resolved through the target module's API.
const LINK_TARGETS = { gmud_change: 'Change (GMUD)', incident: 'Incident', goal_objective: 'Objective', retro_board: 'Retrospective' };
const LATE_DAYS = 7;
const RAW_RETENTION_DAYS = 400; // raw events older than this are dropped on ingestion runs
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default defineModule({
  id: 'metrics',
  name: 'Engineering Metrics',
  description: 'Deployment frequency, lead time, change failure rate, MTTR, throughput and PR cycle time per team, from GitHub and your pipelines. For improving the system of work, never for ranking people.',
  defaultEnabled: true,
  keyPrefixes: ['metsrc:', 'metscope:', 'metevt:', 'metdef:', 'metann:', 'metgoal:', 'metexp:', 'metrun:'],
  shards: { metsrc: 'org', metscope: 'org', metevt: 'org', metdef: 'org', metann: 'org', metgoal: 'org', metexp: 'org', metrun: 'org' },
  register(core) {
    const { db, isAdmin, route, getTeam, listTeams, listUsers, integrationFor, getOrg } = core;
    registerPermissions(PERMISSIONS);

    // ------------------------------------------------------------ access
    // Evaluated on every request from the canonical model (core teams +
    // foundation memberships and roles).
    async function access(c) {
      if (c.metricsAccess) return c.metricsAccess;
      const [perms, mine] = await Promise.all([loadPermissions(db, c.org.id, c.user), activeMemberships(db, c.org.id, c.user.id)]);
      const coreAdmin = isAdmin(c);
      const admin = coreAdmin || hasPermission(perms, 'metrics:admin');
      const readAll = admin || hasPermission(perms, 'metrics:read');
      const teams = new Set([...(c.user.teamIds || []), ...mine.filter((m) => m.scopeType === 'team').map((m) => m.scopeId)]);
      const groups = new Set(mine.filter((m) => m.scopeType === 'group').map((m) => m.scopeId));
      const canSee = (type, id) => readAll || (type === 'team' && teams.has(id)) || (type === 'group' && groups.has(id));
      c.metricsAccess = { admin, readAll, teams, groups, canSee };
      return c.metricsAccess;
    }
    const requireMetricsAdmin = async (c) => {
      if (!(await access(c)).admin) fail(403, 'Only metrics admins can do this');
    };

    // ------------------------------------------------------------ loaders
    const definitions = async (orgId) => {
      const stored = new Map((await db.list(K.definitions(orgId))).map((d) => [d.key, d]));
      return Object.fromEntries(METRIC_KEYS.map((k) => [k, definitionOf(k, stored.get(k))]));
    };
    const scopesOf = (orgId) => db.list(K.scopes(orgId));
    const ownersOf = (scopes, e) => scopes.filter((s) => scopeCovers(s, e)).map((s) => ({ type: s.ownerType, id: s.ownerId }));

    // An event is visible when the user can see one of the teams/groups that
    // owned its repository/service at the time it happened.
    function visible(a, scopes, e) {
      if (a.readAll) return true;
      return ownersOf(scopes, e).some((o) => a.canSee(o.type, o.id));
    }

    async function checkOwner(c, type, id) {
      if (type === 'team' && !(await getTeam(c.org.id, id))) fail(400, 'Team not found');
      if (type === 'group' && !(await db.get(FK.group(c.org.id, id)))) fail(400, 'Group not found');
    }

    function parsePeriod(q) {
      const to = isDate(q.get('to')) ? q.get('to') : day();
      const from = isDate(q.get('from')) ? q.get('from') : day(-83); // 12 weeks
      if (from > to) fail(400, 'The period starts after it ends');
      if ((new Date(to) - new Date(from)) / 864e5 > 366) fail(400, 'Choose a period of up to one year');
      return { from, to };
    }

    // The events of a scope (team / group / org) the user may see, filtered.
    async function scopedEvents(c, q) {
      const a = await access(c);
      const scopeType = ['org', ...OWNER_TYPES].includes(q.get('scopeType')) ? q.get('scopeType') : 'org';
      const scopeId = scopeType === 'org' ? null : str(q.get('scopeId'), 60);
      if (scopeType === 'org' && !a.readAll) fail(403, 'Organization-wide metrics need the metrics:read permission. Choose one of your teams.');
      if (scopeType !== 'org' && !a.canSee(scopeType, scopeId)) fail(404, `${scopeType === 'team' ? 'Team' : 'Group'} not found`);
      const repository = normRepo(q.get('repository') || '');
      const service = str(q.get('service'), 120).toLowerCase();
      const environment = str(q.get('environment'), 60).toLowerCase();
      const scopes = await scopesOf(c.org.id);
      const mine = scopeType === 'org' ? scopes : scopes.filter((s) => s.ownerType === scopeType && s.ownerId === scopeId);
      const events = (await db.list(K.events(c.org.id))).filter(
        (e) =>
          (scopeType === 'org' ? visible(a, scopes, e) : mine.some((s) => scopeCovers(s, e))) &&
          (!repository || e.repository === repository) &&
          (!service || e.service === service) &&
          // the environment filter narrows deployments; PRs have no environment
          (!environment || e.type === 'pull_request' || e.environment === environment),
      );
      return { a, scopeType, scopeId, scopes, mine, events };
    }

    // Coverage: which mapped repositories/services have a healthy source and
    // data. A failing source is a gap, never "no activity" (spec §12).
    async function coverageOf(c, mine, events, { from, to }) {
      const sources = await db.list(K.sources(c.org.id));
      const names = [...new Set(mine.filter((s) => !s.validTo || s.validTo >= from).map((s) => s.name))];
      const covering = (name) => sources.filter((s) => !s.repositories.length || s.repositories.includes(name));
      const rows = names.map((name) => {
        const src = covering(name);
        const withData = events.some((e) => (e.repository === name || e.service === name) && (e.occurredAt || '').slice(0, 10) >= from && (e.occurredAt || '').slice(0, 10) <= to);
        const failing = src.filter((s) => s.status === 'error');
        return { name, sources: src.map((s) => s.name), hasSource: src.length > 0, healthy: src.length > 0 && !failing.length, withData, failingSources: failing.map((s) => s.name) };
      });
      const lastSyncAt = sources.map((s) => s.lastSyncAt).filter(Boolean).sort().pop() || null;
      return {
        mapped: rows.length,
        withSource: rows.filter((r) => r.hasSource).length,
        healthy: rows.filter((r) => r.healthy).length,
        withData: rows.filter((r) => r.withData).length,
        repositories: rows,
        gaps: rows.filter((r) => !r.healthy).map((r) => (r.hasSource ? `${r.name}: ingestion failing (${r.failingSources.join(', ')})` : `${r.name}: no data source`)),
        lastSyncAt,
        lastEventAt: events.map((e) => e.receivedAt).filter(Boolean).sort().pop() || null,
      };
    }

    const previousPeriod = ({ from, to }) => {
      const len = Math.round((new Date(to) - new Date(from)) / 864e5) + 1;
      const pTo = new Date(new Date(`${from}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
      const pFrom = new Date(new Date(`${pTo}T00:00:00Z`) - (len - 1) * 864e5).toISOString().slice(0, 10);
      return { from: pFrom, to: pTo };
    };

    // Rule-based insights with evidence, sources and period. Hypotheses only.
    function insightsOf(metrics, defs, period) {
      const out = [];
      const by = Object.fromEntries(metrics.map((m) => [m.key, m]));
      const pr = by.pr_cycle_time;
      if (pr?.breakdown?.waitingForReview !== null && pr?.breakdown?.waitingForReview !== undefined && pr.breakdown.withReviewData >= (defs.pr_cycle_time.minSample || 1)) {
        const { waitingForReview: w, reviewToMerge: r } = pr.breakdown;
        if (w > r && w >= 4) {
          out.push({
            kind: 'hypothesis',
            title: 'Pull requests wait longer for a first review than they take from review to merge',
            evidence: `Median ${w} h waiting for the first review vs ${r} h from review to merge (${pr.breakdown.withReviewData} PRs, ${period.from} → ${period.to}).`,
            sources: defs.pr_cycle_time.sources,
            suggestion: 'Possible retrospective topic: how review requests are noticed and picked up.',
          });
        }
      }
      for (const m of metrics) {
        const alert = trendAlert(m, defs[m.key]);
        if (alert) {
          out.push({
            kind: 'trend',
            title: alert.message,
            evidence: `Last 3 weeks: ${alert.recent.join(', ')} ${defs[m.key].unit}; earlier average ${alert.baseline}.`,
            sources: defs[m.key].sources,
            suggestion: alert.better ? 'Worth noting what changed, e.g. as an annotation, before drawing conclusions.' : 'Possible retrospective topic or key result; check data coverage first.',
            alert,
          });
        }
      }
      const lt = by.lead_time;
      if (lt?.deploymentsWithoutPrs > 0) {
        out.push({ kind: 'data', title: `${lt.deploymentsWithoutPrs} production deployment(s) have no linked pull requests`, evidence: 'Lead time only counts deployments whose pull requests are known.', sources: defs.lead_time.sources, suggestion: 'Send prNumbers with deployments (API) or use GitHub deployments.' });
      }
      return out.map((x) => ({ ...x, period, note: 'Correlation, not causation: check context before acting.' }));
    }

    // ------------------------------------------------------------ catalog
    route('GET', '/api/metrics/catalog', async (c) => {
      const a = await access(c);
      const [teams, groups, defs] = await Promise.all([listTeams(c.org.id), db.list(FK.groups(c.org.id)), definitions(c.org.id)]);
      return json({
        definitions: Object.values(defs),
        eventTypes: EVENT_TYPES,
        deployStatus: DEPLOY_STATUS,
        scopeKinds: SCOPE_KINDS,
        sourceTypes: SOURCE_TYPES,
        leadTimeStarts: LEAD_TIME_STARTS,
        directions: DIRECTIONS,
        experimentStatus: EXPERIMENT_STATUS,
        linkTargets: LINK_TARGETS,
        teams: teams.filter((t) => a.canSee('team', t.id)).map((t) => ({ id: t.id, name: t.name })),
        groups: groups.filter((g) => a.canSee('group', g.id)).map((g) => ({ id: g.id, name: g.name })),
        canAdmin: a.admin,
        canReadAll: a.readAll,
      });
    });

    // ------------------------------------------------------------ dashboard
    route('GET', '/api/metrics/dashboard', async (c) => {
      const q = c.url.searchParams;
      const period = parsePeriod(q);
      const { scopeType, scopeId, mine, events } = await scopedEvents(c, q);
      const defs = await definitions(c.org.id);
      const coverage = await coverageOf(c, mine, events, period);
      const prev = previousPeriod(period);
      const noSource = coverage.mapped > 0 && coverage.withSource === 0;
      const metrics = METRIC_KEYS.map((key) => {
        const m = computeMetric(key, defs[key], events, period);
        const p = computeMetric(key, defs[key], events, prev);
        const def = defs[key];
        return {
          ...m,
          status: !coverage.mapped ? 'no_scope' : noSource ? 'no_source' : coverage.gaps.length ? 'partial' : m.insufficient ? 'insufficient_sample' : 'ok',
          previous: { ...prev, value: p.value, sample: p.sample },
          definition: { name: def.name, formula: def.formula, unit: def.unit, version: def.version, window: `${period.from} → ${period.to}`, sources: def.sources, minSample: def.minSample, leadTimeStart: def.leadTimeStart, excludeRepositories: def.excludeRepositories },
          lastUpdated: coverage.lastEventAt,
        };
      });
      const annotations = (await db.list(K.annotations(c.org.id))).filter(
        (x) => x.date >= period.from && x.date <= period.to && (x.scopeType === 'org' || (x.scopeType === scopeType && x.scopeId === scopeId)),
      );
      return json({
        scope: { type: scopeType, id: scopeId },
        period,
        weeks: weeksOf(period.from, period.to),
        metrics,
        coverage,
        annotations: annotations.sort((x, y) => x.date.localeCompare(y.date)),
        insights: insightsOf(metrics, defs, period),
        flow: flowOf(events, period),
      });
    });

    // Delivery flow (spec §4): how many changes reached each stage in the period.
    function flowOf(events, { from, to }) {
      const inP = (at) => at && at.slice(0, 10) >= from && at.slice(0, 10) <= to;
      const prs = events.filter((e) => e.type === 'pull_request' && inP(e.openedAt));
      const deploys = events.filter((e) => e.type === 'deployment' && inP(e.occurredAt));
      return [
        { stage: 'pr_opened', label: 'PR opened', count: prs.length },
        { stage: 'reviewed', label: 'Reviewed', count: prs.filter((p) => p.firstReviewAt).length },
        { stage: 'merged', label: 'Merged', count: prs.filter((p) => p.mergedAt).length },
        { stage: 'deployed', label: 'Deployed to production', count: deploys.filter((d) => isProduction(d.environment) && d.status === 'success').length },
        { stage: 'failed', label: 'Failed / rolled back', count: deploys.filter((d) => isProduction(d.environment) && d.status !== 'success').length },
      ];
    }

    // Comparison between teams only when definition, coverage and sample are
    // equivalent; otherwise the reasons are returned instead of the numbers.
    route('GET', '/api/metrics/compare', async (c) => {
      const a = await access(c);
      if (!a.readAll) fail(403, 'Comparing teams needs the metrics:read permission');
      const q = c.url.searchParams;
      const key = METRIC_KEYS.includes(q.get('metric')) ? q.get('metric') : fail(400, 'Choose the metric');
      const teamIds = (q.get('teamIds') || '').split(',').map((x) => str(x, 60)).filter(Boolean).slice(0, 10);
      if (teamIds.length < 2) fail(400, 'Choose at least two teams');
      const period = parsePeriod(q);
      const defs = await definitions(c.org.id);
      const scopes = await scopesOf(c.org.id);
      const all = await db.list(K.events(c.org.id));
      const rows = [];
      for (const id of teamIds) {
        const team = await getTeam(c.org.id, id);
        if (!team) fail(400, 'Team not found');
        const mine = scopes.filter((s) => s.ownerType === 'team' && s.ownerId === id);
        const events = all.filter((e) => mine.some((s) => scopeCovers(s, e)));
        const coverage = await coverageOf(c, mine, events, period);
        rows.push({ teamId: id, name: team.name, metric: computeMetric(key, defs[key], events, period), coverage });
      }
      const reasons = [];
      for (const r of rows) {
        if (!r.coverage.mapped) reasons.push(`${r.name} has no repositories or services mapped`);
        else if (r.coverage.healthy < r.coverage.mapped) reasons.push(`${r.name} has incomplete data coverage`);
        if (r.metric.insufficient) reasons.push(`${r.name} is below the minimum sample (${r.metric.sample}/${r.metric.minSample})`);
      }
      const comparable = !reasons.length;
      return json({
        metric: key,
        definitionVersion: defs[key].version,
        comparable,
        reasons,
        note: 'Teams differ in context and criticality: use comparisons to learn, not to rank.',
        teams: rows.map((r) => ({ teamId: r.teamId, name: r.name, value: comparable ? r.metric.value : null, sample: r.metric.sample, coverage: { mapped: r.coverage.mapped, healthy: r.coverage.healthy } })),
      });
    });

    // ------------------------------------------------------------ drill-down
    const eventView = (e, owners) => ({ ...e, owners });

    route('GET', '/api/metrics/events', async (c) => {
      const q = c.url.searchParams;
      const period = parsePeriod(q);
      const { scopes, events } = await scopedEvents(c, q);
      const type = EVENT_TYPES.includes(q.get('type')) ? q.get('type') : null;
      const metric = METRIC_KEYS.includes(q.get('metric')) ? q.get('metric') : null;
      const metricTypes = { deployment_frequency: ['deployment'], lead_time: ['deployment', 'pull_request'], change_failure_rate: ['deployment', 'incident'], mttr: ['incident'], throughput: ['pull_request'], pr_cycle_time: ['pull_request'] };
      const at = (e) => (e.type === 'pull_request' ? e.mergedAt || e.openedAt : e.occurredAt) || '';
      const rows = events
        .filter((e) => (!type || e.type === type) && (!metric || metricTypes[metric].includes(e.type)) && at(e).slice(0, 10) >= period.from && at(e).slice(0, 10) <= period.to)
        .sort((x, y) => at(y).localeCompare(at(x)))
        .slice(0, 500);
      const teams = new Map((await listTeams(c.org.id)).map((t) => [t.id, t.name]));
      return json({ events: rows.map((e) => eventView(e, ownersOf(scopes, e).map((o) => ({ ...o, name: teams.get(o.id) || null })))) });
    });

    async function getEvent(c, id) {
      const e = await db.get(K.event(c.org.id, id));
      const a = await access(c);
      if (!e || !visible(a, await scopesOf(c.org.id), e)) fail(404, 'Event not found');
      return e;
    }

    const linksOf = async (orgId, id) => {
      const refs = await db.list(FK.linksBySource(orgId, 'metrics.event', id));
      return (await Promise.all(refs.map((r) => db.get(FK.link(orgId, r.id))))).filter(Boolean);
    };

    route('GET', '/api/metrics/events/:id', async (c) => {
      const e = await getEvent(c, c.params.id);
      const source = await db.get(K.source(c.org.id, e.sourceId));
      return json({ event: eventView(e, ownersOf(await scopesOf(c.org.id), e)), source: source ? { id: source.id, name: source.name, type: source.type } : null, links: await linksOf(c.org.id, e.id) });
    });

    route('POST', '/api/metrics/events/:id/links', async (c) => {
      const e = await getEvent(c, c.params.id);
      const targetType = Object.hasOwn(LINK_TARGETS, c.body.targetType) ? c.body.targetType : fail(400, 'Choose what to link to');
      const targetId = str(c.body.targetId, 200) || fail(400, 'Choose the item to link');
      const existing = (await linksOf(c.org.id, e.id)).find((l) => l.targetType === targetType && l.targetId === targetId);
      if (existing) return json({ link: existing });
      const link = await createLink(db, { orgId: c.org.id, sourceType: 'metrics.event', sourceId: e.id, targetType, targetId, createdBy: c.user.id });
      if (targetType === 'gmud_change' && e.type === 'deployment') await db.patch(K.event(c.org.id, e.id), { gmudChangeId: targetId });
      return json({ link }, 201);
    });

    route('DELETE', '/api/metrics/events/:id/links/:linkId', async (c) => {
      const e = await getEvent(c, c.params.id);
      const link = await db.get(FK.link(c.org.id, c.params.linkId));
      if (!link || link.sourceId !== e.id) fail(404, 'Link not found');
      await deleteLink(db, { orgId: c.org.id, id: link.id });
      return json({ ok: true });
    });

    // ------------------------------------------------------------ export (CSV)
    const csvCell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      // no formula injection in spreadsheets
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

    route('GET', '/api/metrics/export', async (c) => {
      const q = c.url.searchParams;
      const period = parsePeriod(q);
      const { scopeType, scopeId, events } = await scopedEvents(c, q);
      const defs = await definitions(c.org.id);
      let body;
      if (q.get('kind') === 'events') {
        body = csv([
          ['id', 'type', 'repository', 'service', 'environment', 'title', 'url', 'opened_at', 'first_review_at', 'merged_at', 'occurred_at', 'status', 'pr_numbers', 'gmud_change_id', 'started_at', 'restored_at', 'source_id'],
          ...events
            .filter((e) => ((e.type === 'pull_request' ? e.mergedAt || e.openedAt : e.occurredAt) || '').slice(0, 10) >= period.from)
            .map((e) => [e.id, e.type, e.repository, e.service, e.environment, e.title, e.url, e.openedAt, e.firstReviewAt, e.mergedAt, e.occurredAt, e.status, (e.prNumbers || []).join(' '), e.gmudChangeId, e.startedAt, e.restoredAt, e.sourceId]),
        ]);
      } else {
        const rows = [['metric', 'definition_version', 'unit', 'scope_type', 'scope_id', 'week', 'value', 'period_value', 'sample', 'min_sample']];
        for (const key of METRIC_KEYS) {
          const m = computeMetric(key, defs[key], events, period);
          for (const p of m.series) rows.push([key, defs[key].version, defs[key].unit, scopeType, scopeId, p.week, p.value, m.value, m.sample, m.minSample]);
        }
        body = csv(rows);
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="metrics-${period.from}-${period.to}.csv"` } });
    });

    // ------------------------------------------------------------ sources
    const sourceView = ({ tokenHash, ...s }) => ({ ...s, hasToken: Boolean(tokenHash) });

    route('GET', '/api/metrics/sources', async (c) => {
      await requireMetricsAdmin(c);
      const runs = (await db.list(K.runs(c.org.id))).sort((x, y) => y.startedAt.localeCompare(x.startedAt));
      return json({ sources: (await db.list(K.sources(c.org.id))).map(sourceView), runs: runs.slice(0, 50) });
    });

    route('POST', '/api/metrics/sources', async (c) => {
      await requireMetricsAdmin(c);
      const type = SOURCE_TYPES.includes(c.body.type) ? c.body.type : fail(400, 'Choose the source type');
      const name = str(c.body.name, 120) || (type === 'github' ? 'GitHub' : 'API');
      const repositories = [...new Set((Array.isArray(c.body.repositories) ? c.body.repositories : []).map(normRepo).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))].slice(0, 100);
      if (type === 'github' && !repositories.length) fail(400, 'Choose the repositories to read (owner/name)');
      if (type === 'github' && !(await integrationFor(c, 'github'))) fail(400, 'Connect your GitHub account first (My account → Integrations → GitHub)');
      const source = { id: newId(), type, name, repositories, status: 'never', lastSyncAt: null, lastError: null, connectedBy: type === 'github' ? c.user.id : null, createdBy: c.user.id, createdAt: now() };
      let token = null;
      if (type === 'api') {
        token = `rwm_${randomToken(24)}`;
        source.tokenHash = await sha256(token);
      }
      await db.put(K.source(c.org.id, source.id), source);
      await recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action: 'metrics.source.created', target: { type: 'metrics.source', id: source.id }, after: sourceView(source) });
      // the ingestion token is shown once
      return json({ source: sourceView(source), token, ingestUrl: type === 'api' ? `/api/metrics/ingest/${c.org.id}/${source.id}` : null }, 201);
    });

    route('PATCH', '/api/metrics/sources/:id', async (c) => {
      await requireMetricsAdmin(c);
      const s = (await db.get(K.source(c.org.id, c.params.id))) || fail(404, 'Source not found');
      const next = { ...s };
      if (c.body.name !== undefined) next.name = str(c.body.name, 120) || s.name;
      if (c.body.repositories !== undefined) next.repositories = [...new Set((Array.isArray(c.body.repositories) ? c.body.repositories : []).map(normRepo).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))].slice(0, 100);
      if (s.type === 'github' && !next.repositories.length) fail(400, 'Choose the repositories to read (owner/name)');
      await db.put(K.source(c.org.id, s.id), next);
      await recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action: 'metrics.source.updated', target: { type: 'metrics.source', id: s.id }, before: sourceView(s), after: sourceView(next) });
      return json({ source: sourceView(next) });
    });

    route('POST', '/api/metrics/sources/:id/token', async (c) => {
      await requireMetricsAdmin(c);
      const s = (await db.get(K.source(c.org.id, c.params.id))) || fail(404, 'Source not found');
      if (s.type !== 'api') fail(400, 'Only API sources have an ingestion token');
      const token = `rwm_${randomToken(24)}`;
      await db.patch(K.source(c.org.id, s.id), { tokenHash: await sha256(token) });
      await recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action: 'metrics.source.token_rotated', target: { type: 'metrics.source', id: s.id } });
      return json({ token, ingestUrl: `/api/metrics/ingest/${c.org.id}/${s.id}` });
    });

    route('DELETE', '/api/metrics/sources/:id', async (c) => {
      await requireMetricsAdmin(c);
      const s = (await db.get(K.source(c.org.id, c.params.id))) || fail(404, 'Source not found');
      // events already received stay: they are the history of the metrics
      await db.delete(K.source(c.org.id, s.id));
      await recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action: 'metrics.source.deleted', target: { type: 'metrics.source', id: s.id }, before: sourceView(s) });
      return json({ ok: true });
    });

    // ------------------------------------------------------------ ingestion
    // Idempotent: the event id comes from (source, type, external id).
    async function ingest(orgId, source, items, actorId) {
      const run = { id: newId(), sourceId: source.id, kind: 'ingest', startedAt: now(), received: 0, created: 0, updated: 0, duplicates: 0, late: 0, rejected: [] };
      const scopes = await scopesOf(orgId);
      for (const [i, raw] of (Array.isArray(items) ? items : []).slice(0, 1000).entries()) {
        run.received++;
        const e = cleanEvent(raw);
        const err = assertValidEvent(e);
        if (err) {
          if (run.rejected.length < 50) run.rejected.push({ index: i, externalId: e.externalId || null, error: err });
          continue;
        }
        if (source.repositories.length && e.repository && !source.repositories.includes(e.repository)) {
          if (run.rejected.length < 50) run.rejected.push({ index: i, externalId: e.externalId, error: `${e.repository} isn't one of this source's repositories` });
          continue;
        }
        const id = eventId(source.id, e.type, e.externalId);
        const prev = await db.get(K.event(orgId, id));
        const { receivedAt: _r, late: _l, ...prevData } = prev || {};
        const next = { id, sourceId: source.id, ...e };
        if (prev && JSON.stringify(prevData) === JSON.stringify(next)) {
          run.duplicates++;
          continue;
        }
        const late = (Date.now() - new Date(e.occurredAt)) / 864e5 > LATE_DAYS && !prev;
        if (late) run.late++;
        await db.put(K.event(orgId, id), { ...next, receivedAt: now(), late });
        prev ? run.updated++ : run.created++;
        if (e.gmudChangeId && e.gmudChangeId !== prev?.gmudChangeId) {
          await createLink(db, { orgId, sourceType: 'metrics.event', sourceId: id, targetType: 'gmud_change', targetId: e.gmudChangeId, createdBy: actorId, metadata: { from: 'ingestion' } });
        }
        // deployments and incidents feed the Team Timeline (never PR authors)
        if (!prev && e.type !== 'pull_request') {
          const team = scopes.find((s) => s.ownerType === 'team' && scopeCovers(s, e));
          await recordEvent(db, {
            orgId, actorId: null, teamId: team?.ownerId || null, entityType: `metrics.${e.type}`, entityId: id,
            eventType: e.type === 'deployment' ? `metrics.deployment.${e.status}` : 'metrics.incident.recorded',
            source: source.type, metadata: { repository: e.repository, service: e.service, environment: e.environment, title: e.title },
          });
        }
      }
      run.finishedAt = now();
      await db.put(K.run(orgId, run.id), run);
      return run;
    }

    async function prune(orgId) {
      const cutoff = day(-RAW_RETENTION_DAYS);
      for (const e of await db.list(K.events(orgId))) if ((e.occurredAt || '').slice(0, 10) < cutoff) await db.delete(K.event(orgId, e.id));
      const runs = (await db.list(K.runs(orgId))).sort((x, y) => y.startedAt.localeCompare(x.startedAt));
      for (const r of runs.slice(200)) await db.delete(K.run(orgId, r.id));
    }

    // Pipelines/CI/incident tools push events here with the source's token.
    route('POST', '/api/metrics/ingest/:orgId/:sourceId', async (c) => {
      const auth = c.req.headers.get('authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const source = await db.get(K.source(str(c.params.orgId, 60), str(c.params.sourceId, 60)));
      if (!token || !source?.tokenHash || (await sha256(token)) !== source.tokenHash) fail(401, 'Invalid ingestion token');
      const org = await getOrg(c.params.orgId);
      if (!org || org.modules?.metrics === false) fail(404, 'Engineering Metrics is turned off for this company');
      const run = await ingest(org.id, source, c.body.events, null);
      await db.patch(K.source(org.id, source.id), { status: 'ok', lastSyncAt: now(), lastError: run.rejected.length ? `${run.rejected.length} event(s) rejected` : null });
      return json({ run }, run.rejected.length && !run.created && !run.updated && !run.duplicates ? 400 : 200);
    }, { public: true });

    // Admins can also upload events (e.g. a CSV converted to JSON, incidents).
    route('POST', '/api/metrics/sources/:id/events', async (c) => {
      await requireMetricsAdmin(c);
      const s = (await db.get(K.source(c.org.id, c.params.id))) || fail(404, 'Source not found');
      if (s.type !== 'api') fail(400, 'GitHub sources are filled by syncing');
      const run = await ingest(c.org.id, s, c.body.events, c.user.id);
      await db.patch(K.source(c.org.id, s.id), { status: 'ok', lastSyncAt: now(), lastError: run.rejected.length ? `${run.rejected.length} event(s) rejected` : null });
      return json({ run });
    });

    // GitHub reconciliation: re-reads recently updated PRs and deployments.
    // Failures mark the source as failing (a gap), never as "no activity".
    route('POST', '/api/metrics/sources/:id/sync', async (c) => {
      await requireMetricsAdmin(c);
      const s = (await db.get(K.source(c.org.id, c.params.id))) || fail(404, 'Source not found');
      if (s.type !== 'github') fail(400, 'API sources receive events; there is nothing to sync');
      const integration = await integrationFor(c, 'github');
      if (!integration) fail(400, 'Connect your GitHub account first (My account → Integrations → GitHub)');
      const gh = githubClient(integration.token);
      const since = s.lastSyncAt ? new Date(new Date(s.lastSyncAt) - 3 * 864e5).toISOString() : null; // overlap for late updates
      const items = [];
      const errors = [];
      for (const repo of s.repositories) {
        try {
          items.push(...(await gh.pulls(repo, since)), ...(await gh.deployments(repo)));
        } catch (e) {
          errors.push(`${repo}: ${e.message}`);
        }
      }
      const run = await ingest(c.org.id, s, items, c.user.id);
      run.kind = 'sync';
      run.errors = errors;
      await db.put(K.run(c.org.id, run.id), run);
      const failed = errors.length === s.repositories.length;
      await db.patch(K.source(c.org.id, s.id), { status: errors.length ? 'error' : 'ok', lastSyncAt: failed ? s.lastSyncAt : now(), lastAttemptAt: now(), lastError: errors.join('; ') || null, connectedBy: c.user.id });
      await prune(c.org.id);
      return json({ run, source: sourceView(await db.get(K.source(c.org.id, s.id))) });
    });

    // ------------------------------------------------------------ quality
    route('GET', '/api/metrics/quality', async (c) => {
      await requireMetricsAdmin(c);
      const [sources, scopes, events, runs] = await Promise.all([db.list(K.sources(c.org.id)), scopesOf(c.org.id), db.list(K.events(c.org.id)), db.list(K.runs(c.org.id))]);
      const today = day();
      const active = scopes.filter((s) => !s.validTo || s.validTo >= today);
      const since = day(-30);
      const recent = events.filter((e) => (e.occurredAt || '').slice(0, 10) >= since);
      const seen = [...new Set(events.map((e) => e.repository || e.service).filter(Boolean))];
      const mappedNames = new Set(active.map((s) => s.name));
      const last30 = runs.filter((r) => r.startedAt.slice(0, 10) >= since);
      const sum = (k) => last30.reduce((n, r) => n + (r[k] || 0), 0);
      return json({
        sources: sources.map((s) => ({ id: s.id, name: s.name, type: s.type, status: s.status, lastSyncAt: s.lastSyncAt, lastAttemptAt: s.lastAttemptAt || null, lastError: s.lastError, stale: s.type === 'github' && (!s.lastSyncAt || s.lastSyncAt.slice(0, 10) < day(-2)) })),
        coverage: active.map((s) => ({
          name: s.name, kind: s.kind, ownerType: s.ownerType, ownerId: s.ownerId,
          hasSource: sources.some((x) => !x.repositories.length || x.repositories.includes(s.name)),
          eventsLast30Days: recent.filter((e) => e.repository === s.name || e.service === s.name).length,
          productionDeploymentsLast30Days: recent.filter((e) => (e.repository === s.name || e.service === s.name) && e.type === 'deployment' && isProduction(e.environment)).length,
        })),
        unmapped: seen.filter((n) => !mappedNames.has(n)),
        environments: [...new Set(events.map((e) => e.environment).filter(Boolean))],
        last30Days: { runs: last30.length, received: sum('received'), duplicates: sum('duplicates'), late: sum('late'), rejected: last30.reduce((n, r) => n + r.rejected.length, 0), failedSyncs: last30.filter((r) => (r.errors || []).length).length },
        retentionDays: RAW_RETENTION_DAYS,
      });
    });

    // ------------------------------------------------------------ scopes (repo/service ↔ team)
    // Associations are never rewritten: to re-map, end the current one and
    // create a new one. Past periods keep their attribution (spec §6, §12).
    route('GET', '/api/metrics/scopes', async (c) => {
      const a = await access(c);
      const scopes = (await scopesOf(c.org.id)).filter((s) => a.admin || a.canSee(s.ownerType, s.ownerId));
      return json({ scopes: scopes.sort((x, y) => x.name.localeCompare(y.name) || x.validFrom.localeCompare(y.validFrom)) });
    });

    route('POST', '/api/metrics/scopes', async (c) => {
      await requireMetricsAdmin(c);
      const s = cleanScope({ validFrom: day(), ...c.body });
      const err = assertValidScope(s);
      if (err) fail(400, err);
      await checkOwner(c, s.ownerType, s.ownerId);
      const overlap = (await scopesOf(c.org.id)).find((x) => x.kind === s.kind && x.name === s.name && x.ownerType === s.ownerType && x.ownerId === s.ownerId && (!x.validTo || x.validTo >= s.validFrom) && (!s.validTo || s.validTo >= x.validFrom));
      if (overlap) fail(409, 'This association already exists for that period');
      const scope = { id: newId(), ...s, createdBy: c.user.id, createdAt: now() };
      await db.put(K.scope(c.org.id, scope.id), scope);
      await recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action: 'metrics.scope.created', target: { type: 'metrics.scope', id: scope.id }, after: scope });
      return json({ scope }, 201);
    });

    route('POST', '/api/metrics/scopes/:id/end', async (c) => {
      await requireMetricsAdmin(c);
      const s = (await db.get(K.scope(c.org.id, c.params.id))) || fail(404, 'Association not found');
      const validTo = isDate(c.body.validTo) ? c.body.validTo : day(-1);
      if (validTo < s.validFrom) fail(400, 'The end is before the start');
      if (s.validTo && s.validTo < validTo) fail(400, 'This association already ended');
      await db.patch(K.scope(c.org.id, s.id), { validTo, endedBy: c.user.id, endedAt: now() });
      await recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action: 'metrics.scope.ended', target: { type: 'metrics.scope', id: s.id }, before: { validTo: s.validTo }, after: { validTo } });
      return json({ scope: await db.get(K.scope(c.org.id, s.id)) });
    });

    // Only a mistake can be removed: an association that attributed no event.
    route('DELETE', '/api/metrics/scopes/:id', async (c) => {
      await requireMetricsAdmin(c);
      const s = (await db.get(K.scope(c.org.id, c.params.id))) || fail(404, 'Association not found');
      if ((await db.list(K.events(c.org.id))).some((e) => scopeCovers(s, e))) fail(409, 'This association already attributed events. End it instead.');
      await db.delete(K.scope(c.org.id, s.id));
      await recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action: 'metrics.scope.deleted', target: { type: 'metrics.scope', id: s.id }, before: s });
      return json({ ok: true });
    });

    // ------------------------------------------------------------ definitions
    route('GET', '/api/metrics/definitions', async (c) => json({ definitions: Object.values(await definitions(c.org.id)) }));

    route('PATCH', '/api/metrics/definitions/:key', async (c) => {
      await requireMetricsAdmin(c);
      const key = METRIC_KEYS.includes(c.params.key) ? c.params.key : fail(404, 'Metric not found');
      const current = (await definitions(c.org.id))[key];
      const patch = cleanDefinitionPatch(key, c.body);
      const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(current[k]));
      if (!changed.length) return json({ definition: current });
      const reason = str(c.body.reason, 500) || fail(400, 'Explain why the definition changes');
      const { history, ...snapshot } = current;
      const next = { ...current, ...patch, version: current.version + 1, changedBy: c.user.id, changedAt: now(), reason, history: [...history, snapshot].slice(-50) };
      await db.put(K.definition(c.org.id, key), next);
      await recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action: 'metrics.definition.changed', target: { type: 'metrics.definition', id: key }, before: snapshot, after: { ...patch, version: next.version, reason } });
      return json({ definition: next });
    });

    // ------------------------------------------------------------ annotations
    async function requireScopeWrite(c, scopeType, scopeId) {
      const a = await access(c);
      if (scopeType === 'org' ? !a.admin : !(a.admin || (scopeType === 'team' ? a.teams.has(scopeId) : a.groups.has(scopeId)))) fail(403, "You can't add to this scope");
      if (scopeType !== 'org') await checkOwner(c, scopeType, scopeId);
    }

    route('GET', '/api/metrics/annotations', async (c) => {
      const a = await access(c);
      const list = (await db.list(K.annotations(c.org.id))).filter((x) => x.scopeType === 'org' || a.canSee(x.scopeType, x.scopeId));
      return json({ annotations: list.sort((x, y) => y.date.localeCompare(x.date)) });
    });

    route('POST', '/api/metrics/annotations', async (c) => {
      const x = cleanAnnotation(c.body);
      const err = assertValidAnnotation(x);
      if (err) fail(400, err);
      if (x.scopeType === 'org') x.scopeId = null;
      await requireScopeWrite(c, x.scopeType, x.scopeId);
      const ann = { id: newId(), ...x, createdBy: c.user.id, createdAt: now() };
      await db.put(K.annotation(c.org.id, ann.id), ann);
      return json({ annotation: ann }, 201);
    });

    route('DELETE', '/api/metrics/annotations/:id', async (c) => {
      const x = (await db.get(K.annotation(c.org.id, c.params.id))) || fail(404, 'Annotation not found');
      const a = await access(c);
      if (x.createdBy !== c.user.id && !a.admin) fail(403, 'Only who wrote it (or a metrics admin) can remove it');
      await db.delete(K.annotation(c.org.id, x.id));
      return json({ ok: true });
    });

    // ------------------------------------------------------------ goal links (metric ↔ KR)
    // The KR references the metric's definition and version; the series is
    // never copied into Goals.
    async function goalLinkView(c, g) {
      const defs = await definitions(c.org.id);
      const period = { from: day(-(g.windowDays - 1)), to: day() };
      const scopes = await scopesOf(c.org.id);
      const mine = g.scopeType === 'org' ? scopes : scopes.filter((s) => s.ownerType === g.scopeType && s.ownerId === g.scopeId);
      const events = (await db.list(K.events(c.org.id))).filter((e) => mine.some((s) => scopeCovers(s, e)));
      const m = computeMetric(g.metricKey, defs[g.metricKey], events, period);
      const span = g.target - g.baseline;
      const progress = m.value === null || !span ? null : Math.max(0, Math.min(100, Math.round((100 * (m.value - g.baseline)) / span)));
      return { ...g, current: { value: m.value, sample: m.sample, insufficient: m.insufficient, period, definitionVersion: defs[g.metricKey].version }, progress, definitionChanged: defs[g.metricKey].version !== g.definitionVersion };
    }

    route('GET', '/api/metrics/goal-links', async (c) => {
      const a = await access(c);
      const q = c.url.searchParams;
      const list = (await db.list(K.goalLinks(c.org.id))).filter(
        (g) => (g.scopeType === 'org' ? a.readAll : a.canSee(g.scopeType, g.scopeId)) && (!q.get('objectiveId') || g.objectiveId === q.get('objectiveId')),
      );
      return json({ goalLinks: await Promise.all(list.map((g) => goalLinkView(c, g))) });
    });

    route('POST', '/api/metrics/goal-links', async (c) => {
      const g = cleanGoalLink(c.body);
      const err = assertValidGoalLink(g);
      if (err) fail(400, err);
      if (g.scopeType === 'org') g.scopeId = null;
      await requireScopeWrite(c, g.scopeType, g.scopeId);
      const defs = await definitions(c.org.id);
      const item = { id: newId(), ...g, definitionVersion: defs[g.metricKey].version, createdBy: c.user.id, createdAt: now() };
      item.linkId = (await createLink(db, { orgId: c.org.id, sourceType: 'metrics.goal_link', sourceId: item.id, targetType: 'goal_objective', targetId: g.objectiveId, relationshipType: 'measures', createdBy: c.user.id, metadata: { keyResultId: g.keyResultId, metricKey: g.metricKey } })).id;
      await db.put(K.goalLink(c.org.id, item.id), item);
      await recordEvent(db, { orgId: c.org.id, actorId: c.user.id, teamId: g.scopeType === 'team' ? g.scopeId : null, entityType: 'metrics.goal_link', entityId: item.id, eventType: 'metrics.goal_link.created', metadata: { metricKey: g.metricKey, objectiveId: g.objectiveId, keyResultId: g.keyResultId } });
      return json({ goalLink: await goalLinkView(c, item) }, 201);
    });

    route('DELETE', '/api/metrics/goal-links/:id', async (c) => {
      const g = (await db.get(K.goalLink(c.org.id, c.params.id))) || fail(404, 'Link not found');
      await requireScopeWrite(c, g.scopeType, g.scopeId);
      await db.delete(K.goalLink(c.org.id, g.id));
      if (g.linkId) await deleteLink(db, { orgId: c.org.id, id: g.linkId });
      return json({ ok: true });
    });

    // ------------------------------------------------------------ experiments
    const canSeeExp = (a, x) => a.canSee('team', x.teamId);

    route('GET', '/api/metrics/experiments', async (c) => {
      const a = await access(c);
      const teamId = c.url.searchParams.get('teamId');
      const list = (await db.list(K.experiments(c.org.id))).filter((x) => canSeeExp(a, x) && (!teamId || x.teamId === teamId));
      return json({ experiments: list.sort((x, y) => (y.startDate || y.createdAt).localeCompare(x.startDate || x.createdAt)) });
    });

    async function checkExperimentOwner(c, x) {
      const users = await listUsers(c.org.id);
      if (!users.some((u) => u.id === x.ownerId)) fail(400, "The owner isn't a member of the company");
    }

    route('POST', '/api/metrics/experiments', async (c) => {
      const x = cleanExperiment({ ownerId: c.user.id, ...c.body });
      const err = assertValidExperiment(x);
      if (err) fail(400, err);
      await requireScopeWrite(c, 'team', x.teamId);
      await checkExperimentOwner(c, x);
      const item = { id: newId(), ...x, createdBy: c.user.id, createdAt: now(), updatedAt: now() };
      await db.put(K.experiment(c.org.id, item.id), item);
      await recordEvent(db, { orgId: c.org.id, actorId: c.user.id, teamId: x.teamId, entityType: 'metrics.experiment', entityId: item.id, eventType: 'metrics.experiment.created', metadata: { title: x.title } });
      return json({ experiment: item }, 201);
    });

    route('PATCH', '/api/metrics/experiments/:id', async (c) => {
      const prev = (await db.get(K.experiment(c.org.id, c.params.id))) || fail(404, 'Experiment not found');
      const a = await access(c);
      if (!canSeeExp(a, prev)) fail(404, 'Experiment not found');
      await requireScopeWrite(c, 'team', prev.teamId);
      const x = cleanExperiment({ ...c.body, teamId: prev.teamId }, prev);
      const err = assertValidExperiment(x);
      if (err) fail(400, err);
      await checkExperimentOwner(c, x);
      const item = { ...prev, ...x, updatedAt: now() };
      await db.put(K.experiment(c.org.id, item.id), item);
      if (x.status !== prev.status) await recordEvent(db, { orgId: c.org.id, actorId: c.user.id, teamId: x.teamId, entityType: 'metrics.experiment', entityId: item.id, eventType: `metrics.experiment.${x.status}`, metadata: { title: x.title } });
      return json({ experiment: item });
    });

    route('DELETE', '/api/metrics/experiments/:id', async (c) => {
      const prev = (await db.get(K.experiment(c.org.id, c.params.id))) || fail(404, 'Experiment not found');
      await requireScopeWrite(c, 'team', prev.teamId);
      await db.delete(K.experiment(c.org.id, prev.id));
      return json({ ok: true });
    });

    // ------------------------------------------------------------ dashboard hooks
    return {
      dashboard: async (c) => {
        const a = await access(c);
        const scopes = await scopesOf(c.org.id);
        const today = day();
        const myTeams = [...new Set(scopes.filter((s) => s.ownerType === 'team' && a.teams.has(s.ownerId) && (!s.validTo || s.validTo >= today)).map((s) => s.ownerId))];
        const running = (await db.list(K.experiments(c.org.id))).filter((x) => x.status === 'running' && canSeeExp(a, x)).length;
        return { teamsWithMetrics: myTeams, runningExperiments: running };
      },
      adminDashboard: async (c) => {
        const [sources, scopes] = await Promise.all([db.list(K.sources(c.org.id)), scopesOf(c.org.id)]);
        return {
          onboarding: { metricsSource: sources.length > 0, metricsScope: scopes.length > 0 },
          failingSources: sources.filter((s) => s.status === 'error').map(({ id, name, lastError }) => ({ id, name, lastError })),
        };
      },
      // history stays attributed to the team it happened in: merging moves
      // only associations that are still active
      onTeamMerge: async (orgId, fromId, intoId) => {
        const today = day();
        for (const s of await db.list(K.scopes(orgId))) {
          if (s.ownerType !== 'team' || s.ownerId !== fromId || (s.validTo && s.validTo < today)) continue;
          await db.patch(K.scope(orgId, s.id), { validTo: day(-1) < s.validFrom ? s.validFrom : day(-1) });
          const id = newId();
          await db.put(K.scope(orgId, id), { ...s, id, ownerId: intoId, validFrom: today, validTo: s.validTo, createdAt: now(), createdBy: null, mergedFrom: s.id });
        }
        for (const x of await db.list(K.experiments(orgId))) if (x.teamId === fromId) await db.patch(K.experiment(orgId, x.id), { teamId: intoId });
      },
      beforeTeamDelete: async (c, teamId) => {
        const n = (await db.list(K.scopes(c.org.id))).filter((s) => s.ownerType === 'team' && s.ownerId === teamId).length;
        if (n) fail(409, `This team owns ${n} repository/service association(s) in Engineering Metrics. End them or merge the team instead.`);
      },
    };
  },
});
