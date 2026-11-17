import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from '../src/storage/memory.js';
import { readYourWrites } from '../src/storage/consistency.js';
import { createApp } from '../src/app.js';

// A store whose reads only see a write `lagMs` after it happened (like a read replica).
function laggyStorage(lagMs) {
  const main = memoryStorage();
  const replica = memoryStorage();
  const later = (fn) => setTimeout(fn, lagMs);
  return {
    get: (k) => replica.get(k),
    list: (p) => replica.list(p),
    put: async (k, v, o) => (await main.put(k, v, o), later(() => replica.put(k, v, o))),
    delete: async (k) => (await main.delete(k), later(() => replica.delete(k))),
  };
}

test('read-your-writes: recent writes are visible at once, in gets and lists', async () => {
  const db = readYourWrites(laggyStorage(10_000), { retryPrefixes: [] });
  await db.put('note:s1:a', { id: 'a', text: 'one' });
  await db.put('note:s1:b', { id: 'b', text: 'two' });
  assert.deepEqual(await db.get('note:s1:a'), { id: 'a', text: 'one' });
  assert.deepEqual((await db.list('note:s1:')).map((n) => n.id), ['a', 'b']);
  await db.delete('note:s1:a');
  assert.equal(await db.get('note:s1:a'), null);
  assert.deepEqual((await db.list('note:s1:')).map((n) => n.id), ['b']);
  // callers can't change the remembered copy by mutating what they got
  const b = await db.get('note:s1:b');
  b.text = 'changed';
  assert.equal((await db.get('note:s1:b')).text, 'two');
});

test('read-your-writes: a miss on a key that should exist is read again', async () => {
  const store = laggyStorage(250);
  // another instance wrote it: nothing in this instance's memory
  const writer = readYourWrites(store, { retryPrefixes: [] });
  const reader = readYourWrites(store, { retryPrefixes: ['session:'], delays: [100, 100, 100, 100] });
  await writer.put('session:t', { userId: 'u' });
  assert.deepEqual(await reader.get('session:t'), { userId: 'u' });
  // keys where a miss is normal answer right away
  const t0 = Date.now();
  assert.equal(await reader.get('useremail:nobody@x.io'), null);
  assert.ok(Date.now() - t0 < 50);
});

test('eventual consistency: sign up then load the account right away', async () => {
  const app = createApp({ storage: laggyStorage(300), consistency: 'eventual', env: { APP_URL: 'https://rewind.test' } });
  const call = async (method, path, body, token) => {
    const res = await app.fetch(new Request(`https://rewind.test${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, data: await res.json() };
  };
  const { data } = await call('POST', '/api/auth/signup', { orgName: 'Lag Co', name: 'Ana', email: 'ana@lag.io', password: 'strong-pass' });
  const me = await call('GET', '/api/me', null, data.token);
  assert.equal(me.status, 200);
  assert.equal(me.data.org.name, 'Lag Co');
  const login = await call('POST', '/api/auth/login', { email: 'ana@lag.io', password: 'strong-pass' });
  assert.equal((await call('GET', '/api/me', null, login.data.token)).status, 200);
});
