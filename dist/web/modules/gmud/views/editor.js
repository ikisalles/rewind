// Creating / editing a draft change, in five steps with a progress indicator. Every step saves
// itself while people type (autosave); nothing is lost when moving between steps.
import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, field, badge, attempt, confirmDialog, icon, pageHeader, modal, toast, fmtDateTime } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import {
  TYPES, TYPE_HINT, CATEGORIES, LEVEL, LIKELIHOOD, ENVS, STRATEGIES, ROLES, levelBadge, typeBadge,
  loadPeople, personName, peopleSelect, select, checkbox, dash, approversText,
} from '../lib.js';
import { prDetailModal, prTable, riskMatrix, calcRisk, githubPermissionsLink } from './parts.js';

const STEPS = [
  ['overview', '1. Overview', 'Title, owner, environment and window'],
  ['code', '2. Code & Changes', 'Repositories, PRs, versions and description'],
  ['risk', '3. Risk & Testing', 'Impact, risk, tests and rollback'],
  ['execution', '4. Execution', 'Strategy, owners and checklist'],
  ['approval', '5. Approval', 'Review and submit'],
];

export async function editorView(root, { params, query }) {
  await loadPeople();
  let v = await get(`/api/gmud/changes/${params.id}`);
  if (!v.can.edit) {
    toast(v.change.status === 'draft' ? "You can't edit this change" : 'Only drafts can be edited', 'error');
    location.replace(`#/changes/${params.id}`);
    return;
  }
  const step = STEPS.some(([id]) => id === query.get('step')) ? query.get('step') : 'overview';
  const id = v.change.id;

  // ---------------------------------------------------------------- autosave
  const status = h('span', { class: 'save-state muted small', 'aria-live': 'polite' }, 'All changes saved');
  let timer = null;
  let pending = null; // () => Promise
  let inflight = Promise.resolve();
  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `save-state small ${kind || 'muted'}`;
  };
  const run = (section, data) => {
    setStatus('Saving…');
    inflight = inflight
      .then(() => patch(`/api/gmud/changes/${id}`, { section, data }))
      .then((next) => {
        v = next;
        setStatus(`Saved at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
        drawStepper();
        return next;
      })
      .catch((e) => {
        setStatus(`Couldn't save: ${e.message}`, 'danger');
        throw e;
      });
    return inflight;
  };
  const schedule = (section, collect) => {
    clearTimeout(timer);
    setStatus('Unsaved changes…');
    pending = () => run(section, collect());
    timer = setTimeout(flush, 700);
  };
  async function flush() {
    clearTimeout(timer);
    const job = pending;
    pending = null;
    if (job) await job().catch(() => {});
    await inflight.catch(() => {});
  }
  const go = async (to) => {
    await flush();
    location.hash = `#/changes/${id}/edit?step=${to}`;
  };

  // ---------------------------------------------------------------- frame
  const stepper = h('ol', { class: 'stepper', 'aria-label': 'Steps' });
  const missingBy = (s) => v.readiness.missing.filter((m) => m.step === s);
  function drawStepper() {
    mount(
      stepper,
      STEPS.map(([sid, label, hint]) => {
        const missing = sid === 'approval' ? v.readiness.missing : missingBy(sid);
        const done = sid !== 'approval' && !missing.length;
        return h(
          'li',
          { class: `step${sid === step ? ' current' : ''}${done ? ' done' : ''}` },
          h(
            'button',
            { type: 'button', onClick: () => go(sid), 'aria-current': sid === step ? 'step' : undefined },
            h('span', { class: 'step-dot' }, done ? icon('check', 12) : String(STEPS.findIndex(([x]) => x === sid) + 1)),
            h('span', { class: 'step-text' }, h('strong', {}, label.replace(/^\d\.\s/, '')), h('span', { class: 'muted small' }, missing.length ? `${missing.length} to fill` : hint)),
          ),
        );
      }),
    );
  }
  drawStepper();

  const body = h('div', { class: 'step-body' });
  const index = STEPS.findIndex(([x]) => x === step);
  const nav = h(
    'div',
    { class: 'step-nav' },
    index > 0 ? button('Back', { onClick: () => go(STEPS[index - 1][0]) }) : h('span'),
    index < STEPS.length - 1 ? button(`Next: ${STEPS[index + 1][1].replace(/^\d\.\s/, '')}`, { variant: 'primary', onClick: () => go(STEPS[index + 1][0]) }) : null,
  );

  mount(
    root,
    pageHeader(
      v.change.overview.title || 'New change',
      [status, h('a', { class: 'btn btn-default', href: `#/changes/${id}`, onClick: async (e) => (e.preventDefault(), await flush(), (location.hash = `#/changes/${id}`)) }, 'View details')],
      [['Changes', '#/changes'], [v.change.number], ['Draft']],
    ),
    stepper,
    body,
    nav,
  );

  const ctx = { get v() { return v; }, set v(x) { v = x; drawStepper(); }, schedule, run, flush, body, id, go };
  await { overview, code, risk, execution, approval }[step](ctx);
  return () => void flush();
}

