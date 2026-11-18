#!/usr/bin/env node
// Links every workspace (packages/*, modules/*, apps/*) into node_modules by its package name,
// like `npm install` does. Runs when the Docker container starts, so a module added after the
// image was built (or code mounted by the dev/test services) still resolves as @rewind/<id>.
// No network, no dependencies; existing correct links are left alone.

import { readdirSync, readFileSync, existsSync, mkdirSync, symlinkSync, readlinkSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let linked = 0;

for (const group of ['packages', 'modules', 'apps']) {
  const base = join(ROOT, group);
  if (!existsSync(base)) continue;
  for (const dir of readdirSync(base)) {
    const pkgFile = join(base, dir, 'package.json');
    if (!existsSync(pkgFile)) continue;
    const { name } = JSON.parse(readFileSync(pkgFile, 'utf8'));
    if (!name) continue;
    const link = join(ROOT, 'node_modules', name);
    const target = relative(dirname(link), join(base, dir));
    try {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) continue;
      rmSync(link, { recursive: true, force: true });
    } catch {
      // not there yet
    }
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, 'dir');
    linked++;
  }
}

if (linked) console.log(`Linked ${linked} workspace package(s) into node_modules`);
