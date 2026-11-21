import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, signupCompany } from '@rewind/core/testing';
import foundation from '@rewind/foundation/server';
import goals from '../server/index.js';
import { progressOf, objectiveProgress, checkInDue } from '../server/model.js';

const setup = () => setupApp({ modules: [foundation, goals] });

async function boot() {
  const ctx = setup();
  const { admin, bia, me } = await signupCompany(ctx.call);
  const biaMe = (await ctx.call('GET', '/api/me', null, bia)).data;
  const cycle = (await ctx.call('POST', '/api/goals/cycles', { name: 'Q1', kind: 'quarter', startDate: '2026-01-01', endDate: '2026-03-31' }, admin)).data.cycle;
  return { ...ctx, admin, bia, me, biaId: biaMe.user.id, teamId: me.org.defaultTeamId, cycle };
}

test('progress math: increase, decrease, range, milestones and incompatible parameters', () => {
  assert.equal(progressOf({ type: 'number', direction: 'increase', baseline: 10, target: 20, current: 15 }).ratio, 0.5);
  assert.equal(progressOf({ type: 'number', direction: 'decrease', baseline: 100, target: 50, current: 75 }).ratio, 0.5);
  // real value is kept; only the bar is clamped
  const over = progressOf({ type: 'number', direction: 'increase', baseline: 0, target: 10, current: 15 });
  assert.equal(over.ratio, 1.5);
  assert.equal(over.bar, 1);
  const under = progressOf({ type: 'number', direction: 'increase', baseline: 10, target: 20, current: 5 });
  assert.equal(under.ratio, -0.5);
  assert.equal(under.bar, 0);
  // not computable
  assert.equal(progressOf({ type: 'number', direction: 'increase', baseline: 10, target: 10, current: 10 }).ratio, null);
  assert.equal(progressOf({ type: 'number', direction: 'increase', baseline: null, target: 10, current: 3 }).ratio, null);
  // explicit rules
  assert.equal(progressOf({ type: 'number', direction: 'maintain', rangeMin: 1, rangeMax: 3, current: 2 }).ratio, 1);
  assert.equal(progressOf({ type: 'number', direction: 'maintain', rangeMin: 1, rangeMax: 3, current: 4 }).ratio, 0);
  assert.equal(progressOf({ type: 'milestone', milestones: [{ done: true }, { done: false }] }).ratio, 0.5);
  assert.equal(objectiveProgress([{ type: 'number', direction: 'increase', baseline: 0, target: 10, current: 5 }, { type: 'number', direction: 'increase', baseline: 1, target: 1, current: 1 }]).computed, 1);
  assert.equal(checkInDue({ frequency: 'weekly', createdAt: '2026-01-01T00:00:00Z' }, '2026-01-05T00:00:00Z', '2026-01-10T00:00:00Z'), false);
  assert.equal(checkInDue({ frequency: 'weekly' }, '2026-01-01T00:00:00Z', '2026-01-10T00:00:00Z'), true);
});

test('cycles: only goal admins manage them; validation; delete only when empty', async () => {
  const { call, admin, bia, cycle } = await boot();
  assert.equal(cycle.status, 'draft');
  assert.equal((await call('POST', '/api/goals/cycles', { name: 'X', startDate: '2026-01-01', endDate: '2026-02-01' }, bia)).status, 403);
  assert.equal((await call('POST', '/api/goals/cycles', { name: 'Bad', startDate: '2026-03-01', endDate: '2026-01-01' }, admin)).status, 400);
  const pub = await call('PATCH', `/api/goals/cycles/${cycle.id}`, { status: 'published' }, admin);
  assert.equal(pub.data.cycle.status, 'published');
  await call('POST', '/api/goals/objectives', { title: 'Grow', cycleId: cycle.id }, admin);
  assert.equal((await call('DELETE', `/api/goals/cycles/${cycle.id}`, null, admin)).status, 409);
  assert.equal((await call('GET', '/api/goals/cycles', null, bia)).data.cycles.length, 1);
});

