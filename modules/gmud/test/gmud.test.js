import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, signupCompany as signup } from '@rewind/core/testing';
import gmud from '../server/index.js';
import { parse, compare, bump, latest, suggestBump, diffType } from '../server/semver.js';
import { calculateRisk } from '../server/model.js';
import { releaseNotes } from '../server/notes.js';

const setup = () => setupApp({ modules: [gmud], env: { SECRETS_KEY: 'k' } });

// ACME with the module turned on (it is off until an admin turns it on)
async function signupCompany(call) {
  const out = await signup(call);
  await call('PATCH', '/api/org/modules/gmud', { enabled: true }, out.admin);
  return out;
}

const SUMMARY = { text: 'New login flow', origin: 'manual' };
const OVERVIEW = {
  title: 'Auth module update',
  category: 'feature',
  priority: 'medium',
  environment: 'production',
  plannedAt: '2026-11-20T22:00',
};
const RISK = {
  probability: 'medium',
  impact: 'medium',
  rollback: { strategy: 'Redeploy previous version', procedure: 'Run the deploy workflow with v2.3.1' },
  testing: { unit: true, codeReview: true, evidence: [{ label: 'CI', url: 'https://ci.example/1' }, { label: 'bad', url: 'javascript:alert(1)' }] },
};
const REPO = { repo: 'acme/auth-service', currentVersion: '2.3.1', prs: [{ number: 12, title: 'feat: passkeys', labels: [] }, { number: 13, title: 'fix: typo', labels: [] }] };

async function readyDraft(call, token, me) {
  const { change } = (await call('POST', '/api/gmud/changes', { title: 'x' }, token)).data;
  const id = change.id;
  await call('PATCH', `/api/gmud/changes/${id}`, { section: 'overview', data: { ...OVERVIEW, responsibleId: me.user.id, teamId: me.org.defaultTeamId } }, token);
  const code = (await call('PATCH', `/api/gmud/changes/${id}`, { section: 'code', data: { summary: SUMMARY, repos: [REPO] } }, token)).data;
  const { nextVersion } = code.change.code.repos[0];
  await call('PATCH', `/api/gmud/changes/${id}`, { section: 'code', data: { summary: SUMMARY, repos: [{ ...REPO, nextVersion, confirmed: true, confirmedVersion: nextVersion }] } }, token);
  await call('PATCH', `/api/gmud/changes/${id}`, { section: 'risk', data: RISK }, token);
  return id;
}

test('semver: parse, precedence, bumps with pre-releases, latest tag and the suggestion policy', () => {
  assert.deepEqual(parse('v2.4.0-rc.1+build.5'), { major: 2, minor: 4, patch: 0, pre: ['rc', '1'], build: 'build.5' });
  assert.equal(parse('2.4'), null);
  assert.equal(compare('2.4.0-alpha.1', '2.4.0'), -1);
  assert.equal(compare('2.4.0-rc.2', '2.4.0-rc.10'), -1);
  assert.equal(compare('2.4.0+a', '2.4.0+b'), 0);
  assert.equal(bump('2.3.1', 'major'), '3.0.0');
  assert.equal(bump('2.3.1', 'minor'), '2.4.0');
  assert.equal(bump('2.3.1', 'patch'), '2.3.2');
  assert.equal(bump('2.3.1', 'minor', 'rc'), '2.4.0-rc.1');
  assert.equal(bump('2.4.0-rc.1', 'minor', 'rc'), '2.4.0-rc.2');
  assert.equal(bump('2.4.0-rc.2', 'minor'), '2.4.0');
  assert.equal(diffType('2.3.1', '3.0.0'), 'major');
  assert.equal(diffType('2.3.1', '2.3.1'), null);
  assert.equal(latest(['v1.2.0', 'v1.10.0', 'v2.0.0-rc.1', 'nightly']), 'v1.10.0');

  assert.deepEqual(suggestBump([{ number: 1, title: 'fix: a' }, { number: 2, title: 'feat: b' }]), { bump: 'minor', reasons: ['#2 feature (feat:)'] });
  assert.equal(suggestBump([{ number: 3, title: 'chore: x', labels: ['semver:major'] }]).bump, 'major');
  assert.equal(suggestBump([{ number: 4, title: 'refactor!: drop v1 API' }]).bump, 'major');
  assert.equal(suggestBump([{ number: 5, title: 'Update readme' }]).bump, 'patch'); // policy default
  assert.equal(suggestBump([{ number: 6, title: 'feat: x' }], { useConventional: false, fallback: 'minor' }).reasons[0].includes('default'), true);
});

