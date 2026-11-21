// @rewind/goals — web part: objectives pages, menu, Company settings tab and home widgets.
import { defineWebModule } from '@rewind/web/app.js';
import { objectivesView } from './views/objectives.js';
import { detailView } from './views/detail.js';
import { cyclesTab } from './views/cycles.js';
import { home } from './views/home.js';

export default defineWebModule({
  id: 'goals',
  name: 'Goals & Objectives',
  styles: ['goals.css'],
  routes: [
    ['/goals', objectivesView],
    ['/goals/:id', detailView],
  ],
  navSection: 'Goals',
  nav: [{ href: '#/goals', label: 'Objectives', icon: 'flag' }],
  admin: [{ id: 'goals-cycles', label: 'Goal cycles', icon: 'calendar', view: cyclesTab }],
  home,
});