test('objectives for the organization, a group and a team; scope permissions', async () => {
  const { call, admin, bia, me, biaId, teamId, cycle } = await boot();
  // organization: admins only (or goals:write)
  const org = await call('POST', '/api/goals/objectives', { title: 'Be reliable', cycleId: cycle.id, scopeType: 'org' }, admin);
  assert.equal(org.status, 201);
  assert.equal(org.data.objective.ownerId, me.user.id);
  assert.equal((await call('POST', '/api/goals/objectives', { title: 'Nope', scopeType: 'org' }, bia)).status, 403);

  // team: members of the team can create
  const team = await call('POST', '/api/goals/objectives', { title: 'Faster deploys', scopeType: 'team', scopeId: teamId, parentId: org.data.objective.id }, bia);
  assert.equal(team.status, 201);
  assert.equal(team.data.objective.ownerId, biaId);

  // group: through a foundation membership
  const group = (await call('POST', '/api/foundation/groups', { name: 'Engineering' }, admin)).data.group;
  assert.equal((await call('POST', '/api/goals/objectives', { title: 'Platform', scopeType: 'group', scopeId: group.id }, bia)).status, 403);
  await call('POST', '/api/foundation/memberships', { userId: biaId, scopeType: 'group', scopeId: group.id, roleKey: 'team_member' }, admin);
  const g = await call('POST', '/api/goals/objectives', { title: 'Platform', scopeType: 'group', scopeId: group.id, parentId: org.data.objective.id }, bia);
  assert.equal(g.status, 201);

  // unknown scope / owner outside the directory / loops
  assert.equal((await call('POST', '/api/goals/objectives', { title: 'x', scopeType: 'team', scopeId: 'nope' }, admin)).status, 400);
  assert.equal((await call('POST', '/api/goals/objectives', { title: 'x', ownerId: 'ghost' }, admin)).status, 400);
  assert.equal((await call('PATCH', `/api/goals/objectives/${org.data.objective.id}`, { parentId: team.data.objective.id }, admin)).status, 400);

  // alignment is visible from the parent
  const detail = (await call('GET', `/api/goals/objectives/${org.data.objective.id}`, null, bia)).data;
  assert.equal(detail.children.length, 2);
  assert.equal(detail.canEdit, false);
  assert.equal((await call('PATCH', `/api/goals/objectives/${org.data.objective.id}`, { title: 'Hijack' }, bia)).status, 403);
});

test('owner and collaborators must have access to the scope; scope visibility hides objectives', async () => {
  const { call, admin, bia, biaId, teamId } = await boot();
  const other = (await call('POST', '/api/teams', { name: 'Other squad' }, admin)).data.team;
  // Bia isn't in "Other squad"
  assert.equal((await call('POST', '/api/goals/objectives', { title: 'x', scopeType: 'team', scopeId: other.id, ownerId: biaId }, admin)).status, 400);
  assert.equal((await call('POST', '/api/goals/objectives', { title: 'x', scopeType: 'team', scopeId: other.id, collaboratorIds: [biaId] }, admin)).status, 400);
  const secret = (await call('POST', '/api/goals/objectives', { title: 'Secret', scopeType: 'team', scopeId: other.id, visibility: 'scope' }, admin)).data.objective;
  const open = (await call('POST', '/api/goals/objectives', { title: 'Open', scopeType: 'team', scopeId: other.id }, admin)).data.objective;
  const list = (await call('GET', '/api/goals/objectives', null, bia)).data.objectives.map((o) => o.id);
  assert.ok(list.includes(open.id));
  assert.ok(!list.includes(secret.id));
  assert.equal((await call('GET', `/api/goals/objectives/${secret.id}`, null, bia)).status, 404);
  // a collaborator can edit
  const mine = (await call('POST', '/api/goals/objectives', { title: 'Shared', scopeType: 'team', scopeId: teamId, collaboratorIds: [biaId] }, admin)).data.objective;
  assert.equal((await call('PATCH', `/api/goals/objectives/${mine.id}`, { purpose: 'Why' }, bia)).status, 200);
});

