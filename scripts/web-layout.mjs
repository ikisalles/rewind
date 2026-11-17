// How the web app is laid out at runtime. Used by the Node server (serves the
// sources directly, no build) and by scripts/build-web.mjs (copies the same
// layout into dist/web for CDNs, Cloudflare and Azion).
//
//   /                    apps/web            (shell: router, auth, admin, home)
//   /modules/<id>/       modules/<id>/web    (each module listed in apps/web/package.json)
//
// The browser resolves bare imports through an import map injected into index.html:
//   @rewind/web/...   -> /assets/js/...
//   @rewind/<id>/...  -> /modules/<id>/...

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Every workspace package that ships a web part ("rewind.web" in its package.json).
function webPackages() {
  const found = new Map();
  for (const group of ['modules', 'packages']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base)) {
      const pkgFile = join(base, dir, 'package.json');
      if (!existsSync(pkgFile)) continue;
      const pkg = readJson(pkgFile);
      if (pkg.rewind?.web) found.set(pkg.name, { pkg, dir: join(base, dir) });
    }
  }
  return found;
}

export function webMounts() {
  const shell = readJson(join(ROOT, 'apps/web/package.json'));
  const available = webPackages();
  const mounts = [{ prefix: '/', dir: join(ROOT, 'apps/web'), name: '@rewind/web' }];
  for (const name of Object.keys(shell.dependencies || {})) {
    const found = available.get(name);
    if (!found) continue;
    const id = name.split('/').pop();
    mounts.push({ prefix: `/modules/${id}/`, dir: join(found.dir, found.pkg.rewind.web), name });
  }
  return mounts;
}

export function importMap(mounts = webMounts()) {
  const imports = { '@rewind/web/': './assets/js/' };
  for (const m of mounts) if (m.prefix !== '/') imports[`${m.name}/`] = `.${m.prefix}`;
  return { imports };
}

// index.html carries a placeholder that becomes the import map.
export function renderIndex(html, mounts = webMounts()) {
  const tag = `<script type="importmap">${JSON.stringify(importMap(mounts))}</script>`;
  if (!html.includes('<!-- rewind:importmap -->')) throw new Error('index.html is missing <!-- rewind:importmap -->');
  return html.replace('<!-- rewind:importmap -->', tag);
}

// Maps a URL path to a file on disk (or null when outside every mount).
export function resolveFile(pathname, mounts = webMounts()) {
  const sorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const m of sorted) {
    if (!pathname.startsWith(m.prefix)) continue;
    const file = resolve(m.dir, '.' + pathname.slice(m.prefix.length - 1));
    if (file !== m.dir && !file.startsWith(m.dir + '/')) return null; // no ../ escapes
    return file;
  }
  return null;
}