test('risk matrix and release notes', () => {
  assert.equal(calculateRisk('low', 'low'), 'low');
  assert.equal(calculateRisk('medium', 'medium'), 'medium');
  assert.equal(calculateRisk('high', 'medium'), 'high');
  assert.equal(calculateRisk('high', 'high'), 'critical');
  assert.equal(calculateRisk('', 'high'), null);
  const notes = releaseNotes({ repo: 'acme/api', currentVersion: '1.0.0', nextVersion: '2.0.0', prs: [{ number: 1, title: 'feat!: new auth', author: 'ana' }, { number: 2, title: 'fix: crash' }] });
  assert.match(notes, /### Breaking changes\n- new auth \(#1 by @ana\)/);
  assert.match(notes, /### Fixes\n- crash \(#2\)/);
});

test('a change goes from draft to approved, with versions confirmed and approvals by role', async () => {
  const { call } = setup();
  const { admin, bia, me } = await signupCompany(call);

  const created = (await call('POST', '/api/gmud/changes', {}, bia)).data;
  assert.match(created.change.number, /^CHG-\d{4}-0001$/);
  assert.equal(created.change.execution.steps.length, 4);
  assert.equal(created.readiness.ok, false);
  const second = (await call('POST', '/api/gmud/changes', {}, bia)).data.change;
  assert.match(second.number, /-0002$/);

  // Bia (member) requests, Ana (admin) approves
  const biaMe = (await call('GET', '/api/me', null, bia)).data;
  const id = await readyDraft(call, bia, biaMe);
  let v = (await call('GET', `/api/gmud/changes/${id}`, null, bia)).data;
  const repo = v.change.code.repos[0];
  assert.equal(repo.suggested.bump, 'minor');
  assert.equal(repo.nextVersion, '2.4.0');
  assert.equal(repo.confirmed, true);
  assert.equal(v.change.risk.calculated, 'medium');
  assert.equal(v.change.overview.changeType, 'minor'); // derived from the repositories' increments
  assert.deepEqual(v.change.testing.evidence, [{ label: 'CI', url: 'https://ci.example/1' }]);
  assert.deepEqual(v.readiness, { ok: true, missing: [] });
  assert.deepEqual(v.requiredPreview, ['technical', 'change']); // production → change approver too

  // changing the version drops the confirmation
  const moved = (await call('PATCH', `/api/gmud/changes/${id}`, { section: 'code', data: { summary: SUMMARY, repos: [{ ...repo, nextVersion: '3.0.0' }] } }, bia)).data;
  assert.equal(moved.change.code.repos[0].confirmed, false);
  assert.equal(moved.readiness.ok, false);
  assert.equal((await call('POST', `/api/gmud/changes/${id}/submit`, {}, bia)).data.missing[0].message, 'acme/auth-service: confirm version 3.0.0');
  await call('PATCH', `/api/gmud/changes/${id}`, { section: 'code', data: { summary: SUMMARY, repos: [{ ...repo, nextVersion: '3.0.0', confirmed: true, confirmedVersion: '3.0.0' }] } }, bia);

  const submitted = (await call('POST', `/api/gmud/changes/${id}/submit`, {}, bia)).data;
  assert.equal(submitted.change.status, 'submitted');
  assert.deepEqual(submitted.change.approvals.required, ['technical', 'change']);
  assert.equal((await call('PATCH', `/api/gmud/changes/${id}`, { section: 'overview', data: OVERVIEW }, bia)).status, 409); // not a draft anymore

  // Bia can't approve her own change; Ana (admin, no approver list) can
  assert.equal((await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'approved' }, bia)).status, 403);
  v = (await call('GET', `/api/gmud/changes/${id}`, null, admin)).data;
  assert.deepEqual(v.can.decide, ['technical', 'change']);
  v = (await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'approved', comment: 'LGTM' }, admin)).data;
  assert.equal(v.change.status, 'in_review');
  assert.equal((await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'approved' }, admin)).status, 403); // already decided
  v = (await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'change', decision: 'approved' }, admin)).data;
  assert.equal(v.change.status, 'approved');

  // approval plans one release per repository
  const { releases } = (await call('GET', '/api/gmud/releases', null, bia)).data;
  assert.equal(releases.length, 1);
  assert.deepEqual([releases[0].repo, releases[0].version, releases[0].previousVersion, releases[0].status], ['acme/auth-service', '3.0.0', '2.3.1', 'planned']);

  // a deployment that starts moves the change to in progress; completing releases it
  const dep = (await call('POST', `/api/gmud/changes/${id}/deployments`, { environment: 'staging', status: 'in_progress' }, bia)).data;
  assert.equal(dep.change.status, 'in_progress');
  assert.deepEqual(dep.deployment.releases.map((r) => r.version), ['3.0.0']);
  const step = dep.change.execution.steps[0];
  const stepped = (await call('PATCH', `/api/gmud/changes/${id}/steps/${step.id}`, { status: 'done', evidence: 'https://grafana.example/d/1', title: 'hacked' }, bia)).data;
  assert.deepEqual([stepped.change.execution.steps[0].status, stepped.change.execution.steps[0].title], ['done', step.title]);
  await call('PATCH', `/api/gmud/deployments/${dep.deployment.id}`, { status: 'failed', note: 'timeout' }, bia);
  assert.equal((await call('GET', '/api/gmud/releases', null, bia)).data.releases[0].status, 'planned'); // a failed deployment doesn't touch the release
  assert.equal((await call('POST', `/api/gmud/changes/${id}/actions/complete`, {}, admin)).data.change.status, 'completed');
  assert.equal((await call('GET', '/api/gmud/releases', null, bia)).data.releases[0].status, 'released');
  assert.equal((await call('POST', `/api/gmud/changes/${id}/actions/cancel`, { comment: 'x' }, admin)).status, 409);

  // audit trail
  const { events } = (await call('GET', `/api/gmud/changes/${id}/activity`, null, admin)).data;
  const types = events.map((e) => e.type);
  for (const t of ['created', 'edited', 'status', 'decision', 'release', 'deployment', 'step']) assert.ok(types.includes(t), t);
  // back-to-back autosaves of a section by the same person are one entry (the risk edit in
  // between starts a new one)
  const codeEdits = events.filter((e) => e.type === 'edited' && e.section === 'code');
  assert.equal(codeEdits.length, 2);

  const dash = (await call('GET', '/api/dashboard', null, admin)).data;
  assert.deepEqual(dash.gmud.awaitingMe, []);
});