// ================================================================== 1. overview
function overview({ v, schedule, body }) {
  const o = v.change.overview;
  const teams = store.me.user.role === 'admin' ? store.me.teams : store.me.teams.filter((t) => store.me.user.teamIds.includes(t.id) || t.id === o.teamId);
  const collect = () => {
    const d = Object.fromEntries(new FormData(form));
    d.tags = (d.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    return d;
  };
  const form = h(
    'form',
    { class: 'panel stack', onInput: () => schedule('overview', collect), onChange: () => schedule('overview', collect), onSubmit: (e) => e.preventDefault() },
    h('div', { class: 'grid-2' }, field('Change ID', h('input', { value: v.change.number, disabled: true }), 'Generated automatically, never changes.'), field('Title *', h('input', { name: 'title', value: o.title, maxlength: 160, required: true, placeholder: 'e.g. Authentication module update' }))),
    h('div', { class: 'grid-2' }, field('Category *', select('category', CATEGORIES, o.category), 'The nature of the change. The SemVer type comes from the repositories in step 2.'), field('Priority *', select('priority', LEVEL, o.priority))),
    h('div', { class: 'grid-2' }, field('Responsible *', peopleSelect('responsibleId', o.responsibleId)), field('Team *', select('teamId', teams.map((t) => [t.id, t.name]), o.teamId))),
    h('div', { class: 'grid-2' }, field('Environment *', select('environment', ENVS, o.environment)), field('Planned date (window) *', h('input', { type: 'datetime-local', name: 'plannedAt', value: o.plannedAt }))),
    field('Tags', h('input', { name: 'tags', value: o.tags.join(', '), placeholder: 'auth, q4-launch' }), 'Separated by commas.'),
    h('p', { class: 'muted small' }, icon('info', 12), ' Repositories, pull requests, versions and the description come in step 2; the risk level in step 3.'),
  );
  mount(body, form);
}

// ================================================================== 2. code & changes
async function code(ctx) {
  const { body } = ctx;
  let gh = { connected: false };
  const draw = () => {
    const { repos, summary } = ctx.v.change.code;
    mount(
      body,
      gh.connected
        ? h('div', { class: 'banner' }, icon('github'), h('span', {}, 'Connected to GitHub as ', h('strong', {}, `@${gh.login}`), '. Import a release, compare branches/tags, or pick pull requests.'), h('span', { class: 'banner-end' }, icon('info', 14), githubPermissionsLink()))
        : h('div', { class: 'banner banner-accent' }, icon('github'), h('span', {}, gh.error ? `GitHub: ${gh.error} ` : 'Connect GitHub to import pull requests, commits and versions. '), h('a', { href: '#/account/integrations/github' }, 'My account → Integrations → GitHub'), h('span', { class: 'muted' }, ' You can also add repositories by hand.'), h('span', { class: 'banner-end' }, icon('info', 14), githubPermissionsLink())),
      h(
        'div',
        { class: 'section-row' },
        h('div', {}, h('h2', { class: 'section-title' }, `Repositories (${repos.length})`), h('p', { class: 'muted small' }, 'A change can include several repositories, each with its own pull requests and version.')),
        h('div', { class: 'btn-group' }, gh.connected ? button(repos.length ? 'Import another repository' : 'Import from GitHub', { variant: 'primary', iconName: 'github', onClick: () => importModal(ctx, null, save) }) : null, button('Add manually', { iconName: 'plus', onClick: () => manualModal(ctx, save) })),
      ),
      repos.length ? repos.map((r, i) => repoCard(ctx, r, i, save, gh)) : h('div', { class: 'panel empty-panel' }, 'No repositories yet. Each repository gets its own SemVer version.'),
      summaryBlock(ctx, summary, repos, draw),
    );
  };
  // saves the code section right away and redraws with what the server kept (suggestions, versions)
  async function save(repos, summary = ctx.v.change.code.summary) {
    await ctx.flush();
    const next = await ctx.run('code', { repos, summary }).catch(() => null);
    if (next) draw();
    return next;
  }
  draw();
  gh = await get('/api/gmud/github/status').catch(() => ({ connected: false }));
  draw();
}

function repoCard(ctx, r, i, save, gh) {
  const all = () => ctx.v.change.code.repos.map((x) => ({ ...x }));
  const update = (fields) => {
    const repos = all();
    repos[i] = { ...repos[i], ...fields };
    return save(repos);
  };
  const bumpTo = async (type) => {
    const base = r.currentVersion || '0.0.0';
    const { version } = await post('/api/gmud/semver/next', { version: base, bump: type });
    update({ bump: type, nextVersion: version, confirmed: false });
  };
  const nextInput = h('input', { value: r.nextVersion, class: 'mono version-input', placeholder: '2.4.0', 'aria-label': `Next version of ${r.repo}`, onChange: (e) => update({ nextVersion: e.target.value.trim(), confirmed: false }) });
  const currentInput = h('input', { value: r.currentVersion, class: 'mono version-input', placeholder: '2.3.1', 'aria-label': `Current version of ${r.repo}`, onChange: (e) => update({ currentVersion: e.target.value.trim() }) });
  const sug = r.suggested;
  return h(
    'section',
    { class: 'panel repo-card' },
    h(
      'div',
      { class: 'panel-head' },
      h('div', {}, h('h3', {}, icon(r.github ? 'github' : 'branch', 14), ' ', r.repo), h('p', { class: 'muted small' }, `${r.stats.prs} PRs · ${r.stats.commits} commits · ${r.stats.files} files${r.source.mode === 'compare' ? ` · ${r.source.base}…${r.source.head}` : r.source.mode === 'release' ? ` · release ${r.source.tag}` : ''}`)),
      h(
        'div',
        { class: 'btn-group' },
        r.github && gh.connected ? button('Add PRs', { size: 'sm', iconName: 'plus', onClick: () => importModal(ctx, r.repo, save) }) : null,
        button('', {
          variant: 'danger-ghost',
          iconName: 'trash',
          title: `Remove ${r.repo}`,
          onClick: async () => (await confirmDialog(`Remove ${r.repo} from this change?`, { confirmLabel: 'Remove', danger: true })) && save(all().filter((_, j) => j !== i)),
        }),
      ),
    ),
    h(
      'div',
      { class: 'version-row' },
      field('Current', currentInput),
      h('span', { class: 'version-arrow' }, '→'),
      field('Next', nextInput),
      field('Increment', select('bump', TYPES, r.bump, { empty: null, onChange: (e) => bumpTo(e.target.value) })),
      h(
        'div',
        { class: 'version-confirm' },
        r.confirmed
          ? badge(`Confirmed ${r.nextVersion}`, 'success', 'check')
          : r.nextVersion
            ? button(`Confirm ${r.nextVersion}`, { variant: 'primary', size: 'sm', onClick: () => update({ confirmed: true, confirmedVersion: r.nextVersion }) })
            : h('span', { class: 'muted small' }, 'Set the next version'),
      ),
    ),
    sug
      ? h('p', { class: 'muted small suggestion' }, icon('info', 12), ` Suggested: `, typeBadge(sug.bump), ` — ${sug.reasons.join('; ')}. `, sug.bump !== r.bump ? h('button', { type: 'button', class: 'link-btn', onClick: () => bumpTo(sug.bump) }, `Use ${TYPES[sug.bump]}`) : null)
      : null,
    r.prs.length ? prTable(r.prs, { onOpen: prDetailModal, onRemove: (n) => update({ prs: r.prs.filter((p) => p.number !== n) }) }) : h('p', { class: 'muted small' }, 'No pull requests linked.'),
  );
}

// The one description of the change, covering every repository: written here, next to the PRs,
// or generated from them.
function summaryBlock(ctx, summary, repos, redraw) {
  const text = summary.text || ctx.v.change.overview.description || '';
  const area = h('textarea', {
    rows: 7,
    maxlength: 8000,
    'aria-label': 'Description',
    placeholder: 'What changes, why, and what people will notice. One description for the whole change, across all repositories.',
    onInput: () =>
      ctx.schedule('code', () => ({
        repos: ctx.v.change.code.repos,
        summary: { text: area.value, origin: summary.origin === 'generated' || summary.origin === 'edited' ? 'edited' : 'manual' },
      })),
  }, text);
  return h(
    'section',
    { class: 'panel stack summary-block' },
    h(
      'div',
      { class: 'panel-head' },
      h('div', {}, h('h3', {}, 'Description *'), h('p', { class: 'muted small' }, 'One for the whole change. Write it, or generate a suggestion from the pull requests and review it.')),
      h(
        'div',
        { class: 'btn-group' },
        summary.origin === 'generated' ? badge('Generated suggestion', 'info', 'info') : summary.origin === 'edited' ? badge('Generated suggestion · edited', 'info', 'edit') : null,
        button(text ? 'Regenerate from PRs' : 'Generate from PRs', {
          size: 'sm',
          disabled: !repos.length,
          onClick: async () => {
            if (text && !(await confirmDialog('Replace the current description with a suggestion generated from the pull requests?'))) return;
            await ctx.flush();
            const r = await attempt(() => post(`/api/gmud/changes/${ctx.id}/summary`));
            if (r) {
              ctx.v = r;
              redraw();
            }
          },
        }),
      ),
    ),
    area,
  );
}

function manualModal(ctx, save) {
  const m = modal({
    title: 'Add a repository',
    body: h(
      'form',
      {
        id: 'manual-repo',
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const d = Object.fromEntries(new FormData(e.target));
          m.close();
          await save([...ctx.v.change.code.repos, { repo: d.repo.trim(), currentVersion: d.currentVersion.trim(), nextVersion: d.nextVersion.trim(), prs: [], source: { mode: 'manual' } }]);
        },
      },
      field('Repository *', h('input', { name: 'repo', required: true, placeholder: 'owner/name or service name', maxlength: 140 })),
      h('div', { class: 'grid-2' }, field('Current version', h('input', { name: 'currentVersion', placeholder: '2.3.1', class: 'mono' })), field('Next version', h('input', { name: 'nextVersion', placeholder: '2.4.0', class: 'mono' }))),
    ),
    actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'manual-repo' }, 'Add')],
  });
}

