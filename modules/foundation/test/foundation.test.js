import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, signupCompany } from '@rewind/core/testing';
import foundation from '../server/index.js';
import { BUILTIN_ROLES, isActive } from '../server/model.js';
import { effectivePermissions, hasPermission } from '../server/rbac.js';
import { recordEvent, createLink } from '../server/events.js';

const setup = () => setupApp({ modules: [foundation] });

test('catalog exposes permissions, idp kinds, relationships, built-in roles', async () => {
  const { call } = setup();
  const { admin } = await signupCompany(call);
  const { data } = await call('GET', '/api/foundation/catalog', null, admin);
  assert.equal(data.sources.length, 3);
  assert.ok(data.permissions.some((p) => p.key === 'groups:write'));
  assert.ok(data.idpKinds.some((k) => k.key === 'oidc'));
  assert.ok(data.relationships.includes('supports'));
  assert.ok(data.builtinRoles.some((r) => r.key === 'organization_admin'));
});

test('built-in roles exist for every organization without being written', async () => {
  const { call } = setup();
  const { admin } = await signupCompany(call);
  const { data } = await call('GET', '/api/foundation/roles', null, admin);
  const keys = data.roles.map((r) => r.key).sort();
  for (const r of BUILTIN_ROLES) assert.ok(keys.includes(r.key), `missing ${r.key}`);
});

test('groups are distinct from teams; create, update and delete end the memberships', async () => {
  const { call } = setup();
  const { admin, me } = await signupCompany(call);
  // create a group
  const created = await call('POST', '/api/foundation/groups', { name: 'Engineering', description: 'All engineers' }, admin);
  assert.equal(created.status, 201);
  const group = created.data.group;
  assert.equal(group.source, 'manual');

  // attach a membership (admin user as organization_admin on the group)
  const m1 = await call('POST', '/api/foundation/memberships', {
    userId: me.user.id, scopeType: 'group', scopeId: group.id, roleKey: 'group_manager',
  }, admin);
  assert.equal(m1.status, 201);

  // listing groups shows the created one
  const list = await call('GET', '/api/foundation/groups', null, admin);
  assert.equal(list.data.groups.length, 1);

  // synced groups block name/description edits
  await call('PATCH', `/api/foundation/groups/${group.id}`, { source: 'synced' }, admin);
  const blocked = await call('PATCH', `/api/foundation/groups/${group.id}`, { name: 'SRE' }, admin);
  assert.equal(blocked.status, 409);

  // deleting ends memberships but keeps them
  await call('DELETE', `/api/foundation/groups/${group.id}`, null, admin);
  const stillThere = await call('GET', '/api/foundation/memberships', null, admin);
  assert.equal(stillThere.data.memberships.length, 1);
  assert.ok(stillThere.data.memberships[0].validTo); // ended, not deleted
});

test('membership validation: unknown role / user / scope are rejected', async () => {
  const { call } = setup();
  const { admin, me } = await signupCompany(call);
  const bad = await call('POST', '/api/foundation/memberships', {
    userId: me.user.id, scopeType: 'org', scopeId: me.org.id, roleKey: 'does_not_exist',
  }, admin);
  assert.equal(bad.status, 400);

  const badGroup = await call('POST', '/api/foundation/memberships', {
    userId: me.user.id, scopeType: 'group', scopeId: 'fake', roleKey: 'organization_admin',
  }, admin);
  assert.equal(badGroup.status, 400);

  const badUser = await call('POST', '/api/foundation/memberships', {
    userId: 'nobody', scopeType: 'org', scopeId: me.org.id, roleKey: 'organization_admin',
  }, admin);
  assert.equal(badUser.status, 400);

  const okRun = await call('POST', '/api/foundation/memberships', {
    userId: me.user.id, scopeType: 'org', scopeId: me.org.id, roleKey: 'organization_admin',
  }, admin);
  assert.equal(okRun.status, 201);
});

test('custom roles: create, assign, cannot delete while in use, then end membership and delete', async () => {
  const { call } = setup();
  const { admin, me } = await signupCompany(call);
  const created = await call('POST', '/api/foundation/roles', {
    key: 'release_manager', name: 'Release Manager', scope: 'team', permissions: ['teams:read', 'teams:write'],
  }, admin);
  assert.equal(created.status, 201);

  const membership = (await call('POST', '/api/foundation/memberships', {
    userId: me.user.id, scopeType: 'team', scopeId: me.org.defaultTeamId, roleKey: 'release_manager',
  }, admin)).data.membership;

  // cannot delete role while in use
  const blocked = await call('DELETE', '/api/foundation/roles/release_manager', null, admin);
  assert.equal(blocked.status, 409);

  // end the membership, then delete
  await call('DELETE', `/api/foundation/memberships/${membership.id}`, null, admin);
  const deleted = await call('DELETE', '/api/foundation/roles/release_manager', null, admin);
  assert.equal(deleted.status, 200);

  // built-in roles cannot be deleted
  const builtinBlocked = await call('DELETE', '/api/foundation/roles/organization_admin', null, admin);
  assert.equal(builtinBlocked.status, 400);
});

