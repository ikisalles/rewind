// Read-only GitHub client for Engineering Metrics. Pulls pull requests (with
// first review), and deployments with their latest status, and normalizes
// them into MetricEvents. Authors are never kept.
//
// The token is the connecting admin's own (My account → Integrations → GitHub),
// least privilege: read access to the mapped repositories only.
import { fail } from '@rewind/core';

const API = 'https://api.github.com';
const PER_REPO = 50;
const DETAIL = 30; // PRs/deployments that get a detail call per sync
const MAX_PAGES = 4; // reconciliation window: up to 4×50 recently updated PRs per repo

export function githubClient(token, fetchImpl = (...a) => globalThis.fetch(...a)) {
  async function call(path) {
    const res = await fetchImpl(path.startsWith('http') ? path : API + path, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'rewind-metrics',
      },
    });
    if (res.status === 401) fail(400, 'GitHub rejected the token. Update it in My account → Integrations → GitHub.');
    if (res.status === 403 || res.status === 429) fail(429, 'GitHub rate limit reached or no access to this repository');
    if (res.status === 404) fail(404, 'Repository not found on GitHub (or the token has no access to it)');
    if (!res.ok) fail(502, `GitHub answered ${res.status}`);
    return res.json();
  }

  async function pulls(repo, since) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await call(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_REPO}&page=${page}`);
      out.push(...batch.filter((p) => !since || p.updated_at >= since));
      if (batch.length < PER_REPO || (since && batch.some((p) => p.updated_at < since))) break;
    }
    const events = [];
    for (const [i, p] of out.entries()) {
      let firstReviewAt = null;
      let firstCommitAt = null;
      if (i < DETAIL && p.merged_at) {
        const [reviews, commits] = await Promise.all([
          call(`/repos/${repo}/pulls/${p.number}/reviews?per_page=100`).catch(() => []),
          call(`/repos/${repo}/pulls/${p.number}/commits?per_page=100`).catch(() => []),
        ]);
        // the first review by someone other than the PR's author (not stored)
        firstReviewAt = reviews.filter((r) => r.submitted_at && r.user?.login !== p.user?.login).map((r) => r.submitted_at).sort()[0] || null;
        firstCommitAt = commits.map((c) => c.commit?.author?.date).filter(Boolean).sort()[0] || null;
      }
      events.push({
        type: 'pull_request',
        externalId: `${repo}#${p.number}`,
        repository: repo,
        number: p.number,
        title: p.title,
        url: p.html_url,
        openedAt: p.created_at,
        mergedAt: p.merged_at,
        firstReviewAt,
        firstCommitAt,
      });
    }
    return events;
  }

  async function deployments(repo) {
    const list = await call(`/repos/${repo}/deployments?per_page=${PER_REPO}`);
    const events = [];
    for (const d of list.slice(0, DETAIL)) {
      const [statuses, prs] = await Promise.all([
        call(`/repos/${repo}/deployments/${d.id}/statuses?per_page=10`).catch(() => []),
        d.sha ? call(`/repos/${repo}/commits/${d.sha}/pulls`).catch(() => []) : [],
      ]);
      const last = statuses[0];
      if (!last || !['success', 'failure', 'error', 'inactive'].includes(last.state)) continue; // still running
      events.push({
        type: 'deployment',
        externalId: `${repo}@${d.id}`,
        repository: repo,
        environment: d.environment,
        sha: d.sha,
        title: d.description || d.ref,
        url: last.log_url || last.target_url || '',
        status: last.state === 'success' || last.state === 'inactive' ? 'success' : 'failure',
        deployedAt: last.created_at,
        prNumbers: prs.map((p) => p.number),
      });
    }
    return events;
  }

  return { pulls, deployments, me: () => call('/user') };
}
