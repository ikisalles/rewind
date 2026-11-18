// Releases (SemVer versions per repository, with notes) and Deployments (per environment).
import { get, patch } from '@rewind/web/api.js';
import { keepUpdated } from '@rewind/web/live.js';
import { h, mount, button, field, badge, attempt, pageHeader, section, modal, fmtDate } from '@rewind/web/ui.js';
import { RELEASE_STATUS, DEPLOY_STATUS, ENVS, loadPeople, select, pairBadge, typeBadge } from '../lib.js';
import { releaseTable, deploymentTable } from './detail.js';

const relState = { repo: '', status: '' };

// both pages follow the company's channel: new releases and deployment statuses appear live
const follow = async (root, render) => {
  await render();
  return keepUpdated(root, render, '/api/gmud/live', { pollMs: 15_000 });
};

export const releasesView = (root) => follow(root, () => renderReleases(root));
export const deploymentsView = (root) => follow(root, () => renderDeployments(root));

async function renderReleases(root) {
  await loadPeople();
  const { releases } = await get('/api/gmud/releases');
  const repos = [...new Set(releases.map((r) => r.repo))].sort();
  const body = h('div', {});

  // the latest released (or planned) version of each repository
  const latestByRepo = repos.map((repo) => {
    const list = releases.filter((r) => r.repo === repo);
    return { repo, released: list.find((r) => r.status === 'released'), planned: list.find((r) => r.status === 'planned') };
  });

  const draw = () => {
    const rows = releases.filter((r) => (!relState.repo || r.repo === relState.repo) && (!relState.status || r.status === relState.status));
    mount(body, section(`History (${rows.length})`, releaseTable(rows, { onOpen: (r) => openRelease(r, () => renderReleases(root)) })));
  };
  const filter = (key, el) => (el.addEventListener('change', () => ((relState[key] = el.value), draw())), el);

  mount(
    root,
    pageHeader('Releases', [], [['GMUD']]),
    repos.length
      ? section(
          'Repositories',
          h(
            'div',
            { class: 'card-grid' },
            latestByRepo.map(({ repo, released, planned }) =>
              h(
                'button',
                { type: 'button', class: 'dash-card repo-tile', onClick: () => ((relState.repo = repo), renderReleases(root)) },
                h('div', { class: 'card-head' }, h('strong', {}, repo)),
                h('div', { class: 'mono version-big' }, released?.version || '—'),
                h('div', { class: 'muted small' }, released ? `Released ${fmtDate(released.releasedAt)}` : 'Nothing released yet'),
                planned ? h('div', { class: 'card-tags' }, badge(`Next: ${planned.version}`, 'info', 'clock')) : null,
              ),
            ),
          ),
        )
      : h('div', { class: 'panel empty-panel' }, 'No releases yet. A release is planned for each repository when its change is approved.'),
    repos.length
      ? h('div', { class: 'gmud-filters' }, filter('repo', select('repo', repos.map((r) => [r, r]), relState.repo, { empty: 'All repositories', 'aria-label': 'Repository' })), filter('status', select('status', RELEASE_STATUS, relState.status, { empty: 'Any status', 'aria-label': 'Status' })))
      : null,
    body,
  );
  if (repos.length) draw();
}

// the list holds summaries: notes and PRs come from the change the release belongs to
async function openRelease(r, reload) {
  const res = await attempt(() => get(`/api/gmud/changes/${r.changeId}/releases`));
  const full = res?.releases.find((x) => x.id === r.id);
  if (full) notesModal(full, reload);
}

function notesModal(r, reload) {
  const area = h('textarea', { rows: 14, class: 'mono', maxlength: 20000 }, r.notes);
  const m = modal({
    title: `${r.repo} ${r.version}`,
    wide: true,
    body: [
      h('div', { class: 'card-tags' }, pairBadge(RELEASE_STATUS, r.status), typeBadge(r.bump), badge(`tag ${r.tag}`, 'neutral', 'tag'), h('a', { href: `#/changes/${r.changeId}` }, r.changeNumber), r.notesOrigin === 'generated' ? badge('Generated suggestion', 'info', 'info') : badge('Edited', 'neutral', 'edit')),
      field('Release notes', area, 'Generated from the pull requests when the change was approved. Edit them as needed.'),
      r.prs.length ? h('ul', { class: 'plain-list small' }, r.prs.map((p) => h('li', {}, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number}`) : `#${p.number}`, ` ${p.title}`))) : null,
    ],
    actions: [
      button('Close', { onClick: () => m.close() }),
      button('Save notes', {
        variant: 'primary',
        onClick: async () => {
          if (await attempt(() => patch(`/api/gmud/releases/${r.id}`, { notes: area.value }), 'Release notes saved')) {
            m.close();
            reload();
          }
        },
      }),
    ],
  });
}

const depState = { environment: '', status: '' };

async function renderDeployments(root) {
  await loadPeople();
  const { deployments } = await get('/api/gmud/deployments');
  const body = h('div', {});
  const reload = () => renderDeployments(root);
  const draw = () => {
    const rows = deployments.filter((d) => (!depState.environment || d.environment === depState.environment) && (!depState.status || d.status === depState.status));
    mount(body, deploymentTable(rows, reload, { showChange: true }));
  };
  const filter = (key, el) => (el.addEventListener('change', () => ((depState[key] = el.value), draw())), el);
  mount(
    root,
    pageHeader('Deployments', [], [['GMUD']]),
    h('p', { class: 'muted section-hint' }, 'Deployments are registered from a change (Execution tab): Rewind records them, it does not run them.'),
    h('div', { class: 'gmud-filters' }, filter('environment', select('environment', ENVS, depState.environment, { empty: 'Any environment', 'aria-label': 'Environment' })), filter('status', select('status', DEPLOY_STATUS, depState.status, { empty: 'Any status', 'aria-label': 'Status' }))),
    body,
  );
  draw();
}

