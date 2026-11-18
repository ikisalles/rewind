// Azion Functions entry point. The application runs this function for /api/*;
// every other path is served from Object Storage (see azion.config.mjs).
//
// Storage: Azion SQL Database (SQLite compatible).
//   - Reads (and, when the runtime allows it, writes) go through the runtime
//     binding `globalThis.Azion.Sql`, the same one the official `azion/sql`
//     library uses inside Functions.
//   - If a write fails in the runtime and AZION_TOKEN is set, it is retried
//     through the SQL Database REST API (v4), which always writes to the main
//     instance. Set REWIND_SQL_MODE=api to send every statement through the API.
//
// Configuration comes from the function's environment variables (Azion.env).
//
// Live updates: one RewindRoom Durable Object per sprint. On Azion a Durable Object binding is an
// environment variable whose value names the class:
//   REWIND_ROOMS = durable-object:RewindRoom
// and the namespace then arrives as env.REWIND_ROOMS in fetch(request, env, ctx). That is why this
// function uses the ES Modules handler (export default { fetch }) and exports the class.
// Without the binding, live updates are off and the web app polls.

import { sqlStorage } from '@rewind/core/storage/sql';
import { durableStorage } from '@rewind/core/storage/durable';
import { durableRealtime } from '@rewind/core/realtime/durable';
import { createRewind, SHARDS } from '../index.js';

// Durable Object classes hosted by this function (bound through environment variables):
//   REWIND_ROOMS = durable-object:RewindRoom    live updates, one room per channel (sprint, change, company's change lists)
//   REWIND_STORE = durable-object:RewindStore   the data, one object per owner (sprint, board, company, global)
export { RewindRoom } from '@rewind/core/realtime/room';
export { RewindStore } from '@rewind/core/storage/durable';

// A Durable Object namespace from the handler's env (a binding, not a plain string value).
const namespaceOf = (ns) => (ns && typeof ns.idFromName === 'function' && typeof ns.get === 'function' ? ns : null);
const roomsNamespace = (env) => namespaceOf(env?.REWIND_ROOMS);
const storeNamespace = (env) => namespaceOf(env?.REWIND_STORE);

const ENV_KEYS = [
  'APP_URL', 'API_URL', 'CORS_ORIGIN', 'ALLOW_SIGNUP', 'REWIND_DATABASE', 'REWIND_SQL_MODE', 'AZION_TOKEN',
  'REWIND_STORAGE', 'MIGRATE_TOKEN',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_FETCH_GROUPS',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT', 'MICROSOFT_FETCH_GROUPS',
  'RESEND_API_KEY', 'EMAIL_FROM', 'SECRETS_KEY',
];

const API = 'https://api.azion.com/v4/workspace/sql/databases';

function readEnv() {
  const env = {};
  for (const k of ENV_KEYS) {
    const v = globalThis.Azion?.env?.get(k);
    if (v != null && v !== '') env[k] = v;
  }
  return env;
}

// Values are inlined as SQLite literals so we don't depend on driver-specific
// parameter binding. Strings are quoted with '' escaping; only strings, numbers and null are used.
export function bind(sql, params = []) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(Math.trunc(v));
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