// ---------------------------------------------------------------- GitHub import
function importModal(ctx, fixedRepo, save) {
  let repo = fixedRepo;
  let mode = 'release';
  const m = modal({ title: fixedRepo ? `Add pull requests · ${fixedRepo}` : 'Import from GitHub', wide: true, body: h('p', { class: 'muted' }, 'Loading…') });

  // adds what GitHub returned to the change's repositories (new repository, or more PRs for one)
  const merge = (repos, name, res, source) => {
    const at = repos.findIndex((x) => x.repo === name);
    if (at >= 0) {
      const known = new Set(repos[at].prs.map((p) => p.number));
      repos[at] = { ...repos[at], github: true, prs: [...repos[at].prs, ...res.prs.filter((p) => !known.has(p.number))], currentVersion: repos[at].currentVersion || res.currentVersion, stats: {} };
    } else {
      repos.push({ repo: name, github: true, currentVersion: res.currentVersion, nextVersion: res.nextVersion, bump: res.suggested.bump, prs: res.prs, source, stats: { commits: res.commits, files: res.files } });
    }
  };

  // after an import: say what came in, and offer another repository right away
  const done = (lines) => {
    if (fixedRepo) return m.close();
    m.setBody(
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'banner' }, icon('check'), h('div', {}, lines.map((l) => h('div', {}, l)))),
        h('p', { class: 'muted' }, `This change now has ${ctx.v.change.code.repos.length} repositor${ctx.v.change.code.repos.length === 1 ? 'y' : 'ies'}. A change can include as many as it needs, each with its own pull requests and version.`),
        h('div', { class: 'btn-group' }, button('Import another repository', { variant: 'primary', iconName: 'plus', onClick: () => ((repo = null), draw()) }), button('Done', { onClick: () => m.close() })),
      ),
    );
  };

  const finish = async (payload) => {
    m.setBody(h('p', { class: 'muted' }, 'Importing pull requests, reviews, commits and checks…'));
    const res = await attempt(() => post('/api/gmud/github/import', { repo, mode, ...payload }));
    if (!res) return draw();
    const repos = ctx.v.change.code.repos.map((x) => ({ ...x }));
    merge(repos, repo, res, { mode, base: payload.base || '', head: payload.head || '', tag: payload.tag || '' });
    await save(repos);
    done([`${repo}: ${res.prs.length} pull request${res.prs.length === 1 ? '' : 's'} imported${res.truncated ? ` (the first ${res.prs.length} of ${res.found})` : ''}.`]);
  };

  // "https://github.com/acme/api/pull/12" or "acme/api#12", from any repositories at once
  const importLinks = async (text) => {
    const byRepo = new Map();
    for (const m2 of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)|\b([\w.-]+\/[\w.-]+)#(\d+)/g)) {
      const name = m2[1] || m2[3];
      byRepo.set(name, [...(byRepo.get(name) || []), Number(m2[2] || m2[4])]);
    }
    if (!byRepo.size) return toast('No pull request links found', 'error');
    const repos = ctx.v.change.code.repos.map((x) => ({ ...x }));
    const lines = [];
    for (const [name, numbers] of byRepo) {
      m.setBody(h('p', { class: 'muted' }, `Importing ${name}…`));
      try {
        const res = await post('/api/gmud/github/import', { repo: name, mode: 'prs', numbers });
        merge(repos, name, res, { mode: 'prs' });
        lines.push(`${name}: ${res.prs.length} pull request${res.prs.length === 1 ? '' : 's'} imported.`);
      } catch (e) {
        lines.push(`${name}: ${e.message}`);
      }
    }
    await save(repos);
    done(lines);
  };

  async function pickRepo() {
    const listBox = h('div', { class: 'pick-list' }, h('p', { class: 'muted' }, 'Loading repositories…'));
    let data = { orgs: [], repos: [] };
    const search = h('input', { type: 'search', placeholder: 'Search repositories', 'aria-label': 'Search repositories', onInput: () => drawList() });
    const owner = h('select', { 'aria-label': 'Organization', onChange: () => drawList() });
    const drawList = () => {
      const q = search.value.toLowerCase();
      const list = data.repos.filter((r) => (!owner.value || r.owner === owner.value) && r.fullName.toLowerCase().includes(q)).slice(0, 60);
      mount(
        listBox,
        list.length
          ? list.map((r) => h('button', { type: 'button', class: 'pick-item', onClick: () => ((repo = r.fullName), draw()) }, h('strong', {}, r.fullName), r.private ? badge('Private', 'neutral', 'lock') : null, h('span', { class: 'muted small' }, r.description)))
          : h('p', { class: 'muted' }, 'No repository found.'),
      );
    };
    const links = h('textarea', { rows: 3, placeholder: 'https://github.com/acme/auth-service/pull/41\nhttps://github.com/acme/api-gateway/pull/7\nacme/frontend#120', 'aria-label': 'Pull request links' });
    m.setBody(
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'panel stack-sm' }, h('strong', {}, 'Paste pull request links'), h('span', { class: 'muted small' }, 'From one or several repositories: each repository is added with its PRs.'), links, h('div', {}, button('Import links', { variant: 'primary', size: 'sm', onClick: () => importLinks(links.value) }))),
        h('div', { class: 'divider' }, 'or pick a repository, then a release, a comparison or PRs'),
        h('div', { class: 'grid-2' }, owner, search),
        listBox,
      ),
    );
    data = await attempt(() => get('/api/gmud/github/repos'));
    if (!data) return m.close();
    const logins = [...new Set(data.repos.map((r) => r.owner))];
    mount(owner, h('option', { value: '' }, 'All organizations and accounts'), logins.map((l) => h('option', { value: l }, l)));
    drawList();
  }

  function draw() {
    if (!repo) return pickRepo();
    const tabs = [
      ['release', 'From a release'],
      ['compare', 'Compare branches/tags'],
      ['prs', 'Select PRs'],
    ];
    const pane = h('div', { class: 'stack' });
    m.setBody(
      h('div', { class: 'stack' }, h('p', {}, 'Repository: ', h('strong', {}, repo), fixedRepo ? null : [' ', h('button', { type: 'button', class: 'link-btn', onClick: () => ((repo = null), draw()) }, 'change')]), h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { type: 'button', class: `tab${mode === id ? ' active' : ''}`, onClick: () => ((mode = id), draw()) }, label))), pane),
    );
    ({ release: releasePane, compare: comparePane, prs: prsPane })[mode](pane);
  }

  async function releasePane(pane) {
    mount(pane, h('p', { class: 'muted' }, 'Loading releases…'));
    const r = await attempt(() => get(`/api/gmud/github/releases?repo=${encodeURIComponent(repo)}`));
    if (!r) return;
    if (!r.releases.length) return mount(pane, h('p', { class: 'muted' }, 'This repository has no GitHub Releases. Compare two refs instead.'));
    const sel = select('tag', r.releases.map((x) => [x.tag, `${x.name}${x.prerelease ? ' (pre-release)' : ''} · ${x.publishedAt ? new Date(x.publishedAt).toLocaleDateString() : ''}`]), r.releases[0].tag, { empty: null });
    mount(pane, field('Release', sel, 'Imports every pull request since the release before it. The version comes from the tag.'), h('div', {}, button('Import release', { variant: 'primary', onClick: () => finish({ tag: sel.value }) })));
  }

  async function comparePane(pane) {
    mount(pane, h('p', { class: 'muted' }, 'Loading branches and tags…'));
    const [refs, latest] = await Promise.all([attempt(() => get(`/api/gmud/github/refs?repo=${encodeURIComponent(repo)}`)), get(`/api/gmud/github/latest?repo=${encodeURIComponent(repo)}`).catch(() => ({}))]);
    if (!refs) return;
    const options = [...refs.tags.map((t) => [t, `tag ${t}`]), ...refs.branches.map((b) => [b, `branch ${b}`])];
    const base = select('base', options, latest.tag || refs.tags[0] || refs.defaultBranch, { empty: null });
    const head = select('head', options, refs.defaultBranch, { empty: null });
    mount(
      pane,
      h('div', { class: 'grid-2' }, field('From (base)', base, latest.tag ? `Latest published version: ${latest.tag}` : 'No published version found.'), field('To (head)', head)),
      h('div', {}, button('Compare and import', { variant: 'primary', onClick: () => finish({ base: base.value, head: head.value }) })),
    );
  }

  function prsPane(pane) {
    const chosen = new Set();
    const list = h('div', { class: 'pick-list' });
    const count = h('span', { class: 'muted small' }, '0 selected');
    const search = h('input', { type: 'search', placeholder: 'Search pull requests (title, author:name, label:x…)', 'aria-label': 'Search pull requests' });
    let t = null;
    const load = async () => {
      mount(list, h('p', { class: 'muted' }, 'Loading…'));
      const r = await get(`/api/gmud/github/pulls?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(search.value)}`).catch((e) => (mount(list, h('p', { class: 'danger' }, e.message)), null));
      if (!r) return;
      mount(
        list,
        r.pulls.length
          ? r.pulls.map((p) =>
              h(
                'label',
                { class: 'pick-item pick-check' },
                h('input', { type: 'checkbox', checked: chosen.has(p.number), onChange: (e) => (e.target.checked ? chosen.add(p.number) : chosen.delete(p.number), (count.textContent = `${chosen.size} selected`)) }),
                h('span', { class: 'mono' }, `#${p.number}`),
                h('strong', {}, p.title),
                badge(p.state, p.state === 'merged' ? 'accent' : p.state === 'open' ? 'success' : 'neutral'),
                h('span', { class: 'muted small' }, p.author ? `@${p.author}` : ''),
              ),
            )
          : h('p', { class: 'muted' }, 'No pull requests found.'),
      );
    };
    search.addEventListener('input', () => (clearTimeout(t), (t = setTimeout(load, 400))));
    mount(pane, search, list, h('div', { class: 'section-row' }, count, button('Import selected', { variant: 'primary', onClick: () => (chosen.size ? finish({ numbers: [...chosen] }) : toast('Pick at least one pull request', 'error')) })));
    load();
  }

  draw();
}

