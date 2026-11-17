// Test helpers shared by the core and the modules: an in-memory app and HTTP-like calls.
import { memoryStorage } from '../src/storage/memory.js';
import { createApp } from '../src/app.js';

export function setupApp({ modules = [], env = {} } = {}) {
  const storage = memoryStorage();
  const app = createApp({ storage, modules, env: { APP_URL: 'https://rewind.test', ...env } });
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

// Company "ACME" with an admin (Ana) and a member invited into the default team (Bia).
export async function signupCompany(call) {
  const { data } = await call('POST', '/api/auth/signup', { orgName: 'ACME', name: 'Ana', email: 'ana@acme.io', password: 'strong-pass' });
  const admin = data.token;
  const me = (await call('GET', '/api/me', null, admin)).data;
  const inv = (await call('POST', '/api/invites', { email: 'bia@acme.io', teamId: me.org.defaultTeamId }, admin)).data;
  const bia = (await call('POST', `/api/invites/${inv.invites[0].token}/accept`, { name: 'Bia', password: '12345678' })).data.token;
  return { admin, bia, me };
}
