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

import { sqlStorage } from '@rewind/core/storage/sql';
import { createRewind } from '../index.js';

const ENV_KEYS = [
  'APP_URL', 'API_URL', 'CORS_ORIGIN', 'ALLOW_SIGNUP', 'REWIND_DATABASE', 'REWIND_SQL_MODE', 'AZION_TOKEN',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_FETCH_GROUPS',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT', 'MICROSOFT_FETCH_GROUPS',
  'RESEND_API_KEY', 'EMAIL_FROM',
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

async function handle(request) {
  if (!app) {
    const env = readEnv();
    // reads come from replicas that may be a moment behind the writes: read-your-writes on
    app = createRewind({ storage: sqlStorage(azionDriver(env.REWIND_DATABASE || 'rewind', env)), env, consistency: 'eventual' });
  }
  return app.fetch(request);
}

addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
