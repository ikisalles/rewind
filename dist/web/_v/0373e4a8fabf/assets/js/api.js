const cfg = window.REWIND_CONFIG || {};
const base = (cfg.apiBase || '').replace(/\/$/, '');
const TOKEN_KEY = 'rewind.token';

export const apiUrl = (path) => `${base}${path}`;

export const session = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    startedAt = Date.now();
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private mode: session lasts only this tab */
    }
    memoryToken = token;
  },
  clear() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
    memoryToken = null;
  },
};
let memoryToken = null;
// When the session was created in this tab: on stores whose reads lag behind writes, the
// first requests after signing in may not find the new session yet (see api() below).
let startedAt = 0;
// Latest revision this tab caused per record (sprint id -> rev): reads may lag a moment behind
// writes, so a view can wait until it sees at least that version.
const revs = new Map();
export const minRev = (id) => revs.get(id) || 0;
const FRESH_SESSION_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(method, path, body, attempt = 0) {
  const token = session.get() || memoryToken;
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server');
  }
  const data = await res.json().catch(() => ({}));
  // "<id>:<rev>": the revision a change produced (e.g. of a sprint), see minRev()
  const rev = res.headers.get('x-rewind-rev');
  if (rev) {
    const [id, n] = rev.split(':');
    revs.set(id, Math.max(revs.get(id) || 0, Number(n) || 0));
  }
  // a brand-new session may take a moment to be readable everywhere: try again before signing out
  if (res.status === 401 && token && Date.now() - startedAt < FRESH_SESSION_MS && attempt < 4) {
    await sleep(400 * 2 ** attempt);
    return api(method, path, body, attempt + 1);
  }
  if (res.status === 401 && token && !path.startsWith('/api/auth/')) {
    session.clear();
    location.hash = '#/login';
  }
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.status = res.status;
    err.code = data.code; // e.g. 'sso_required'
    throw err;
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p, b) => api('DELETE', p, b); // b: optional body (e.g. a reason)
