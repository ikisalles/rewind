import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, signupCompany } from '@rewind/core/testing';
import retro from '../server/index.js';

const setup = (env = {}) => setupApp({ modules: [retro], env });

// ACME (admin Ana, member Bia) with a board and an open sprint.
async function bootstrap(call) {
  const { admin, bia, me } = await signupCompany(call);
  const board = (await call('POST', '/api/boards', { name: 'Squad A', teamId: me.org.defaultTeamId }, admin)).data.board;
  const sprint = (await call('POST', `/api/boards/${board.id}/sprints`, { name: 'Sprint 1', start: '2026-11-01', end: '2026-11-14' }, admin)).data.sprint;
  return { admin, bia, me, board, sprint };
}

test('hidden notes are masked for others, visible to author', async () => {
  const { call } = setup();
  const { admin, bia, sprint } = await bootstrap(call);
  await call('POST', `/api/sprints/${sprint.id}/notes`, { columnId: 'good', text: 'secret' }, bia);
  const asAdmin = (await call('GET', `/api/sprints/${sprint.id}`, null, admin)).data;
  assert.equal(asAdmin.notes[0].text, null);
  assert.equal(asAdmin.notes[0].masked, true);
  const asBia = (await call('GET', `/api/sprints/${sprint.id}`, null, bia)).data;
  assert.equal(asBia.notes[0].text, 'secret');
  // vote budget only visible to the retro admin
  assert.equal(asBia.sprint.votesPerUser, undefined);
  assert.equal(asAdmin.sprint.votesPerUser, 3);

  await call('PATCH', `/api/sprints/${sprint.id}`, { hidden: false }, admin);
  const revealed = (await call('GET', `/api/sprints/${sprint.id}`, null, admin)).data;
  assert.equal(revealed.notes[0].text, 'secret');
  assert.equal(revealed.notes[0].authorName, 'Bia');
});

test('members cannot manage sprint', async () => {
  const { call } = setup();
  const { bia, sprint } = await bootstrap(call);
  assert.equal((await call('PATCH', `/api/sprints/${sprint.id}`, { hidden: false }, bia)).status, 403);
  assert.equal((await call('POST', `/api/sprints/${sprint.id}/finish`, {}, bia)).status, 403);
});

test('vote limit, finish, top 3 and lock', async () => {
  const { call } = setup();
  const { admin, bia, sprint } = await bootstrap(call);
  await call('PATCH', `/api/sprints/${sprint.id}`, { votesPerUser: 2 }, admin);
  const ids = [];
  for (const t of ['a', 'b', 'c', 'd']) {
    ids.push((await call('POST', `/api/sprints/${sprint.id}/notes`, { columnId: 'good', text: t }, admin)).data.note.id);
  }
  assert.equal((await call('POST', `/api/sprints/${sprint.id}/notes/${ids[2]}/vote`, {}, bia)).status, 200);
  assert.equal((await call('POST', `/api/sprints/${sprint.id}/notes/${ids[1]}/vote`, {}, bia)).status, 200);
  assert.equal((await call('POST', `/api/sprints/${sprint.id}/notes/${ids[0]}/vote`, {}, bia)).status, 409);
  await call('POST', `/api/sprints/${sprint.id}/notes/${ids[2]}/vote`, {}, admin);

  const fin = await call('POST', `/api/sprints/${sprint.id}/finish`, {}, admin);
  assert.deepEqual(fin.data.top, [ids[2], ids[1], ids[0]]);
  assert.equal((await call('POST', `/api/sprints/${sprint.id}/notes`, { columnId: 'good', text: 'x' }, bia)).status, 409);
});

