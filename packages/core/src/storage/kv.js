// Adapter for key/value stores with a Cloudflare-KV-like API:
//   get(key, 'json'), put(key, string, { expirationTtl }), delete(key), list({ prefix, cursor })
// Note: Cloudflare KV is eventually consistent; prefer D1/SQL when several people
// write to the same retro at the same time.

import { mergePatch } from './merge-patch.js';

export function kvStorage(ns) {
  return {
    async get(key) {
      return (await ns.get(key, 'json')) ?? null;
    },
    async put(key, value, opts = {}) {
      const o = opts.ttl ? { expirationTtl: Math.max(60, opts.ttl) } : undefined;
      await ns.put(key, JSON.stringify(value), o);
    },
    async delete(key) {
      await ns.delete(key);
    },
    // KV has no partial update: read, merge, write (not atomic; KV is eventually consistent anyway)
    async patch(key, fields) {
      const current = await ns.get(key, 'json');
      if (current) await ns.put(key, JSON.stringify(mergePatch(current, fields)));
    },
    async touch(key, field, atLeast) {
      const current = await ns.get(key, 'json');
      if (current) await ns.put(key, JSON.stringify({ ...current, [field]: Math.max((Number(current[field]) || 0) + 1, atLeast) }));
    },
    async list(prefix) {
      const keys = [];
      let cursor;
      do {
        const page = await ns.list({ prefix, cursor });
        keys.push(...page.keys.map((k) => k.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      const values = await Promise.all(keys.sort().map((k) => ns.get(k, 'json')));
      return values.filter(Boolean);
    },
  };
}