test('rejection needs a reason and sends the change back to draft on revise; approver lists and self-approval', async () => {
  const { call } = setup();
  const { admin, bia, me } = await signupCompany(call);
  const biaId = (await call('GET', '/api/me', null, bia)).data.user.id;

  // Bia is the only technical approver; the company allows self-approval for no one
  assert.equal((await call('PUT', '/api/gmud/settings', { approvers: { technical: [biaId] } }, bia)).status, 403);
  const s = (await call('PUT', '/api/gmud/settings', { approvers: { technical: [biaId, 'ghost'] }, rules: { technical: true, changeEnvironments: [], changeMinRisk: 'never', securityCategories: ['security'] } }, admin)).data.settings;
  assert.deepEqual(s.approvers.technical, [biaId]);

  const id = await readyDraft(call, admin, me);
  let v = (await call('POST', `/api/gmud/changes/${id}/submit`, {}, admin)).data;
  assert.deepEqual(v.change.approvals.required, ['technical']);
  assert.equal((await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'approved' }, admin)).status, 403); // admin isn't on the list
  assert.equal((await call('GET', '/api/dashboard', null, bia)).data.gmud.awaitingMe.length, 1);
  assert.equal((await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'rejected' }, bia)).status, 400); // no reason
  v = (await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'rejected', comment: 'Missing load test' }, bia)).data;
  assert.equal(v.change.status, 'rejected');
  v = (await call('POST', `/api/gmud/changes/${id}/actions/revise`, {}, admin)).data;
  assert.deepEqual([v.change.status, v.change.approvals.decisions.length, v.can.edit], ['draft', 0, true]);

  // security category adds the security approval
  await call('PATCH', `/api/gmud/changes/${id}`, { section: 'overview', data: { ...OVERVIEW, category: 'security', responsibleId: me.user.id, teamId: me.org.defaultTeamId } }, admin);
  assert.deepEqual((await call('GET', `/api/gmud/changes/${id}`, null, admin)).data.requiredPreview, ['technical', 'security']);

  // members can see and comment, not edit; drafts can be deleted
  assert.equal((await call('PATCH', `/api/gmud/changes/${id}`, { section: 'overview', data: OVERVIEW }, bia)).status, 403);
  assert.equal((await call('POST', `/api/gmud/changes/${id}/comments`, { text: 'Can we do it on Friday?' }, bia)).status, 201);
  assert.equal((await call('DELETE', `/api/gmud/changes/${id}`, null, bia)).status, 403);
  assert.equal((await call('DELETE', `/api/gmud/changes/${id}`, null, admin)).status, 200);
  assert.equal((await call('GET', `/api/gmud/changes/${id}`, null, admin)).status, 404);

  // teams with open changes can't be deleted
  const squad = (await call('POST', '/api/teams', { name: 'Squad' }, admin)).data.team;
  const other = (await call('POST', '/api/gmud/changes', {}, admin)).data.change;
  await call('PATCH', `/api/gmud/changes/${other.id}`, { section: 'overview', data: { ...OVERVIEW, teamId: squad.id } }, admin);
  assert.equal((await call('DELETE', `/api/teams/${squad.id}`, null, admin)).status, 409);
});