// SQL Database REST API (v4): resolves the database id by name once, then runs statements on it.
function apiClient(name, token) {
  let id;
  const call = async (path, init = {}) => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Token ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`SQL API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
  const dbId = async () => {
    if (id) return id;
    const list = await call(`?search=${encodeURIComponent(name)}&page_size=50`);
    const found = (list.results || []).find((d) => d.name === name);
    if (!found) throw new Error(`SQL database "${name}" not found`);
    return (id = found.id);
  };
  return {
    async run(statement) {
      const out = await call(`/${await dbId()}/query`, { method: 'POST', body: JSON.stringify({ statements: [statement] }) });
      if (out.errors?.length) throw new Error(out.errors[0].detail || out.errors[0].title || 'SQL API error');
      const first = (out.data || [])[0] || {};
      if (first.error) throw new Error(String(first.error));
      const r = first.results || first;
      const columns = r.columns || [];
      return (r.rows || []).map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    },
  };
}

function azionDriver(name, env) {
  const api = env.AZION_TOKEN ? apiClient(name, env.AZION_TOKEN) : null;
  const apiOnly = env.REWIND_SQL_MODE === 'api';
  if (apiOnly && !api) throw new Error('REWIND_SQL_MODE=api needs AZION_TOKEN');

  let conn;
  const open = async () => {
    if (conn) return conn;
    const Database = globalThis.Azion?.Sql?.Database;
    if (!Database?.open) throw new Error('Azion SQL runtime binding not available');
    return (conn = await Database.open(name));
  };

  const readRows = async (rows) => {
    const out = [];
    if (!rows) return out;
    const cols = rows.columnCount();
    const names = Array.from({ length: cols }, (_, i) => rows.columnName(i));
    for (let row = await rows.next(); row; row = await rows.next()) {
      const obj = {};
      names.forEach((n, i) => (obj[n] = row.getValue(i)));
      out.push(obj);
    }
    return out;
  };

  return {
    async all(sql, params) {
      const statement = bind(sql, params);
      if (apiOnly) return api.run(statement);
      return readRows(await (await open()).query(statement));
    },
    async run(sql, params) {
      const statement = bind(sql, params);
      if (apiOnly) return void (await api.run(statement));
      try {
        const db = await open();
        await (db.execute ? db.execute(statement) : db.query(statement));
      } catch (e) {
        if (!api) throw e;
        await api.run(statement);
      }
    },
  };
}

let app;

// Where the data lives: Durable Objects (strongly consistent) whenever the REWIND_STORE binding
// exists; REWIND_STORAGE=sql forces the SQL Database (reads from replicas that can lag ~60 s).
// The default lives in the code, not in a variable: variables reach the edge locations at
// different times, and a mixed fleet would read and write two different databases.
function getApp(bindings) {
  if (!app) {
    const env = readEnv();
    const rooms = roomsNamespace(bindings);
    const store = storeNamespace(bindings);
    const durable = env.REWIND_STORAGE !== 'sql' && store;
    app = createRewind({
      storage: durable ? durableStorage(store, { shards: SHARDS }) : sqlStorage(azionDriver(env.REWIND_DATABASE || 'rewind', env)),
      env,
      // SQL reads come from replicas a moment behind the writes: read-your-writes on
      consistency: durable ? 'strong' : 'eventual',
      realtime: rooms ? durableRealtime(rooms) : null,
    });
  }
  return app;
}

// One-off copy of the SQL Database into the Durable Objects (POST /api/_migrate, header
// x-migrate-token = MIGRATE_TOKEN). Keeps the time left on expiring keys (sessions...).
async function migrate(request, bindings) {
  const env = readEnv();
  if (!env.MIGRATE_TOKEN || request.headers.get('x-migrate-token') !== env.MIGRATE_TOKEN) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const store = storeNamespace(bindings);
  if (!store) return new Response(JSON.stringify({ error: 'REWIND_STORE binding missing' }), { status: 500 });
  const target = durableStorage(store, { shards: SHARDS });
  // copying again later would put old SQL data over newer changes: only once, unless forced
  const done = await target.get('meta:migrated-from-sql');
  if (done && new URL(request.url).searchParams.get('force') !== '1') {
    return new Response(JSON.stringify({ error: 'Already migrated', ...done }), { status: 409, headers: { 'content-type': 'application/json' } });
  }
  const driver = azionDriver(env.REWIND_DATABASE || 'rewind', env);
  const now = Date.now();
  // remaining lifetime computed in SQL: the runtime can't hand big integers to JavaScript reliably
  const rows = await driver.all('SELECT k, v, CAST((exp - ?) / 1000 AS INTEGER) AS ttl FROM rewind_kv WHERE exp IS NULL OR exp > ? ORDER BY k', [now, now]);
  const counts = {};
  for (const { k, v, ttl } of rows) {
    await target.put(k, JSON.parse(v), ttl ? { ttl: Math.max(1, Number(ttl)) } : {});
    const kind = k.split(':')[0];
    counts[kind] = (counts[kind] || 0) + 1;
  }
  await target.put('meta:migrated-from-sql', { at: new Date().toISOString(), rows: rows.length });
  return new Response(JSON.stringify({ ok: true, rows: rows.length, counts }), { headers: { 'content-type': 'application/json' } });
}

// The Azion runtime requires the handler to be declared as an async function.
export default {
  async fetch(request, env) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/_migrate') return migrate(request, env);
    return getApp(env).fetch(request);
  },
};
