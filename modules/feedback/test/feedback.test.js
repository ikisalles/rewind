import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, signupCompany } from '@rewind/core/testing';
import foundation from '@rewind/foundation/server';
import feedback from '../server/index.js';

async function boot() {
  const ctx = setupApp({ modules: [foundation, feedback] });
  const { call } = ctx;
  const { admin, bia, me } = await signupCompany(call);
  const teamId = me.org.defaultTeamId;
  const biaId = (await call('GET', '/api/me', null, bia)).data.user.id;
  // Caio: a third person, outside the default team
  const other = (await call('POST', '/api/teams', { name: 'Other' }, admin)).data.team;
  const inv = (await call('POST', '/api/invites', { email: 'caio@acme.io', teamId: other.id }, admin)).data;
  const caio = (await call('POST', `/api/invites/${inv.invites[0].token}/accept`, { name: 'Caio', password: '12345678' })).data.token;
  const caioId = (await call('GET', '/api/me', null, caio)).data.user.id;
  return { ...ctx, admin, bia, caio, me, adminId: me.user.id, biaId, caioId, teamId, otherTeamId: other.id };
}

test('kudos: audience preview before sending, team audience, private stays private (even for admins)', async () => {
  const { call, admin, bia, caio, adminId, biaId, caioId, teamId } = await boot();
  const preview = (await call('POST', '/api/feedback/audience-preview', { audience: { type: 'private' }, recipientIds: [caioId] }, bia)).data;
  assert.match(preview.summary, /Only you and the recipients/);
  assert.equal(preview.count, 2);

  assert.equal((await call('POST', '/api/feedback/recognitions', { recipientIds: [caioId], category: 'support', contribution: 'x' }, bia)).status, 201);
  assert.equal((await call('POST', '/api/feedback/recognitions', { recipientIds: [caioId], category: 'nope', contribution: 'x' }, bia)).status, 400);
  assert.equal((await call('POST', '/api/feedback/recognitions', { recipientIds: [biaId], category: 'support', contribution: 'x' }, bia)).status, 400);

  const priv = (await call('GET', '/api/feedback/recognitions', null, bia)).data.recognitions[0];
  assert.equal(priv.audience.type, 'private');
  // the admin is not a participant: no access to private content
  assert.equal((await call('GET', `/api/feedback/recognitions/${priv.id}`, null, admin)).status, 404);
  assert.equal((await call('GET', `/api/feedback/recognitions/${priv.id}`, null, caio)).status, 200);

  // team audience: Bia (in the team) can address it; Caio (not in it) can't
  const team = await call('POST', '/api/feedback/recognitions', { recipientIds: [adminId], category: 'quality', contribution: 'Great review', audience: { type: 'team', id: teamId } }, bia);
  assert.equal(team.status, 201);
  assert.equal((await call('POST', '/api/feedback/recognitions', { recipientIds: [adminId], category: 'quality', contribution: 'x', audience: { type: 'team', id: teamId } }, caio)).status, 403);
  assert.equal((await call('GET', `/api/feedback/recognitions/${team.data.recognition.id}`, null, caio)).status, 404);

  // only non-private recognitions become domain events (timeline)
  const events = (await call('GET', '/api/foundation/events', null, admin)).data.events.filter((e) => e.entityType === 'feedback.recognition');
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.audience.type, 'team');
});

test('company-wide recognition follows the policy; audience changes are logged and communicated', async () => {
  const { call, admin, bia, caio, caioId } = await boot();
  const r = (await call('POST', '/api/feedback/recognitions', { recipientIds: [caioId], category: 'delivery', contribution: 'Shipped', audience: { type: 'private' } }, bia)).data.recognition;
  assert.equal((await call('PATCH', `/api/feedback/recognitions/${r.id}/audience`, { audience: { type: 'org' } }, caio)).status, 403);
  const changed = await call('PATCH', `/api/feedback/recognitions/${r.id}/audience`, { audience: { type: 'org' } }, bia);
  assert.equal(changed.data.recognition.audienceHistory.length, 1);
  assert.equal((await call('GET', `/api/feedback/recognitions/${r.id}`, null, admin)).status, 200);
  const audit = (await call('GET', '/api/foundation/audit', null, admin)).data.records.map((x) => x.action);
  assert.ok(audit.includes('feedback.recognition.audience_changed'));
  const n = (await call('GET', '/api/feedback/notifications', null, caio)).data.notifications.map((x) => x.type);
  assert.ok(n.includes('feedback.audience'));

  // policy: turn company-wide off
  const cats = (await call('GET', '/api/feedback/catalog', null, admin)).data.categories;
  assert.equal((await call('PUT', '/api/feedback/settings', { categories: cats, allowOrgAudience: false }, bia)).status, 403);
  await call('PUT', '/api/feedback/settings', { categories: [...cats, { label: 'Mentoring' }], allowOrgAudience: false }, admin);
  assert.equal((await call('POST', '/api/feedback/recognitions', { recipientIds: [caioId], category: 'mentoring', contribution: 'x', audience: { type: 'org' } }, bia)).status, 400);
  assert.equal((await call('POST', '/api/feedback/recognitions', { recipientIds: [caioId], category: 'mentoring', contribution: 'x' }, bia)).status, 201);
});

