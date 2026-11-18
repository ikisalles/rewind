import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlStorage } from '../src/storage/sql.js';
import { defineModule, fail, json } from '../src/index.js';
import { setupApp, signupCompany } from './helpers.js';

// The core runs on its own: no modules.
const setup = (env = {}) => setupApp({ env });
const bootstrap = signupCompany;

test('module system: routes, dashboard parts, admin onboarding and hooks', async () => {
  const notes = defineModule({
    id: 'notes',
    register(core) {
      core.route('GET', '/api/notes/ping', async (c) => json({ pong: true, admin: core.isAdmin(c) }));
      return {
        dashboard: async () => ({ hello: 'world' }),
        adminDashboard: async () => ({ onboarding: { firstNote: false }, tip: 'write one' }),
        beforeTeamDelete: async (_c, teamId) => teamId === 'locked' || fail(400, 'blocked by notes'),
      };
    },
  });
  const { call } = setupApp({ modules: [notes] });
  const { admin, bia } = await signupCompany(call);

  assert.deepEqual((await call('GET', '/api/notes/ping', null, bia)).data, { pong: true, admin: false });
  assert.equal((await call('GET', '/api/notes/ping')).status, 401); // module routes are private by default

  const dash = (await call('GET', '/api/dashboard', null, admin)).data;
  assert.deepEqual(dash.modules, ['notes']);
  assert.deepEqual(dash.notes, { hello: 'world' });
  assert.equal(dash.admin.onboarding.firstNote, false);
  assert.equal(dash.admin.onboarding.people, true);
  assert.deepEqual(dash.admin.notes, { tip: 'write one' });
  assert.equal((await call('GET', '/api/dashboard', null, bia)).data.admin, null);

  const team = (await call('POST', '/api/teams', { name: 'Squad' }, admin)).data.team;
  const del = await call('DELETE', `/api/teams/${team.id}`, null, admin);
  assert.equal(del.status, 400);
  assert.equal(del.data.error, 'blocked by notes');
});

test('module system: invalid or duplicated modules are rejected', () => {
  assert.throws(() => defineModule({ id: 'Bad Id', register() {} }));
  assert.throws(() => defineModule({ id: 'x' }));
  const m = defineModule({ id: 'x', register() {} });
  assert.equal(m.required, false); // modules are optional unless they say otherwise
  assert.throws(() => setupApp({ modules: [m, m] }), /twice/);
});

test('signup, login and auth required', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/me')).status, 401);
  await bootstrap(call);
  assert.equal((await call('POST', '/api/auth/login', { email: 'ana@acme.io', password: 'wrong' })).status, 401);
  const ok = await call('POST', '/api/auth/login', { email: 'ANA@acme.io', password: 'strong-pass' });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
});

test('same company name: denied request blocks that company, another name reactivates', async () => {
  const { call } = setup();
  const { admin } = await bootstrap(call);
  await call('POST', '/api/auth/signup', { orgName: 'acme', name: 'Dan', email: 'dan@x.io', password: 'dan-pass1' });
  const [req] = (await call('GET', '/api/org/requests', null, admin)).data.requests;
  const denied = await call('POST', `/api/org/requests/${req.id}/deny`, {}, admin);
  assert.equal(denied.status, 200);
  assert.equal(denied.data.emailSent, false); // email not configured in this setup
  assert.deepEqual((await call('GET', '/api/org/requests', null, admin)).data.requests, []);

  const login = await call('POST', '/api/auth/login', { email: 'dan@x.io', password: 'dan-pass1' });
  assert.equal(login.status, 403);
  assert.match(login.data.error, /denied/);
  const again = await call('POST', '/api/auth/signup', { orgName: 'ACME', name: 'Dan', email: 'dan@x.io', password: 'dan-pass1' });
  assert.equal(again.status, 403);

  // a different company name reactivates the sign-up
  const fresh = await call('POST', '/api/auth/signup', { orgName: 'Dan Labs', name: 'Dan', email: 'dan@x.io', password: 'dan-pass2' });
  assert.equal(fresh.status, 201);
  const danMe = (await call('GET', '/api/me', null, fresh.data.token)).data;
  assert.equal(danMe.org.name, 'Dan Labs');
  assert.equal(danMe.user.role, 'admin');
  assert.equal((await call('POST', '/api/auth/login', { email: 'dan@x.io', password: 'dan-pass2' })).status, 200);

  // renaming a company to a name in use is refused
  assert.equal((await call('PATCH', '/api/org', { name: 'Acme' }, fresh.data.token)).status, 409);
  assert.equal((await call('PATCH', '/api/org', { name: 'Dan Labs Inc' }, fresh.data.token)).status, 200);
  // the old name is free again
  assert.equal((await call('POST', '/api/auth/signup', { orgName: 'dan labs', name: 'Eve', email: 'eve@x.io', password: 'eve-pass1' })).status, 201);
});

