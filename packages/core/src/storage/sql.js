// SQL-backed key/value storage. Works with any SQLite-compatible database
// that can run parameterised statements: Cloudflare D1, Azion SQL Database,
// libSQL/Turso, better-sqlite3...
//
// A single table keeps the schema trivial and portable:
//   CREATE TABLE IF NOT EXISTS rewind_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)

export const SCHEMA =
  'CREATE TABLE IF NOT EXISTS rewind_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)';

// `driver` must expose:
//   all(sql, params) -> Promise<Array<{ v: string, exp: number|null }>>
//   run(sql, params) -> Promise<void>
export function sqlStorage(driver) {
  let ready = null;
  const init = () => (ready ??= driver.run(SCHEMA, []));
  const now = () => Date.now();

  const decode = (rows) =>
    rows.filter((r) => !r.exp || Number(r.exp) > now()).map((r) => JSON.parse(r.v));

  return {
    async get(key) {
      await init();
      const rows = await driver.all('SELECT v, exp FROM rewind_kv WHERE k = ?', [key]);
      return decode(rows)[0] ?? null;
    },
    async put(key, value, opts = {}) {
      await init();
      const exp = opts.ttl ? now() + opts.ttl * 1000 : null;
      await driver.run(
        'INSERT INTO rewind_kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp',
        [key, JSON.stringify(value), exp],
      );
    },
    async delete(key) {
      await init();
      await driver.run('DELETE FROM rewind_kv WHERE k = ?', [key]);
    },
    async list(prefix) {
      await init();
      // Prefix range scan: every key in [prefix, prefixEnd) starts with prefix.
      const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      const rows = await driver.all(
        'SELECT v, exp FROM rewind_kv WHERE k >= ? AND k < ? ORDER BY k',
        [prefix, end],
      );
      return decode(rows);
    },
  };
}

// Cloudflare D1 binding -> driver
export function d1Driver(db) {
  return {
    async all(sql, params) {
      const res = await db.prepare(sql).bind(...params).all();
      return res.results ?? [];
    },
    async run(sql, params) {
      await db.prepare(sql).bind(...params).run();
    },
  };
}
