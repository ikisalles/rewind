// Small DOM helpers. Everything is built with createElement/textContent,
// so user content is never interpreted as HTML.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (val === undefined || val === null) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

// Inline SVG icons (stroke style, 16px), drawn for Rewind.
const ICONS = {
  menu: 'M3 6h18M3 12h18M3 18h18',
  home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  modules: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  merge: 'M6 3v6a6 6 0 006 6h6M6 21v-6M15 12l3 3-3 3',
  userOff: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0M3 3l18 18',
  unmerge: 'M6 3v18M12 8l4-4 4 4M16 4v9a4 4 0 01-4 4H8',
  plus: 'M12 5v14M5 12h14',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6A17 17 0 002 12s3.5 7 10 7a9.7 9.7 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2',
  share: 'M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13',
  flag: 'M4 22V4m0 0h13l-2 4 2 4H4',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  columns: 'M4 4h5v16H4zM10 4h4v16h-4zM15 4h5v16h-5z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0',
  userPlus: 'M10 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0M19 8v6M16 11h6',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  board: 'M4 4h16v16H4zM4 9h16M9 9v11',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  palette: 'M12 3a9 9 0 000 18c1 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.3-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16a5 5 0 005-5c0-4.4-4-8-9-8zM7.5 12h.01M9.5 8h.01M14.5 8h.01M16.5 12h.01',
  team: 'M9 11a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6M3 20a6 6 0 0112 0m2-6a5 5 0 014 6',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  building: 'M4 21V5l8-3v19M12 9h8v12M8 8h.01M8 12h.01M8 16h.01M16 13h.01M16 17h.01',
  history: 'M3 12a9 9 0 103-6.7L3 8M3 3v5h5M12 7v5l3 3',
  trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
  github: 'M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 00-.9-2.6c3.1-.3 6.4-1.5 6.4-7A5.4 5.4 0 0020 4.8 5 5 0 0019.9 1S18.7.7 16 2.5a13.4 13.4 0 00-7 0C6.3.7 5.1 1 5.1 1A5 5 0 005 4.8a5.4 5.4 0 00-1.5 3.7c0 5.4 3.3 6.6 6.4 7a3.4 3.4 0 00-.9 2.6V22',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

export function button(label, { variant = 'default', iconName, onClick, type = 'button', title, disabled, size } = {}) {
  return h(
    'button',
    // icon-only buttons need an accessible name; a visible label already is one
    { class: `btn btn-${variant}${size ? ' btn-' + size : ''}`, type, onClick, title, 'aria-label': label ? undefined : title, disabled },
    iconName ? icon(iconName) : null,
    label ? h('span', {}, label) : null,
  );
}

export function badge(text, kind = 'neutral', iconName) {
  return h('span', { class: `badge badge-${kind}` }, iconName ? icon(iconName, 11) : null, text);
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function avatar(person, size = 22) {
  const initials = (person?.name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  if (person?.avatar) {
    return h('img', { class: 'avatar', src: person.avatar, alt: '', width: size, height: size, referrerpolicy: 'no-referrer' });
  }
  return h('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px` } }, initials);
}

// ---------------------------------------------------------------- toasts
export function toast(message, kind = 'info') {
  let host = document.querySelector('.toasts');
  if (!host) document.body.append((host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })));
  const t = h('div', { class: `toast toast-${kind}` }, message);
  host.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3600);
}

// ---------------------------------------------------------------- modal
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const content = h('div', { class: 'modal-body' }, body);
  const overlay = h(
    'div',
    { class: 'modal-overlay', onMousedown: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), button('', { iconName: 'x', variant: 'ghost', title: 'Close', onClick: close })),
      content,
      actions.length ? h('div', { class: 'modal-foot' }, actions) : null,
    ),
  );
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  overlay.querySelector('input, textarea, select')?.focus();
  return { close, content, setBody: (...c) => mount(content, ...c) };
}

export function confirmDialog(message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title: 'Confirm',
      body: h('p', { class: 'muted' }, message),
      onClose: () => !answered && resolve(false),
      actions: [
        button('Cancel', { onClick: () => m.close() }),
        button(confirmLabel, {
          variant: danger ? 'danger' : 'primary',
          onClick: () => {
            answered = true;
            m.close();
            resolve(true);
          },
        }),
      ],
    });
  });
}

// ---------------------------------------------------------------- formatting
export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const fmtDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export const today = () => new Date().toISOString().slice(0, 10);

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('Link copied', 'success'),
    () => toast("Couldn't copy", 'error'),
  );
}

export function table(headers, rows, { empty = 'Nothing here yet.' } = {}) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { class: 'empty', colspan: headers.length }, empty))),
    ),
  );
}

// Run an async action with error toast; returns the result or undefined.
export async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success, 'success');
    return r;
  } catch (e) {
    toast(e.message || 'Something went wrong', 'error');
  }
}

// ---------------------------------------------------------------- page layout
export function pageHeader(title, actions = [], crumbs = []) {
  return h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      {},
      crumbs.length ? h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, crumbs.map(([label, href]) => (href ? h('a', { href }, label) : h('span', {}, label)))) : null,
      h('h1', {}, title),
    ),
    h('div', { class: 'page-actions' }, actions),
  );
}

export function section(title, ...children) {
  return h('section', { class: 'section' }, h('h2', { class: 'section-title' }, title), children);
}

export function metric(label, value, unit) {
  return h('div', { class: 'metric' }, h('div', { class: 'metric-label' }, label), h('div', { class: 'metric-value' }, String(value), unit ? h('small', {}, unit) : null));
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
