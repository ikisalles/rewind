// Read-your-writes on top of an eventually consistent store, e.g. a SQL database whose
// reads come from replicas a moment behind the main instance (Azion SQL Database).
//
// 1. Recent writes are kept in memory for a few seconds, per instance: reads and lists see
//    them right away (and deletes hide the old value).
// 2. A miss on a key that should exist (a session token someone just got, a board someone
//    just created...) is read again a few times, briefly, in case the replica is behind.
//    Keys where "not found" is normal (e.g. "is this email taken?") are not retried.

import { mergePatch } from './merge-patch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function readYourWrites(storage, { retryPrefixes = [], delays = [100, 200, 400, 800, 1500], recentMs = 15_000, maxRecent = 1000, now = Date.now } = {}) {
  const recent = new Map(); // key -> { at, value } (value undefined = deleted)

  const remember = (key, value) => {
    recent.delete(key); // re-insert to keep insertion order = age
    recent.set(key, { at: now(), value: clone(value) });
    while (recent.size > maxRecent) recent.delete(recent.keys().next().value);
  };
  const fresh = (key) => {
    const hit = recent.get(key);
    if (!hit) return null;
    if (now() - hit.at > recentMs) {
      recent.delete(key);
      return null;
    }
    return hit;
  };
  const shouldExist = (key) => retryPrefixes.some((p) => key.startsWith(p));

  return {
    ...storage,

    async get(key) {
      const hit = fresh(key);
      if (hit) return clone(hit.value) ?? null;
      let value = await storage.get(key);
      if (value !== null || !shouldExist(key)) return value;
      for (const ms of delays) {
        await sleep(ms);
        value = await storage.get(key);
        if (value !== null) return value;
      }
      return null;
    },

    async put(key, value, opts) {
      await storage.put(key, value, opts);
      remember(key, value);
    },

    async delete(key) {
      await storage.delete(key);
      remember(key, undefined);
    },

    async touch(key, field, atLeast) {
      await storage.touch(key, field, atLeast);
      recent.delete(key); // the new value is only known by the database
    },

    async patch(key, fields) {
      await storage.patch(key, fields);
      const hit = fresh(key);
      if (hit && hit.value !== undefined) remember(key, mergePatch(hit.value, fields));
      else recent.delete(key); // unknown full value here: let the next read go to the store
    },

    async list(prefix) {
      const rows = await storage.list(prefix);
      const pending = [...recent.keys()].filter((k) => k.startsWith(prefix) && fresh(k));
      if (!pending.length) return rows;
      // Rows don't carry their key, so match them by the id the key ends with (every
      // listed record has an `id`, or `userId` for votes, or `token` for invite indexes).
      const idOf = (key) => key.slice(prefix.length);
      const rowId = (row) => row?.id ?? row?.userId ?? row?.token;
      const byId = new Map(rows.map((row) => [String(rowId(row)), row]));
      for (const key of pending) {
        const id = idOf(key);
        const { value } = recent.get(key);
        if (value === undefined) byId.delete(id);
        else byId.set(id, clone(value));
      }
      return [...byId.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
    },
  };
}
