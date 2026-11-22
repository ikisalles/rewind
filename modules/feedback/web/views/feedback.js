// Feedback: received / sent / requests, one feedback (discussed, next steps),
// one request (answers, close), and personal history with notes.
import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, pageHeader, section, attempt, confirmDialog, fmtDate, fmtDateTime, badge, field, modal, table } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import { KINDS, REQUEST_STATUS, audienceText, cat, categoryLabel, linkChip, load, names, personChip, personName, prose } from '../lib.js';
import { answerRequest, askFeedback, giveFeedback, giveKudos } from './forms.js';
import { recognitionCard } from './kudos.js';

const tabs = (active) =>
  h('nav', { class: 'fb-tabs' }, [['#/feedback', 'Feedback & requests', 'main'], ['#/feedback/history', 'My history & next steps', 'history'], ['#/kudos', 'Kudos', 'kudos']].map(([href, label, id]) => h('a', { href, class: id === active ? 'on' : '' }, label)));

function feedbackCard(f) {
  const me = store.me.user.id;
  return h(
    'article',
    { class: 'fb-card' },
    h('div', { class: 'fb-card-head' }, f.authorId === me ? h('span', {}, 'You → ', h('strong', {}, names(f.recipientIds))) : [personChip(f.authorId), h('span', { class: 'muted' }, '→ you')], badge(KINDS[f.kind] || f.kind), f.discussedBy.length ? badge('Discussed', 'success') : null),
    f.situation ? [h('div', { class: 'fb-label' }, 'Situation'), prose(f.situation)] : null,
    f.behavior ? [h('div', { class: 'fb-label' }, 'Observed behavior'), prose(f.behavior)] : null,
    f.impact ? [h('div', { class: 'fb-label' }, 'Impact'), prose(f.impact)] : null,
    f.suggestion ? [h('div', { class: 'fb-label' }, 'Suggestion / question'), prose(f.suggestion)] : null,
    f.links?.length ? h('div', { class: 'fb-meta' }, f.links.map(linkChip)) : null,
    h('div', { class: 'fb-meta' }, h('a', { href: `#/feedback/${f.id}` }, fmtDateTime(f.createdAt)), h('span', {}, `Visible to: ${audienceText(f.audience)}${f.audience.type !== 'private' ? ' (as of sending)' : ''}`)),
  );
}

export async function feedbackView(root) {
  await load();
  const draw = async () => {
    const [{ feedback }, { sent, received }] = await Promise.all([get('/api/feedback/history'), get('/api/feedback/requests')]);
    const me = store.me.user.id;
    const pending = received.filter((r) => !r.answeredByMe && ['open', 'answered'].includes(r.status));
    const reqRow = (r, mine) =>
      h('tr', { class: 'row-link', onClick: () => (location.hash = `#/feedback/requests/${r.id}`) },
        h('td', {}, h('a', { href: `#/feedback/requests/${r.id}` }, r.question)),
        h('td', {}, mine ? names(r.recipientIds) : personName(r.authorId)),
        h('td', { class: 'nowrap' }, fmtDate(r.dueDate)),
        h('td', {}, badge(...(REQUEST_STATUS[r.status] || [r.status])), mine ? h('span', { class: 'muted' }, ` ${r.answeredBy.length}/${r.recipientIds.length} answered`) : null));
    mount(
      root,
      pageHeader('Feedback', [
        button('Give feedback', { variant: 'primary', iconName: 'comment', onClick: () => giveFeedback({ onSaved: draw }) }),
        button('Ask for feedback', { iconName: 'send', onClick: () => askFeedback({ onSaved: draw }) }),
        button('Recognize someone', { iconName: 'heart', onClick: () => giveKudos() }),
      ]),
      tabs('main'),
      pending.length ? section(`Waiting for your answer (${pending.length})`, table(['Question', 'From', 'Due', 'Status'], pending.map((r) => reqRow(r, false)))) : null,
      section('Received', (() => { const l = feedback.filter((f) => f.recipientIds.includes(me)); return l.length ? h('div', { class: 'fb-feed' }, l.map(feedbackCard)) : h('p', { class: 'muted' }, 'Nothing received yet.'); })()),
      section('Sent', (() => { const l = feedback.filter((f) => f.authorId === me); return l.length ? h('div', { class: 'fb-feed' }, l.map(feedbackCard)) : h('p', { class: 'muted' }, 'Nothing sent yet.'); })()),
      section('My requests', table(['Question', 'Asked', 'Due', 'Status'], sent.map((r) => reqRow(r, true)), { empty: 'You haven\'t asked for feedback yet.' })),
    );
  };
  await draw();
}

