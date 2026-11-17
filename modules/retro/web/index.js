// @rewind/retro — web part: routes, menu items and home widgets.
import { defineWebModule } from '@rewind/web/app.js';
import { boardsListView, boardView } from './views/boards.js';
import { sprintView, publicSprintView } from './views/sprint.js';
import { myActionsView } from './views/actions.js';
import { home } from './views/home.js';

export default defineWebModule({
  id: 'retro',
  name: 'Retro',
  styles: ['retro.css'],
  routes: [
    ['/boards', boardsListView],
    ['/boards/:boardId', boardView],
    ['/sprint/:sprintId', sprintView],
    ['/actions', myActionsView],
    ['/s/:token', publicSprintView, { public: true, bare: true }],
  ],
  // old links keep working: #/retro, #/retro/:id -> #/boards...
  aliases: [[/^\/retro(?=\/|$)/, '/boards']],
  nav: [
    { href: '#/boards', label: 'Boards', icon: 'board' },
    { href: '#/actions', label: 'My action items', icon: 'list' },
  ],
  home,
});
