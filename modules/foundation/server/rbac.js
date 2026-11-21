// RBAC evaluator for the foundation (spec §4). The core still owns the simple
// admin/member role used for sign-in; the foundation layers richer permissions
// on top, derived from the memberships that apply to a given user and scope.
//
// Permission check never looks at the UI: every HTTP handler calls either
// hasPermission(effective, 'resource:action') or requires() before mutating.

import { BUILTIN_ROLES, isActive, registerPermissions } from './model.js';
import { K } from './events.js';

export { registerPermissions };

// Combines core admins (role === 'admin') with the organization_owner
// permissions, so turning the foundation on doesn't downgrade existing admins.
export function effectivePermissions(user, memberships, roles, now = new Date().toISOString()) {
  const perms = new Set();
  const byKey = new Map(roles.map((r) => [r.key, r]));
  // core admins keep a superset of permissions ("org:*") until an org migrates
  // their users to the richer model explicitly
  if (user?.role === 'admin') perms.add('org:*');
  for (const m of memberships) {
    if (m.userId !== user?.id) continue;
    if (!isActive(m, now)) continue;
    const role = byKey.get(m.roleKey);
    if (!role) continue;
    for (const p of role.permissions) perms.add(p);
  }
  return perms;
}

// "resource:action" matches a wildcard "<resource>:*" or "*".
export function hasPermission(perms, required) {
  if (perms.has('*') || perms.has(required)) return true;
  const resource = required.split(':')[0];
  return perms.has(`${resource}:*`) || perms.has('org:*');
}

export function ensureBuiltinRoles(saved) {
  const byKey = new Map(saved.map((r) => [r.key, r]));
  for (const r of BUILTIN_ROLES) if (!byKey.has(r.key)) byKey.set(r.key, r);
  return [...byKey.values()];
}

// For other modules: the effective permission set of a user, read from the
// foundation's memberships and roles (the canonical model, spec §4).
export async function loadPermissions(db, orgId, user, at = new Date().toISOString()) {
  const [saved, memberships] = await Promise.all([db.list(K.roles(orgId)), db.list(K.memberships(orgId))]);
  return effectivePermissions(user, memberships, ensureBuiltinRoles(saved), at);
}

// Active memberships of a user (any scope) — e.g. to know which groups a
// person belongs to without touching the foundation's keys.
export async function activeMemberships(db, orgId, userId, at = new Date().toISOString()) {
  return (await db.list(K.memberships(orgId))).filter((m) => m.userId === userId && isActive(m, at));
}
