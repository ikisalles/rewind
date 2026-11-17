// Deployment settings. Edit this file after publishing the /public folder to your CDN.
window.REWIND_CONFIG = {
  // Where the API lives. Empty = same origin (/api/...).
  // Example for a separate API host: 'https://rewind-api.example.com' (set CORS_ORIGIN on the API).
  apiBase: '',
  appName: 'Rewind',
  slogan: 'listening to and giving a voice to the team',
  repoUrl: 'https://github.com/ikisalles/rewind',
  // Seconds between automatic refreshes of an open retro.
  pollSeconds: 4,
  // Default colors for this deployment (each company admin can still change them).
  // Keys: bg, surface, surface2, border, text, muted, accent, accentText, success, danger, link
  theme: {},
};