test('action items, previous sprint review and share link', async () => {
  const { call } = setup();
  const { admin, bia, board, sprint, me } = await bootstrap(call);
  const members = (await call('GET', '/api/org/members', null, admin)).data.members;
  const biaId = members.find((m) => m.email === 'bia@acme.io').id;
  const a1 = (await call('POST', `/api/sprints/${sprint.id}/actions`, { text: 'Melhorar CI', ownerId: biaId, due: '2026-11-20' }, admin)).data.action;
  await call('POST', `/api/sprints/${sprint.id}/actions`, { text: 'Doc' }, admin);
  // owner can mark as done
  assert.equal((await call('PATCH', `/api/sprints/${sprint.id}/actions/${a1.id}`, { done: true }, bia)).status, 200);
  assert.equal((await call('GET', '/api/actions/mine', null, bia)).data.actions.length, 0);

  const s2 = (await call('POST', `/api/boards/${board.id}/sprints`, { name: 'Sprint 2', start: '2026-11-15', end: '2026-11-28' }, admin)).data.sprint;
  const state = (await call('GET', `/api/sprints/${s2.id}`, null, admin)).data;
  assert.equal(state.previous.sprint.id, sprint.id);
  assert.equal(state.previous.pending.length, 1);
  const pendingId = state.previous.pending[0].id;
  await call('POST', `/api/sprints/${s2.id}/review`, { actionId: pendingId, decision: 'keep' }, admin);
  const after = (await call('GET', `/api/sprints/${s2.id}`, null, admin)).data;
  assert.equal(after.previous.pending.length, 0);
  assert.equal(after.actions.length, 1);
  assert.equal(after.actions[0].carriedFrom.sprintId, sprint.id);

  const share = (await call('POST', `/api/sprints/${s2.id}/share`, {}, admin)).data;
  assert.match(share.url, /#\/s\//);
  const pub = await call('GET', `/api/public/${share.shareToken}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.sprint.shareToken, undefined);
  assert.equal(pub.data.org.name, me.org.name);
  await call('POST', `/api/sprints/${s2.id}/share`, { enabled: false }, admin);
  assert.equal((await call('GET', `/api/public/${share.shareToken}`)).status, 404);
});

test('dashboard: attention items and my action items', async () => {
  const { call } = setup();
  const { admin, bia, me, board, sprint } = await bootstrap(call);
  const daysFromNow = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  // the sprint ends tomorrow, so the retro admin is told to finish it
  await call('PATCH', `/api/sprints/${sprint.id}`, { start: daysFromNow(-10), end: daysFromNow(1) }, admin);

  let dash = (await call('GET', '/api/dashboard', null, bia)).data;
  assert.equal(dash.retro.boards.length, 1);
  assert.equal(dash.retro.boards[0].lastSprint.shareToken, undefined);
  assert.equal(dash.retro.attention.length, 1);
  assert.equal(dash.retro.attention[0].needsNote, true);
  assert.equal(dash.retro.attention[0].votesRemaining, 0); // nothing to vote on yet
  assert.equal(dash.retro.attention[0].closingSoon, false); // bia doesn't manage the retro

  const note = (await call('POST', `/api/sprints/${sprint.id}/notes`, { columnId: 'good', text: 'x' }, bia)).data.note;
  dash = (await call('GET', '/api/dashboard', null, bia)).data;
  assert.equal(dash.retro.attention[0].needsNote, false);
  assert.equal(dash.retro.attention[0].votesRemaining, 3);

  for (let i = 0; i < 3; i++) {
    const n = (await call('POST', `/api/sprints/${sprint.id}/notes`, { columnId: 'good', text: `n${i}` }, admin)).data.note;
    await call('POST', `/api/sprints/${sprint.id}/notes/${n.id}/vote`, {}, bia);
  }
  dash = (await call('GET', '/api/dashboard', null, bia)).data;
  assert.deepEqual(dash.retro.attention, []); // all done for bia

  const asAdmin = (await call('GET', '/api/dashboard', null, admin)).data;
  assert.equal(asAdmin.retro.attention[0].closingSoon, true);

  await call('POST', `/api/sprints/${sprint.id}/actions`, { text: 'Fix CI', ownerId: me.user.id, noteId: note.id }, admin);
  await call('POST', `/api/sprints/${sprint.id}/actions`, { text: 'Not mine' }, admin);
  const mine = (await call('GET', '/api/dashboard', null, admin)).data.retro.actions;
  assert.deepEqual(mine.map((a) => a.text), ['Fix CI']);
  assert.equal(mine[0].board.id, board.id);

  // finished retros no longer need attention
  await call('POST', `/api/sprints/${sprint.id}/finish`, {}, admin);
  assert.deepEqual((await call('GET', '/api/dashboard', null, admin)).data.retro.attention, []);
});

test('dashboard: latest results, team health and admin housekeeping', async () => {
  const { call } = setup();
  const { admin, bia, me, board, sprint } = await bootstrap(call);

  let dash = (await call('GET', '/api/dashboard', null, admin)).data;
  assert.deepEqual(dash.retro.results, []);
  assert.deepEqual(dash.admin.onboarding, { teams: false, people: true, board: true, sprint: true, finished: false, appearance: false });
  assert.equal(dash.admin.pendingInvites, 0); // bia already accepted
  assert.equal((await call('GET', '/api/dashboard', null, bia)).data.admin, null);

  const a = (await call('POST', `/api/sprints/${sprint.id}/notes`, { columnId: 'improve', text: 'slow CI' }, bia)).data.note;
  await call('POST', `/api/sprints/${sprint.id}/notes`, { columnId: 'good', text: 'pairing' }, bia);
  await call('POST', `/api/sprints/${sprint.id}/notes/${a.id}/vote`, {}, bia);
  await call('POST', `/api/sprints/${sprint.id}/notes/${a.id}/vote`, {}, admin);
  const act1 = (await call('POST', `/api/sprints/${sprint.id}/actions`, { text: 'Cache deps', ownerId: me.user.id }, admin)).data.action;
  await call('POST', `/api/sprints/${sprint.id}/actions`, { text: 'Parallel jobs' }, admin);
  await call('PATCH', `/api/sprints/${sprint.id}/actions/${act1.id}`, { done: true }, admin);
  await call('POST', `/api/sprints/${sprint.id}/finish`, {}, admin);

  dash = (await call('GET', '/api/dashboard', null, bia)).data;
  const [result] = dash.retro.results;
  assert.equal(result.board.id, board.id);
  assert.equal(result.top[0].text, 'slow CI');
  assert.equal(result.top[0].votes, 2);
  assert.equal(result.top[0].column.title, 'What could be better');
  assert.deepEqual(result.actions, { done: 1, total: 2, rate: 0.5 });

  const [health] = dash.retro.health;
  assert.equal(health.sprints.length, 1);
  assert.equal(health.sprints[0].actions.rate, 0.5);
  // ana (who signed up) and bia are both in the default team; only bia added notes
  assert.deepEqual(health.sprints[0].participation, { authors: 1, teamSize: 2, rate: 0.5 });

  // next sprint carries the open item over
  const s2 = (await call('POST', `/api/boards/${board.id}/sprints`, { name: 'Sprint 2', start: '2026-11-15', end: '2026-11-28' }, admin)).data.sprint;
  const pending = (await call('GET', `/api/sprints/${s2.id}`, null, admin)).data.previous.pending;
  await call('POST', `/api/sprints/${s2.id}/review`, { actionId: pending[0].id, decision: 'keep' }, admin);
  dash = (await call('GET', '/api/dashboard', null, admin)).data;
  assert.equal(dash.retro.health[0].sprints.length, 2);
  assert.equal(dash.retro.health[0].sprints[0].carried, 1);
  assert.equal(dash.retro.health[0].sprints[0].actions.rate, 0.5); // carried still counts as not done
  assert.equal(dash.admin.onboarding.finished, true);

  // housekeeping: pending invite and a member without a team
  await call('POST', '/api/invites', { email: 'caio@acme.io', teamId: me.org.defaultTeamId }, admin);
  const bob = (await call('POST', '/api/invites', { email: 'bob@acme.io', teamId: me.org.defaultTeamId }, admin)).data.invites[0];
  const bobToken = (await call('POST', `/api/invites/${bob.token}/accept`, { name: 'Bob', password: '12345678' })).data.token;
  const bobId = (await call('GET', '/api/me', null, bobToken)).data.user.id;
  await call('PATCH', `/api/org/members/${bobId}`, { teamIds: [] }, admin);
  dash = (await call('GET', '/api/dashboard', null, admin)).data;
  assert.equal(dash.admin.pendingInvites, 1);
  assert.deepEqual(dash.admin.membersWithoutTeam.map((m) => m.name), ['Bob']);
});

test('boards list never leaks the share token or vote budget', async () => {
  const { call } = setup();
  const { admin, bia, sprint } = await bootstrap(call);
  await call('POST', `/api/sprints/${sprint.id}/share`, {}, admin);
  const { boards } = (await call('GET', '/api/boards', null, bia)).data;
  assert.equal(boards[0].lastSprint.id, sprint.id);
  assert.equal(boards[0].lastSprint.shareToken, undefined);
  assert.equal(boards[0].lastSprint.votesPerUser, undefined);
});

test('merge notes: revealed notes, votes and authors kept, can be split back', async () => {
  const { call } = setup();
  const { admin, bia, sprint } = await bootstrap(call);
  const sid = sprint.id;
  const add = async (text, token, columnId = 'improve') => (await call('POST', `/api/sprints/${sid}/notes`, { columnId, text }, token)).data.note;
  const a = await add('CI is slow', admin);
  const b = await add('Builds take forever', bia);
  const c = await add('Pipeline too slow', bia, 'ideas');
  const action = (await call('POST', `/api/sprints/${sid}/actions`, { text: 'Cache deps', noteId: b.id }, admin)).data.action;

  // votes: bia votes on a and b, admin on b
  await call('POST', `/api/sprints/${sid}/notes/${a.id}/vote`, {}, bia);
  await call('POST', `/api/sprints/${sid}/notes/${b.id}/vote`, {}, bia);
  await call('POST', `/api/sprints/${sid}/notes/${b.id}/vote`, {}, admin);

  // hidden notes can't be merged (nobody can read them), members can't merge
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${a.id}/merge`, { noteIds: [b.id] }, admin)).status, 409);
  await call('PATCH', `/api/sprints/${sid}`, { hidden: false }, admin);
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${a.id}/merge`, { noteIds: [b.id] }, bia)).status, 403);
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${a.id}/merge`, { noteIds: [] }, admin)).status, 400);

  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${a.id}/merge`, { noteIds: [b.id, c.id] }, admin)).status, 200);
  let state = (await call('GET', `/api/sprints/${sid}`, null, bia)).data;
  assert.equal(state.notes.length, 1);
  const merged = state.notes[0];
  assert.equal(merged.text, 'CI is slow');
  assert.deepEqual(merged.merged.map((m) => [m.text, m.authorName, m.mine]), [['Builds take forever', 'Bia', true], ['Pipeline too slow', 'Bia', true]]);
  // every vote follows the merged card: bia's two (on a and b) + the admin's one
  assert.equal(merged.votes, 3);
  assert.equal(merged.myVotes, 2);
  assert.equal(state.myVotes.used, 2);
  assert.equal(state.actions.find((x) => x.id === action.id).noteId, a.id);

  // bia's notes were merged into the admin's card: she still counts as having participated
  const dash = (await call('GET', '/api/dashboard', null, bia)).data;
  assert.equal(dash.retro.attention[0]?.needsNote ?? false, false);

  // hiding again masks merged texts of others
  await call('PATCH', `/api/sprints/${sid}`, { hidden: true }, admin);
  const asAdmin = (await call('GET', `/api/sprints/${sid}`, null, admin)).data.notes[0];
  assert.equal(asAdmin.text, 'CI is slow');
  assert.equal(asAdmin.merged[0].text, null);
  assert.equal(asAdmin.merged[0].masked, true);
  await call('PATCH', `/api/sprints/${sid}`, { hidden: false }, admin);

  // only the retro admin removes a merged card
  assert.equal((await call('DELETE', `/api/sprints/${sid}/notes/${a.id}`, null, bia)).status, 403);

  // split back: original column, author and text
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${a.id}/unmerge`, { mergedId: c.id }, admin)).status, 200);
  state = (await call('GET', `/api/sprints/${sid}`, null, admin)).data;
  const back = state.notes.find((n) => n.id === c.id);
  assert.equal(back.columnId, 'ideas');
  assert.equal(back.authorName, 'Bia');
  assert.equal(state.notes.find((n) => n.id === a.id).merged.length, 1);

  // the merged card is the one that counts when the retro is finished
  const { top } = (await call('POST', `/api/sprints/${sid}/finish`, {}, admin)).data;
  assert.equal(top[0], a.id);
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${a.id}/merge`, { noteIds: [c.id] }, admin)).status, 409);
});

test('merge own notes even while hidden; anonymous retro hides authors from everyone', async () => {
  const { call, app } = setup();
  const { admin, bia, sprint } = await bootstrap(call);
  const sid = sprint.id;
  const add = async (text, token) => (await call('POST', `/api/sprints/${sid}/notes`, { columnId: 'good', text }, token)).data.note;
  const b1 = await add('Pairing helped', bia);
  const b2 = await add('Pair programming', bia);
  const a1 = await add('Pairing', admin);

  // notes start hidden: bia can still merge her own two notes
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${b1.id}/merge`, { noteIds: [b2.id] }, bia)).status, 200);
  // but not someone else's, and the admin can't merge notes nobody can read yet
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${b1.id}/merge`, { noteIds: [a1.id] }, bia)).status, 409);
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${a1.id}/merge`, { noteIds: [b1.id] }, admin)).status, 409);
  // bia can split her own merged card
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${b1.id}/unmerge`, { mergedId: b2.id }, bia)).status, 200);
  await call('POST', `/api/sprints/${sid}/notes/${b1.id}/merge`, { noteIds: [b2.id] }, bia);

  // anonymous: only the retro admin toggles it; authors disappear for everyone, admin included
  await call('PATCH', `/api/sprints/${sid}`, { hidden: false }, admin);
  assert.equal((await call('PATCH', `/api/sprints/${sid}`, { anonymous: true }, bia)).status, 403);
  assert.equal((await call('PATCH', `/api/sprints/${sid}`, { anonymous: true }, admin)).status, 200);
  const asAdmin = (await call('GET', `/api/sprints/${sid}`, null, admin)).data;
  assert.equal(asAdmin.sprint.anonymous, true);
  const biaCard = asAdmin.notes.find((n) => n.id === b1.id);
  assert.equal(biaCard.text, 'Pairing helped');
  assert.equal(biaCard.authorName, null);
  assert.equal(biaCard.authorId, null);
  assert.equal(biaCard.merged[0].authorName, null);
  assert.equal(asAdmin.notes.find((n) => n.id === a1.id).mine, true); // you still know your own notes
  const asBia = (await call('GET', `/api/sprints/${sid}`, null, bia)).data;
  assert.equal(asBia.notes.find((n) => n.id === a1.id).authorName, null);
  assert.equal(asBia.notes.find((n) => n.id === b1.id).mine, true);

  // the admin merges any revealed note, by any author
  assert.equal((await call('POST', `/api/sprints/${sid}/notes/${a1.id}/merge`, { noteIds: [b1.id] }, admin)).status, 200);

  // the public link doesn't leak authors either
  const { url } = (await call('POST', `/api/sprints/${sid}/share`, {}, admin)).data;
  const token = url.split('/s/')[1];
  const pub = (await call('GET', `/api/public/${token}`)).data;
  assert.ok(pub.notes.every((n) => n.authorName === null && n.merged.every((m) => m.authorName === null)));
});


test('several votes on the same card, within the sprint limit', async () => {
  const { call } = setup();
  const { admin, bia, sprint } = await bootstrap(call);
  const sid = sprint.id;
  await call('PATCH', `/api/sprints/${sid}`, { votesPerUser: 3 }, admin);
  const a = (await call('POST', `/api/sprints/${sid}/notes`, { columnId: 'good', text: 'a' }, admin)).data.note;
  const b = (await call('POST', `/api/sprints/${sid}/notes`, { columnId: 'good', text: 'b' }, admin)).data.note;
  const vote = (id) => call('POST', `/api/sprints/${sid}/notes/${id}/vote`, {}, bia);
  const unvote = (id) => call('DELETE', `/api/sprints/${sid}/notes/${id}/vote`, null, bia);

  assert.deepEqual((await vote(a.id)).data, { remaining: 2, onNote: 1 });
  assert.deepEqual((await vote(a.id)).data, { remaining: 1, onNote: 2 });
  assert.deepEqual((await vote(b.id)).data, { remaining: 0, onNote: 1 });
  // the limit counts every vote, wherever it went
  assert.equal((await vote(a.id)).status, 409);

  let state = (await call('GET', `/api/sprints/${sid}`, null, bia)).data;
  const noteA = state.notes.find((n) => n.id === a.id);
  assert.equal(noteA.votes, 2);
  assert.equal(noteA.myVotes, 2);
  assert.deepEqual(state.myVotes, { used: 3, remaining: 0 });

  // taking back removes one vote at a time
  assert.deepEqual((await unvote(a.id)).data, { remaining: 1, onNote: 1 });
  state = (await call('GET', `/api/sprints/${sid}`, null, bia)).data;
  assert.equal(state.notes.find((n) => n.id === a.id).votes, 1);

  // deleting a card gives back every vote it had
  await vote(a.id);
  await call('DELETE', `/api/sprints/${sid}/notes/${a.id}`, null, admin);
  state = (await call('GET', `/api/sprints/${sid}`, null, bia)).data;
  assert.deepEqual(state.myVotes, { used: 1, remaining: 2 });

  // the vote with most votes wins the top 3
  await vote(b.id);
  const { top } = (await call('POST', `/api/sprints/${sid}/finish`, {}, admin)).data;
  assert.equal(top[0], b.id);
});

test('sprint templates: list, create from a template, blank start and apply later', async () => {
  const { call } = setup();
  const { admin, bia, board } = await bootstrap(call);
  const create = (body) => call('POST', `/api/boards/${board.id}/sprints`, { name: 'S', start: '2026-11-01', end: '2026-11-14', ...body }, admin);

  const { templates } = (await call('GET', '/api/retro/templates', null, bia)).data;
  const ids = templates.map((t) => t.id);
  for (const id of ['start-stop-continue', '4ls', 'mad-sad-glad', 'sailboat', 'starfish', 'rose-thorn-bud', 'classic']) assert.ok(ids.includes(id), id);
  assert.ok(templates.every((t) => t.columns.length && t.columns.every((c) => c.title && c.color && c.hint)));

  // from a template: its columns, with prompts
  const ssc = (await create({ template: 'start-stop-continue' })).data.sprint;
  assert.equal(ssc.template, 'start-stop-continue');
  assert.deepEqual(ssc.columns.map((c) => c.title), ['Start', 'Stop', 'Continue']);
  assert.equal(ssc.columns[0].hint, 'What should we begin doing?');
  assert.equal((await create({ template: 'nope' })).status, 400);

  // old clients (no template) still get the classic columns
  const legacy = (await create({})).data.sprint;
  assert.deepEqual(legacy.columns.map((c) => c.id), ['good', 'improve', 'ideas']);

  // blank: no columns, so no notes until the admin adds some
  const blank = (await create({ template: 'blank' })).data.sprint;
  assert.equal(blank.template, 'blank');
  assert.deepEqual(blank.columns, []);
  assert.equal((await call('POST', `/api/sprints/${blank.id}/notes`, { columnId: 'x', text: 'hi' }, bia)).status, 400);
  assert.equal((await call('PATCH', `/api/sprints/${blank.id}`, { columns: [{ title: 'Kudos', color: '#ec4899', hint: 'Who helped you?' }, { title: 'Blockers' }] }, bia)).status, 403);
  assert.equal((await call('PATCH', `/api/sprints/${blank.id}`, { columns: [{ title: 'Kudos', color: '#ec4899', hint: 'Who helped you?' }, { title: 'Blockers' }] }, admin)).status, 200);
  let state = (await call('GET', `/api/sprints/${blank.id}`, null, bia)).data;
  assert.deepEqual(state.sprint.columns.map((c) => [c.title, c.hint ?? null]), [['Kudos', 'Who helped you?'], ['Blockers', null]]);
  const kudos = state.sprint.columns[0].id;
  assert.equal((await call('POST', `/api/sprints/${blank.id}/notes`, { columnId: kudos, text: 'Thanks Ana' }, bia)).status, 201);

  // with notes, the board can't go back to zero columns
  assert.equal((await call('PATCH', `/api/sprints/${blank.id}`, { columns: [] }, admin)).status, 400);

  // apply a template later: notes in columns it doesn't have move to its first column
  assert.equal((await call('PATCH', `/api/sprints/${blank.id}`, { template: 'mad-sad-glad' }, admin)).status, 200);
  state = (await call('GET', `/api/sprints/${blank.id}`, null, admin)).data;
  assert.equal(state.sprint.template, 'mad-sad-glad');
  assert.deepEqual(state.sprint.columns.map((c) => c.id), ['mad', 'sad', 'glad']);
  assert.equal(state.notes[0].columnId, 'mad');
  assert.equal((await call('PATCH', `/api/sprints/${blank.id}`, { template: 'nope' }, admin)).status, 400);
});
