// The change as a document: what approvers will read, laid out like a printed page. Before a
// draft is submitted this is the last step (preview, then "Submit for approval"); at any time it
// can be saved as PDF (the browser's print dialog) or downloaded as a Word document.
import { get, post } from '@rewind/web/api.js';
import { h, mount, button, attempt, icon, fmtDateTime } from '@rewind/web/ui.js';
import { store } from '@rewind/web/app.js';
import {
  STATUS, TYPES, CATEGORIES, LEVEL, LIKELIHOOD, ENVS, STRATEGIES, ROLES, STEP_STATUS,
  loadPeople, personName, teamName, approversText, decidedBy,
} from '../lib.js';

const STEP_NAMES = { overview: 'Overview', code: 'Code & Changes', risk: 'Risk & Testing', execution: 'Execution', approval: 'Approval' };

// The document's own look (also embedded in the Word file): fixed "paper" colors, not the app theme.
const DOC_CSS = `
.doc-sheet { background: #ffffff; color: #1a1a1a; font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.45; }
.doc-sheet h1 { font-size: 18pt; margin: 0 0 4pt; color: #111111; }
.doc-sheet h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #999999; color: #111111; }
.doc-sheet h3 { font-size: 11pt; margin: 10pt 0 4pt; color: #222222; }
.doc-sheet p { margin: 0 0 6pt; }
.doc-sheet table { width: 100%; border-collapse: collapse; margin: 4pt 0 8pt; font-size: 10pt; }
.doc-sheet th, .doc-sheet td { border: 1px solid #bbbbbb; padding: 4pt 6pt; text-align: left; vertical-align: top; }
.doc-sheet th { background: #f0f0f0; font-weight: bold; }
.doc-sheet .doc-meta th { width: 28%; }
.doc-sheet .doc-kicker { font-family: Arial, sans-serif; font-size: 9pt; letter-spacing: 1px; text-transform: uppercase; color: #555555; margin: 0 0 6pt; }
.doc-sheet .doc-sub { color: #444444; margin: 0 0 12pt; }
.doc-sheet .doc-text { white-space: pre-wrap; }
.doc-sheet .doc-muted { color: #666666; }
.doc-sheet .doc-mono { font-family: 'Courier New', monospace; font-size: 9.5pt; }
.doc-sheet ul { margin: 0 0 6pt; padding-left: 18pt; }
.doc-sheet .doc-stamp { display: inline-block; border: 2px solid #b45309; color: #b45309; padding: 2pt 8pt; font-family: Arial, sans-serif; font-size: 9pt; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; }
.doc-sheet .doc-foot { margin-top: 24pt; padding-top: 6pt; border-top: 1px solid #cccccc; font-size: 8.5pt; color: #777777; }
`;

const v = (x) => (x === null || x === undefined || x === '' ? '—' : x);
const label = (map, key) => (key ? (Array.isArray(map[key]) ? map[key][0] : map[key]) || key : '—');
const when = (local) => (local ? fmtDateTime(local) : '—');
const check = (b) => (b ? '☑' : '☐');
const table = (head, rows, cls) => h('table', { class: cls }, head ? h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))) : null, h('tbody', {}, rows));
const meta = (pairs) => table(null, pairs.filter(Boolean).map(([k, val]) => h('tr', {}, h('th', {}, k), h('td', {}, val))), 'doc-meta');
const text = (t) => (t ? h('p', { class: 'doc-text' }, t) : h('p', { class: 'doc-muted' }, 'Not filled in.'));

