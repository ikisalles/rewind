// RBAC evaluator for the foundation (spec §4). The core still owns the simple
// admin/member role used for sign-in; the foundation layers richer permissions
// on top, derived from the memberships that apply to a given user and scope.
//
// Permission check never looks at the UI: every HTTP handler calls either
// hasPermission(effective, 'resource:action') or requires() before mutating.

import { BUILTIN_ROLES, isActive } from './model.js';

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