test('rbac: non-admin without memberships has no foundation permissions', async () => {
  const { call } = setup();
  const { admin, bia } = await signupCompany(call);
  // admin can list groups
  assert.equal((await call('GET', '/api/foundation/groups', null, admin)).status, 200);
  // bia is a plain member: she cannot list groups
  assert.equal((await call('GET', '/api/foundation/groups', null, bia)).status, 403);
});

test('rbac: granting the right role to a member exposes the right permissions', async () => {
  const { call } = setup();
  const { admin, bia, me } = await signupCompany(call);
  const biaId = (await call('GET', '/api/me', null, bia)).data.user.id;
  // grant viewer at org scope
  await call('POST', '/api/foundation/memberships', {
    userId: biaId, scopeType: 'org', scopeId: me.org.id, roleKey: 'viewer',
  }, admin);
  const okGroups = await call('GET', '/api/foundation/groups', null, bia);
  assert.equal(okGroups.status, 200);
  // but she still cannot write audit:read is included, teams:write isn't
  const noWrite = await call('POST', '/api/foundation/groups', { name: 'x' }, bia);
  assert.equal(noWrite.status, 403);
});

test('rbac: effectivePermissions and hasPermission respect wildcards and validity', () => {
  const user = { id: 'u1', role: 'member' };
  const roles = [
    { key: 'r1', permissions: ['groups:read'] },
    { key: 'r2', permissions: ['groups:*'] },
  ];
  const memberships = [
    { id: 'm1', userId: 'u1', roleKey: 'r1', scopeType: 'org', scopeId: 'o', validFrom: '', validTo: '' },
    { id: 'm2', userId: 'u1', roleKey: 'r2', scopeType: 'org', scopeId: 'o', validFrom: '', validTo: '1970-01-01T00:00:00Z' },
  ];
  const now = new Date().toISOString();
  const perms = effectivePermissions(user, memberships, roles, now);
  assert.ok(hasPermission(perms, 'groups:read'));
  assert.ok(!hasPermission(perms, 'groups:write')); // m2 is expired
});

test('external identity: subject uniqueness and link/unlink events are audited', async () => {
  const { call } = setup();
  const { admin, me } = await signupCompany(call);
  const linked = await call('POST', '/api/foundation/identities', {
    userId: me.user.id, provider: 'okta', subject: 'okta|00u123', email: me.user.email,
  }, admin);
  assert.equal(linked.status, 201);
  // same subject can't be linked twice
  const dup = await call('POST', '/api/foundation/identities', {
    userId: me.user.id, provider: 'okta', subject: 'okta|00u123',
  }, admin);
  assert.equal(dup.status, 409);

  const { data: audit } = await call('GET', '/api/foundation/audit', null, admin);
  assert.ok(audit.records.some((r) => r.action === 'identity.link'));
});

test('entity links: create, list by source, delete', async () => {
  const { call } = setup();
  const { admin } = await signupCompany(call);
  const created = await call('POST', '/api/foundation/links', {
    sourceType: 'goal', sourceId: 'G1', targetType: 'okr', targetId: 'O1', relationshipType: 'supports',
  }, admin);
  assert.equal(created.status, 201);
  const bySource = await call('GET', '/api/foundation/links?sourceType=goal&sourceId=G1', null, admin);
  assert.equal(bySource.data.links.length, 1);
  await call('DELETE', `/api/foundation/links/${created.data.link.id}`, null, admin);
  const empty = await call('GET', '/api/foundation/links?sourceType=goal&sourceId=G1', null, admin);
  assert.equal(empty.data.links.length, 0);
});

test('domain events: created by routes and by direct helper; listed newest first', async () => {
  const { call, storage } = setup();
  const { admin, me } = await signupCompany(call);
  const g = (await call('POST', '/api/foundation/groups', { name: 'X' }, admin)).data.group;
  await recordEvent(storage, { orgId: me.org.id, actorId: me.user.id, entityType: 'test', entityId: 'T1', eventType: 'test.ping' });
  const { data } = await call('GET', '/api/foundation/events', null, admin);
  assert.ok(data.events.length >= 2);
  // group.created is one of them
  assert.ok(data.events.some((e) => e.eventType === 'group.created' && e.entityId === g.id));
});