function buildDocument(view, settings) {
  const { change } = view;
  const o = change.overview;
  const r = change.risk;
  const t = change.testing;
  const rb = change.rollback;
  const e = change.execution;
  const risk = r.override || o.riskLevel || r.calculated;
  const required = change.approvals.required.length ? change.approvals.required : view.requiredPreview;
  const repos = change.code.repos;
  const isDraft = change.status === 'draft';

  return h(
    'article',
    { class: 'doc-sheet' },
    h('p', { class: 'doc-kicker' }, `${store.me.org.name} · Change request (GMUD)`),
    h('h1', {}, `${change.number} — ${o.title || 'Untitled'}`),
    h('p', { class: 'doc-sub' }, isDraft ? h('span', { class: 'doc-stamp' }, 'Preview — not submitted') : `Status: ${label(STATUS, change.status)}`),
    meta([
      ['Change ID', change.number],
      ['Requested by', personName(change.createdBy)],
      ['Responsible', personName(o.responsibleId)],
      ['Team', teamName(o.teamId)],
      ['Category', label(CATEGORIES, o.category)],
      ['Priority', label(LEVEL, o.priority)],
      ['Change type (SemVer)', label(TYPES, o.changeType)],
      ['Risk level', `${label(LEVEL, risk)}${r.override || o.riskLevel ? ' (set by hand)' : risk ? ' (likelihood × impact)' : ''}`],
      ['Environment', label(ENVS, o.environment)],
      ['Planned window', when(o.plannedAt)],
      o.tags.length && ['Tags', o.tags.join(', ')],
      ['Created', fmtDateTime(change.createdAt)],
      change.submittedAt && ['Submitted', fmtDateTime(change.submittedAt)],
    ]),

    h('h2', {}, '1. Description'),
    text(change.code.summary?.text || o.description),

    h('h2', {}, '2. Scope: repositories and versions'),
    repos.length
      ? table(
          ['Repository', 'Current', 'Next', 'Increment', 'Pull requests'],
          repos.map((x) => h('tr', {}, h('td', {}, x.repo), h('td', { class: 'doc-mono' }, v(x.currentVersion)), h('td', { class: 'doc-mono' }, `${v(x.nextVersion)}${x.confirmed ? '' : ' (not confirmed)'}`), h('td', {}, label(TYPES, x.bump)), h('td', {}, String(x.prs.length)))),
        )
      : h('p', { class: 'doc-muted' }, 'No repositories.'),
    repos
      .filter((x) => x.prs.length)
      .map((x) => [
        h('h3', {}, x.repo),
        table(
          ['PR', 'Title', 'Author', 'Reviews', 'Checks'],
          x.prs.map((p) =>
            h(
              'tr',
              {},
              h('td', { class: 'doc-mono' }, p.url ? h('a', { href: p.url }, `#${p.number}`) : `#${p.number}`),
              h('td', {}, p.title, p.labels?.length ? h('span', { class: 'doc-muted' }, ` [${p.labels.join(', ')}]`) : null),
              h('td', {}, p.author ? `@${p.author}` : '—'),
              h('td', {}, p.approvals ? `${p.approvals} approved` : p.reviewers?.length ? `${p.reviewers.length} reviewer(s)` : 'none'),
              h('td', {}, !p.checks || !p.checks.total ? '—' : p.checks.state === 'success' ? `${p.checks.passed}/${p.checks.total} passed` : p.checks.state === 'failure' ? `${p.checks.failed} failed` : 'pending'),
            ),
          ),
        ),
      ]),

    h('h2', {}, '3. Impact and risk'),
    meta([
      ['Affected systems', v(r.affectedSystems)],
      ['Affected services', v(r.affectedServices)],
      ['Customer impact', v(r.customerImpact)],
      ['Expected downtime', v(r.downtime)],
      ['Dependencies', v(r.dependencies)],
      ['Data migration', r.dataMigration ? 'Yes' : 'No'],
      ['Likelihood of failure', label(LIKELIHOOD, r.probability)],
      ['Impact if it fails', label(LIKELIHOOD, r.impact)],
      ['Risk level', label(LEVEL, risk)],
      ['Touches', [r.indicators?.infrastructure && 'infrastructure', r.indicators?.database && 'database', r.indicators?.api && 'API / contract', r.indicators?.security && 'security'].filter(Boolean).join(', ') || 'None flagged'],
    ]),
    r.justification ? [h('h3', {}, 'Justification'), text(r.justification)] : null,

    h('h2', {}, '4. Testing and validation'),
    h('p', {}, `${check(t.unit)} Unit tests   ${check(t.integration)} Integration tests   ${check(t.e2e)} E2E tests   ${check(t.codeReview)} Code review   ${check(t.ciChecks)} CI/CD checks passed`),
    t.evidence.length ? [h('h3', {}, 'Evidence'), h('ul', {}, t.evidence.map((x) => h('li', {}, h('a', { href: x.url }, x.label || x.url))))] : null,
    h('h3', {}, 'Acceptance criteria'),
    text(t.acceptance),
    h('h3', {}, 'Post-deployment validation'),
    text(t.postDeploy),

    h('h2', {}, '5. Rollback plan'),
    rb.notApplicable
      ? [h('p', {}, 'Rollback does not apply to this change.'), text(rb.justification)]
      : [
          meta([
            ['Strategy', v(rb.strategy)],
            ['Previous version / stable artifact', v(rb.previousVersion)],
            ['Owner', personName(rb.ownerId)],
            ['Estimated recovery time', v(rb.recoveryTime)],
          ]),
          h('h3', {}, 'Procedure'),
          text(rb.procedure),
          h('h3', {}, 'Rollback triggers'),
          text(rb.triggers),
        ],

    h('h2', {}, '6. Execution plan'),
    meta([
      ['Deployment strategy', label(STRATEGIES, e.strategy)],
      ['Target environment', label(ENVS, o.environment)],
      ['Planned start', when(o.plannedAt)],
      ['Estimated duration', v(e.duration)],
      ['Execution owner', personName(e.ownerId)],
      ['Monitoring owner', personName(e.monitoringOwnerId)],
      ['Deployment pipeline', v(e.pipeline)],
      ['Deployment URL', e.deploymentUrl ? h('a', { href: e.deploymentUrl }, e.deploymentUrl) : '—'],
    ]),
    e.steps.length
      ? table(
          ['#', 'Step', 'Owner', 'Estimated time', 'Status'],
          e.steps.map((s, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, s.title, s.detail ? h('div', { class: 'doc-muted' }, s.detail) : null), h('td', {}, personName(s.ownerId)), h('td', {}, when(s.eta)), h('td', {}, label(STEP_STATUS, s.status)))),
        )
      : null,

    h('h2', {}, '7. Approvals'),
    table(
      ['Role', 'Who can approve', 'Decision', 'By', 'Date', 'Comment'],
      required.map((role) => {
        const d = change.approvals.decisions.find((x) => x.role === role);
        return h('tr', {}, h('td', {}, ROLES[role]), h('td', {}, approversText(settings, role)), h('td', {}, d ? (d.decision === 'approved' ? 'Approved' : 'Rejected') : 'Pending'), h('td', {}, d ? decidedBy(d) : ''), h('td', {}, d ? fmtDateTime(d.at) : ''), h('td', {}, d?.comment || ''));
      }),
    ),
    h('p', { class: 'doc-muted' }, settings.allowSelfApproval ? 'Self-approval is allowed by the company rules.' : 'The requester cannot approve their own change.'),

    h('p', { class: 'doc-foot' }, `Generated by Rewind on ${fmtDateTime(new Date().toISOString())} · ${change.number}`),
  );
}

