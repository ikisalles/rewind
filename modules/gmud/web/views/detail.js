// A change's details page: header with what can be done now, and the tabs Overview, Code
// Changes, Risk & Testing, Execution, Approvals and Activity Log.
import { get, post, patch, del } from '@rewind/web/api.js';
import { h, mount, button, field, badge, attempt, icon, pageHeader, modal, table, fmtDateTime, avatar, toast } from '@rewind/web/ui.js';
import { keepUpdated } from '@rewind/web/live.js';
import {
  TYPES, CATEGORIES, LEVEL, ENVS, STRATEGIES, ROLES, STEP_STATUS, DEPLOY_STATUS, RELEASE_STATUS,
  statusBadge, levelBadge, typeBadge, pairBadge, envLabel, when, loadPeople, personById, personName, personChip, teamName, select, prose, kv, dash, approversText, decidedBy,
} from '../lib.js';
import { prDetailModal, prTable, riskMatrix } from './parts.js';

const TABS = [
  ['overview', 'Overview', 'info'],
  ['code', 'Code Changes', 'change'],
  ['risk', 'Risk & Testing', 'shield'],
  ['execution', 'Execution', 'rocket'],
  ['approvals', 'Approvals', 'check'],
  ['activity', 'Activity Log', 'history'],
];

// The page follows the change live: anyone's approval, status change, comment or deployment
// shows up here within a second (WebSocket on the change's own channel, polling as a fallback).
export async function detailView(root, { params }) {
  await loadPeople();
  let gone = false;
  const draw = async () => {
    try {
      await renderDetail(root, params, draw);
    } catch (e) {
      if (/not found/i.test(e.message) && !gone) {
        gone = true;
        toast('This change was deleted', 'info');
        location.hash = '#/changes';
        return;
      }
      throw e;
    }
  };
  await renderDetail(root, params, draw);
  return keepUpdated(root, draw, `/api/gmud/changes/${params.id}/live`, { pollMs: 15_000 });
}

// Builds the whole page off-screen, then swaps it in at once (no flicker on live refreshes).
async function renderDetail(root, params, reload) {
  const tab = TABS.some(([t]) => t === params.tab) ? params.tab : 'overview';
  const v = await get(`/api/gmud/changes/${params.id}`);
  const { change } = v;
  const o = change.overview;
  const body = h('div', { class: 'detail-body' });
  const page = h(
    'div',
    {},
    pageHeader(`${change.number} · ${o.title || 'Untitled draft'}`, actions(v, reload), [['Changes', '#/changes'], [change.number]]),
    h(
      'div',
      { class: 'card-tags detail-badges' },
      statusBadge(change.status),
      typeBadge(o.changeType),
      levelBadge(riskOf(change), 'Risk: '),
      o.environment ? badge(envLabel(o.environment), o.environment === 'production' ? 'warning' : 'neutral') : null,
      o.plannedAt ? badge(when(o.plannedAt), 'neutral', 'calendar') : null,
      o.tags.map((t) => badge(t, 'info', 'tag')),
    ),
    statusBanner(v),
    h('div', { class: 'tabs' }, TABS.map(([id, label, ic]) => h('a', { href: `#/changes/${change.id}/${id}`, class: `tab${tab === id ? ' active' : ''}` }, icon(ic, 14), label))),
    body,
  );
  await { overview, code, risk, execution, approvals, activity }[tab](body, v, reload);
  root.replaceChildren(...page.childNodes);
}

function statusBanner({ change, can, readiness }) {
  if (change.status === 'draft' && can.edit) {
    const left = readiness.missing.length;
    return h('div', { class: 'banner banner-accent' }, icon('edit'), h('span', {}, `This change is a draft${left ? ` with ${left} required item${left === 1 ? '' : 's'} left` : ', ready to submit'}. `), h('a', { href: left ? `#/changes/${change.id}/edit` : `#/changes/${change.id}/document` }, left ? 'Continue editing' : 'Review the document and submit'));
  }
  if (can.decide.length)
    return h('div', { class: 'banner banner-accent' }, icon('check'), h('span', {}, `Waiting for your decision as ${can.decide.map((r) => ROLES[r].toLowerCase()).join(' and ')}.`));
  if (change.status === 'rejected') {
    const r = [...change.approvals.decisions].reverse().find((d) => d.decision === 'rejected');
    return h('div', { class: 'banner' }, icon('x'), h('span', {}, `Rejected by ${personName(r?.userId)}: `, h('strong', {}, r?.comment || '')));
  }
  return null;
}

