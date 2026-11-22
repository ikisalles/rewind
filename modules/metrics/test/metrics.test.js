import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, signupCompany } from '@rewind/core/testing';
import foundation from '@rewind/foundation/server';
import metrics from '../server/index.js';
import { computeMetric, definitionOf, trendAlert, scopeCovers } from '../server/model.js';

const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const at = (offsetDays, hour = 10) => `${day(offsetDays)}T${String(hour).padStart(2, '0')}:00:00.000Z`;

async function boot() {
  const ctx = setupApp({ modules: [foundation, metrics] });
  const { call } = ctx;
  const { admin, bia, me } = await signupCompany(call);
  const teamId = me.org.defaultTeamId;
  const other = (await call('POST', '/api/teams', { name: 'Payments' }, admin)).data.team;
  const inv = (await call('POST', '/api/invites', { email: 'caio@acme.io', teamId: other.id }, admin)).data;
  const caio = (await call('POST', `/api/invites/${inv.invites[0].token}/accept`, { name: 'Caio', password: '12345678' })).data.token;
  return { ...ctx, admin, bia, caio, me, teamId, otherTeamId: other.id, orgId: me.org.id };
}

async function apiSource(call, admin, name = 'CI') {
  const r = await call('POST', '/api/metrics/sources', { type: 'api', name }, admin);
  assert.equal(r.status, 201);
  return r.data;
}

const pr = (n, repo, openedDays, mergedDays, reviewDays = null) => ({
  type: 'pull_request', externalId: `${repo}#${n}`, repository: repo, number: n, title: `PR ${n}`, author: 'someone',
  openedAt: at(openedDays, 9), firstReviewAt: reviewDays === null ? null : at(reviewDays, 12), mergedAt: mergedDays === null ? null : at(mergedDays, 15),
});
const deploy = (id, repo, days, extra = {}) => ({ type: 'deployment', externalId: id, repository: repo, environment: 'production', deployedAt: at(days, 18), status: 'success', ...extra });

test('only metrics admins configure; ingestion is token-protected and idempotent; authors are dropped', async () => {
  const { call, admin, bia, orgId, teamId } = await boot();
  assert.equal((await call('POST', '/api/metrics/sources', { type: 'api' }, bia)).status, 403);
  // GitHub sources need the admin's own GitHub connection
  assert.equal((await call('POST', '/api/metrics/sources', { type: 'github', repositories: ['acme/api'] }, admin)).status, 400);
  const { source, token, ingestUrl } = await apiSource(call, admin);
  assert.ok(token.startsWith('rwm_'));
  assert.equal(source.tokenHash, undefined);
  assert.equal((await call('POST', '/api/metrics/scopes', { name: 'acme/api', ownerType: 'team', ownerId: teamId, validFrom: day(-60) }, admin)).status, 201);

  const events = [pr(1, 'acme/api', -10, -9, -9), deploy('d1', 'acme/api', -8, { prNumbers: [1], gmudChangeId: 'chg1' }), { type: 'deployment', externalId: 'bad' }];
  assert.equal((await call('POST', ingestUrl, { events }, 'wrong')).status, 401);
  const first = (await call('POST', ingestUrl, { events }, token)).data.run;
  assert.equal(first.created, 2);
  assert.equal(first.rejected.length, 1);
  assert.equal(first.late, 2);
  const again = (await call('POST', ingestUrl, { events }, token)).data.run;
  assert.equal(again.created, 0);
  assert.equal(again.duplicates, 2);

  const list = (await call('GET', `/api/metrics/events?scopeType=team&scopeId=${teamId}&from=${day(-30)}`, null, bia)).data.events;
  assert.equal(list.length, 2);
  assert.ok(list.every((e) => !('author' in e)));
  // the GMUD reference became an entity link; deployments feed the timeline
  const dep = list.find((e) => e.type === 'deployment');
  const detail = (await call('GET', `/api/metrics/events/${dep.id}`, null, bia)).data;
  assert.deepEqual(detail.links.map((l) => [l.targetType, l.targetId]), [['gmud_change', 'chg1']]);
  const timeline = (await call('GET', '/api/foundation/events', null, admin)).data.events.filter((e) => e.entityType === 'metrics.deployment');
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].teamId, teamId);
  const audit = (await call('GET', '/api/foundation/audit', null, admin)).data.records.map((x) => x.action);
  assert.ok(audit.includes('metrics.source.created') && audit.includes('metrics.scope.created'));
  void orgId;
});

