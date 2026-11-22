// @rewind/feedback — web part: kudos feed, feedback & requests, personal history,
// Company settings tab and home widgets.
import { defineWebModule } from '@rewind/web/app.js';
import { kudosView, kudosDetailView } from './views/kudos.js';
import { feedbackView, feedbackDetailView, requestDetailView, historyView } from './views/feedback.js';
import { settingsTab } from './views/settings.js';
import { home } from './views/home.js';

export default defineWebModule({
  id: 'feedback',
  name: 'Feedback & Recognition',
  styles: ['feedback.css'],
  // fixed paths before ":id"
  routes: [
    ['/kudos', kudosView],
    ['/kudos/:id', kudosDetailView],
    ['/feedback', feedbackView],
    ['/feedback/history', historyView],
    ['/feedback/requests/:id', requestDetailView],
    ['/feedback/:id', feedbackDetailView],
  ],
  navSection: 'People',
  nav: [
    { href: '#/kudos', label: 'Kudos', icon: 'heart' },
    { href: '#/feedback', label: 'Feedback', icon: 'comment' },
  ],
  admin: [{ id: 'feedback-settings', label: 'Feedback', icon: 'heart', view: settingsTab }],
  home,
});
