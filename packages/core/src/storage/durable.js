// Storage on Durable Objects: strongly consistent, one object per "shard".
//
// Every key belongs to an owner: a sprint's notes live in that sprint's object, a company's
// people and boards in that company's object, global indexes (sessions, emails) in one global
// object. Each object is a single instance that runs one request at a time, so reads always see
// the latest write. Every list(prefix) used by Rewind falls in a single shard.
//
// Shard rules map a key's first segment to an owner kind; the owner id is the second segment:
//   { note: 'sprint' }  =>  "note:<sprintId>:<id>"  lives in the object "sprint:<sprintId>"
// Keys without a rule live in "global".
//
//   storage = durableStorage(env.REWIND_STORE, { shards })   // binding of the RewindStore class

import { mergePatch } from './merge-patch.js';

export const shardOf = (key, shards = {}) => {
  const [kind, owner] = key.split(':');
  const rule = shards[kind];
  return rule && owner ? `${rule}:${owner}` : 'global';
};

export function durableStorage(namespace, { shards = {} } = {}) {
  const call = async (key, body) => {
    const stub = namespace.get(namespace.idFromName(`rewind-store:${shardOf(key, shards)}`));
    const res = await stub.fetch('https://rewind-store/op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ ok: false, error: `store answered ${res.status}` }));
    if (!data.ok) throw new Error(`RewindStore: ${data.error}`);
    return data.result;
  };
  return {
    get: (key) => call(key, { op: 'get', key }),
    put: (key, value, opts = {}) => call(key, { op: 'put', key, value, ttl: opts.ttl || null }),
    delete: (key) => call(key, { op: 'delete', key }),
    list: (prefix) => call(prefix, { op: 'list', prefix }),
    patch: (key, fields) => call(key, { op: 'patch', key, fields }),
    touch: (key, field, atLeast) => call(key, { op: 'touch', key, field, atLeast }),
  };
}

// --------------------------------------------------------------------- the Durable Object
// Uses the object's SQLite (ctx.storage.sql) when available, its key-value API otherwise.

function sqlBackend(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)');
  const live = '(exp IS NULL OR exp > ?)';
  return {
    get: (key) => {
      const row = sql.exec(`SELECT v FROM kv WHERE k = ? AND ${live}`, key, Date.now()).toArray()[0];
      return row ? JSON.parse(row.v) : null;
    },
    put: (key, value, exp) => void sql.exec('INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)', key, JSON.stringify(value), exp),
    delete: (key) => void sql.exec('DELETE FROM kv WHERE k = ?', key),
    list: (prefix) => {
      const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      return sql.exec(`SELECT v FROM kv WHERE k >= ? AND k < ? AND ${live} ORDER BY k`, prefix, end, Date.now()).toArray().map((r) => JSON.parse(r.v));
    },
    expOf: (key) => sql.exec('SELECT exp FROM kv WHERE k = ?', key).toArray()[0]?.exp ?? null,
  };
}

function kvBackend(storage) {
  const alive = (e) => e && (!e.exp || e.exp > Date.now());
  return {
    get: async (key) => {
      const e = await storage.get(key);
      return alive(e) ? e.v : null;
    },
    put: (key, value, exp) => storage.put(key, { v: value, exp }),
    delete: (key) => storage.delete(key),
    list: async (prefix) => [...(await storage.list({ prefix })).values()].filter(alive).map((e) => e.v),
    expOf: async (key) => (await storage.get(key))?.exp ?? null,
  };
}

export class RewindStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.db = ctx.storage?.sql ? sqlBackend(ctx.storage.sql) : kvBackend(ctx.storage);
  }

  async fetch(request) {
    let body;
    try {
      body = await request.json();
      const result = await this.run(body);
      return new Response(JSON.stringify({ ok: true, result: result ?? null }), { headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  }

  // One request at a time per object: a read-modify-write here is atomic.
  async run({ op, key, value, ttl, prefix, fields, field, atLeast }) {
    const db = this.db;
    switch (op) {
      case 'get':
        return db.get(key);
      case 'put':
        return db.put(key, value, ttl ? Date.now() + ttl * 1000 : null);
      case 'delete':
        return db.delete(key);
      case 'list':
        return db.list(prefix);
      case 'patch': {
        const current = await db.get(key);
        if (current) await db.put(key, mergePatch(current, fields), await db.expOf(key));
        return null;
      }
      case 'touch': {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) throw new Error('Invalid field name');
        const current = await db.get(key);
        if (current) await db.put(key, { ...current, [field]: Math.max((Number(current[field]) || 0) + 1, Number(atLeast) || 0) }, await db.expOf(key));
        return null;
      }
      default:
        throw new Error(`Unknown operation ${op}`);
    }
  }
}