test('repository mapping keeps history: re-mapping never moves past events', async () => {
  const { call, admin, bia, caio, teamId, otherTeamId } = await boot();
  const { ingestUrl, token } = await apiSource(call, admin);
  const scope = (await call('POST', '/api/metrics/scopes', { name: 'Acme/Web', ownerType: 'team', ownerId: teamId, validFrom: day(-90) }, admin)).data.scope;
  assert.equal(scope.name, 'acme/web');
  await call('POST', ingestUrl, { events: [pr(1, 'acme/web', -40, -39), pr(2, 'acme/web', -3, -2)] }, token);

  // hand the repository over to Payments from 10 days ago
  assert.equal((await call('POST', `/api/metrics/scopes/${scope.id}/end`, { validTo: day(-11) }, admin)).status, 200);
  assert.equal((await call('POST', '/api/metrics/scopes', { name: 'acme/web', ownerType: 'team', ownerId: otherTeamId, validFrom: day(-10) }, admin)).status, 201);
  // an association that already attributed events can't be deleted
  assert.equal((await call('DELETE', `/api/metrics/scopes/${scope.id}`, null, admin)).status, 409);

  const q = `from=${day(-60)}&to=${day()}`;
  const mine = (await call('GET', `/api/metrics/events?scopeType=team&scopeId=${teamId}&${q}`, null, bia)).data.events.map((e) => e.number);
  const theirs = (await call('GET', `/api/metrics/events?scopeType=team&scopeId=${otherTeamId}&${q}`, null, caio)).data.events.map((e) => e.number);
  assert.deepEqual(mine, [1]);
  assert.deepEqual(theirs, [2]);
  // other teams' drill-down isn't reachable
  assert.equal((await call('GET', `/api/metrics/events?scopeType=team&scopeId=${otherTeamId}&${q}`, null, bia)).status, 404);
  const pr2 = (await call('GET', `/api/metrics/events?scopeType=team&scopeId=${otherTeamId}&${q}`, null, caio)).data.events[0];
  assert.equal((await call('GET', `/api/metrics/events/${pr2.id}`, null, bia)).status, 404);
  // organization-wide view needs metrics:read
  assert.equal((await call('GET', '/api/metrics/dashboard?scopeType=org', null, bia)).status, 403);
  assert.equal((await call('GET', '/api/metrics/dashboard?scopeType=org', null, admin)).status, 200);
});