test('GitHub import uses the person token: compare refs, release scope, version suggestion', async (t) => {
  const { call } = setup();
  const { admin } = await signupCompany(call);
  assert.equal((await call('GET', '/api/gmud/github/repos', null, admin)).status, 412); // not connected
  await call('PUT', '/api/me/integrations/github', { token: 'ghp_test_token_1' }, admin);

  const seen = [];
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  const pr = (n, title, labels = []) => ({ number: n, title, html_url: `https://github.com/acme/api/pull/${n}`, body: n === 7 ? 'Closes #3' : '', user: { login: 'dev' }, labels: labels.map((name) => ({ name })), merged_at: '2026-11-10T10:00:00Z', base: { ref: 'main' }, head: { ref: `b${n}`, sha: `sha${n}` }, commits: 2, changed_files: 3, additions: 10, deletions: 2, requested_reviewers: [] });
  const routes = {
    '/repos/acme/api/compare/v1.4.0...main': { total_commits: 3, commits: [{ sha: 'a', commit: { message: 'feat: search (#7)' } }, { sha: 'b', commit: { message: 'Merge pull request #8 from acme/fix' } }, { sha: 'c', commit: { message: 'direct push' } }], files: [{}, {}] },
    '/repos/acme/api/commits/c/pulls': [],
    '/repos/acme/api/pulls/7': pr(7, 'feat: search'),
    '/repos/acme/api/pulls/8': pr(8, 'fix: crash', ['semver:patch']),
    '/repos/acme/api/pulls/7/reviews?per_page=100': [{ user: { login: 'rev' }, state: 'APPROVED' }],
    '/repos/acme/api/pulls/8/reviews?per_page=100': [],
    '/repos/acme/api/releases/latest': { tag_name: 'v1.4.0', html_url: 'https://github.com/acme/api/releases/tag/v1.4.0' },
    '/repos/acme/api/commits/sha7/check-runs?per_page=100': { check_runs: [{ conclusion: 'success' }, { conclusion: 'failure' }] },
  };
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace('https://api.github.com', '');
    seen.push([path, init.headers.authorization]);
    const key = Object.keys(routes).find((k) => k === path);
    if (key) return new Response(JSON.stringify(routes[key]), { status: 200 });
    if (/\/(commits|files)\?per_page=100$/.test(path)) return new Response('[]', { status: 200 });
    if (/\/status$/.test(path)) return new Response('{"statuses":[]}', { status: 200 });
    if (/check-runs/.test(path)) return new Response('{"check_runs":[]}', { status: 200 });
    return new Response('{"message":"Not Found"}', { status: 404 });
  };

  const res = await call('POST', '/api/gmud/github/import', { repo: 'acme/api', mode: 'compare', base: 'v1.4.0', head: 'main' }, admin);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.prs.map((p) => p.number), [7, 8]);
  assert.equal(res.data.commits, 3);
  assert.equal(res.data.currentVersion, '1.4.0');
  assert.deepEqual([res.data.suggested.bump, res.data.nextVersion], ['minor', '1.5.0']);
  const seven = res.data.prs[0];
  assert.deepEqual([seven.approvals, seven.checks.state, seven.checks.failed, seven.issues[0].url], [1, 'failure', 1, 'https://github.com/acme/api/issues/3']);
  assert.ok(seen.every(([, auth]) => auth === 'Bearer ghp_test_token_1'));

  assert.equal((await call('POST', '/api/gmud/github/import', { repo: '../etc', mode: 'compare', base: 'a', head: 'b' }, admin)).status, 400);
});

