// @rewind/foundation — the transversal foundation of the platform (spec:
// 00-fundacao-transversal.md). It owns the richer identity, authorization,
// linking and event capabilities that other modules share, without any module
// depending on another:
//
//   Group (distinct from Team), Membership, Role, ExternalIdentity,
//   IdentityProvider, ExternalGroupMapping, SyncRun, ProvisioningEvent,
//   EntityReference, DomainEvent, AuditRecord, NotificationPreference.
//
// Storage keys live in ./events.js (the K map) and are routed to the company's
// Durable Object (the SHARDS map). The core keeps people, companies and teams
// untouched; the foundation reads them through the services it is given.

import { defineModule, fail, json, newId, now, str } from '@rewind/core';
import {
  BUILTIN_ROLES, IDP_KINDS, PERMISSIONS, RELATIONSHIPS, SCOPE_TYPES, SOURCES,
  assertValidGroup, assertValidMembership, assertValidRole, cleanGroup,
  cleanIdentity, cleanIdp, cleanLink, cleanMapping, cleanMembership,
  cleanNotificationPref, cleanRole, isActive,
} from './model.js';
import { effectivePermissions, ensureBuiltinRoles, hasPermission } from './rbac.js';
import { K, SHARDS, createLink, deleteLink, recordAudit, recordEvent } from './events.js';

const sameSource = (a, b) => (a.source || 'manual') === b;