// ---------------------------------------------------------------- actions by status
function actions(v, reload) {
  const { change, can } = v;
  const id = change.id;
  const act = (action, label, { variant = 'default', iconName, reason = false, confirm } = {}) =>
    button(label, {
      variant,
      iconName,
      onClick: () =>
        reason || confirm
          ? reasonModal(label, reason, confirm, (comment) => post(`/api/gmud/changes/${id}/actions/${action}`, { comment }), reload)
          : attempt(() => post(`/api/gmud/changes/${id}/actions/${action}`), label).then((r) => r && reload()),
    });
  const out = [h('a', { class: 'btn btn-default', href: `#/changes/${id}/document` }, icon('file'), 'Document'), button('Comment', { iconName: 'comment', onClick: () => commentModal(id, reload) })];
  const s = change.status;
  if (can.decide.length) out.push(button('Decide', { variant: 'primary', iconName: 'check', onClick: () => decisionModal(v, reload) }));
  if (s === 'draft' && can.edit) out.push(h('a', { class: 'btn btn-primary', href: `#/changes/${id}/edit` }, icon('edit'), 'Edit draft'));
  if (can.manage) {
    if (['submitted', 'in_review'].includes(s)) out.push(act('withdraw', 'Withdraw', { iconName: 'undo', confirm: 'The change goes back to draft and the decisions so far are cleared.' }));
    if (s === 'rejected') out.push(act('revise', 'Revise', { variant: 'primary', iconName: 'edit' }));
    if (s === 'approved') out.push(act('schedule', 'Schedule', { iconName: 'calendar', confirm: `Confirm the window: ${when(change.overview.plannedAt)}.` }));
  }
  if (can.execute || can.manage) {
    if (['approved', 'scheduled'].includes(s) && can.execute) out.push(act('start', 'Start execution', { variant: 'primary', iconName: 'play' }));
    if (s === 'in_progress' && can.execute) {
      out.push(act('complete', 'Complete', { variant: 'primary', iconName: 'check', confirm: 'Releases of this change are marked as released.' }));
      out.push(act('fail', 'Mark as failed', { variant: 'danger-ghost', iconName: 'alert', reason: 'What failed?' }));
    }
    if (['in_progress', 'failed', 'completed'].includes(s) && can.execute) out.push(act('rollback', 'Roll back', { variant: 'danger-ghost', iconName: 'undo', reason: 'Why is it being rolled back?' }));
  }
  if (can.manage && ['draft', 'submitted', 'in_review', 'approved', 'scheduled'].includes(s)) out.push(act('cancel', 'Cancel change', { variant: 'danger-ghost', iconName: 'x', reason: 'Why is it cancelled?' }));
  if (can.delete) out.push(button('Delete', { variant: 'danger-ghost', iconName: 'trash', onClick: () => deleteModal(change) }));
  return out;
}

// run(comment) does the action; when it succeeds the window closes, then the page reloads
// Deleting is for good (unlike cancelling): the change, its log, releases and deployments go away.
// Admins and GMUD owners can do it in any status; a short record keeps who, when and why.
function deleteModal(change) {
  const draft = change.status === 'draft';
  const typed = h('input', { name: 'confirm', autocomplete: 'off', placeholder: change.number, 'aria-label': `Type ${change.number} to confirm` });
  const go = button('Delete for good', { variant: 'danger', iconName: 'trash', disabled: true, type: 'submit' });
  go.setAttribute('form', 'delete-form');
  typed.addEventListener('input', () => (go.disabled = typed.value.trim().toUpperCase() !== change.number));
  const m = modal({
    title: `Delete ${change.number}?`,
    body: h(
      'form',
      {
        id: 'delete-form',
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const reason = new FormData(e.target).get('reason') || '';
          const r = await attempt(() => del(`/api/gmud/changes/${change.id}`, { reason }), `${change.number} deleted`);
          if (!r) return;
          m.close();
          location.hash = '#/changes';
        },
      },
      h('p', {}, draft ? 'This draft goes away for good.' : h('span', {}, 'This is not a cancellation: the change, its activity log, releases and deployments ', h('strong', {}, 'go away for good'), '. Only a short record of who deleted it, when and why is kept.')),
      draft ? null : h('p', { class: 'muted small' }, 'To keep the history, cancel the change instead.'),
      field(draft ? 'Reason (optional)' : 'Why is it being deleted?', h('textarea', { name: 'reason', rows: 2, required: !draft, maxlength: 1000 })),
      field(`Type ${change.number} to confirm`, typed),
    ),
    actions: [button('Keep it', { onClick: () => m.close() }), go],
  });
}