export async function feedbackDetailView(root, { params }) {
  await load();
  const me = store.me.user.id;
  const draw = async () => {
    const v = await get(`/api/feedback/feedback/${params.id}`).catch(() => null);
    if (!v) return mount(root, pageHeader('Feedback', [], [['Feedback', '#/feedback']]), h('p', { class: 'muted' }, "This feedback doesn't exist or isn't visible to you."));
    const f = v.feedback;
    const participant = f.authorId === me || f.recipientIds.includes(me);
    const discussed = f.discussedBy.includes(me);
    mount(
      root,
      pageHeader('Feedback', participant ? [
        button(discussed ? 'Mark as not discussed' : 'Mark as discussed', { iconName: 'check', onClick: async () => (await attempt(() => post(`/api/feedback/feedback/${f.id}/discussed`, { discussed: !discussed }))) && draw() }),
        button('Add next step', { iconName: 'plus', onClick: () => commitmentForm(f, draw) }),
        f.authorId === me && !f.readBy.length ? button('Edit', { iconName: 'edit', onClick: () => editFeedback(f, draw) }) : null,
        f.authorId === me ? button('Delete', { variant: 'danger', onClick: async () => (await confirmDialog('Delete this feedback?', { danger: true, confirmLabel: 'Delete' })) && (await attempt(() => del(`/api/feedback/feedback/${f.id}`), 'Deleted')) && (location.hash = '#/feedback') }) : null,
      ] : [], [['Feedback', '#/feedback']]),
      feedbackCard(f),
      f.revisions.length ? h('p', { class: 'fb-hint' }, `Edited ${f.revisions.length} time(s) before being read; previous versions are kept.`) : null,
      section('Next steps', commitmentsTable(v.commitments, draw)),
    );
  };
  await draw();
}

function editFeedback(f, done) {
  const fields = ['situation', 'behavior', 'impact', 'suggestion'];
  const inputs = Object.fromEntries(fields.map((k) => [k, h('textarea', { rows: 3 }, f[k] || '')]));
  const m = modal({
    title: 'Edit feedback',
    wide: true,
    body: h('div', { class: 'fb-form' }, h('p', { class: 'fb-hint' }, 'You can edit until it is read. Previous versions are kept.'), fields.map((k) => field(k[0].toUpperCase() + k.slice(1), inputs[k]))),
    actions: [button('Cancel', { onClick: () => m.close() }), button('Save', { variant: 'primary', onClick: async () => { if (await attempt(() => patch(`/api/feedback/feedback/${f.id}`, Object.fromEntries(fields.map((k) => [k, inputs[k].value]))), 'Saved')) { m.close(); done(); } } })],
  });
}

function commitmentForm(f, done) {
  const title = h('input', { maxlength: 300, placeholder: 'What will be done?' });
  const owner = h('select', {}, [f.authorId, ...f.recipientIds].map((id) => h('option', { value: id }, personName(id))));
  const due = h('input', { type: 'date' });
  const m = modal({
    title: 'Next step',
    body: h('div', { class: 'fb-form' }, field('Next step', title), field('Responsible', owner), field('Due date', due), h('p', { class: 'fb-hint' }, 'Next steps are only created this way — never automatically.')),
    actions: [button('Cancel', { onClick: () => m.close() }), button('Add', { variant: 'primary', onClick: async () => { if (await attempt(() => post('/api/feedback/commitments', { title: title.value, ownerId: owner.value, dueDate: due.value || null, feedbackId: f?.id }), 'Next step added')) { m.close(); done(); } } })],
  });
}

function commitmentsTable(list, done) {
  const STATUS = { open: 'Open', done: 'Done', dropped: 'Dropped' };
  return table(['Next step', 'Responsible', 'Due', 'Status'], list.map((x) =>
    h('tr', {}, h('td', {}, x.title), h('td', {}, personChip(x.ownerId)), h('td', { class: 'nowrap' }, fmtDate(x.dueDate)),
      h('td', {}, h('select', { onChange: async (e) => (await attempt(() => patch(`/api/feedback/commitments/${x.id}`, { status: e.target.value }))) && done() }, Object.entries(STATUS).map(([k, v]) => h('option', { value: k, selected: k === x.status }, v)))))),
  { empty: 'No next steps.' });
}

