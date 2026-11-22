// Shared pieces of the Engineering Metrics pages: catalog, labels, value
// formatting, a small SVG sparkline and the CSV download.
import { get, apiUrl, session } from '@rewind/web/api.js';
import { h, badge, toast } from '@rewind/web/ui.js';

let catalog = null;
export async function loadCatalog(force = false) {
  if (!catalog || force) catalog = await get('/api/metrics/catalog');
  return catalog;
}
export const cat = () => catalog || { definitions: [], teams: [], groups: [], linkTargets: {} };

export const STATUS = {
  ok: ['Data OK', 'success'],
  partial: ['Partial data', 'warning'],
  insufficient_sample: ['Sample too small', 'neutral'],
  no_source: ['No data source', 'danger'],
  no_scope: ['No repositories mapped', 'neutral'],
};
export const statusBadge = (s) => badge(...(STATUS[s] || [s, 'neutral']));
export const SOURCE_STATUS = { ok: ['Healthy', 'success'], error: ['Failing', 'danger'], never: ['Never synced', 'neutral'] };
export const EXPERIMENT_STATUS = { planned: ['Planned', 'neutral'], running: ['Running', 'accent'], concluded: ['Concluded', 'success'], abandoned: ['Abandoned', 'neutral'] };
export const EVENT_LABEL = { pull_request: 'Pull request', deployment: 'Deployment', incident: 'Incident' };
export const LEAD_TIME_STARTS = { first_commit: 'First commit', pr_opened: 'Pull request opened', pr_merged: 'Pull request merged' };
export const LOWER_IS_BETTER = ['lead_time', 'change_failure_rate', 'mttr', 'pr_cycle_time'];

export const defName = (key) => cat().definitions.find((d) => d.key === key)?.name || key;

export function fmtValue(v, unit) {
  if (v === null || v === undefined) return '—';
  if (unit === 'hours' && v >= 48) return `${Math.round((v / 24) * 10) / 10} d`;
  if (unit === 'hours') return `${v} h`;
  if (unit === '%') return `${v}%`;
  return String(v);
}
export const unitShort = (unit) => (unit === 'hours' || unit === '%' ? '' : unit);

export function scopeLabel(type, id) {
  if (type === 'org') return 'Organization';
  const list = type === 'team' ? cat().teams : cat().groups;
  return list.find((x) => x.id === id)?.name || '—';
}

// Weekly series; gaps (null) break the line instead of being drawn as zero.
export function sparkline(series, { width = 160, height = 36 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('class', 'metrics-spark');
  svg.setAttribute('role', 'img');
  const vals = series.map((p) => p.value);
  const known = vals.filter((v) => v !== null && v !== undefined);
  svg.setAttribute('aria-label', known.length ? `Weekly values: ${vals.map((v) => v ?? 'no data').join(', ')}` : 'No data');
  if (!known.length) return svg;
  const max = Math.max(...known, 0.0001);
  const step = series.length > 1 ? width / (series.length - 1) : width;
  let d = '';
  let pen = false;
  vals.forEach((v, i) => {
    if (v === null || v === undefined) return (pen = false);
    const x = Math.round(i * step * 10) / 10;
    const y = Math.round((height - 3 - (v / max) * (height - 6)) * 10) / 10;
    d += `${pen ? 'L' : 'M'}${x} ${y} `;
    pen = true;
  });
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d.trim());
  svg.append(path);
  return svg;
}

export async function downloadCsv(path, filename) {
  const res = await fetch(apiUrl(path), { headers: { authorization: `Bearer ${session.get()}` } });
  if (!res.ok) return toast((await res.json().catch(() => ({}))).error || 'Export failed', 'error');
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

export function select(name, options, value, { empty = null, ...attrs } = {}) {
  const entries = Array.isArray(options) ? options : Object.entries(options).map(([v, l]) => [v, Array.isArray(l) ? l[0] : l]);
  return h('select', { name, ...attrs }, empty !== null ? h('option', { value: '' }, empty) : null, entries.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

export const today = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
export const val = (form, name) => form.querySelector(`[name="${name}"]`)?.value || '';