// ================================================================== 3. risk & testing
function risk({ v, schedule, body }) {
  const r = v.change.risk;
  const t = v.change.testing;
  const rb = v.change.rollback;
  const isProd = v.change.overview.environment === 'production';
  const evidence = h('div', { class: 'stack-sm' });
  const addEvidence = (e = { label: '', url: '' }) =>
    evidence.append(
      h('div', { class: 'evidence-row' }, h('input', { 'data-ev': 'label', value: e.label, placeholder: 'Label (e.g. CI run)', maxlength: 120 }), h('input', { 'data-ev': 'url', value: e.url, type: 'url', placeholder: 'https://…' }), button('', { variant: 'ghost', iconName: 'x', title: 'Remove', onClick: (ev) => (ev.currentTarget.parentElement.remove(), save()) })),
    );
  t.evidence.forEach(addEvidence);

  const matrix = h('div', {});
  const collect = () => {
    const d = Object.fromEntries(new FormData(form));
    const flag = (k) => d[k] === 'on';
    return {
      affectedSystems: d.affectedSystems, affectedServices: d.affectedServices, customerImpact: d.customerImpact, downtime: d.downtime, dependencies: d.dependencies,
      dataMigration: flag('dataMigration'), probability: d.probability, impact: d.impact, override: d.override, justification: d.justification,
      indicators: { infrastructure: flag('ind_infrastructure'), database: flag('ind_database'), api: flag('ind_api'), security: flag('ind_security') },
      testing: {
        unit: flag('unit'), integration: flag('integration'), e2e: flag('e2e'), codeReview: flag('codeReview'), ciChecks: flag('ciChecks'),
        evidence: [...evidence.children].map((row) => ({ label: row.querySelector('[data-ev=label]').value, url: row.querySelector('[data-ev=url]').value })).filter((e) => e.url),
        acceptance: d.acceptance, postDeploy: d.postDeploy,
      },
      rollback: { notApplicable: flag('notApplicable'), justification: d.rbJustification, strategy: d.rbStrategy, procedure: d.rbProcedure, previousVersion: d.rbPrevious, ownerId: d.rbOwner, recoveryTime: d.rbRecovery, triggers: d.rbTriggers },
    };
  };
  const overrideSelect = select('override', LEVEL, r.override || v.change.overview.riskLevel || '', { empty: 'Use the calculated level' });
  const save = () => {
    const d = collect();
    mount(matrix, riskMatrix(d.probability, d.impact));
    rbPlan.hidden = d.rollback.notApplicable;
    rbWhy.hidden = !d.rollback.notApplicable;
    schedule('risk', () => d);
  };
  const prev = v.change.code.repos.filter((x) => x.currentVersion).map((x) => `${x.repo.split('/').pop()} ${x.currentVersion}`).join(', ');
  const rbPlan = h(
    'div',
    { class: 'stack', hidden: rb.notApplicable },
    h('div', { class: 'grid-2' }, field(`Strategy${isProd ? ' *' : ''}`, h('input', { name: 'rbStrategy', value: rb.strategy, placeholder: 'Redeploy the previous release' })), field('Previous version / stable artifact', h('input', { name: 'rbPrevious', value: rb.previousVersion || prev, placeholder: 'auth-service 2.3.1' }))),
    field(`Procedure${isProd ? ' *' : ''}`, h('textarea', { name: 'rbProcedure', rows: 4, placeholder: '1. …\n2. …' }, rb.procedure)),
    h('div', { class: 'grid-2' }, field('Rollback owner', peopleSelect('rbOwner', rb.ownerId)), field('Estimated recovery time', h('input', { name: 'rbRecovery', value: rb.recoveryTime, placeholder: '15 minutes' }))),
    field('Rollback triggers', h('textarea', { name: 'rbTriggers', rows: 3, placeholder: '5xx rate above 2% for 5 min; p95 latency above 800 ms; login failures' }, rb.triggers), 'Objective conditions to revert.'),
  );
  const rbWhy = h('div', { hidden: !rb.notApplicable }, field('Why rollback does not apply *', h('textarea', { name: 'rbJustification', rows: 3 }, rb.justification)));

  const form = h(
    'form',
    { class: 'stack', onInput: save, onChange: save, onSubmit: (e) => e.preventDefault() },
    h(
      'section',
      { class: 'panel stack' },
      h('h3', {}, 'Impact assessment'),
      h('div', { class: 'grid-2' }, field('Affected systems', h('input', { name: 'affectedSystems', value: r.affectedSystems, placeholder: 'Authentication API' })), field('Affected services', h('input', { name: 'affectedServices', value: r.affectedServices, placeholder: 'auth-service, api-gateway' }))),
      field('Customer impact', h('textarea', { name: 'customerImpact', rows: 2, placeholder: 'Possible sign-in failures' }, r.customerImpact)),
      h('div', { class: 'grid-2' }, field('Expected downtime', h('input', { name: 'downtime', value: r.downtime, placeholder: 'No downtime' })), field('Dependencies', h('input', { name: 'dependencies', value: r.dependencies, placeholder: 'Redis, PostgreSQL' }))),
      checkbox('dataMigration', 'Includes a data migration', r.dataMigration),
    ),
    h(
      'section',
      { class: 'panel stack' },
      h('h3', {}, 'Risk assessment'),
      h(
        'div',
        { class: 'risk-grid' },
        h(
          'div',
          { class: 'stack' },
          field('Likelihood of failure *', select('probability', LIKELIHOOD, r.probability)),
          field('Impact if it fails *', select('impact', LIKELIHOOD, r.impact)),
          field('Risk level', overrideSelect, 'Calculated from the matrix; set it by hand only when the matrix doesn’t tell the whole story (explain why below).'),
        ),
        matrix,
      ),
      field('Justification', h('textarea', { name: 'justification', rows: 2 }, r.justification)),
      h('fieldset', { class: 'checks inline-checks' }, h('legend', {}, 'This change touches'), checkbox('ind_infrastructure', 'Infrastructure', r.indicators.infrastructure), checkbox('ind_database', 'Database', r.indicators.database), checkbox('ind_api', 'API / contract', r.indicators.api), checkbox('ind_security', 'Security (adds a security approval)', r.indicators.security)),
    ),
    h(
      'section',
      { class: 'panel stack' },
      h('h3', {}, 'Testing & validation'),
      h('fieldset', { class: 'checks inline-checks' }, h('legend', {}, 'Done'), checkbox('unit', 'Unit tests', t.unit), checkbox('integration', 'Integration tests', t.integration), checkbox('e2e', 'E2E tests', t.e2e), checkbox('codeReview', 'Code review', t.codeReview), checkbox('ciChecks', 'CI/CD checks passed', t.ciChecks)),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Evidence (links)'), evidence, h('div', {}, button('Add link', { size: 'sm', iconName: 'plus', onClick: () => addEvidence() }))),
      h('div', { class: 'grid-2' }, field('Acceptance criteria', h('textarea', { name: 'acceptance', rows: 3 }, t.acceptance)), field('Post-deployment validation', h('textarea', { name: 'postDeploy', rows: 3 }, t.postDeploy))),
    ),
    h(
      'section',
      { class: 'panel stack' },
      h('div', { class: 'panel-head' }, h('div', {}, h('h3', {}, 'Rollback plan'), h('p', { class: 'muted small' }, isProd ? 'Required for production: a plan, or why rollback does not apply.' : 'Recommended. Required when the environment is production.'))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'notApplicable', checked: rb.notApplicable }), h('span', { class: 'switch-ui' }), h('span', {}, 'Rollback does not apply to this change')),
      rbWhy,
      rbPlan,
    ),
  );
  mount(matrix, riskMatrix(r.probability, r.impact));
  mount(body, form);
}

