// GitHub REST client for the change module, acting with the person's own token
// (My account → Integrations → GitHub). Read-only: Rewind records and approves changes,
// it doesn't trigger deployments.
import { fail } from '@rewind/core';
import { latest, valid } from './semver.js';

const API = 'https://api.github.com';
const MAX_PRS = 30; // per import, each PR costs a few calls
const CONCURRENCY = 6;

const PR_REF = /(?:Merge pull request #(\d+)|\(#(\d+)\)\s*$)/m;
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;

async function pool(items, fn, size = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export const splitRepo = (full) => {
  const [owner, name] = String(full || '').split('/');
  const ok = (part) => /^[\w.-]{1,100}$/.test(part || '') && !/^\.+$/.test(part);
  if (!ok(owner) || !ok(name) || String(full).split('/').length !== 2) fail(400, 'Repository must look like owner/name');
  return { owner, name, path: `/repos/${owner}/${name}` };
};

export function githubClient(token, fetchImpl = (...a) => fetch(...a)) {
  async function call(path, { allow404 = false } = {}) {
    const res = await fetchImpl(path.startsWith('http') ? path : API + path, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'rewind-changes',
      },
    });
    if (res.status === 404 && allow404) return null;
    if (res.status === 401) fail(400, 'GitHub rejected your token. Update it in My account → Integrations → GitHub.');
    if (res.status === 403 || res.status === 429) {
      const left = res.headers.get('x-ratelimit-remaining');
      fail(429, left === '0' ? 'GitHub rate limit reached. Try again in a few minutes.' : 'Your GitHub token has no access to this. Check its permissions.');
    }
    if (res.status === 404) fail(404, 'Not found on GitHub (or your token has no access to it)');
    if (!res.ok) fail(502, `GitHub answered ${res.status}`);
    return res.json();
  }

  const repoLite = (r) => ({ fullName: r.full_name, owner: r.owner?.login, private: r.private, defaultBranch: r.default_branch, description: r.description || '', pushedAt: r.pushed_at, url: r.html_url });

  async function prDetail(path, number) {
    const [pr, reviews, commits, files] = await Promise.all([
      call(`${path}/pulls/${number}`),
      call(`${path}/pulls/${number}/reviews?per_page=100`).catch(() => []),
      call(`${path}/pulls/${number}/commits?per_page=100`).catch(() => []),
      call(`${path}/pulls/${number}/files?per_page=100`).catch(() => []),
    ]);
    const sha = pr.head?.sha;
    const [runs, status] = sha
      ? await Promise.all([call(`${path}/commits/${sha}/check-runs?per_page=100`).catch(() => null), call(`${path}/commits/${sha}/status`).catch(() => null)])
      : [null, null];
    // the latest review of each reviewer counts
    const byReviewer = new Map();
    for (const r of reviews || []) if (r.user?.login && r.state !== 'COMMENTED') byReviewer.set(r.user.login, r.state);
    for (const r of pr.requested_reviewers || []) if (!byReviewer.has(r.login)) byReviewer.set(r.login, 'REQUESTED');
    const checkRuns = runs?.check_runs || [];
    const statuses = status?.statuses || [];
    const total = checkRuns.length + statuses.length;
    const passed = checkRuns.filter((c) => ['success', 'neutral', 'skipped'].includes(c.conclusion)).length + statuses.filter((s) => s.state === 'success').length;
    const failed = checkRuns.filter((c) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion)).length + statuses.filter((s) => ['failure', 'error'].includes(s.state)).length;
    const issues = [];
    for (const m of (pr.body || '').matchAll(CLOSES)) {
      const repo = m[1] || path.replace('/repos/', '');
      issues.push({ number: Number(m[2]), url: `https://github.com/${repo}/issues/${m[2]}`, title: '' });
    }
    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      body: (pr.body || '').slice(0, 3000),
      author: pr.user?.login || '',
      state: pr.merged_at ? 'merged' : pr.state,
      labels: (pr.labels || []).map((l) => l.name),
      reviewers: [...byReviewer].map(([login, state]) => ({ login, state: state.toLowerCase() })),
      approvals: [...byReviewer.values()].filter((s) => s === 'APPROVED').length,
      mergedAt: pr.merged_at || '',
      baseRef: pr.base?.ref || '',
      headRef: pr.head?.ref || '',
      commits: pr.commits ?? (commits || []).length,
      commitList: (commits || []).map((c) => ({ sha: c.sha, message: (c.commit?.message || '').split('\n')[0], author: c.author?.login || c.commit?.author?.name || '' })),
      files: pr.changed_files ?? (files || []).length,
      fileList: (files || []).map((f) => f.filename),
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      checks: total
        ? { state: failed ? 'failure' : passed === total ? 'success' : 'pending', total, passed, failed, url: `${pr.html_url}/checks` }
        : { state: 'none', total: 0, passed: 0, failed: 0, url: '' },
      issues: issues.filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i),
    };
  }

  async function prsFromCommits(path, commits) {
    const numbers = new Set();
    const unresolved = [];
    for (const c of commits) {
      const m = PR_REF.exec((c.commit?.message || '').split('\n')[0]) || PR_REF.exec(c.commit?.message || '');
      if (m) numbers.add(Number(m[1] || m[2]));
      else unresolved.push(c.sha);
    }
    // commits without "(#123)" in the message: ask GitHub which PR they belong to (a few only)
    const found = await pool(unresolved.slice(0, 20), (sha) => call(`${path}/commits/${sha}/pulls`).catch(() => []));
    for (const list of found) for (const pr of list || []) numbers.add(pr.number);
    return [...numbers].sort((a, b) => a - b);
  }

  async function detailed(path, numbers) {
    const capped = numbers.slice(0, MAX_PRS);
    return { prs: await pool(capped, (n) => prDetail(path, n)), truncated: numbers.length > capped.length, found: numbers.length };
  }

  return {
    async me() {
      return call('/user');
    },

    // organizations the person belongs to and the repositories they can reach
    async repos({ q = '', owner = '' } = {}) {
      const [orgs, ...pages] = await Promise.all([
        call('/user/orgs?per_page=100').catch(() => []),
        call('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=1'),
        call('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=2').catch(() => []),
      ]);
      const term = q.toLowerCase();
      const repos = pages.flat().map(repoLite).filter((r) => (!owner || r.owner === owner) && (!term || r.fullName.toLowerCase().includes(term)));
      return { orgs: orgs.map((o) => ({ login: o.login, avatar: o.avatar_url })), repos };
    },

    async refs(full) {
      const { path } = splitRepo(full);
      const [repo, branches, tags] = await Promise.all([call(path), call(`${path}/branches?per_page=100`), call(`${path}/tags?per_page=100`)]);
      return { defaultBranch: repo.default_branch, branches: branches.map((b) => b.name), tags: tags.map((t) => t.name) };
    },

    // the latest published version: the latest release, else the highest SemVer tag
    async latestVersion(full) {
      const { path } = splitRepo(full);
      const release = await call(`${path}/releases/latest`, { allow404: true });
      if (release?.tag_name && valid(release.tag_name)) return { version: release.tag_name.replace(/^v/, ''), tag: release.tag_name, source: 'release', url: release.html_url };
      const tags = (await call(`${path}/tags?per_page=100`)).map((t) => t.name);
      const top = latest(tags);
      return top ? { version: top.replace(/^v/, ''), tag: top, source: 'tag', url: `https://github.com/${full}/releases/tag/${top}` } : { version: '', tag: '', source: 'none', url: '' };
    },

    async releases(full) {
      const { path } = splitRepo(full);
      return (await call(`${path}/releases?per_page=30`)).filter((r) => !r.draft).map((r) => ({ tag: r.tag_name, name: r.name || r.tag_name, publishedAt: r.published_at, prerelease: r.prerelease, url: r.html_url }));
    },

    async searchPulls(full, q = '') {
      const { path } = splitRepo(full);
      if (q.trim()) {
        const term = encodeURIComponent(`repo:${full} is:pr ${q.trim()}`);
        const found = await call(`/search/issues?q=${term}&sort=updated&per_page=30`);
        return found.items.map((i) => ({ number: i.number, title: i.title, state: i.pull_request?.merged_at ? 'merged' : i.state, author: i.user?.login, updatedAt: i.updated_at, url: i.html_url }));
      }
      const list = await call(`${path}/pulls?state=all&sort=updated&direction=desc&per_page=30`);
      return list.map((p) => ({ number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, author: p.user?.login, updatedAt: p.updated_at, url: p.html_url }));
    },

    async importPulls(full, numbers) {
      const { path } = splitRepo(full);
      const clean = [...new Set((numbers || []).map(Number).filter((n) => n > 0))];
      if (!clean.length) fail(400, 'Pick at least one pull request');
      return detailed(path, clean);
    },

    // commits and PRs between two refs (branches, tags or SHAs)
    async importCompare(full, base, head) {
      const { path } = splitRepo(full);
      if (!base || !head) fail(400, 'Pick both references to compare');
      const cmp = await call(`${path}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      const numbers = await prsFromCommits(path, cmp.commits || []);
      return { ...(await detailed(path, numbers)), commits: cmp.total_commits ?? (cmp.commits || []).length, files: (cmp.files || []).length, base, head };
    },

    // the PRs of a GitHub Release: everything since the release before it
    async importRelease(full, tag) {
      const { path } = splitRepo(full);
      if (!tag) fail(400, 'Pick a release');
      const all = (await call(`${path}/releases?per_page=100`)).filter((r) => !r.draft);
      const i = all.findIndex((r) => r.tag_name === tag);
      if (i < 0) fail(404, `Release ${tag} not found`);
      const previous = all[i + 1]?.tag_name;
      if (previous) {
        const result = await this.importCompare(full, previous, tag);
        return { ...result, tag, previous };
      }
      const numbers = [...new Set([...(all[i].body || '').matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
      return { ...(await detailed(path, numbers)), tag, previous: null };
    },
  };
}