test('reactions are toggles, no scores or rankings', async () => {
  const { call, bia, caio, caioId } = await boot();
  const r = (await call('POST', '/api/feedback/recognitions', { recipientIds: [caioId], category: 'support', contribution: 'x' }, bia)).data.recognition;
  let x = (await call('POST', `/api/feedback/recognitions/${r.id}/reactions`, { emoji: '👏' }, caio)).data.recognition;
  assert.equal(x.reactions['👏'], 1);
  x = (await call('POST', `/api/feedback/recognitions/${r.id}/reactions`, { emoji: '👏' }, caio)).data.recognition;
  assert.equal(x.reactions['👏'], undefined);
  assert.equal((await call('POST', `/api/feedback/recognitions/${r.id}/reactions`, { emoji: '💩' }, caio)).status, 400);
  const dash = (await call('GET', '/api/dashboard', null, caio)).data.feedback;
  assert.deepEqual(Object.keys(dash).sort(), ['pendingRequests', 'unread']);
});

test('feedback: frozen team audience — later members do not gain access; neutral notifications', async () => {
  const { call, admin, bia, caio, adminId, caioId, teamId } = await boot();
  const f = (await call('POST', '/api/feedback/feedback', { recipientIds: [adminId], situation: 'Planning', behavior: 'You listened', impact: 'Better plan', audience: { type: 'team', id: teamId } }, bia)).data.feedback;
  assert.equal(f.kind, 'offered');
  assert.equal(f.audienceUserIds, undefined); // never sent to clients
  // Caio joins the team afterwards (manually or via IdP sync)
  await call('POST', `/api/teams/${teamId}/members`, { userId: caioId }, admin);
  assert.equal((await call('GET', `/api/feedback/feedback/${f.id}`, null, caio)).status, 404);
  // notifications never carry the content
  const n = (await call('GET', '/api/feedback/notifications', null, admin)).data.notifications;
  assert.equal(n[0].text, 'You received new feedback');
  assert.ok(!JSON.stringify(n).includes('listened'));
  // no company-wide feedback
  const org = await call('POST', '/api/feedback/feedback', { recipientIds: [adminId], behavior: 'x', audience: { type: 'org' } }, bia);
  assert.equal(org.data.feedback.audience.type, 'private');
});

test('feedback edits keep history and stop once read; discussed flag; explicit next steps', async () => {
  const { call, admin, bia, adminId, biaId } = await boot();
  const f = (await call('POST', '/api/feedback/feedback', { recipientIds: [adminId], behavior: 'v1' }, bia)).data.feedback;
  const edited = (await call('PATCH', `/api/feedback/feedback/${f.id}`, { behavior: 'v2' }, bia)).data.feedback;
  assert.equal(edited.revisions[0].behavior, 'v1');
  await call('GET', `/api/feedback/feedback/${f.id}`, null, admin); // read by the recipient
  assert.equal((await call('PATCH', `/api/feedback/feedback/${f.id}`, { behavior: 'v3' }, bia)).status, 409);
  const d = (await call('POST', `/api/feedback/feedback/${f.id}/discussed`, {}, admin)).data.feedback;
  assert.deepEqual(d.discussedBy, [adminId]);

  assert.equal((await call('POST', '/api/feedback/commitments', { title: 'Pair weekly', ownerId: adminId, feedbackId: f.id }, bia)).status, 400); // due date required
  const c = (await call('POST', '/api/feedback/commitments', { title: 'Pair weekly', ownerId: adminId, dueDate: '2026-12-31', feedbackId: f.id }, bia)).data.commitment;
  assert.deepEqual(c.participantIds.sort(), [adminId, biaId].sort());
  assert.equal((await call('GET', '/api/feedback/commitments', null, admin)).data.commitments.length, 1);
  const detail = (await call('GET', `/api/feedback/feedback/${f.id}`, null, admin)).data;
  assert.equal(detail.commitments.length, 1);
});

