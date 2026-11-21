// @rewind/goals — Goals & Objectives (spec: 01-goals-objectives.md).
//
// Connects the organization's priorities to the outcomes teams are after:
// cycles, objectives (organization / group / team), key results, immutable
// check-ins, initiatives, cycle reviews, links and in-app reminders.
//
// The module owns only its own keys (g*:). People and teams come from the
// core services, groups/memberships/roles from the foundation's canonical
// model (read through its published helpers), and events, audit records and
// entity links are written with the foundation's helpers. Goals never talks to
// an identity provider directly.

import { defineModule, fail, json, newId, now } from '@rewind/core';
import { recordAudit, recordEvent, createLink, deleteLink, K as FK } from '@rewind/foundation/server/events';
import { activeMemberships, hasPermission, loadPermissions, registerPermissions } from '@rewind/foundation/server/rbac';
import {
  CHECKIN_STATUS, CYCLE_KINDS, CYCLE_STATUS, DIRECTIONS, ENTITY_TYPES, FINAL_STATUS, FREQUENCIES,
  INITIATIVE_STATUS, KR_TYPES, LINK_RELATIONSHIPS, LINK_TARGETS, LIVE_STATUS, OBJECTIVE_STATUS,
  PERMISSIONS, PRIORITIES, SCOPES, VISIBILITY,
  assertValidCheckIn, assertValidCycle, assertValidInitiative, assertValidKeyResult, assertValidLink,
  assertValidObjective, checkInDue, cleanCheckIn, cleanCycle, cleanInitiative, cleanKeyResult,
  cleanLinkInput, cleanObjective, objectiveProgress, progressOf,
} from './model.js';

const K = {
  cycle: (o, id) => `gcyc:${o}:${id}`,
  cycles: (o) => `gcyc:${o}:`,
  objective: (o, id) => `gobj:${o}:${id}`,
  objectives: (o) => `gobj:${o}:`,
  kr: (o, objId, id) => `gkr:${o}:${objId}:${id}`,
  krsOf: (o, objId) => `gkr:${o}:${objId}:`,
  krs: (o) => `gkr:${o}:`,
  checkIn: (o, krId, id) => `gchk:${o}:${krId}:${id}`,
  checkInsOf: (o, krId) => `gchk:${o}:${krId}:`,
  checkIns: (o) => `gchk:${o}:`,
  initiative: (o, objId, id) => `gini:${o}:${objId}:${id}`,
  initiativesOf: (o, objId) => `gini:${o}:${objId}:`,
};

const byDate = (field) => (a, b) => (b[field] || '').localeCompare(a[field] || '');

