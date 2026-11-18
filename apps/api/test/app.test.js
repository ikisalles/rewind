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

test('the API ships the retro and changes (GMUD) modules; GMUD starts off', async () => {
  assert.deepEqual(MODULES.map((m) => m.id), ['retro', 'gmud']);
  const { call } = setup();
  const { admin } = await bootstrap(call);
  const dash = (await call('GET', '/api/dashboard', null, admin)).data;
  assert.deepEqual(dash.modules, ['retro']);
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


test('Administration → Modules: admins see the installed modules; retro is required, GMUD optional', async () => {
  const { call } = setup();
  const { admin, bia } = await bootstrap(call);
  const r = await call('GET', '/api/org/modules', null, admin);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.modules.map(({ id, enabled, required }) => ({ id, enabled, required })), [
    { id: 'retro', enabled: true, required: true },
    { id: 'gmud', enabled: false, required: false },
  ]);
  assert.ok(r.data.modules.every((m) => m.name && m.description));
  assert.equal((await call('GET', '/api/org/modules', null, bia)).status, 403);
  const on = await call('PATCH', '/api/org/modules/gmud', { enabled: true }, admin);
  assert.equal(on.data.modules[1].enabled, true);
  assert.deepEqual((await call('GET', '/api/dashboard', null, bia)).data.modules, ['retro', 'gmud']);
});
