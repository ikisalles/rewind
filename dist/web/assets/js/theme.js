// Theme tokens. The defaults follow the dark console look; a deployment can
// override them in config.js (REWIND_CONFIG.theme) and each company admin can
// override them again in Administration → Appearance.

export const TOKENS = [
  { key: 'bg', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'surface2', label: 'Raised surface' },
  { key: 'border', label: 'Borders' },
  { key: 'text', label: 'Text' },
  { key: 'muted', label: 'Secondary text' },
  { key: 'accent', label: 'Accent' },
  { key: 'accentText', label: 'Text on accent' },
  { key: 'success', label: 'Success' },
  { key: 'danger', label: 'Error' },
  { key: 'link', label: 'Links' },
];

export const PRESETS = {
  'Dark (default)': {
    bg: '#121212', surface: '#171717', surface2: '#1f1f1f', border: '#2b2b2b', text: '#ededed',
    muted: '#a3a3a3', accent: '#f3652b', accentText: '#ffffff', success: '#22c55e', danger: '#ef4444', link: '#7ab8ff',
  },
  Light: {
    bg: '#f6f6f5', surface: '#ffffff', surface2: '#f1f1ef', border: '#e2e2df', text: '#1a1a1a',
    muted: '#666666', accent: '#e4561d', accentText: '#ffffff', success: '#15803d', danger: '#dc2626', link: '#1d64d8',
  },
  Ocean: {
    bg: '#0b1220', surface: '#0f172a', surface2: '#16213a', border: '#24324f', text: '#e6edf7',
    muted: '#94a3b8', accent: '#38bdf8', accentText: '#04121f', success: '#34d399', danger: '#f87171', link: '#7dd3fc',
  },
};

export const DEFAULT_THEME = PRESETS['Dark (default)'];

const cssVar = (key) => '--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export function applyTheme(orgTheme = {}) {
  const theme = { ...DEFAULT_THEME, ...(window.REWIND_CONFIG?.theme || {}), ...orgTheme };
  const root = document.documentElement;
  for (const { key } of TOKENS) root.style.setProperty(cssVar(key), theme[key]);
  // derived tones
  root.style.setProperty('--accent-soft', theme.accent + '22');
  root.style.setProperty('--success-soft', theme.success + '22');
  root.style.setProperty('--danger-soft', theme.danger + '22');
  // native controls (date pickers, scrollbars) follow the background brightness
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.bg.slice(i, i + 2), 16));
  root.style.colorScheme = root.dataset.scheme = 0.299 * r + 0.587 * g + 0.114 * b > 140 ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
  return theme;
}
