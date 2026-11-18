#!/usr/bin/env node
// Assembles the static web app into dist/web (no bundling: files are copied as they are).
// The Node server doesn't need this: it serves the same layout straight from the sources.
//   npm run build:web
//
// Versioned layout, so a deploy is never half old and half new behind CDN caches:
//   dist/web/index.html          the shell (never cached): points at this build's folder
//   dist/web/config.js           deployment settings, favicon.svg
//   dist/web/_v/<hash>/...       every script, stylesheet and module of this build
// <hash> comes from the files' contents: a new build gets new URLs, an unchanged one keeps them.

import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, webMounts, renderIndex } from './web-layout.mjs';

const out = join(ROOT, 'dist/web');
const mounts = webMounts();
const skip = (src) => !/\/(node_modules|package\.json)$/.test(src) && !src.endsWith('package.json');
// served from the root, outside the versioned folder
const ROOT_FILES = ['index.html', 'config.js', 'favicon.svg'];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (!skip(path)) return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

// the build id: a hash of every file that goes into the versioned folder
const hash = createHash('sha256');
for (const m of mounts) {
  for (const file of files(m.dir).sort()) {
    hash.update(`${m.prefix}${relative(m.dir, file)}\0`);
    hash.update(readFileSync(file));
  }
}
const version = hash.digest('hex').slice(0, 12);
const base = `_v/${version}/`;

rmSync(out, { recursive: true, force: true });
for (const m of mounts) {
  const target = join(out, base, m.prefix);
  mkdirSync(target, { recursive: true });
  cpSync(m.dir, target, { recursive: true, filter: skip });
}
const shell = join(out, base);
for (const name of ROOT_FILES) {
  copyFileSync(join(shell, name), join(out, name));
  rmSync(join(shell, name), { force: true });
}
writeFileSync(join(out, 'index.html'), renderIndex(readFileSync(join(out, 'index.html'), 'utf8'), mounts, `./${base}`));

console.log(`dist/web ready (version ${version}): ${mounts.map((m) => `${m.prefix} ← ${m.dir.replace(ROOT + '/', '')}`).join(', ')}`);