function reasonModal(title, reason, confirm, run, reload) {
  const m = modal({
    title,
    body: h(
      'form',
      {
        id: 'reason-form',
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const comment = new FormData(e.target).get('comment') || '';
          const done = await attempt(() => run(comment), title);
          if (!done) return; // the error toast says why; the window stays for another try
          m.close();
          reload();
        },
      },
      confirm ? h('p', { class: 'muted' }, confirm) : null,
      field(reason || 'Comment (optional)', h('textarea', { name: 'comment', rows: 3, required: Boolean(reason), maxlength: 2000 })),
    ),
    actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: `btn ${reason ? 'btn-danger' : 'btn-primary'}`, type: 'submit', form: 'reason-form' }, title)],
  });
}

function commentModal(id, reload) {
  const m = modal({
    title: 'Comment',
    body: h(
      'form',
      {
        id: 'comment-form',
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          if (await attempt(() => post(`/api/gmud/changes/${id}/comments`, { text: new FormData(e.target).get('text') }), 'Comment added')) {
            m.close();
            reload();
          }
        },
      },
      field('Comment', h('textarea', { name: 'text', rows: 4, required: true, maxlength: 4000 }), 'Shows in the Approvals tab and the activity log.'),
    ),
    actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'comment-form' }, 'Comment')],
  });
}

function decisionModal({ change, can }, reload) {
  const m = modal({
    title: `Decide on ${change.number}`,
    body: h(
      'form',
      {
        id: 'decision-form',
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const d = Object.fromEntries(new FormData(e.target));
          const r = await attempt(() => post(`/api/gmud/changes/${change.id}/decision`, d), d.decision === 'approved' ? 'Approved' : 'Rejected');
          if (r) {
            m.close();
            reload();
          }
        },
      },
      can.decide.length > 1 ? field('As', select('role', can.decide.map((r) => [r, ROLES[r]]), can.decide[0], { empty: null })) : h('input', { type: 'hidden', name: 'role', value: can.decide[0] }),
      h('p', { class: 'muted' }, `You're deciding as ${ROLES[can.decide[0]].toLowerCase()}${can.decide.length > 1 ? ' (or pick another role above)' : ''}.`),
      h('fieldset', { class: 'checks' }, h('legend', {}, 'Decision'), h('label', {}, h('input', { type: 'radio', name: 'decision', value: 'approved', required: true }), 'Approve'), h('label', {}, h('input', { type: 'radio', name: 'decision', value: 'rejected' }), 'Reject')),
      field('Comment', h('textarea', { name: 'comment', rows: 3, maxlength: 2000 }), 'Required when rejecting.'),
    ),
    actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'decision-form' }, 'Record decision')],
  });
}

