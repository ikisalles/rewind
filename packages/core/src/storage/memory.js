// In-memory storage. Useful for tests and local development.
// Every storage adapter implements the same tiny interface:
//   get(key) -> value | null
//   put(key, value, { ttl }?)  (ttl in seconds)
//   delete(key)
//   list(prefix) -> value[]   (ordered by key)

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