test('companies created before the name index are still matched', async () => {
  const { call, storage } = setup();
  await bootstrap(call);
  // simulate a database from before the index existed
  for (const key of ['orgname:acme', 'meta:orgname-index:v1']) await storage.delete(key);
  const r = await call('POST', '/api/auth/signup', { orgName: 'Acme', name: 'Fay', email: 'fay@x.io', password: 'fay-pass1' });
  assert.equal(r.status, 202);
});

test('social login: company creation, auto-join and group teams', async () => {
  const realFetch = globalThis.fetch;
  let profile;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'x' });
    if (u.includes('openidconnect.googleapis.com')) return Response.json(profile);
    if (u.includes('cloudidentity')) return Response.json({ memberships: [{ groupKey: { id: 'payments-squad@acme.io' }, displayName: 'Payments Squad' }] });
    throw new Error('unexpected ' + u);
  };
  try {
    const { call, app } = setup({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', GOOGLE_FETCH_GROUPS: 'true' });
    const login = async (p) => {
      profile = p;
      const start = await app.fetch(new Request('https://rewind.test/api/auth/oauth/google/start'));
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const cb = await app.fetch(new Request(`https://rewind.test/api/auth/oauth/google/callback?code=c&state=${state}`));
      const back = new URLSearchParams(cb.headers.get('location').split('?')[1]);
      if (back.get('error')) return { error: back.get('error') };
      return (await call('POST', '/api/auth/exchange', { code: back.get('code') })).data;
    };
    const g = (email, name) => ({ sub: email, email, email_verified: true, name, hd: 'acme.io' });

    const first = await login(g('ana@acme.io', 'Ana'));
    const me = (await call('GET', '/api/me', null, first.token)).data;
    assert.equal(me.user.role, 'admin');
    assert.equal(me.user.onboarding, 'autoJoin');
    assert.equal(me.org.domain, 'acme.io');
    assert.ok(me.teams.some((t) => t.name === 'Payments Squad'));

    // auto-join still off: colleague is refused
    assert.match((await login(g('bia@acme.io', 'Bia'))).error, /invite/);

    await call('PATCH', '/api/org', { autoJoin: true }, first.token);
    const bia = await login(g('bia@acme.io', 'Bia'));
    const biaMe = (await call('GET', '/api/me', null, bia.token)).data;
    assert.equal(biaMe.user.role, 'member');
    assert.equal(biaMe.org.id, me.org.id);
    const team = biaMe.teams.find((t) => t.name === 'Payments Squad');
    assert.deepEqual(biaMe.user.teamIds, [team.id]);
    assert.equal((await call('GET', '/api/me', null, first.token)).data.user.onboarding ?? null, null); // cleared
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sql storage on real SQLite: values, prefixes, TTL, and runtimes that mangle big integers', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return t.skip('node:sqlite is not available in this Node version');
  }
  const db = new DatabaseSync(':memory:');
  const realDriver = {
    all: async (sql, p) => db.prepare(sql).all(...p),
    run: async (sql, p) => void db.prepare(sql).run(...p),
  };
  // what the edge runtime did: integer columns came back wrong (here: wrapped to 32 bits)
  const manglingDriver = {
    ...realDriver,
    all: async (sql, p) => (await realDriver.all(sql, p)).map((r) => ('exp' in r && r.exp !== null ? { ...r, exp: r.exp | 0 } : r)),
  };
  for (const [name, driver] of [['sqlite', realDriver], ['mangling runtime', manglingDriver]]) {
    db.exec('DROP TABLE IF EXISTS rewind_kv');
    const s = sqlStorage(driver);
    await s.put('a:1', { x: 1 });
    await s.put('a:2', { x: 2 }, { ttl: 60 * 60 * 24 * 30 }); // a 30-day session
    await s.put('b:1', { x: 3 });
    assert.deepEqual(await s.get('a:2'), { x: 2 }, name);
    assert.deepEqual(await s.list('a:'), [{ x: 1 }, { x: 2 }], name);
    await s.put('a:3', { x: 4 }, { ttl: -1 }); // already expired
    assert.equal(await s.get('a:3'), null, name);
    assert.deepEqual((await s.list('a:')).map((v) => v.x), [1, 2], name);
    await s.delete('a:1');
    assert.equal(await s.get('a:1'), null, name);
    assert.deepEqual(await s.get('b:1'), { x: 3 }, name);
    // patch changes only the given fields, inside the database (arrays replace, null removes)
    await s.put('p:1', { name: 'S', columns: [1, 2], hidden: true, share: 'x' });
    await s.patch('p:1', { hidden: false, columns: [], share: null });
    assert.deepEqual(await s.get('p:1'), { name: 'S', columns: [], hidden: false }, name);
    await s.patch('missing', { a: 1 });
    assert.equal(await s.get('missing'), null, name);
    // touch: a revision that only grows
    await s.touch('p:1', 'rev', 1000);
    await s.touch('p:1', 'rev', 10); // a clock behind still moves it forward
    assert.equal((await s.get('p:1')).rev, 1001, name);
  }
});

