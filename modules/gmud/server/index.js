// @rewind/gmud — change management (GMUD) for software: changes → approval → releases
// (SemVer per repository) → deployments per environment, with GitHub as the source of truth
// for code and an audit log of everything that happens.
//
// Rewind is the system of record and approval: it doesn't trigger deployments, people register
// them. The model keeps Change, Release and Deployment apart so triggering can come later.
//
// Storage: each change (GMUD) has its own Durable Object with everything about it; the company's
// object only keeps light indexes for the lists, the CHG-YYYY-NNNN sequence and the settings.
//
//   in the change's object ("gmud:{changeId}")
//     gmud:{changeId}                    the change: every section, PRs, checklist, approvals
//     gmudev:{changeId}:{id}             its activity log
//     gmudrel:{changeId}:{id}            its releases (notes, PRs)
//     gmuddep:{changeId}:{id}            its deployments (history)
//   in the company's object ("org:{orgId}")
//     chgidx:{orgId}:{changeId}          summary of each change, for lists, filters and the home page
//     relidx:{orgId}:{id}  depidx:{orgId}:{id}   summaries of releases and deployments
//     chgseq:{orgId}:{year}  gmudcfg:{orgId}  gmudmeta:{orgId}
//
// Changes created before this layout (chg:/chgev:/rel:/dep: keys under the company) are moved
// to it the first time the company's changes are read.

import { defineModule, fail, json, newId, now, str } from '@rewind/core';
import { githubClient, splitRepo } from './github.js';
import { releaseNotes, changeSummary } from './notes.js';
import { bump, suggestBump, valid as validVersion, BUMPS } from './semver.js';
import {
  SECTIONS, TRANSITIONS, EDITABLE, EXECUTABLE, OPEN, DEFAULT_SETTINGS, DEFAULT_STEPS, ROLES, DEPLOY_STATUSES, ENVIRONMENTS,
  emptyChange, cleanSettings, cleanStep, calculateRisk, riskLevel, description, changeTypeOf, requiredApprovals, rolesFor, readiness,
} from './model.js';

export * as semver from './semver.js';

const K = {
  // the change's own object
  change: (id) => `gmud:${id}`,
  event: (changeId, id) => `gmudev:${changeId}:${id}`,
  events: (changeId) => `gmudev:${changeId}:`,
  release: (changeId, id) => `gmudrel:${changeId}:${id}`,
  releases: (changeId) => `gmudrel:${changeId}:`,
  deployment: (changeId, id) => `gmuddep:${changeId}:${id}`,
  deployments: (changeId) => `gmuddep:${changeId}:`,
  // the company's object
  index: (orgId, id) => `chgidx:${orgId}:${id}`,
  indexes: (orgId) => `chgidx:${orgId}:`,
  releaseIdx: (orgId, id) => `relidx:${orgId}:${id}`,
  releaseIdxs: (orgId) => `relidx:${orgId}:`,
  deploymentIdx: (orgId, id) => `depidx:${orgId}:${id}`,
  deploymentIdxs: (orgId) => `depidx:${orgId}:`,
  seq: (orgId, year) => `chgseq:${orgId}:${year}`,
  settings: (orgId) => `gmudcfg:${orgId}`,
  meta: (orgId) => `gmudmeta:${orgId}`,
  // before each change had its own object
  legacy: {
    changes: (orgId) => `chg:${orgId}:`,
    change: (orgId, id) => `chg:${orgId}:${id}`,
    events: (orgId, changeId) => `chgev:${orgId}:${changeId}:`,
    releases: (orgId) => `rel:${orgId}:`,
    deployments: (orgId) => `dep:${orgId}:`,
  },
};

// what the company's lists need of a release / deployment (details stay in the change's object)
const releaseSummary = ({ notes, prs, ...rest }) => rest;
const deploymentSummary = ({ history, notes, ...rest }) => rest;

// fields whose old → new value is worth showing in the activity log
const TRACKED = new Set(['title', 'changeType', 'category', 'priority', 'override', 'environment', 'plannedAt', 'responsibleId', 'teamId', 'probability', 'impact', 'strategy', 'notApplicable']);
const EDIT_MERGE_MS = 10 * 60_000; // autosave edits by the same person within 10 min are one log entry

const short = (v) => (typeof v === 'string' ? v.slice(0, 80) : v);