export async function requestDetailView(root, { params }) {
  await load();
  const me = store.me.user.id;
  const draw = async () => {
    const v = await get(`/api/feedback/requests/${params.id}`).catch(() => null);
    if (!v) return mount(root, pageHeader('Feedback request', [], [['Feedback', '#/feedback']]), h('p', { class: 'muted' }, "This request doesn't exist or isn't visible to you."));
    const { request: r, responses } = v;
    const mine = r.authorId === me;
    const live = ['open', 'answered'].includes(r.status);
    mount(
      root,
      pageHeader(r.question, [
        !mine && live ? button(r.answeredBy.includes(me) ? 'Answer again' : 'Answer', { variant: 'primary', onClick: () => answerRequest(r, draw) }) : null,
        mine && live ? button('Close', { onClick: async () => (await attempt(() => patch(`/api/feedback/requests/${r.id}`, { status: 'closed' }), 'Request closed')) && draw() }) : null,
        mine && live ? button('Withdraw', { variant: 'ghost', onClick: async () => (await attempt(() => patch(`/api/feedback/requests/${r.id}`, { status: 'cancelled' }), 'Request withdrawn')) && draw() }) : null,
      ], [['Feedback', '#/feedback']]),
      h('div', { class: 'fb-meta' }, badge(...(REQUEST_STATUS[r.status] || [r.status])), h('span', {}, `Asked by ${personName(r.authorId)}`), h('span', {}, `To ${names(r.recipientIds)}`), r.dueDate ? h('span', {}, `Due ${fmtDate(r.dueDate)}`) : null),
      prose(r.context),
      section(mine ? `Answers (${responses.length})` : 'Your answers', responses.length ? h('div', { class: 'fb-feed' }, responses.map(feedbackCard)) : h('p', { class: 'muted' }, 'No answers yet.')),
    );
  };
  await draw();
}

export async function historyView(root) {
  await load();
  const state = { from: '', to: '', q: '', category: '', kind: '' };
  const body = h('div', {});
  const draw = async () => {
    const p = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
    const [{ recognitions, feedback }, { commitments }, { notes }] = await Promise.all([get(`/api/feedback/history?${p}`), get('/api/feedback/commitments'), get('/api/feedback/notes')]);
    mount(
      body,
      section(`Next steps (${commitments.length})`, commitmentsTable(commitments, draw)),
      section(`Feedback (${feedback.length})`, feedback.length ? h('div', { class: 'fb-feed' }, feedback.map(feedbackCard)) : h('p', { class: 'muted' }, 'Nothing in this period.')),
      section(`Recognitions (${recognitions.length})`, recognitions.length ? h('div', { class: 'fb-feed' }, recognitions.map((r) => recognitionCard(r, draw))) : h('p', { class: 'muted' }, 'Nothing in this period.')),
      section('My private notes (1:1 preparation)', notesBlock(notes, draw)),
    );
  };
  const inp = (key, attrs) => h('input', { ...attrs, value: state[key], onChange: (e) => ((state[key] = e.target.value), draw()) });
  mount(
    root,
    pageHeader('My history', [button('Export my data (JSON)', { iconName: 'download', onClick: exportMine })]),
    tabs('history'),
    h('div', { class: 'fb-row' },
      inp('from', { type: 'date', title: 'From' }), inp('to', { type: 'date', title: 'To' }), inp('q', { type: 'search', placeholder: 'Search text' }),
      h('select', { onChange: (e) => ((state.category = e.target.value), draw()) }, h('option', { value: '' }, 'Any kudos category'), cat().categories.map((c) => h('option', { value: c.key }, c.label))),
      h('select', { onChange: (e) => ((state.kind = e.target.value), draw()) }, h('option', { value: '' }, 'Any feedback kind'), Object.entries(KINDS).map(([k, v]) => h('option', { value: k }, v)))),
    body,
  );
  await draw();
}

function notesBlock(notes, done) {
  const text = h('textarea', { rows: 3, placeholder: 'Topics for your next 1:1… Only you can see these notes.' });
  return [
    h('div', { class: 'fb-form' }, text, h('div', {}, button('Save note', { size: 'sm', onClick: async () => (await attempt(() => post('/api/feedback/notes', { text: text.value }), 'Note saved')) && done() }))),
    notes.map((n) => h('div', { class: 'fb-card' }, prose(n.text), h('div', { class: 'fb-meta' }, fmtDateTime(n.createdAt), button('Delete', { size: 'sm', variant: 'ghost', onClick: async () => (await attempt(() => del(`/api/feedback/notes/${n.id}`))) && done() })))),
  ];
}

async function exportMine() {
  const data = await attempt(() => get('/api/feedback/export'));
  if (!data) return;
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: `my-feedback-${data.exportedAt.slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
}

export { categoryLabel };
