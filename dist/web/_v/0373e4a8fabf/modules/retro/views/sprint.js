import { get, post, patch, del, minRev } from '@rewind/web/api.js';
import { keepUpdated as keepLive } from '@rewind/web/live.js';
import { h, mount, button, field, badge, modal, icon, avatar, fmtDate, attempt, confirmDialog, copyText, pageHeader } from '@rewind/web/ui.js';
import { applyTheme } from '@rewind/web/theme.js';
import { logo, footer, APP_NAME, store } from '@rewind/web/app.js';
import { statusBadge, sprintForm } from './boards.js';
import { loadTemplates, templatePicker } from './templates.js';

// id of the card being dragged (drag & drop merge)
let draggingId = null;

// Live updates (shared with every module, see @rewind/web/live.js): also wait while a card is dragged.
const keepUpdated = (root, refresh, liveUrl) => keepLive(root, refresh, liveUrl, { busy: () => Boolean(draggingId) });

// ===================================================================== board columns
// Who wrote a part, as this viewer may see it.
export const authorLabel = (part) => (part.masked ? 'Hidden' : part.mine ? 'You' : part.authorName || 'Anonymous');

// Merge rules (the API enforces the same): you merge notes you can read. The retro admin
// merges any revealed note; everyone merges their own notes, even while notes are hidden.
const ownsAll = (n) => n.mine && (n.merged || []).every((p) => p.mine);
const readable = (n) => !n.masked && (n.merged || []).every((p) => !p.masked);
const mergeable = (n, state) =>
  state.sprint.status === 'open' && readable(n) && (state.sprint.hidden ? ownsAll(n) : state.canManage || ownsAll(n));

const noteText = (part) =>
  part.masked
    ? h('p', { class: 'note-text', 'aria-label': 'Hidden note' }, h('span', { class: 'redacted' }), h('span', { class: 'redacted short' }))
    : h('p', { class: 'note-text' }, part.text);