test('the module starts off; companies turn it on and off', async () => {
  const { call } = setup();
  const { admin, bia } = await signup(call);
  assert.equal((await call('GET', '/api/gmud/changes', null, bia)).status, 404);
  await call('PATCH', '/api/org/modules/gmud', { enabled: true }, admin);
  assert.ok((await call('GET', '/api/me', null, bia)).data.modules.includes('gmud'));
  await call('PATCH', '/api/org/modules/gmud', { enabled: false }, admin);
  assert.equal((await call('GET', '/api/gmud/changes', null, bia)).status, 404);
  assert.equal((await call('GET', '/api/dashboard', null, bia)).data.gmud, undefined);
});

test('derived fields: change type from the repositories, risk level set in the risk step, one description', async () => {
  const { call } = setup();
  const { admin, me } = await signupCompany(call);
  const { change } = (await call('POST', '/api/gmud/changes', {}, admin)).data;
  const url = `/api/gmud/changes/${change.id}`;
  const repo = (name, bump, n) => ({ repo: `acme/${name}`, currentVersion: '1.0.0', bump, prs: [{ number: n, title: 'x' }] });

  let v = (await call('PATCH', url, { section: 'code', data: { repos: [repo('api', 'patch', 1), repo('web', 'major', 2)], summary: { text: 'One description for both' } } }, admin)).data;
  assert.equal(v.change.overview.changeType, 'major'); // the highest increment wins
  assert.deepEqual(v.change.code.repos.map((r) => r.nextVersion), ['1.0.1', '2.0.0']);

  // the overview form doesn't carry them, and saving it keeps them
  v = (await call('PATCH', url, { section: 'overview', data: { ...OVERVIEW, changeType: 'patch', responsibleId: me.user.id, teamId: me.org.defaultTeamId } }, admin)).data;
  assert.equal(v.change.overview.changeType, 'major');
  assert.ok(!v.readiness.missing.some((m) => /Description/.test(m.message)));

  v = (await call('PATCH', url, { section: 'risk', data: { probability: 'low', impact: 'low', override: 'high' } }, admin)).data;
  assert.deepEqual([v.change.risk.calculated, v.change.risk.override], ['low', 'high']);
  assert.ok(v.requiredPreview.includes('change')); // production, and high risk
  assert.equal((await call('GET', '/api/gmud/changes', null, admin)).data.changes[0].risk, 'high');

  v = (await call('PATCH', url, { section: 'code', data: { repos: [repo('api', 'patch', 1)], summary: { text: '' } } }, admin)).data;
  assert.equal(v.change.overview.changeType, 'patch');
  assert.ok(v.readiness.missing.some((m) => m.step === 'code' && /Description/.test(m.message)));
});

