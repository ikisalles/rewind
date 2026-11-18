// Pieces shared by the form and the details page: pull request table and details, risk matrix.
import { h, badge, button, modal, icon, table, fmtDateTime } from '@rewind/web/ui.js';
import { LEVEL, LIKELIHOOD } from '../lib.js';

const ORDER = ['low', 'medium', 'high'];

export function calcRisk(p, i) {
  const a = ORDER.indexOf(p) + 1;
  const b = ORDER.indexOf(i) + 1;
  if (!a || !b) return null;
  const s = a * b;
  return s >= 9 ? 'critical' : s >= 6 ? 'high' : s >= 3 ? 'medium' : 'low';
}

// 3×3 likelihood × impact grid; the cell of this change is highlighted.
export function riskMatrix(probability, impact) {
  const level = calcRisk(probability, impact);
  return h(
    'div',
    { class: 'risk-matrix-wrap' },
    h(
      'div',
      { class: 'risk-matrix', role: 'table', 'aria-label': 'Risk matrix: likelihood by impact' },
      h('span', { class: 'rm-corner small muted' }, 'Likelihood ↓ / Impact →'),
      ORDER.map((i) => h('span', { class: 'rm-head small muted', role: 'columnheader' }, LIKELIHOOD[i])),
      [...ORDER].reverse().map((p) => [
        h('span', { class: 'rm-head small muted', role: 'rowheader' }, LIKELIHOOD[p]),
        ORDER.map((i) => {
          const cell = calcRisk(p, i);
          const on = p === probability && i === impact;
          return h('span', { class: `rm-cell rm-${cell}${on ? ' on' : ''}`, role: 'cell', title: `${LIKELIHOOD[p]} likelihood × ${LIKELIHOOD[i]} impact = ${LEVEL[cell][0]}` }, on ? icon('check', 12) : null, LEVEL[cell][0]);
        }),
      ]),
    ),
    h('p', { class: 'small' }, 'Calculated risk: ', level ? badge(LEVEL[level][0], LEVEL[level][1]) : h('span', { class: 'muted' }, 'pick likelihood and impact')),
  );
}

const checksBadge = (c) => {
  if (!c || c.state === 'none' || !c.total) return badge('No checks');
  if (c.state === 'success') return badge(`${c.passed}/${c.total} passed`, 'success', 'check');
  if (c.state === 'failure') return badge(`${c.failed} failed`, 'danger', 'x');
  return badge(`${c.passed}/${c.total} pending`, 'warning', 'clock');
};
const stateBadge = (s) => badge(s || '—', s === 'merged' ? 'accent' : s === 'open' ? 'success' : 'neutral');

export function prTable(prs, { onOpen, onRemove } = {}) {
  return table(
    ['PR', 'Title', 'Author', 'Reviews', 'Checks', 'Merged', ''],
    prs.map((p) =>
      h(
        'tr',
        {},
        h('td', { class: 'mono nowrap' }, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number}`) : `#${p.number}`),
        h('td', {}, h('button', { type: 'button', class: 'link-btn pr-title', onClick: () => onOpen?.(p) }, p.title), p.labels.length ? h('div', { class: 'card-tags' }, p.labels.slice(0, 5).map((l) => badge(l))) : null),
        h('td', { class: 'nowrap small' }, p.author ? `@${p.author}` : '—'),
        h('td', { class: 'nowrap' }, p.approvals ? badge(`${p.approvals} approved`, 'success', 'check') : p.reviewers.length ? badge(`${p.reviewers.length} reviewer${p.reviewers.length > 1 ? 's' : ''}`) : h('span', { class: 'muted small' }, 'none')),
        h('td', { class: 'nowrap' }, checksBadge(p.checks)),
        h('td', { class: 'nowrap small' }, p.mergedAt ? fmtDateTime(p.mergedAt) : stateBadge(p.state)),
        h('td', { class: 'right' }, onRemove ? button('', { size: 'xs', variant: 'ghost', iconName: 'x', title: `Remove #${p.number}`, onClick: () => onRemove(p.number) }) : null),
      ),
    ),
  );
}