test('requests: ask, receive several answers, close; only the requester sees all answers', async () => {
  const { call, admin, bia, caio, adminId, biaId, caioId } = await boot();
  const r = (await call('POST', '/api/feedback/requests', { question: 'How was my demo?', recipientIds: [biaId, caioId], dueDate: '2026-12-01' }, admin)).data.request;
  assert.equal(r.status, 'open');
  assert.equal((await call('GET', '/api/feedback/notifications', null, bia)).data.reminders.length, 1);
  await call('POST', `/api/feedback/requests/${r.id}/responses`, { behavior: 'Clear slides' }, bia);
  await call('POST', `/api/feedback/requests/${r.id}/responses`, { suggestion: 'Shorter intro' }, caio);
  assert.equal((await call('GET', '/api/feedback/notifications', null, bia)).data.reminders.length, 0);
  const mine = (await call('GET', `/api/feedback/requests/${r.id}`, null, admin)).data;
  assert.equal(mine.request.status, 'answered');
  assert.equal(mine.responses.length, 2);
  assert.ok(mine.responses.every((x) => x.kind === 'requested' && x.recipientIds[0] === adminId));
  assert.equal((await call('GET', `/api/feedback/requests/${r.id}`, null, bia)).data.responses.length, 1);
  assert.equal((await call('PATCH', `/api/feedback/requests/${r.id}`, { status: 'closed' }, bia)).status, 403);
  assert.equal((await call('PATCH', `/api/feedback/requests/${r.id}`, { status: 'closed' }, admin)).data.request.status, 'closed');
  assert.equal((await call('POST', `/api/feedback/requests/${r.id}/responses`, { behavior: 'late' }, bia)).status, 409);
});

test('private 1:1 notes are visible only to their author', async () => {
  const { call, admin, bia, biaId } = await boot();
  const n = (await call('POST', '/api/feedback/notes', { text: 'Talk about growth', aboutUserId: biaId }, admin)).data.note;
  assert.equal((await call('GET', '/api/feedback/notes', null, admin)).data.notes.length, 1);
  assert.equal((await call('GET', '/api/feedback/notes', null, bia)).data.notes.length, 0);
  assert.equal((await call('DELETE', `/api/feedback/notes/${n.id}`, null, bia)).status, 404);
});

test('history and export only include the person’s own items; export is audited', async () => {
  const { call, admin, bia, caio, adminId, caioId } = await boot();
  await call('POST', '/api/feedback/feedback', { recipientIds: [caioId], behavior: 'secret between Bia and Caio' }, bia);
  await call('POST', '/api/feedback/recognitions', { recipientIds: [adminId], category: 'learning', contribution: 'Taught us testing', links: [{ targetType: 'goal_objective', targetId: 'obj-1' }, { targetType: 'retro_board', targetId: 'b-1' }] }, bia);
  const h = (await call('GET', '/api/feedback/history?q=testing', null, admin)).data;
  assert.equal(h.recognitions.length, 1);
  assert.equal(h.recognitions[0].links.length, 2);
  assert.equal(h.feedback.length, 0);
  const exp = (await call('GET', '/api/feedback/export', null, admin)).data;
  assert.ok(!JSON.stringify(exp).includes('secret between'));
  assert.equal((await call('GET', '/api/feedback/export', null, caio)).data.feedback.length, 1);
  const audit = (await call('GET', '/api/foundation/audit', null, admin)).data.records.map((x) => x.action);
  assert.ok(audit.includes('feedback.export'));
});

test('people search by name/e-mail and team/group; authorship survives membership changes', async () => {
  const { call, admin, bia, adminId, biaId, teamId } = await boot();
  const res = (await call('GET', '/api/feedback/people?q=caio@', null, bia)).data;
  assert.equal(res.people.length, 1);
  assert.equal(res.people[0].email, undefined);
  const teams = (await call('GET', '/api/feedback/people', null, bia)).data.teams;
  assert.ok(teams.find((t) => t.id === teamId).memberIds.includes(biaId));
  const r = (await call('POST', '/api/feedback/recognitions', { recipientIds: [adminId], category: 'support', contribution: 'x' }, bia)).data.recognition;
  await call('DELETE', `/api/teams/${teamId}/members/${biaId}`, null, admin);
  const again = (await call('GET', `/api/feedback/recognitions/${r.id}`, null, admin)).data.recognition;
  assert.equal(again.authorId, biaId);
});