// ---------------------------------------------------------------- tabs
function overview(body, { change, requiredPreview }) {
  const o = change.overview;
  const required = change.approvals.required.length ? change.approvals.required : requiredPreview;
  mount(
    body,
    h(
      'div',
      { class: 'detail-grid' },
      h(
        'section',
        { class: 'panel stack' },
        h('div', { class: 'section-row' }, h('h3', {}, 'Description'), originBadge(change)),
        prose(change.code.summary.text || o.description),
      ),
      h(
        'section',
        { class: 'panel' },
        kv([
          ['Change ID', h('span', { class: 'mono' }, change.number)],
          ['Status', statusBadge(change.status)],
          ['Change type', typeBadge(o.changeType)],
          ['Version', change.code.repos.length ? h('div', {}, change.code.repos.map((r) => h('div', { class: 'mono small' }, `${r.repo} ${r.currentVersion || '—'} → ${r.nextVersion || '?'}`))) : dash('')],
          ['Category', dash(CATEGORIES[o.category])],
          ['Priority', levelBadge(o.priority)],
          ['Risk level', h('span', {}, levelBadge(riskOf(change)), change.risk.override || o.riskLevel ? h('span', { class: 'muted small' }, ' set by hand') : h('span', { class: 'muted small' }, ' calculated'))],
          ['Responsible', personChip(o.responsibleId)],
          ['Team', teamName(o.teamId)],
          ['Environment', envLabel(o.environment)],
          ['Planned date', when(o.plannedAt)],
          ['Requested by', personChip(change.createdBy)],
          ['Created', fmtDateTime(change.createdAt)],
          change.submittedAt && ['Submitted', fmtDateTime(change.submittedAt)],
          change.approvedAt && ['Approved', fmtDateTime(change.approvedAt)],
          ['Approvals', h('div', { class: 'card-tags' }, required.map((r) => approvalBadge(change, r)))],
        ]),
      ),
    ),
  );
}

const riskOf = (change) => change.risk.override || change.overview.riskLevel || change.risk.calculated;
const originBadge = (change) => {
  const o = change.code.summary.origin;
  return o === 'generated' ? badge('Generated suggestion', 'info', 'info') : o === 'edited' ? badge('Generated suggestion · edited', 'info', 'edit') : null;
};

const approvalBadge = (change, role) => {
  const d = change.approvals.decisions.find((x) => x.role === role);
  if (!d) return badge(`${ROLES[role]}: pending`, 'neutral', 'clock');
  return badge(`${ROLES[role]}: ${d.decision}`, d.decision === 'approved' ? 'success' : 'danger', d.decision === 'approved' ? 'check' : 'x');
};

function code(body, { change }) {
  const { repos, summary } = change.code;
  mount(
    body,
    repos.length
      ? repos.map((r) =>
          h(
            'section',
            { class: 'panel repo-card' },
            h(
              'div',
              { class: 'panel-head' },
              h('div', {}, h('h3', {}, icon(r.github ? 'github' : 'branch', 14), ' ', r.repo), h('p', { class: 'muted small' }, `${r.stats.prs} PRs · ${r.stats.commits} commits · ${r.stats.files} files`)),
              h('div', { class: 'card-tags' }, h('span', { class: 'mono' }, `${r.currentVersion || '—'} → ${r.nextVersion || '?'}`), typeBadge(r.bump), r.confirmed ? badge('Confirmed', 'success', 'check') : badge('Not confirmed', 'warning')),
            ),
            r.suggested ? h('p', { class: 'muted small suggestion' }, 'Suggested ', typeBadge(r.suggested.bump), ` — ${r.suggested.reasons.join('; ')}`) : null,
            r.prs.length ? prTable(r.prs, { onOpen: prDetailModal }) : h('p', { class: 'muted small' }, 'No pull requests linked.'),
          ),
        )
      : h('div', { class: 'panel empty-panel' }, 'No repositories linked yet.'),
    h('section', { class: 'panel stack' }, h('div', { class: 'section-row' }, h('h3', {}, 'Description'), originBadge(change)), prose(summary.text || change.overview.description)),
  );
}

