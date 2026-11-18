// Semantic Versioning 2.0.0 (https://semver.org): parse, compare, bump, and the increment a
// set of pull requests suggests. A suggestion is only a suggestion: the person responsible for
// the change confirms (or changes) the next version of every repository.

const RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const BUMPS = ['major', 'minor', 'patch'];
export const bumpRank = (b) => ({ patch: 1, minor: 2, major: 3 })[b] || 0;
export const highestBump = (list) => list.reduce((best, b) => (bumpRank(b) > bumpRank(best) ? b : best), null);

export function parse(version) {
  const m = RE.exec(String(version ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [], build: m[5] || '' };
}

export const valid = (v) => Boolean(parse(v));

export function format({ major, minor, patch, pre = [], build = '' }) {
  return `${major}.${minor}.${patch}${pre.length ? `-${pre.join('.')}` : ''}${build ? `+${build}` : ''}`;
}

// Precedence per the spec: build metadata is ignored; a pre-release is lower than its release.
export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return +p > +q ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

// bump('2.3.1', 'minor') = '2.4.0'; bump('2.3.1', 'minor', 'rc') = '2.4.0-rc.1'.
// A pre-release of the same target only moves its counter: bump('2.4.0-rc.1', 'minor', 'rc') = '2.4.0-rc.2'.
export function bump(version, type, preId = '') {
  const v = parse(version) || { major: 0, minor: 0, patch: 0, pre: [] };
  let next;
  if (type === 'major') next = v.pre.length && v.minor === 0 && v.patch === 0 ? { ...v } : { major: v.major + 1, minor: 0, patch: 0 };
  else if (type === 'minor') next = v.pre.length && v.patch === 0 ? { ...v } : { major: v.major, minor: v.minor + 1, patch: 0 };
  else next = v.pre.length ? { ...v } : { major: v.major, minor: v.minor, patch: v.patch + 1 };
  next.build = '';
  if (!preId) return format({ ...next, pre: [] });
  const samePre = v.pre[0] === preId && next.major === v.major && next.minor === v.minor && next.patch === v.patch;
  const n = samePre && /^\d+$/.test(v.pre[1] || '') ? +v.pre[1] + 1 : 1;
  return format({ ...next, pre: [preId, String(n)] });
}

// The increment from one version to another (null when `to` isn't greater).
export function diffType(from, to) {
  const a = parse(from) || { major: 0, minor: 0, patch: 0 };
  const b = parse(to);
  if (!b || compare(format({ ...a, pre: a.pre || [] }), to) >= 0) return null;
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  return 'patch';
}

// The highest version among tags such as "v1.2.0", "1.3.0-rc.1", "release-x" (ignored).
export function latest(tags, { includePre = false } = {}) {
  return tags
    .filter((t) => valid(t) && (includePre || !parse(t).pre.length))
    .sort((a, b) => compare(b, a))[0] || null;
}

// ------------------------------------------------------------------ suggestion
export const DEFAULT_POLICY = {
  useLabels: true, // semver:major | semver:minor | semver:patch labels
  useConventional: true, // "feat:", "fix:", "feat!:" titles and "BREAKING CHANGE" in descriptions
  breakingLabels: ['breaking', 'breaking-change', 'breaking change'],
  fallback: 'patch', // when nothing else says anything
};

const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s/;

function prBump(pr, policy) {
  const labels = (pr.labels || []).map((l) => String(l).toLowerCase());
  if (policy.useLabels) {
    for (const b of BUMPS) if (labels.includes(`semver:${b}`) || labels.includes(`semver-${b}`)) return [b, `label semver:${b}`];
    const breaking = labels.find((l) => policy.breakingLabels.includes(l));
    if (breaking) return ['major', `label "${breaking}"`];
  }
  if (policy.useConventional) {
    const m = CONVENTIONAL.exec(pr.title || '');
    if (m?.[3] || /BREAKING[ -]CHANGE/.test(pr.body || '')) return ['major', 'breaking change'];
    if (m && m[1].toLowerCase() === 'feat') return ['minor', 'feature (feat:)'];
    if (m && ['fix', 'perf'].includes(m[1].toLowerCase())) return ['patch', `${m[1].toLowerCase()}:`];
  }
  return null;
}

// { bump, reasons: ['#12 label semver:minor', ...] } — the highest increment wins.
export function suggestBump(prs = [], policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const found = prs.map((pr) => [pr, prBump(pr, p)]).filter(([, r]) => r);
  if (!found.length) return { bump: p.fallback, reasons: [prs.length ? `no SemVer signal in ${prs.length} PR(s): policy default` : 'no pull requests: policy default'] };
  const top = highestBump(found.map(([, [b]]) => b));
  return { bump: top, reasons: found.filter(([, [b]]) => b === top).map(([pr, [, why]]) => `#${pr.number} ${why}`) };
}
