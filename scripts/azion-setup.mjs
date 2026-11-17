#!/usr/bin/env node
// One-time (and repeatable) Azion setup for Rewind. No dependencies.
//
//   1. Creates the SQL Database (REWIND_DATABASE, default "rewind") if it doesn't exist
//      and waits until it is ready.
//   2. Creates the rewind_kv table.
//   3. Creates or updates the Function's environment variables from .env.azion
//      (keys with SECRET/TOKEN/KEY in the name are stored as secrets).
//
// Usage:
//   cp .env.azion.example .env.azion      # fill it
//   AZION_TOKEN=<personal token> npm run azion:setup
//   npm run azion:setup -- --with-token   # also uploads AZION_TOKEN (SQL API fallback, see README)
//
// Create a personal token at console.azion.com → Personal Tokens (or `azion create personal-token`).

import { readFileSync, existsSync } from 'node:fs';
import { SCHEMA } from '../packages/core/src/storage/sql.js';

const SQL_API = 'https://api.azion.com/v4/workspace/sql/databases';
const VARS_API = 'https://api.azion.com/v3/variables';
const withToken = process.argv.includes('--with-token');

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] !== '') out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const vars = loadEnvFile('.env.azion');
const token = process.env.AZION_TOKEN || vars.AZION_TOKEN;
if (!token) {
  console.error('Set AZION_TOKEN (a personal token) in the environment or in .env.azion.');
  process.exit(1);
}
const dbName = vars.REWIND_DATABASE || 'rewind';

async function api(url, init = {}, accept = 'application/json') {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Token ${token}`, accept, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) {
    throw new Error(`${init.method || 'GET'} ${url} -> ${res.status} ${JSON.stringify(body.errors || body).slice(0, 400)}`);
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- SQL Database
async function ensureDatabase() {
  const list = await api(`${SQL_API}?search=${encodeURIComponent(dbName)}&page_size=50`);
  let db = (list.results || []).find((d) => d.name === dbName);
  if (db) {
    console.log(`✔ SQL Database "${dbName}" already exists (id ${db.id})`);
  } else {
    const created = await api(SQL_API, { method: 'POST', body: JSON.stringify({ name: dbName }) });
    db = created.data || created;
    console.log(`… SQL Database "${dbName}" requested (id ${db.id}), waiting until it's ready`);
  }
  for (let i = 0; i < 60; i++) {
    const cur = await api(`${SQL_API}/${db.id}`);
    const status = (cur.data || cur).status;
    if (status === 'created') return db.id;
    if (i === 0 || i % 5 === 0) console.log(`  status: ${status}`);
    await sleep(3000);
  }
  throw new Error('The database was not ready after 3 minutes; run the setup again later.');
}

async function ensureTable(id) {
  await api(`${SQL_API}/${id}/query`, { method: 'POST', body: JSON.stringify({ statements: [SCHEMA] }) });
  console.log('✔ Table rewind_kv ready');
}

// ---------------------------------------------------------------- environment variables
const isSecret = (key) => /SECRET|TOKEN|KEY/.test(key);

async function syncVariables() {
  const wanted = Object.entries(vars).filter(([k]) => k !== 'AZION_TOKEN' || withToken);
  if (withToken && !vars.AZION_TOKEN) wanted.push(['AZION_TOKEN', token]);
  if (!wanted.length) {
    console.log('ℹ No variables in .env.azion, skipping');
    return;
  }
  const v3 = 'application/json; version=3';
  const existing = await api(VARS_API, {}, v3);
  const byKey = new Map((Array.isArray(existing) ? existing : existing.results || []).map((v) => [v.key, v]));
  for (const [key, value] of wanted) {
    const body = JSON.stringify({ key, value, secret: isSecret(key) });
    const cur = byKey.get(key);
    if (cur) await api(`${VARS_API}/${cur.uuid}`, { method: 'PUT', body }, v3);
    else await api(VARS_API, { method: 'POST', body }, v3);
    console.log(`✔ ${cur ? 'Updated' : 'Created'} variable ${key}${isSecret(key) ? ' (secret)' : ''}`);
  }
}

try {
  const id = await ensureDatabase();
  await ensureTable(id);
  await syncVariables();
  console.log('\nDone. Next: npm run azion:deploy');
} catch (e) {
  console.error(`✖ ${e.message}`);
  process.exit(1);
}
