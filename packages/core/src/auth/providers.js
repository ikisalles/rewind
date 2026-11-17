// Social login providers. Each provider maps its own profile into a common shape:
//   { provider, providerId, email, emailVerified, name, avatar, domain, groups: [{ key, name }] }
// `groups` decides which team(s) the person lands in. When a provider can't
// tell (or group lookup is disabled), Rewind falls back to a default team.
//
// To add a provider: add an entry here with authorizeUrl/tokenUrl/scopes/profile().

const ua = { 'user-agent': 'rewind', accept: 'application/json' };

async function getJson(url, token, extra = {}) {
  const res = await fetch(url, { headers: { ...ua, authorization: `Bearer ${token}`, ...extra } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const domainOf = (email) => (email?.split('@')[1] || '').toLowerCase();

const flag = (v) => v === true || v === 'true' || v === '1';

export const PROVIDERS = {
  google: {
    label: 'Google',
    enabled: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    scopes: (env) =>
      ['openid', 'email', 'profile']
        .concat(flag(env.GOOGLE_FETCH_GROUPS) ? ['https://www.googleapis.com/auth/cloud-identity.groups.readonly'] : [])
        .join(' '),
    extraParams: { prompt: 'select_account' },
    async profile(token, env) {
      const u = await getJson('https://openidconnect.googleapis.com/v1/userinfo', token);
      const groups = [];
      // Google Workspace groups (Cloud Identity). Needs the extra scope above and
      // the Cloud Identity API enabled in the Google Cloud project.
      if (flag(env.GOOGLE_FETCH_GROUPS) && u.hd) {
        try {
          const q = encodeURIComponent(`member_key_id=='${u.email}'`);
          const r = await getJson(
            `https://cloudidentity.googleapis.com/v1/groups/-/memberships:searchDirectGroups?query=${q}`,
            token,
          );
          for (const m of r.memberships ?? []) {
            groups.push({ key: `google:${m.groupKey?.id}`, name: m.displayName || m.groupKey?.id });
          }
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
    enabled: (env) => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    authorizeUrl: () => 'https://github.com/login/oauth/authorize',
    tokenUrl: () => 'https://github.com/login/oauth/access_token',
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
    enabled: (env) => Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
    clientId: (env) => env.MICROSOFT_CLIENT_ID,
    clientSecret: (env) => env.MICROSOFT_CLIENT_SECRET,
    authorizeUrl: (env) =>
      `https://login.microsoftonline.com/${env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl: (env) => `https://login.microsoftonline.com/${env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/token`,
    scopes: (env) =>
      ['openid', 'email', 'profile', 'User.Read']
        .concat(flag(env.MICROSOFT_FETCH_GROUPS) ? ['GroupMember.Read.All'] : [])
        .join(' '),
    extraParams: { prompt: 'select_account' },
    async profile(token, env) {
      const u = await getJson('https://graph.microsoft.com/v1.0/me', token);
      const email = (u.mail || u.userPrincipalName || '').toLowerCase();
      let groups = [];
      if (flag(env.MICROSOFT_FETCH_GROUPS)) {
        const r = await getJson(
          'https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.group?$select=id,displayName',
          token,
        ).catch(() => ({ value: [] }));
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
};

export function enabledProviders(env) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.enabled(env))
    .map(([id, p]) => ({ id, label: p.label }));
}

export function authorizeUrl(id, env, { state, redirectUri }) {
  const p = PROVIDERS[id];
  const params = new URLSearchParams({
    client_id: p.clientId(env),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scopes(env),
    state,
    ...p.extraParams,
  });
  return `${p.authorizeUrl(env)}?${params}`;
}

export async function exchangeCode(id, env, { code, redirectUri }) {
  const p = PROVIDERS[id];
  const res = await fetch(p.tokenUrl(env), {
    method: 'POST',
    headers: { ...ua, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: p.clientId(env),
      client_secret: p.clientSecret(env),
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`token exchange failed (${res.status})`);
  return p.profile(data.access_token, env);
}

// Free mail providers never become a shared company workspace.
export const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
  'aol.com', 'gmx.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'users.noreply.github.com',
]);
