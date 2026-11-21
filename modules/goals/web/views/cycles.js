// Company settings → Goal cycles: create, publish and archive cycles, and run
// the cycle review (final status, learnings and destination of each objective).
import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, field, modal, table, section, attempt, confirmDialog, fmtDate, fmtDateTime } from '@rewind/web/ui.js';
import { CYCLE_KINDS, CYCLE_STATUS, OBJECTIVE_STATUS, FINAL, formData, input, pairBadge, select, statusBadge, textarea, loadDirectory, personName } from '../lib.js';

export async function cyclesTab(root, reload) {
  const [{ cycles }, catalog] = await Promise.all([get('/api/goals/cycles'), get('/api/goals/catalog'), loadDirectory()]);
  if (!catalog.can.manageCycles) return mount(root, h('p', { class: 'muted' }, 'Only goal admins can manage cycles.'));
  mount(
    root,
    section(
      'Goal cycles',
      h('p', { class: 'muted' }, 'Planning and review periods. Draft → In review → Published → Closed (after the cycle review).'),
      h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
        button('New cycle', { variant: 'primary', iconName: 'plus', onClick: () => cycleForm(null, reload) }),
        catalog.can.export ? button('Export (JSON)', { iconName: 'download', onClick: () => exportJson() }) : null,
      ),
      table(
        ['Cycle', 'Kind', 'Dates', 'Status', ''],
        cycles.map((c) =>
          h(
            'tr',
            {},
            h('td', {}, h('strong', {}, c.name), c.review ? h('div', { class: 'muted', style: { fontSize: '12px' } }, `Reviewed ${fmtDateTime(c.review.closedAt)} by ${personName(c.review.closedBy)}`) : null),
            h('td', {}, CYCLE_KINDS[c.kind] || c.kind),
            h('td', { class: 'nowrap' }, `${fmtDate(c.startDate)} – ${fmtDate(c.endDate)}`),
            h('td', {}, pairBadge(CYCLE_STATUS, c.status)),
            h(
              'td',
              { class: 'nowrap' },
              c.status !== 'archived'
                ? [
                    button('Edit', { size: 'sm', onClick: () => cycleForm(c, reload) }),
                    button('Review & close', { size: 'sm', onClick: () => closeForm(c, cycles, reload) }),
                    button('', {
                      iconName: 'trash', variant: 'ghost', title: 'Delete',
                      onClick: async () => (await confirmDialog(`Delete cycle "${c.name}"? Only cycles without objectives can be deleted.`, { danger: true, confirmLabel: 'Delete' })) && (await attempt(() => del(`/api/goals/cycles/${c.id}`), 'Cycle deleted')) && reload(),
                    }),
                  ]
                : c.review
                  ? button('See review', { size: 'sm', onClick: () => showReview(c) })
                  : null,
            ),
          ),
        ),
        { empty: 'No cycles yet.' },
      ),
    ),
  );
}