export default defineModule({
  id: 'goals',
  name: 'Goals & Objectives',
  description: 'Cycles, objectives for the organization, groups and teams, measurable key results, check-ins with evidence, initiatives and cycle reviews.',
  defaultEnabled: true,
  keyPrefixes: ['gcyc:', 'gobj:', 'gkr:', 'gchk:', 'gini:'],
  // everything in the company's object: objectives are read across teams
  shards: { gcyc: 'org', gobj: 'org', gkr: 'org', gchk: 'org', gini: 'org' },
  register(core) {
    const { db, isAdmin, getTeam, listUsers, listTeams } = core;
    registerPermissions(PERMISSIONS);

    // ------------------------------------------------------------ access
    // Authorization is evaluated at the moment of each action (spec §4) from
    // the canonical model: core teams + foundation memberships and roles.
    async function access(c) {
      if (c.goalsAccess) return c.goalsAccess;
      const [perms, mine] = await Promise.all([
        loadPermissions(db, c.org.id, c.user),
        activeMemberships(db, c.org.id, c.user.id),
      ]);
      const admin = isAdmin(c);
      const can = (p) => admin || hasPermission(perms, p);
      c.goalsAccess = { admin, can, inScope: (type, id) => inScope(c.user, type, id, mine) };
      return c.goalsAccess;
    }

    function inScope(user, scopeType, scopeId, memberships) {
      if (user.role === 'admin' || scopeType === 'org') return true;
      if (scopeType === 'team' && (user.teamIds || []).includes(scopeId)) return true;
      return memberships.some((m) => m.userId === user.id && m.scopeType === scopeType && m.scopeId === scopeId);
    }

    const involved = (o, userId) => o.ownerId === userId || o.collaboratorIds.includes(userId) || o.createdBy === userId;

    function canRead(c, a, o) {
      if (a.admin || o.visibility === 'org' || involved(o, c.user.id)) return true;
      return a.can('goals:read') || a.can('goals:write') || a.inScope(o.scopeType, o.scopeId);
    }

    function canEdit(c, a, o) {
      if (a.admin || a.can('goals:write')) return true;
      return o.ownerId === c.user.id || o.collaboratorIds.includes(c.user.id) || (o.createdBy === c.user.id && o.status === 'draft');
    }

    function canCreateIn(a, scopeType, scopeId) {
      if (a.admin || a.can('goals:write')) return true;
      // organization objectives are set by whoever governs goals
      if (scopeType === 'org') return false;
      return a.inScope(scopeType, scopeId);
    }

    const requireCycles = async (c) => {
      const a = await access(c);
      if (!a.can('goals:admin')) fail(403, 'Only goal admins can manage cycles');
    };

    // ------------------------------------------------------------ loaders
    async function getObjective(c, id, { edit = false } = {}) {
      const o = await db.get(K.objective(c.org.id, id));
      if (!o) fail(404, 'Objective not found');
      const a = await access(c);
      if (!canRead(c, a, o)) fail(404, 'Objective not found'); // don't reveal restricted objectives
      if (edit && !canEdit(c, a, o)) fail(403, "You can't edit this objective");
      return o;
    }

    async function getKr(c, objectiveId, krId) {
      const kr = await db.get(K.kr(c.org.id, objectiveId, krId));
      if (!kr) fail(404, 'Key result not found');
      return kr;
    }

    // Owner and collaborators must exist in the internal directory and have
    // access to the objective's scope (spec §9).
    async function checkPeople(c, o) {
      const users = await listUsers(c.org.id);
      const memberships = await db.list(FK.memberships(c.org.id));
      const at = now();
      const active = memberships.filter((m) => (!m.validFrom || m.validFrom <= at) && (!m.validTo || m.validTo >= at));
      for (const [label, id] of [['owner', o.ownerId], ...o.collaboratorIds.map((id) => ['collaborator', id])]) {
        const u = users.find((x) => x.id === id);
        if (!u) fail(400, `The ${label} isn't a member of the company`);
        if (!inScope(u, o.scopeType, o.scopeId, active)) fail(400, `${u.name} (${label}) doesn't have access to this ${o.scopeType}`);
      }
    }

    async function checkScope(c, o) {
      if (o.scopeType === 'org') {
        o.scopeId = null;
        return;
      }
      if (o.scopeType === 'team' && !(await getTeam(c.org.id, o.scopeId))) fail(400, 'Team not found');
      if (o.scopeType === 'group' && !(await db.get(FK.group(c.org.id, o.scopeId)))) fail(400, 'Group not found');
    }

    async function checkCycle(c, cycleId) {
      if (!cycleId) return;
      const cycle = await db.get(K.cycle(c.org.id, cycleId));
      if (!cycle) fail(400, 'Cycle not found');
      if (cycle.status === 'archived') fail(400, 'This cycle is closed');
    }

    // optional alignment: parent must exist and not create a loop
    async function checkParent(c, o, selfId) {
      if (!o.parentId) return;
      let id = o.parentId;
      for (let i = 0; id && i < 50; i++) {
        if (id === selfId) fail(400, "An objective can't be aligned to itself or to one of its children");
        const p = await db.get(K.objective(c.org.id, id));
        if (!p) fail(400, 'Parent objective not found');
        id = p.parentId;
      }
    }

    // ------------------------------------------------------------ events/audit
    async function emit(c, o, entity, entityId, eventType, metadata = {}) {
      return recordEvent(db, {
        orgId: c.org.id,
        actorId: c.user.id,
        teamId: o.scopeType === 'team' ? o.scopeId : null,
        entityType: ENTITY_TYPES[entity],
        entityId,
        eventType,
        source: 'manual',
        // audience travels with the event, so a Team Timeline can respect it
        metadata: { objectiveId: o.id, scopeType: o.scopeType, scopeId: o.scopeId, visibility: o.visibility, title: o.title, ...metadata },
      });
    }

    const audit = (c, action, extra = {}) => recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action, ...extra });

    // ------------------------------------------------------------ views
    async function withKrs(c, o) {
      const krs = await db.list(K.krsOf(c.org.id, o.id));
      return { ...o, progress: objectiveProgress(krs), krCount: krs.length };
    }

    async function lastCheckIn(orgId, krId) {
      return (await db.list(K.checkInsOf(orgId, krId))).sort(byDate('createdAt'))[0] || null;
    }

    // ------------------------------------------------------------ catalog
    core.route('GET', '/api/goals/catalog', async (c) => {
      const a = await access(c);
      return json({
        cycleKinds: CYCLE_KINDS, cycleStatus: CYCLE_STATUS, objectiveStatus: OBJECTIVE_STATUS, finalStatus: FINAL_STATUS,
        priorities: PRIORITIES, scopes: SCOPES, visibility: VISIBILITY, krTypes: KR_TYPES, directions: DIRECTIONS,
        frequencies: Object.keys(FREQUENCIES), checkInStatus: CHECKIN_STATUS, initiativeStatus: INITIATIVE_STATUS,
        linkTargets: LINK_TARGETS, linkRelationships: LINK_RELATIONSHIPS,
        can: { manageCycles: a.can('goals:admin'), writeAny: a.can('goals:write'), export: a.can('goals:export') },
      });
    });

    // people, teams and groups for pickers — from the canonical model
    core.route('GET', '/api/goals/directory', async (c) => {
      const [users, teams, groups] = await Promise.all([listUsers(c.org.id), listTeams(c.org.id), db.list(FK.groups(c.org.id))]);
      return json({
        people: users.map(({ id, name, avatar, teamIds }) => ({ id, name, avatar, teamIds })),
        teams: teams.map(({ id, name }) => ({ id, name })),
        groups: groups.map(({ id, name }) => ({ id, name })),
      });
    });

    // ------------------------------------------------------------ cycles
    core.route('GET', '/api/goals/cycles', async (c) => {
      const cycles = (await db.list(K.cycles(c.org.id))).sort(byDate('startDate'));
      return json({ cycles });
    });

    core.route('POST', '/api/goals/cycles', async (c) => {
      await requireCycles(c);
      const data = cleanCycle(c.body);
      const err = assertValidCycle(data);
      if (err) fail(400, err);
      const cycle = { id: newId(), orgId: c.org.id, ...data, review: null, createdBy: c.user.id, createdAt: now(), updatedAt: now() };
      await db.put(K.cycle(c.org.id, cycle.id), cycle);
      await audit(c, 'goals.cycle.create', { target: cycle.id, after: cycle });
      await recordEvent(db, { orgId: c.org.id, actorId: c.user.id, entityType: 'goal.cycle', entityId: cycle.id, eventType: 'goal.cycle.created', source: 'manual', metadata: { name: cycle.name } });
      return json({ cycle }, 201);
    });

    core.route('PATCH', '/api/goals/cycles/:id', async (c) => {
      await requireCycles(c);
      const cycle = await db.get(K.cycle(c.org.id, c.params.id));
      if (!cycle) fail(404, 'Cycle not found');
      if (cycle.status === 'archived' && c.body?.status !== 'archived') fail(409, 'This cycle is closed');
      const data = cleanCycle(c.body, cycle);
      const err = assertValidCycle(data);
      if (err) fail(400, err);
      const before = { ...cycle };
      Object.assign(cycle, data, { updatedAt: now() });
      await db.put(K.cycle(c.org.id, cycle.id), cycle);
      await audit(c, 'goals.cycle.update', { target: cycle.id, before, after: cycle });
      if (before.status !== cycle.status) {
        await recordEvent(db, { orgId: c.org.id, actorId: c.user.id, entityType: 'goal.cycle', entityId: cycle.id, eventType: `goal.cycle.${cycle.status}`, source: 'manual', metadata: { from: before.status, to: cycle.status, name: cycle.name } });
      }
      return json({ cycle });
    });

    core.route('DELETE', '/api/goals/cycles/:id', async (c) => {
      await requireCycles(c);
      const cycle = await db.get(K.cycle(c.org.id, c.params.id));
      if (!cycle) fail(404, 'Cycle not found');
      const used = (await db.list(K.objectives(c.org.id))).some((o) => o.cycleId === cycle.id);
      if (used) fail(409, 'This cycle has objectives. Archive it instead.');
      await db.delete(K.cycle(c.org.id, cycle.id));
      await audit(c, 'goals.cycle.delete', { target: cycle.id, before: cycle });
      return json({ ok: true });
    });

    // Cycle review: final result, learnings and what happens to each objective
    // (spec §3.5). Final statuses are chosen by people, never computed.
    core.route('POST', '/api/goals/cycles/:id/close', async (c) => {
      await requireCycles(c);
      const cycle = await db.get(K.cycle(c.org.id, c.params.id));
      if (!cycle) fail(404, 'Cycle not found');
      if (cycle.status === 'archived') fail(409, 'This cycle is already closed');
      const nextCycleId = typeof c.body?.nextCycleId === 'string' ? c.body.nextCycleId : null;
      if (nextCycleId) {
        if (nextCycleId === cycle.id) fail(400, 'Carry objectives over to a different cycle');
        await checkCycle(c, nextCycleId);
      }
      const outcomes = new Map((Array.isArray(c.body?.outcomes) ? c.body.outcomes : []).map((x) => [x?.objectiveId, x]));
      const objectives = (await db.list(K.objectives(c.org.id))).filter((o) => o.cycleId === cycle.id);
      const carried = [];
      for (const o of objectives) {
        const out = outcomes.get(o.id) || {};
        const status = FINAL_STATUS.includes(out.status) ? out.status : FINAL_STATUS.includes(o.status) ? o.status : 'not_achieved';
        const destination = ['close', 'carry_over', 'archive'].includes(out.destination) ? out.destination : 'close';
        if (destination === 'carry_over' && !nextCycleId) fail(400, 'Choose the cycle that receives the carried-over objectives');
        const outcome = {
          result: String(out.result || '').slice(0, 2000),
          learnings: String(out.learnings || '').slice(0, 4000),
          destination,
          finalStatus: status,
          closedAt: now(),
          closedBy: c.user.id,
        };
        const before = { status: o.status };
        o.status = destination === 'archive' ? 'archived' : status;
        o.outcome = outcome;
        o.updatedAt = now();
        await db.put(K.objective(c.org.id, o.id), o);
        await emit(c, o, 'objective', o.id, 'goal.objective.closed', { from: before.status, to: o.status, finalStatus: status, destination });
        if (destination === 'carry_over') {
          const copy = {
            ...o,
            id: newId(),
            cycleId: nextCycleId,
            status: 'draft',
            outcome: null,
            carriedFrom: o.id,
            createdBy: c.user.id,
            createdAt: now(),
            updatedAt: now(),
          };
          await db.put(K.objective(c.org.id, copy.id), copy);
          // key results go along with their current value as the new baseline
          for (const kr of await db.list(K.krsOf(c.org.id, o.id))) {
            const nkr = { ...kr, id: newId(), objectiveId: copy.id, baseline: kr.type === 'milestone' || kr.direction === 'maintain' ? kr.baseline : kr.current ?? kr.baseline, targetHistory: [], createdAt: now(), updatedAt: now() };
            await db.put(K.kr(c.org.id, copy.id, nkr.id), nkr);
          }
          await createLink(db, { orgId: c.org.id, sourceType: ENTITY_TYPES.objective, sourceId: copy.id, targetType: ENTITY_TYPES.objective, targetId: o.id, relationshipType: 'derived_from', createdBy: c.user.id });
          await emit(c, copy, 'objective', copy.id, 'goal.objective.created', { carriedFrom: o.id });
          carried.push(copy.id);
        }
      }
      const before = { ...cycle };
      cycle.status = 'archived';
      cycle.review = {
        summary: String(c.body?.summary || '').slice(0, 4000),
        learnings: String(c.body?.learnings || '').slice(0, 4000),
        closedAt: now(),
        closedBy: c.user.id,
        carried,
      };
      cycle.updatedAt = now();
      await db.put(K.cycle(c.org.id, cycle.id), cycle);
      await audit(c, 'goals.cycle.close', { target: cycle.id, before, after: cycle });
      await recordEvent(db, { orgId: c.org.id, actorId: c.user.id, entityType: 'goal.cycle', entityId: cycle.id, eventType: 'goal.cycle.closed', source: 'manual', metadata: { name: cycle.name, objectives: objectives.length, carried: carried.length } });
      return json({ cycle, carried });
    });

    // ------------------------------------------------------------ objectives
    core.route('GET', '/api/goals/objectives', async (c) => {
      const a = await access(c);
      const q = c.url.searchParams;
      const f = { cycleId: q.get('cycleId'), scopeType: q.get('scopeType'), scopeId: q.get('scopeId'), status: q.get('status'), mine: q.get('mine') === '1' };
      const all = await db.list(K.objectives(c.org.id));
      const rows = all.filter(
        (o) =>
          canRead(c, a, o) &&
          (!f.cycleId || o.cycleId === f.cycleId) &&
          (!f.scopeType || o.scopeType === f.scopeType) &&
          (!f.scopeId || o.scopeId === f.scopeId) &&
          (!f.status || o.status === f.status) &&
          (!f.mine || involved(o, c.user.id)),
      );
      const objectives = await Promise.all(rows.map((o) => withKrs(c, o)));
      return json({ objectives: objectives.sort(byDate('createdAt')) });
    });

    core.route('POST', '/api/goals/objectives', async (c) => {
      const a = await access(c);
      const data = cleanObjective({ ownerId: c.user.id, ...c.body });
      if (!['draft', 'proposed'].includes(data.status)) data.status = 'draft';
      const err = assertValidObjective(data);
      if (err) fail(400, err);
      if (!canCreateIn(a, data.scopeType, data.scopeId)) fail(403, `You can't create objectives for this ${data.scopeType === 'org' ? 'organization' : data.scopeType}`);
      await checkScope(c, data);
      await checkCycle(c, data.cycleId);
      await checkParent(c, data, null);
      await checkPeople(c, data);
      const o = { id: newId(), orgId: c.org.id, ...data, outcome: null, createdBy: c.user.id, createdAt: now(), updatedAt: now() };
      await db.put(K.objective(c.org.id, o.id), o);
      // a retrospective's learning can become an objective (spec §5)
      const from = c.body?.derivedFrom;
      if (from && Object.hasOwn(LINK_TARGETS, from.type) && typeof from.id === 'string' && from.id) {
        await createLink(db, {
          orgId: c.org.id, sourceType: ENTITY_TYPES.objective, sourceId: o.id, targetType: from.type,
          targetId: from.id.slice(0, 200), relationshipType: 'derived_from', createdBy: c.user.id,
          metadata: { objectiveId: o.id, entity: 'objective', entityId: o.id, label: '' },
        });
      }
      await audit(c, 'goals.objective.create', { target: o.id, after: o });
      await emit(c, o, 'objective', o.id, 'goal.objective.created');
      return json({ objective: await withKrs(c, o) }, 201);
    });

    core.route('GET', '/api/goals/objectives/:id', async (c) => {
      const o = await getObjective(c, c.params.id);
      const a = await access(c);
      const [krs, initiatives, allObjectives, links] = await Promise.all([
        db.list(K.krsOf(c.org.id, o.id)),
        db.list(K.initiativesOf(c.org.id, o.id)),
        db.list(K.objectives(c.org.id)),
        listLinks(c, o),
      ]);
      const withProgress = await Promise.all(
        krs.sort((x, y) => x.createdAt.localeCompare(y.createdAt)).map(async (kr) => {
          const checkIns = (await db.list(K.checkInsOf(c.org.id, kr.id))).sort(byDate('createdAt'));
          return { ...kr, progress: progressOf(kr), checkIns, checkInDue: LIVE_STATUS.includes(o.status) && checkInDue(kr, checkIns[0]?.createdAt) };
        }),
      );
      const summary = (x) => ({ id: x.id, title: x.title, status: x.status, scopeType: x.scopeType, scopeId: x.scopeId });
      const parent = o.parentId ? allObjectives.find((x) => x.id === o.parentId) : null;
      const children = allObjectives.filter((x) => x.parentId === o.id && canRead(c, a, x)).map(summary);
      return json({
        objective: { ...o, progress: objectiveProgress(krs) },
        keyResults: withProgress,
        initiatives: initiatives.sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
        links,
        parent: parent ? (canRead(c, a, parent) ? summary(parent) : { id: parent.id, restricted: true }) : null,
        children,
        canEdit: canEdit(c, a, o),
      });
    });

    core.route('PATCH', '/api/goals/objectives/:id', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const a = await access(c);
      const data = cleanObjective(c.body || {}, o);
      const err = assertValidObjective(data);
      if (err) fail(400, err);
      // moving an objective to another scope needs the right to create there
      if ((data.scopeType !== o.scopeType || data.scopeId !== o.scopeId) && !canCreateIn(a, data.scopeType, data.scopeId)) {
        fail(403, `You can't move objectives to this ${data.scopeType === 'org' ? 'organization' : data.scopeType}`);
      }
      await checkScope(c, data);
      if (data.cycleId !== o.cycleId) await checkCycle(c, data.cycleId);
      await checkParent(c, data, o.id);
      if (data.ownerId !== o.ownerId || data.collaboratorIds.join() !== o.collaboratorIds.join() || data.scopeId !== o.scopeId) await checkPeople(c, data);
      const before = { ...o };
      Object.assign(o, data, { updatedAt: now() });
      await db.put(K.objective(c.org.id, o.id), o);
      await audit(c, 'goals.objective.update', { target: o.id, before, after: o });
      if (before.status !== o.status) {
        const published = ['draft', 'proposed'].includes(before.status) && o.status === 'active';
        await emit(c, o, 'objective', o.id, published ? 'goal.objective.published' : 'goal.objective.status_changed', { from: before.status, to: o.status });
      }
      // ownership only changes through this explicit event (spec §4)
      if (before.ownerId !== o.ownerId) await emit(c, o, 'objective', o.id, 'goal.objective.owner_changed', { from: before.ownerId, to: o.ownerId });
      const other = ['title', 'purpose', 'context', 'priority', 'dueDate', 'parentId', 'scopeId', 'collaboratorIds', 'visibility'].some((k) => JSON.stringify(before[k]) !== JSON.stringify(o[k]));
      if (other) await emit(c, o, 'objective', o.id, 'goal.objective.updated');
      return json({ objective: await withKrs(c, o) });
    });

    // Only drafts without check-ins can be deleted; everything else is
    // cancelled or archived so history stays (spec §9).
    core.route('DELETE', '/api/goals/objectives/:id', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const krs = await db.list(K.krsOf(c.org.id, o.id));
      for (const kr of krs) if ((await db.list(K.checkInsOf(c.org.id, kr.id))).length) fail(409, 'This objective has check-ins. Cancel or archive it instead.');
      if (o.status !== 'draft') fail(409, 'Only drafts can be deleted. Cancel or archive it instead.');
      if ((await db.list(K.objectives(c.org.id))).some((x) => x.parentId === o.id)) fail(409, 'Other objectives are aligned to this one');
      for (const kr of krs) await db.delete(K.kr(c.org.id, o.id, kr.id));
      for (const i of await db.list(K.initiativesOf(c.org.id, o.id))) await db.delete(K.initiative(c.org.id, o.id, i.id));
      for (const l of await listLinks(c, o)) await deleteLink(db, { orgId: c.org.id, id: l.id });
      await db.delete(K.objective(c.org.id, o.id));
      await audit(c, 'goals.objective.delete', { target: o.id, before: o });
      await emit(c, o, 'objective', o.id, 'goal.objective.deleted');
      return json({ ok: true });
    });

    // events of an objective (and its KRs/initiatives), for whoever can read it
    core.route('GET', '/api/goals/objectives/:id/history', async (c) => {
      const o = await getObjective(c, c.params.id);
      const events = (await db.list(FK.events(c.org.id))).filter((e) => e.metadata?.objectiveId === o.id).sort(byDate('occurredAt'));
      return json({ events });
    });

    // ------------------------------------------------------------ key results
    core.route('POST', '/api/goals/objectives/:id/krs', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      if (FINAL_STATUS.includes(o.status)) fail(409, 'This objective is closed');
      const data = cleanKeyResult({ ownerId: o.ownerId, ...c.body });
      if (data.current === null && data.type !== 'milestone' && data.direction !== 'maintain') data.current = data.baseline;
      const err = assertValidKeyResult(data);
      if (err) fail(400, err);
      if (data.ownerId) await checkPeople(c, { ...o, ownerId: data.ownerId, collaboratorIds: [] });
      const kr = { id: newId(), orgId: c.org.id, objectiveId: o.id, ...data, targetHistory: [], createdBy: c.user.id, createdAt: now(), updatedAt: now() };
      await db.put(K.kr(c.org.id, o.id, kr.id), kr);
      await audit(c, 'goals.kr.create', { target: kr.id, after: kr });
      await emit(c, o, 'kr', kr.id, 'goal.kr.created', { description: kr.description });
      return json({ keyResult: { ...kr, progress: progressOf(kr) } }, 201);
    });

    core.route('PATCH', '/api/goals/objectives/:id/krs/:krId', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const kr = await getKr(c, o.id, c.params.krId);
      // the current value moves through check-ins, keeping history
      const { current: _ignored, ...body } = c.body || {};
      const data = cleanKeyResult(body, kr);
      const err = assertValidKeyResult(data);
      if (err) fail(400, err);
      const changed = ['baseline', 'target', 'rangeMin', 'rangeMax', 'direction', 'unit', 'type'].filter((k) => data[k] !== kr[k]);
      const reason = String(c.body?.reason || '').trim().slice(0, 1000);
      if (changed.length && !reason) fail(400, 'Explain why the baseline/target changed');
      if (data.ownerId && data.ownerId !== kr.ownerId) await checkPeople(c, { ...o, ownerId: data.ownerId, collaboratorIds: [] });
      const before = { ...kr };
      if (changed.length) {
        kr.targetHistory = [
          ...(kr.targetHistory || []),
          { at: now(), by: c.user.id, reason, changed, before: Object.fromEntries(changed.map((k) => [k, kr[k]])), after: Object.fromEntries(changed.map((k) => [k, data[k]])) },
        ];
      }
      Object.assign(kr, data, { updatedAt: now() });
      await db.put(K.kr(c.org.id, o.id, kr.id), kr);
      await audit(c, 'goals.kr.update', { target: kr.id, before, after: kr });
      if (changed.length) await emit(c, o, 'kr', kr.id, 'goal.kr.target_changed', { changed, reason });
      else await emit(c, o, 'kr', kr.id, 'goal.kr.updated');
      return json({ keyResult: { ...kr, progress: progressOf(kr) } });
    });

    core.route('DELETE', '/api/goals/objectives/:id/krs/:krId', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const kr = await getKr(c, o.id, c.params.krId);
      if ((await db.list(K.checkInsOf(c.org.id, kr.id))).length) fail(409, 'This key result has check-ins and keeps its history');
      await db.delete(K.kr(c.org.id, o.id, kr.id));
      await audit(c, 'goals.kr.delete', { target: kr.id, before: kr });
      await emit(c, o, 'kr', kr.id, 'goal.kr.deleted', { description: kr.description });
      return json({ ok: true });
    });

    // ------------------------------------------------------------ check-ins
    // Immutable: there is no PATCH/DELETE. A correction is a new check-in.
    core.route('POST', '/api/goals/objectives/:id/krs/:krId/checkins', async (c) => {
      const o = await db.get(K.objective(c.org.id, c.params.id));
      if (!o) fail(404, 'Objective not found');
      const a = await access(c);
      if (!canRead(c, a, o)) fail(404, 'Objective not found');
      const kr = await getKr(c, o.id, c.params.krId);
      if (!canEdit(c, a, o) && kr.ownerId !== c.user.id) fail(403, "You can't check in on this key result");
      if (FINAL_STATUS.includes(o.status)) fail(409, 'This objective is closed');
      const data = cleanCheckIn(c.body, kr);
      const err = assertValidCheckIn(data, kr);
      if (err) fail(400, err);
      const ci = {
        id: newId(), orgId: c.org.id, objectiveId: o.id, krId: kr.id, ...data,
        previousValue: kr.current, authorId: c.user.id, createdAt: now(),
      };
      await db.put(K.checkIn(c.org.id, kr.id, ci.id), ci);
      const update = { updatedAt: now(), lastCheckInAt: ci.createdAt };
      if (kr.type === 'milestone') update.milestones = kr.milestones.map((m) => ({ ...m, done: data.milestonesDone.includes(m.id) }));
      else update.current = data.value;
      if (data.confidence !== null) update.confidence = data.confidence;
      await db.patch(K.kr(c.org.id, o.id, kr.id), update);
      const next = { ...kr, ...update };
      await emit(c, o, 'kr', kr.id, 'goal.checkin.created', { checkInId: ci.id, value: data.value, status: data.status, progress: progressOf(next).ratio });
      return json({ checkIn: ci, keyResult: { ...next, progress: progressOf(next) } }, 201);
    });

    // ------------------------------------------------------------ initiatives
    async function checkInitiative(c, o, data) {
      if (data.krId) await getKr(c, o.id, data.krId);
      if (data.ownerId) await checkPeople(c, { ...o, ownerId: data.ownerId, collaboratorIds: [] });
    }

    core.route('POST', '/api/goals/objectives/:id/initiatives', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const data = cleanInitiative({ ownerId: c.user.id, ...c.body });
      const err = assertValidInitiative(data);
      if (err) fail(400, err);
      await checkInitiative(c, o, data);
      const i = { id: newId(), orgId: c.org.id, objectiveId: o.id, ...data, createdBy: c.user.id, createdAt: now(), updatedAt: now() };
      await db.put(K.initiative(c.org.id, o.id, i.id), i);
      await audit(c, 'goals.initiative.create', { target: i.id, after: i });
      await emit(c, o, 'initiative', i.id, 'goal.initiative.created', { title: i.title, krId: i.krId });
      return json({ initiative: i }, 201);
    });

    core.route('PATCH', '/api/goals/objectives/:id/initiatives/:iid', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const i = await db.get(K.initiative(c.org.id, o.id, c.params.iid));
      if (!i) fail(404, 'Initiative not found');
      const data = cleanInitiative(c.body || {}, i);
      const err = assertValidInitiative(data);
      if (err) fail(400, err);
      await checkInitiative(c, o, data);
      const before = { ...i };
      Object.assign(i, data, { updatedAt: now() });
      await db.put(K.initiative(c.org.id, o.id, i.id), i);
      await audit(c, 'goals.initiative.update', { target: i.id, before, after: i });
      // finishing an initiative doesn't touch the key result (spec §3.4)
      await emit(c, o, 'initiative', i.id, before.status !== i.status ? 'goal.initiative.status_changed' : 'goal.initiative.updated', { from: before.status, to: i.status });
      return json({ initiative: i });
    });

    core.route('DELETE', '/api/goals/objectives/:id/initiatives/:iid', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const i = await db.get(K.initiative(c.org.id, o.id, c.params.iid));
      if (!i) fail(404, 'Initiative not found');
      await db.delete(K.initiative(c.org.id, o.id, i.id));
      await audit(c, 'goals.initiative.delete', { target: i.id, before: i });
      await emit(c, o, 'initiative', i.id, 'goal.initiative.deleted', { title: i.title });
      return json({ ok: true });
    });

    // ------------------------------------------------------------ links
    // Stored in the foundation's Entity Linking. Internal targets (retro
    // boards, GMUDs) keep only the id — no title is copied — and the UI
    // resolves them through the target module's API, so its permissions apply
    // on every follow (spec §9: links respect the target's permissions).
    async function listLinks(c, o) {
      const sources = [[ENTITY_TYPES.objective, o.id]];
      for (const kr of await db.list(K.krsOf(c.org.id, o.id))) sources.push([ENTITY_TYPES.kr, kr.id]);
      for (const i of await db.list(K.initiativesOf(c.org.id, o.id))) sources.push([ENTITY_TYPES.initiative, i.id]);
      const out = [];
      for (const [type, id] of sources) {
        for (const ref of await db.list(FK.linksBySource(c.org.id, type, id))) {
          const l = await db.get(FK.link(c.org.id, ref.id));
          if (l) out.push(l);
        }
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    core.route('POST', '/api/goals/objectives/:id/links', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const data = cleanLinkInput(c.body);
      const err = assertValidLink(data);
      if (err) fail(400, err);
      const entityId = data.entityId || o.id;
      if (data.entity === 'kr') await getKr(c, o.id, entityId);
      if (data.entity === 'initiative' && !(await db.get(K.initiative(c.org.id, o.id, entityId)))) fail(404, 'Initiative not found');
      if (data.entity === 'objective' && entityId !== o.id) fail(400, 'Link from this objective, one of its key results or initiatives');
      const internal = LINK_TARGETS[data.targetType].internal;
      const link = await createLink(db, {
        orgId: c.org.id,
        sourceType: ENTITY_TYPES[data.entity],
        sourceId: entityId,
        targetType: data.targetType,
        targetId: internal ? data.targetId : data.targetId || data.url,
        relationshipType: data.relationshipType,
        createdBy: c.user.id,
        metadata: { objectiveId: o.id, entity: data.entity, entityId, url: internal ? '' : data.url, label: internal ? '' : data.label },
      });
      await audit(c, 'goals.link.create', { target: link.id, after: link });
      await emit(c, o, data.entity, entityId, 'goal.link.created', { targetType: data.targetType, relationshipType: data.relationshipType });
      return json({ link }, 201);
    });

    core.route('DELETE', '/api/goals/objectives/:id/links/:linkId', async (c) => {
      const o = await getObjective(c, c.params.id, { edit: true });
      const link = await db.get(FK.link(c.org.id, c.params.linkId));
      if (!link || link.metadata?.objectiveId !== o.id) fail(404, 'Link not found');
      await deleteLink(db, { orgId: c.org.id, id: link.id });
      await audit(c, 'goals.link.delete', { target: link.id, before: link });
      await emit(c, o, link.metadata.entity || 'objective', link.sourceId, 'goal.link.deleted', { targetType: link.targetType });
      return json({ ok: true });
    });

    // ------------------------------------------------------------ reminders (in-app)
    // Owners and collaborators are reminded of due check-ins and deadlines.
    // Respects the foundation's notification preferences: a "goals" in_app
    // preference with enabled: false (eventType "goals.reminder" or "*")
    // turns them off.
    async function remindersFor(c) {
      const prefs = await db.list(FK.notifPrefsFor(c.org.id, c.user.id));
      const off = prefs.some((p) => p.module === 'goals' && p.channel === 'in_app' && !p.enabled && ['goals.reminder', '*'].includes(p.eventType));
      if (off) return [];
      const at = now();
      const soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
      const today = at.slice(0, 10);
      const out = [];
      for (const o of await db.list(K.objectives(c.org.id))) {
        if (!LIVE_STATUS.includes(o.status)) continue;
        const mineObjective = o.ownerId === c.user.id || o.collaboratorIds.includes(c.user.id);
        if (mineObjective && o.dueDate && o.dueDate <= soon) {
          out.push({ kind: o.dueDate < today ? 'overdue' : 'deadline', objectiveId: o.id, title: o.title, dueDate: o.dueDate });
        }
        for (const kr of await db.list(K.krsOf(c.org.id, o.id))) {
          if (!(mineObjective || kr.ownerId === c.user.id)) continue;
          const last = kr.lastCheckInAt || (await lastCheckIn(c.org.id, kr.id))?.createdAt;
          if (checkInDue(kr, last, at)) out.push({ kind: 'checkin', objectiveId: o.id, krId: kr.id, title: kr.description, objectiveTitle: o.title, lastCheckInAt: last || null, frequency: kr.frequency });
        }
      }
      return out;
    }

    core.route('GET', '/api/goals/reminders', async (c) => json({ reminders: await remindersFor(c) }));

    // ------------------------------------------------------------ export
    core.route('GET', '/api/goals/export', async (c) => {
      const a = await access(c);
      if (!a.can('goals:export')) fail(403, 'You need the goals:export permission');
      const cycleId = c.url.searchParams.get('cycleId');
      const rows = (await db.list(K.objectives(c.org.id))).filter((o) => canRead(c, a, o) && (!cycleId || o.cycleId === cycleId));
      const objectives = [];
      for (const o of rows) {
        const krs = await db.list(K.krsOf(c.org.id, o.id));
        objectives.push({
          ...o,
          progress: objectiveProgress(krs),
          keyResults: await Promise.all(krs.map(async (kr) => ({ ...kr, progress: progressOf(kr), checkIns: (await db.list(K.checkInsOf(c.org.id, kr.id))).sort(byDate('createdAt')) }))),
          initiatives: await db.list(K.initiativesOf(c.org.id, o.id)),
        });
      }
      await audit(c, 'goals.export', { metadata: { cycleId, count: objectives.length } });
      return json({ exportedAt: now(), cycleId: cycleId || null, objectives });
    });

    // ------------------------------------------------------------ dashboard & hooks
    return {
      dashboard: async (c) => {
        const a = await access(c);
        const all = (await db.list(K.objectives(c.org.id))).filter((o) => canRead(c, a, o));
        const mine = all.filter((o) => o.ownerId === c.user.id || o.collaboratorIds.includes(c.user.id));
        const reminders = await remindersFor(c);
        return {
          objectives: all.filter((o) => LIVE_STATUS.includes(o.status)).length,
          mine: mine.filter((o) => !FINAL_STATUS.includes(o.status)).length,
          atRisk: all.filter((o) => ['at_risk', 'off_track'].includes(o.status)).length,
          reminders: reminders.slice(0, 10),
        };
      },
      adminDashboard: async (c) => {
        const cycles = await db.list(K.cycles(c.org.id));
        const objectives = await db.list(K.objectives(c.org.id));
        const today = now().slice(0, 10);
        const overdueCycles = cycles.filter((x) => x.status !== 'archived' && x.endDate && x.endDate < today);
        return {
          onboarding: { goalsCycle: cycles.length > 0, goalsObjective: objectives.length > 0 },
          overdueCycles: overdueCycles.map(({ id, name, endDate }) => ({ id, name, endDate })),
        };
      },
      onTeamMerge: async (orgId, fromId, intoId) => {
        for (const o of await db.list(K.objectives(orgId))) {
          if (o.scopeType === 'team' && o.scopeId === fromId) await db.patch(K.objective(orgId, o.id), { scopeId: intoId });
        }
      },
      // a team with objectives in progress isn't deleted: objectives and
      // check-ins are never lost to an organizational change (spec §9)
      beforeTeamDelete: async (c, teamId) => {
        const open = (await db.list(K.objectives(c.org.id))).filter((o) => o.scopeType === 'team' && o.scopeId === teamId);
        if (open.length) fail(409, `This team has ${open.length} objective(s). Move them to another team first.`);
      },
    };
  },
});