test('key results: validation, target changes keep history and need a reason', async () => {
  const { call, admin } = await boot();
  const o = (await call('POST', '/api/goals/objectives', { title: 'Speed' }, admin)).data.objective;
  const url = `/api/goals/objectives/${o.id}/krs`;
  assert.equal((await call('POST', url, { description: 'Lead time', direction: 'increase', baseline: 10, target: 5 }, admin)).status, 400);
  assert.equal((await call('POST', url, { description: 'No params' }, admin)).status, 400);
  assert.equal((await call('POST', url, { description: 'Range', direction: 'maintain' }, admin)).status, 400);
  assert.equal((await call('POST', url, { description: 'Milestones', type: 'milestone' }, admin)).status, 400);
  const kr = (await call('POST', url, { description: 'Lead time (h)', unit: 'h', type: 'duration', direction: 'decrease', baseline: 48, target: 24 }, admin)).data.keyResult;
  assert.equal(kr.current, 48);
  assert.equal(kr.progress.ratio, 0);

  assert.equal((await call('PATCH', `${url}/${kr.id}`, { target: 12 }, admin)).status, 400);
  const changed = (await call('PATCH', `${url}/${kr.id}`, { target: 12, reason: 'Team got faster than expected', current: 1 }, admin)).data.keyResult;
  assert.equal(changed.target, 12);
  assert.equal(changed.current, 48); // current only moves through check-ins
  assert.equal(changed.targetHistory.length, 1);
  assert.deepEqual(changed.targetHistory[0].before, { target: 24 });
  assert.equal(changed.targetHistory[0].reason, 'Team got faster than expected');
  const events = (await call('GET', `/api/goals/objectives/${o.id}/history`, null, admin)).data.events.map((e) => e.eventType);
  assert.ok(events.includes('goal.kr.target_changed'));
});

test('check-ins are immutable, keep authorship and evidence, and move the KR', async () => {
  const { call, admin, bia, biaId, teamId } = await boot();
  const o = (await call('POST', '/api/goals/objectives', { title: 'Quality', scopeType: 'team', scopeId: teamId, status: 'active' }, admin)).data.objective;
  assert.equal(o.status, 'draft'); // created as draft, published explicitly
  await call('PATCH', `/api/goals/objectives/${o.id}`, { status: 'active' }, admin);
  const kr = (await call('POST', `/api/goals/objectives/${o.id}/krs`, { description: 'Coverage', type: 'percent', baseline: 40, target: 80, ownerId: biaId }, admin)).data.keyResult;
  const ci = `/api/goals/objectives/${o.id}/krs/${kr.id}/checkins`;
  assert.equal((await call('POST', ci, { value: 50 }, bia)).status, 400); // needs evidence
  const r = await call('POST', ci, { value: 60, status: 'on_track', evidence: 'CI report', evidenceLinks: ['https://ci.example/1', 'javascript:alert(1)'], confidence: 7 }, bia);
  assert.equal(r.status, 201);
  assert.equal(r.data.checkIn.authorId, biaId);
  assert.ok(r.data.checkIn.createdAt);
  assert.deepEqual(r.data.checkIn.evidenceLinks, ['https://ci.example/1']);
  assert.equal(r.data.keyResult.current, 60);
  assert.equal(r.data.keyResult.progress.ratio, 0.5);
  // no edit/delete of check-ins
  assert.equal((await call('PATCH', `${ci}/${r.data.checkIn.id}`, { value: 1 }, admin)).status, 404);
  assert.equal((await call('DELETE', `${ci}/${r.data.checkIn.id}`, null, admin)).status, 404);
  // the objective can't be deleted any more (history)
  assert.equal((await call('DELETE', `/api/goals/objectives/${o.id}`, null, admin)).status, 409);
  const events = (await call('GET', `/api/goals/objectives/${o.id}/history`, null, admin)).data.events.map((e) => e.eventType);
  assert.ok(events.includes('goal.objective.published'));
  assert.ok(events.includes('goal.checkin.created'));
});

test('initiatives: done initiative does not mean the KR is achieved', async () => {
  const { call, admin } = await boot();
  const o = (await call('POST', '/api/goals/objectives', { title: 'Adoption' }, admin)).data.objective;
  const kr = (await call('POST', `/api/goals/objectives/${o.id}/krs`, { description: 'Active users', type: 'count', baseline: 100, target: 200 }, admin)).data.keyResult;
  const i = (await call('POST', `/api/goals/objectives/${o.id}/initiatives`, { title: 'Onboarding revamp', krId: kr.id, expectedImpact: '+50 users' }, admin)).data.initiative;
  assert.equal(i.status, 'planned');
  const done = await call('PATCH', `/api/goals/objectives/${o.id}/initiatives/${i.id}`, { status: 'done' }, admin);
  assert.equal(done.data.initiative.status, 'done');
  const detail = (await call('GET', `/api/goals/objectives/${o.id}`, null, admin)).data;
  assert.equal(detail.keyResults[0].progress.ratio, 0);
  assert.equal(detail.objective.status, 'draft');
  assert.equal((await call('POST', `/api/goals/objectives/${o.id}/initiatives`, { title: 'x', krId: 'nope' }, admin)).status, 404);
});

