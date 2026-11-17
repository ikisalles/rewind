#!/usr/bin/env node
// Assembles the static web app into dist/web (no bundling: files are copied as they are).
// The Node server doesn't need this: it serves the same layout straight from the sources.
//   npm run build:web

import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, webMounts, renderIndex } from './web-layout.mjs';

const out = join(ROOT, 'dist/web');
const mounts = webMounts();
const skip = (src) => !/\/(node_modules|package\.json)$/.test(src) && !src.endsWith('package.json');

rmSync(out, { recursive: true, force: true });
for (const m of mounts) {
  const target = join(out, m.prefix);
  mkdirSync(target, { recursive: true });
  cpSync(m.dir, target, { recursive: true, filter: skip });
}
const index = join(out, 'index.html');
writeFileSync(index, renderIndex(readFileSync(index, 'utf8'), mounts));

console.log(`dist/web ready: ${mounts.map((m) => `${m.prefix} ← ${m.dir.replace(ROOT + '/', '')}`).join(', ')}`);