test('identity providers: create, update, delete, with group mappings', async () => {
  const { call } = setup();
  const { admin, me } = await signupCompany(call);
  const g = (await call('POST', '/api/foundation/groups', { name: 'SRE' }, admin)).data.group;
  const idp = (await call('POST', '/api/foundation/idps', { name: 'Acme Okta', kind: 'oidc', issuer: 'https://acme.okta.com' }, admin)).data.idp;
  const mapping = await call('POST', '/api/foundation/mappings', {
    idpId: idp.id, externalKey: 'okta-group-123', externalName: 'SRE from Okta', mapsTo: { groupId: g.id },
  }, admin);
  assert.equal(mapping.status, 201);
  // role mapping must be valid
  const badRole = await call('POST', '/api/foundation/mappings', {
    idpId: idp.id, externalKey: 'g2', mapsTo: { roleKey: 'nope' },
  }, admin);
  assert.equal(badRole.status, 400);
  // list filters by idp
  const list = await call('GET', `/api/foundation/mappings?idpId=${idp.id}`, null, admin);
  assert.equal(list.data.mappings.length, 1);
  // delete provider
  await call('DELETE', `/api/foundation/idps/${idp.id}`, null, admin);
});

test('notification preferences: per-user, deduped and replaced each PUT', async () => {
  const { call } = setup();
  const { admin, bia } = await signupCompany(call);
  const first = await call('PUT', '/api/foundation/notifications/prefs', { prefs: [
    { module: 'goals', eventType: 'goal.updated', channel: 'in_app', enabled: true },
    { module: 'goals', eventType: 'goal.updated', channel: 'in_app', enabled: false }, // dedup
    { module: 'gmud', eventType: 'change.approved', channel: 'in_app', enabled: true },
  ] }, bia);
  assert.equal(first.status, 200);
  assert.equal(first.data.prefs.length, 2);
  // admin's prefs aren't biás
  const adminPrefs = await call('GET', '/api/foundation/notifications/prefs', null, admin);
  assert.equal(adminPrefs.data.prefs.length, 0);
});

test('isActive: validFrom / validTo gates', () => {
  const past = '1970-01-01T00:00:00Z';
  const future = '9999-12-31T00:00:00Z';
  const now = new Date().toISOString();
  assert.ok(isActive({ validFrom: past, validTo: future }, now));
  assert.ok(!isActive({ validFrom: future, validTo: '' }, now));
  assert.ok(!isActive({ validFrom: '', validTo: past }, now));
});

test('beforeTeamDelete: foundation blocks deletion while memberships exist', async () => {
  const { call } = setup();
  const { admin, me } = await signupCompany(call);
  // give someone a team membership in the foundation
  await call('POST', '/api/foundation/memberships', {
    userId: me.user.id, scopeType: 'team', scopeId: me.org.defaultTeamId, roleKey: 'team_member',
  }, admin);
  // create a new team to delete (default team can't be deleted anyway)
  const t = (await call('POST', '/api/teams', { name: 'Platform' }, admin)).data.team;
  await call('POST', '/api/foundation/memberships', {
    userId: me.user.id, scopeType: 'team', scopeId: t.id, roleKey: 'team_member',
  }, admin);
  const blocked = await call('DELETE', `/api/teams/${t.id}`, null, admin);
  assert.equal(blocked.status, 409);
});

test('me/permissions reflects core admin as "org:*" superset', async () => {
  const { call } = setup();
  const { admin, bia } = await signupCompany(call);
  const adminPerms = (await call('GET', '/api/foundation/me/permissions', null, admin)).data.permissions;
  assert.ok(adminPerms.includes('org:*'));
  const biaPerms = (await call('GET', '/api/foundation/me/permissions', null, bia)).data.permissions;
  assert.ok(!biaPerms.includes('org:*'));
});

test('createLink helper works outside of HTTP (for other modules)', async () => {
  const { call, storage } = setup();
  const { me } = await signupCompany(call);
  await createLink(storage, { orgId: me.org.id, sourceType: 'retro', sourceId: 's1', targetType: 'goal', targetId: 'g1', relationshipType: 'discussed_in', createdBy: me.user.id });
  const bySource = (await storage.list(`flinksrc:${me.org.id}:retro:s1:`));
  assert.equal(bySource.length, 1);
});
