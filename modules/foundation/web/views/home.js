// Home widgets for the foundation: a small set of metrics and an onboarding
// step for admins (set up groups, configure an identity provider).
import { h } from '@rewind/web/ui.js';

export const home = {
  metrics: ({ data }) => {
    const f = data.foundation;
    if (!f) return [];
    return [
      ['Groups', f.groups ?? 0],
      ['My memberships', f.myMemberships ?? 0],
    ];
  },
  onboarding: () => [
    // "done" is read from data.admin.onboarding[step.key] (keys coming from adminDashboard()).
    { key: 'foundationGroups', title: 'Create your first group', hint: 'Groups organize people inside the company (different from Teams).', href: '#/admin/fdn-groups' },
    { key: 'foundationIdp', title: 'Register an identity provider', hint: 'Prepare OIDC / SCIM / directory connectors (spec §3).', href: '#/admin/fdn-identity' },
  ],
  housekeeping: ({ data }) => {
    const admin = data.admin?.foundation;
    if (!admin?.lastSync) return [];
    return [{
      icon: 'history',
      title: `Last directory sync: ${admin.lastSync.status}`,
      hint: `Started at ${admin.lastSync.at}`,
      href: '#/admin/fdn-identity',
      cta: 'Open',
    }];
  },
};
