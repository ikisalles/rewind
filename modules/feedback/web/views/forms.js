// Modals: give kudos, give feedback, ask for feedback, answer a request.
import { post } from '@rewind/web/api.js';
import { h, mount, button, field, modal } from '@rewind/web/ui.js';
import { audiencePicker, cat, linksPicker, load, peoplePicker } from '../lib.js';

function formModal({ title, body, submitLabel, onSubmit }) {
  const msg = h('div', {});
  const form = h('form', { class: 'fb-form' }, body, msg);
  const m = modal({ title, wide: true, body: form, actions: [button('Cancel', { onClick: () => m.close() }), button(submitLabel, { variant: 'primary', onClick: () => form.requestSubmit() })] });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(msg);
    try {
      await onSubmit(form);
      m.close();
    } catch (x) {
      mount(msg, h('p', { class: 'fb-error', role: 'alert' }, x.message));
    }
  });
}
const ta = (name, placeholder, rows = 3) => h('textarea', { name, rows, placeholder });
const val = (form, name) => form.querySelector(`[name="${name}"]`)?.value || '';

export async function giveKudos({ recipientId, onSaved } = {}) {
  await load();
  const pick = peoplePicker(new Set(recipientId ? [recipientId] : []));
  const aud = audiencePicker({ kind: 'recognition', types: cat().recognitionAudiences, recipients: pick.selected });
  pick.el.addEventListener('change', () => aud.refresh());
  const links = linksPicker();
  formModal({
    title: 'Recognize someone',
    submitLabel: 'Send recognition',
    body: [
      field('Who', pick.el),
      field('Category', h('select', { name: 'category', required: true }, cat().categories.map((c) => h('option', { value: c.key }, c.label)))),
      field('Context', ta('context', 'Where / when did it happen?', 2)),
      field('Contribution you observed', ta('contribution', 'What exactly did they do?')),
      field('Impact', ta('impact', 'What changed because of it?', 2)),
      links.el,
      aud.el,
    ],
    onSubmit: async (form) => {
      const r = await post('/api/feedback/recognitions', { recipientIds: [...pick.selected], category: val(form, 'category'), context: val(form, 'context'), contribution: val(form, 'contribution'), impact: val(form, 'impact'), audience: aud.value, links: links.value() });
      onSaved?.(r.recognition);
    },
  });
}

const feedbackFields = () => [
  h('p', { class: 'fb-hint' }, 'A useful shape (optional): context → observed behavior → impact → next step.'),
  field('Situation / context', ta('situation', 'When and where', 2)),
  field('Observed behavior', ta('behavior', 'What you saw or heard — facts, not judgements')),
  field('Impact', ta('impact', 'What effect it had', 2)),
  field('Suggestion or question', ta('suggestion', 'Next step, idea or question', 2)),
];
const feedbackBody = (form) => ({ situation: val(form, 'situation'), behavior: val(form, 'behavior'), impact: val(form, 'impact'), suggestion: val(form, 'suggestion') });

export async function giveFeedback({ recipientId, onSaved } = {}) {
  await load();
  const pick = peoplePicker(new Set(recipientId ? [recipientId] : []));
  const aud = audiencePicker({ kind: 'feedback', types: cat().feedbackAudiences, recipients: pick.selected });
  pick.el.addEventListener('change', () => aud.refresh());
  const links = linksPicker();
  formModal({
    title: 'Give feedback',
    submitLabel: 'Send feedback',
    body: [
      field('To', pick.el),
      field('Kind', h('select', { name: 'kind' }, [['offered', 'Offered'], ['continuous', 'Continuous'], ['after_event', 'After an event']].map(([v, l]) => h('option', { value: v }, l)))),
      ...feedbackFields(),
      links.el,
      aud.el,
    ],
    onSubmit: async (form) => {
      const r = await post('/api/feedback/feedback', { ...feedbackBody(form), kind: val(form, 'kind'), recipientIds: [...pick.selected], audience: aud.value, links: links.value() });
      onSaved?.(r.feedback);
    },
  });
}

export async function askFeedback({ onSaved } = {}) {
  await load();
  const pick = peoplePicker();
  formModal({
    title: 'Ask for feedback',
    submitLabel: 'Send request',
    body: [
      field('Question', h('input', { name: 'question', required: true, maxlength: 1000, placeholder: 'What would you like to know?' })),
      field('Context', ta('context', 'Optional', 2)),
      field('Ask', pick.el),
      field('Due date (optional)', h('input', { name: 'dueDate', type: 'date' })),
      h('label', { class: 'fb-row' }, h('input', { type: 'checkbox', name: 'remind', checked: true }), 'Remind them until they answer'),
      h('p', { class: 'fb-hint' }, 'Answers are visible only to you and to each person who answers.'),
    ],
    onSubmit: async (form) => {
      const r = await post('/api/feedback/requests', { question: val(form, 'question'), context: val(form, 'context'), recipientIds: [...pick.selected], dueDate: val(form, 'dueDate') || null, remind: form.querySelector('[name="remind"]').checked });
      onSaved?.(r.request);
    },
  });
}

export async function answerRequest(request, onSaved) {
  await load();
  formModal({
    title: `Answer: ${request.question}`,
    submitLabel: 'Send answer',
    body: [...feedbackFields(), h('p', { class: 'fb-hint' }, 'Only the person who asked will see your answer.')],
    onSubmit: async (form) => {
      await post(`/api/feedback/requests/${request.id}/responses`, feedbackBody(form));
      onSaved?.();
    },
  });
}
