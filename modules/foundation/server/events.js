// Shared helpers other modules import to log domain events, audit records and
// entity links into the foundation's storage. Keeping the keys here (and not in
// server/index.js) lets another module write a DomainEvent without reaching
// into the foundation's HTTP surface.
//
//   import { recordEvent, recordAudit, createLink } from '@rewind/foundation/server/events';
//
// A module may call these whenever it decides something is worth seeing in
// the Team Timeline, the Audit log, or the Entity Linking layer (spec §5).
// Nothing in core depends on the foundation: when the foundation is not
// installed, modules can wrap these calls in a try/catch — the helpers
// tolerate the db keys not being read by anyone.

import { newId, now } from '@rewind/core';

export const K = {
  group: (orgId, id) => `fgrp:${orgId}:${id}`,
  groups: (orgId) => `fgrp:${orgId}:`,
  role: (orgId, key) => `frole:${orgId}:${key}`,
  roles: (orgId) => `frole:${orgId}:`,
  membership: (orgId, id) => `fmbr:${orgId}:${id}`,
  memberships: (orgId) => `fmbr:${orgId}:`,
  identity: (orgId, id) => `fident:${orgId}:${id}`,
  identities: (orgId) => `fident:${orgId}:`,
  identityBySubject: (orgId, provider, subject) => `fidsub:${orgId}:${provider}:${subject}`,
  idp: (orgId, id) => `fidp:${orgId}:${id}`,
  idps: (orgId) => `fidp:${orgId}:`,
  mapping: (orgId, id) => `fmap:${orgId}:${id}`,
  mappings: (orgId) => `fmap:${orgId}:`,
  syncRun: (orgId, id) => `fsync:${orgId}:${id}`,
  syncRuns: (orgId) => `fsync:${orgId}:`,
  provisioning: (orgId, syncId, id) => `fprov:${orgId}:${syncId}:${id}`,
  provisioningFor: (orgId, syncId) => `fprov:${orgId}:${syncId}:`,
  link: (orgId, id) => `flink:${orgId}:${id}`,
  links: (orgId) => `flink:${orgId}:`,
  // one key per (sourceType, sourceId) group so a module's view filters cheaply
  linkBySource: (orgId, sourceType, sourceId, id) => `flinksrc:${orgId}:${sourceType}:${sourceId}:${id}`,
  linksBySource: (orgId, sourceType, sourceId) => `flinksrc:${orgId}:${sourceType}:${sourceId}:`,
  event: (orgId, id) => `fevt:${orgId}:${id}`,
  events: (orgId) => `fevt:${orgId}:`,
  audit: (orgId, id) => `faudit:${orgId}:${id}`,
  audits: (orgId) => `faudit:${orgId}:`,
  notifPref: (orgId, userId, id) => `fnotif:${orgId}:${userId}:${id}`,
  notifPrefsFor: (orgId, userId) => `fnotif:${orgId}:${userId}:`,
  notifPrefs: (orgId) => `fnotif:${orgId}:`,
};

// Shards: everything lives in the organization's Durable Object (spec §6).
// Keeping org-wide state together keeps lists on a single object.
export const SHARDS = {
  fgrp: 'org', frole: 'org', fmbr: 'org', fident: 'org', fidsub: 'org',
  fidp: 'org', fmap: 'org', fsync: 'org', fprov: 'org',
  flink: 'org', flinksrc: 'org', fevt: 'org', faudit: 'org', fnotif: 'org',
};

// Immutable event: corrections produce a new event (spec §5.3).
export async function recordEvent(db, {
  orgId, actorId = null, teamId = null, entityType, entityId,
  eventType, source = 'system', metadata = {}, correlationId = null, schemaVersion = 1,
}) {
  const event = {
    id: newId(),
    orgId,
    actorId,
    teamId,
    entityType,
    entityId,
    eventType,
    source,
    schemaVersion,
    metadata,
    correlationId,
    occurredAt: now(),
    recordedAt: now(),
  };
  await db.put(K.event(orgId, event.id), event);
  return event;
}

// Admin action or sync operation: separate from domain events (spec §5.3).
export async function recordAudit(db, { orgId, actorId, action, target = null, before = null, after = null, source = 'manual', metadata = {} }) {
  const record = {
    id: newId(),
    orgId,
    actorId,
    action,
    target,
    before,
    after,
    source,
    metadata,
    at: now(),
  };
  await db.put(K.audit(orgId, record.id), record);
  return record;
}

export async function createLink(db, { orgId, sourceType, sourceId, targetType, targetId, relationshipType = 'relates_to', createdBy, metadata = {} }) {
  const link = {
    id: newId(),
    orgId,
    sourceType,
    sourceId,
    targetType,
    targetId,
    relationshipType,
    metadata,
    createdBy,
    createdAt: now(),
  };
  await db.put(K.link(orgId, link.id), link);
  await db.put(K.linkBySource(orgId, sourceType, sourceId, link.id), { id: link.id });
  return link;
}

export async function deleteLink(db, { orgId, id }) {
  const link = await db.get(K.link(orgId, id));
  if (!link) return false;
  await db.delete(K.link(orgId, id));
  await db.delete(K.linkBySource(orgId, link.sourceType, link.sourceId, link.id));
  return true;
}
