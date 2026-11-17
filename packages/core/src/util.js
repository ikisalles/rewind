// Small helpers shared by the core and the modules.

export const now = () => new Date().toISOString();
export const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');
export const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
export const isColor = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
export const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);

// "Acme", " ACME " and "Ácme" are the same company name.
export const normalizeOrgName = (name) =>
  String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