function risk(body, { change }) {
  const r = change.risk;
  const t = change.testing;
  const rb = change.rollback;
  const yes = (b, label) => h('span', { class: `check-pill${b ? ' on' : ''}` }, icon(b ? 'check' : 'x', 12), label);
  mount(
    body,
    h(
      'div',
      { class: 'detail-grid' },
      h(
        'section',
        { class: 'panel stack' },
        h('h3', {}, 'Impact assessment'),
        kv([
          ['Affected systems', dash(r.affectedSystems)],
          ['Affected services', dash(r.affectedServices)],
          ['Customer impact', dash(r.customerImpact)],
          ['Expected downtime', dash(r.downtime)],
          ['Dependencies', dash(r.dependencies)],
          ['Data migration', r.dataMigration ? 'Yes' : 'No'],
        ]),
      ),
      h(
        'section',
        { class: 'panel stack' },
        h('h3', {}, 'Risk assessment'),
        riskMatrix(r.probability, r.impact),
        r.override ? h('p', { class: 'small' }, 'Risk level set by hand: ', levelBadge(r.override)) : null,
        r.justification ? prose(r.justification) : null,
        h('div', { class: 'card-tags' }, yes(r.indicators.infrastructure, 'Infrastructure'), yes(r.indicators.database, 'Database'), yes(r.indicators.api, 'API / contract'), yes(r.indicators.security, 'Security')),
      ),
    ),
    h(
      'section',
      { class: 'panel stack' },
      h('h3', {}, 'Testing & validation'),
      h('div', { class: 'card-tags' }, yes(t.unit, 'Unit'), yes(t.integration, 'Integration'), yes(t.e2e, 'E2E'), yes(t.codeReview, 'Code review'), yes(t.ciChecks, 'CI/CD checks')),
      t.evidence.length ? h('ul', { class: 'plain-list' }, t.evidence.map((e) => h('li', {}, h('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.label || e.url)))) : h('p', { class: 'muted small' }, 'No evidence links.'),
      h('div', { class: 'grid-2' }, h('div', {}, h('strong', {}, 'Acceptance criteria'), prose(t.acceptance)), h('div', {}, h('strong', {}, 'Post-deployment validation'), prose(t.postDeploy))),
    ),
    h(
      'section',
      { class: 'panel stack' },
      h('h3', {}, 'Rollback plan'),
      rb.notApplicable
        ? h('div', {}, badge('Rollback does not apply'), prose(rb.justification))
        : [
            kv([
              ['Strategy', dash(rb.strategy)],
              ['Previous version', dash(rb.previousVersion)],
              ['Owner', personChip(rb.ownerId)],
              ['Recovery time', dash(rb.recoveryTime)],
            ]),
            h('strong', {}, 'Procedure'),
            prose(rb.procedure),
            h('strong', {}, 'Rollback triggers'),
            prose(rb.triggers),
          ],
    ),
  );
}

async function execution(body, v, reload) {
  const { change, can } = v;
  const e = change.execution;
  // straight from this change's own data
  const [{ deployments: mineDeps }, { releases: mineRels }] = await Promise.all([get(`/api/gmud/changes/${change.id}/deployments`), get(`/api/gmud/changes/${change.id}/releases`)]);
  mount(
    body,
    h(
      'section',
      { class: 'panel' },
      kv([
        ['Strategy', dash(STRATEGIES[e.strategy])],
        ['Target environment', envLabel(change.overview.environment)],
        ['Planned start', when(change.overview.plannedAt)],
        ['Estimated duration', dash(e.duration)],
        ['Execution owner', personChip(e.ownerId)],
        ['Monitoring owner', personChip(e.monitoringOwnerId)],
        ['Pipeline', dash(e.pipeline)],
        ['Deployment URL', e.deploymentUrl ? h('a', { href: e.deploymentUrl, target: '_blank', rel: 'noopener' }, e.deploymentUrl) : dash('')],
        change.startedAt && ['Started', fmtDateTime(change.startedAt)],
        change.finishedAt && ['Finished', fmtDateTime(change.finishedAt)],
      ]),
    ),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, 'Execution checklist'), can.execute ? null : h('span', { class: 'muted small' }, 'Tracked once the change is approved.')),
      h('div', { class: 'panel list-panel' }, e.steps.length ? e.steps.map((s, i) => stepRow(change, s, i, can.execute, reload)) : h('p', { class: 'muted empty-panel' }, 'No steps.')),
    ),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, `Releases (${mineRels.length})`), h('a', { href: '#/releases', class: 'small' }, 'All releases →')),
      mineRels.length ? releaseTable(mineRels) : h('p', { class: 'muted small' }, 'Releases are planned when the change is approved: one per repository.'),
    ),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, `Deployments (${mineDeps.length})`), can.execute ? button('Register deployment', { iconName: 'rocket', onClick: () => deploymentModal(change, mineRels, reload) }) : null),
      mineDeps.length ? deploymentTable(mineDeps, reload) : h('p', { class: 'muted small' }, 'No deployments registered. Rewind records deployments, it does not run them.'),
    ),
  );
}

