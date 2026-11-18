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

test('company sign-in: own OIDC / Google credentials, scoped to the company, SSO required with notices', async () => {
  const realFetch = globalThis.fetch;
  const seen = { tokenBodies: [], emails: [] };
  let profile;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://idp.acme.io/.well-known/openid-configuration') return Response.json({ authorization_endpoint: 'https://idp.acme.io/authorize', token_endpoint: 'https://idp.acme.io/token', userinfo_endpoint: 'https://idp.acme.io/userinfo' });
    if (u === 'https://idp.acme.io/token' || u.includes('oauth2.googleapis.com/token')) {
      seen.tokenBodies.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return Response.json({ access_token: 'x' });
    }
    if (u === 'https://idp.acme.io/userinfo' || u.includes('openidconnect.googleapis.com')) return Response.json(profile);
    if (u.includes('api.resend.com')) {
      seen.emails.push(JSON.parse(init.body));
      return Response.json({ id: 'e' });
    }
    throw new Error('unexpected ' + u);
  };
  try {
    // the platform also offers Google with its own credentials
    const { call, app } = setup({ GOOGLE_CLIENT_ID: 'platform-id', GOOGLE_CLIENT_SECRET: 'platform-secret', SECRETS_KEY: 'k', RESEND_API_KEY: 'r', EMAIL_FROM: 'Rewind <r@x.io>' });
    const { admin, bia, me } = await signupCompany(call); // ACME: Ana (admin), Bia (member), both with passwords
    const other = (await call('POST', '/api/auth/signup', { orgName: 'Other', name: 'Olga', email: 'olga@other.io', password: 'strong-pass' })).data.token;

    const flow = async (provider, org, p, invite) => {
      profile = p;
      const qs = new URLSearchParams({ ...(org ? { org } : {}), ...(invite ? { invite } : {}) });
      const start = await app.fetch(new Request(`https://rewind.test/api/auth/oauth/${provider}/start?${qs}`));
      const loc = new URL(start.headers.get('location'));
      const state = loc.searchParams.get('state');
      const cb = await app.fetch(new Request(`https://rewind.test/api/auth/oauth/${provider}/callback?code=c&state=${state}`));
      const back = new URLSearchParams(cb.headers.get('location').split('?')[1]);
      if (back.get('error')) return { error: back.get('error'), authorize: loc };
      return { ...(await call('POST', '/api/auth/exchange', { code: back.get('code') })).data, authorize: loc };
    };
    const oidcUser = (email, name, groups = []) => ({ sub: email, email, email_verified: true, name, groups });

    // admins only; the issuer must answer OpenID discovery; secrets never come back
    assert.equal((await call('PUT', '/api/org/auth/providers/oidc', { clientId: 'acme-app', clientSecret: 'acme-secret', issuer: 'https://idp.acme.io' }, bia)).status, 403);
    assert.equal((await call('PUT', '/api/org/auth/providers/oidc', { clientId: 'a', clientSecret: 'b', issuer: 'http://idp.acme.io' }, admin)).status, 400);
    const saved = await call('PUT', '/api/org/auth/providers/oidc', { clientId: 'acme-app', clientSecret: 'acme-secret-1234', issuer: 'https://idp.acme.io/', label: 'Okta' }, admin);
    assert.equal(saved.status, 200);
    assert.equal(JSON.stringify(saved.data).includes('acme-secret'), false);
    assert.deepEqual([saved.data.auth.providers.oidc.hasSecret, saved.data.auth.providers.oidc.secretHint, saved.data.ready], [true, '…1234', [{ id: 'oidc', label: 'Okta' }]]);
    const view = (await call('GET', '/api/org/auth', null, admin)).data;
    assert.equal(view.redirectUris.oidc, 'https://rewind.test/api/auth/oauth/oidc/callback');
    assert.deepEqual(view.platform.map((p) => p.id), ['google']);

    // domains: valid, not public, not another company's
    assert.equal((await call('PUT', '/api/org/auth/policy', { domains: ['gmail.com'] }, admin)).status, 400);
    assert.equal((await call('PUT', '/api/org/auth/policy', { domains: ['other.io'] }, other)).status, 200);
    assert.equal((await call('PUT', '/api/org/auth/policy', { domains: ['other.io'] }, admin)).status, 409);
    await call('PUT', '/api/org/auth/policy', { domains: ['acme.io'] }, admin);

    // discovery: the email leads to the company and its sign-in
    const d = (await call('POST', '/api/auth/discover', { email: 'bia@acme.io' })).data;
    assert.deepEqual([d.org.name, d.sso, d.password], ['ACME', [{ id: 'oidc', label: 'Okta' }], true]);
    assert.deepEqual((await call('POST', '/api/auth/discover', { email: 'new@acme.io' })).data.sso, [{ id: 'oidc', label: 'Okta' }]);
    assert.deepEqual((await call('POST', '/api/auth/discover', { email: 'x@nowhere.io' })).data, { org: null, sso: [], password: true });

    // existing member through the company IdP, with the company's credentials (not the platform's)
    const biaSso = await flow('oidc', me.org.id, oidcUser('bia@acme.io', 'Bia'));
    assert.equal(biaSso.authorize.origin + biaSso.authorize.pathname, 'https://idp.acme.io/authorize');
    assert.equal(biaSso.authorize.searchParams.get('client_id'), 'acme-app');
    assert.deepEqual([seen.tokenBodies.at(-1).client_id, seen.tokenBodies.at(-1).client_secret], ['acme-app', 'acme-secret-1234']);
    const biaMe = (await call('GET', '/api/me', null, biaSso.token)).data;
    assert.deepEqual([biaMe.org.id, biaMe.user.email, biaMe.user.providers.includes('oidc')], [me.org.id, 'bia@acme.io', true]);
    assert.deepEqual(biaMe.managedBy, ['Okta']); // shown in My account: the account comes from Okta

    // new person of the domain: account in ACME (never a new company), groups → teams
    const cara = await flow('oidc', me.org.id, oidcUser('cara@acme.io', 'Cara', ['platform-team']));
    const caraMe = (await call('GET', '/api/me', null, cara.token)).data;
    assert.deepEqual([caraMe.org.id, caraMe.user.role], [me.org.id, 'member']);
    assert.ok(caraMe.teams.some((t) => t.name === 'platform-team'));
    // outside the company's domains, or someone from another company: refused
    assert.match((await flow('oidc', me.org.id, oidcUser('eve@evil.io', 'Eve'))).error, /Ask an admin for an invite/);
    assert.match((await flow('oidc', me.org.id, oidcUser('olga@other.io', 'Olga'))).error, /another company/);

    // a company's own Google app works the same way; the platform's Google still works for others
    await call('PUT', '/api/org/auth/providers/google', { clientId: 'acme-google', clientSecret: 'acme-g-secret' }, admin);
    const viaGoogle = await flow('google', me.org.id, { sub: 'b', email: 'bia@acme.io', email_verified: true, name: 'Bia', hd: 'acme.io' });
    assert.equal(viaGoogle.authorize.searchParams.get('client_id'), 'acme-google');
    assert.ok(viaGoogle.token);
    const platform = await flow('google', null, { sub: 'z', email: 'zoe@zeta.io', email_verified: true, name: 'Zoe', hd: 'zeta.io' });
    assert.equal(platform.authorize.searchParams.get('client_id'), 'platform-id');
    assert.ok(platform.token);

    // requiring SSO: everyone is told (email + notice); members can't use passwords, admins can
    seen.emails.length = 0;
    const policy = await call('PUT', '/api/org/auth/policy', { domains: ['acme.io'], requireSso: true }, admin);
    assert.deepEqual(policy.data.notified, { people: 3, emailed: 3, emailEnabled: true });
    assert.deepEqual(seen.emails.map((e) => e.to).sort(), ['ana@acme.io', 'bia@acme.io', 'cara@acme.io']);
    assert.match(seen.emails.find((e) => e.to === 'bia@acme.io').html, /no longer works/);
    assert.doesNotMatch(seen.emails.find((e) => e.to === 'ana@acme.io').html, /no longer works/); // admins keep the password
    const notice = (await call('GET', '/api/me', null, bia)).data.user.notice;
    assert.deepEqual([notice.type, notice.required, notice.providers], ['signin', true, ['Google', 'Okta']]);

    const pw = await call('POST', '/api/auth/login', { email: 'bia@acme.io', password: '12345678' });
    assert.deepEqual([pw.status, pw.data.code], [403, 'sso_required']);
    assert.match(pw.data.error, /Google or Okta/);
    assert.equal((await call('POST', '/api/auth/login', { email: 'ana@acme.io', password: 'strong-pass' })).status, 200);
    assert.equal((await call('POST', '/api/auth/discover', { email: 'bia@acme.io' })).data.password, false);
    // the platform's Google is no longer accepted for ACME members; the company's is
    assert.match((await flow('google', null, { sub: 'b', email: 'bia@acme.io', email_verified: true, name: 'Bia', hd: 'acme.io' })).error, /signs in with/);
    const again = await flow('oidc', me.org.id, oidcUser('bia@acme.io', 'Bia Souza'));
    assert.equal((await call('GET', '/api/me', null, again.token)).data.user.name, 'Bia Souza'); // the provider owns the name
    assert.equal((await call('GET', '/api/me', null, again.token)).data.user.notice ?? null, null); // signing in the new way clears it
    assert.equal((await call('DELETE', '/api/me/notice', null, cara.token)).status, 200);
    assert.equal((await call('GET', '/api/me', null, cara.token)).data.user.notice ?? null, null);

    // invites: no password route for members while SSO is required; the invite says how
    const inv = (await call('POST', '/api/invites', { email: 'dan@acme.io', teamId: me.org.defaultTeamId }, admin)).data.invites[0];
    const look = (await call('GET', `/api/invites/${inv.token}`)).data;
    assert.deepEqual([look.password, look.sso.map((p) => p.id), look.orgId], [false, ['google', 'oidc'], me.org.id]);
    assert.equal((await call('POST', `/api/invites/${inv.token}/accept`, { name: 'Dan', password: 'strong-pass' })).data.code, 'sso_required');
    const dan = await flow('oidc', me.org.id, oidcUser('dan@acme.io', 'Dan'), inv.token);
    assert.ok(dan.token);

    // removing the last provider never locks people out
    await call('DELETE', '/api/org/auth/providers/google', null, admin);
    const last = await call('DELETE', '/api/org/auth/providers/oidc', null, admin);
    assert.equal(last.data.auth.requireSso, false);
    assert.equal((await call('POST', '/api/auth/login', { email: 'bia@acme.io', password: '12345678' })).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('themes are personal: each person saves their own, the company has none', async () => {
  const { call } = setup();
  const { admin, bia } = await signupCompany(call);
  assert.equal((await call('PATCH', '/api/me', { theme: 'neon' }, bia)).status, 400);
  assert.equal((await call('PATCH', '/api/me', { theme: 'light' }, bia)).data.user.theme, 'light');
  assert.equal((await call('PATCH', '/api/me', { theme: 'ocean' }, admin)).data.user.theme, 'ocean');
  assert.equal((await call('GET', '/api/me', null, bia)).data.user.theme, 'light');
  assert.equal((await call('GET', '/api/me', null, admin)).data.user.theme, 'ocean');
  // the company no longer stores colors
  await call('PATCH', '/api/org', { theme: { accent: '#ff0000' } }, admin);
  assert.equal((await call('GET', '/api/me', null, admin)).data.org.theme?.accent, undefined);
});

test('company logo: fetched from the company site when a sign-in is connected, shown only then', async () => {
  const { iconLinks } = await import('../src/lib/logo.js');
  assert.deepEqual(
    iconLinks('<head><link rel="icon" href="/fav.ico"><link rel="apple-touch-icon" href="/touch.png"><link rel="icon" sizes="32x32 192x192" href="https://cdn.acme.io/i192.png"><link rel="stylesheet" href="/x.css"></head>', 'https://acme.io/'),
    ['https://cdn.acme.io/i192.png', 'https://acme.io/touch.png', 'https://acme.io/fav.ico'],
  );

  const realFetch = globalThis.fetch;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u === 'https://idp.acme.io/.well-known/openid-configuration') return Response.json({ authorization_endpoint: 'https://idp.acme.io/a', token_endpoint: 'https://idp.acme.io/t', userinfo_endpoint: 'https://idp.acme.io/u' });
    if (u === 'https://acme.io/') return new Response('<html><head><link rel="apple-touch-icon" href="/touch.png"></head></html>', { headers: { 'content-type': 'text/html' } });
    if (u === 'https://acme.io/touch.png') return new Response(png, { headers: { 'content-type': 'image/png' } });
    if (u === 'https://nologo.io/') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    if (u.startsWith('https://nologo.io/')) return new Response('nope', { status: 404 });
    throw new Error('unexpected ' + u);
  };
  try {
    const { call, app, storage } = setup({ SECRETS_KEY: 'k' });
    const { admin, bia, me: first } = await signupCompany(call);
    // no sign-in connected: no logo, and refreshing is refused
    assert.equal((await call('GET', '/api/me', null, admin)).data.org.logo, null);
    assert.equal((await call('POST', '/api/org/logo/refresh', {}, admin)).status, 400);

    // connecting the company's sign-in with its domain brings the logo from acme.io
    await call('PUT', '/api/org/auth/providers/oidc', { clientId: 'a', clientSecret: 'b', issuer: 'https://idp.acme.io' }, admin);
    await call('PUT', '/api/org/auth/policy', { domains: ['acme.io'] }, admin);
    const logo = (await call('GET', '/api/me', null, bia)).data.org.logo;
    assert.equal(logo.from, 'https://acme.io/touch.png');
    assert.match(logo.url, new RegExp(`^/api/orgs/${first.org.id}/logo\\?v=`));
    // the image lives apart from the company record, served by its own cacheable URL (no session needed)
    assert.equal(JSON.stringify(await storage.get(`org:${first.org.id}`)).includes('base64'), false);
    const img = await app.fetch(new Request(`https://rewind.test${logo.url}`));
    assert.deepEqual([img.status, img.headers.get('content-type'), img.headers.get('cache-control')], [200, 'image/png', 'public, max-age=31536000, immutable']);
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [...png]);
    assert.equal((await app.fetch(new Request('https://rewind.test/api/orgs/nope/logo'))).status, 404);
    assert.equal((await call('GET', '/api/me', null, bia)).status, 200); // other API answers stay no-store

    // removed by an admin: gone, and not fetched back on its own
    assert.equal((await call('DELETE', '/api/org/logo', null, bia)).status, 403);
    await call('DELETE', '/api/org/logo', null, admin);
    await call('PUT', '/api/org/auth/policy', { domains: ['acme.io'] }, admin);
    assert.equal((await call('GET', '/api/me', null, admin)).data.org.logo, null);
    assert.ok((await call('POST', '/api/org/logo/refresh', {}, admin)).data.logo.url);

    // the sign-in goes away: the logo isn't shown anymore
    await call('DELETE', '/api/org/auth/providers/oidc', null, admin);
    assert.equal((await call('GET', '/api/me', null, admin)).data.org.logo, null);

    // a site without icons
    await call('PUT', '/api/org/auth/providers/oidc', { clientId: 'a', clientSecret: 'b', issuer: 'https://idp.acme.io' }, admin);
    await call('PUT', '/api/org/auth/policy', { domains: ['nologo.io'] }, admin);
    await call('DELETE', '/api/org/logo', null, admin);
    assert.equal((await call('POST', '/api/org/logo/refresh', {}, admin)).status, 404);
    assert.ok(seen.every((u) => u.startsWith('https://'))); // only https, only the company's own hosts (plus its IdP)
  } finally {
    globalThis.fetch = realFetch;
  }
});
