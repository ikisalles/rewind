// In-memory storage. Useful for tests and local development.
// Every storage adapter implements the same tiny interface:
//   get(key) -> value | null
//   put(key, value, { ttl }?)  (ttl in seconds)
//   delete(key)
//   list(prefix) -> value[]   (ordered by key)
//   patch(key, fields)  changes only those fields of an existing value (JSON Merge Patch);
//                       does nothing when the key doesn't exist
//   touch(key, field, atLeast)  sets a numeric field to max(field + 1, atLeast): a revision
//                       that only grows, even with clocks a little apart between servers

import { mergePatch } from './merge-patch.js';

export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));

  const alive = (entry) => !entry._exp || entry._exp > Date.now();

  return {
    data,
    async get(key) {
      const entry = data.get(key);
      if (!entry) return null;
      if (!alive(entry)) {
        data.delete(key);
        return null;
      }
      return structuredClone(entry.v);
    },
    async put(key, value, opts = {}) {
      const entry = { v: structuredClone(value) };
      if (opts.ttl) entry._exp = Date.now() + opts.ttl * 1000;
      data.set(key, entry);
    },
    async delete(key) {
      data.delete(key);
    },
    async patch(key, fields) {
      const entry = data.get(key);
      if (!entry || !alive(entry)) return;
      entry.v = mergePatch(entry.v, fields);
    },
    async touch(key, field, atLeast) {
      const entry = data.get(key);
      if (!entry || !alive(entry)) return;
      entry.v[field] = Math.max((Number(entry.v[field]) || 0) + 1, atLeast);
    },
    async list(prefix) {
      return [...data.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((k) => data.get(k))
        .filter(alive)
        .map((e) => structuredClone(e.v));
    },
  };
}
