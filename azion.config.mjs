// Azion deployment for Rewind: `azion deploy` reads this file.
//
//   dist/web  -> Object Storage bucket, delivered through a storage connector (npm run build:web)
//   /api/*    -> Function built from apps/api/azion/main.js (SQL Database for data)
//
// Names below are created in your Azion account on the first deploy.
// Runtime settings (OAuth, URLs, AZION_TOKEN...) are environment variables:
// see `npm run azion:setup` and README → Deploy → Azion.

const NAME = 'rewind';

// File types served straight from storage (cached). Everything else that is not /api/* is the SPA shell.
const STATIC = ['css', 'js', 'mjs', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'json', 'txt', 'map', 'woff', 'woff2', 'html'];

export default {
  build: {
    entry: 'apps/api/azion/main.js',
    bundler: 'esbuild',
    preset: 'javascript',
    polyfills: false,
    // main.js registers its own `addEventListener('fetch', ...)`
    worker: true,
  },

  // dist/web is assembled by `npm run build:web` (the azion:build / azion:deploy scripts run it first)
  storage: [{ name: `${NAME}-static`, prefix: 'public', dir: './dist/web', workloadsAccess: 'read_only' }],

  connectors: [
    {
      name: `${NAME}-static`,
      active: true,
      type: 'storage',
      attributes: { bucket: `${NAME}-static`, prefix: 'public' },
    },
  ],

  functions: [{ name: `${NAME}-api`, path: './functions/main.js' }],

  applications: [
    {
      name: NAME,
      functionsEnabled: true,
      edgeCacheEnabled: true,
      cache: [{ name: `${NAME}-static`, browser: { maxAgeSeconds: 300 }, edge: { maxAgeSeconds: 3600 } }],
      functionsInstances: [{ name: `${NAME}-api`, ref: `${NAME}-api` }],
      rules: {
        request: [
          {
            name: 'API',
            description: 'Every /api/* request runs the Rewind API function (never cached)',
            active: true,
            criteria: [[{ variable: '${uri}', conditional: 'if', operator: 'starts_with', argument: '/api/' }]],
            behaviors: [{ type: 'run_function', attributes: { value: `${NAME}-api` } }],
          },
          {
            name: 'Static assets',
            description: 'Files from public/ delivered from storage with the cache policy',
            active: true,
            criteria: [[{ variable: '${uri}', conditional: 'if', operator: 'matches', argument: `\\.(${STATIC.join('|')})$` }]],
            behaviors: [
              { type: 'set_connector', attributes: { value: `${NAME}-static` } },
              { type: 'set_cache_policy', attributes: { value: `${NAME}-static` } },
              { type: 'deliver' },
            ],
          },
          {
            name: 'SPA shell',
            description: 'The app uses hash routes, so the root serves index.html',
            active: true,
            criteria: [[{ variable: '${uri}', conditional: 'if', operator: 'is_equal', argument: '/' }]],
            behaviors: [
              { type: 'set_connector', attributes: { value: `${NAME}-static` } },
              { type: 'rewrite_request', attributes: { value: '/index.html' } },
            ],
          },
        ],
      },
    },
  ],

  workloads: [
    {
      name: NAME,
      active: true,
      infrastructure: 1,
      deployments: [
        { name: NAME, current: true, active: true, strategy: { type: 'default', attributes: { application: NAME } } },
      ],
    },
  ],
};