async function exportJson() {
  const data = await attempt(() => get('/api/goals/export'));
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `goals-${data.exportedAt.slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
}

function cycleForm(cycle, reload) {
  const c = cycle || { kind: 'quarter', status: 'draft' };
  const msg = h('div', {});
  const form = h(
    'form',
    { class: 'goals-form' },
    h('div', { class: 'wide' }, field('Name', input('name', c.name, { required: true, maxlength: 120, placeholder: '2026 Q1' }))),
    field('Kind', select('kind', CYCLE_KINDS, c.kind)),
    field('Status', select('status', Object.fromEntries(Object.entries(CYCLE_STATUS).filter(([k]) => k !== 'archived')), c.status)),
    field('Start', input('startDate', c.startDate, { type: 'date', required: true })),
    field('End', input('endDate', c.endDate, { type: 'date', required: true })),
    h('div', { class: 'wide' }, field('Template / guidance', textarea('template', c.template, { placeholder: 'e.g. 3–5 objectives per team, 2–4 KRs each' }))),
    h('div', { class: 'wide' }, field('Closing rules', textarea('closingRules', c.closingRules, { placeholder: 'e.g. ≥ 70% = achieved; review in the last week' }))),
    h('div', { class: 'wide' }, msg),
  );
  const m = modal({
    title: cycle ? 'Edit cycle' : 'New cycle',
    wide: true,
    body: form,
    actions: [button('Cancel', { onClick: () => m.close() }), button('Save', { variant: 'primary', onClick: () => form.requestSubmit() })],
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = formData(form);
      if (cycle) await patch(`/api/goals/cycles/${cycle.id}`, d);
      else await post('/api/goals/cycles', d);
      m.close();
      reload();
    } catch (x) {
      mount(msg, h('p', { class: 'goals-error' }, x.message));
    }
  });
}

// Final statuses are chosen by people — nothing is decided automatically.
async function closeForm(cycle, cycles, reload) {
  const { objectives } = await get(`/api/goals/objectives?cycleId=${cycle.id}`);
  const finals = Object.fromEntries(Object.entries(OBJECTIVE_STATUS).filter(([k]) => FINAL.includes(k) && k !== 'archived'));
  const next = cycles.filter((c) => c.id !== cycle.id && c.status !== 'archived');
  const msg = h('div', {});
  const rows = objectives.map((o) =>
    h(
      'div',
      { class: 'goals-kr', 'data-id': o.id },
      h('div', { class: 'goals-kr-head' }, h('strong', {}, o.title), statusBadge(o.status)),
      h(
        'div',
        { class: 'goals-form' },
        field('Final status', select(`status:${o.id}`, finals, FINAL.includes(o.status) ? o.status : (o.progress?.ratio ?? 0) >= 1 ? 'achieved' : 'partially_achieved')),
        field('Destination', select(`destination:${o.id}`, { close: 'Close', carry_over: 'Carry over to the next cycle', archive: 'Archive' }, 'close')),
        h('div', { class: 'wide' }, field('Result', textarea(`result:${o.id}`, '', { rows: 2 }))),
        h('div', { class: 'wide' }, field('Learnings', textarea(`learnings:${o.id}`, '', { rows: 2 }))),
      ),
    ),
  );
  const form = h(
    'form',
    {},
    h('p', { class: 'muted' }, `${objectives.length} objective(s) in this cycle. Check-ins and history are kept.`),
    field('Next cycle (for carried-over objectives)', select('nextCycleId', next.map((c) => [c.id, c.name]), null, { empty: '—' })),
    field('Cycle summary', textarea('summary', '')),
    field('Cycle learnings', textarea('learnings', '')),
    rows,
    msg,
  );
  const m = modal({
    title: `Review & close: ${cycle.name}`,
    wide: true,
    body: form,
    actions: [button('Cancel', { onClick: () => m.close() }), button('Close cycle', { variant: 'primary', onClick: () => form.requestSubmit() })],
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(form);
    const outcomes = objectives.map((o) => ({
      objectiveId: o.id,
      status: d[`status:${o.id}`],
      destination: d[`destination:${o.id}`],
      result: d[`result:${o.id}`],
      learnings: d[`learnings:${o.id}`],
    }));
    try {
      await post(`/api/goals/cycles/${cycle.id}/close`, { summary: d.summary, learnings: d.learnings, nextCycleId: d.nextCycleId || null, outcomes });
      m.close();
      reload();
    } catch (x) {
      mount(msg, h('p', { class: 'goals-error' }, x.message));
    }
  });
}

function showReview(c) {
  modal({
    title: `Review: ${c.name}`,
    body: h(
      'div',
      {},
      h('strong', {}, 'Summary'),
      h('p', { class: 'goals-prose' }, c.review.summary || '—'),
      h('strong', {}, 'Learnings'),
      h('p', { class: 'goals-prose' }, c.review.learnings || '—'),
      h('p', { class: 'muted' }, `${c.review.carried?.length || 0} objective(s) carried over.`),
      h('a', { href: '#/goals' }, 'See objectives'),
    ),
  });
}