export default defineModule({
  id: 'foundation',
  name: 'Foundation',
  description: 'Transversal foundation: groups, memberships, roles, identity providers, external identities, entity links, domain events, audit log and notification preferences shared by every module.',
  // Required: every module can rely on it being there.
  required: true,
  keyPrefixes: ['fgrp:', 'frole:', 'fmbr:', 'fident:', 'fidsub:', 'fidp:', 'fmap:', 'fsync:', 'flink:', 'flinksrc:', 'fevt:', 'faudit:', 'fnotif:'],
  shards: SHARDS,
  register(core) {
    const { db, isAdmin, requireAdmin, listUsers, listTeams } = core;

    // ---------------------------------------------------------------- helpers
    async function loadRoles(orgId) {
      const saved = await db.list(K.roles(orgId));
      return ensureBuiltinRoles(saved);
    }

    async function loadMemberships(orgId) {
      return db.list(K.memberships(orgId));
    }

    async function effectiveForUser(c) {
      const roles = await loadRoles(c.org.id);
      const memberships = await loadMemberships(c.org.id);
      return effectivePermissions(c.user, memberships, roles);
    }

    async function require(c, permission) {
      if (isAdmin(c)) return; // core admins keep org:* (see rbac.js)
      const perms = await effectiveForUser(c);
      if (!hasPermission(perms, permission)) fail(403, `You don't have permission: ${permission}`);
    }

    async function audit(c, action, extra = {}) {
      return recordAudit(db, { orgId: c.org.id, actorId: c.user.id, action, ...extra });
    }

    async function emit(c, entityType, entityId, eventType, metadata = {}) {
      return recordEvent(db, { orgId: c.org.id, actorId: c.user.id, entityType, entityId, eventType, source: 'manual', metadata });
    }

    // ---------------------------------------------------------------- catalog
    core.route('GET', '/api/foundation/catalog', async () =>
      json({
        permissions: PERMISSIONS,
        idpKinds: IDP_KINDS,
        relationships: RELATIONSHIPS,
        sources: SOURCES,
        scopeTypes: SCOPE_TYPES,
        builtinRoles: BUILTIN_ROLES,
      }),
    );

    core.route('GET', '/api/foundation/me/permissions', async (c) => {
      const perms = await effectiveForUser(c);
      return json({ permissions: [...perms].sort(), coreRole: c.user.role });
    });

    // ---------------------------------------------------------------- groups
    core.route('GET', '/api/foundation/groups', async (c) => {
      await require(c, 'groups:read');
      const groups = await db.list(K.groups(c.org.id));
      return json({ groups: groups.sort((a, b) => a.name.localeCompare(b.name)) });
    });

    core.route('POST', '/api/foundation/groups', async (c) => {
      requireAdmin(c);
      const data = cleanGroup(c.body);
      const err = assertValidGroup(data);
      if (err) fail(400, err);
      const group = { id: newId(), orgId: c.org.id, ...data, createdAt: now(), updatedAt: now() };
      await db.put(K.group(c.org.id, group.id), group);
      await audit(c, 'group.create', { target: group.id, after: group });
      await emit(c, 'group', group.id, 'group.created', { name: group.name });
      return json({ group }, 201);
    });

    core.route('GET', '/api/foundation/groups/:id', async (c) => {
      await require(c, 'groups:read');
      const group = await db.get(K.group(c.org.id, c.params.id));
      if (!group) fail(404, 'Group not found');
      const memberships = (await loadMemberships(c.org.id)).filter((m) => m.scopeType === 'group' && m.scopeId === group.id);
      return json({ group, memberships });
    });

    core.route('PATCH', '/api/foundation/groups/:id', async (c) => {
      requireAdmin(c);
      const group = await db.get(K.group(c.org.id, c.params.id));
      if (!group) fail(404, 'Group not found');
      const data = cleanGroup(c.body, group);
      // synced groups: name/description belong to the provider (spec §2.3).
      if (group.source === 'synced' && (data.name !== group.name || data.description !== group.description)) {
        fail(409, 'Name and description of a synced group are managed by the identity provider');
      }
      const err = assertValidGroup(data);
      if (err) fail(400, err);
      const before = { ...group };
      Object.assign(group, data, { updatedAt: now() });
      await db.put(K.group(c.org.id, group.id), group);
      await audit(c, 'group.update', { target: group.id, before, after: group });
      await emit(c, 'group', group.id, 'group.updated');
      return json({ group });
    });

    core.route('DELETE', '/api/foundation/groups/:id', async (c) => {
      requireAdmin(c);
      const group = await db.get(K.group(c.org.id, c.params.id));
      if (!group) fail(404, 'Group not found');
      // end every membership of this group's scope but don't delete them:
      // encerrar vigência preserves history (spec §6).
      const atEnd = now();
      for (const m of await loadMemberships(c.org.id)) {
        if (m.scopeType === 'group' && m.scopeId === group.id && !m.validTo) {
          await db.patch(K.membership(c.org.id, m.id), { validTo: atEnd });
        }
      }
      await db.delete(K.group(c.org.id, group.id));
      await audit(c, 'group.delete', { target: group.id, before: group });
      await emit(c, 'group', group.id, 'group.deleted', { name: group.name });
      return json({ ok: true });
    });

    // ---------------------------------------------------------------- memberships
    core.route('GET', '/api/foundation/memberships', async (c) => {
      await require(c, 'members:read');
      const all = await loadMemberships(c.org.id);
      const userId = c.url.searchParams.get('userId');
      const scopeType = c.url.searchParams.get('scopeType');
      const scopeId = c.url.searchParams.get('scopeId');
      const active = c.url.searchParams.get('active');
      const at = now();
      const out = all.filter((m) =>
        (!userId || m.userId === userId) &&
        (!scopeType || m.scopeType === scopeType) &&
        (!scopeId || m.scopeId === scopeId) &&
        (active !== 'true' || isActive(m, at)),
      );
      return json({ memberships: out });
    });

    core.route('POST', '/api/foundation/memberships', async (c) => {
      requireAdmin(c);
      const data = cleanMembership(c.body);
      const [roles, users, groups, teams] = await Promise.all([
        loadRoles(c.org.id), listUsers(c.org.id), db.list(K.groups(c.org.id)), listTeams(c.org.id),
      ]);
      const err = assertValidMembership(data, {
        orgId: c.org.id,
        roles: new Set(roles.map((r) => r.key)),
        users: new Set(users.map((u) => u.id)),
        groups: new Set(groups.map((g) => g.id)),
        teams: new Set(teams.map((t) => t.id)),
      });
      if (err) fail(400, err);
      const m = { id: newId(), orgId: c.org.id, ...data, createdAt: now() };
      await db.put(K.membership(c.org.id, m.id), m);
      await audit(c, 'membership.create', { target: m.id, after: m });
      await emit(c, 'membership', m.id, 'membership.created', { userId: m.userId, scopeType: m.scopeType, scopeId: m.scopeId, roleKey: m.roleKey });
      return json({ membership: m }, 201);
    });

    core.route('PATCH', '/api/foundation/memberships/:id', async (c) => {
      requireAdmin(c);
      const current = await db.get(K.membership(c.org.id, c.params.id));
      if (!current) fail(404, 'Membership not found');
      // manual memberships are never removed by sync, unless política explícita
      // (spec §8). The sync loop will call this path; a plain admin call stays
      // 'manual'.
      const data = cleanMembership({ ...current, ...c.body }, current);
      if (data.source === 'synced' && current.source === 'manual' && c.body.source !== 'synced') data.source = 'manual';
      const roles = new Set((await loadRoles(c.org.id)).map((r) => r.key));
      if (!roles.has(data.roleKey)) fail(400, 'Unknown role');
      const before = { ...current };
      Object.assign(current, data);
      await db.put(K.membership(c.org.id, current.id), current);
      await audit(c, 'membership.update', { target: current.id, before, after: current });
      await emit(c, 'membership', current.id, 'membership.updated');
      return json({ membership: current });
    });

    // DELETE encerra a vigência (preserves history, spec §6).
    core.route('DELETE', '/api/foundation/memberships/:id', async (c) => {
      requireAdmin(c);
      const m = await db.get(K.membership(c.org.id, c.params.id));
      if (!m) fail(404, 'Membership not found');
      const before = { ...m };
      m.validTo = now();
      await db.put(K.membership(c.org.id, m.id), m);
      await audit(c, 'membership.end', { target: m.id, before, after: m });
      await emit(c, 'membership', m.id, 'membership.ended');
      return json({ membership: m });
    });

    // ---------------------------------------------------------------- roles
    core.route('GET', '/api/foundation/roles', async (c) => {
      await require(c, 'roles:read');
      return json({ roles: await loadRoles(c.org.id) });
    });

    core.route('POST', '/api/foundation/roles', async (c) => {
      requireAdmin(c);
      const data = cleanRole(c.body);
      const existing = await loadRoles(c.org.id);
      const err = assertValidRole(data, { existingKeys: new Set(existing.map((r) => r.key)) });
      if (err) fail(400, err);
      const role = { ...data, orgId: c.org.id, builtin: false, createdAt: now() };
      await db.put(K.role(c.org.id, role.key), role);
      await audit(c, 'role.create', { target: role.key, after: role });
      return json({ role }, 201);
    });

    core.route('PATCH', '/api/foundation/roles/:key', async (c) => {
      requireAdmin(c);
      const saved = await db.get(K.role(c.org.id, c.params.key));
      const builtin = BUILTIN_ROLES.find((r) => r.key === c.params.key);
      const current = saved || builtin;
      if (!current) fail(404, 'Role not found');
      // Built-in roles can have their name/description/permissions overridden
      // per organization; the key and "builtin" flag stay.
      const next = cleanRole({ ...current, ...c.body, key: current.key }, current);
      const role = { ...current, ...next, orgId: c.org.id, builtin: Boolean(current.builtin) };
      await db.put(K.role(c.org.id, role.key), role);
      await audit(c, 'role.update', { target: role.key, before: current, after: role });
      return json({ role });
    });

    core.route('DELETE', '/api/foundation/roles/:key', async (c) => {
      requireAdmin(c);
      const builtin = BUILTIN_ROLES.find((r) => r.key === c.params.key);
      if (builtin) fail(400, "Built-in roles can't be deleted (edit them to adjust permissions)");
      const saved = await db.get(K.role(c.org.id, c.params.key));
      if (!saved) fail(404, 'Role not found');
      // block deletion when a membership still references it
      const inUse = (await loadMemberships(c.org.id)).some((m) => m.roleKey === saved.key && !m.validTo);
      if (inUse) fail(409, 'This role is assigned to one or more memberships; end those first');
      await db.delete(K.role(c.org.id, saved.key));
      await audit(c, 'role.delete', { target: saved.key, before: saved });
      return json({ ok: true });
    });

    core.route('GET', '/api/foundation/permissions', async (c) => {
      await require(c, 'roles:read');
      return json({ permissions: PERMISSIONS });
    });

    // ---------------------------------------------------------------- identity providers
    core.route('GET', '/api/foundation/idps', async (c) => {
      await require(c, 'idp:read');
      const idps = await db.list(K.idps(c.org.id));
      return json({ idps, kinds: IDP_KINDS });
    });

    core.route('POST', '/api/foundation/idps', async (c) => {
      requireAdmin(c);
      const data = cleanIdp(c.body);
      if (!data.name) fail(400, 'Enter a name for this identity provider');
      const idp = { id: newId(), orgId: c.org.id, ...data, createdAt: now(), updatedAt: now() };
      await db.put(K.idp(c.org.id, idp.id), idp);
      await audit(c, 'idp.create', { target: idp.id, after: idp });
      return json({ idp }, 201);
    });

    core.route('PATCH', '/api/foundation/idps/:id', async (c) => {
      requireAdmin(c);
      const saved = await db.get(K.idp(c.org.id, c.params.id));
      if (!saved) fail(404, 'Identity provider not found');
      const data = cleanIdp({ ...saved, ...c.body }, saved);
      const idp = { ...saved, ...data, updatedAt: now() };
      await db.put(K.idp(c.org.id, idp.id), idp);
      await audit(c, 'idp.update', { target: idp.id, before: saved, after: idp });
      return json({ idp });
    });

    core.route('DELETE', '/api/foundation/idps/:id', async (c) => {
      requireAdmin(c);
      const saved = await db.get(K.idp(c.org.id, c.params.id));
      if (!saved) fail(404, 'Identity provider not found');
      // revoking a connector: the admin decides what to do with synced
      // memberships (spec §3.5). Here we leave synced memberships alone and
      // only remove the connector; a future route will offer the three paths
      // (preserve / convert to manual / remove).
      await db.delete(K.idp(c.org.id, saved.id));
      await audit(c, 'idp.delete', { target: saved.id, before: saved });
      return json({ ok: true });
    });

    // ---------------------------------------------------------------- group mappings
    core.route('GET', '/api/foundation/mappings', async (c) => {
      await require(c, 'idp:read');
      const mappings = await db.list(K.mappings(c.org.id));
      const idpId = c.url.searchParams.get('idpId');
      return json({ mappings: idpId ? mappings.filter((m) => m.idpId === idpId) : mappings });
    });

    core.route('POST', '/api/foundation/mappings', async (c) => {
      requireAdmin(c);
      const data = cleanMapping(c.body);
      if (!data.idpId || !data.externalKey) fail(400, 'idpId and externalKey are required');
      if (!(await db.get(K.idp(c.org.id, data.idpId)))) fail(400, 'Unknown identity provider');
      const groups = new Set((await db.list(K.groups(c.org.id))).map((g) => g.id));
      const teams = new Set((await listTeams(c.org.id)).map((t) => t.id));
      const roles = new Set((await loadRoles(c.org.id)).map((r) => r.key));
      if (data.mapsTo.groupId && !groups.has(data.mapsTo.groupId)) fail(400, 'Unknown group');
      if (data.mapsTo.teamId && !teams.has(data.mapsTo.teamId)) fail(400, 'Unknown team');
      if (data.mapsTo.roleKey && !roles.has(data.mapsTo.roleKey)) fail(400, 'Unknown role');
      // "grupo externo → role" must be explicit, visible, auditable (spec §4.1).
      const mapping = { id: newId(), orgId: c.org.id, ...data, createdAt: now() };
      await db.put(K.mapping(c.org.id, mapping.id), mapping);
      await audit(c, 'mapping.create', { target: mapping.id, after: mapping });
      return json({ mapping }, 201);
    });

    core.route('DELETE', '/api/foundation/mappings/:id', async (c) => {
      requireAdmin(c);
      const saved = await db.get(K.mapping(c.org.id, c.params.id));
      if (!saved) fail(404, 'Mapping not found');
      await db.delete(K.mapping(c.org.id, saved.id));
      await audit(c, 'mapping.delete', { target: saved.id, before: saved });
      return json({ ok: true });
    });

    // ---------------------------------------------------------------- external identities
    // The provider's immutable subject is the key, not the e-mail (spec §3.4).
    core.route('GET', '/api/foundation/identities', async (c) => {
      await require(c, 'members:read');
      const identities = await db.list(K.identities(c.org.id));
      const userId = c.url.searchParams.get('userId');
      return json({ identities: userId ? identities.filter((i) => i.userId === userId) : identities });
    });

    core.route('POST', '/api/foundation/identities', async (c) => {
      requireAdmin(c);
      const data = cleanIdentity(c.body);
      if (!data.userId || !data.provider || !data.subject) fail(400, 'userId, provider and subject are required');
      const users = new Set((await listUsers(c.org.id)).map((u) => u.id));
      if (!users.has(data.userId)) fail(400, 'Unknown user');
      const existing = await db.get(K.identityBySubject(c.org.id, data.provider, data.subject));
      if (existing) fail(409, 'This external identity is already linked to a user on this organization');
      const identity = { id: newId(), orgId: c.org.id, ...data, createdAt: now(), lastSeenAt: null };
      await db.put(K.identity(c.org.id, identity.id), identity);
      await db.put(K.identityBySubject(c.org.id, identity.provider, identity.subject), { id: identity.id, userId: identity.userId });
      await audit(c, 'identity.link', { target: identity.id, after: identity });
      await emit(c, 'identity', identity.id, 'identity.linked', { userId: identity.userId, provider: identity.provider });
      return json({ identity }, 201);
    });

    core.route('DELETE', '/api/foundation/identities/:id', async (c) => {
      requireAdmin(c);
      const identity = await db.get(K.identity(c.org.id, c.params.id));
      if (!identity) fail(404, 'External identity not found');
      await db.delete(K.identity(c.org.id, identity.id));
      await db.delete(K.identityBySubject(c.org.id, identity.provider, identity.subject));
      await audit(c, 'identity.unlink', { target: identity.id, before: identity });
      await emit(c, 'identity', identity.id, 'identity.unlinked');
      return json({ ok: true });
    });

    // ---------------------------------------------------------------- sync runs (read-only here)
    // Writing SyncRuns is driven by a connector module (future work). We expose
    // the read surface already so the admin UI has something to render.
    core.route('GET', '/api/foundation/sync-runs', async (c) => {
      await require(c, 'idp:read');
      const runs = (await db.list(K.syncRuns(c.org.id))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return json({ runs });
    });

    core.route('GET', '/api/foundation/sync-runs/:id', async (c) => {
      await require(c, 'idp:read');
      const run = await db.get(K.syncRun(c.org.id, c.params.id));
      if (!run) fail(404, 'Sync run not found');
      const events = await db.list(K.provisioningFor(c.org.id, run.id));
      return json({ run, provisioning: events });
    });

    // ---------------------------------------------------------------- entity links
    core.route('GET', '/api/foundation/links', async (c) => {
      await require(c, 'links:read');
      const sourceType = c.url.searchParams.get('sourceType');
      const sourceId = c.url.searchParams.get('sourceId');
      if (sourceType && sourceId) {
        const refs = await db.list(K.linksBySource(c.org.id, sourceType, sourceId));
        const links = await Promise.all(refs.map((r) => db.get(K.link(c.org.id, r.id))));
        return json({ links: links.filter(Boolean) });
      }
      return json({ links: await db.list(K.links(c.org.id)) });
    });

    core.route('POST', '/api/foundation/links', async (c) => {
      await require(c, 'links:write');
      const data = cleanLink(c.body);
      if (!data.sourceType || !data.sourceId || !data.targetType || !data.targetId) fail(400, 'Source and target are required');
      const link = await createLink(db, { orgId: c.org.id, ...data, createdBy: c.user.id });
      await audit(c, 'link.create', { target: link.id, after: link });
      await emit(c, 'link', link.id, 'link.created', { sourceType: link.sourceType, sourceId: link.sourceId, targetType: link.targetType, targetId: link.targetId, relationshipType: link.relationshipType });
      return json({ link }, 201);
    });

    core.route('DELETE', '/api/foundation/links/:id', async (c) => {
      await require(c, 'links:write');
      const existed = await db.get(K.link(c.org.id, c.params.id));
      const ok = await deleteLink(db, { orgId: c.org.id, id: c.params.id });
      if (!ok) fail(404, 'Link not found');
      await audit(c, 'link.delete', { target: c.params.id, before: existed });
      return json({ ok: true });
    });

    // ---------------------------------------------------------------- domain events
    core.route('GET', '/api/foundation/events', async (c) => {
      await require(c, 'events:read');
      const events = (await db.list(K.events(c.org.id))).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      const entityType = c.url.searchParams.get('entityType');
      const entityId = c.url.searchParams.get('entityId');
      const limit = Math.min(500, Number(c.url.searchParams.get('limit')) || 100);
      const filtered = events.filter((e) =>
        (!entityType || e.entityType === entityType) &&
        (!entityId || e.entityId === entityId),
      ).slice(0, limit);
      return json({ events: filtered });
    });

    core.route('POST', '/api/foundation/events', async (c) => {
      // modules write events via events.js; the HTTP endpoint lets integrations
      // record events too (manual source). Admins only.
      requireAdmin(c);
      const entityType = str(c.body?.entityType, 60);
      const entityId = str(c.body?.entityId, 120);
      const eventType = str(c.body?.eventType, 120);
      if (!entityType || !entityId || !eventType) fail(400, 'entityType, entityId and eventType are required');
      const event = await recordEvent(db, {
        orgId: c.org.id, actorId: c.user.id, entityType, entityId, eventType,
        source: 'manual', metadata: c.body?.metadata && typeof c.body.metadata === 'object' ? c.body.metadata : {},
      });
      return json({ event }, 201);
    });

    // ---------------------------------------------------------------- audit log
    core.route('GET', '/api/foundation/audit', async (c) => {
      await require(c, 'audit:read');
      const records = (await db.list(K.audits(c.org.id))).sort((a, b) => b.at.localeCompare(a.at));
      const limit = Math.min(500, Number(c.url.searchParams.get('limit')) || 100);
      return json({ records: records.slice(0, limit) });
    });

    // ---------------------------------------------------------------- notification preferences
    core.route('GET', '/api/foundation/notifications/prefs', async (c) => {
      const prefs = await db.list(K.notifPrefsFor(c.org.id, c.user.id));
      return json({ prefs });
    });

    core.route('PUT', '/api/foundation/notifications/prefs', async (c) => {
      const incoming = Array.isArray(c.body?.prefs) ? c.body.prefs : [];
      // Replace the full set each time: simpler and keeps the user's prefs
      // self-consistent. Deduplicate by (module, eventType, channel).
      const dedup = new Map();
      for (const raw of incoming) {
        const clean = cleanNotificationPref(raw);
        if (!clean.eventType) continue;
        dedup.set(`${clean.module}|${clean.eventType}|${clean.channel}`, clean);
      }
      const existing = await db.list(K.notifPrefsFor(c.org.id, c.user.id));
      for (const e of existing) await db.delete(K.notifPref(c.org.id, c.user.id, e.id));
      const saved = [];
      for (const pref of dedup.values()) {
        const row = { id: newId(), orgId: c.org.id, userId: c.user.id, ...pref, updatedAt: now() };
        await db.put(K.notifPref(c.org.id, c.user.id, row.id), row);
        saved.push(row);
      }
      return json({ prefs: saved });
    });

    // ---------------------------------------------------------------- bulk directory view
    // One call that returns everything an admin screen needs (groups, teams,
    // users, memberships, roles) — the admin UI uses it to render the whole
    // directory at once without fan-out.
    core.route('GET', '/api/foundation/directory', async (c) => {
      await require(c, 'members:read');
      const [groups, memberships, roles, users, teams] = await Promise.all([
        db.list(K.groups(c.org.id)),
        loadMemberships(c.org.id),
        loadRoles(c.org.id),
        listUsers(c.org.id),
        listTeams(c.org.id),
      ]);
      const slim = users.map(({ id, name, email, avatar, role, teamIds }) => ({ id, name, email, avatar, role, teamIds }));
      return json({ groups, memberships, roles, users: slim, teams });
    });

    // ---------------------------------------------------------------- dashboard
    return {
      dashboard: async (c) => {
        const [groups, memberships] = await Promise.all([db.list(K.groups(c.org.id)), loadMemberships(c.org.id)]);
        const mine = memberships.filter((m) => m.userId === c.user.id && isActive(m, now()));
        return { groups: groups.length, myMemberships: mine.length };
      },
      adminDashboard: async (c) => {
        const [groups, idps, runs] = await Promise.all([
          db.list(K.groups(c.org.id)),
          db.list(K.idps(c.org.id)),
          db.list(K.syncRuns(c.org.id)),
        ]);
        const lastRun = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null;
        return {
          onboarding: {
            foundationGroups: groups.length > 0,
            foundationIdp: idps.length > 0,
          },
          counts: { groups: groups.length, idps: idps.length },
          lastSync: lastRun && { id: lastRun.id, status: lastRun.status, at: lastRun.startedAt },
        };
      },
      // Keep groups in step when a team is merged: mappings that pointed to
      // the removed team move to the remaining team.
      onTeamMerge: async (orgId, fromId, intoId) => {
        for (const m of await db.list(K.mappings(orgId))) {
          if (m.mapsTo?.teamId === fromId) {
            await db.patch(K.mapping(orgId, m.id), { mapsTo: { ...m.mapsTo, teamId: intoId } });
          }
        }
        for (const m of await db.list(K.memberships(orgId))) {
          if (m.scopeType === 'team' && m.scopeId === fromId) {
            await db.patch(K.membership(orgId, m.id), { scopeId: intoId });
          }
        }
      },
      // Block deleting a team that has memberships — the admin must end them
      // explicitly (spec §6: encerrar vigência over deleting).
      beforeTeamDelete: async (c, teamId) => {
        const active = (await loadMemberships(c.org.id)).filter((m) => m.scopeType === 'team' && m.scopeId === teamId && !m.validTo);
        if (active.length) fail(409, `This team still has ${active.length} active membership(s) in the foundation. End them first.`);
      },
    };
  },
});
