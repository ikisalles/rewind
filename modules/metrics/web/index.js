// @rewind/metrics — web part: dashboard, drill-down, experiments & KRs,
// Company settings tab and home widgets.
import { defineWebModule } from '@rewind/web/app.js';
import { dashboardView } from './views/dashboard.js';
import { eventsView, eventDetailView } from './views/events.js';
import { improveView } from './views/improve.js';
import { adminTab } from './views/admin.js';
import { home } from './views/home.js';

export default defineWebModule({
  id: 'metrics',
  name: 'Engineering Metrics',
  styles: ['metrics.css'],
  // fixed paths before ":id"
  routes: [
    ['/metrics', dashboardView],
    ['/metrics/improve', improveView],
    ['/metrics/events', eventsView],
    ['/metrics/events/:id', eventDetailView],
  ],
  navSection: 'Engineering',
  nav: [{ href: '#/metrics', label: 'Metrics', icon: 'rocket' }],
  admin: [{ id: 'metrics-settings', label: 'Engineering metrics', icon: 'rocket', view: adminTab }],
  home,
});
