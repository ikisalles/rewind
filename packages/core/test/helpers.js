// Test helpers shared by the core and the modules: an in-memory app and HTTP-like calls.
import { memoryStorage } from '../src/storage/memory.js';
import { durableStorage } from '../src/storage/durable.js';
import { createApp, CORE_SHARDS } from '../src/app.js';
import { fakeStoreNamespace } from './fake-durable.js';

// Durable storage has no in-process `data` map; tests that peek at keys get one built from the
// keys written through this storage.
function withMemoryView(storage) {
  const keys = new Set();
  return {
    ...storage,
    data: { keys: () => keys.values() },
    put: async (k, v, o) => (keys.add(k), storage.put(k, v, o)),
    delete: async (k) => (keys.delete(k), storage.delete(k)),
  };
}

// REWIND_TEST_STORAGE=durable-sql | durable-kv runs the same tests on Durable Object storage.
const storageMode = process.env.REWIND_TEST_STORAGE || 'memory';

export function setupApp({ modules = [], env = {}, realtime = null } = {}) {
  const shards = Object.assign({}, CORE_SHARDS, ...modules.map((m) => m.shards || {}));
  const storage = storageMode.startsWith('durable')
    ? withMemoryView(durableStorage(fakeStoreNamespace(storageMode === 'durable-kv' ? 'kv' : 'sql'), { shards }))
    : memoryStorage();
  const app = createApp({ storage, modules, realtime, env: { APP_URL: 'https://rewind.test', ...env } });
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
  const ctx = { app, storage, call };
  setupApp.last = ctx; // lets a test reach the storage of the app it just created
  return ctx;
}

// Company "ACME" with an admin (Ana) and a member invited into the default team (Bia).
export async function signupCompany(call) {
  const { data } = await call('POST', '/api/auth/signup', { orgName: 'ACME', name: 'Ana', email: 'ana@acme.io', password: 'strong-pass' });
  const admin = data.token;
  const me = (await call('GET', '/api/me', null, admin)).data;
  const inv = (await call('POST', '/api/invites', { email: 'bia@acme.io', teamId: me.org.defaultTeamId }, admin)).data;
  const bia = (await call('POST', `/api/invites/${inv.invites[0].token}/accept`, { name: 'Bia', password: '12345678' })).data.token;
  return { admin, bia, me };
}
