// Home page after sign-in. The shell draws the frame (greeting, admin checklist,
// overview, housekeeping) and every module fills it through its `home` widgets.
import { get } from '../api.js';
import { h, mount, button, icon, pageHeader, section, metric, plural } from '../ui.js';
import { store } from '../app.js';
import { MODULES } from '../modules.js';

export async function homeView(root) {
  const { user, org } = store.me;
  const data = await get('/api/dashboard');
  const ctx = { data, refresh: () => homeView(root) };
  // only modules the API has enabled
  const mods = MODULES.filter((m) => data.modules.includes(m.id));
  const collect = (name) => mods.flatMap((m) => m.home[name]?.(ctx) || []);

  const metrics = collect('metrics');
  mount(
    root,
    pageHeader(`Hi, ${user.name.split(' ')[0]} — ${org.name}`, collect('actions')),
    data.admin ? onboardingPanel(data.admin.onboarding, collect('onboarding')) : null,
    metrics.length ? section('Overview', h('div', { class: 'metrics' }, metrics.map(([label, value, unit]) => metric(label, value, unit)))) : null,
    data.admin ? housekeepingPanel(data.admin, collect('housekeeping')) : null,
    collect('sections'),
  );
}

// ------------------------------------------------------------- admin: getting started
function onboardingPanel(done, moduleSteps) {
  const steps = [
    { key: 'teams', title: 'Set up your teams', hint: 'Create teams or sign in with a provider that has groups.', href: '#/admin/teams' },
    { key: 'people', title: 'Bring your people in', hint: 'Invite colleagues or allow automatic sign-in for your domain.', href: '#/admin/invites' },
    ...moduleSteps,
    { key: 'appearance', title: 'Make it yours', hint: 'Optional: use your company colors.', href: '#/admin/appearance' },
  ];
  const count = steps.filter((s) => done[s.key]).length;
  if (count === steps.length) return null;

  return h(
    'section',
    { class: 'section panel onboarding' },
    h('div', { class: 'panel-head' }, h('h3', {}, 'Get your team started'), h('span', { class: 'muted small' }, `${count} of ${steps.length} done`)),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': steps.length, 'aria-valuenow': count }, h('span', { style: { width: `${(count / steps.length) * 100}%` } })),
    h(
      'ol',
      { class: 'checklist' },
      steps.map((step) => {
        const ok = Boolean(done[step.key]);
        const label = h('div', {}, h('div', { class: ok ? 'muted done' : 'strong' }, step.title), h('div', { class: 'muted small' }, step.hint));
        let target = null;
        if (!ok && step.href) target = h('a', { href: step.href, class: 'btn btn-default btn-sm' }, step.cta || 'Go');
        if (!ok && step.onClick) target = button(step.cta || 'Go', { size: 'sm', onClick: step.onClick });
        return h('li', { class: ok ? 'is-done' : '' }, h('span', { class: 'check-dot', 'aria-label': ok ? 'Done' : 'To do' }, ok ? icon('check', 12) : null), label, target);
      }),
    ),
  );
}

// ------------------------------------------------------------- admin: housekeeping
function housekeepingPanel(admin, moduleRows) {
  const rows = [];
  if (admin.accessRequests) {
    rows.push({ icon: 'userPlus', title: `${plural(admin.accessRequests, 'person is', 'people are')} asking to join`, hint: 'They registered your company name and are waiting for your approval.', href: '#/admin/members', cta: 'Review' });
  }
  if (admin.pendingInvites) {
    rows.push({ icon: 'mail', title: `${plural(admin.pendingInvites, 'invite')} waiting to be accepted`, href: '#/admin/invites', cta: 'Review' });
  }
  if (admin.membersWithoutTeam.length) {
    const names = admin.membersWithoutTeam.map((m) => m.name);
    const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    rows.push({ icon: 'user', title: `${plural(names.length, 'member')} without a team`, hint: `${shown} won't see their team's work until they join a team.`, href: '#/admin/members', cta: 'Assign' });
  }
  rows.push(...moduleRows);
  if (!rows.length) return null;
  return section(
    'Company housekeeping',
    h(
      'div',
      { class: 'panel list-panel' },
      rows.map((r) =>
        h(
          'div',
          { class: 'list-row' },
          h('span', { class: 'list-icon' }, icon(r.icon)),
          h('div', { class: 'list-text' }, h('div', { class: 'strong' }, r.title), r.hint ? h('div', { class: 'muted small' }, r.hint) : null),
          h('a', { href: r.href, class: 'btn btn-default btn-sm' }, r.cta),
        ),
      ),
    ),
  );
}
