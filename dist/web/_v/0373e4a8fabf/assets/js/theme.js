// Themes. Each person picks one in My account → Appearance (saved on their account, so it follows
// them on any browser); it applies to them only. The browser also remembers the last one, so the
// sign-in page and the first paint already use it.
//
// A deployment can still tweak the default (dark) theme in config.js (REWIND_CONFIG.theme).

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

export const THEMES = {
  dark: {
    label: 'Dark',
    colors: {
      bg: '#121212', surface: '#171717', surface2: '#1f1f1f', border: '#2b2b2b', text: '#ededed',
      muted: '#a3a3a3', accent: '#f3652b', accentText: '#ffffff', success: '#22c55e', danger: '#ef4444', link: '#7ab8ff',
    },
  },
  light: {
    label: 'Light',
    colors: {
      bg: '#f6f6f5', surface: '#ffffff', surface2: '#f1f1ef', border: '#e2e2df', text: '#1a1a1a',
      muted: '#666666', accent: '#e4561d', accentText: '#ffffff', success: '#15803d', danger: '#dc2626', link: '#1d64d8',
    },
  },
  ocean: {
    label: 'Ocean',
    colors: {
      bg: '#0b1220', surface: '#0f172a', surface2: '#16213a', border: '#24324f', text: '#e6edf7',
      muted: '#94a3b8', accent: '#38bdf8', accentText: '#04121f', success: '#34d399', danger: '#f87171', link: '#7dd3fc',
    },
  },
};

export const DEFAULT_THEME_ID = 'dark';
const STORAGE_KEY = 'rewind.theme';

const cssVar = (key) => '--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// The colors of a theme (the deployment's tweaks apply to the default one).
export function themeColors(id) {
  const known = THEMES[id] ? id : DEFAULT_THEME_ID;
  return { ...THEMES[known].colors, ...(known === DEFAULT_THEME_ID ? window.REWIND_CONFIG?.theme || {} : {}) };
}

export function rememberedTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

// applyTheme(id): the person's theme; without an id, the one this browser remembers.
export function applyTheme(id) {
  const themeId = THEMES[id] ? id : THEMES[rememberedTheme()] ? rememberedTheme() : DEFAULT_THEME_ID;
  const theme = themeColors(themeId);
  const root = document.documentElement;
  for (const { key } of TOKENS) root.style.setProperty(cssVar(key), theme[key]);
  // derived tones
  root.style.setProperty('--accent-soft', theme.accent + '22');
  root.style.setProperty('--success-soft', theme.success + '22');
  root.style.setProperty('--danger-soft', theme.danger + '22');
  // native controls (date pickers, scrollbars) follow the background brightness
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(theme.bg.slice(i, i + 2), 16));
  root.style.colorScheme = root.dataset.scheme = 0.299 * r + 0.587 * g + 0.114 * b > 140 ? 'light' : 'dark';
  root.dataset.theme = themeId;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
  if (id) {
    try {
      localStorage.setItem(STORAGE_KEY, themeId);
    } catch {
      /* private mode: just not remembered */
    }
  }
  return theme;
}