test('storage: everything about a change lives in its own object; the company keeps only summaries', async () => {
  const { shardOf } = await import('@rewind/core');
  const { call, storage } = setup();
  const { admin, me } = await signupCompany(call);
  const carlInvite = (await call('POST', '/api/invites', { email: 'carl@acme.io', teamId: me.org.defaultTeamId, role: 'admin' }, admin)).data.invites[0];
  const carl = (await call('POST', `/api/invites/${carlInvite.token}/accept`, { name: 'Carl', password: 'strong-pass' })).data.token;
  const a = await readyDraft(call, admin, me);
  const b = await readyDraft(call, admin, me);
  await call('POST', `/api/gmud/changes/${a}/submit`, {}, admin);
  await call('POST', `/api/gmud/changes/${a}/decision`, { role: 'technical', decision: 'approved' }, carl);
  await call('POST', `/api/gmud/changes/${a}/decision`, { role: 'change', decision: 'approved' }, carl);
  const dep = (await call('POST', `/api/gmud/changes/${a}/deployments`, { status: 'in_progress', notes: 'canary 10%' }, admin)).data.deployment;
  await call('PATCH', `/api/gmud/deployments/${dep.id}`, { status: 'succeeded', note: 'all good' }, admin);

  const owners = {};
  for (const key of storage.data.keys()) {
    if (!/^(gmud|gmudev|gmudrel|gmuddep|chgidx|relidx|depidx|chgseq|gmudcfg|gmudmeta|chg|chgev|rel|dep):/.test(key)) continue;
    (owners[shardOf(key, gmud.shards)] ||= []).push(key.split(':')[0]);
  }
  // each change's object holds the change, its log, releases and deployments
  assert.deepEqual([...new Set(owners[`gmud:${a}`])].sort(), ['gmud', 'gmuddep', 'gmudev', 'gmudrel']);
  assert.deepEqual([...new Set(owners[`gmud:${b}`])].sort(), ['gmud', 'gmudev']);
  // the company's object: summaries, sequence, layout marker — never a change's details
  assert.deepEqual([...new Set(owners[`org:${me.org.id}`])].sort(), ['chgidx', 'chgseq', 'depidx', 'gmudmeta', 'relidx']);
  assert.ok(!Object.keys(owners).some((o) => o === 'global'));
  const idx = await storage.get(`chgidx:${me.org.id}:${a}`);
  assert.equal(idx.code, undefined); // no PRs, no sections in the index
  assert.equal((await storage.get(`relidx:${me.org.id}:${(await call('GET', '/api/gmud/releases', null, admin)).data.releases[0].id}`)).notes, undefined);
  assert.equal((await storage.get(`depidx:${me.org.id}:${dep.id}`)).history, undefined);

  // lists come from the summaries; details from the change
  assert.equal((await call('GET', '/api/gmud/changes', null, admin)).data.changes.length, 2);
  const full = (await call('GET', `/api/gmud/changes/${a}/deployments`, null, admin)).data.deployments[0];
  assert.deepEqual(full.history.map((x) => x.status), ['in_progress', 'succeeded']);
  assert.match((await call('GET', `/api/gmud/changes/${a}/releases`, null, admin)).data.releases[0].notes, /acme\/auth-service/);
  assert.equal((await call('GET', '/api/gmud/deployments', null, admin)).data.deployments[0].status, 'succeeded');

  // another company can't reach a change by its id
  const other = (await call('POST', '/api/auth/signup', { orgName: 'Other', name: 'O', email: 'o@o.io', password: 'strong-pass' })).data.token;
  await call('PATCH', '/api/org/modules/gmud', { enabled: true }, other);
  assert.equal((await call('GET', `/api/gmud/changes/${a}`, null, other)).status, 404);
  assert.equal((await call('GET', `/api/gmud/changes/${a}/deployments`, null, other)).status, 404);
});

test('storage: changes saved in the old company-wide layout move to their own objects', async () => {
  const { call, storage } = setup();
  const { admin, me } = await signupCompany(call);
  const org = me.org.id;
  const old = { id: 'old1', orgId: org, number: 'CHG-2026-0007', status: 'approved', overview: { title: 'Old one', tags: [], plannedAt: '', responsibleId: me.user.id, teamId: '' }, code: { repos: [], summary: { text: 'x', origin: 'manual' } }, risk: { indicators: {} }, testing: {}, rollback: {}, execution: { steps: [] }, approvals: { required: [], decisions: [] }, createdBy: me.user.id, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  await storage.put(`chg:${org}:old1`, old);
  await storage.put(`chgev:${org}:old1:e1`, { id: 'e1', at: '2026-11-01T00:00:00Z', by: me.user.id, type: 'created', message: 'Created' });
  await storage.put(`rel:${org}:r1`, { id: 'r1', orgId: org, changeId: 'old1', changeNumber: 'CHG-2026-0007', repo: 'acme/x', version: '1.0.0', notes: 'n', prs: [], status: 'planned', createdAt: '2026-11-01T00:00:00Z' });

  const list = (await call('GET', '/api/gmud/changes', null, admin)).data.changes;
  assert.deepEqual(list.map((c) => c.number), ['CHG-2026-0007']);
  assert.equal((await call('GET', '/api/gmud/changes/old1', null, admin)).data.change.overview.title, 'Old one');
  assert.equal((await call('GET', '/api/gmud/changes/old1/activity', null, admin)).data.events.length, 1);
  assert.equal((await call('GET', '/api/gmud/changes/old1/releases', null, admin)).data.releases[0].notes, 'n');
  assert.equal(await storage.get(`chg:${org}:old1`), null);
  assert.equal(await storage.get(`rel:${org}:r1`), null);
});

test('live updates: every write tells the change channel and the company channel; reads and GitHub calls stay quiet', async () => {
  const sent = [];
  const realtime = {
    publish: async (channel, message) => sent.push([channel, message.change]),
    connect: (_req, channel) => new Response(null, { status: 200, headers: { 'x-channel': channel } }),
  };
  const { call, app } = setupApp({ modules: [gmud], env: { SECRETS_KEY: 'k' }, realtime });
  const { admin, me } = await signupCompany(call);
  const org = `gmud-org:${me.org.id}`;

  const id = (await call('POST', '/api/gmud/changes', {}, admin)).data.change.id;
  assert.deepEqual(sent.splice(0), [[`gmud:${id}`, id], [org, id]]);
  await call('PATCH', `/api/gmud/changes/${id}`, { section: 'overview', data: { title: 'Live' } }, admin);
  await call('POST', `/api/gmud/changes/${id}/comments`, { text: 'hi' }, admin);
  assert.deepEqual(sent.splice(0).map(([ch]) => ch), [`gmud:${id}`, org, `gmud:${id}`, org]);

  await call('GET', `/api/gmud/changes/${id}`, null, admin);
  await call('GET', '/api/gmud/changes', null, admin);
  await call('POST', '/api/gmud/semver/next', { version: '1.0.0', bump: 'minor' }, admin);
  assert.equal((await call('PATCH', `/api/gmud/changes/${id}`, { section: 'nope' }, admin)).status, 400); // failed writes too
  assert.deepEqual(sent, []);

  // sockets: a change of this company, or the company's lists
  const live = async (path, token) => {
    const res = await app.fetch(new Request(`https://rewind.test${path}`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `rewind, ${token}` } }));
    return [res.status, res.headers.get('x-channel')];
  };
  assert.deepEqual(await live(`/api/gmud/changes/${id}/live`, admin), [200, `gmud:${id}`]);
  assert.deepEqual(await live('/api/gmud/live', admin), [200, org]);
  const other = (await call('POST', '/api/auth/signup', { orgName: 'Other', name: 'O', email: 'o@o.io', password: 'strong-pass' })).data.token;
  await call('PATCH', '/api/org/modules/gmud', { enabled: true }, other);
  assert.equal((await live(`/api/gmud/changes/${id}/live`, other))[0], 404);
});