export function prDetailModal(p) {
  const list = (title, items, render) => (items.length ? h('div', { class: 'stack-sm' }, h('strong', {}, `${title} (${items.length})`), h('ul', { class: 'plain-list' }, items.map((x) => h('li', {}, render(x))))) : null);
  const m = modal({
    title: `#${p.number} ${p.title}`,
    wide: true,
    body: [
      h(
        'div',
        { class: 'card-tags' },
        stateBadge(p.state),
        p.author ? badge(`@${p.author}`, 'neutral', 'user') : null,
        p.baseRef ? badge(`${p.headRef} → ${p.baseRef}`, 'neutral', 'branch') : null,
        checksBadge(p.checks),
        badge(`+${p.additions} −${p.deletions}`),
        p.labels.map((l) => badge(l, 'info', 'tag')),
      ),
      p.mergedAt ? h('p', { class: 'muted small' }, `Merged ${fmtDateTime(p.mergedAt)}`) : null,
      p.body ? h('div', { class: 'prose pr-body' }, p.body) : h('p', { class: 'muted' }, 'No description.'),
      list('Reviewers', p.reviewers, (r) => [h('strong', {}, `@${r.login}`), ' ', badge(r.state.replace('_', ' '), r.state === 'approved' ? 'success' : r.state === 'changes_requested' ? 'danger' : 'neutral')]),
      list('Related issues', p.issues, (i) => h('a', { href: i.url, target: '_blank', rel: 'noopener' }, `#${i.number}${i.title ? ` ${i.title}` : ''}`)),
      list('Commits', p.commitList, (c) => [h('code', {}, c.sha.slice(0, 7)), ' ', c.message, c.author ? h('span', { class: 'muted' }, ` · ${c.author}`) : null]),
      list(`Files changed${p.files > p.fileList.length ? ` — first ${p.fileList.length} of ${p.files}` : ''}`, p.fileList, (f) => h('code', {}, f)),
      p.checks?.url ? h('a', { href: p.checks.url, target: '_blank', rel: 'noopener' }, 'Checks and workflows on GitHub →') : null,
    ],
    actions: [p.url ? h('a', { class: 'btn btn-default', href: p.url, target: '_blank', rel: 'noopener' }, icon('github'), 'Open on GitHub') : null, button('Close', { onClick: () => m.close() })].filter(Boolean),
  });
}

// Which permissions a GitHub token needs for everything the change module reads.
// Rewind only reads from GitHub: every permission is read-only.
const GH_PERMISSIONS = [
  ['Metadata', 'Read-only', 'Always on in fine-grained tokens. Lists your repositories, tags and repository details.'],
  ['Contents', 'Read-only', 'Branches, releases (including the latest published version) and comparing two branches/tags.'],
  ['Pull requests', 'Read-only', 'Searching and listing PRs, their details, reviews, commits, changed files, and which PR a commit belongs to.'],
  ['Commit statuses', 'Read-only', 'CI statuses of each PR (the “Checks” column).'],
  ['Checks', 'Read-only', 'Check runs (e.g. GitHub Actions results), if your token settings offer it. GitHub’s docs don’t say which fine-grained permission this read needs; without access, the “Checks” column shows only commit statuses.'],
];

export function githubPermissionsModal() {
  const m = modal({
    title: 'GitHub token: permissions needed',
    wide: true,
    body: [
      h('p', {}, 'Rewind only ', h('strong', {}, 'reads'), ' from GitHub to build the change: repositories, pull requests, versions and checks. It never writes, so every permission is read-only.'),
      h('h3', {}, 'Fine-grained token (recommended)'),
      h(
        'ol',
        { class: 'perm-steps' },
        h('li', {}, 'GitHub → Settings → Developer settings → Personal access tokens → ', h('strong', {}, 'Fine-grained tokens'), ' → Generate new token.'),
        h('li', {}, h('strong', {}, 'Resource owner'), ': the organization that owns the repositories (not your personal account). A fine-grained token covers one owner; if the organization requires it, an org admin approves the token before it works.'),
        h('li', {}, h('strong', {}, 'Repository access'), ': “All repositories”, or “Only select repositories” with every repository your changes include.'),
        h('li', {}, h('strong', {}, 'Repository permissions'), ', all ', h('em', {}, 'Read-only'), ':'),
      ),
      table(
        ['Permission', 'Access', 'Used for'],
        GH_PERMISSIONS.map(([name, access, why]) => h('tr', {}, h('td', { class: 'nowrap' }, h('strong', {}, name)), h('td', { class: 'nowrap' }, badge(access, 'info')), h('td', { class: 'small' }, why))),
      ),
      h('p', { class: 'muted small' }, 'Organization and account permissions: none needed. With a fine-grained token GitHub doesn’t list your organizations, so the organization filter shows the owners of the repositories the token reaches.'),
      h('h3', {}, 'Classic token (alternative)'),
      h('p', {}, 'Scopes: ', h('code', {}, 'repo'), ' (or only ', h('code', {}, 'public_repo'), ' for public repositories) and ', h('code', {}, 'read:org'), ' to list your organizations. A classic token reaches every organization you belong to; for organizations with SAML single sign-on, authorize the token for them (Configure SSO).'),
      h('h3', {}, 'Good to know'),
      h(
        'ul',
        { class: 'perm-steps' },
        h('li', {}, 'Tokens expire: when GitHub rejects it, generate a new one and save it in My account → Integrations → GitHub.'),
        h('li', {}, 'The token is personal: imports use your access, so you only see repositories you can open on GitHub.'),
        h('li', {}, 'It is stored encrypted and never shown again after saving.'),
      ),
    ],
    actions: [
      h('a', { class: 'btn btn-default', href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, icon('github'), 'Create a token on GitHub'),
      h('a', { class: 'btn btn-default', href: '#/account/integrations/github', onClick: () => m.close() }, 'Save it in My account'),
      button('Close', { variant: 'primary', onClick: () => m.close() }),
    ],
  });
}

export const githubPermissionsLink = (label = 'Which permissions does the token need?') =>
  h('button', { type: 'button', class: 'link-btn', onClick: githubPermissionsModal }, label);
