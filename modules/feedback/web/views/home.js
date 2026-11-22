// Home widgets: neutral notifications and pending requests. No content, no rankings.
import { h, button, section } from '@rewind/web/ui.js';
import { get, post } from '@rewind/web/api.js';
import { giveKudos } from './forms.js';

let cache = null;
export const home = {
  actions: () => [button('Recognize someone', { iconName: 'heart', onClick: () => giveKudos() })],
  metrics: ({ data }) => (data.feedback ? [['Feedback requests for you', data.feedback.pendingRequests]] : []),
  onboarding: () => [{ key: 'feedbackFirstKudos', title: 'Send the first recognition', hint: 'Specific, about a contribution and its impact.', href: '#/kudos' }],
  sections: ({ data, refresh }) => {
    if (!data.feedback || (!data.feedback.unread && !data.feedback.pendingRequests)) return [];
    if (!cache) get('/api/feedback/notifications').then((r) => ((cache = r), refresh()), () => {});
    if (!cache) return [];
    const items = [...cache.reminders, ...cache.notifications.filter((n) => !n.read)];
    return [section('Feedback', h('ul', {}, items.map((n) => h('li', {}, h('a', { href: n.href }, n.text)))),
      cache.notifications.some((n) => !n.read) ? button('Mark as read', { size: 'sm', variant: 'ghost', onClick: async () => { await post('/api/feedback/notifications/read'); cache = null; refresh(); } }) : null)];
  },
};
