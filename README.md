# Rewind

> **listening to and giving a voice to the team**

Rewind is an open source tool for agile retrospectives. It is designed to run on the edge, primarily on
**Azion Functions** (also on **Cloudflare Workers**), and works on any runtime that speaks `fetch`
(Deno, Bun, Node 20+).

- **Modular monorepo**: a small core (companies, people, teams, sign-in) plus feature **modules**. Retro is the first module; new ones plug in without touching the others.
- **Frontend**: plain HTML, CSS and JavaScript (ES modules + an import map). No bundler: files are served as they are.
- **API**: a single JavaScript `fetch` handler (`@rewind/core`) with no third-party dependencies; each module adds its routes.
- **Pluggable storage**: SQL (Cloudflare D1, Azion SQL Database or any SQLite), KV or in-memory.

## Features

| Area | What it does |
| --- | --- |
| Companies | Manual sign-up (company + admin with a password) or automatic through social sign-in (Google, Microsoft, GitHub). |
| Social sign-in | The first sign-in from a domain creates the company and makes that person the admin. Rewind then asks whether other `@domain` accounts may join automatically. |
| Automatic teams | Provider groups (Google Workspace, Microsoft Entra ID, GitHub teams) become Rewind teams. Without groups, the person joins the default team. |
| Invites | For manually created companies, or when automatic sign-in is off, the admin invites people by email and picks their team and role. The link can be copied; the email is sent if Resend is configured. |
| Teams | Administration → Teams lists the teams; open one to see its members, remove someone or add a person who is already in the company. |
| Same company name | Registering a company name that already exists (ignoring case, accents and extra spaces) doesn't create a duplicate: the request waits for approval. The person who registered the company gets an email and every admin sees the request in Administration → Members (and on the dashboard). Approved people join as members of the teams the admin picks, so they only see those teams' boards. Denied people get an email and can't register that company again; registering a different company name reactivates their sign-up. |
| Retro | Boards per team → sprints with start and end dates → configurable columns → sticky notes from each member. |
| Templates | When creating a sprint, pick a format (Start/Stop/Continue, 4Ls, Mad/Sad/Glad, Sailboat, Starfish, Rose/Thorn/Bud or Classic) or start blank and add the columns yourself. Each column can have a prompt shown in the note box. A template can also be applied later from the board (*Template*). |
| Hide notes | The retro admin hides or reveals the notes. While they are hidden, the API doesn't send other people's text at all: it is not just a blur on screen. |
| Live updates | People on the same retro see new cards, votes, merges and the finish within about a second, over a WebSocket: one Durable Object per sprint on Cloudflare (and Azion Durable Objects, same interface), an in-process hub on Node/Docker. Messages only say "this sprint changed", so hidden notes and authors never travel over it. Without it the board refreshes every few seconds. |
| Votes | The admin sets how many votes each person gets; only the admin sees this setting. People spend them on the cards they want to prioritize, and can put several on the same card (the heart adds one, "−" takes one back) as long as the total stays within the limit. |
| Merge notes | Drag a card onto another (you're asked to confirm after the drop), or use the merge button and pick several. The card keeps every text and author, all votes add up and action items follow. Everyone can merge their own notes, even while notes are hidden; the retro admin can merge any revealed note. Each merged note can be split back into its own card. |
| Hide authors | The retro admin hides who wrote each card, for everyone (admin included) and on the public link. The API doesn't send the authors at all; people still see "You" on their own cards. |
| Share | Creates a public, read-only link that can be disabled at any time. |
| Finish retro | Admin only. Locks editing and opens the 3 most voted items, each with action items (owner, optional due date and done status). |
| Pending items | Shows the previous sprint's unfinished action items so they can be re-validated: keep in this sprint, already done, or no longer relevant. |
| Appearance | The admin changes the company colors, with presets and a live preview. Whoever deploys Rewind sets the default colors in `apps/web/config.js`. |
| Home dashboard | What needs you now (retros where you haven't added a note or still have votes, sprints ending soon for the retro admin), your open action items with one-click done, the top 3 of each board's latest retro and how its action items are going, team health over the last 6 sprints (action items done, participation, items carried over) and, for admins, a getting-started checklist plus housekeeping (pending invites, members without a team, boards with no activity for 4 weeks). |

The default look is a dark console: near-black background, surfaces with subtle borders, orange accent,
Inter font and Roboto Mono in the footer.

## Structure

An npm workspaces monorepo. No third-party dependencies: `npm install` only links the workspaces.

```
packages/
  core/                 @rewind/core — API kernel: sign-in (password + social), companies, people,
    src/app.js            teams, invites, access requests, email, the module system and /api/dashboard
    src/module.js         defineModule(): the server-side module contract
    src/storage/          memory.js · sql.js (D1/Azion/SQLite) · kv.js (Cloudflare KV)
    src/auth/providers.js Google, GitHub, Microsoft
    test/                 core tests + helpers shared with the modules (@rewind/core/testing)
modules/
  retro/                @rewind/retro — the retrospectives module
    server/index.js       routes: boards, sprints, notes, votes, merge, action items, share links
    web/                  views, menu items, home widgets and retro.css (served at /modules/retro/)
    test/                 module tests
apps/
  api/                  @rewind/api — core + enabled modules (index.js) and the runtimes:
    node/                 local server (server.js) and development watcher (dev.js)
    cloudflare/           worker.js + wrangler.toml.example
    azion/                main.js (Azion Functions + SQL Database)
    test/                 integration tests of the composed API
  web/                  @rewind/web — the static shell: router, sign-in, home, administration
    assets/js/app.js      shared web context + defineWebModule(): the web module contract
    assets/js/modules.js  web modules enabled in this build
    config.js             deployment settings (apiBase, name, slogan, default colors)
scripts/
  web-layout.mjs        how shell and modules are laid out at runtime (+ the import map)
  build-web.mjs         copies that layout into dist/web for CDNs, Cloudflare and Azion
  azion-setup.mjs       creates the Azion SQL Database, table and environment variables
azion.config.mjs        Azion resources: storage, function, application rules, workload
azion/azion.json        IDs of the Azion resources (written by the CLI, keep it committed)
Dockerfile, compose.yaml  Docker image and services (app, dev, test)
```

## Modules

A module is a folder in `modules/<id>` with a server part, a web part and its own tests. It owns its
data (its own storage keys) and only reaches core data through the services the core gives it.

**Server** (`modules/<id>/server/index.js`):

```js
import { defineModule, json } from '@rewind/core';

export default defineModule({
  id: 'polls',
  name: 'Polls',
  register(core) {
    // core: db, route, isAdmin, requireAdmin, appUrl, sendEmail, getOrg, getTeam, listTeams, listUsers, teamMembers
    core.route('GET', '/api/polls', async (c) => json({ polls: await core.db.list(`poll:${c.org.id}:`) }));
    return {
      dashboard: async (c) => ({ open: 0 }),                    // becomes /api/dashboard → polls
      adminDashboard: async (c) => ({ onboarding: { poll: false } }), // merged into admin.onboarding
      beforeTeamDelete: async (c, teamId) => {},                // fail(...) to block the deletion
    };
  },
});
```

**Web** (`modules/<id>/web/index.js`), imported in the browser as `@rewind/<id>/...`:

```js
import { defineWebModule } from '@rewind/web/app.js';

export default defineWebModule({
  id: 'polls',
  styles: ['polls.css'],
  routes: [['/polls', pollsView]],
  nav: [{ href: '#/polls', label: 'Polls', icon: 'list' }],
  home: { metrics: ({ data }) => [['Open polls', data.polls.open]], sections: (ctx) => [] },
});
```

**Enable it**:

1. `modules/<id>/package.json` named `@rewind/<id>`, with `"exports": { "./server": "./server/index.js" }` and `"rewind": { "web": "./web" }`.
2. API: add it to `apps/api/package.json` dependencies and to `MODULES` in `apps/api/index.js`.
3. Web: add it to `apps/web/package.json` dependencies and to `MODULES` in `apps/web/assets/js/modules.js`.
4. `npm install` (links the new workspace) and `npm test`.

The web shell serves each enabled module at `/modules/<id>/` and adds it to the import map; the home page
only shows widgets of modules the API reports as enabled.

Admins see the installed modules in **Administration → Modules** (`GET /api/org/modules`). A module declares
`required: true` when a company can't turn it off; Retro is required for now, as it is the only module.

## Dashboard API

The home page loads everything with a single call, so it stays cheap on edge storage.
`GET /api/dashboard` (signed in) returns the enabled `modules`, the core's `admin` part and one key per module:

| Field | Content |
| --- | --- |
| `modules` | Ids of the enabled modules, e.g. `["retro"]`. |
| `admin` | `null` for members. For admins: `accessRequests` (people waiting for approval), `pendingInvites`, `membersWithoutTeam`, `onboarding` step flags (core + modules) and one key per module (e.g. `admin.retro.staleBoards`: latest sprint ended more than 28 days ago, or no sprints 28 days after creation). |
| `retro.boards` | Boards the viewer can see, with `sprintCount` and `lastSprint` (`id`, `name`, `status`, `start`, `end`). |
| `retro.actions` | The viewer's open action items, sorted by due date, each with its `board` and `sprint`. |
| `retro.attention` | One entry per board whose latest sprint is open and waits on the viewer: `needsNote`, `votesRemaining`, `closingSoon` (retro admin only, sprint ends within 2 days or already ended). |
| `retro.results` | Latest finished retro per board: `top` notes (text, votes, column), and `actions` progress (`done`, `total`, `rate`). |
| `retro.health` | Per board, the last 6 sprints (oldest first): `actions` progress, `participation` (`authors`, `teamSize`, `rate`) and `carried` items. Dropped items don't count; carried ones count as not done. |

Hidden notes stay hidden here too: if the retro admin hides the notes again after finishing, `retro.results[].top[].text` is `null` except for the author.

## Running locally

### With Docker (recommended, no Node install needed)

Requires Docker. On macOS this can be Docker Desktop, OrbStack or Colima (`brew install colima docker docker-compose`,
then `colima start`).

```bash
cp .env.example .env              # optional: configure social sign-in
docker compose up -d              # Rewind at http://localhost:8787
docker compose logs -f            # follow the logs
docker compose down               # stop (data stays in the rewind-data volume)
```

> If `docker-compose` is installed as a separate binary (e.g. via Homebrew), use `docker-compose`
> instead of `docker compose` in every command.

Other useful commands:

| Command | What it does |
| --- | --- |
| `docker compose --profile dev up dev` | Development mode: uses the code on your machine and restarts the API on every change in `packages/`, `modules/` or `apps/api/`. The frontend has no build step, so just reload the browser. |
| `docker compose --profile test run --rm test` | Runs the tests. |
| `docker compose up -d --build` | Rebuilds the image after changing the code (normal mode). |
| `docker compose down -v` | Stops everything and **deletes the data** (the `rewind-data` volume). |
| `PORT=3000 docker compose up -d` | Uses another host port. If you use social sign-in, set `APP_URL` too. |

Without Compose, using plain `docker`:

```bash
docker build -t rewind .
docker run -d --name rewind -p 8787:8787 -v rewind-data:/app/.data --env-file .env rewind
docker run --rm rewind npm test
```

(Without a `.env` file, drop `--env-file .env`.)

The image is based on `node:22-alpine`, runs as an unprivileged user and stores data in `/app/.data/rewind.json`,
inside the volume. This mode is meant for development and small installs; in production, prefer
Cloudflare or Azion with a SQL database (see Deploy).

### With Node installed

Requires Node 20+.

```bash
npm install             # links the workspaces (no downloads: there are no third-party dependencies)
cp .env.example .env    # optional: configure social sign-in
npm run dev             # http://localhost:8787, restarts on every change
npm start               # no automatic restart
npm test                # core, modules and integration tests
npm run build:web       # optional: static build in dist/web (what Cloudflare and Azion publish)
```

Locally, data is stored in `.data/rewind.json`.

## Deploy

### Azion — primary target (Application + Function + Object Storage + SQL Database)

Everything is described in `azion.config.mjs`:

| Resource | Name | What it does |
| --- | --- | --- |
| Object Storage bucket | `rewind-static` | Holds `dist/web` (the shell and the modules' web parts, from `npm run build:web`). |
| Storage connector | `rewind-static` | Delivers files from the bucket. |
| Function | `rewind-api` | The API (core + modules), bundled from `apps/api/azion/main.js`. |
| Application | `rewind` | Rules: `/api/*` runs the function; files are served from storage with cache; `/` serves `index.html`. |
| Workload | `rewind` | Gives the application a public domain (`*.map.azionedge.net`). |
| SQL Database | `rewind` | Data. Created by `npm run azion:setup` (the CLI can't create databases). |

**Requirements**: the [Azion CLI](https://www.azion.com/en/documentation/devtools/cli/) (`brew install azion`)
and Node.js 20+ (the CLI bundles the function with `npx`).

**First deploy**

```bash
azion login                                  # opens the browser
cp .env.azion.example .env.azion             # fill AZION_TOKEN and what you need (OAuth, Resend...)
npm run azion:setup                          # SQL Database + table + function variables
npm install                                  # links the workspaces
npm run azion:deploy                         # build:web + build + upload dist/web + function + rules
```

The deploy prints the URL (`https://xxxxxxxx.map.azionedge.net`). Open it and register the first company.
To use social sign-in, register `https://<that domain>/api/auth/oauth/<provider>/callback` with the provider,
put the credentials in `.env.azion`, then run `npm run azion:setup` and `npm run azion:deploy` again.

**Domain**: the workload answers on `https://rewind.azion.app` (a free Azion custom domain, set in
`workloads[].domains` of `azion.config.mjs`; each `azion.app` name belongs to one workload) and on the
generated `*.map.azionedge.net` domain.

**Bucket and prefix**: bucket names are global on Azion, so the first deploy may create a suffixed bucket
(e.g. `rewind-20261117153022`). That name goes into `BUCKET` in `azion.config.mjs`, and `azion/azion.json`
has `"prefix": "public"` with `"rotate-prefix": false`, so every deploy uploads `dist/web` to the same place
the storage connector points at. If you deploy to another account, set `BUCKET` to the bucket the CLI creates there.

**Older Azion accounts**: the CLI asks Azion which platform generation the account is on and, for accounts
still flagged as v3, runs the legacy commands, which don't know workloads or `azion.app` domains (the deploy
fails reading `azion/azion.json`). If the account can use the v4 API (`GET /v4/workspace/workloads` returns
200), set `APIVersion = 'v4'` in `~/.azion/default/settings.toml` before deploying; the CLI checks again after
24 hours. The lasting fix is to have the account moved to v4.

**Data on Durable Objects (production setup)**: the Azion SQL Database serves reads from replicas
that were measured ~60 s behind the writes, and reading the main instance through its REST API costs
~1.7 s per query, too slow and too stale for a live retro. So on Azion the data lives in the
`RewindStore` Durable Object (`@rewind/core/storage/durable`), strongly consistent, one object per
owner: a sprint's notes, votes and action items in the sprint's object, a board's sprints in the
board's object, a company's people, teams, boards, invites and access requests in the company's
object, sessions and indexes in a global object. Modules declare their rules (`shards` in
`defineModule`), so every list stays inside one object.

| Variable | Value |
| --- | --- |
| `REWIND_STORE` | `durable-object:RewindStore` (the binding) |
| `REWIND_STORAGE` | `durable` to use it; unset keeps the SQL Database |
| `MIGRATE_TOKEN` | only while migrating; remove afterwards |

Moving an existing SQL Database over: deploy with `REWIND_STORE` and `MIGRATE_TOKEN` set (data still
read from SQL), call `POST /api/_migrate` with header `x-migrate-token: <MIGRATE_TOKEN>` (copies every
row once, keeping the time left on sessions; a second call answers 409 unless `?force=1`), then set
`REWIND_STORAGE=durable` and deploy again. The SQL Database stays untouched as a backup.

Tests run on every storage: `npm run test:all` (memory, Durable Objects with SQLite, Durable Objects
with the key-value API).

**Live updates on Azion**: one `RewindRoom` Durable Object per sprint. On Azion a Durable Object
binding is an environment variable that names the class: `REWIND_ROOMS = durable-object:RewindRoom`
(in `.env.azion`, sent by `npm run azion:setup`); the function then gets the namespace as
`env.REWIND_ROOMS`. That is why `apps/api/azion/main.js` uses the ES Modules handler and exports the
class. Two details of the Azion toolchain it depends on:

- the runtime requires `fetch` to be declared `async` (`export default { async fetch(request, env) {...} }`);
- the bundler wraps ES Modules entries in a file that re-exports only `default`, which would drop the
  class, so `build.extend` in `azion.config.mjs` bundles `main.js` itself.

Without the variable the API still works and the board falls back to refreshing every few seconds.
Runtime logs: `azion logs cells --function-id <id>`.

**Next deploys**: `npm run azion:deploy`. The CLI updates the same resources because their IDs are in
`azion/azion.json`, so keep that file committed.

**Deploy from GitHub**: `.github/workflows/azion-deploy.yml` runs the same build and deploy when started
by hand (Actions → *Deploy Application using Azion CLI* → Run workflow). Add a repository secret
`AZION_PERSONAL_TOKEN` first. Function variables are not part of the workflow: keep using `npm run azion:setup`.

**SQL access from the function**: the adapter reads and writes through the runtime binding
`Azion.Sql.Database` (the same one the official `azion/sql` library uses). If writes fail in your account,
run `npm run azion:setup -- --with-token` to give the function `AZION_TOKEN`: failed writes are then retried
through the SQL Database REST API, which always writes to the main instance. Set `REWIND_SQL_MODE=api` to send
every query through the API. Prefer a dedicated personal token with an expiration date for this.

### Cloudflare (Workers + Static Assets + D1)

```bash
npm install && npm run build:web             # dist/web: shell + modules
cp apps/api/cloudflare/wrangler.toml.example wrangler.toml
npx wrangler d1 create rewind                # copy the database_id into wrangler.toml
npx wrangler secret put GOOGLE_CLIENT_ID   # and the other secrets
npx wrangler deploy
```

Live updates use the `RewindRoom` Durable Object (binding `REWIND_ROOMS`, already in the example
`wrangler.toml`). Leave it out and the retro board falls back to refreshing every few seconds.

The Worker serves `dist/web` and the API on the same domain. The table is created automatically on first access.

### API on a different domain

If the frontend and the API live on different hosts, set `apiBase` in `apps/web/config.js`, set
`CORS_ORIGIN` on the API, and `APP_URL`/`API_URL` for the OAuth redirects.

## Environment variables

| Variable | Description |
| --- | --- |
| `APP_URL` | Public URL of the frontend (used in invites and the OAuth return). Default: the request origin. |
| `API_URL` | Public URL of the API (used in the OAuth `redirect_uri`). Default: the request origin. |
| `CORS_ORIGIN` | Allowed origins, comma separated, when the API is on another domain. |
| `ALLOW_SIGNUP` | `false` blocks the creation of new companies (closed instance). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Enable Google sign-in. |
| `GOOGLE_FETCH_GROUPS` | `true` fetches Google Workspace groups (requires the Cloud Identity API to be enabled). |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Enable GitHub sign-in (organization teams become Rewind teams). |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | Enable Microsoft Entra ID sign-in. |
| `MICROSOFT_FETCH_GROUPS` | `true` fetches groups (requires the `GroupMember.Read.All` permission with admin consent). |
| `RESEND_API_KEY` / `EMAIL_FROM` | Optional: sends invites and access-request emails through Resend. |
| `REWIND_DATABASE` | Azion: SQL Database name (default `rewind`). |
| `AZION_TOKEN` | Azion: personal token. Used by `npm run azion:setup`; on the function only with `--with-token` (SQL API fallback). |
| `REWIND_SQL_MODE` | Azion: `api` sends every query through the SQL Database REST API (needs `AZION_TOKEN`). |

Callback URL to register with each provider: `{API_URL}/api/auth/oauth/{google|github|microsoft}/callback`.

## Social sign-in (Google, Microsoft, GitHub)

Social sign-in is off until a provider has credentials. With it on, people never fill a sign-up form:
the first person from a company domain creates the company and becomes its admin, their provider groups
become Rewind teams, and colleagues from the same domain join the right team (see the next section).

1. **Create an OAuth app** with the provider, as a *Web application*, with this redirect/callback URL:
   `{API_URL}/api/auth/oauth/{provider}/callback`. Locally that's
   `http://localhost:8787/api/auth/oauth/google/callback` (or `github`, `microsoft`).
   - **Google**: [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → Create credentials →
     OAuth client ID. On the OAuth consent screen, choose **Internal** to use it only inside your Google Workspace.
   - **Microsoft**: [Entra ID](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
     → App registrations → New registration → platform **Web**. Create a client secret under *Certificates & secrets*.
     Set `MICROSOFT_TENANT` to your tenant ID to accept only your organization.
   - **GitHub**: [Developer settings](https://github.com/settings/developers) → OAuth Apps → New OAuth App.
2. **Set the credentials**: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (and the same for `GITHUB_*`, `MICROSOFT_*`)
   in `.env` locally, or in `.env.azion` followed by `npm run azion:setup` on Azion.
3. **Groups as teams (optional)**:
   - Google Workspace: enable the **Cloud Identity API** in the same Google Cloud project and set `GOOGLE_FETCH_GROUPS=true`.
   - Microsoft: add the `GroupMember.Read.All` permission, grant admin consent, and set `MICROSOFT_FETCH_GROUPS=true`.
   - GitHub: organization teams are always read (the app asks for `read:org`).

   Without groups, people land in the company's default team and an admin moves them later.
4. **Restart** so the settings are read: `docker compose up -d --force-recreate` (or the `dev` profile), or deploy again on Azion.

The sign-in and sign-up pages show a button per configured provider. When none is configured, they say so.

**Good to know**

- The company comes from the email domain (Google also uses the Workspace `hd` claim). Personal domains
  (gmail.com, outlook.com…) never become a shared company: those people get their own workspace.
- The first admin is asked whether colleagues from the domain may join automatically. If not, they need an invite.
- Rewind only accepts verified emails from the provider.

## How social sign-in picks the company and team

1. **Email already registered**: the person signs in, and the teams from their groups are synced.
2. **Came through an invite**: joins the invite's company and team.
3. **The domain already has a company**: if automatic sign-in is on, the person joins the team matching their groups (or the default team). If it's off, they need an invite.
4. **First person from the domain**: creates the company, becomes admin and chooses whether automatic sign-in is on.

Personal email domains (gmail.com, outlook.com, etc.) never become a shared company.

## Adding a provider or a storage backend

- **Provider**: add an entry to `packages/core/src/auth/providers.js` with `authorizeUrl`, `tokenUrl`,
  `scopes` and a `profile()` that returns `{ email, emailVerified, name, domain, groups }`.
- **Storage**: implement `get`, `put` (with optional `ttl`), `delete` and `list(prefix)`.
  For any SQL database, a driver with `all(sql, params)` and `run(sql, params)` is enough (see `packages/core/src/storage/sql.js`).

## License

MIT
