// A company's logo, from its own website: the icons its home page declares (apple-touch-icon,
// <link rel="icon">), then /apple-touch-icon.png and /favicon.ico. Fetched straight from the
// company's domain (no third-party logo service) and kept as a small data URL.

const MAX_HTML = 400_000; // only the <head> matters
const MAX_IMAGE = 100_000; // keeps /api/me light
const TIMEOUT_MS = 4000;

// truncate: keep the first `max` bytes (a page's <head>) instead of giving up on big pages
async function fetchLimited(url, max, accept, { truncate = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Rewind (company logo)', accept } });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const chunks = [];
    let size = 0;
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      while (size < max + 1) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
      reader.cancel().catch(() => {});
    } else {
      const all = new Uint8Array(await res.arrayBuffer());
      chunks.push(all);
      size = all.length;
    }
    if (size > max && !truncate) return null;
    const buf = new Uint8Array(Math.min(size, max));
    let at = 0;
    for (const c of chunks) {
      const part = c.subarray(0, Math.min(c.length, buf.length - at));
      buf.set(part, at);
      at += part.length;
      if (at >= buf.length) break;
    }
    return { type, buf, url: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// <link rel="apple-touch-icon" href="..."> / <link rel="icon" sizes="192x192" href="...">
export function iconLinks(html, baseUrl) {
  const out = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attr = (name) => (new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag) || [])
      .slice(2)
      .find((v) => v !== undefined);
    const rel = (attr('rel') || '').toLowerCase();
    if (!/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const href = attr('href');
    if (!href || href.startsWith('data:')) continue;
    let url;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    const size = Math.max(0, ...String(attr('sizes') || '').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
    // bigger first; apple-touch-icon (usually 180px, square, opaque) beats unsized icons
    out.push({ url, score: size || (rel.includes('apple-touch-icon') ? 180 : /\.svg(\?|$)/i.test(url) ? 150 : 32) });
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.url);
}

const toBase64 = (buf) => {
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);

// { dataUrl, from } or null when the site has no usable icon.
export async function fetchCompanyLogo(domain) {
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain || '')) return null;
  const base = `https://${domain}`;
  const page = await fetchLimited(`${base}/`, MAX_HTML, 'text/html', { truncate: true });
  const declared = page && page.type.includes('html') ? iconLinks(new TextDecoder().decode(page.buf), page.url) : [];
  // the usual paths, on the host the home page ended up at (e.g. www.) and on the domain itself
  const hosts = [...new Set([page ? new URL(page.url).origin : null, base].filter(Boolean))];
  const usual = hosts.flatMap((h) => [`${h}/apple-touch-icon.png`, `${h}/favicon.ico`]);
  const candidates = [...new Set([...declared, ...usual])].filter((u) => u.startsWith('https://'));
  for (const url of candidates.slice(0, 6)) {
    const img = await fetchLimited(url, MAX_IMAGE, 'image/*');
    if (!img || !img.buf.length) continue;
    const type = IMAGE_TYPES.has(img.type) ? img.type : /\.ico(\?|$)/i.test(url) && img.type === 'application/octet-stream' ? 'image/x-icon' : null;
    if (!type) continue;
    return { dataUrl: `data:${type};base64,${toBase64(img.buf)}`, from: url };
  }
  return null;
}