function noteCard(note, column, state, opts) {
  const { readOnly, onVote, onUnvote, onEdit, onDelete, onMerge, onDropMerge, onUnmerge } = opts;
  const finished = state.sprint.status === 'finished';
  const rank = finished ? state.sprint.top.indexOf(note.id) : -1;
  // several of your votes can go to the same card, within the sprint's limit
  const canVote = !readOnly && !finished && state.myVotes?.remaining > 0;
  const mineOnNote = note.myVotes || 0;
  const merging = !readOnly && mergeable(note, state);
  const others = merging ? state.notes.filter((n) => n.id !== note.id && mergeable(n, state)) : [];
  const merged = note.merged || [];
  // a merged card holds other people's notes: only the retro admin may remove it
  const canDelete = !readOnly && !finished && (state.canManage || (note.mine && !merged.length));

  // drag a card onto another one; after the drop you're asked to confirm the merge
  const drag = merging
    ? {
        draggable: 'true',
        onDragstart: (e) => {
          draggingId = note.id;
          e.dataTransfer.setData('text/plain', note.id); // Firefox needs data to start a drag
          e.dataTransfer.effectAllowed = 'move';
          e.currentTarget.classList.add('dragging');
          document.body.classList.add('note-dragging');
        },
        onDragend: (e) => {
          draggingId = null;
          e.currentTarget.classList.remove('dragging');
          document.body.classList.remove('note-dragging');
          document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
        },
        onDragenter: (e) => {
          if (!draggingId || draggingId === note.id) return;
          e.preventDefault();
          e.currentTarget.classList.add('drop-target');
        },
        onDragover: (e) => {
          if (!draggingId || draggingId === note.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        },
        onDragleave: (e) => {
          // ignore moves between the card's own children
          if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop-target');
        },
        onDrop: (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('drop-target');
          const sourceId = draggingId;
          draggingId = null;
          if (sourceId && sourceId !== note.id) onDropMerge(sourceId, note);
        },
      }
    : {};

  return h(
    'article',
    { class: `note${note.masked ? ' masked' : ''}${note.mine ? ' mine' : ''}${merged.length ? ' is-merged' : ''}`, style: { '--col': column.color }, ...drag },
    rank >= 0 ? h('span', { class: 'note-rank', title: `#${rank + 1} most voted` }, icon('trophy', 12), `#${rank + 1}`) : null,
    noteText(note),
    merged.length
      ? h(
          'ul',
          { class: 'merged-list', 'aria-label': `${merged.length} merged note${merged.length === 1 ? '' : 's'}` },
          merged.map((part) =>
            h(
              'li',
              { class: 'merged-part' },
              noteText(part),
              h(
                'span',
                { class: 'merged-meta' },
                authorLabel(part),
                merging && button('', { iconName: 'unmerge', variant: 'ghost', size: 'xs', title: 'Split back into its own card', onClick: () => onUnmerge(note, part) }),
              ),
            ),
          ),
        )
      : null,
    h(
      'footer',
      { class: 'note-foot' },
      h(
        'span',
        { class: 'note-author' },
        authorLabel(note),
        merged.length ? h('span', { class: 'merged-count', title: `${merged.length + 1} notes merged` }, icon('merge', 11), String(merged.length + 1)) : null,
      ),
      h(
        'span',
        { class: 'note-tools' },
        !readOnly && note.mine && !finished && button('', { iconName: 'edit', variant: 'ghost', size: 'xs', title: 'Edit', onClick: () => onEdit(note) }),
        others.length > 0 && button('', { iconName: 'merge', variant: 'ghost', size: 'xs', title: 'Merge other notes into this one (or drag a card onto it)', onClick: () => onMerge(note) }),
        canDelete && button('', { iconName: 'trash', variant: 'ghost', size: 'xs', title: 'Remove', onClick: () => onDelete(note) }),
        h(
          'span',
          { class: `vote-group${mineOnNote ? ' active' : ''}` },
          !readOnly && !finished && mineOnNote > 0
            ? h('button', { class: 'vote-less', type: 'button', title: 'Take back one of your votes', 'aria-label': 'Take back one of your votes', onClick: () => onUnvote(note) }, '−')
            : null,
          h(
            'button',
            {
              class: `vote${mineOnNote ? ' active' : ''}`,
              type: 'button',
              disabled: !canVote,
              title: readOnly || finished ? 'Votes' : canVote ? 'Add a vote' : 'You have no votes left',
              'aria-label': `${note.votes} vote${note.votes === 1 ? '' : 's'}${mineOnNote ? `, ${mineOnNote} from you` : ''}${canVote ? '. Add a vote' : ''}`,
              onClick: () => onVote(note),
            },
            icon('heart', 13),
            String(note.votes),
            mineOnNote ? h('span', { class: 'vote-mine' }, `· you ${mineOnNote}`) : null,
          ),
        ),
      ),
    ),
  );
}

function columnsView(state, opts) {
  const finished = state.sprint.status === 'finished';
  if (!state.sprint.columns.length) {
    const manage = !opts.readOnly && state.canManage && !finished;
    return h(
      'div',
      { class: 'panel empty-board' },
      icon('columns', 22),
      h('h3', {}, 'This retro has no columns yet'),
      manage
        ? [
            h('p', { class: 'muted' }, 'Add the columns the team will write in, or start from a template.'),
            h('div', { class: 'btn-group' }, button('Add columns', { variant: 'primary', iconName: 'plus', onClick: opts.onSetupColumns }), button('Use a template', { iconName: 'board', onClick: opts.onUseTemplate })),
          ]
        : h('p', { class: 'muted' }, 'The retro admin is setting up the columns. Notes can be added as soon as they are ready.'),
    );
  }
  return h(
    'div',
    { class: 'columns', style: { '--cols': state.sprint.columns.length } },
    state.sprint.columns.map((col) => {
      const notes = state.notes.filter((n) => n.columnId === col.id);
      if (finished) notes.sort((a, b) => b.votes - a.votes);
      return h(
        'section',
        { class: 'column', style: { '--col': col.color } },
        h(
          'header',
          { class: 'column-head' },
          h('span', { class: 'col-dot' }),
          h('h3', {}, col.title),
          col.orphan ? h('span', { title: "These notes' column was removed. Save the columns (Columns → Save) to keep this one, then rename it." }, badge('Recovered', 'warning')) : null,
          h('span', { class: 'count' }, String(notes.length)),
        ),
        !opts.readOnly && !finished && !col.orphan ? opts.composer(col) : null,
        h('div', { class: 'notes' }, notes.length ? notes.map((n) => noteCard(n, col, state, opts)) : h('p', { class: 'empty-col' }, 'No notes')),
      );
    }),
  );
}

// ===================================================================== action items
function memberName(state, id) {
  return state.members.find((m) => m.id === id)?.name || 'Unassigned';
}

function actionRow(action, state, { editable, onChange, origin }) {
  const sid = action.sprintId;
  const canToggle = editable || action.ownerId === state.me?.id;
  const update = (body) => attempt(() => patch(`/api/sprints/${sid}/actions/${action.id}`, body)).then(onChange);
  const overdue = action.due && !action.done && action.due < new Date().toISOString().slice(0, 10);

  return h(
    'li',
    { class: `action${action.done ? ' done' : ''}` },
    h('input', { type: 'checkbox', checked: action.done, disabled: !canToggle, 'aria-label': 'Done', onChange: (e) => update({ done: e.target.checked }) }),
    h(
      'div',
      { class: 'action-main' },
      origin ? h('span', { class: 'action-origin muted small' }, `↳ ${origin}`) : null,
      h('span', { class: 'action-text' }, action.text),
      h(
        'span',
        { class: 'action-meta' },
        editable
          ? h('select', { class: 'inline', 'aria-label': 'Owner', onChange: (e) => update({ ownerId: e.target.value || null }) },
              h('option', { value: '' }, 'Unassigned'),
              state.members.map((m) => h('option', { value: m.id, selected: m.id === action.ownerId }, m.name)))
          : h('span', {}, icon('user', 12), memberName(state, action.ownerId)),
        editable
          ? h('input', { type: 'date', class: 'inline', value: action.due || '', 'aria-label': 'Due date', onChange: (e) => update({ due: e.target.value || null }) })
          : action.due ? h('span', { class: overdue ? 'danger' : '' }, `due ${fmtDate(action.due)}`) : null,
        action.carriedFrom ? badge(`from ${action.carriedFrom.sprintName}`, 'neutral', 'history') : null,
      ),
    ),
    editable &&
      button('', {
        iconName: 'trash',
        variant: 'ghost',
        size: 'xs',
        title: 'Remove action item',
        onClick: () => attempt(() => del(`/api/sprints/${sid}/actions/${action.id}`)).then(onChange),
      }),
  );
}

// Action items written in a window are drafts until the window is saved.
// `drafts` is shared by the whole window: [{ key, noteId, text, ownerId, due }].
function draftEditor(state, noteId, drafts, onChange) {
  const mine = () => drafts.filter((d) => d.noteId === noteId);
  const list = h('ul', { class: 'actions drafts' });
  const draw = () =>
    mount(
      list,
      mine().map((d) =>
        h(
          'li',
          { class: 'action draft' },
          h('span', { class: 'draft-dot', title: 'Not saved yet' }),
          h(
            'div',
            { class: 'action-main' },
            h('span', { class: 'action-text' }, d.text),
            h('span', { class: 'action-meta' }, h('span', {}, icon('user', 12), d.ownerId ? memberName(state, d.ownerId) : 'Unassigned'), d.due ? h('span', {}, fmtDate(d.due)) : null, badge('Not saved yet', 'warning')),
          ),
          button('', { iconName: 'x', variant: 'ghost', size: 'xs', title: 'Remove', onClick: () => (drafts.splice(drafts.indexOf(d), 1), draw(), onChange()) }),
        ),
      ),
    );
  const form = h(
    'form',
    {
      class: 'action-form',
      onSubmit: (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        if (!data.text.trim()) return;
        drafts.push({ key: Math.random().toString(36).slice(2), noteId, text: data.text.trim(), ownerId: data.ownerId || null, due: data.due || null });
        form.reset();
        form.elements.text.focus();
        draw();
        onChange();
      },
    },
    h('input', { name: 'text', required: true, maxlength: 500, placeholder: 'New action item...', 'aria-label': 'Action item' }),
    h('select', { name: 'ownerId', 'aria-label': 'Owner' }, h('option', { value: '' }, 'Owner'), state.members.map((m) => h('option', { value: m.id }, m.name))),
    h('input', { name: 'due', type: 'date', 'aria-label': 'Due date (optional)', title: 'Due date (optional)' }),
    button('Add', { type: 'submit', iconName: 'plus', size: 'sm' }),
  );
  draw();
  return h('div', { class: 'stack-sm' }, list, form);
}

// One of the top voted items, followed by whatever goes under it (action items, editors).
function resultItem(state, note, i, ...children) {
  const col = state.sprint.columns.find((c) => c.id === note.columnId);
  return h(
    'li',
    { class: 'result', style: { '--col': col?.color } },
    h(
      'div',
      { class: 'result-head' },
      h('span', { class: 'result-rank' }, `#${i + 1}`),
      h(
        'div',
        { class: 'result-note' },
        h('p', {}, note.text),
        note.merged?.length ? h('ul', { class: 'merged-list' }, note.merged.map((part) => h('li', { class: 'merged-part' }, h('p', { class: 'note-text' }, part.text), h('span', { class: 'merged-meta' }, authorLabel(part))))) : null,
        h('span', { class: 'muted small' }, `${col?.title || ''} · ${state.sprint.anonymous ? 'Anonymous' : [note, ...(note.merged || [])].map(authorLabel).join(', ')} · `, icon('heart', 11), ` ${note.votes} vote(s)`),
      ),
    ),
    children,
  );
}

const toPayload = (drafts) => drafts.map(({ noteId, text, ownerId, due }) => ({ noteId, text, ownerId, due }));

// Same rule the API uses when the retro is finished: most votes, then oldest.
const topPreview = (state, n = 3) => [...state.notes].sort((a, b) => b.votes - a.votes || a.createdAt.localeCompare(b.createdAt)).slice(0, n);

function actionComposer(state, noteId, onChange) {
  const form = h(
    'form',
    {
      class: 'action-form',
      onSubmit: async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        const ok = await attempt(() => post(`/api/sprints/${state.sprint.id}/actions`, { ...data, noteId }));
        if (ok) {
          form.reset();
          onChange();
        }
      },
    },
    h('input', { name: 'text', required: true, maxlength: 500, placeholder: 'New action item...', 'aria-label': 'Action item' }),
    h('select', { name: 'ownerId', 'aria-label': 'Owner' }, h('option', { value: '' }, 'Owner'), state.members.map((m) => h('option', { value: m.id }, m.name))),
    h('input', { name: 'due', type: 'date', 'aria-label': 'Due date (optional)', title: 'Due date (optional)' }),
    button('Add', { type: 'submit', iconName: 'plus', size: 'sm' }),
  );
  return form;
}