function stepRow(change, s, i, editable, reload) {
  const open = () => {
    const m = modal({
      title: `Step ${i + 1}: ${s.title}`,
      body: h(
        'form',
        {
          id: 'step-form',
          class: 'stack',
          onSubmit: async (e) => {
            e.preventDefault();
            if (await attempt(() => patch(`/api/gmud/changes/${change.id}/steps/${s.id}`, Object.fromEntries(new FormData(e.target))), 'Step updated')) {
              m.close();
              reload();
            }
          },
        },
        s.detail ? h('p', { class: 'muted' }, s.detail) : null,
        field('Status', select('status', STEP_STATUS, s.status, { empty: null })),
        field('Evidence (link)', h('input', { name: 'evidence', type: 'url', value: s.evidence, placeholder: 'https://…' })),
        field('Notes', h('textarea', { name: 'notes', rows: 3, maxlength: 1000 }, s.notes)),
      ),
      actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'step-form' }, 'Save')],
    });
  };
  return h(
    'div',
    { class: 'list-row step-line' },
    h('span', { class: 'list-icon mono' }, String(i + 1)),
    h(
      'div',
      { class: 'list-text' },
      h('div', { class: 'strong' }, s.title),
      h('div', { class: 'muted small' }, [s.detail, s.ownerId && `Owner: ${personName(s.ownerId)}`, s.eta && `ETA ${when(s.eta)}`].filter(Boolean).join(' · ')),
      s.notes ? h('div', { class: 'small' }, s.notes) : null,
      s.evidence ? h('a', { href: s.evidence, target: '_blank', rel: 'noopener', class: 'small' }, 'Evidence →') : null,
    ),
    h('div', { class: 'btn-group' }, pairBadge(STEP_STATUS, s.status), editable ? button('Update', { size: 'sm', onClick: open }) : null),
  );
}

export function releaseTable(list, { onOpen } = {}) {
  return table(
    ['Repository', 'Version', 'Type', 'Change', 'Status', 'Created', 'Released'],
    list.map((r) =>
      h(
        'tr',
        { class: onOpen ? 'row-link' : '', onClick: onOpen ? () => onOpen(r) : undefined },
        h('td', {}, r.repo),
        h('td', { class: 'mono nowrap' }, `${r.previousVersion || '—'} → `, h('strong', {}, r.version)),
        h('td', {}, typeBadge(r.bump)),
        h('td', { class: 'mono nowrap' }, h('a', { href: `#/changes/${r.changeId}`, onClick: (e) => e.stopPropagation() }, r.changeNumber)),
        h('td', {}, pairBadge(RELEASE_STATUS, r.status)),
        h('td', { class: 'nowrap small' }, fmtDateTime(r.createdAt)),
        h('td', { class: 'nowrap small' }, r.releasedAt ? fmtDateTime(r.releasedAt) : '—'),
      ),
    ),
  );
}

export function deploymentTable(list, reload, { showChange = false } = {}) {
  return table(
    [showChange ? 'Change' : null, 'Environment', 'Releases', 'Status', 'Started', 'Finished', 'By', ''].filter(Boolean),
    list.map((d) =>
      h(
        'tr',
        {},
        showChange ? h('td', { class: 'mono nowrap' }, h('a', { href: `#/changes/${d.changeId}/execution` }, d.changeNumber)) : null,
        h('td', {}, envLabel(d.environment)),
        h('td', { class: 'small' }, d.releases.map((r) => `${r.repo.split('/').pop()} ${r.version}`).join(', ') || '—'),
        h('td', {}, pairBadge(DEPLOY_STATUS, d.status)),
        h('td', { class: 'nowrap small' }, d.startedAt ? fmtDateTime(d.startedAt) : '—'),
        h('td', { class: 'nowrap small' }, d.finishedAt ? fmtDateTime(d.finishedAt) : '—'),
        h('td', { class: 'nowrap' }, personChip(d.createdBy)),
        h('td', { class: 'right' }, button('Open', { size: 'sm', onClick: () => openDeployment(d, reload) })),
      ),
    ),
  );
}