// ================================================================== 4. execution
function execution({ v, schedule, body }) {
  const e = v.change.execution;
  const o = v.change.overview;
  const steps = h('div', { class: 'steps-edit' });
  const addStep = (s = { id: '', title: '', detail: '', ownerId: '', eta: '' }) => {
    const row = h(
      'div',
      { class: 'step-row', 'data-id': s.id },
      h('div', { class: 'step-move' }, button('', { size: 'xs', variant: 'ghost', iconName: 'up', title: 'Move up', onClick: () => (row.previousElementSibling && row.parentElement.insertBefore(row, row.previousElementSibling), save()) }), button('', { size: 'xs', variant: 'ghost', iconName: 'down', title: 'Move down', onClick: () => (row.nextElementSibling && row.parentElement.insertBefore(row.nextElementSibling, row), save()) })),
      h('div', { class: 'stack-sm grow' }, h('input', { 'data-k': 'title', value: s.title, placeholder: 'Step', maxlength: 160, 'aria-label': 'Step' }), h('input', { 'data-k': 'detail', value: s.detail, placeholder: 'Details (optional)', maxlength: 500, 'aria-label': 'Details' })),
      h('div', { class: 'stack-sm' }, peopleSelect('', s.ownerId, { empty: 'Owner', 'data-k': 'ownerId', 'aria-label': 'Owner' }), h('input', { type: 'datetime-local', 'data-k': 'eta', value: s.eta, 'aria-label': 'Estimated time' })),
      button('', { variant: 'danger-ghost', iconName: 'trash', title: 'Remove step', onClick: () => (row.remove(), save()) }),
    );
    steps.append(row);
  };
  e.steps.forEach(addStep);
  const collect = () => {
    const d = Object.fromEntries(new FormData(form));
    d.steps = [...steps.children].map((row) => {
      const val = (k) => row.querySelector(`[data-k=${k}]`).value;
      const old = e.steps.find((s) => s.id === row.dataset.id) || {};
      return { ...old, id: row.dataset.id, title: val('title'), detail: val('detail'), ownerId: val('ownerId'), eta: val('eta') };
    });
    return d;
  };
  const save = () => schedule('execution', collect);
  const form = h(
    'form',
    { class: 'stack', onInput: save, onChange: save, onSubmit: (ev) => ev.preventDefault() },
    h(
      'section',
      { class: 'panel stack' },
      h('h3', {}, 'Execution plan'),
      h('div', { class: 'grid-2' }, field('Deployment strategy', select('strategy', STRATEGIES, e.strategy)), field('Estimated duration', h('input', { name: 'duration', value: e.duration, placeholder: '30 minutes' }))),
      h('div', { class: 'grid-2' }, field('Target environment', h('input', { value: ENVS[o.environment] || 'Set in Overview', disabled: true })), field('Planned start', h('input', { value: o.plannedAt ? fmtDateTime(o.plannedAt) : 'Set in Overview', disabled: true }))),
      h('div', { class: 'grid-2' }, field('Execution owner', peopleSelect('ownerId', e.ownerId)), field('Monitoring owner', peopleSelect('monitoringOwnerId', e.monitoringOwnerId))),
      h('div', { class: 'grid-2' }, field('Deployment pipeline', h('input', { name: 'pipeline', value: e.pipeline, placeholder: 'GitHub Actions' })), field('Deployment URL', h('input', { name: 'deploymentUrl', type: 'url', value: e.deploymentUrl, placeholder: 'Link to the workflow' }))),
      h('p', { class: 'muted small' }, icon('info', 12), ' Rewind records the deployment; it does not trigger it.'),
    ),
    h('section', { class: 'panel stack' }, h('div', { class: 'panel-head' }, h('div', {}, h('h3', {}, 'Execution checklist'), h('p', { class: 'muted small' }, 'Each step gets a status, evidence and notes during execution.'))), steps, h('div', {}, button('Add step', { size: 'sm', iconName: 'plus', onClick: () => (addStep(), save()) }))),
  );
  mount(body, form);
}