test('links to retros, GMUDs and external items live in the foundation; internal ones copy no title', async () => {
  const { call, admin } = await boot();
  const o = (await call('POST', '/api/goals/objectives', { title: 'Fewer incidents', derivedFrom: { type: 'retro_board', id: 'board-1' } }, admin)).data.objective;
  const url = `/api/goals/objectives/${o.id}/links`;
  assert.equal((await call('POST', url, { targetType: 'gmud_change' }, admin)).status, 400);
  assert.equal((await call('POST', url, { targetType: 'pr', url: 'not a url' }, admin)).status, 400);
  const gmud = (await call('POST', url, { targetType: 'gmud_change', targetId: 'chg-1', label: 'leaked title', relationshipType: 'implements' }, admin)).data.link;
  assert.equal(gmud.metadata.label, '');
  await call('POST', url, { targetType: 'pr', url: 'https://github.com/acme/app/pull/1', label: 'PR #1' }, admin);
  let detail = (await call('GET', `/api/goals/objectives/${o.id}`, null, admin)).data;
  assert.equal(detail.links.length, 3);
  assert.ok(detail.links.some((l) => l.relationshipType === 'derived_from' && l.targetId === 'board-1'));
  assert.equal((await call('DELETE', `${url}/${gmud.id}`, null, admin)).status, 200);
  detail = (await call('GET', `/api/goals/objectives/${o.id}`, null, admin)).data;
  assert.equal(detail.links.length, 2);
  // visible in the foundation's entity links too
  assert.equal((await call('GET', '/api/foundation/links', null, admin)).data.links.length, 2);
});

test('cycle review: final status, learnings and carry-over into the next cycle', async () => {
  const { call, admin, cycle } = await boot();
  const next = (await call('POST', '/api/goals/cycles', { name: 'Q2', startDate: '2026-04-01', endDate: '2026-06-30' }, admin)).data.cycle;
  const a = (await call('POST', '/api/goals/objectives', { title: 'A', cycleId: cycle.id }, admin)).data.objective;
  const b = (await call('POST', '/api/goals/objectives', { title: 'B', cycleId: cycle.id }, admin)).data.objective;
  await call('PATCH', `/api/goals/objectives/${b.id}`, { status: 'active' }, admin);
  const krB = (await call('POST', `/api/goals/objectives/${b.id}/krs`, { description: 'NPS', baseline: 10, target: 40 }, admin)).data.keyResult;
  await call('POST', `/api/goals/objectives/${b.id}/krs/${krB.id}/checkins`, { value: 25, evidence: 'survey' }, admin);
  assert.equal((await call('POST', `/api/goals/cycles/${cycle.id}/close`, { outcomes: [{ objectiveId: b.id, destination: 'carry_over' }] }, admin)).status, 400);
  const r = await call('POST', `/api/goals/cycles/${cycle.id}/close`, {
    summary: 'Good quarter', learnings: 'Smaller KRs',
    nextCycleId: next.id,
    outcomes: [
      { objectiveId: a.id, status: 'achieved', result: 'Done', learnings: 'Keep it' },
      { objectiveId: b.id, status: 'partially_achieved', destination: 'carry_over' },
    ],
  }, admin);
  assert.equal(r.status, 200);
  assert.equal(r.data.cycle.status, 'archived');
  assert.equal(r.data.carried.length, 1);
  const closedA = (await call('GET', `/api/goals/objectives/${a.id}`, null, admin)).data.objective;
  assert.equal(closedA.status, 'achieved');
  assert.equal(closedA.outcome.learnings, 'Keep it');
  const copy = (await call('GET', `/api/goals/objectives/${r.data.carried[0]}`, null, admin)).data;
  assert.equal(copy.objective.cycleId, next.id);
  assert.equal(copy.objective.carriedFrom, b.id);
  assert.equal(copy.keyResults[0].baseline, 25);
  // closed cycle: no new objectives, no new check-ins on closed objectives
  assert.equal((await call('POST', '/api/goals/objectives', { title: 'Late', cycleId: cycle.id }, admin)).status, 400);
  assert.equal((await call('POST', `/api/goals/objectives/${b.id}/krs/${krB.id}/checkins`, { value: 30, evidence: 'x' }, admin)).status, 409);
  // check-ins survive
  const old = (await call('GET', `/api/goals/objectives/${b.id}`, null, admin)).data;
  assert.equal(old.keyResults[0].checkIns.length, 1);
});

