// A stand-in for a Durable Object namespace: one RewindStore instance per name, each with its own
// storage, either SQLite (ctx.storage.sql, like Cloudflare/Azion SQLite-backed objects) or the
// key-value API. Also records which objects each operation touched.
import { RewindStore } from '../src/storage/durable.js';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  /* Node without SQLite: only the key-value mode can run */
}

function sqlStorageApi() {
  const db = new DatabaseSync(':memory:');
  return {
    sql: {
      exec(query, ...params) {
        const st = db.prepare(query);
        const rows = /^\s*(select|with)/i.test(query) ? st.all(...params) : (st.run(...params), []);
        return { toArray: () => rows };
      },
    },
  };
}

function kvStorageApi() {
  const data = new Map();
  return {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => void data.set(k, structuredClone(v)),
    delete: async (k) => void data.delete(k),
    list: async ({ prefix }) => new Map([...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => [k, structuredClone(data.get(k))])),
  };
}

// A fresh namespace (no objects yet) every call, so each test starts empty.
export function fakeStoreNamespace(mode = 'sql') {
  if (mode === 'sql' && !DatabaseSync) throw new Error('node:sqlite is not available');
  const objects = new Map();
  const object = (id) => {
    if (!objects.has(id)) objects.set(id, new RewindStore({ storage: mode === 'sql' ? sqlStorageApi() : kvStorageApi() }, {}));
    return objects.get(id);
  };
  return {
    objects,
    idFromName: (name) => name,
    get: (id) => ({ fetch: (url, init) => object(id).fetch(new Request(url, init)) }),
  };
}
