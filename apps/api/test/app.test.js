// Integration: the composed API (core + every enabled module), as the runtimes run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from '@rewind/core/storage/memory';
import { signupCompany } from '@rewind/core/testing';
import { createRewind, MODULES } from '../index.js';

function setup(env = {}) {
  const storage = memoryStorage();
  const app = createRewind({ storage, env: { APP_URL: 'https://rewind.test', ...env } });
  const call = async (method, path, body, token) => {
    const res = await app.fetch(
      new Request(`https://rewind.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  return { app, storage, call };
}

const bootstrap = signupCompany;

test('the API ships the foundation, retro, GMUD and goals modules; GMUD starts off', async () => {
  assert.deepEqual(MODULES.map((m) => m.id), ['foundation', 'retro', 'gmud', 'goals']);
  const { call } = setup();
  const { admin } = await bootstrap(call);
  const dash = (await call('GET', '/api/dashboard', null, admin)).data;
  // foundation is required (always on); gmud starts off
  assert.deepEqual(dash.modules, ['foundation', 'retro', 'goals']);
  assert.ok(Array.isArray(dash.retro.boards));
  assert.equal(dash.admin.onboarding.board, false);
  // retro blocks deleting a team that still has boards
  const team = (await call('POST', '/api/teams', { name: 'Squad' }, admin)).data.team;
  await call('POST', '/api/boards', { name: 'B', teamId: team.id }, admin);
  assert.equal((await call('DELETE', `/api/teams/${team.id}`, null, admin)).status, 400);
});

test('same company name: request waits for admin approval', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('resend')) {
      sent.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const { call } = setup({ RESEND_API_KEY: 'k', EMAIL_FROM: 'rewind@test' });
    const { admin, me } = await bootstrap(call);

    // "acme" with different case/spacing/accents is the same company
    const r = await call('POST', '/api/auth/signup', { orgName: '  Ácme ', name: 'Caio', email: 'caio@x.io', password: 'caio-pass' });
    assert.equal(r.status, 202);
    assert.equal(r.data.status, 'pending');
    assert.equal(r.data.token, undefined);
    assert.equal(r.data.orgName, 'ACME');
    // the company creator is notified by email
    assert.equal(sent.at(-1).to, 'ana@acme.io');
    assert.match(sent.at(-1).html, /#\/admin\/members/);

    // no access while pending, and no second request
    const login = await call('POST', '/api/auth/login', { email: 'caio@x.io', password: 'caio-pass' });
    assert.equal(login.status, 403);
    assert.match(login.data.error, /waiting for an admin/);
    assert.equal((await call('POST', '/api/auth/login', { email: 'caio@x.io', password: 'wrong-pass' })).status, 401);
    assert.equal((await call('POST', '/api/auth/signup', { orgName: 'Other', name: 'Caio', email: 'caio@x.io', password: 'caio-pass' })).status, 409);

    // admins see it; members don't
    assert.equal((await call('GET', '/api/me', null, admin)).data.pendingRequests, 1);
    assert.equal((await call('GET', '/api/dashboard', null, admin)).data.admin.accessRequests, 1);
    const { requests } = (await call('GET', '/api/org/requests', null, admin)).data;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].hash, undefined);
    assert.equal((await call('GET', '/api/org/members', null, admin)).data.members.length, 2);

    // approve into a specific team only
    const squad = (await call('POST', '/api/teams', { name: 'Squad B' }, admin)).data.team;
    const boardA = (await call('POST', '/api/boards', { name: 'A', teamId: me.org.defaultTeamId }, admin)).data.board;
    const boardB = (await call('POST', '/api/boards', { name: 'B', teamId: squad.id }, admin)).data.board;
    const ok = await call('POST', `/api/org/requests/${requests[0].id}/approve`, { teamIds: [squad.id] }, admin);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.emailSent, true);
    assert.equal(sent.at(-1).to, 'caio@x.io');
    assert.equal((await call('POST', `/api/org/requests/${requests[0].id}/approve`, {}, admin)).status, 404);

    const caio = (await call('POST', '/api/auth/login', { email: 'caio@x.io', password: 'caio-pass' })).data.token;
    const caioMe = (await call('GET', '/api/me', null, caio)).data;
    assert.equal(caioMe.org.id, me.org.id);
    assert.equal(caioMe.user.role, 'member');
    const visible = (await call('GET', '/api/boards', null, caio)).data.boards.map((b) => b.id);
    assert.deepEqual(visible, [boardB.id]);
    assert.equal((await call('GET', `/api/boards/${boardA.id}`, null, caio)).status, 403);
    assert.equal((await call('GET', '/api/org/requests', null, caio)).status, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});


test('Administration → Modules: admins see the installed modules; foundation and retro are required, GMUD optional', async () => {
  const { call } = setup();
  const { admin, bia } = await bootstrap(call);
  const r = await call('GET', '/api/org/modules', null, admin);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.modules.map(({ id, enabled, required }) => ({ id, enabled, required })), [
    { id: 'foundation', enabled: true, required: true },
    { id: 'retro', enabled: true, required: true },
    { id: 'gmud', enabled: false, required: false },
    { id: 'goals', enabled: true, required: false },
  ]);
  assert.ok(r.data.modules.every((m) => m.name && m.description));
  assert.equal((await call('GET', '/api/org/modules', null, bia)).status, 403);
  const on = await call('PATCH', '/api/org/modules/gmud', { enabled: true }, admin);
  assert.equal(on.data.modules.find((m) => m.id === 'gmud').enabled, true);
  assert.deepEqual((await call('GET', '/api/dashboard', null, bia)).data.modules, ['foundation', 'retro', 'gmud', 'goals']);
});

test('groups from the identity provider merge with teams made in Rewind (no duplicates)', async () => {
  const realFetch = globalThis.fetch;
  let groups = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'x' });
    if (u.includes('openidconnect.googleapis.com')) return Response.json({ sub: 'bia', email: 'bia@acme.io', email_verified: true, name: 'Bia', hd: 'acme.io' });
    if (u.includes('cloudidentity')) return Response.json({ memberships: groups.map((g) => ({ groupKey: { id: g.id }, displayName: g.name })) });
    return realFetch(url);
  };
  try {
    const { call, app } = setup({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', GOOGLE_FETCH_GROUPS: 'true' });
    const { admin, bia, me } = await bootstrap(call);
    const login = async () => {
      const start = await app.fetch(new Request('https://rewind.test/api/auth/oauth/google/start'));
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const cb = await app.fetch(new Request(`https://rewind.test/api/auth/oauth/google/callback?code=c&state=${state}`));
      return new URLSearchParams(cb.headers.get('location').split('?')[1]);
    };
    const teams = async () => (await call('GET', '/api/me', null, admin)).data.teams;
    const biaTeams = async () => (await call('GET', '/api/me', null, bia)).data.user.teamIds;

    // 1. a team made in Rewind, then the same group arrives: linked, not duplicated
    const payments = (await call('POST', '/api/teams', { name: 'Payments Squad' }, admin)).data.team;
    const board = (await call('POST', '/api/boards', { name: 'Payments retro', teamId: payments.id }, admin)).data.board;
    groups = [{ id: 'payments@acme.io', name: 'payments squad ' }];
    assert.ok((await login()).get('code'));
    let list = await teams();
    assert.equal(list.filter((t) => /payments/i.test(t.name)).length, 1);
    assert.equal(list.find((t) => t.id === payments.id).groupKey, 'google:payments@acme.io');
    assert.ok((await biaTeams()).includes(payments.id));

    // 2. an older duplicate (group team first, manual one later): merged into the older, with its data
    groups = [{ id: 'ops@acme.io', name: 'Ops' }];
    await login();
    const opsGroup = (await teams()).find((t) => t.groupKey === 'google:ops@acme.io');
    // simulate a duplicate from before the rule: a manual "OPS" team with its own board, member, change and approver role
    const opsManual = (await call('POST', '/api/teams', { name: 'OPS' }, admin)).data.team;
    const opsBoard = (await call('POST', '/api/boards', { name: 'Ops board', teamId: opsManual.id }, admin)).data.board;
    const dora = (await call('POST', '/api/invites', { email: 'dora@acme.io', teamId: opsManual.id }, admin)).data.invites[0];
    await call('PATCH', '/api/org/modules/gmud', { enabled: true }, admin);
    const change = (await call('POST', '/api/gmud/changes', {}, admin)).data.change;
    await call('PATCH', `/api/gmud/changes/${change.id}`, { section: 'overview', data: { title: 'x', teamId: opsManual.id } }, admin);
    await call('PUT', '/api/gmud/settings', { approverTeams: { technical: [opsManual.id] } }, admin);

    await login(); // Bia again, still in the Ops group
    list = await teams();
    assert.equal(list.filter((t) => /^ops$/i.test(t.name)).length, 1);
    assert.equal(list.some((t) => t.id === opsManual.id), false); // the newer one went away
    const kept = list.find((t) => t.id === opsGroup.id);
    assert.equal(kept.groupKey, 'google:ops@acme.io');
    const boards = (await call('GET', '/api/boards', null, admin)).data.boards;
    assert.equal(boards.find((b) => b.id === opsBoard.id).teamId, kept.id);
    assert.equal(boards.find((b) => b.id === board.id).teamId, payments.id);
    assert.equal((await call('GET', `/api/invites/${dora.token}`)).data.teamName, 'Ops');
    assert.equal((await call('GET', `/api/gmud/changes/${change.id}`, null, admin)).data.change.overview.teamId, kept.id);
    assert.deepEqual((await call('GET', '/api/gmud/settings', null, admin)).data.settings.approverTeams.technical, [kept.id]);

    // 3. different names: merged by hand
    const pag = (await call('POST', '/api/teams', { name: 'Pagamentos' }, admin)).data.team;
    await call('POST', `/api/teams/${pag.id}/members`, { userId: me.user.id }, admin);
    assert.equal((await call('POST', `/api/teams/${pag.id}/merge`, { into: payments.id }, bia)).status, 403);
    assert.equal((await call('POST', `/api/teams/${pag.id}/merge`, { into: pag.id }, admin)).status, 400);
    assert.equal((await call('POST', `/api/teams/${kept.id}/merge`, { into: payments.id }, admin)).status, 409); // two different groups
    assert.equal((await call('POST', `/api/teams/${pag.id}/merge`, { into: payments.id }, admin)).status, 200);
    assert.equal((await teams()).some((t) => t.id === pag.id), false);
    assert.ok((await call('GET', '/api/me', null, admin)).data.user.teamIds.includes(payments.id));
  } finally {
    globalThis.fetch = realFetch;
  }
});
