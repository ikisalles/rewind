// Sign-in providers. Each one maps its own profile into a common shape:
//   { provider, providerId, email, emailVerified, name, avatar, domain, groups: [{ key, name }] }
// `groups` decides which team(s) the person lands in. When a provider can't tell (or group
// lookup is off), Rewind falls back to a default team.
//
// Credentials come from one of two places, with the same code path:
//   - the platform: environment variables (GOOGLE_CLIENT_ID, ...), for every company;
//   - a company: Company settings → Sign-in (stored per company, secrets encrypted).
// Both become a "config": { clientId, clientSecret, tenant?, issuer?, label?, fetchGroups? }.
//
// To add a provider: add an entry here with authorize/token endpoints, scopes and profile().

const ua = { 'user-agent': 'rewind', accept: 'application/json' };

async function getJson(url, token, extra = {}) {
  const res = await fetch(url, { headers: { ...ua, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const domainOf = (email) => (email?.split('@')[1] || '').toLowerCase();
const flag = (v) => v === true || v === 'true' || v === '1';

// OpenID Connect discovery, cached per issuer for a few minutes.
const discovery = new Map();
async function oidcMeta(issuer) {
  const base = String(issuer || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('The issuer must be an https URL');
  const hit = discovery.get(base);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.meta;
  const meta = await getJson(`${base}/.well-known/openid-configuration`);
  if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.userinfo_endpoint) throw new Error('The issuer has no OpenID configuration');
  discovery.set(base, { at: Date.now(), meta });
  return meta;
}

export const PROVIDERS = {
  google: {
    label: 'Google',
    fromEnv: (env) => env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, fetchGroups: flag(env.GOOGLE_FETCH_GROUPS) },
    authorizeUrl: async () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: async () => 'https://oauth2.googleapis.com/token',
    scopes: (cfg) => ['openid', 'email', 'profile'].concat(cfg.fetchGroups ? ['https://www.googleapis.com/auth/cloud-identity.groups.readonly'] : []).join(' '),
    extraParams: { prompt: 'select_account' },
    async profile(token, cfg) {
      const u = await getJson('https://openidconnect.googleapis.com/v1/userinfo', token);
      const groups = [];
      // Google Workspace groups (Cloud Identity): needs the extra scope above and the
      // Cloud Identity API enabled in the Google Cloud project.
      if (cfg.fetchGroups && u.hd) {
        try {
          const q = encodeURIComponent(`member_key_id=='${u.email}'`);
          const r = await getJson(`https://cloudidentity.googleapis.com/v1/groups/-/memberships:searchDirectGroups?query=${q}`, token);
          for (const m of r.memberships ?? []) groups.push({ key: `google:${m.groupKey?.id}`, name: m.displayName || m.groupKey?.id });
        } catch {
          /* groups are best effort */
        }
      }
      return {
        provider: 'google',
        providerId: u.sub,
        email: u.email?.toLowerCase(),
        emailVerified: Boolean(u.email_verified),
        name: u.name || u.email,
        avatar: u.picture,
        // `hd` is only present for Google Workspace accounts.
        domain: (u.hd || domainOf(u.email)).toLowerCase(),
        groups,
      };
    },
  },

  github: {
    label: 'GitHub',
    fromEnv: (env) => env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    authorizeUrl: async () => 'https://github.com/login/oauth/authorize',
    tokenUrl: async () => 'https://github.com/login/oauth/access_token',
    scopes: () => 'read:user user:email read:org',
    extraParams: {},
    async profile(token) {
      const u = await getJson('https://api.github.com/user', token);
      const emails = await getJson('https://api.github.com/user/emails', token).catch(() => []);
      const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
      const email = (primary?.email || u.email || '').toLowerCase();
      const teams = await getJson('https://api.github.com/user/teams', token).catch(() => []);
      return {
        provider: 'github',
        providerId: String(u.id),
        email,
        emailVerified: Boolean(primary?.verified),
        name: u.name || u.login,
        avatar: u.avatar_url,
        domain: domainOf(email),
        groups: teams.map((t) => ({ key: `github:${t.organization?.login}/${t.slug}`, name: t.name })),
      };
    },
  },

  microsoft: {
    label: 'Microsoft',
    fromEnv: (env) =>
      env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenant: env.MICROSOFT_TENANT, fetchGroups: flag(env.MICROSOFT_FETCH_GROUPS) },
    authorizeUrl: async (cfg) => `https://login.microsoftonline.com/${cfg.tenant || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl: async (cfg) => `https://login.microsoftonline.com/${cfg.tenant || 'common'}/oauth2/v2.0/token`,
    scopes: (cfg) => ['openid', 'email', 'profile', 'User.Read'].concat(cfg.fetchGroups ? ['GroupMember.Read.All'] : []).join(' '),
    extraParams: { prompt: 'select_account' },
    async profile(token, cfg) {
      const u = await getJson('https://graph.microsoft.com/v1.0/me', token);
      const email = (u.mail || u.userPrincipalName || '').toLowerCase();
      let groups = [];
      if (cfg.fetchGroups) {
        const r = await getJson('https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.group?$select=id,displayName', token).catch(() => ({ value: [] }));
        groups = r.value.map((g) => ({ key: `microsoft:${g.id}`, name: g.displayName }));
      }
      return {
        provider: 'microsoft',
        providerId: u.id,
        email,
        // Entra ID only issues accounts for verified tenant domains.
        emailVerified: Boolean(email),
        name: u.displayName || email,
        avatar: null,
        domain: domainOf(email),
        groups,
      };
    },
  },

  // Any OpenID Connect identity provider (Okta, Auth0, Keycloak, JumpCloud, OneLogin, Entra ID...).
  // Company-level only: the company gives its issuer URL, client ID and secret.
  oidc: {
    label: 'SSO',
    fromEnv: () => null,
    authorizeUrl: async (cfg) => (await oidcMeta(cfg.issuer)).authorization_endpoint,
    tokenUrl: async (cfg) => (await oidcMeta(cfg.issuer)).token_endpoint,
    scopes: (cfg) => ['openid', 'email', 'profile'].concat(cfg.fetchGroups ? ['groups'] : []).join(' '),
    extraParams: {},
    async profile(token, cfg) {
      const u = await getJson((await oidcMeta(cfg.issuer)).userinfo_endpoint, token);
      const email = String(u.email || u.preferred_username || '').toLowerCase();
      const groups = Array.isArray(u.groups) ? u.groups.map((g) => ({ key: `oidc:${g}`, name: String(g) })) : [];
      return {
        provider: 'oidc',
        providerId: String(u.sub),
        email,
        // the company's own identity provider: trusted unless it says the email isn't verified
        emailVerified: u.email_verified !== false && u.email_verified !== 'false',
        name: u.name || [u.given_name, u.family_name].filter(Boolean).join(' ') || email,
        avatar: u.picture || null,
        domain: domainOf(email),
        groups,
      };
    },
  },
};

export const labelOf = (id, cfg) => (id === 'oidc' && cfg?.label) || PROVIDERS[id]?.label || id;

// Providers the platform offers to everyone (environment variables).
export function enabledProviders(env) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.fromEnv(env))
    .map(([id, p]) => ({ id, label: p.label }));
}

export async function authorizeUrl(id, cfg, { state, redirectUri, loginHint }) {
  const p = PROVIDERS[id];
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scopes(cfg),
    state,
    ...p.extraParams,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${await p.authorizeUrl(cfg)}?${params}`;
}

export async function exchangeCode(id, cfg, { code, redirectUri }) {
  const p = PROVIDERS[id];
  const res = await fetch(await p.tokenUrl(cfg), {
    method: 'POST',
    headers: { ...ua, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`token exchange failed (${res.status})`);
  return p.profile(data.access_token, cfg);
}

// Free mail providers never become a shared company workspace.
export const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
  'aol.com', 'gmx.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'users.noreply.github.com',
]);