// ===================================================================== sprint page
export async function sprintView(root, { params }) {
  let state;
  let tab = 'board';
  const composers = new Map(); // columnId -> textarea (kept across repaints)

  // Never show a state older than the one on screen: the sprint's `rev` grows with every
  // change, and reads may come from a database replica a moment behind. With `want`, keep
  // trying (briefly) until the server returns at least that revision.
  const RETRY_MS = [300, 700, 1500, 3000, 5000];
  const load = async (want = 0) => {
    want = Math.max(want, minRev(params.sprintId));
    for (let i = 0; ; i++) {
      const next = await get(`/api/sprints/${params.sprintId}`);
      const rev = Number(next.sprint.rev) || 0;
      const shown = Number(state?.sprint.rev) || 0;
      if (rev >= shown && rev >= want) {
        state = next;
        state.me = store.me.user;
        return true;
      }
      if (i >= RETRY_MS.length || rev < shown && rev >= want) return false; // keep what's on screen
      await new Promise((r) => setTimeout(r, RETRY_MS[i]));
    }
  };
  const refresh = async (want = 0) => {
    if (await load(want)) paint();
  };

  // ---------------------------------------------------- note handlers
  const composer = (col) => {
    let ta = composers.get(col.id);
    if (!ta) {
      ta = h('textarea', { rows: 2, maxlength: 2000, placeholder: `${col.hint || 'Write a note...'} (Ctrl+Enter)`, 'aria-label': `New note in ${col.title}` });
      const submit = async () => {
        const text = ta.value.trim();
        if (!text) return;
        if (await attempt(() => post(`/api/sprints/${state.sprint.id}/notes`, { columnId: col.id, text }))) {
          ta.value = '';
          ta.blur();
          refresh();
        }
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
      });
      ta._submit = submit;
      composers.set(col.id, ta);
    }
    return h('div', { class: 'composer' }, ta, button('Add', { iconName: 'plus', size: 'sm', onClick: () => ta._submit() }));
  };

  const excerpt = (n) => (n.text.length > 80 ? `${n.text.slice(0, 80)}…` : n.text);
  const mergeNotes = async (target, noteIds) => {
    const r = await attempt(() => post(`/api/sprints/${state.sprint.id}/notes/${target.id}/merge`, { noteIds }), noteIds.length === 1 ? 'Notes merged' : `${noteIds.length + 1} notes merged`);
    if (r) refresh();
    return r;
  };

  const noteHandlers = {
    readOnly: false,
    composer,
    onSetupColumns: () => columnsDialog(),
    onUseTemplate: () => templateDialog(),
    onDropMerge: async (sourceId, target) => {
      const source = state.notes.find((n) => n.id === sourceId);
      if (!source) return;
      const ok = await confirmDialog(`Merge "${excerpt(source)}" into "${excerpt(target)}"? Both texts and authors are kept, and votes are added up.`, { confirmLabel: 'Merge' });
      if (ok) mergeNotes(target, [sourceId]);
    },
    onMerge: (target) => {
      const others = state.notes.filter((n) => n.id !== target.id && mergeable(n, state));
      const m = modal({
        title: 'Merge notes',
        wide: true,
        body: h(
          'form',
          {
            id: 'merge-form',
            class: 'stack',
            onSubmit: async (e) => {
              e.preventDefault();
              const noteIds = new FormData(e.target).getAll('noteIds');
              if (!noteIds.length) return;
              if (await mergeNotes(target, noteIds)) m.close();
            },
          },
          h('div', { class: 'merge-target' }, h('span', { class: 'muted small' }, 'Into'), h('strong', {}, target.text)),
          h('p', { class: 'muted small' }, 'Pick the notes about the same item or subject. Texts and authors are kept on the merged card, and all their votes add up. You can split them back later.'),
          state.sprint.columns.map((col) => {
            const list = others.filter((n) => n.columnId === col.id);
            if (!list.length) return null;
            return h(
              'fieldset',
              { class: 'merge-pick', style: { '--col': col.color } },
              h('legend', {}, col.title),
              list.map((n) =>
                h(
                  'label',
                  {},
                  h('input', { type: 'checkbox', name: 'noteIds', value: n.id }),
                  h('span', {}, h('span', { class: 'merge-text' }, n.text), h('span', { class: 'muted small' }, ` — ${authorLabel(n)} · ${n.votes} vote${n.votes === 1 ? '' : 's'}${n.merged?.length ? ` · ${n.merged.length + 1} merged` : ''}`)),
                ),
              ),
            );
          }),
        ),
        actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'merge-form' }, 'Merge')],
      });
    },
    onUnmerge: async (note, part) => {
      if (!(await confirmDialog(`Split "${excerpt(part)}" back into its own card? Its votes stay on the merged card.`, { confirmLabel: 'Split' }))) return;
      if (await attempt(() => post(`/api/sprints/${state.sprint.id}/notes/${note.id}/unmerge`, { mergedId: part.id }), 'Note split back')) refresh();
    },
    onVote: async (note) => {
      if (await attempt(() => post(`/api/sprints/${state.sprint.id}/notes/${note.id}/vote`))) refresh();
    },
    onUnvote: async (note) => {
      if (await attempt(() => del(`/api/sprints/${state.sprint.id}/notes/${note.id}/vote`))) refresh();
    },
    onDelete: async (note) => {
      if (!(await confirmDialog('Remove this note?', { danger: true, confirmLabel: 'Remove' }))) return;
      if (await attempt(() => del(`/api/sprints/${state.sprint.id}/notes/${note.id}`))) refresh();
    },
    onEdit: (note) => {
      const m = modal({
        title: 'Edit note',
        body: h(
          'form',
          {
            id: 'note-form',
            class: 'stack',
            onSubmit: async (e) => {
              e.preventDefault();
              const data = Object.fromEntries(new FormData(e.target));
              if (await attempt(() => patch(`/api/sprints/${state.sprint.id}/notes/${note.id}`, data))) {
                m.close();
                refresh();
              }
            },
          },
          field('Text', h('textarea', { name: 'text', rows: 4, required: true, maxlength: 2000 }, note.text)),
          field('Column', h('select', { name: 'columnId' }, state.sprint.columns.map((c) => h('option', { value: c.id, selected: c.id === note.columnId }, c.title)))),
        ),
        actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'note-form' }, 'Save')],
      });
    },
  };

  // ---------------------------------------------------- admin actions
  const sprintUrl = `/api/sprints/${params.sprintId}`;

  const toggleAnonymous = () =>
    attempt(() => patch(sprintUrl, { anonymous: !state.sprint.anonymous }), state.sprint.anonymous ? 'Authors visible' : 'Authors hidden').then(refresh);

  const toggleHidden = () => attempt(() => patch(sprintUrl, { hidden: !state.sprint.hidden }), state.sprint.hidden ? 'Notes revealed' : 'Notes hidden').then(refresh);

  const setVotes = (n) => attempt(() => patch(sprintUrl, { votesPerUser: Number(n) }), 'Votes updated').then(refresh);

  const shareDialog = () => {
    const render = (url) =>
      url
        ? h(
            'div',
            { class: 'stack' },
            h('p', { class: 'muted small' }, 'Anyone with this link can view the board without editing anything. Hidden notes stay hidden.'),
            h('div', { class: 'copy-row' }, h('input', { readonly: true, value: url, onFocus: (e) => e.target.select(), 'aria-label': 'Public link' }), button('Copy', { iconName: 'copy', onClick: () => copyText(url) })),
            button('Disable link', {
              variant: 'danger-ghost',
              onClick: async () => {
                await attempt(() => post(`${sprintUrl}/share`, { enabled: false }), 'Link disabled');
                m.setBody(render(null));
                refresh();
              },
            }),
          )
        : h(
            'div',
            { class: 'stack' },
            h('p', { class: 'muted small' }, 'Create a read-only link to share the retro with people outside the team.'),
            button('Create view-only link', {
              variant: 'primary',
              iconName: 'link',
              onClick: async () => {
                const r = await attempt(() => post(`${sprintUrl}/share`, { enabled: true }));
                if (r) {
                  m.setBody(render(r.url));
                  refresh();
                }
              },
            }),
          );
    const current = state.sprint.shareToken ? `${location.origin}${location.pathname}#/s/${state.sprint.shareToken}` : null;
    const m = modal({ title: 'Share board', body: render(current) });
  };

  const columnsDialog = () => {
    let cols = state.sprint.columns.map((c) => ({ ...c }));
    // with notes on the board there must be a column to keep them in
    const minCols = state.notes.length ? 1 : 0;
    const list = h('div', { class: 'stack-sm' });
    const palette = ['#22c55e', '#ef4444', '#3b82f6', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f3652b'];
    const draw = () =>
      mount(
        list,
        cols.length
          ? cols.map((c, i) =>
              h(
                'div',
                { class: 'col-edit' },
                h('input', { type: 'color', value: c.color, 'aria-label': 'Color', onInput: (e) => (c.color = e.target.value) }),
                h('input', { value: c.title, maxlength: 60, 'aria-label': 'Title', placeholder: 'Column title', onInput: (e) => (c.title = e.target.value) }),
                button('', { iconName: 'x', variant: 'ghost', size: 'xs', title: 'Remove column', disabled: cols.length <= minCols, onClick: () => ((cols = cols.filter((_, j) => j !== i)), draw()) }),
                h('span', { class: 'col-move' },
                  button('↑', { variant: 'ghost', size: 'xs', title: 'Move up', disabled: i === 0, onClick: () => (([cols[i - 1], cols[i]] = [cols[i], cols[i - 1]]), draw()) }),
                  button('↓', { variant: 'ghost', size: 'xs', title: 'Move down', disabled: i === cols.length - 1, onClick: () => (([cols[i + 1], cols[i]] = [cols[i], cols[i + 1]]), draw()) })),
                h('input', { class: 'col-hint', value: c.hint || '', maxlength: 120, 'aria-label': 'Prompt', placeholder: 'Prompt shown in the note box (optional), e.g. What went well?', onInput: (e) => (c.hint = e.target.value) }),
              ),
            )
          : h('p', { class: 'muted small' }, 'No columns yet. Add the first one.'),
      );
    draw();
    const m = modal({
      title: 'Board columns',
      body: [
        list,
        button('Add column', {
          iconName: 'plus',
          variant: 'ghost',
          disabled: false,
          onClick: () => {
            if (cols.length >= 8) return;
            cols.push({ id: '', title: cols.length ? 'New column' : 'Column 1', color: palette[cols.length % palette.length], hint: '' });
            draw();
            list.querySelectorAll('.col-edit input:not([type=color]):not(.col-hint)')[cols.length - 1]?.select();
          },
        }),
        h('p', { class: 'muted small' }, 'Up to 8 columns. Notes from removed columns move to the first column.'),
      ],
      actions: [
        button('Cancel', { onClick: () => m.close() }),
        button('Save columns', {
          variant: 'primary',
          onClick: async () => {
            if (await attempt(() => patch(sprintUrl, { columns: cols }), 'Columns updated')) {
              m.close();
              refresh();
            }
          },
        }),
      ],
    });
    if (!cols.length) list.parentElement?.querySelector('button')?.focus();
  };

  // Replace the columns with a template's (also how a blank retro gets a format later).
  const templateDialog = async () => {
    const templates = await attempt(loadTemplates);
    if (!templates) return;
    const form = h('form', { id: 'template-form', class: 'stack' }, templatePicker(templates, { allowBlank: false, selected: state.sprint.template }));
    const m = modal({
      title: 'Use a template',
      wide: true,
      body: [
        form,
        state.notes.length ? h('p', { class: 'muted small' }, "The board's columns are replaced. Notes in columns the template doesn't have move to its first column.") : null,
      ],
      actions: [
        button('Cancel', { onClick: () => m.close() }),
        button('Use template', {
          variant: 'primary',
          onClick: async () => {
            const template = new FormData(form).get('template');
            if (!template) return;
            if (await attempt(() => patch(sprintUrl, { template }), 'Columns updated')) {
              m.close();
              refresh();
            }
          },
        }),
      ],
    });
  };

  const editSprint = () => {
    const m = modal({
      title: 'Edit sprint',
      body: sprintForm({
        id: 'edit-sprint',
        initial: state.sprint,
        onSubmit: async (data) => {
          if (await attempt(() => patch(sprintUrl, data), 'Sprint updated')) {
            m.close();
            refresh();
          }
        },
      }),
      actions: [
        button('Delete sprint', {
          variant: 'danger-ghost',
          iconName: 'trash',
          onClick: async () => {
            if (!(await confirmDialog('Delete this sprint with all its notes, votes and action items?', { danger: true, confirmLabel: 'Delete' }))) return;
            if (await attempt(() => del(sprintUrl), 'Sprint deleted')) {
              m.close();
              location.hash = `#/boards/${state.board.id}`;
            }
          },
        }),
        h('button', { class: 'btn btn-primary', type: 'submit', form: 'edit-sprint' }, 'Save'),
      ],
    });
  };

  // Finish: write the action items first; the retro only closes when they are saved.
  const finishRetro = async () => {
    if (state.sprint.hidden) {
      const ok = await confirmDialog('To pick action items you need to read the notes. Reveal them to everyone now? (Finishing the retro reveals them anyway.)', { confirmLabel: 'Reveal notes' });
      if (!ok || !(await attempt(() => patch(sprintUrl, { hidden: false })))) return;
      await refresh();
    }
    const drafts = [];
    let saving = false;
    const saveBtn = button('Save and finish retro', {
      variant: 'primary',
      iconName: 'flag',
      onClick: async () => {
        if (saving) return;
        saving = true;
        saveBtn.disabled = true;
        const r = await attempt(() => post(`${sprintUrl}/finish`, { actions: toPayload(drafts) }), drafts.length ? `Retro finished with ${drafts.length} action item${drafts.length === 1 ? '' : 's'}` : 'Retro finished');
        saving = false;
        saveBtn.disabled = false;
        if (r) {
          drafts.length = 0;
          m.close();
          await refresh();
          resultsDialog();
        }
      },
    });
    const top = topPreview(state);
    const body = h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted small' }, 'These are the most voted items right now. Write the action items for them, then save: only then the retro is finished (notes, votes and edits lock) and the action items are created. Cancel keeps the retro open and discards what you wrote here.'),
      top.length
        ? h('ol', { class: 'results' }, top.map((note, i) => resultItem(state, note, i, draftEditor(state, note.id, drafts, () => {}))))
        : h('p', { class: 'muted' }, 'No notes in this retro.'),
    );
    const m = modal({
      title: 'Finish retro — action items',
      wide: true,
      body,
      actions: [button('Cancel', { onClick: () => close() }), saveBtn],
    });
    // closing with unsaved drafts asks first
    const close = async () => {
      if (drafts.length && !(await confirmDialog(`Discard ${drafts.length} unsaved action item${drafts.length === 1 ? '' : 's'}? The retro stays open.`, { danger: true, confirmLabel: 'Discard' }))) return;
      m.close();
    };
  };

  const reopen = async () => {
    if (await attempt(() => post(`${sprintUrl}/reopen`), 'Retro reopened')) refresh();
  };

  // The "Finalizar retro" window: top 3 voted items, each with its action items.
  // After finishing: the top 3 with their action items. New ones are drafts until saved.
  const resultsDialog = () => {
    const drafts = [];
    const saveBtn = button('Save action items', {
      variant: 'primary',
      disabled: true,
      onClick: async () => {
        if (!drafts.length) return;
        saveBtn.disabled = true;
        const r = await attempt(() => post(`${sprintUrl}/actions`, { actions: toPayload(drafts) }), `${drafts.length} action item${drafts.length === 1 ? '' : 's'} saved`);
        if (r) {
          drafts.length = 0;
          await redraw();
        } else saveBtn.disabled = false;
      },
    });
    const sync = () => (saveBtn.disabled = !drafts.length);
    const body = () => {
      const top = state.sprint.top.map((id) => state.notes.find((n) => n.id === id)).filter(Boolean);
      if (!top.length) return h('p', { class: 'muted' }, 'No notes in this retro.');
      return h(
        'ol',
        { class: 'results' },
        top.map((note, i) => {
          const actions = state.actions.filter((a) => a.noteId === note.id);
          return resultItem(
            state,
            note,
            i,
            h('ul', { class: 'actions' }, actions.map((a) => actionRow(a, state, { editable: state.canManage, onChange: redraw }))),
            state.canManage ? draftEditor(state, note.id, drafts, sync) : !actions.length ? h('p', { class: 'muted small' }, 'No action items.') : null,
          );
        }),
      );
    };
    const redraw = async () => {
      await load();
      m.setBody(body());
      sync();
      paint();
    };
    const close = async () => {
      if (drafts.length && !(await confirmDialog(`Discard ${drafts.length} unsaved action item${drafts.length === 1 ? '' : 's'}?`, { danger: true, confirmLabel: 'Discard' }))) return;
      m.close();
    };
    const m = modal({
      title: 'Retro results — top 3 voted items',
      wide: true,
      body: body(),
      onClose: () => paint(),
      actions: state.canManage ? [button('Close', { onClick: () => close() }), saveBtn] : [],
    });
  };


  // ---------------------------------------------------- pending items from previous sprint
  const reviewPending = async (action, decision) => {
    const msg = { keep: 'Carried over to this sprint', done: 'Marked as done', drop: 'Dropped' }[decision];
    if (await attempt(() => post(`${sprintUrl}/review`, { actionId: action.id, decision }), msg)) refresh();
  };

  function pendingTab() {
    const prev = state.previous;
    if (!prev) return h('div', { class: 'panel empty-panel' }, "This is the board's first sprint, so there are no previous items.");
    return h(
      'div',
      { class: 'panel' },
      h(
        'div',
        { class: 'panel-head' },
        h('div', {}, h('h3', {}, `Pending from ${prev.sprint.name}`), h('p', { class: 'muted small' }, `${fmtDate(prev.sprint.start)} → ${fmtDate(prev.sprint.end)} · unfinished action items. Do they still make sense?`)),
        h('a', { href: `#/sprint/${prev.sprint.id}`, class: 'btn btn-ghost btn-sm' }, 'Open previous sprint'),
      ),
      prev.pending.length
        ? h(
            'ul',
            { class: 'pending-list' },
            prev.pending.map((a) =>
              h(
                'li',
                { class: 'pending' },
                h('div', { class: 'action-main' }, h('span', { class: 'action-text' }, a.text), h('span', { class: 'action-meta' }, icon('user', 12), memberName(state, a.ownerId), a.due ? ` · due ${fmtDate(a.due)}` : '')),
                state.canManage
                  ? h(
                      'div',
                      { class: 'btn-group' },
                      button('Keep in this sprint', { size: 'sm', iconName: 'history', onClick: () => reviewPending(a, 'keep') }),
                      button('Already done', { size: 'sm', iconName: 'check', onClick: () => reviewPending(a, 'done') }),
                      button('No longer relevant', { size: 'sm', variant: 'danger-ghost', iconName: 'x', onClick: () => reviewPending(a, 'drop') }),
                    )
                  : badge('Pending', 'warning'),
              ),
            ),
          )
        : h('p', { class: 'muted empty-panel' }, 'All reviewed. Nothing pending from the previous sprint.'),
    );
  }

  function actionsTab() {
    const noteText = (id) => state.notes.find((n) => n.id === id)?.text;
    return h(
      'div',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', {}, h('h3', {}, 'Sprint action items'), h('p', { class: 'muted small' }, 'Includes items carried over from the previous sprint.'))),
      state.actions.length
        ? h(
            'ul',
            { class: 'actions' },
            state.actions.map((a) => actionRow(a, state, { editable: state.canManage, onChange: refresh, origin: a.noteId && noteText(a.noteId) })),
          )
        : h('p', { class: 'muted empty-panel' }, 'No action items yet.'),
      state.canManage ? actionComposer(state, null, refresh) : null,
    );
  }

  // ---------------------------------------------------- paint
  function toolbar() {
    const s = state.sprint;
    const finished = s.status === 'finished';
    const items = [];
    if (!finished) items.push(h('span', { class: 'chip' }, icon('heart', 13), `${state.myVotes.remaining} vote(s) left`));
    if (state.canManage) {
      items.push(button(s.anonymous ? 'Show authors' : 'Hide authors', { iconName: s.anonymous ? 'user' : 'userOff', onClick: toggleAnonymous, title: s.anonymous ? 'Show who wrote each card' : 'Hide who wrote each card, for everyone' }));
      if (!finished) {
        items.push(
          button(s.hidden ? 'Show notes' : 'Hide notes', { iconName: s.hidden ? 'eye' : 'eyeOff', onClick: toggleHidden }),
          h(
            'label',
            { class: 'chip chip-input', title: 'Votes per person (only the admin sees this)' },
            icon('lock', 12),
            'Votes per person',
            h('input', { type: 'number', min: 0, max: 50, value: s.votesPerUser, onChange: (e) => setVotes(e.target.value) }),
          ),
          button('Columns', { iconName: 'columns', onClick: columnsDialog }),
          button('Template', { iconName: 'board', onClick: templateDialog }),
        );
      }
      items.push(button('Share', { iconName: 'share', onClick: shareDialog }));
      items.push(finished ? button('Reopen', { variant: 'ghost', onClick: reopen }) : button('Finish retro', { variant: 'primary', iconName: 'flag', onClick: finishRetro }));
    }
    if (finished) items.push(button('View results', { variant: state.canManage ? 'default' : 'primary', iconName: 'trophy', onClick: resultsDialog }));
    return h('div', { class: 'toolbar' }, items);
  }

  function paint() {
    const s = state.sprint;
    const pendingCount = state.previous?.pending.length || 0;
    const tabs = [
      ['board', 'Board', state.notes.length],
      ['pending', 'Pending from previous sprint', pendingCount],
      ['actions', 'Action items', state.actions.length],
    ];
    mount(
      root,
      pageHeader(
        s.name,
        [state.canManage && button('', { iconName: 'settings', variant: 'icon', title: 'Edit sprint', onClick: editSprint })],
        [['Boards', '#/boards'], [state.board.name, `#/boards/${state.board.id}`], [`${fmtDate(s.start)} → ${fmtDate(s.end)}`]],
      ),
      h('div', { class: 'sprint-meta' }, statusBadge(s), s.hidden ? badge('Notes hidden', 'warning', 'eyeOff') : badge('Notes visible', 'neutral', 'eye'), s.anonymous ? badge('Authors hidden', 'warning', 'userOff') : null, s.shareToken ? badge('Public link active', 'info', 'link') : null),
      toolbar(),
      s.status === 'finished'
        ? h('div', { class: 'banner' }, icon('lock'), 'Retro finished: the board is locked for editing.')
        : pendingCount && tab === 'board'
          ? h('div', { class: 'banner banner-accent' }, icon('history'), `${pendingCount} action item(s) from the previous sprint still pending. `, h('button', { class: 'link-btn', onClick: () => ((tab = 'pending'), paint()) }, 'Review now'))
          : null,
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        tabs.map(([id, label, n]) =>
          h('button', { class: `tab${tab === id ? ' active' : ''}`, role: 'tab', 'aria-selected': String(tab === id), onClick: () => ((tab = id), paint()) }, label, h('span', { class: 'count' }, String(n))),
        ),
      ),
      tab === 'board' ? columnsView(state, noteHandlers) : tab === 'pending' ? pendingTab() : actionsTab(),
    );
  }

  await load();
  paint();
  return keepUpdated(root, refresh, `/api/sprints/${params.sprintId}/live`);
}

