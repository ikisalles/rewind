// Web modules enabled in this build. Each one comes from modules/<id>/web and is
// reachable as @rewind/<id>/... through the import map (see scripts/web-layout.mjs).
// To add one: add it to apps/web/package.json "dependencies" and import it here.
import foundation from '@rewind/foundation/index.js';
import retro from '@rewind/retro/index.js';
import gmud from '@rewind/gmud/index.js';
import goals from '@rewind/goals/index.js';

export const MODULES = [foundation, retro, gmud, goals];