test('team members: add and remove one person, keeping their other teams', async () => {
  const { call } = setup();
  const { admin, bia, me } = await bootstrap(call);
  const squad = (await call('POST', '/api/teams', { name: 'Squad' }, admin)).data.team;
  const biaId = (await call('GET', '/api/me', null, bia)).data.user.id;

  const added = await call('POST', `/api/teams/${squad.id}/members`, { userId: biaId }, admin);
  assert.equal(added.status, 201);
  assert.deepEqual(added.data.member.teamIds.sort(), [me.org.defaultTeamId, squad.id].sort());
  assert.equal((await call('POST', `/api/teams/${squad.id}/members`, { userId: biaId }, admin)).status, 200); // already in

  const removed = await call('DELETE', `/api/teams/${squad.id}/members/${biaId}`, null, admin);
  assert.deepEqual(removed.data.member.teamIds, [me.org.defaultTeamId]);
  assert.equal(removed.data.member.cred, undefined);

  assert.equal((await call('POST', `/api/teams/${squad.id}/members`, { userId: biaId }, bia)).status, 403);
  assert.equal((await call('POST', `/api/teams/${squad.id}/members`, { userId: 'nobody' }, admin)).status, 404);
  assert.equal((await call('POST', '/api/teams/nope/members', { userId: biaId }, admin)).status, 404);
});

test('durable storage: every key lives in its owner object, so every list stays in one object', async () => {
  const { durableStorage, shardOf } = await import('../src/storage/durable.js');
  const { fakeStoreNamespace } = await import('./fake-durable.js');
  const shards = { user: 'org', team: 'org', board: 'org', sprint: 'board', note: 'sprint', vote: 'sprint', action: 'sprint' };
  const ns = fakeStoreNamespace('kv');
  const s = durableStorage(ns, { shards });
  await s.put('user:o1:u1', { id: 'u1' });
  await s.put('user:o2:u9', { id: 'u9' });
  await s.put('board:o1:b1', { id: 'b1' });
  await s.put('sprint:b1:s1', { id: 's1' });
  await s.put('note:s1:n1', { id: 'n1' });
  await s.put('note:s1:n2', { id: 'n2' });
  await s.put('session:t1', { userId: 'u1' }, { ttl: 60 });
  assert.equal(shardOf('note:s1:n1', shards), 'sprint:s1');
  assert.equal(shardOf('sprint:b1:s1', shards), 'board:b1');
  assert.equal(shardOf('session:t1', shards), 'global');
  assert.deepEqual([...ns.objects.keys()].sort(), ['rewind-store:board:b1', 'rewind-store:global', 'rewind-store:org:o1', 'rewind-store:org:o2', 'rewind-store:sprint:s1']);
  assert.deepEqual((await s.list('note:s1:')).map((n) => n.id), ['n1', 'n2']);
  assert.deepEqual((await s.list('user:o1:')).map((u) => u.id), ['u1']);
  await s.patch('note:s1:n1', { text: 'x' });
  await s.touch('sprint:b1:s1', 'rev', 5);
  assert.deepEqual(await s.get('note:s1:n1'), { id: 'n1', text: 'x' });
  assert.equal((await s.get('sprint:b1:s1')).rev, 5);
  await s.put('session:old', { userId: 'u1' }, { ttl: -1 });
  assert.equal(await s.get('session:old'), null);
});

test('invite lookup shows the team and the role being offered', async () => {
  const { call } = setup();
  const { admin, me } = await bootstrap(call);
  const asMember = (await call('POST', '/api/invites', { email: 'carl@acme.io', teamId: me.org.defaultTeamId }, admin)).data.invites[0];
  const asAdmin = (await call('POST', '/api/invites', { email: 'dora@acme.io', teamId: me.org.defaultTeamId, role: 'admin' }, admin)).data.invites[0];
  const a = (await call('GET', `/api/invites/${asMember.token}`)).data;
  const b = (await call('GET', `/api/invites/${asAdmin.token}`)).data;
  assert.deepEqual([a.teamName, a.role], ['General', 'member']);
  assert.deepEqual([b.teamName, b.role], ['General', 'admin']);
});

