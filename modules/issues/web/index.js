// @rewind/issues — web part. No menu and no pages of its own: the backlog and
// its settings appear only inside a team board (retro's extension points).
import { defineWebModule } from '@rewind/web/app.js';
import { boardTabs, backlogSettings } from './views/backlog.js';

export default defineWebModule({
  id: 'issues',
  name: 'Issues',
  styles: ['issues.css'],
  slots: {
    'retro.board.tabs': boardTabs,
    'retro.board.settings': backlogSettings,
  },
});
