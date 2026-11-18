// @rewind/gmud — web part: change management pages, menu items and home widgets.
import { defineWebModule } from '@rewind/web/app.js';
import { changesView } from './views/changes.js';
import { editorView } from './views/editor.js';
import { detailView } from './views/detail.js';
import { releasesView, deploymentsView } from './views/releases.js';
import { settingsTab } from './views/settings.js';
import { home } from './views/home.js';
import { documentView } from './views/document.js';

export default defineWebModule({
  id: 'gmud',
  name: 'Changes (GMUD)',
  styles: ['gmud.css'],
  // order matters: fixed paths before ":id"
  routes: [
    ['/changes', changesView],
    ['/changes/:id/edit', editorView],
    ['/changes/:id/document', documentView],
    ['/changes/:id', detailView],
    ['/changes/:id/:tab', detailView],
    ['/releases', releasesView],
    ['/deployments', deploymentsView],
  ],
  // its own section in the menu, below the main navigation
  navSection: 'Change management',
  nav: [
    { href: '#/changes', label: 'Changes', icon: 'change' },
    { href: '#/releases', label: 'Releases', icon: 'tag' },
    { href: '#/deployments', label: 'Deployments', icon: 'rocket' },
  ],
  // Company settings → GMUDs: approvers, approval rules, self-approval, SemVer policy
  admin: [{ id: 'gmuds', label: 'GMUDs', icon: 'change', view: settingsTab }],
  // the settings used to live at #/changes/settings
  aliases: [[/^\/changes\/settings$/, '/admin/gmuds']],
  home,
});
