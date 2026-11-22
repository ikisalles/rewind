import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, signupCompany } from '@rewind/core/testing';
import retro from '@rewind/retro/server';
import issues from '../server/index.js';
import { jqlFor, fromJira } from '../server/model.js';

async function boot() {
  const ctx = setupApp({ modules: [retro, issues] });
  const { call } = ctx;
  const { admin, bia, me } = await signupCompany(call);
  const teamId = me.org.defaultTeamId;
  const other = (await call('POST', '/api/teams', { name: 'Other' }, admin)).data.team;
  const inv = (await call('POST', '/api/invites', { email: 'caio@acme.io', teamId: other.id }, admin)).data;
  const caio = (await call('POST', `/api/invites/${inv.invites[0].token}/accept`, { name: 'Caio', password: '12345678' })).data.token;
  const biaId = (await call('GET', '/api/me', null, bia)).data.user.id;
  const board = (await call('POST', '/api/boards', { name: 'Squad', teamId }, bia)).data.board;
  return { ...ctx, admin, bia, caio, biaId, me, teamId, board };
}

test('the module starts off and only answers when the company turns it on', async () => {
  const { call, admin, bia, board } = await boot();
  assert.equal((await call('GET', `/api/issues/boards/${board.id}`, null, bia)).status, 404);
  assert.equal((await call('PATCH', '/api/org/modules/issues', { enabled: true }, admin)).status, 200);
  assert.equal((await call('GET', `/api/issues/boards/${board.id}`, null, bia)).status, 200);
});

test('manual issues live inside the board, with Jira default fields; only the team sees them', async () => {
  const { call, admin, bia, caio, biaId, board } = await boot();
  await call('PATCH', '/api/org/modules/issues', { enabled: true }, admin);
  const base = `/api/issues/boards/${board.id}`;
  assert.equal((await call('POST', `${base}/issues`, { summary: '' }, bia)).status, 400);
  const epic = (await call('POST', `${base}/issues`, { summary: 'Checkout v2', issueType: 'epic' }, bia)).data.issue;
  assert.equal(epic.key, 'ISS-1');
  assert.equal(epic.reporterId, biaId);
  const story = await call('POST', `${base}/issues`, { summary: 'Pay with Pix', issueType: 'story', priority: 'high', assigneeId: biaId, labels: 'payments, pix', storyPoints: '3', dueDate: '2026-12-01', parentId: epic.id, description: 'As a buyer…' }, bia);
  assert.equal(story.status, 201);
  assert.deepEqual(story.data.issue.labels, ['payments', 'pix']);
  assert.equal(story.data.issue.storyPoints, 3);
  // people and sprints must belong to the board
  const me = (await call('GET', '/api/me', null, caio)).data.user.id;
  assert.equal((await call('POST', `${base}/issues`, { summary: 'x', assigneeId: me }, bia)).status, 400);
  assert.equal((await call('POST', `${base}/issues`, { summary: 'x', sprintId: 'nope' }, bia)).status, 400);
  // another team doesn't see the board's backlog
  assert.equal((await call('GET', base, null, caio)).status, 403);
  const list = (await call('GET', base, null, bia)).data;
  assert.equal(list.issues.length, 2);
  assert.equal(list.settings.source, 'manual');

  const edited = await call('PATCH', `${base}/issues/${story.data.issue.id}`, { status: 'in_progress' }, bia);
  assert.equal(edited.data.issue.status, 'in_progress');
  assert.equal(edited.data.issue.summary, 'Pay with Pix');
  // deleting the board takes its issues with it
  assert.equal((await call('DELETE', `/api/boards/${board.id}`, null, bia)).status, 200);
  assert.equal((await call('GET', base, null, bia)).status, 404);
});