// ===================================================================== public read-only
export async function publicSprintView(root, { params }) {
  let state;
  const load = async () => {
    state = await get(`/api/public/${params.token}`);
    applyTheme(); // public link: the theme this browser remembers
  };
  const paint = () => {
    const s = state.sprint;
    const top = s.status === 'finished' ? s.top.map((id) => state.notes.find((n) => n.id === id)).filter(Boolean) : [];
    mount(
      root,
      h('header', { class: 'topbar' }, h('div', { class: 'topbar-left' }, logo(), h('span', { class: 'slogan' }, state.org.name)), badge('View only', 'info', 'eye')),
      h(
        'main',
        { class: 'content' },
        pageHeader(s.name, [], [[state.board.name], [`${fmtDate(s.start)} → ${fmtDate(s.end)}`]]),
        h('div', { class: 'sprint-meta' }, statusBadge(s), s.hidden ? badge('Notes hidden', 'warning', 'eyeOff') : null, s.anonymous ? badge('Authors hidden', 'warning', 'userOff') : null),
        columnsView(state, { readOnly: true }),
        top.length
          ? h(
              'section',
              { class: 'section' },
              h('h2', { class: 'section-title' }, 'Top voted items and action items'),
              h(
                'ol',
                { class: 'results panel' },
                top.map((note, i) =>
                  h(
                    'li',
                    { class: 'result' },
                    h('div', { class: 'result-head' }, h('span', { class: 'result-rank' }, `#${i + 1}`), h('div', { class: 'result-note' }, h('p', {}, note.text), h('span', { class: 'muted small' }, `${note.votes} vote(s)`))),
                    h('ul', { class: 'actions' }, state.actions.filter((a) => a.noteId === note.id).map((a) => actionRow(a, state, { editable: false, onChange: () => {} }))),
                  ),
                ),
              ),
            )
          : null,
      ),
      footer(),
    );
  };
  try {
    await load();
  } catch (e) {
    mount(root, h('div', { class: 'auth-page' }, h('div', { class: 'auth-card' }, logo(), h('h1', {}, 'Link unavailable'), h('p', { class: 'muted' }, e.message))));
    return;
  }
  document.title = `${state.sprint.name} — ${APP_NAME}`;
  paint();
  return keepUpdated(root, async () => {
    await load();
    paint();
  });
}
