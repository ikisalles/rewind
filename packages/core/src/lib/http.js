export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const fail = (status, message, code) => {
  throw new HttpError(status, message, code);
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function redirect(url) {
  return new Response(null, { status: 302, headers: { location: url } });
}

export async function readJson(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return {};
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    fail(400, 'Invalid JSON');
  }
}

export function corsHeaders(request, allowed) {
  const origin = request.headers.get('origin');
  if (!origin || !allowed) return {};
  const list = allowed.split(',').map((s) => s.trim());
  if (!list.includes('*') && !list.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

// Tiny path router: add('GET', '/api/sprints/:id', fn)
export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const names = [];
      const re = new RegExp(
        '^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$',
      );
      routes.push({ method, re, names, handler });
    },
    match(method, path) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (m) {
          const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
          return { handler: r.handler, params };
        }
      }
      return null;
    },
  };
}