test('approvers can be teams (groups): anyone in the team decides, together with listed people', async () => {
  const { call } = setup();
  const { admin, bia, me } = await signupCompany(call);
  const biaId = (await call('GET', '/api/me', null, bia)).data.user.id;
  const cab = (await call('POST', '/api/teams', { name: 'CAB' }, admin)).data.team;
  const sec = (await call('POST', '/api/teams', { name: 'Security' }, admin)).data.team;
  // Carl joins only through the CAB team; Dora is listed by name
  const join = async (email, teamId) => {
    const inv = (await call('POST', '/api/invites', { email, teamId }, admin)).data.invites[0];
    return (await call('POST', `/api/invites/${inv.token}/accept`, { name: email, password: 'strong-pass' })).data.token;
  };
  const carl = await join('carl@acme.io', cab.id);
  const dora = await join('dora@acme.io', me.org.defaultTeamId);
  const doraId = (await call('GET', '/api/me', null, dora)).data.user.id;

  const saved = (await call('PUT', '/api/gmud/settings', {
    approvers: { technical: [], change: [doraId] },
    approverTeams: { technical: [cab.id, 'ghost-team'], change: [sec.id] },
    rules: { technical: true, changeEnvironments: ['production'], changeMinRisk: 'never', securityCategories: [] },
  }, admin)).data.settings;
  assert.deepEqual(saved.approverTeams.technical, [cab.id]); // unknown teams dropped

  const id = await readyDraft(call, bia, (await call('GET', '/api/me', null, bia)).data);
  await call('POST', `/api/gmud/changes/${id}/submit`, {}, bia);
  // technical: only the CAB team (admin is not in it); change: Dora or the Security team
  assert.equal((await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'approved' }, admin)).status, 403);
  assert.equal((await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'change', decision: 'approved' }, carl)).status, 403);
  assert.deepEqual((await call('GET', `/api/gmud/changes/${id}`, null, carl)).data.can.decide, ['technical']);
  assert.equal((await call('GET', '/api/dashboard', null, carl)).data.gmud.awaitingMe.length, 1);
  await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'approved' }, carl);
  const v = (await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'change', decision: 'approved' }, dora)).data;
  assert.equal(v.change.status, 'approved');
  assert.deepEqual(v.change.approvals.decisions.map((d) => d.viaTeam), [cab.id, null]); // Carl through CAB, Dora by name

  // the list shows the approvals with who decided, and drafts show the ones they'll need
  const draft = (await call('POST', '/api/gmud/changes', {}, admin)).data.change.id;
  await call('PATCH', `/api/gmud/changes/${draft}`, { section: 'overview', data: { environment: 'production' } }, admin);
  const listed = (await call('GET', '/api/gmud/changes', null, admin)).data;
  const row = listed.changes.find((x) => x.id === id);
  assert.deepEqual(row.decisions.map((d) => [d.role, d.decision, d.viaTeam]), [['technical', 'approved', cab.id], ['change', 'approved', null]]);
  const draftRow = listed.changes.find((x) => x.id === draft);
  assert.deepEqual([draftRow.required, draftRow.requiredPreview], [['technical', 'change'], true]);
  assert.deepEqual(listed.settings.approverTeams.technical, [cab.id]);
  void biaId;
});

