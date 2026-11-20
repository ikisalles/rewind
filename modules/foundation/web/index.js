// @rewind/foundation — web part: admin tabs for groups, roles, identity
// providers, external identities, entity links and the audit log.
import { defineWebModule } from '@rewind/web/app.js';
import { groupsTab } from './views/groups.js';
import { rolesTab } from './views/roles.js';
import { identityTab } from './views/identity.js';
import { auditTab } from './views/audit.js';
import { linksTab } from './views/links.js';
import { home } from './views/home.js';

export default defineWebModule({
  id: 'foundation',
  name: 'Foundation',
  styles: ['foundation.css'],
  // No top-level routes: everything the foundation adds lives under Company
  // settings. Modules consume its data through the API, not through a page.
  routes: [],
  nav: [],
  admin: [
    { id: 'fdn-groups', label: 'Groups', icon: 'team', view: groupsTab },
    { id: 'fdn-roles', label: 'Roles & permissions', icon: 'shield', view: rolesTab },
    { id: 'fdn-identity', label: 'Identity providers', icon: 'plug', view: identityTab },
    { id: 'fdn-links', label: 'Entity links', icon: 'link', view: linksTab },
    { id: 'fdn-audit', label: 'Audit log', icon: 'history', view: auditTab },
  ],
  home,
});