function downloadWord(sheet, number) {
  const html = `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${number}</title><style>@page { size: A4; margin: 2cm; } body { margin: 0; } ${DOC_CSS}</style></head><body>${sheet.outerHTML}</body></html>`;
  const url = URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' }));
  const a = h('a', { href: url, download: `${number}.doc` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function printPdf(number) {
  const title = document.title;
  document.title = number; // the PDF's default file name
  window.print();
  document.title = title;
}

export async function documentView(root, { params }) {
  await loadPeople();
  const [view, { settings }] = await Promise.all([get(`/api/gmud/changes/${params.id}`), get('/api/gmud/settings')]);
  const { change, can, readiness } = view;
  const draftForMe = change.status === 'draft' && can.edit;
  if (!document.getElementById('gmud-doc-css')) document.head.append(h('style', { id: 'gmud-doc-css' }, DOC_CSS));

  const sheet = buildDocument(view, settings);
  const missing = draftForMe ? readiness.missing : [];
  mount(
    root,
    h(
      'div',
      { class: 'doc-toolbar' },
      h(
        'div',
        {},
        h('nav', { class: 'crumbs' }, h('a', { href: '#/changes' }, 'Changes'), h('a', { href: `#/changes/${change.id}` }, change.number), h('span', {}, 'Document')),
        h('h1', {}, draftForMe ? 'Review before submitting' : 'Change document'),
      ),
      h(
        'div',
        { class: 'page-actions' },
        draftForMe ? h('a', { class: 'btn btn-default', href: `#/changes/${change.id}/edit?step=approval` }, icon('edit'), 'Back to editing') : h('a', { class: 'btn btn-default', href: `#/changes/${change.id}` }, 'Back to the change'),
        button('Save as PDF', { iconName: 'download', onClick: () => printPdf(change.number) }),
        button('Download Word', { iconName: 'file', onClick: () => downloadWord(sheet, change.number) }),
        draftForMe
          ? button('Submit for approval', {
              variant: 'primary',
              iconName: 'send',
              disabled: Boolean(missing.length),
              onClick: async () => {
                const r = await attempt(() => post(`/api/gmud/changes/${change.id}/submit`), 'Submitted for approval');
                if (r) location.hash = `#/changes/${change.id}`;
              },
            })
          : null,
      ),
    ),
    missing.length
      ? h(
          'div',
          { class: 'banner banner-accent doc-alert' },
          icon('alert'),
          h('div', {}, h('strong', {}, `${missing.length} required item${missing.length === 1 ? '' : 's'} left before submitting: `), missing.map((m, i) => [i ? ' · ' : '', h('a', { href: `#/changes/${change.id}/edit?step=${m.step}` }, `${m.message} (${STEP_NAMES[m.step]})`)])),
        )
      : draftForMe
        ? h('p', { class: 'muted small doc-alert' }, 'This is exactly what approvers will read. Check it, then submit.')
        : null,
    h('div', { class: 'doc-wrap' }, sheet),
  );
}
