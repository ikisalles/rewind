// Data shapes and validation for the foundation module. No I/O here.
//
// The foundation owns these entities (see the Fundação Transversal spec):
//   Group, Membership, Role, ExternalIdentity, IdentityProvider,
//   ExternalGroupMapping, SyncRun, ProvisioningEvent, EntityReference,
//   DomainEvent, AuditRecord, NotificationPreference.
//
// A Group organizes people; a Team represents a unit of work used by other
// modules (teams stay in @rewind/core). Memberships record the vínculo between
// a person and a scope (organization/group/team) with a role and vigência.

import { str } from '@rewind/core';

export const SOURCES = ['manual', 'synced', 'hybrid'];
export const SCOPE_TYPES = ['org', 'group', 'team'];

// Built-in roles, in the order of the spec (§4.1). The key is stable; the name
// can be edited per organization. "builtin: true" marks roles that can't be
// deleted — custom roles can be created on top.
export const BUILTIN_ROLES = [
  { key: 'organization_owner', name: 'Organization Owner', scope: 'org', builtin: true, permissions: ['org:*'] },
  { key: 'organization_admin', name: 'Organization Admin', scope: 'org', builtin: true, permissions: ['org:read', 'org:write', 'members:read', 'members:write', 'groups:read', 'groups:write', 'teams:read', 'teams:write', 'roles:read', 'roles:write', 'idp:read', 'idp:write', 'audit:read'] },
  { key: 'group_manager', name: 'Group Manager', scope: 'group', builtin: true, permissions: ['groups:read', 'groups:write', 'members:read'] },
  { key: 'team_manager', name: 'Team Manager', scope: 'team', builtin: true, permissions: ['teams:read', 'teams:write', 'members:read'] },
  { key: 'team_member', name: 'Team Member', scope: 'team', builtin: true, permissions: ['teams:read'] },
  { key: 'viewer', name: 'Viewer', scope: 'org', builtin: true, permissions: ['org:read', 'members:read', 'groups:read', 'teams:read'] },
  { key: 'module_admin', name: 'Module Admin', scope: 'org', builtin: true, permissions: ['module:admin'] },
];

// Permission catalog the UI shows when editing custom roles. The convention is
// "<resource>:<action>" with "*" matching any action.
export const PERMISSIONS = [
  { key: 'org:read', label: 'Read organization details' },
  { key: 'org:write', label: 'Edit organization details' },
  { key: 'members:read', label: 'See members' },
  { key: 'members:write', label: 'Manage members' },
  { key: 'groups:read', label: 'See groups' },
  { key: 'groups:write', label: 'Manage groups' },
  { key: 'teams:read', label: 'See teams' },
  { key: 'teams:write', label: 'Manage teams' },
  { key: 'roles:read', label: 'See roles & permissions' },
  { key: 'roles:write', label: 'Manage roles & permissions' },
  { key: 'idp:read', label: 'See identity providers' },
  { key: 'idp:write', label: 'Manage identity providers' },
  { key: 'audit:read', label: 'See the audit log' },
  { key: 'events:read', label: 'See the domain events feed' },
  { key: 'links:read', label: 'See entity links' },
  { key: 'links:write', label: 'Create or remove entity links' },
  { key: 'notifications:read', label: 'See notification preferences' },
  { key: 'notifications:write', label: 'Change notification preferences' },
  { key: 'module:admin', label: 'Module-level administration' },
];

// Modules contribute their own permissions (e.g. "goals:write") at register
// time, so roles can grant them without the foundation knowing each module.
export function registerPermissions(list = []) {
  const known = new Set(PERMISSIONS.map((p) => p.key));
  for (const p of list) {
    if (p?.key && /^[a-z][a-z0-9-]*:[a-z*][a-z0-9_*-]*$/.test(p.key) && !known.has(p.key)) {
      PERMISSIONS.push({ key: p.key, label: str(p.label, 120) || p.key, module: str(p.module, 60) || undefined });
      known.add(p.key);
    }
  }
}