test('Jira source: board settings choose the Team; sync reads, updates and drops issues', async () => {
  const { call, admin, bia, caio, board } = await boot();
  await call('PATCH', '/api/org/modules/issues', { enabled: true }, admin);
  const base = `/api/issues/boards/${board.id}`;
  assert.equal((await call('PATCH', `${base}/settings`, { source: 'jira' }, bia)).status, 400);
  assert.equal((await call('PATCH', `${base}/settings`, { source: 'jira', jiraTeam: 'Payments' }, caio)).status, 403);
  const s = (await call('PATCH', `${base}/settings`, { source: 'jira', jiraTeam: 'Payments', jiraProject: 'pay' }, bia)).data.settings;
  assert.equal(s.jiraProject, 'PAY');
  assert.equal((await call('POST', `${base}/sync`, null, bia)).status, 400); // no Jira account yet
  assert.equal((await call('PUT', '/api/me/integrations/jira', { site: 'acme.atlassian.net', email: 'bia@acme.io', token: 'jt' }, bia)).status, 200);

  let page = [
    { id: '10', key: 'PAY-1', fields: { summary: 'Refunds', issuetype: { name: 'Story' }, status: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' }, assignee: { displayName: 'Bia' }, labels: ['x'] } },
    { id: '11', key: 'PAY-2', fields: { summary: 'Fix totals', issuetype: { name: 'Bug' }, status: { statusCategory: { key: 'new' } } } },
  ];
  let sent;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response(JSON.stringify({ issues: page }), { status: 200 });
  };
  try {
    assert.equal((await call('POST', `${base}/sync`, null, bia)).data.synced, 2);
    assert.equal(sent.url, 'https://acme.atlassian.net/rest/api/3/search/jql');
    assert.match(sent.body.jql, /Team\[Team\]" in teamsByName\("Payments"\) AND project = "PAY"/);
    assert.equal(sent.auth, `Basic ${btoa('bia@acme.io:jt')}`);
    let list = (await call('GET', base, null, bia)).data.issues;
    assert.deepEqual(list.map((i) => [i.key, i.status, i.issueType]), [['PAY-1', 'in_progress', 'story'], ['PAY-2', 'todo', 'bug']]);
    assert.equal((await call('PATCH', `${base}/issues/${list[0].id}`, { summary: 'x' }, bia)).status, 400);
    // PAY-2 left the Team: it leaves the backlog; PAY-1 keeps its id
    page = [page[0]];
    assert.equal((await call('POST', `${base}/sync`, null, bia)).data.removed, 1);
    const again = (await call('GET', base, null, bia)).data;
    assert.deepEqual(again.issues.map((i) => i.id), [list[0].id]);
    assert.equal(again.sync.count, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test('model: JQL by team id or name', () => {
  assert.equal(jqlFor({ jiraTeam: '0f0e8f4c-1234-4abc-9def-0123456789ab', jiraProject: '' }), '"Team[Team]" = "0f0e8f4c-1234-4abc-9def-0123456789ab" ORDER BY Rank ASC');
  assert.match(jqlFor({ jiraTeam: 'A "b"', jiraProject: '' }), /teamsByName\("A b"\)/);
  assert.equal(fromJira({ id: '1', key: 'K-1', fields: { issuetype: { name: 'Sub-task' } } }, 'https://x').issueType, 'subtask');
});

test('sprints: plan issues, start one at a time, complete; the retro opens only at the end', async () => {
  const { call, admin, bia, board } = await boot();
  const base = `/api/issues/boards/${board.id}`;
  const retroBody = { name: 'Retro', start: '2026-11-01', end: '2026-11-14' };
  // module off: retros are created as before
  assert.equal((await call('POST', `/api/boards/${board.id}/sprints`, retroBody, bia)).status, 201);
  await call('PATCH', '/api/org/modules/issues', { enabled: true }, admin);
  assert.equal((await call('POST', `/api/boards/${board.id}/sprints`, retroBody, bia)).status, 409);

  const s1 = (await call('POST', `${base}/sprints`, { goal: 'Pix' }, bia)).data.sprint;
  const s2 = (await call('POST', `${base}/sprints`, {}, bia)).data.sprint;
  assert.equal(s1.name, 'Sprint 1');
  assert.equal(s1.status, 'planned');
  assert.equal((await call('POST', `${base}/sprints/${s1.id}/start`, {}, bia)).status, 400); // empty
  const a = (await call('POST', `${base}/issues`, { summary: 'A', sprintId: s1.id, storyPoints: 3 }, bia)).data.issue;
  const b = (await call('POST', `${base}/issues`, { summary: 'B' }, bia)).data.issue;
  await call('PATCH', `${base}/issues/${b.id}`, { sprintId: s1.id }, bia);
  const started = (await call('POST', `${base}/sprints/${s1.id}/start`, {}, bia)).data.sprint;
  assert.equal(started.status, 'active');
  assert.deepEqual(started.committed, { issues: 2, points: 3 });
  await call('POST', `${base}/issues`, { summary: 'C', sprintId: s2.id }, bia);
  assert.equal((await call('POST', `${base}/sprints/${s2.id}/start`, {}, bia)).status, 409); // one active at a time
  assert.equal((await call('POST', `/api/boards/${board.id}/sprints`, { ...retroBody, deliverySprintId: s1.id }, bia)).status, 409); // not completed yet

  await call('PATCH', `${base}/issues/${a.id}`, { status: 'done' }, bia);
  const done = (await call('POST', `${base}/sprints/${s1.id}/complete`, { moveOpenTo: s2.id }, bia)).data.sprint;
  assert.equal(done.status, 'completed');
  assert.equal(done.result.done, 1);
  assert.equal(done.result.open, 1);
  const issuesNow = (await call('GET', base, null, bia)).data.issues;
  assert.equal(issuesNow.find((i) => i.id === b.id).sprintId, s2.id); // carried over
  assert.equal((await call('POST', `${base}/issues`, { summary: 'x', sprintId: s1.id }, bia)).status, 400);

  const retro = await call('POST', `/api/boards/${board.id}/sprints`, { ...retroBody, deliverySprintId: s1.id }, bia);
  assert.equal(retro.status, 201);
  const after = (await call('GET', base, null, bia)).data;
  assert.equal(after.sprints.find((s) => s.id === s1.id).retroSprintId, retro.data.sprint.id);
  assert.equal((await call('POST', `/api/boards/${board.id}/sprints`, { ...retroBody, deliverySprintId: s1.id }, bia)).status, 409); // only once
  assert.equal((await call('DELETE', `${base}/sprints/${s1.id}`, null, bia)).status, 400);
});