export default defineModule({
  id: 'gmud',
  name: 'Changes (GMUD)',
  description: 'Change management for software: GMUDs with risk, testing, rollback and approvals, SemVer releases per repository and deployments, with GitHub import.',
  // optional: each company turns it on in Administration → Modules
  defaultEnabled: false,
  keyPrefixes: ['gmud:', 'gmudrel:', 'gmuddep:', 'chgidx:', 'relidx:', 'depidx:'],
  shards: {
    gmud: 'gmud', gmudev: 'gmud', gmudrel: 'gmud', gmuddep: 'gmud', // one object per change
    chgidx: 'org', relidx: 'org', depidx: 'org', chgseq: 'org', gmudcfg: 'org', gmudmeta: 'org',
    chg: 'org', chgev: 'org', rel: 'org', dep: 'org', // old layout, read once to move it
  },
  register(core) {
    const { db, isAdmin, requireAdmin, listUsers, integrationFor, realtime } = core;

    // ---------------------------------------------------------------- live updates
    // Two channels: one per change (its page) and one per company (the lists and summaries).
    // After any successful change the people looking are told "it changed"; their browsers reload
    // through the API, so the message itself carries no content.
    const changeChannel = (id) => `gmud:${id}`;
    const orgChannel = (orgId) => `gmud-org:${orgId}`;
    async function announce(c, changeId) {
      const message = { type: 'changed', change: changeId || null, at: Date.now() };
      await Promise.all([changeId ? realtime.publish(changeChannel(changeId), message) : null, realtime.publish(orgChannel(c.org.id), message)]);
    }
    // which change a write touched: the URL (/api/gmud/changes/:id/...), or what the handler returned
    const touchedChange = async (c, res) => {
      if (c.params.id && c.url.pathname.startsWith('/api/gmud/changes/')) return c.params.id;
      const body = await res.clone().json().catch(() => null);
      return body?.change?.id || body?.deployment?.changeId || body?.release?.changeId || null;
    };
    const QUIET = ['/api/gmud/github/', '/api/gmud/semver/', '/api/gmud/settings'];
    const route = (method, path, fn, opts) =>
      core.route(
        method,
        path,
        method === 'GET' || QUIET.some((q) => path.startsWith(q))
          ? fn
          : async (c) => {
              const res = await fn(c);
              if (res.status < 400) await announce(c, await touchedChange(c, res));
              return res;
            },
        opts,
      );

    // ---------------------------------------------------------------- helpers
    const settingsOf = async (orgId) => {
      const saved = await db.get(K.settings(orgId));
      return saved ? cleanSettings(saved, DEFAULT_SETTINGS) : JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    };

    // ---------------------------------------------------------------- moving the old layout
    const migrated = new Set();
    async function migrate(orgId) {
      if (migrated.has(orgId)) return;
      if (!(await db.get(K.meta(orgId)))) {
        for (const change of await db.list(K.legacy.changes(orgId))) {
          await db.put(K.change(change.id), change);
          for (const e of await db.list(K.legacy.events(orgId, change.id))) {
            await db.put(K.event(change.id, e.id), e);
            await db.delete(`chgev:${orgId}:${change.id}:${e.id}`);
          }
          await db.put(K.index(orgId, change.id), lite(change));
          await db.delete(K.legacy.change(orgId, change.id));
        }
        for (const rel of await db.list(K.legacy.releases(orgId))) {
          await putRelease(rel);
          await db.delete(`rel:${orgId}:${rel.id}`);
        }
        for (const dep of await db.list(K.legacy.deployments(orgId))) {
          await putDeployment(dep);
          await db.delete(`dep:${orgId}:${dep.id}`);
        }
        await db.put(K.meta(orgId), { layout: 'per-change', at: now() });
      }
      migrated.add(orgId);
    }

    async function loadChange(c, id = c.params.id) {
      await migrate(c.org.id);
      const change = await db.get(K.change(id));
      if (!change || change.orgId !== c.org.id) fail(404, 'Change not found');
      return change;
    }

    const listIndex = async (orgId) => (await migrate(orgId), db.list(K.indexes(orgId)));
    // the index summaries carry what rolesFor() needs
    const asChange = (x) => ({ ...x, approvals: { required: x.required, decisions: x.decisions } });

    // releases and deployments: full record in the change's object, summary in the company's
    async function putRelease(rel) {
      await db.put(K.release(rel.changeId, rel.id), rel);
      await db.put(K.releaseIdx(rel.orgId, rel.id), releaseSummary(rel));
    }
    async function putDeployment(dep) {
      await db.put(K.deployment(dep.changeId, dep.id), dep);
      await db.put(K.deploymentIdx(dep.orgId, dep.id), deploymentSummary(dep));
    }

    const canEdit = (c, ch) => isAdmin(c) || ch.createdBy === c.user.id || ch.overview.responsibleId === c.user.id;
    const canExecute = (c, ch) => canEdit(c, ch) || [ch.execution.ownerId, ch.execution.monitoringOwnerId].includes(c.user.id);

    async function log(c, change, type, message, extra = {}) {
      const event = { id: newId(), at: now(), by: c.user.id, type, message, ...extra };
      await db.put(K.event(change.id, event.id), event);
      return event;
    }

    // the change in its object, then its summary in the company's index
    async function save(change, fields) {
      fields.updatedAt = now();
      Object.assign(change, fields);
      await db.patch(K.change(change.id), fields);
      await db.put(K.index(change.orgId, change.id), lite(change));
      return change;
    }

    async function nextNumber(orgId) {
      const year = new Date().getUTCFullYear();
      const key = K.seq(orgId, year);
      if (!(await db.get(key))) await db.put(key, { n: 0 });
      await db.touch(key, 'n', 0); // atomic +1 on the company's object
      const { n } = await db.get(key);
      return `CHG-${year}-${String(n).padStart(4, '0')}`;
    }

    const lite = (ch) => ({
      id: ch.id,
      number: ch.number,
      status: ch.status,
      title: ch.overview.title,
      changeType: ch.overview.changeType,
      category: ch.overview.category,
      priority: ch.overview.priority,
      risk: riskLevel(ch),
      environment: ch.overview.environment,
      plannedAt: ch.overview.plannedAt,
      responsibleId: ch.overview.responsibleId,
      teamId: ch.overview.teamId,
      tags: ch.overview.tags,
      repos: ch.code.repos.map((r) => ({ repo: r.repo, currentVersion: r.currentVersion, nextVersion: r.nextVersion })),
      required: ch.approvals.required,
      decisions: ch.approvals.decisions.map(({ role, decision, userId, viaTeam }) => ({ role, decision, userId, viaTeam: viaTeam || null })),
      securityFlag: Boolean(ch.risk.indicators?.security),
      createdBy: ch.createdBy,
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
    });

    async function view(c, change) {
      const settings = await settingsOf(c.org.id);
      const preview = EDITABLE.includes(change.status) ? requiredApprovals(change, settings) : change.approvals.required;
      return {
        change,
        readiness: readiness(change),
        requiredPreview: preview,
        can: {
          edit: canEdit(c, change) && EDITABLE.includes(change.status),
          manage: canEdit(c, change),
          execute: canExecute(c, change) && EXECUTABLE.includes(change.status),
          decide: rolesFor(change, c.user, settings),
        },
      };
    }

    async function transition(c, change, to, message, extra = {}) {
      const from = change.status;
      await save(change, { status: to, ...extra });
      await log(c, change, 'status', message, { from, to });
      await syncReleases(c, change);
      return change;
    }

    // ---------------------------------------------------------------- releases follow the change
    // Approved → one planned release per repository; completed → released;
    // cancelled → cancelled; rolled back → rolled back. A failed deployment doesn't touch them.
    async function syncReleases(c, change) {
      const mine = await db.list(K.releases(change.id));
      if (change.status === 'approved' && !mine.length) {
        for (const repo of change.code.repos) {
          const rel = {
            id: newId(),
            orgId: c.org.id,
            changeId: change.id,
            changeNumber: change.number,
            repo: repo.repo,
            version: repo.nextVersion,
            previousVersion: repo.currentVersion,
            bump: repo.bump,
            tag: `v${repo.nextVersion}`,
            notes: releaseNotes(repo),
            notesOrigin: 'generated',
            prs: repo.prs.map((p) => ({ number: p.number, title: p.title, url: p.url })),
            status: 'planned',
            createdAt: now(),
            releasedAt: '',
          };
          await putRelease(rel);
        }
        await log(c, change, 'release', `Planned ${change.code.repos.length} release(s): ${change.code.repos.map((r) => `${r.repo} ${r.nextVersion}`).join(', ')}`);
        return;
      }
      const target = { completed: 'released', cancelled: 'cancelled', rolled_back: 'rolled_back' }[change.status];
      if (!target) return;
      for (const rel of mine) {
        if (rel.status === target) continue;
        await putRelease({ ...rel, status: target, releasedAt: target === 'released' ? now() : rel.releasedAt });
      }
    }

    // ---------------------------------------------------------------- people & settings
    route('GET', '/api/gmud/people', async (c) => {
      const users = await listUsers(c.org.id);
      return json({ people: users.map((u) => ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar || null, role: u.role })).sort((a, b) => a.name.localeCompare(b.name)) });
    });

    route('GET', '/api/gmud/settings', async (c) => json({ settings: await settingsOf(c.org.id), roles: ROLES }));

    route('PUT', '/api/gmud/settings', async (c) => {
      requireAdmin(c);
      const users = new Set((await listUsers(c.org.id)).map((u) => u.id));
      const teams = new Set((await core.listTeams(c.org.id)).map((t) => t.id));
      const settings = cleanSettings(c.body, await settingsOf(c.org.id));
      for (const r of ROLES) {
        settings.approvers[r] = settings.approvers[r].filter((id) => users.has(id));
        settings.approverTeams[r] = settings.approverTeams[r].filter((id) => teams.has(id));
      }
      await db.put(K.settings(c.org.id), settings);
      return json({ settings });
    });

    // ---------------------------------------------------------------- changes
    route('GET', '/api/gmud/changes', async (c) => {
      const [list, settings] = await Promise.all([listIndex(c.org.id), settingsOf(c.org.id)]);
      // drafts haven't fixed their approvals yet: show the ones they will need under today's rules
      const preview = (x) => requiredApprovals({ overview: { environment: x.environment, category: x.category }, risk: { override: x.risk, indicators: { security: x.securityFlag } } }, settings);
      const out = list.map((x) => (x.status === 'draft' ? { ...x, required: preview(x), requiredPreview: true } : x));
      return json({ changes: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), settings });
    });

    route('POST', '/api/gmud/changes', async (c) => {
      const change = {
        id: newId(),
        orgId: c.org.id,
        number: await nextNumber(c.org.id),
        status: 'draft',
        ...emptyChange(),
        createdBy: c.user.id,
        createdAt: now(),
        updatedAt: now(),
      };
      change.overview.title = str(c.body.title, 160);
      change.overview.responsibleId = c.user.id;
      change.overview.teamId = c.user.teamIds[0] || c.org.defaultTeamId || '';
      change.execution.ownerId = c.user.id;
      change.execution.steps = DEFAULT_STEPS.map(([title, detail]) => cleanStep({ id: newId(), title, detail }));
      await migrate(c.org.id);
      await db.put(K.change(change.id), change);
      await db.put(K.index(c.org.id, change.id), lite(change));
      await log(c, change, 'created', `Created ${change.number}`);
      return json(await view(c, change), 201);
    });

    route('GET', '/api/gmud/changes/:id', async (c) => json(await view(c, await loadChange(c))));

    // WebSockets: one change (anyone in the company may follow it), or the company's lists
    route('GET', '/api/gmud/changes/:id/live', async (c) => realtime.connect(c.req, changeChannel((await loadChange(c)).id)));
    route('GET', '/api/gmud/live', async (c) => realtime.connect(c.req, orgChannel(c.org.id)));

    // Autosave: one section at a time, only while it is a draft.
    route('PATCH', '/api/gmud/changes/:id', async (c) => {
      const change = await loadChange(c);
      if (!canEdit(c, change)) fail(403, 'Only the requester, the responsible person or an admin can edit this change');
      if (!EDITABLE.includes(change.status)) fail(409, 'Only drafts can be edited. Withdraw the change to edit it.');
      const { section } = c.body;
      const data = c.body.data || {};
      const fields = {};
      // fields derived from other steps are kept as they are
      const derived = { changeType: change.overview.changeType, description: change.overview.description, riskLevel: change.overview.riskLevel };
      if (section === 'overview') fields.overview = { ...derived, ...SECTIONS.overview(data) };
      else if (section === 'code') {
        fields.code = await cleanCode(c, data, change);
        const changeType = changeTypeOf(fields.code.repos);
        if (changeType !== change.overview.changeType) fields.overview = { ...change.overview, changeType };
      }
      else if (section === 'risk') {
        fields.risk = SECTIONS.risk(data);
        fields.risk.calculated = calculateRisk(fields.risk.probability, fields.risk.impact);
        if (data.testing) fields.testing = SECTIONS.testing(data.testing);
        if (data.rollback) fields.rollback = SECTIONS.rollback(data.rollback);
      } else if (section === 'execution') {
        fields.execution = SECTIONS.execution(data, change.execution);
        fields.execution.steps = fields.execution.steps.map((s) => ({ ...s, id: s.id || newId() }));
      } else fail(400, 'Unknown section');

      const changes = [];
      for (const [name, next] of Object.entries(fields)) {
        const before = change[name] || {};
        for (const [k, v] of Object.entries(next)) {
          if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
          changes.push(TRACKED.has(k) && typeof v !== 'object' ? { field: `${name}.${k}`, from: short(before[k] ?? ''), to: short(v) } : { field: `${name}.${k}` });
        }
      }
      if (!changes.length) return json(await view(c, change));
      await save(change, fields);
      await logEdit(c, change, section, changes);
      return json(await view(c, change));
    });

    async function logEdit(c, change, section, changes) {
      const events = await db.list(K.events(change.id));
      const last = events[events.length - 1];
      if (last?.type === 'edited' && last.by === c.user.id && last.section === section && Date.now() - Date.parse(last.at) < EDIT_MERGE_MS) {
        const merged = [...last.changes];
        for (const ch of changes) {
          const i = merged.findIndex((m) => m.field === ch.field);
          if (i < 0) merged.push(ch);
          else merged[i] = { ...ch, from: merged[i].from }; // keep the value from before the session
        }
        await db.patch(K.event(change.id, last.id), { at: now(), changes: merged });
        return;
      }
      await log(c, change, 'edited', `Edited ${section}`, { section, changes });
    }

    // Code section: versions are suggested from the PRs (company policy) and must be confirmed.
    async function cleanCode(c, data, change) {
      const settings = await settingsOf(c.org.id);
      const code = SECTIONS.code(data);
      const raw = new Map((Array.isArray(data.repos) ? data.repos : []).map((r) => [str(r?.repo, 140), r]));
      for (const repo of code.repos) {
        repo.suggested = suggestBump(repo.prs, settings.semver);
        if (!repo.bump) repo.bump = repo.suggested.bump;
        if (!repo.nextVersion && repo.currentVersion) repo.nextVersion = bump(repo.currentVersion, repo.bump);
        // a confirmation holds only for the version that was confirmed
        const sent = raw.get(repo.repo) || {};
        const confirmedVersion = sent.confirmed ? str(sent.confirmedVersion || sent.nextVersion, 60).replace(/^v/, '') : '';
        repo.confirmed = Boolean(repo.nextVersion) && confirmedVersion === repo.nextVersion;
        repo.confirmedVersion = repo.confirmed ? repo.nextVersion : '';
      }
      if (code.summary.origin === 'manual' && change.code.summary.origin !== 'manual' && code.summary.text) code.summary.origin = 'edited';
      return code;
    }

    route('POST', '/api/gmud/changes/:id/summary', async (c) => {
      const change = await loadChange(c);
      if (!canEdit(c, change) || !EDITABLE.includes(change.status)) fail(403, 'Only drafts can be edited');
      const text = changeSummary(change);
      if (!text) fail(400, 'Add repositories and pull requests first');
      await save(change, { code: { ...change.code, summary: { text, origin: 'generated' } } });
      await log(c, change, 'edited', 'Generated the description from the pull requests', { section: 'code', changes: [{ field: 'code.summary' }] });
      return json(await view(c, change));
    });

    route('DELETE', '/api/gmud/changes/:id', async (c) => {
      const change = await loadChange(c);
      if (!canEdit(c, change)) fail(403, 'Only the requester, the responsible person or an admin can delete this change');
      if (change.status !== 'draft') fail(409, 'Only drafts can be deleted. Cancel the change instead.');
      for (const e of await db.list(K.events(change.id))) await db.delete(K.event(change.id, e.id));
      await db.delete(K.change(change.id));
      await db.delete(K.index(c.org.id, change.id));
      return json({ ok: true });
    });

    route('POST', '/api/gmud/changes/:id/submit', async (c) => {
      const change = await loadChange(c);
      if (!canEdit(c, change)) fail(403, 'Only the requester, the responsible person or an admin can submit this change');
      if (change.status !== 'draft') fail(409, 'Only drafts can be submitted');
      const ready = readiness(change);
      if (!ready.ok) return json({ error: 'Some required information is missing', missing: ready.missing }, 400);
      const settings = await settingsOf(c.org.id);
      await transition(c, change, 'submitted', `Submitted for approval (${requiredApprovals(change, settings).join(', ')})`, {
        submittedAt: now(),
        approvals: { required: requiredApprovals(change, settings), decisions: [] },
      });
      return json(await view(c, change));
    });

    route('POST', '/api/gmud/changes/:id/decision', async (c) => {
      const change = await loadChange(c);
      const settings = await settingsOf(c.org.id);
      const role = c.body.role;
      const decision = c.body.decision === 'rejected' ? 'rejected' : c.body.decision === 'approved' ? 'approved' : null;
      if (!decision) fail(400, 'Approve or reject');
      if (!rolesFor(change, c.user, settings).includes(role)) {
        if (!['submitted', 'in_review'].includes(change.status)) fail(409, 'This change is not waiting for approval');
        if (!settings.allowSelfApproval && change.createdBy === c.user.id) fail(403, "You can't approve a change you requested");
        fail(403, `You're not a ${role} approver for this change`);
      }
      const comment = str(c.body.comment, 2000);
      if (decision === 'rejected' && !comment) fail(400, 'Say why the change is rejected');
      // on whose behalf: listed by name, a team (group), or as an admin
      const teams = settings.approverTeams[role] || [];
      const viaTeam = (settings.approvers[role] || []).includes(c.user.id) ? null : c.user.teamIds.find((t) => teams.includes(t)) || null;
      const entry = { id: newId(), role, decision, userId: c.user.id, viaTeam, comment, at: now() };
      const decisions = [...change.approvals.decisions, entry];
      const approvals = { ...change.approvals, decisions };
      await log(c, change, 'decision', `${decision === 'approved' ? 'Approved' : 'Rejected'} as ${role} approver`, { role, decision, comment });
      const allApproved = change.approvals.required.every((r) => decisions.some((d) => d.role === r && d.decision === 'approved'));
      if (decision === 'rejected') await transition(c, change, 'rejected', 'Rejected', { approvals });
      else if (allApproved) await transition(c, change, 'approved', 'Approved: every required approval is in', { approvals, approvedAt: now() });
      else if (change.status === 'submitted') await transition(c, change, 'in_review', 'In review', { approvals });
      else await save(change, { approvals });
      return json(await view(c, change));
    });

    const MESSAGES = {
      withdraw: 'Withdrawn back to draft',
      schedule: 'Scheduled',
      start: 'Execution started',
      complete: 'Completed',
      fail: 'Marked as failed',
      rollback: 'Rolled back',
      cancel: 'Cancelled',
      revise: 'Reopened as a draft to address the rejection',
    };

    route('POST', '/api/gmud/changes/:id/actions/:action', async (c) => {
      const change = await loadChange(c);
      const rule = TRANSITIONS[c.params.action];
      if (!rule) fail(404, 'Unknown action');
      const [from, to] = rule;
      const allowed = ['start', 'complete', 'fail', 'rollback'].includes(c.params.action) ? canExecute(c, change) : canEdit(c, change);
      if (!allowed) fail(403, "You can't do this on this change");
      if (!from.includes(change.status)) fail(409, `A change that is ${change.status.replace('_', ' ')} can't be ${MESSAGES[c.params.action].toLowerCase()}`);
      const comment = str(c.body.comment, 2000);
      if (['fail', 'rollback', 'cancel'].includes(c.params.action) && !comment) fail(400, 'Add a short reason');
      const extra = {};
      if (to === 'draft') extra.approvals = { required: [], decisions: [] };
      if (to === 'scheduled' && !change.overview.plannedAt) fail(400, 'Set the planned date first');
      if (to === 'in_progress') extra.startedAt = now();
      if (['completed', 'failed', 'rolled_back'].includes(to)) extra.finishedAt = now();
      await transition(c, change, to, comment ? `${MESSAGES[c.params.action]}: ${comment}` : MESSAGES[c.params.action], extra);
      return json(await view(c, change));
    });

    route('POST', '/api/gmud/changes/:id/comments', async (c) => {
      const change = await loadChange(c);
      const text = str(c.body.text, 4000);
      if (!text) fail(400, 'Write a comment');
      const event = await log(c, change, 'comment', text);
      return json({ event }, 201);
    });

    route('GET', '/api/gmud/changes/:id/activity', async (c) => {
      const change = await loadChange(c);
      const events = await db.list(K.events(change.id));
      return json({ events: events.reverse() });
    });

    // Execution checklist: status, evidence and notes of each step.
    route('PATCH', '/api/gmud/changes/:id/steps/:stepId', async (c) => {
      const change = await loadChange(c);
      if (!canExecute(c, change)) fail(403, "You're not part of this change's execution");
      if (!EXECUTABLE.includes(change.status)) fail(409, 'The checklist is tracked once the change is approved');
      const steps = change.execution.steps.map((s) => (s.id === c.params.stepId ? cleanStep({ ...s, ...c.body, id: s.id, title: s.title }) : s));
      const step = steps.find((s) => s.id === c.params.stepId);
      if (!step) fail(404, 'Step not found');
      await save(change, { execution: { ...change.execution, steps } });
      await log(c, change, 'step', `${step.title}: ${step.status.replace('_', ' ')}${step.notes ? ` (${step.notes.slice(0, 120)})` : ''}`, { stepId: step.id, status: step.status });
      return json(await view(c, change));
    });

    // ---------------------------------------------------------------- releases
    const byNewest = (list) => list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // the company's releases (summaries); details come from the change
    route('GET', '/api/gmud/releases', async (c) => (await migrate(c.org.id), json({ releases: byNewest(await db.list(K.releaseIdxs(c.org.id))) })));

    route('GET', '/api/gmud/changes/:id/releases', async (c) => {
      const change = await loadChange(c);
      return json({ releases: byNewest(await db.list(K.releases(change.id))) });
    });

    route('PATCH', '/api/gmud/releases/:id', async (c) => {
      await migrate(c.org.id);
      const idx = await db.get(K.releaseIdx(c.org.id, c.params.id));
      if (!idx) fail(404, 'Release not found');
      const change = await loadChange(c, idx.changeId);
      const rel = await db.get(K.release(change.id, idx.id));
      if (!rel) fail(404, 'Release not found');
      if (!canEdit(c, change)) fail(403, "You can't edit this release");
      const notes = str(c.body.notes, 20000);
      await db.patch(K.release(change.id, rel.id), { notes, notesOrigin: 'edited' });
      await log(c, change, 'release', `Edited the release notes of ${rel.repo} ${rel.version}`);
      return json({ release: { ...rel, notes, notesOrigin: 'edited' } });
    });

    // ---------------------------------------------------------------- deployments (registered)
    route('GET', '/api/gmud/deployments', async (c) => (await migrate(c.org.id), json({ deployments: byNewest(await db.list(K.deploymentIdxs(c.org.id))) })));

    route('GET', '/api/gmud/changes/:id/deployments', async (c) => {
      const change = await loadChange(c);
      return json({ deployments: byNewest(await db.list(K.deployments(change.id))) });
    });

    route('POST', '/api/gmud/changes/:id/deployments', async (c) => {
      const change = await loadChange(c);
      if (!canExecute(c, change)) fail(403, "You're not part of this change's execution");
      if (!EXECUTABLE.includes(change.status)) fail(409, 'Deployments are registered once the change is approved');
      const releases = await db.list(K.releases(change.id));
      const ids = Array.isArray(c.body.releaseIds) ? c.body.releaseIds.filter((id) => releases.some((r) => r.id === id)) : [];
      const status = DEPLOY_STATUSES.includes(c.body.status) ? c.body.status : 'planned';
      const environment = ENVIRONMENTS.includes(c.body.environment) ? c.body.environment : change.overview.environment;
      const dep = {
        id: newId(),
        orgId: c.org.id,
        changeId: change.id,
        changeNumber: change.number,
        environment,
        releaseIds: ids.length ? ids : releases.map((r) => r.id),
        releases: (ids.length ? releases.filter((r) => ids.includes(r.id)) : releases).map((r) => ({ id: r.id, repo: r.repo, version: r.version })),
        status,
        url: urlOrEmpty(c.body.url),
        notes: str(c.body.notes, 2000),
        createdBy: c.user.id,
        createdAt: now(),
        startedAt: status === 'planned' ? '' : now(),
        finishedAt: ['succeeded', 'failed', 'rolled_back'].includes(status) ? now() : '',
        history: [{ status, at: now(), by: c.user.id, note: str(c.body.notes, 500) }],
      };
      await putDeployment(dep);
      await log(c, change, 'deployment', `Registered a deployment to ${environment} (${status.replace('_', ' ')})`, { deploymentId: dep.id });
      await followDeployment(c, change, dep);
      return json({ deployment: dep, ...(await view(c, change)) }, 201);
    });

    route('PATCH', '/api/gmud/deployments/:id', async (c) => {
      await migrate(c.org.id);
      const idx = await db.get(K.deploymentIdx(c.org.id, c.params.id));
      if (!idx) fail(404, 'Deployment not found');
      const change = await loadChange(c, idx.changeId);
      const dep = await db.get(K.deployment(change.id, idx.id));
      if (!dep) fail(404, 'Deployment not found');
      if (!canExecute(c, change)) fail(403, "You're not part of this change's execution");
      const previousStatus = dep.status;
      const status = DEPLOY_STATUSES.includes(c.body.status) ? c.body.status : dep.status;
      const note = str(c.body.note, 500);
      const fields = {
        status,
        url: c.body.url !== undefined ? urlOrEmpty(c.body.url) : dep.url,
        notes: c.body.notes !== undefined ? str(c.body.notes, 2000) : dep.notes,
        history: status !== dep.status || note ? [...dep.history, { status, at: now(), by: c.user.id, note }] : dep.history,
      };
      if (status === 'in_progress' && !dep.startedAt) fields.startedAt = now();
      if (['succeeded', 'failed', 'rolled_back'].includes(status) && status !== dep.status) fields.finishedAt = now();
      Object.assign(dep, fields);
      await putDeployment(dep);
      if (status !== previousStatus || note) {
        await log(c, change, 'deployment', `Deployment to ${dep.environment}: ${status.replace('_', ' ')}${note ? ` (${note})` : ''}`, { deploymentId: dep.id });
      }
      await followDeployment(c, change, dep);
      return json({ deployment: dep });
    });

    // A deployment that starts moves an approved/scheduled change to "in progress".
    async function followDeployment(c, change, dep) {
      if (dep.status === 'in_progress' && ['approved', 'scheduled'].includes(change.status)) {
        await transition(c, change, 'in_progress', `Execution started (deployment to ${dep.environment})`, { startedAt: now() });
      }
    }

    const urlOrEmpty = (v) => {
      const s = str(v, 500);
      try {
        return s && ['http:', 'https:'].includes(new URL(s).protocol) ? s : '';
      } catch {
        return '';
      }
    };

    // ---------------------------------------------------------------- GitHub (read-only)
    async function gh(c) {
      const integration = await integrationFor(c, 'github');
      if (!integration?.token) fail(412, 'Connect GitHub first: My account → Integrations → GitHub');
      return githubClient(integration.token);
    }

    route('GET', '/api/gmud/github/status', async (c) => {
      const integration = await integrationFor(c, 'github').catch(() => null);
      if (!integration?.token) return json({ connected: false });
      try {
        const me = await githubClient(integration.token).me();
        return json({ connected: true, login: me.login });
      } catch (e) {
        return json({ connected: false, error: e.message });
      }
    });

    route('GET', '/api/gmud/github/repos', async (c) => json(await (await gh(c)).repos({ q: c.url.searchParams.get('q') || '', owner: c.url.searchParams.get('owner') || '' })));

    route('GET', '/api/gmud/github/refs', async (c) => json(await (await gh(c)).refs(c.url.searchParams.get('repo'))));

    route('GET', '/api/gmud/github/latest', async (c) => json(await (await gh(c)).latestVersion(c.url.searchParams.get('repo'))));

    route('GET', '/api/gmud/github/releases', async (c) => json({ releases: await (await gh(c)).releases(c.url.searchParams.get('repo')) }));

    route('GET', '/api/gmud/github/pulls', async (c) => json({ pulls: await (await gh(c)).searchPulls(c.url.searchParams.get('repo'), c.url.searchParams.get('q') || '') }));

    // Imports a repository's scope: picked PRs, a GitHub Release, or a comparison of two refs.
    // Also returns the latest published version and the SemVer increment the PRs suggest.
    route('POST', '/api/gmud/github/import', async (c) => {
      const client = await gh(c);
      const { repo, mode } = c.body;
      splitRepo(repo);
      let result;
      if (mode === 'prs') result = await client.importPulls(repo, c.body.numbers);
      else if (mode === 'release') result = await client.importRelease(repo, str(c.body.tag, 120));
      else if (mode === 'compare') result = await client.importCompare(repo, str(c.body.base, 120), str(c.body.head, 120));
      else fail(400, 'Pick how to import: prs, release or compare');
      const current = await client.latestVersion(repo).catch(() => ({ version: '' }));
      const settings = await settingsOf(c.org.id);
      const suggested = suggestBump(result.prs, settings.semver);
      // a release import already has its version: the release's tag
      const fromTag = mode === 'release' && validVersion(c.body.tag) ? str(c.body.tag, 60).replace(/^v/, '') : '';
      return json({
        ...result,
        currentVersion: mode === 'release' && result.previous && validVersion(result.previous) ? result.previous.replace(/^v/, '') : current.version,
        suggested,
        nextVersion: fromTag || (current.version ? bump(current.version, suggested.bump) : ''),
      });
    });

    route('POST', '/api/gmud/semver/next', async (c) => {
      const type = BUMPS.includes(c.body.bump) ? c.body.bump : 'patch';
      return json({ version: bump(c.body.version || '0.0.0', type, str(c.body.pre, 20)) });
    });

    // ---------------------------------------------------------------- dashboard
    return {
      dashboard: async (c) => {
        // only the company's index: the home page never opens each change's object
        const [list, settings] = await Promise.all([listIndex(c.org.id), settingsOf(c.org.id)]);
        const awaitingMe = list.filter((ch) => rolesFor(asChange(ch), c.user, settings).length);
        const mine = list.filter((ch) => OPEN.includes(ch.status) && (ch.createdBy === c.user.id || ch.responsibleId === c.user.id));
        const upcoming = list
          .filter((ch) => ['approved', 'scheduled'].includes(ch.status) && ch.plannedAt)
          .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))
          .slice(0, 5);
        return {
          awaitingMe,
          mine,
          upcoming,
          counts: {
            waiting: list.filter((ch) => ['submitted', 'in_review'].includes(ch.status)).length,
            inProgress: list.filter((ch) => ch.status === 'in_progress').length,
          },
        };
      },
      adminDashboard: async (c) => {
        const list = await listIndex(c.org.id);
        const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        const overdue = list.filter((ch) => ['approved', 'scheduled'].includes(ch.status) && ch.plannedAt && ch.plannedAt < nowLocal);
        return { overdue };
      },
      beforeTeamDelete: async (c, teamId) => {
        const open = (await listIndex(c.org.id)).filter((ch) => ch.teamId === teamId && OPEN.includes(ch.status));
        if (open.length) fail(409, `This team has ${open.length} open change(s) (${open.slice(0, 3).map((ch) => ch.number).join(', ')}). Finish or move them first.`);
      },
    };
  },
});