// Identity provider kinds the architecture is prepared for. "capabilities"
// declares what the connector can actually do once configured — the foundation
// never promises universal parity (spec §3.2).
export const IDP_KINDS = [
  { key: 'oidc', label: 'OpenID Connect', capabilities: { auth: true, provisioning: false, groups: 'claim' } },
  { key: 'saml', label: 'SAML 2.0', capabilities: { auth: true, provisioning: false, groups: 'assertion' } },
  { key: 'scim', label: 'SCIM 2.0', capabilities: { auth: false, provisioning: true, groups: 'api' } },
  { key: 'google-workspace', label: 'Google Workspace', capabilities: { auth: true, provisioning: true, groups: 'api' } },
  { key: 'jumpcloud', label: 'JumpCloud', capabilities: { auth: true, provisioning: true, groups: 'api' } },
  { key: 'entra', label: 'Microsoft Entra ID', capabilities: { auth: true, provisioning: true, groups: 'api' } },
  { key: 'okta', label: 'Okta', capabilities: { auth: true, provisioning: true, groups: 'api' } },
  { key: 'csv', label: 'CSV / manual', capabilities: { auth: false, provisioning: true, groups: 'csv' } },
];

// Known relationship types for EntityReference (§5.1). Modules can add their
// own by passing any string; the UI only renames the ones it knows.
export const RELATIONSHIPS = [
  'relates_to', 'supports', 'measures', 'implements',
  'caused_by', 'mitigates', 'derived_from', 'discussed_in', 'recognized_in',
];

export const EVENT_SOURCES = ['manual', 'integration', 'system'];

// Validate and clean user input for each entity. These never throw: they
// return a normalized object; the route handler checks "required" fields.

export function cleanGroup(input, previous = {}) {
  const source = SOURCES.includes(input?.source) ? input.source : previous.source || 'manual';
  return {
    name: str(input?.name, 120) || previous.name || '',
    description: str(input?.description, 500),
    source,
    externalKey: str(input?.externalKey, 300),
    idpId: str(input?.idpId, 60) || null,
  };
}

export function cleanRole(input, previous = {}) {
  const scope = SCOPE_TYPES.includes(input?.scope) ? input.scope : previous.scope || 'org';
  const perms = Array.isArray(input?.permissions) ? input.permissions : previous.permissions || [];
  const known = new Set(PERMISSIONS.map((p) => p.key));
  // "<resource>:*" wildcards are allowed and preserved as-is
  const permissions = [...new Set(perms.map((p) => str(p, 60)).filter((p) => p && (known.has(p) || p.endsWith(':*'))))];
  return {
    key: str(input?.key, 60) || previous.key || '',
    name: str(input?.name, 120) || previous.name || '',
    description: str(input?.description, 500),
    scope,
    permissions,
  };
}

export function cleanMembership(input, previous = {}) {
  const scopeType = SCOPE_TYPES.includes(input?.scopeType) ? input.scopeType : previous.scopeType || 'org';
  const source = SOURCES.includes(input?.source) ? input.source : previous.source || 'manual';
  return {
    userId: str(input?.userId, 60) || previous.userId || '',
    scopeType,
    scopeId: str(input?.scopeId, 60) || previous.scopeId || '',
    roleKey: str(input?.roleKey, 60) || previous.roleKey || '',
    source,
    externalMembershipId: str(input?.externalMembershipId, 300),
    validFrom: str(input?.validFrom, 40) || previous.validFrom || '',
    validTo: str(input?.validTo, 40) || previous.validTo || '',
  };
}