test('membership changes keep objectives and check-ins; team deletion is blocked; merge moves them', async () => {
  const { call, admin, biaId, teamId } = await boot();
  const squad = (await call('POST', '/api/teams', { name: 'Squad' }, admin)).data.team;
  const o = (await call('POST', '/api/goals/objectives', { title: 'Squad goal', scopeType: 'team', scopeId: squad.id }, admin)).data.objective;
  assert.equal((await call('DELETE', `/api/teams/${squad.id}`, null, admin)).status, 409);
  // a membership ending doesn't touch the objective
  const m = (await call('POST', '/api/foundation/memberships', { userId: biaId, scopeType: 'team', scopeId: teamId, roleKey: 'team_member' }, admin)).data.membership;
  await call('DELETE', `/api/foundation/memberships/${m.id}`, null, admin);
  assert.equal((await call('GET', `/api/goals/objectives/${o.id}`, null, admin)).data.objective.title, 'Squad goal');
  await call('POST', `/api/teams/${squad.id}/merge`, { into: teamId }, admin);
  assert.equal((await call('GET', `/api/goals/objectives/${o.id}`, null, admin)).data.objective.scopeId, teamId);
});

test('reminders: due check-ins and deadlines for owners; preference can turn them off', async () => {
  const { call, admin, bia, biaId, teamId } = await boot();
  const soon = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const o = (await call('POST', '/api/goals/objectives', { title: 'Ship', scopeType: 'team', scopeId: teamId, ownerId: biaId, dueDate: soon }, admin)).data.objective;
  await call('PATCH', `/api/goals/objectives/${o.id}`, { status: 'active' }, admin);
  await call('POST', `/api/goals/objectives/${o.id}/krs`, { description: 'Users', baseline: 0, target: 10, ownerId: biaId }, admin);
  let rem = (await call('GET', '/api/goals/reminders', null, bia)).data.reminders;
  assert.ok(rem.some((r) => r.kind === 'deadline'));
  assert.equal((await call('GET', '/api/goals/reminders', null, admin)).data.reminders.length, 0);
  const dash = (await call('GET', '/api/dashboard', null, bia)).data.goals;
  assert.equal(dash.mine, 1);
  await call('PUT', '/api/foundation/notifications/prefs', { prefs: [{ module: 'goals', eventType: 'goals.reminder', channel: 'in_app', enabled: false }] }, bia);
  rem = (await call('GET', '/api/goals/reminders', null, bia)).data.reminders;
  assert.equal(rem.length, 0);
});

test('RBAC: goals permissions show in the catalog and grant export / write through roles', async () => {
  const { call, admin, bia, biaId, me } = await boot();
  const catalog = (await call('GET', '/api/foundation/catalog', null, admin)).data;
  assert.ok(catalog.permissions.some((p) => p.key === 'goals:export'));
  assert.equal((await call('GET', '/api/goals/export', null, bia)).status, 403);
  await call('POST', '/api/foundation/roles', { key: 'goals_lead', name: 'Goals lead', scope: 'org', permissions: ['goals:write', 'goals:export'] }, admin);
  await call('POST', '/api/foundation/memberships', { userId: biaId, scopeType: 'org', scopeId: me.org.id, roleKey: 'goals_lead' }, admin);
  const exp = await call('GET', '/api/goals/export', null, bia);
  assert.equal(exp.status, 200);
  assert.ok(Array.isArray(exp.data.objectives));
  assert.equal((await call('POST', '/api/goals/objectives', { title: 'Company-wide', scopeType: 'org' }, bia)).status, 201);
  const audit = (await call('GET', '/api/foundation/audit', null, admin)).data.records.map((r) => r.action);
  assert.ok(audit.includes('goals.export'));
  assert.ok(audit.includes('goals.objective.create'));
});
