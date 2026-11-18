// Text generated from the pull requests of a change: release notes per repository and the
// change summary. Both are drafts built from PR titles, labels and conventional prefixes, and
// are always marked as generated suggestions for a person to review.

const GROUPS = [
  ['breaking', 'Breaking changes'],
  ['feature', 'Features'],
  ['fix', 'Fixes'],
  ['security', 'Security'],
  ['dependency', 'Dependencies'],
  ['other', 'Other changes'],
];
// for counts in the summary: [one, many]
const NOUNS = { breaking: ['breaking change', 'breaking changes'], feature: ['feature', 'features'], fix: ['fix', 'fixes'], security: ['security change', 'security changes'], dependency: ['dependency update', 'dependency updates'], other: ['other change', 'other changes'] };

export function classify(pr) {
  const labels = (pr.labels || []).map((l) => l.toLowerCase());
  const title = (pr.title || '').toLowerCase();
  const m = /^(\w+)(\([^)]*\))?(!)?:/.exec(title);
  if (m?.[3] || labels.some((l) => l.includes('breaking') || l === 'semver:major') || /BREAKING[ -]CHANGE/.test(pr.body || '')) return 'breaking';
  if (labels.some((l) => l.includes('security')) || m?.[1] === 'security') return 'security';
  if (labels.some((l) => ['dependencies', 'dependency', 'deps'].includes(l)) || m?.[1] === 'deps' || m?.[1] === 'build' || /^bump /.test(title)) return 'dependency';
  if (m?.[1] === 'feat' || labels.some((l) => ['feature', 'enhancement', 'semver:minor'].includes(l))) return 'feature';
  if (['fix', 'perf'].includes(m?.[1]) || labels.some((l) => ['bug', 'bugfix', 'fix'].includes(l))) return 'fix';
  return 'other';
}

const cleanTitle = (t) => String(t || '').replace(/^\w+(\([^)]*\))?!?:\s*/, '');

export function releaseNotes(repo) {
  const lines = [`## ${repo.repo} ${repo.nextVersion || ''}`.trim(), ''];
  if (repo.currentVersion) lines.push(`Previous version: ${repo.currentVersion}`, '');
  const groups = new Map(GROUPS.map(([k]) => [k, []]));
  for (const pr of repo.prs) groups.get(classify(pr)).push(pr);
  for (const [key, title] of GROUPS) {
    const prs = groups.get(key);
    if (!prs.length) continue;
    lines.push(`### ${title}`);
    for (const pr of prs) lines.push(`- ${cleanTitle(pr.title)} (#${pr.number}${pr.author ? ` by @${pr.author}` : ''})`);
    lines.push('');
  }
  if (!repo.prs.length) lines.push('No pull requests were linked to this release.');
  return lines.join('\n').trim();
}

export function changeSummary(change) {
  const repos = change.code.repos;
  if (!repos.length) return '';
  const prs = repos.flatMap((r) => r.prs);
  const counts = {};
  for (const pr of prs) counts[classify(pr)] = (counts[classify(pr)] || 0) + 1;
  const kinds = GROUPS.filter(([k]) => counts[k]).map(([k]) => `${counts[k]} ${NOUNS[k][counts[k] === 1 ? 0 : 1]}`);
  const versions = repos.map((r) => `${r.repo} ${r.currentVersion || '—'} → ${r.nextVersion || '?'}`);
  const lines = [
    `This change updates ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'} (${versions.join('; ')}) with ${prs.length} pull request${prs.length === 1 ? '' : 's'}${kinds.length ? `: ${kinds.join(', ')}` : ''}.`,
  ];
  const highlights = prs.filter((p) => ['breaking', 'security', 'feature'].includes(classify(p))).slice(0, 8);
  if (counts.breaking) lines.push('', 'Watch out: it contains breaking changes.');
  if (highlights.length) {
    lines.push('', 'Highlights:');
    for (const pr of highlights) lines.push(`- ${cleanTitle(pr.title)} (#${pr.number})`);
  }
  return lines.join('\n');
}
