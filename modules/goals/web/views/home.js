// Home widgets for Goals: indicators, in-app reminders (check-ins and
// deadlines) and admin onboarding.
import { h, button, section, fmtDate } from '@rewind/web/ui.js';

const REMINDER = {
  checkin: (r) => [`Check-in due: ${r.title}`, `Objective: ${r.objectiveTitle}`],
  deadline: (r) => [`Due soon: ${r.title}`, `Due ${fmtDate(r.dueDate)}`],
  overdue: (r) => [`Past due: ${r.title}`, `Was due ${fmtDate(r.dueDate)}`],
};

export const home = {
  actions: () => [button('Objectives', { iconName: 'flag', onClick: () => (location.hash = '#/goals') })],
  metrics: ({ data }) => (data.goals ? [['My open objectives', data.goals.mine], ['Objectives at risk', data.goals.atRisk]] : []),
  onboarding: () => [
    { key: 'goalsCycle', title: 'Create a goal cycle', hint: 'Quarterly, semiannual, annual or custom.', href: '#/admin/goals-cycles' },
    { key: 'goalsObjective', title: 'Write the first objective', hint: 'For the organization, a group or a team.', href: '#/goals' },
  ],
  housekeeping: ({ data }) =>
    (data.admin?.goals?.overdueCycles || []).map((c) => ({
      icon: 'clock',
      title: `Cycle "${c.name}" has ended`,
      hint: `It ended ${fmtDate(c.endDate)}. Run the cycle review to record results and learnings.`,
      href: '#/admin/goals-cycles',
      cta: 'Review',
    })),
  sections: ({ data }) => {
    const list = data.goals?.reminders || [];
    if (!list.length) return [];
    return [
      section(
        'Goals reminders',
        h(
          'ul',
          { class: 'goals-history' },
          list.map((r) => {
            const [title, hint] = REMINDER[r.kind](r);
            return h('li', {}, h('a', { href: `#/goals/${r.objectiveId}` }, title), h('div', { class: 'muted' }, hint));
          }),
        ),
      ),
    ];
  },
};
