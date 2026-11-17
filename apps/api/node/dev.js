// Development watcher: restarts the server when a file in src/ or adapters/ changes.
// It polls modification times instead of relying on file system events, because
// those don't reach containers on every Docker runtime (e.g. Colima on macOS).

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// server code of the core, the modules and the API (web files need no restart: just reload the page)
const watched = ['packages', 'modules', 'apps/api'].map((d) => join(root, d));

function snapshot() {
  const times = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.js')) times.push(`${path}:${statSync(path).mtimeMs}`);
    }
  };
  watched.forEach(walk);
  return times.join('|');
}

let child;
const start = () => {
  child = spawn(process.execPath, [join(root, 'apps/api/node/server.js')], { stdio: 'inherit' });
};

let last = snapshot();
start();
setInterval(() => {
  const now = snapshot();
  if (now === last) return;
  last = now;
  console.log('[dev] change detected, restarting...');
  child.once('exit', start);
  child.kill();
}, 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child?.kill();
    process.exit(0);
  });
}
