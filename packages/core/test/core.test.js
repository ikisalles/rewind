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
    assert.equal((await call('GET', '/api/me', null, first.token)).data.user.onboarding, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sql storage adapter round trip', async () => {
  // Fake driver over a Map, emulating the SQL the adapter sends.
  const rows = new Map();
  const driver = {
    async run(sql, p) {
      if (sql.startsWith('INSERT')) rows.set(p[0], { v: p[1], exp: p[2] });
      if (sql.startsWith('DELETE')) rows.delete(p[0]);
    },
    async all(sql, p) {
      if (sql.includes('k = ?')) return rows.has(p[0]) ? [rows.get(p[0])] : [];
      return [...rows.keys()].filter((k) => k >= p[0] && k < p[1]).sort().map((k) => rows.get(k));
    },
  };
  const s = sqlStorage(driver);
  await s.put('a:1', { x: 1 });
  await s.put('a:2', { x: 2 });
  await s.put('b:1', { x: 3 });
  assert.deepEqual(await s.list('a:'), [{ x: 1 }, { x: 2 }]);
  await s.delete('a:1');
  assert.equal(await s.get('a:1'), null);
});