test('deleting for good: admins and owners (people or groups) delete changes in any status, with a record', async () => {
  const { call, storage } = setup();
  const { admin, bia, me } = await signupCompany(call);
  const cab = (await call('POST', '/api/teams', { name: 'CAB' }, admin)).data.team;
  const join = async (email, teamId) => {
    const inv = (await call('POST', '/api/invites', { email, teamId }, admin)).data.invites[0];
    return (await call('POST', `/api/invites/${inv.token}/accept`, { name: email, password: 'strong-pass' })).data.token;
  };
  const carl = await join('carl@acme.io', cab.id); // owner through the CAB group
  const dora = await join('dora@acme.io', me.org.defaultTeamId); // owner by name
  const doraId = (await call('GET', '/api/me', null, dora)).data.user.id;
  await call('PUT', '/api/gmud/settings', { owners: { teams: [cab.id, 'ghost'], people: [doraId] }, allowSelfApproval: true }, admin);
  assert.deepEqual((await call('GET', '/api/gmud/settings', null, admin)).data.settings.owners, { people: [doraId], teams: [cab.id] });

  // an approved change with a release and a deployment
  const id = await readyDraft(call, admin, me);
  await call('POST', `/api/gmud/changes/${id}/submit`, {}, admin);
  await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'technical', decision: 'approved' }, admin);
  await call('POST', `/api/gmud/changes/${id}/decision`, { role: 'change', decision: 'approved' }, admin);
  const dep = (await call('POST', `/api/gmud/changes/${id}/deployments`, { status: 'planned' }, admin)).data.deployment;
  const rel = (await call('GET', '/api/gmud/releases', null, admin)).data.releases[0];

  // who may: not a regular member; yes owners by group and by name, and admins
  assert.deepEqual([(await call('GET', `/api/gmud/changes/${id}`, null, bia)).data.can.delete, (await call('GET', `/api/gmud/changes/${id}`, null, carl)).data.can.delete], [false, true]);
  assert.equal((await call('DELETE', `/api/gmud/changes/${id}`, { reason: 'x' }, bia)).status, 403);
  assert.equal((await call('DELETE', `/api/gmud/changes/${id}`, {}, carl)).status, 400); // a reason is needed once it left draft
  const del = await call('DELETE', `/api/gmud/changes/${id}`, { reason: 'Opened by mistake, duplicate of another GMUD' }, carl);
  assert.deepEqual([del.status, del.data.deleted], [200, 'CHG-2026-0001']);

  // everything is gone: the change, its log, releases and deployments, and their summaries
  assert.equal((await call('GET', `/api/gmud/changes/${id}`, null, admin)).status, 404);
  assert.equal((await call('GET', '/api/gmud/changes', null, admin)).data.changes.length, 0);
  assert.equal((await call('GET', '/api/gmud/releases', null, admin)).data.releases.length, 0);
  assert.equal((await call('GET', '/api/gmud/deployments', null, admin)).data.deployments.length, 0);
  for (const key of [`gmud:${id}`, `gmudrel:${id}:${rel.id}`, `gmuddep:${id}:${dep.id}`, `relidx:${me.org.id}:${rel.id}`, `depidx:${me.org.id}:${dep.id}`]) assert.equal(await storage.get(key), null, key);
  assert.equal((await storage.list(`gmudev:${id}:`)).length, 0);

  // the record left behind, for admins and owners
  const record = (await call('GET', '/api/gmud/deleted', null, dora)).data.deleted[0];
  assert.deepEqual([record.number, record.status, record.byName, record.reason], ['CHG-2026-0001', 'approved', 'carl@acme.io', 'Opened by mistake, duplicate of another GMUD']);
  assert.equal((await call('GET', '/api/gmud/deleted', null, bia)).status, 403);

  // drafts: still deletable by their editors, without a reason
  const draft = (await call('POST', '/api/gmud/changes', {}, bia)).data.change.id;
  assert.equal((await call('DELETE', `/api/gmud/changes/${draft}`, null, bia)).status, 200);
});