function deploymentModal(change, releases, reload) {
  const m = modal({
    title: 'Register deployment',
    body: h(
      'form',
      {
        id: 'dep-form',
        class: 'stack',
        onSubmit: async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const body = { environment: fd.get('environment'), status: fd.get('status'), url: fd.get('url'), notes: fd.get('notes'), releaseIds: fd.getAll('releaseIds') };
          if (await attempt(() => post(`/api/gmud/changes/${change.id}/deployments`, body), 'Deployment registered')) {
            m.close();
            reload();
          }
        },
      },
      h('div', { class: 'grid-2' }, field('Environment', select('environment', ENVS, change.overview.environment, { empty: null })), field('Status', select('status', DEPLOY_STATUS, 'planned', { empty: null }))),
      releases.length ? h('fieldset', { class: 'checks' }, h('legend', {}, 'Releases'), releases.map((r) => h('label', {}, h('input', { type: 'checkbox', name: 'releaseIds', value: r.id, checked: true }), `${r.repo} ${r.version}`))) : null,
      field('Workflow / run URL', h('input', { name: 'url', type: 'url', placeholder: 'https://github.com/…/actions/runs/…' })),
      field('Notes', h('textarea', { name: 'notes', rows: 2, maxlength: 2000 })),
      h('p', { class: 'muted small' }, 'A deployment that starts moves an approved change to “in progress”. A failed deployment does not invalidate its releases.'),
    ),
    actions: [button('Cancel', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'dep-form' }, 'Register')],
  });
}

// lists hold summaries: the history comes from the change the deployment belongs to
async function openDeployment(d, reload) {
  if (d.history) return deploymentDetail(d, reload);
  const r = await attempt(() => get(`/api/gmud/changes/${d.changeId}/deployments`));
  const full = r?.deployments.find((x) => x.id === d.id);
  if (full) deploymentDetail(full, reload);
}

export function deploymentDetail(d, reload) {
  const m = modal({
    title: `Deployment · ${d.changeNumber} → ${envLabel(d.environment)}`,
    wide: true,
    body: [
      h(
        'form',
        {
          id: 'dep-update',
          class: 'stack',
          onSubmit: async (e) => {
            e.preventDefault();
            const r = await attempt(() => patch(`/api/gmud/deployments/${d.id}`, Object.fromEntries(new FormData(e.target))), 'Deployment updated');
            if (r) {
              m.close();
              reload();
            }
          },
        },
        h('div', { class: 'grid-2' }, field('Status', select('status', DEPLOY_STATUS, d.status, { empty: null })), field('Workflow / run URL', h('input', { name: 'url', type: 'url', value: d.url }))),
        field('Note for this update', h('input', { name: 'note', maxlength: 500, placeholder: 'e.g. canary at 10%, error rate normal' })),
      ),
      h('strong', {}, 'History'),
      h('ul', { class: 'timeline' }, [...d.history].reverse().map((x) => h('li', {}, h('span', { class: 'tl-dot' }), h('div', {}, pairBadge(DEPLOY_STATUS, x.status), ' ', h('span', { class: 'muted small' }, `${fmtDateTime(x.at)} · ${personName(x.by)}`), x.note ? h('div', { class: 'small' }, x.note) : null)))),
    ],
    actions: [button('Close', { onClick: () => m.close() }), h('button', { class: 'btn btn-primary', type: 'submit', form: 'dep-update' }, 'Save')],
  });
}