test('personal integrations: tokens are sealed, never returned, and kept per person', async () => {
  const { call, storage } = setupApp({ env: { SECRETS_KEY: 'test-secret' } });
  const { admin, bia, me } = await bootstrap(call);
  const empty = (await call('GET', '/api/me/integrations', null, admin)).data.integrations;
  assert.deepEqual(empty, { jira: { configured: false }, github: { configured: false } });

  assert.equal((await call('PUT', '/api/me/integrations/jira', { site: 'acme.atlassian.net', email: 'ana@acme.io' }, admin)).status, 400); // no token
  assert.equal((await call('PUT', '/api/me/integrations/jira', { site: 'http://acme.atlassian.net', email: 'ana@acme.io', token: 'x' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/me/integrations/gitlab', { token: 'x' }, admin)).status, 404);

  const jira = await call('PUT', '/api/me/integrations/jira', { site: 'acme.atlassian.net/jira', email: 'ana@acme.io', token: 'ATATT-super-secret-1234' }, admin);
  assert.equal(jira.status, 200);
  assert.equal(jira.data.integrations.jira.site, 'https://acme.atlassian.net');
  assert.equal(jira.data.integrations.jira.tokenHint, '…1234');
  assert.equal(JSON.stringify(jira.data).includes('super-secret'), false);
  await call('PUT', '/api/me/integrations/github', { token: 'ghp_abcdefgh5678' }, admin);

  const raw = await storage.get(`integration:${me.org.id}:${me.user.id}`);
  assert.match(raw.jira.token, /^aesgcm:/);
  const { openSecret } = await import('../src/lib/crypto.js');
  assert.equal(await openSecret(raw.jira.token, 'test-secret'), 'ATATT-super-secret-1234');

  // changing only the site keeps the saved token
  const moved = await call('PUT', '/api/me/integrations/jira', { site: 'https://new.atlassian.net', email: 'ana@acme.io' }, admin);
  assert.equal(moved.data.integrations.jira.tokenHint, '…1234');
  assert.equal(await openSecret((await storage.get(`integration:${me.org.id}:${me.user.id}`)).jira.token, 'test-secret'), 'ATATT-super-secret-1234');

  assert.equal((await call('GET', '/api/me/integrations', null, bia)).data.integrations.github.configured, false); // per person
  const left = (await call('DELETE', '/api/me/integrations/github', null, admin)).data.integrations;
  assert.deepEqual([left.github.configured, left.jira.configured], [false, true]);
  assert.equal((await call('GET', '/api/me/integrations')).status, 401);
});

test('module system: admins turn optional modules on and off per company', async () => {
  const mk = (id, extra = {}) => defineModule({ id, name: id.toUpperCase(), ...extra, register: (core) => (core.route('GET', `/api/${id}/ping`, async () => json({ id })), { dashboard: async () => ({ id }) }) });
  const { call } = setupApp({ modules: [mk('base', { required: true }), mk('extra'), mk('later', { defaultEnabled: false })] });
  const { admin, bia } = await signupCompany(call);

  assert.deepEqual((await call('GET', '/api/me', null, bia)).data.modules, ['base', 'extra']);
  assert.equal((await call('GET', '/api/later/ping', null, bia)).status, 404);
  assert.equal((await call('GET', '/api/extra/ping', null, bia)).status, 200);

  assert.equal((await call('PATCH', '/api/org/modules/base', { enabled: false }, admin)).status, 400);
  assert.equal((await call('PATCH', '/api/org/modules/extra', { enabled: false }, bia)).status, 403);
  const off = await call('PATCH', '/api/org/modules/extra', { enabled: false }, admin);
  assert.deepEqual(off.data.modules.map((m) => [m.id, m.enabled]), [['base', true], ['extra', false], ['later', false]]);
  await call('PATCH', '/api/org/modules/later', { enabled: true }, admin);

  assert.deepEqual((await call('GET', '/api/me', null, bia)).data.modules, ['base', 'later']);
  assert.equal((await call('GET', '/api/extra/ping', null, bia)).status, 404);
  assert.equal((await call('GET', '/api/later/ping', null, bia)).status, 200);
  const dash = (await call('GET', '/api/dashboard', null, bia)).data;
  assert.deepEqual([dash.modules, dash.extra, dash.later], [['base', 'later'], undefined, { id: 'later' }]);
});
