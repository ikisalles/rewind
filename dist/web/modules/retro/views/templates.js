// Template picker: "From a template" (cards with each template's columns) or "Start blank".
import { get } from '@rewind/web/api.js';
import { h } from '@rewind/web/ui.js';

let cache;
export const loadTemplates = async () => (cache ??= (await get('/api/retro/templates')).templates);

// Radio inputs named `template`: a template id, or "blank" when `allowBlank` is on.
export function templatePicker(templates, { selected = templates[0]?.id, allowBlank = true } = {}) {
  const grid = h(
    'div',
    { class: 'template-grid', role: 'radiogroup', 'aria-label': 'Templates' },
    templates.map((t) =>
      h(
        'label',
        { class: 'template-card' },
        h('input', { type: 'radio', name: 'template', value: t.id, checked: t.id === selected }),
        h('span', { class: 'template-name' }, t.name),
        h('span', { class: 'template-desc muted small' }, t.description),
        h(
          'span',
          { class: 'template-cols' },
          t.columns.map((c) => h('span', { class: 'template-col', style: { '--col': c.color }, title: c.hint }, c.title)),
        ),
      ),
    ),
  );
  if (!allowBlank) return grid;

  // the two ways to start; the template grid only applies to the first one
  const mode = (value, title, hint, checked) =>
    h(
      'label',
      { class: 'start-mode' },
      h('input', { type: 'radio', name: 'startMode', value, checked, onChange: sync }),
      h('span', {}, h('strong', {}, title), h('span', { class: 'muted small block' }, hint)),
    );
  const wrap = h(
    'div',
    { class: 'stack' },
    h(
      'fieldset',
      { class: 'start-modes' },
      h('legend', { class: 'field-label' }, 'How do you want to start the retro?'),
      mode('template', 'From a template', 'Pick a ready-made format; you can still edit the columns later.', selected !== 'blank'),
      mode('blank', 'Start blank', 'The retro opens with no columns and you add them yourself.', selected === 'blank'),
    ),
    grid,
  );
  function sync() {
    const blank = wrap.querySelector('input[name=startMode]:checked')?.value === 'blank';
    grid.hidden = blank;
    grid.querySelectorAll('input').forEach((i) => (i.disabled = blank));
  }
  sync();
  return wrap;
}

// Reads the choice from a form built with templatePicker().
export function pickedTemplate(form) {
  const fd = new FormData(form);
  return fd.get('startMode') === 'blank' ? 'blank' : fd.get('template');
}