async function approvals(body, v, reload) {
  const { change, can, requiredPreview } = v;
  const [{ settings }, { events }] = await Promise.all([get('/api/gmud/settings'), get(`/api/gmud/changes/${change.id}/activity`)]);
  const required = change.approvals.required.length ? change.approvals.required : requiredPreview;
  const comments = events.filter((e) => e.type === 'comment' || (e.type === 'decision' && e.comment));
  mount(
    body,
    h(
      'section',
      { class: 'panel list-panel' },
      kvRow('Requested by', personChip(change.createdBy), change.submittedAt ? `Submitted ${fmtDateTime(change.submittedAt)}` : 'Not submitted yet'),
      required.map((role) => {
        const d = change.approvals.decisions.find((x) => x.role === role);
        const who = approversText(settings, role);
        return h(
          'div',
          { class: 'list-row' },
          h('span', { class: 'list-icon' }, icon(role === 'security' ? 'shield' : 'check')),
          h('div', { class: 'list-text' }, h('div', { class: 'strong' }, ROLES[role]), h('div', { class: 'muted small' }, d ? `${decidedBy(d)} · ${fmtDateTime(d.at)}` : `Can decide: ${who}`), d?.comment ? h('div', { class: 'small' }, `“${d.comment}”`) : null),
          approvalBadge(change, role),
        );
      }),
    ),
    can.decide.length ? h('div', { class: 'section-row', style: { marginTop: '12px' } }, h('span', {}, 'Your decision is pending.'), button('Decide', { variant: 'primary', iconName: 'check', onClick: () => decisionModal(v, reload) })) : null,
    h(
      'section',
      { class: 'section', style: { marginTop: '24px' } },
      h('div', { class: 'section-row' }, h('h2', { class: 'section-title' }, `Comments (${comments.length})`), button('Comment', { size: 'sm', iconName: 'comment', onClick: () => commentModal(change.id, reload) })),
      comments.length ? h('div', { class: 'comment-list' }, comments.map((e) => h('div', { class: 'comment' }, avatar(personById(e.by) || { name: '?' }, 26), h('div', {}, h('div', { class: 'small' }, h('strong', {}, personName(e.by)), h('span', { class: 'muted' }, ` · ${fmtDateTime(e.at)}`), e.type === 'decision' ? [' ', badge(e.decision, e.decision === 'approved' ? 'success' : 'danger')] : null), h('div', { class: 'prose' }, e.type === 'comment' ? e.message : e.comment))))) : h('p', { class: 'muted small' }, 'No comments yet.'),
    ),
  );
}

const kvRow = (label, value, hint) => h('div', { class: 'list-row' }, h('span', { class: 'list-icon' }, icon('user')), h('div', { class: 'list-text' }, h('div', { class: 'strong' }, label), h('div', { class: 'muted small' }, hint)), value);

const EVENT_ICON = { created: 'plus', edited: 'edit', status: 'flag', decision: 'check', comment: 'comment', release: 'tag', deployment: 'rocket', step: 'list' };
const LABELS = { calculated: 'calculated risk', override: 'risk level (by hand)', summary: 'description', plannedAt: 'planned date', responsibleId: 'responsible', teamId: 'team', ownerId: 'owner', monitoringOwnerId: 'monitoring owner', repos: 'repositories', notApplicable: 'rollback not applicable' };
const fieldLabel = (f) => LABELS[f.split('.').pop()] || f.split('.').pop().replace(/([A-Z])/g, ' $1').toLowerCase();
const fieldValue = (field, v) => {
  if (v === '' || v === undefined || v === null) return '—';
  const key = field.split('.').pop();
  if (key === 'plannedAt') return when(v);
  if (['responsibleId', 'teamId', 'ownerId'].includes(key)) return key === 'teamId' ? teamName(v) : personName(v);
  const maps = { changeType: TYPES, category: CATEGORIES, priority: LEVEL, riskLevel: LEVEL, override: LEVEL, environment: ENVS, strategy: STRATEGIES, probability: LEVEL, impact: LEVEL };
  const m = maps[key]?.[v];
  return Array.isArray(m) ? m[0] : m || String(v);
};

async function activity(body, { change }) {
  const { events } = await get(`/api/gmud/changes/${change.id}/activity`);
  mount(
    body,
    h(
      'ul',
      { class: 'timeline activity' },
      events.map((e) =>
        h(
          'li',
          {},
          h('span', { class: 'tl-icon' }, icon(EVENT_ICON[e.type] || 'info', 14)),
          h(
            'div',
            { class: 'tl-body' },
            h('div', {}, h('strong', {}, personName(e.by)), ' ', e.type === 'comment' ? 'commented' : e.message, h('span', { class: 'muted small' }, ` · ${fmtDateTime(e.at)}`)),
            e.type === 'comment' ? h('div', { class: 'prose small' }, e.message) : null,
            e.type === 'decision' && e.comment ? h('div', { class: 'small' }, `“${e.comment}”`) : null,
            e.changes?.length
              ? h('ul', { class: 'plain-list small muted' }, e.changes.map((c) => h('li', {}, 'from' in c ? [fieldLabel(c.field), ': ', h('s', {}, fieldValue(c.field, c.from)), ' → ', h('span', { class: 'strong' }, fieldValue(c.field, c.to))] : `${fieldLabel(c.field)} changed`)))
              : null,
          ),
        ),
      ),
    ),
  );
}