test('dashboard: definition, sample, coverage, source and gaps; no individual data', async () => {
  const { call, admin, bia, teamId } = await boot();
  const empty = (await call('GET', `/api/metrics/dashboard?scopeType=team&scopeId=${teamId}`, null, bia)).data;
  assert.ok(empty.metrics.every((m) => m.status === 'no_scope' && m.value === null));

  const { ingestUrl, token } = await apiSource(call, admin);
  await call('POST', '/api/metrics/scopes', { name: 'acme/api', ownerType: 'team', ownerId: teamId, validFrom: day(-120) }, admin);
  const prs = Array.from({ length: 6 }, (_, i) => pr(i + 1, 'acme/api', -20 + i, -19 + i, -20 + i));
  const deps = [deploy('a', 'acme/api', -15, { prNumbers: [1, 2] }), deploy('b', 'acme/api', -10, { prNumbers: [3] }), deploy('c', 'acme/api', -9, { status: 'rolled_back' }), deploy('s', 'acme/api', -9, { environment: 'staging' })];
  const inc = [{ type: 'incident', externalId: 'i1', repository: 'acme/api', startedAt: at(-10, 19), restoredAt: at(-10, 21), deploymentId: null }];
  await call('POST', ingestUrl, { events: [...prs, ...deps, ...inc] }, token);

  const d = (await call('GET', `/api/metrics/dashboard?scopeType=team&scopeId=${teamId}&from=${day(-27)}&to=${day()}`, null, bia)).data;
  const m = Object.fromEntries(d.metrics.map((x) => [x.key, x]));
  assert.equal(m.throughput.sample, 6);
  assert.equal(m.throughput.unit, 'merged pull requests / week');
  assert.equal(m.deployment_frequency.sample, 2); // staging and rolled back don't count
  assert.equal(m.change_failure_rate.sample, 3);
  assert.equal(m.change_failure_rate.value, null); // below the minimum sample (5)
  assert.equal(m.change_failure_rate.status, 'insufficient_sample');
  assert.equal(m.pr_cycle_time.value, 30); // 09:00 → 15:00 next day
  assert.equal(m.pr_cycle_time.breakdown.waitingForReview, 3);
  assert.equal(m.lead_time.sample, 3);
  for (const x of d.metrics) {
    assert.ok(x.definition.formula && x.definition.version === 1 && x.definition.sources.length && x.definition.window);
    assert.ok('lastUpdated' in x && 'previous' in x);
  }
  assert.equal(d.coverage.mapped, 1);
  assert.equal(d.coverage.healthy, 1);
  assert.equal(d.flow.find((f) => f.stage === 'merged').count, 6);
  assert.doesNotMatch(JSON.stringify(d), /someone|"author/);

});

test('failing ingestion is flagged on the dashboard and in data quality', async () => {
  const { call, admin, bia, teamId } = await boot();
  const realFetch = globalThis.fetch;
  // the admin connects GitHub; GitHub then answers with errors
  const integ = await call('PUT', '/api/me/integrations/github', { token: 'ghp_x' }, admin);
  assert.equal(integ.status, 200);
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const s = (await call('POST', '/api/metrics/sources', { type: 'github', repositories: ['acme/api'] }, admin)).data.source;
    await call('POST', '/api/metrics/scopes', { name: 'acme/api', ownerType: 'team', ownerId: teamId, validFrom: day(-30) }, admin);
    const run = (await call('POST', `/api/metrics/sources/${s.id}/sync`, null, admin)).data;
    assert.equal(run.source.status, 'error');
    assert.match(run.run.errors[0], /acme\/api/);
    const d = (await call('GET', `/api/metrics/dashboard?scopeType=team&scopeId=${teamId}`, null, bia)).data;
    assert.ok(d.coverage.gaps.length);
    assert.ok(d.metrics.every((m) => m.status === 'partial'));
    const q = (await call('GET', '/api/metrics/quality', null, admin)).data;
    assert.equal(q.sources[0].status, 'error');
    assert.equal(q.last30Days.failedSyncs, 1);
    assert.equal((await call('GET', '/api/metrics/quality', null, bia)).status, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GitHub sync normalizes PRs and deployments without authors', async () => {
  const { call, admin, bia, teamId } = await boot();
  const integ = await call('PUT', '/api/me/integrations/github', { token: 'ghp_x' }, admin);
  assert.equal(integ.status, 200);
  const realFetch = globalThis.fetch;
  const routes = {
    '/repos/acme/api/pulls': [{ number: 7, title: 'Add cache', html_url: 'https://github.com/acme/api/pull/7', created_at: at(-3, 9), merged_at: at(-2, 9), updated_at: at(-2, 9), user: { login: 'dev' } }],
    '/repos/acme/api/pulls/7/reviews': [{ submitted_at: at(-3, 11), user: { login: 'dev' } }, { submitted_at: at(-3, 13), user: { login: 'rev' } }],
    '/repos/acme/api/pulls/7/commits': [{ commit: { author: { date: at(-4, 9) } } }],
    '/repos/acme/api/deployments': [{ id: 99, environment: 'production', sha: 'abc', ref: 'main' }],
    '/repos/acme/api/deployments/99/statuses': [{ state: 'success', created_at: at(-1, 9) }],
    '/repos/acme/api/commits/abc/pulls': [{ number: 7 }],
  };
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    return path in routes ? new Response(JSON.stringify(routes[path]), { status: 200 }) : new Response('{}', { status: 404 });
  };
  try {
    const s = (await call('POST', '/api/metrics/sources', { type: 'github', repositories: ['acme/api'] }, admin)).data.source;
    await call('POST', '/api/metrics/scopes', { name: 'acme/api', ownerType: 'team', ownerId: teamId, validFrom: day(-30) }, admin);
    const r = (await call('POST', `/api/metrics/sources/${s.id}/sync`, null, admin)).data;
    assert.equal(r.source.status, 'ok');
    assert.equal(r.run.created, 2);
    const ev = (await call('GET', `/api/metrics/events?scopeType=team&scopeId=${teamId}`, null, bia)).data.events;
    const p = ev.find((e) => e.type === 'pull_request');
    assert.equal(p.firstReviewAt, at(-3, 13)); // the author's own review doesn't count
    assert.equal(p.firstCommitAt, at(-4, 9));
    assert.doesNotMatch(JSON.stringify(ev), /"dev"|"rev"/);
    assert.deepEqual(ev.find((e) => e.type === 'deployment').prNumbers, [7]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('definitions are versioned with a reason; KR links reference the version; team comparison needs equivalence', async () => {
  const { call, admin, bia, teamId, otherTeamId } = await boot();
  assert.equal((await call('PATCH', '/api/metrics/definitions/lead_time', { leadTimeStart: 'first_commit' }, bia)).status, 403);
  assert.equal((await call('PATCH', '/api/metrics/definitions/lead_time', { leadTimeStart: 'first_commit' }, admin)).status, 400);
  const def = (await call('PATCH', '/api/metrics/definitions/lead_time', { leadTimeStart: 'first_commit', reason: 'Agreed with leads' }, admin)).data.definition;
  assert.equal(def.version, 2);
  assert.equal(def.history[0].leadTimeStart, 'pr_opened');

  const link = await call('POST', '/api/metrics/goal-links', { metricKey: 'lead_time', scopeType: 'team', scopeId: teamId, objectiveId: 'obj1', keyResultId: 'kr1', baseline: 48, target: 24 }, bia);
  assert.equal(link.status, 201);
  assert.equal(link.data.goalLink.definitionVersion, 2);
  assert.equal(link.data.goalLink.current.value, null);
  assert.equal((await call('POST', '/api/metrics/goal-links', { metricKey: 'lead_time', scopeType: 'team', scopeId: otherTeamId, objectiveId: 'o', keyResultId: 'k', baseline: 1, target: 2 }, bia)).status, 403);
  const links = (await call('GET', '/api/foundation/links', null, admin)).data;
  assert.ok(JSON.stringify(links).includes('metrics.goal_link'));

  assert.equal((await call('GET', `/api/metrics/compare?metric=throughput&teamIds=${teamId},${otherTeamId}`, null, bia)).status, 403);
  const cmp = (await call('GET', `/api/metrics/compare?metric=throughput&teamIds=${teamId},${otherTeamId}`, null, admin)).data;
  assert.equal(cmp.comparable, false);
  assert.ok(cmp.reasons.length);
  assert.ok(cmp.teams.every((t) => t.value === null));
});

test('experiments, annotations and CSV export stay inside the team', async () => {
  const { call, app, admin, bia, caio, teamId, otherTeamId } = await boot();
  const meBia = (await call('GET', '/api/me', null, bia)).data.user.id;
  assert.equal((await call('POST', '/api/metrics/experiments', { title: 'WIP limit', hypothesis: 'Less WIP, faster reviews', teamId, metricKeys: ['pr_cycle_time'] }, bia)).status, 201);
  assert.equal((await call('POST', '/api/metrics/experiments', { title: 'x', hypothesis: 'y', teamId: otherTeamId }, bia)).status, 403);
  const x = (await call('GET', '/api/metrics/experiments', null, bia)).data.experiments[0];
  assert.equal(x.ownerId, meBia);
  assert.equal((await call('PATCH', `/api/metrics/experiments/${x.id}`, { status: 'concluded' }, bia)).status, 400);
  assert.equal((await call('PATCH', `/api/metrics/experiments/${x.id}`, { status: 'concluded', observedResult: 'Cycle time fell; other changes happened too' }, bia)).status, 200);
  assert.equal((await call('GET', '/api/metrics/experiments', null, caio)).data.experiments.length, 0);

  assert.equal((await call('POST', '/api/metrics/annotations', { date: day(-5), title: 'Holiday week', scopeType: 'team', scopeId: teamId }, bia)).status, 201);
  assert.equal((await call('POST', '/api/metrics/annotations', { date: day(-5), title: 'x', scopeType: 'org' }, bia)).status, 403);
  const d = (await call('GET', `/api/metrics/dashboard?scopeType=team&scopeId=${teamId}`, null, bia)).data;
  assert.equal(d.annotations.length, 1);

  const { ingestUrl, token } = await apiSource(call, admin);
  await call('POST', '/api/metrics/scopes', { name: 'acme/api', ownerType: 'team', ownerId: teamId, validFrom: day(-30) }, admin);
  await call('POST', ingestUrl, { events: [{ ...pr(1, 'acme/api', -3, -2), title: '=HYPERLINK("x")' }] }, token);
  const res = await app.fetch(new Request(`https://rewind.test/api/metrics/export?kind=events&scopeType=team&scopeId=${teamId}`, { headers: { authorization: `Bearer ${bia}` } }));
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  const text = await res.text();
  assert.match(text, /'=HYPERLINK/);
  const agg = await (await app.fetch(new Request(`https://rewind.test/api/metrics/export?scopeType=team&scopeId=${teamId}`, { headers: { authorization: `Bearer ${bia}` } }))).text();
  assert.match(agg.split('\n')[0], /^metric,definition_version,unit/);
  // a team with associations can't be deleted
  await call('POST', '/api/metrics/scopes', { name: 'acme/pay', ownerType: 'team', ownerId: otherTeamId }, admin);
  assert.equal((await call('DELETE', `/api/teams/${otherTeamId}`, null, admin)).status, 409);
});

test('model: scope validity, sustained trend, empty sample', () => {
  const s = { kind: 'repository', name: 'a/b', validFrom: '2026-01-01', validTo: '2026-01-31', environments: [] };
  assert.equal(scopeCovers(s, { repository: 'a/b', occurredAt: '2026-01-15T00:00:00Z' }), true);
  assert.equal(scopeCovers(s, { repository: 'a/b', occurredAt: '2026-02-01T00:00:00Z' }), false);
  const def = definitionOf('throughput');
  const empty = computeMetric('throughput', def, [], { from: '2026-01-05', to: '2026-02-01' });
  assert.equal(empty.value, null);
  assert.equal(empty.insufficient, true);
  const series = [2, 2, 2, 2, 5, 5, 5].map((value, i) => ({ week: String(i), value }));
  const alert = trendAlert({ key: 'throughput', insufficient: false, series }, def);
  assert.equal(alert.direction, 'up');
  assert.equal(alert.better, true);
});
