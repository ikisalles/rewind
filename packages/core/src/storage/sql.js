// SQL-backed key/value storage. Works with any SQLite-compatible database
// that can run parameterised statements: Cloudflare D1, Azion SQL Database,
// libSQL/Turso, better-sqlite3...
//
// A single table keeps the schema trivial and portable:
//   CREATE TABLE IF NOT EXISTS rewind_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)

export const SCHEMA =
  'CREATE TABLE IF NOT EXISTS rewind_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)';

// `driver` must expose:
//   all(sql, params) -> Promise<Array<{ v: string }>>
//   run(sql, params) -> Promise<void>
//
// Expiry is checked in SQL (exp > now), never by reading `exp` back into JavaScript:
// some runtimes return big integers (milliseconds since 1970) wrongly, which would make
// every value with a TTL (e.g. sessions) look expired.
export function sqlStorage(driver) {
  let ready = null;
  const init = () => (ready ??= driver.run(SCHEMA, []));
  const now = () => Date.now();

  const decode = (rows) => rows.map((r) => JSON.parse(r.v));
  const LIVE = '(exp IS NULL OR exp > ?)';

  return {
    async get(key) {
      await init();
      const rows = await driver.all(`SELECT v FROM rewind_kv WHERE k = ? AND ${LIVE}`, [key, now()]);
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
    // Changes only these fields, inside the database (writes go to the main instance): no
    // read-modify-write, so a stale read elsewhere can't put back fields someone else changed.
    async patch(key, fields) {
      await init();
      await driver.run('UPDATE rewind_kv SET v = json_patch(v, ?) WHERE k = ?', [JSON.stringify(fields), key]);
    },
    // A revision that only grows, computed in the database: max(current + 1, atLeast).
    async touch(key, field, atLeast) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) throw new Error('Invalid field name');
      await init();
      await driver.run(
        `UPDATE rewind_kv SET v = json_set(v, '$.${field}', max(coalesce(json_extract(v, '$.${field}'), 0) + 1, ?)) WHERE k = ?`,
        [atLeast, key],
      );
    },
    async list(prefix) {
      await init();
      // Prefix range scan: every key in [prefix, prefixEnd) starts with prefix.
      const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      const rows = await driver.all(`SELECT v FROM rewind_kv WHERE k >= ? AND k < ? AND ${LIVE} ORDER BY k`, [prefix, end, now()]);
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