// ================================================================== 5. approval
async function approval(ctx) {
  const { body, id } = ctx;
  const { settings } = await get('/api/gmud/settings');
  const draw = () => {
    const v = ctx.v;
    const { missing } = v.readiness;
    const stepName = Object.fromEntries(STEPS.map(([sid, label]) => [sid, label]));
    const approversOf = (role) => approversText(settings, role);
    mount(
      body,
      h(
        'section',
        { class: 'panel stack' },
        h('h3', {}, missing.length ? `${missing.length} item${missing.length === 1 ? '' : 's'} left before submitting` : 'Ready to submit'),
        missing.length
          ? h('ul', { class: 'missing-list' }, missing.map((m) => h('li', {}, icon('alert', 14), h('span', {}, m.message), h('button', { type: 'button', class: 'link-btn', onClick: () => ctx.go(m.step) }, stepName[m.step]))))
          : h('p', { class: 'muted' }, 'Everything required is filled in. Next: review the change as a document, then submit it. Approvers see it on the change page and on their home page.'),
      ),
      h(
        'section',
        { class: 'panel stack' },
        h('h3', {}, 'Approvals this change will need'),
        h('p', { class: 'muted small' }, 'From your company rules: risk, environment and category.', ' ', settings.allowSelfApproval ? '' : 'People can’t approve a change they requested.'),
        h('div', { class: 'approval-list' }, v.requiredPreview.map((role) => h('div', { class: 'approval-item' }, icon(role === 'security' ? 'shield' : 'check', 14), h('div', {}, h('strong', {}, ROLES[role]), h('div', { class: 'muted small' }, approversOf(role)))))),
        h('div', { class: 'kv-inline muted small' }, 'Risk: ', levelBadge(v.change.risk.override || v.change.overview.riskLevel || v.change.risk.calculated), ' · Environment: ', dash(ENVS[v.change.overview.environment]), ' · Category: ', dash(CATEGORIES[v.change.overview.category])),
      ),
      h(
        'div',
        { class: 'step-nav' },
        button('Delete draft', {
          variant: 'danger-ghost',
          iconName: 'trash',
          onClick: async () => {
            if (!(await confirmDialog(`Delete ${v.change.number}? This can't be undone.`, { confirmLabel: 'Delete', danger: true }))) return;
            if (await attempt(() => del(`/api/gmud/changes/${id}`), 'Draft deleted')) location.hash = '#/changes';
          },
        }),
        button('Preview document and submit', {
          variant: 'primary',
          iconName: 'file',
          onClick: async () => {
            await ctx.flush();
            location.hash = `#/changes/${id}/document`;
          },
        }),
      ),
    );
  };
  draw();
}

export { calcRisk };
