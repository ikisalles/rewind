// Web modules enabled in this build. Each one comes from modules/<id>/web and is
// reachable as @rewind/<id>/... through the import map (see scripts/web-layout.mjs).
// To add one: add it to apps/web/package.json "dependencies" and import it here.
import retro from '@rewind/retro/index.js';

export const MODULES = [retro];