export function cleanIdp(input, previous = {}) {
  const kind = IDP_KINDS.find((k) => k.key === input?.kind)?.key || previous.kind || 'oidc';
  const status = ['draft', 'active', 'disabled'].includes(input?.status) ? input.status : previous.status || 'draft';
  return {
    kind,
    name: str(input?.name, 120) || previous.name || '',
    issuer: str(input?.issuer, 300),
    // Secrets never land here: the core already stores SSO client secrets (see
    // packages/core/src/app.js). The foundation keeps only the non-secret
    // description of the connection.
    settings: cleanIdpSettings(input?.settings, previous.settings),
    capabilities: input?.capabilities && typeof input.capabilities === 'object'
      ? { ...previous.capabilities, ...input.capabilities }
      : (previous.capabilities || IDP_KINDS.find((k) => k.key === kind).capabilities),
    status,
  };
}

function cleanIdpSettings(input, previous = {}) {
  const src = input && typeof input === 'object' ? input : previous || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') out[str(k, 60)] = str(v, 2000);
    else if (typeof v === 'boolean' || typeof v === 'number') out[str(k, 60)] = v;
    else if (Array.isArray(v)) out[str(k, 60)] = v.map((x) => str(x, 300)).slice(0, 50);
  }
  return out;
}

export function cleanMapping(input, previous = {}) {
  return {
    idpId: str(input?.idpId, 60) || previous.idpId || '',
    externalKey: str(input?.externalKey, 300) || previous.externalKey || '',
    externalName: str(input?.externalName, 300),
    mapsTo: {
      groupId: str(input?.mapsTo?.groupId, 60) || null,
      teamId: str(input?.mapsTo?.teamId, 60) || null,
      roleKey: str(input?.mapsTo?.roleKey, 60) || null,
    },
  };
}

export function cleanIdentity(input, previous = {}) {
  return {
    userId: str(input?.userId, 60) || previous.userId || '',
    provider: str(input?.provider, 60) || previous.provider || '',
    subject: str(input?.subject, 300) || previous.subject || '',
    email: str(input?.email, 200),
    idpId: str(input?.idpId, 60) || previous.idpId || null,
  };
}

export function cleanLink(input) {
  return {
    sourceType: str(input?.sourceType, 60),
    sourceId: str(input?.sourceId, 120),
    targetType: str(input?.targetType, 60),
    targetId: str(input?.targetId, 120),
    relationshipType: str(input?.relationshipType, 60) || 'relates_to',
    metadata: input?.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };
}

export function cleanNotificationPref(input, previous = {}) {
  return {
    scope: str(input?.scope, 60) || previous.scope || 'user',
    module: str(input?.module, 60) || previous.module || '',
    eventType: str(input?.eventType, 120) || previous.eventType || '',
    channel: ['in_app', 'email', 'slack', 'teams'].includes(input?.channel) ? input.channel : previous.channel || 'in_app',
    enabled: input?.enabled !== false,
  };
}

// --- Invariants checked by routes before writing

export function assertValidGroup(group) {
  if (!group.name) return 'Enter the group name';
  return null;
}

export function assertValidMembership(m, { roles, users, groups, teams, orgId }) {
  if (!m.userId || !users.has(m.userId)) return 'Unknown user';
  if (!m.roleKey || !roles.has(m.roleKey)) return 'Unknown role';
  if (m.scopeType === 'org' && m.scopeId !== orgId) return 'Organization scope id must match the current organization';
  if (m.scopeType === 'group' && !groups.has(m.scopeId)) return 'Unknown group';
  if (m.scopeType === 'team' && !teams.has(m.scopeId)) return 'Unknown team';
  if (m.validFrom && m.validTo && m.validFrom > m.validTo) return 'valid_from must come before valid_to';
  return null;
}

export function assertValidRole(role, { existingKeys }) {
  if (!role.key) return 'Enter the role key';
  if (!/^[a-z][a-z0-9_]*$/.test(role.key)) return 'Role key must be lowercase, start with a letter and use underscores (e.g. "release_manager")';
  if (!role.name) return 'Enter the role name';
  if (existingKeys && existingKeys.has(role.key)) return 'A role with this key already exists';
  return null;
}

// A membership is "active" at a given ISO timestamp.
export function isActive(m, at) {
  if (m.validFrom && m.validFrom > at) return false;
  if (m.validTo && m.validTo < at) return false;
  return true;
}
