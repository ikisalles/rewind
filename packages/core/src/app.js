// Rewind API kernel — a single, runtime-agnostic `fetch` handler.
// It only relies on web standards (Request/Response/fetch/crypto), so the same
// code runs on Cloudflare Workers, Azion Functions, Deno, Bun or Node 20+.
//
// The core owns companies, people, teams, invites, access requests and sign-in.
// Features live in modules (see module.js), e.g. @rewind/retro:
//
//   const app = createApp({ storage, env, modules: [retro] });
//   const response = await app.fetch(request);

import { createRouter, corsHeaders, fail, HttpError, json, readJson, redirect } from './lib/http.js';
import { hashPassword, newId, openSecret, randomToken, sealSecret, verifyPassword } from './lib/crypto.js';
import { authorizeUrl, enabledProviders, exchangeCode, labelOf, PROVIDERS, PUBLIC_DOMAINS } from './auth/providers.js';
import { escapeHtml, isEmail, normalizeOrgName, now, str } from './util.js';
import { readYourWrites } from './storage/consistency.js';
import { fetchCompanyLogo } from './lib/logo.js';

// Core keys that should exist when looked up (a token someone holds, an id from a link...):
// on an eventually consistent store, a miss on them is read again before giving up.
// On Durable Object storage: company data lives in the company's object (keys "<kind>:<orgId>:...").
export const CORE_SHARDS = { user: 'org', team: 'org', inviteidx: 'org', joinreq: 'org', integration: 'org', orgauth: 'org', orglogo: 'org' };

const CORE_KEY_PREFIXES = ['session:', 'authcode:', 'oauth:', 'user:', 'org:', 'cred:', 'team:', 'invite:'];

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const INVITE_TTL = 60 * 60 * 24 * 14; // 14 days

// Each person picks their own theme (My account → Appearance).
const THEMES = ['dark', 'light', 'ocean'];

// consistency: 'strong' (default) or 'eventual' for stores whose reads may lag behind writes
// (e.g. Azion SQL Database read replicas): turns on read-your-writes, see storage/consistency.js.
// realtime: optional { publish(channel, message), connect(request, channel) } (see realtime/);
// without it, modules' live endpoints answer 501 and the web app keeps polling.
export function createApp({ storage, env = {}, modules = [], consistency = 'strong', realtime = null }) {
  const db =
    consistency === 'eventual'
      ? readYourWrites(storage, { retryPrefixes: [...CORE_KEY_PREFIXES, ...modules.flatMap((m) => m.keyPrefixes || [])] })
      : storage;
  const router = createRouter();
  const route = (method, path, fn, opts = {}) => router.add(method, path, { fn, ...opts });

  // ------------------------------------------------------------ data access
  const K = {
    org: (id) => `org:${id}`,
    orgDomain: (d) => `orgdomain:${d}`,
    user: (orgId, id) => `user:${orgId}:${id}`,
    users: (orgId) => `user:${orgId}:`,
    userEmail: (email) => `useremail:${email}`,
    cred: (id) => `cred:${id}`,
    team: (orgId, id) => `team:${orgId}:${id}`,
    teams: (orgId) => `team:${orgId}:`,
    invite: (token) => `invite:${token}`,
    inviteIdx: (orgId, token) => `inviteidx:${orgId}:${token}`,
    invites: (orgId) => `inviteidx:${orgId}:`,
    session: (t) => `session:${t}`,
    authCode: (c) => `authcode:${c}`,
    oauthState: (s) => `oauth:${s}`,
    orgName: (normalized) => `orgname:${normalized}`,
    orgNameIndexed: () => 'meta:orgname-index:v1',
    joinRequest: (orgId, id) => `joinreq:${orgId}:${id}`,
    joinRequests: (orgId) => `joinreq:${orgId}:`,
    joinRequestEmail: (email) => `joinreqemail:${email}`,
    integrations: (orgId, userId) => `integration:${orgId}:${userId}`,
    orgAuth: (orgId) => `orgauth:${orgId}`,
    orgLogo: (orgId) => `orglogo:${orgId}`, // the image itself, apart from the company record
    ssoDomain: (domain) => `ssodomain:${domain}`,
  };

  const appUrl = (req) => (env.APP_URL || new URL(req.url).origin).replace(/\/$/, '');
  const apiUrl = (req) => (env.API_URL || new URL(req.url).origin).replace(/\/$/, '');

  async function createSession(user) {
    const token = randomToken(32);
    await db.put(K.session(token), { userId: user.id, orgId: user.orgId }, { ttl: SESSION_TTL });
    return token;
  }

  async function authenticate(req) {
    const header = req.headers.get('authorization') || '';
    // Browsers can't set headers on a WebSocket: the token comes as a subprotocol ("rewind, <token>").
    const wsToken = (req.headers.get('sec-websocket-protocol') || '').split(',').map((p) => p.trim()).find((p, i, all) => i > 0 && all[0] === 'rewind');
    const token = header.startsWith('Bearer ') ? header.slice(7) : wsToken || null;
    if (!token) return null;
    const s = await db.get(K.session(token));
    if (!s) return null;
    const user = await db.get(K.user(s.orgId, s.userId));
    if (!user) return null;
    const org = await db.get(K.org(s.orgId));
    return { user, org, token };
  }

  const isAdmin = (c) => c.user.role === 'admin';
  const requireAdmin = (c) => isAdmin(c) || fail(403, 'Admins only');

  async function createOrg({ name, domain = null, createdBy }) {
    const org = {
      id: newId(),
      name,
      domain,
      autoJoin: false,
      theme: {},
      defaultTeamId: null,
      createdAt: now(),
      createdBy,
    };
    const team = { id: newId(), orgId: org.id, name: 'General', groupKey: null, createdAt: now() };
    org.defaultTeamId = team.id;
    await db.put(K.team(org.id, team.id), team);
    await db.put(K.org(org.id), org);
    if (domain) await db.put(K.orgDomain(domain), { orgId: org.id });
    const nameKey = K.orgName(normalizeOrgName(name));
    if (!(await db.get(nameKey))) await db.put(nameKey, { orgId: org.id });
    return org;
  }

  // ------------------------------------------------------------ company names
  // Companies created before the name index existed are indexed once, on first use.
  async function ensureOrgNameIndex() {
    if (await db.get(K.orgNameIndexed())) return;
    const orgs = (await db.list('org:')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const org of orgs) {
      const key = K.orgName(normalizeOrgName(org.name));
      if (!(await db.get(key))) await db.put(key, { orgId: org.id });
    }
    await db.put(K.orgNameIndexed(), { at: now() });
  }

  async function findOrgByName(name) {
    await ensureOrgNameIndex();
    const ref = await db.get(K.orgName(normalizeOrgName(name)));
    const org = ref && (await db.get(K.org(ref.orgId)));
    return org && normalizeOrgName(org.name) === normalizeOrgName(name) ? org : null;
  }

  // ------------------------------------------------------------ join requests
  // Someone registered a company name that already exists: they wait for an admin.
  async function findJoinRequest(email) {
    const ref = await db.get(K.joinRequestEmail(email));
    return ref ? db.get(K.joinRequest(ref.orgId, ref.id)) : null;
  }

  async function deleteJoinRequest(req) {
    await db.delete(K.joinRequest(req.orgId, req.id));
    const ref = await db.get(K.joinRequestEmail(req.email));
    if (ref?.id === req.id) await db.delete(K.joinRequestEmail(req.email));
  }

  const pendingMessage = (orgName) => `Your request to join ${orgName} is waiting for an admin's approval. We'll email you when it's reviewed.`;
  const deniedMessage = (orgName) => `Your request to join ${orgName} was denied. You can register again with a different company name.`;

  // Who gets the e-mail: whoever registered the company, or its oldest admin.
  async function companyOwner(org) {
    const users = await db.list(K.users(org.id));
    return (
      users.find((u) => u.id === org.createdBy && u.role === 'admin') ||
      users.filter((u) => u.role === 'admin').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ||
      null
    );
  }

  async function createUser(org, { email, name, avatar = null, role = 'member', teamIds = [] }) {
    const user = {
      id: newId(),
      orgId: org.id,
      email,
      name: name || email.split('@')[0],
      avatar,
      role,
      teamIds: [...new Set(teamIds)],
      providers: [],
      onboarding: null,
      createdAt: now(),
    };
    await db.put(K.user(org.id, user.id), user);
    await db.put(K.userEmail(email), { orgId: org.id, userId: user.id });
    const req = await findJoinRequest(email);
    if (req) await deleteJoinRequest(req);
    return user;
  }

  async function findUserByEmail(email) {
    const ref = await db.get(K.userEmail(email));
    return ref ? db.get(K.user(ref.orgId, ref.userId)) : null;
  }

  // Map provider groups to teams (creating them on first sight).
  // Groups from the company's identity provider become teams. A group never duplicates a team that
  // already exists in Rewind with the same name (ignoring case, accents and spaces): that team is
  // linked to the group instead. Duplicates made before this rule are merged into the older team.
  const sameName = (a, b) => normalizeOrgName(a || '') === normalizeOrgName(b || '');
  async function teamsForGroups(org, groups) {
    if (!groups?.length) return [];
    let teams = await db.list(K.teams(org.id));
    const ids = [];
    for (const g of groups) {
      const name = g.name || g.key;
      let team = teams.find((t) => t.groupKey === g.key);
      const manual = teams.find((t) => !t.groupKey && t.id !== team?.id && sameName(t.name, name));
      if (team && manual) {
        // an earlier duplicate: keep the older team (its boards, links and history), linked to the group
        // ids are time-ordered: they break ties between teams created in the same millisecond
        const older = (a, b) => `${a.createdAt}|${a.id}` <= `${b.createdAt}|${b.id}`;
        const [keep, drop] = older(manual, team) ? [manual, team] : [team, manual];
        keep.groupKey = g.key;
        await db.patch(K.team(org.id, keep.id), { groupKey: g.key });
        await mergeTeams(org.id, drop.id, keep.id);
        teams = teams.filter((t) => t.id !== drop.id);
        team = keep;
      } else if (!team && manual) {
        manual.groupKey = g.key; // the team made in Rewind now follows the group
        await db.patch(K.team(org.id, manual.id), { groupKey: g.key });
        team = manual;
      } else if (!team) {
        team = { id: newId(), orgId: org.id, name, groupKey: g.key, createdAt: now() };
        await db.put(K.team(org.id, team.id), team);
        teams.push(team);
      }
      ids.push(team.id);
    }
    return [...new Set(ids)];
  }

  // Everything that pointed to one team moves to another, then the first one is deleted:
  // members, default team, pending invites, and each module's data (boards, changes...).
  async function mergeTeams(orgId, fromId, intoId) {
    if (fromId === intoId) return;
    for (const u of await db.list(K.users(orgId))) {
      if (!u.teamIds.includes(fromId)) continue;
      await db.patch(K.user(orgId, u.id), { teamIds: [...new Set(u.teamIds.map((t) => (t === fromId ? intoId : t)))] });
    }
    const org = await db.get(K.org(orgId));
    if (org?.defaultTeamId === fromId) await db.patch(K.org(orgId), { defaultTeamId: intoId });
    for (const idx of await db.list(K.invites(orgId))) {
      const invite = await db.get(K.invite(idx.token));
      if (invite?.teamId === fromId) await db.patch(K.invite(idx.token), { teamId: intoId });
    }
    for (const m of loaded) await m.onTeamMerge?.(orgId, fromId, intoId);
    await db.delete(K.team(orgId, fromId));
  }


  async function teamMembers(orgId, teamId) {
    const users = await db.list(K.users(orgId));
    return users.filter((u) => u.teamIds.includes(teamId) || u.role === 'admin');
  }


  // E-mail goes through Resend when configured; otherwise it is skipped (returns false).
  async function sendEmail({ to, subject, html }) {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, html }),
    }).catch(() => null);
    return Boolean(res?.ok);
  }

  const sendInviteEmail = (invite, org, url) =>
    sendEmail({
      to: invite.email,
      subject: `Invitation to ${org.name} on Rewind`,
      html: `<p>You've been invited to join <b>${escapeHtml(org.name)}</b> on Rewind.</p>
             <p><a href="${url}">Accept invite</a></p>`,
    });


  // ------------------------------------------------------------ company sign-in (SSO / social)
  // A company can bring its own sign-in: Google, Microsoft, GitHub or any OpenID Connect provider,
  // with its own client ID and secret (Company settings → Sign-in). Without it, the platform's
  // providers (environment variables) are used. Secrets are stored sealed (SECRETS_KEY).
  const COMPANY_PROVIDERS = ['google', 'microsoft', 'github', 'oidc'];
  const emptyAuth = () => ({ providers: {}, domains: [], requireSso: false, autoProvision: true, notifiedAt: null });
  const orgAuth = async (orgId) => ({ ...emptyAuth(), ...((orgId && (await db.get(K.orgAuth(orgId)))) || {}) });
  const companyDomains = (org, auth) => [...new Set([org?.domain, ...(auth.domains || [])].filter(Boolean))];
  const readyProviders = (auth) =>
    COMPANY_PROVIDERS.filter((id) => auth.providers[id]?.enabled && auth.providers[id].clientId && auth.providers[id].clientSecret && (id !== 'oidc' || auth.providers[id].issuer))
      .map((id) => ({ id, label: labelOf(id, auth.providers[id]) }));

  // what the admin sees: everything but the secrets
  const authView = (auth) => ({
    ...auth,
    providers: Object.fromEntries(Object.entries(auth.providers).map(([id, { clientSecret, ...rest }]) => [id, { ...rest, hasSecret: Boolean(clientSecret) }])),
  });

  // Credentials for a sign-in: the company's when it has them, the platform's otherwise.
  async function providerConfig(id, orgId) {
    if (orgId) {
      const p = (await orgAuth(orgId)).providers[id];
      if (!p?.enabled || !p.clientSecret) fail(404, 'This company has no such sign-in');
      return { ...p, clientSecret: await openSecret(p.clientSecret, env.SECRETS_KEY) };
    }
    const cfg = PROVIDERS[id]?.fromEnv(env);
    if (!cfg) fail(404, 'Provider not enabled');
    return cfg;
  }

  // The company behind an email: its account, or a domain the company signs in with.
  async function orgForEmail(email) {
    const user = await findUserByEmail(email);
    if (user) return { org: await db.get(K.org(user.orgId)), user };
    const domain = email.split('@')[1] || '';
    const ref = (await db.get(K.ssoDomain(domain))) || (await db.get(K.orgDomain(domain)));
    return { org: ref ? await db.get(K.org(ref.orgId)) : null, user: null };
  }

  // The company's logo (header chip) comes from its own website, through the domain its sign-in
  // uses. It only shows while the company has a sign-in connected (social domain or own provider).
  const signInConnected = (org, auth) => Boolean(org?.domain) || readyProviders(auth).length > 0;
  // The image is stored apart (orglogo:<id>) and served by its own cacheable URL; the company record
  // only keeps where it came from and when, so the image never travels with every request.
  async function refreshLogo(org, auth, { force = false } = {}) {
    if (!force && (org.logo || org.logoRemoved)) return org.logo || null;
    const domain = org.domain || auth.domains?.[0];
    const found = domain ? await fetchCompanyLogo(domain).catch(() => null) : null;
    const logo = found ? { from: found.from, domain, at: now() } : null;
    if (found) await db.put(K.orgLogo(org.id), { dataUrl: found.dataUrl });
    else await db.delete(K.orgLogo(org.id));
    org.logo = logo;
    await db.patch(K.org(org.id), { logo, logoRemoved: null });
    return logo;
  }
  const logoUrl = (org) => `/api/orgs/${org.id}/logo?v=${encodeURIComponent(org.logo.at)}`;
  // what people get: the URL of the image, only while a sign-in is connected
  const publicLogo = (org, auth) => (org.logo && signInConnected(org, auth) ? { url: logoUrl(org), from: org.logo.from, at: org.logo.at } : null);

  // Companies whose logo was saved inside the company record (before it moved apart).
  async function moveInlineLogo(org) {
    if (!org.logo?.dataUrl) return;
    const { dataUrl, ...meta } = org.logo;
    await db.put(K.orgLogo(org.id), { dataUrl });
    org.logo = meta;
    await db.patch(K.org(org.id), { logo: { dataUrl: null } });
  }

  const ssoRequired = (auth, user) => auth.requireSso && readyProviders(auth).length > 0 && user?.role !== 'admin';
  const ssoRequiredError = (org, auth) =>
    fail(403, `${org.name} signs in with ${readyProviders(auth).map((p) => p.label).join(' or ')}. Use that button with your work account.`, 'sso_required');

  // ------------------------------------------------------------ public
  route('POST', '/api/auth/discover', async ({ body }) => {
    const email = str(body.email, 200).toLowerCase();
    if (!isEmail(email)) fail(400, 'Enter a valid email');
    const { org, user } = await orgForEmail(email);
    if (!org) return json({ org: null, sso: [], password: true });
    const auth = await orgAuth(org.id);
    const sso = readyProviders(auth);
    return json({ org: { id: org.id, name: org.name }, sso, password: !ssoRequired(auth, user || { role: 'member' }) });
  }, { public: true });

  route('GET', '/api/config', async () =>
    json({
      providers: enabledProviders(env),
      allowSignup: env.ALLOW_SIGNUP !== 'false',
      realtime: Boolean(realtime),
    }),
  { public: true });

  route('POST', '/api/auth/signup', async ({ req: httpReq, body }) => {
    if (env.ALLOW_SIGNUP === 'false') fail(403, 'Sign-up is disabled');
    const orgName = str(body.orgName, 80);
    const name = str(body.name, 80);
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!orgName) fail(400, 'Enter the company name');
    if (!isEmail(email)) fail(400, 'Invalid email');
    if (password.length < 8) fail(400, 'Password must be at least 8 characters');
    if (await findUserByEmail(email)) fail(409, 'This email is already registered');

    const [existingReq, target] = await Promise.all([findJoinRequest(email), findOrgByName(orgName)]);
    if (existingReq) {
      const reqOrg = await db.get(K.org(existingReq.orgId));
      if (existingReq.status === 'pending') fail(409, pendingMessage(reqOrg?.name || existingReq.orgName));
      // Denied: blocked for that company, but a different company name reactivates the sign-up.
      if (target && target.id === existingReq.orgId) fail(403, deniedMessage(target.name));
      await deleteJoinRequest(existingReq);
    }

    // The company name is taken: ask its admins instead of creating a duplicate.
    if (target) {
      const jr = {
        id: newId(),
        orgId: target.id,
        orgName: target.name,
        name: name || email.split('@')[0],
        email,
        hash: await hashPassword(password),
        status: 'pending',
        createdAt: now(),
        decidedAt: null,
        decidedBy: null,
      };
      await db.put(K.joinRequest(target.id, jr.id), jr);
      await db.put(K.joinRequestEmail(email), { orgId: target.id, id: jr.id });
      const owner = await companyOwner(target);
      if (owner) {
        await sendEmail({
          to: owner.email,
          subject: `${jr.name} wants to join ${target.name} on Rewind`,
          html: `<p><b>${escapeHtml(jr.name)}</b> (${escapeHtml(email)}) tried to register the company <b>${escapeHtml(target.name)}</b>, which already exists on Rewind.</p>
                 <p>They can only get in once an admin approves.</p>
                 <p><a href="${appUrl(httpReq)}/#/admin/members">Review the request</a></p>`,
        });
      }
      return json({ status: 'pending', orgName: target.name, message: pendingMessage(target.name) }, 202);
    }

    // Manual sign-up never claims the e-mail domain: it is not verified.
    const org = await createOrg({ name: orgName, createdBy: null });
    const user = await createUser(org, { email, name, role: 'admin', teamIds: [org.defaultTeamId] });
    org.createdBy = user.id;
    await db.patch(K.org(org.id), { createdBy: user.id });
    await db.put(K.cred(user.id), { hash: await hashPassword(password) });
    return json({ token: await createSession(user) }, 201);
  }, { public: true });

  route('POST', '/api/auth/login', async ({ body }) => {
    const email = str(body.email, 200).toLowerCase();
    const user = await findUserByEmail(email);
    if (!user) {
      const jr = await findJoinRequest(email);
      if (jr && (await verifyPassword(String(body.password || ''), jr.hash))) {
        const org = await db.get(K.org(jr.orgId));
        fail(403, jr.status === 'pending' ? pendingMessage(org?.name || jr.orgName) : deniedMessage(org?.name || jr.orgName));
      }
    }
    if (user) {
      const auth = await orgAuth(user.orgId);
      if (ssoRequired(auth, user)) ssoRequiredError(await db.get(K.org(user.orgId)), auth);
    }
    const cred = user && (await db.get(K.cred(user.id)));
    if (!cred || !(await verifyPassword(String(body.password || ''), cred.hash))) {
      fail(401, 'Wrong email or password');
    }
    return json({ token: await createSession(user) });
  }, { public: true });

  route('POST', '/api/auth/exchange', async ({ body }) => {
    const code = str(body.code, 100);
    const entry = code && (await db.get(K.authCode(code)));
    if (!entry) fail(400, 'Code expired, please try again');
    await db.delete(K.authCode(code));
    return json({ token: entry.token });
  }, { public: true });

  // ?org=<id>: sign in with that company's own provider (Company settings → Sign-in)
  route('GET', '/api/auth/oauth/:provider/start', async ({ req, params, url }) => {
    if (!PROVIDERS[params.provider]) fail(404, 'Provider not enabled');
    const orgId = str(url.searchParams.get('org'), 60) || null;
    const cfg = await providerConfig(params.provider, orgId);
    const state = randomToken(24);
    await db.put(K.oauthState(state), { provider: params.provider, orgId, invite: url.searchParams.get('invite') }, { ttl: 600 });
    const hint = str(url.searchParams.get('hint'), 200);
    let target;
    try {
      target = await authorizeUrl(params.provider, cfg, { state, loginHint: isEmail(hint) ? hint : '', redirectUri: `${apiUrl(req)}/api/auth/oauth/${params.provider}/callback` });
    } catch {
      fail(502, "Couldn't reach the company's identity provider");
    }
    return redirect(target);
  }, { public: true });

  route('GET', '/api/auth/oauth/:provider/callback', async ({ req, params, url }) => {
    const back = (q) => redirect(`${appUrl(req)}/#/auth/callback?${new URLSearchParams(q)}`);
    const state = url.searchParams.get('state');
    const saved = state && (await db.get(K.oauthState(state)));
    if (!saved || saved.provider !== params.provider) return back({ error: 'Sign-in session expired' });
    await db.delete(K.oauthState(state));
    if (url.searchParams.get('error')) return back({ error: 'Sign-in cancelled' });

    let profile;
    try {
      const cfg = await providerConfig(params.provider, saved.orgId);
      profile = await exchangeCode(params.provider, cfg, {
        code: url.searchParams.get('code'),
        redirectUri: `${apiUrl(req)}/api/auth/oauth/${params.provider}/callback`,
      });
    } catch {
      return back({ error: "Couldn't authenticate with the provider" });
    }
    try {
      const user = await socialLogin(profile, saved.invite, saved.orgId || null);
      const code = randomToken(24);
      await db.put(K.authCode(code), { token: await createSession(user) }, { ttl: 120 });
      return back({ code });
    } catch (e) {
      if (e instanceof HttpError) return back({ error: e.message });
      throw e;
    }
  }, { public: true });

  // The heart of social sign-in: decides which company and team(s) a person joins.
  // viaOrg: the sign-in used that company's own provider; it can only ever lead into that company.
  async function socialLogin(profile, inviteToken, viaOrg = null) {
    if (!isEmail(profile.email) || !profile.emailVerified) fail(403, "The provider didn't return a verified email");
    const linkProvider = (u) => {
      if (!u.providers.includes(profile.provider)) u.providers.push(profile.provider);
      if (!u.avatar && profile.avatar) u.avatar = profile.avatar;
    };

    // 1. Returning user: refresh group-based teams.
    const existing = await findUserByEmail(profile.email);
    if (existing) {
      if (viaOrg && existing.orgId !== viaOrg) fail(403, 'This account belongs to another company on Rewind. Sign in from its page.');
      const org = await db.get(K.org(existing.orgId));
      // a company that requires its own sign-in doesn't accept the platform's providers
      const auth = await orgAuth(org.id);
      if (!viaOrg && ssoRequired(auth, existing)) ssoRequiredError(org, auth);
      const groupTeams = await teamsForGroups(org, profile.groups);
      existing.teamIds = [...new Set([...existing.teamIds, ...groupTeams])];
      linkProvider(existing);
      // signing in the company's way answers the "how to sign in now" notice
      if (viaOrg && existing.notice?.type === 'signin') existing.notice = null;
      // the provider owns the person's name: keep it in step
      if (profile.name && profile.name !== profile.email) existing.name = str(profile.name, 80) || existing.name;
      await db.patch(K.user(org.id, existing.id), { name: existing.name, teamIds: existing.teamIds, providers: existing.providers, avatar: existing.avatar, notice: existing.notice ?? null });
      return existing;
    }

    // A pending request waits for the admin (an invite overrides it); a denied one
    // blocks that company, but the person may still create or join another.
    const joinReq = await findJoinRequest(profile.email);
    if (joinReq?.status === 'pending' && !inviteToken) {
      const reqOrg = await db.get(K.org(joinReq.orgId));
      fail(403, pendingMessage(reqOrg?.name || joinReq.orgName));
    }

    // 2. Invited person.
    if (inviteToken) {
      const invite = await db.get(K.invite(inviteToken));
      if (!invite) fail(400, 'Invalid or expired invite');
      if (invite.email !== profile.email) fail(403, `This invite was sent to ${invite.email}`);
      if (viaOrg && invite.orgId !== viaOrg) fail(403, 'This invite is for another company');
      const org = await db.get(K.org(invite.orgId));
      const groupTeams = await teamsForGroups(org, profile.groups);
      const user = await createUser(org, {
        email: profile.email,
        name: profile.name,
        avatar: profile.avatar,
        role: invite.role,
        teamIds: [invite.teamId || org.defaultTeamId, ...groupTeams],
      });
      linkProvider(user);
      await db.put(K.user(org.id, user.id), user);
      await db.delete(K.invite(inviteToken));
      await db.delete(K.inviteIdx(org.id, inviteToken));
      return user;
    }

    const domain = profile.domain;
    const companyDomain = domain && !PUBLIC_DOMAINS.has(domain) ? domain : null;

    // 3a. Company sign-in: new people from the company's domains get an account there, nothing else.
    if (viaOrg) {
      const org = await db.get(K.org(viaOrg));
      const auth = await orgAuth(viaOrg);
      if (!org) fail(404, 'Company not found');
      if (joinReq?.status === 'denied' && joinReq.orgId === org.id) fail(403, deniedMessage(org.name));
      if (!auth.autoProvision || !companyDomains(org, auth).includes(profile.domain)) fail(403, `You don't have access to ${org.name} on Rewind yet. Ask an admin for an invite.`);
      const groupTeams = await teamsForGroups(org, profile.groups);
      const user = await createUser(org, { email: profile.email, name: profile.name, avatar: profile.avatar, teamIds: groupTeams.length ? groupTeams : [org.defaultTeamId] });
      linkProvider(user);
      await db.put(K.user(org.id, user.id), user);
      return user;
    }

    // 3. Company already on Rewind.
    if (companyDomain) {
      const ref = await db.get(K.orgDomain(companyDomain));
      if (ref) {
        const org = await db.get(K.org(ref.orgId));
        if (joinReq?.status === 'denied' && joinReq.orgId === org.id) fail(403, deniedMessage(org.name));
        if (!org.autoJoin) {
          fail(403, `${org.name} already uses Rewind. Ask an admin for an invite.`);
        }
        const groupTeams = await teamsForGroups(org, profile.groups);
        const user = await createUser(org, {
          email: profile.email,
          name: profile.name,
          avatar: profile.avatar,
          teamIds: groupTeams.length ? groupTeams : [org.defaultTeamId],
        });
        linkProvider(user);
        await db.put(K.user(org.id, user.id), user);
        return user;
      }
    }

    // 4. First person of the company: creates it and becomes admin.
    if (env.ALLOW_SIGNUP === 'false') fail(403, 'Registering new companies is disabled');
    const orgName = companyDomain ? companyDomain.split('.')[0].replace(/^./, (c) => c.toUpperCase()) : `${profile.name}'s workspace`;
    const org = await createOrg({ name: orgName, domain: companyDomain });
    const groupTeams = await teamsForGroups(org, profile.groups);
    const user = await createUser(org, {
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar,
      role: 'admin',
      teamIds: [org.defaultTeamId, ...groupTeams],
    });
    org.createdBy = user.id;
    await db.patch(K.org(org.id), { createdBy: user.id });
    linkProvider(user);
    // Ask the creator whether colleagues from the same domain may join automatically.
    if (companyDomain) user.onboarding = 'autoJoin';
    if (companyDomain) await refreshLogo(org, emptyAuth()).catch(() => null); // best effort
    await db.put(K.user(org.id, user.id), user);
    return user;
  }

  // ------------------------------------------------------------ invites (public part)
  route('GET', '/api/invites/:token', async ({ params }) => {
    const invite = await db.get(K.invite(params.token));
    if (!invite) fail(404, 'Invalid or expired invite');
    const org = await db.get(K.org(invite.orgId));
    const team = invite.teamId && (await db.get(K.team(org.id, invite.teamId)));
    const auth = await orgAuth(org.id);
    return json({
      email: invite.email,
      orgId: org.id,
      orgName: org.name,
      teamName: team?.name ?? null,
      role: invite.role === 'admin' ? 'admin' : 'member',
      // the company's own sign-in, and whether a password is still an option
      sso: readyProviders(auth),
      password: !ssoRequired(auth, { role: invite.role }),
    });
  }, { public: true });

  route('POST', '/api/invites/:token/accept', async ({ params, body }) => {
    const invite = await db.get(K.invite(params.token));
    if (!invite) fail(404, 'Invalid or expired invite');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) fail(400, 'Password must be at least 8 characters');
    if (await findUserByEmail(invite.email)) fail(409, 'This email already has an account. Please sign in.');
    const org = await db.get(K.org(invite.orgId));
    const inviteAuth = await orgAuth(org.id);
    if (ssoRequired(inviteAuth, { role: invite.role })) ssoRequiredError(org, inviteAuth);
    const user = await createUser(org, {
      email: invite.email,
      name: str(body.name, 80),
      role: invite.role,
      teamIds: [invite.teamId || org.defaultTeamId],
    });
    await db.put(K.cred(user.id), { hash: await hashPassword(password) });
    await db.delete(K.invite(params.token));
    await db.delete(K.inviteIdx(org.id, params.token));
    return json({ token: await createSession(user) }, 201);
  }, { public: true });


  // ------------------------------------------------------------ session
  route('POST', '/api/auth/logout', async (c) => {
    await db.delete(K.session(c.token));
    return json({ ok: true });
  });

  route('GET', '/api/me', async (c) => {
    const teams = await db.list(K.teams(c.org.id));
    const pendingRequests = isAdmin(c) ? (await pendingJoinRequests(c.org.id)).length : 0;
    const auth = await orgAuth(c.org.id);
    await moveInlineLogo(c.org);
    const org = { ...c.org, logo: publicLogo(c.org, auth) };
    // how this person signs in, when a provider manages their account (names of the providers)
    const managedBy = c.user.providers?.length ? c.user.providers.map((id) => labelOf(id, auth.providers[id])) : [];
    // set: has a Rewind password; usable: the company still lets this person sign in with it
    const password = { set: Boolean(await db.get(K.cred(c.user.id))), usable: !ssoRequired(auth, c.user) };
    return json({ user: c.user, org, teams, pendingRequests, managedBy, password, modules: enabledModules(c.org).map((m) => m.id) });
  });

  // Change (or, for someone who only signed in through a provider, create) your Rewind password.
  // The current one is required when there is one. Your other sessions stay signed in.
  route('PUT', '/api/me/password', async (c) => {
    const auth = await orgAuth(c.org.id);
    if (ssoRequired(auth, c.user)) fail(403, `${c.org.name} signs in with ${readyProviders(auth).map((p) => p.label).join(' or ')}: Rewind passwords aren't used.`, 'sso_required');
    const next = typeof c.body.password === 'string' ? c.body.password : '';
    if (next.length < 8) fail(400, 'Password must be at least 8 characters');
    if (next.length > 200) fail(400, 'Password is too long');
    const cred = await db.get(K.cred(c.user.id));
    if (cred) {
      const current = typeof c.body.current === 'string' ? c.body.current : '';
      if (!(await verifyPassword(current, cred.hash))) fail(400, 'Your current password is wrong', 'wrong_password');
      if (await verifyPassword(next, cred.hash)) fail(400, 'The new password must be different from the current one');
    }
    await db.put(K.cred(c.user.id), { hash: await hashPassword(next) });
    return json({ ok: true, created: !cred });
  });

  // ------------------------------------------------------------ join requests (admin)
  const pendingJoinRequests = async (orgId) =>
    (await db.list(K.joinRequests(orgId)))
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ hash, ...r }) => r);

  async function loadJoinRequest(c) {
    requireAdmin(c);
    const jr = await db.get(K.joinRequest(c.org.id, c.params.id));
    if (!jr || jr.status !== 'pending') fail(404, 'Request not found or already reviewed');
    return jr;
  }

  route('GET', '/api/org/requests', async (c) => {
    requireAdmin(c);
    return json({ requests: await pendingJoinRequests(c.org.id) });
  });

  route('POST', '/api/org/requests/:id/approve', async (c) => {
    const jr = await loadJoinRequest(c);
    if (await findUserByEmail(jr.email)) {
      await deleteJoinRequest(jr);
      fail(409, 'This person already has an account');
    }
    const valid = new Set((await db.list(K.teams(c.org.id))).map((t) => t.id));
    const teamIds = (Array.isArray(c.body.teamIds) ? c.body.teamIds : []).filter((id) => valid.has(id));
    // The admin picks the role while approving (member by default: they only see their teams' boards).
    const role = c.body.role === 'admin' ? 'admin' : 'member';
    const user = await createUser(c.org, { email: jr.email, name: jr.name, role, teamIds: teamIds.length ? teamIds : [c.org.defaultTeamId] });
    await db.put(K.cred(user.id), { hash: jr.hash });
    const emailSent = await sendEmail({
      to: jr.email,
      subject: `You're in: ${c.org.name} on Rewind`,
      html: `<p>An admin approved your access to <b>${escapeHtml(c.org.name)}</b> on Rewind${role === 'admin' ? ', as an admin' : ''}.</p>
             <p><a href="${appUrl(c.req)}/#/login">Sign in</a> with the email and password you registered.</p>`,
    });
    return json({ member: { id: user.id, name: user.name, email: user.email, role: user.role, teamIds: user.teamIds }, emailSent });
  });

  route('POST', '/api/org/requests/:id/deny', async (c) => {
    const jr = await loadJoinRequest(c);
    jr.status = 'denied';
    jr.decidedAt = now();
    jr.decidedBy = c.user.id;
    await db.put(K.joinRequest(c.org.id, jr.id), jr);
    const emailSent = await sendEmail({
      to: jr.email,
      subject: `Your request to join ${c.org.name} on Rewind`,
      html: `<p>An admin of <b>${escapeHtml(c.org.name)}</b> did not approve your access, so your sign-up was blocked.</p>
             <p>If you meant to register a different company, <a href="${appUrl(c.req)}/#/signup">register again</a> with another company name using the same email.</p>`,
    });
    return json({ ok: true, emailSent });
  });

  route('PATCH', '/api/me', async (c) => {
    const changes = {};
    const name = str(c.body.name, 80);
    if (name) changes.name = name;
    if (c.body.theme !== undefined) {
      if (!THEMES.includes(c.body.theme)) fail(400, 'Unknown theme');
      changes.theme = c.body.theme; // this person's theme only
    }
    if (Object.keys(changes).length) {
      Object.assign(c.user, changes);
      await db.patch(K.user(c.org.id, c.user.id), changes);
    }
    return json({ user: c.user });
  });

  // ------------------------------------------------------------ personal integrations
  // Each person keeps their own tokens for third-party tools. Tokens are write-only: they are
  // stored sealed (see sealSecret) and the API only ever shows their last characters.
  const INTEGRATIONS = {
    jira: { fields: { site: 200, email: 200 }, required: ['site', 'email'] },
    github: { fields: {}, required: [] },
  };

  const integrationView = (saved) =>
    Object.fromEntries(
      Object.keys(INTEGRATIONS).map((id) => {
        const { token, ...rest } = saved?.[id] || {};
        return [id, saved?.[id] ? { configured: true, ...rest } : { configured: false }];
      }),
    );

  route('GET', '/api/me/integrations', async (c) => json({ integrations: integrationView(await db.get(K.integrations(c.org.id, c.user.id))) }));

  route('PUT', '/api/me/integrations/:provider', async (c) => {
    const spec = INTEGRATIONS[c.params.provider];
    if (!spec) fail(404, 'Unknown integration');
    const key = K.integrations(c.org.id, c.user.id);
    const saved = (await db.get(key)) || {};
    const current = saved[c.params.provider];
    const entry = {};
    for (const [name, max] of Object.entries(spec.fields)) entry[name] = str(c.body[name], max);
    for (const name of spec.required) if (!entry[name]) fail(400, `Enter the ${name}`);
    if (entry.site) {
      const site = /^https?:\/\//i.test(entry.site) ? entry.site : `https://${entry.site}`;
      try {
        const u = new URL(site);
        if (u.protocol !== 'https:') throw new Error();
        entry.site = u.origin;
      } catch {
        fail(400, 'Enter a valid https site address');
      }
    }
    if (entry.email && !isEmail(entry.email)) fail(400, 'Enter a valid email');
    const token = str(c.body.token, 2000);
    if (token) {
      entry.token = await sealSecret(token, env.SECRETS_KEY);
      entry.tokenHint = token.length > 8 ? `…${token.slice(-4)}` : '…';
    } else if (current?.token) {
      entry.token = current.token; // keeping the saved token, only the other fields changed
      entry.tokenHint = current.tokenHint;
    } else {
      fail(400, 'Enter the token');
    }
    entry.updatedAt = now();
    const next = { ...saved, [c.params.provider]: entry };
    await db.put(key, next);
    return json({ integrations: integrationView(next) });
  });

  route('DELETE', '/api/me/integrations/:provider', async (c) => {
    if (!INTEGRATIONS[c.params.provider]) fail(404, 'Unknown integration');
    const key = K.integrations(c.org.id, c.user.id);
    const { [c.params.provider]: removed, ...rest } = (await db.get(key)) || {};
    if (Object.keys(rest).length) await db.put(key, rest);
    else await db.delete(key);
    return json({ integrations: integrationView(rest) });
  });

  // ------------------------------------------------------------ notices for one person
  route('DELETE', '/api/me/notice', async (c) => {
    await db.patch(K.user(c.org.id, c.user.id), { notice: null });
    return json({ ok: true });
  });

  // ------------------------------------------------------------ company logo (admin)
  route('POST', '/api/org/logo/refresh', async (c) => {
    requireAdmin(c);
    const auth = await orgAuth(c.org.id);
    if (!signInConnected(c.org, auth)) fail(400, 'Connect a sign-in (Company settings → Sign-in & SSO) first: the logo comes from your company domain');
    if (!c.org.domain && !auth.domains.length) fail(400, 'Add your company email domain in Sign-in & SSO first');
    const logo = await refreshLogo(c.org, auth, { force: true });
    if (!logo) fail(404, `No icon found on ${c.org.domain || auth.domains[0]}`);
    return json({ logo: publicLogo(c.org, auth) });
  });

  route('DELETE', '/api/org/logo', async (c) => {
    requireAdmin(c);
    c.org.logo = null;
    await db.delete(K.orgLogo(c.org.id));
    await db.patch(K.org(c.org.id), { logo: null, logoRemoved: true }); // don't fetch it back on its own
    return json({ logo: null });
  });

  // The image, by its own URL: public (it's the company's website icon) and cached by browsers;
  // the ?v= in the URL changes whenever the logo does.
  route('GET', '/api/orgs/:id/logo', async ({ params }) => {
    const stored = await db.get(K.orgLogo(params.id));
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(stored?.dataUrl || '');
    if (!m) return new Response('Not found', { status: 404 });
    const bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        'content-type': m[1],
        'cache-control': 'public, max-age=31536000, immutable',
        // an SVG shown as a page must not run anything
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
      },
    });
  }, { public: true });

  // ------------------------------------------------------------ company sign-in (admin)
  const cleanDomain = (d) => String(d || '').trim().toLowerCase().replace(/^@/, '');
  const validDomain = (d) => /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d);

  route('GET', '/api/org/auth', async (c) => {
    requireAdmin(c);
    const auth = await orgAuth(c.org.id);
    const base = apiUrl(c.req);
    return json({
      auth: authView(auth),
      ready: readyProviders(auth),
      domains: companyDomains(c.org, auth),
      verifiedDomain: c.org.domain || null,
      platform: enabledProviders(env),
      redirectUris: Object.fromEntries(COMPANY_PROVIDERS.map((id) => [id, `${base}/api/auth/oauth/${id}/callback`])),
      emailEnabled: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
      secretsEncrypted: Boolean(env.SECRETS_KEY),
    });
  });

  route('PUT', '/api/org/auth/providers/:id', async (c) => {
    requireAdmin(c);
    const id = c.params.id;
    if (!COMPANY_PROVIDERS.includes(id)) fail(404, 'Unknown provider');
    const auth = await orgAuth(c.org.id);
    const current = auth.providers[id] || {};
    const b = c.body;
    const next = {
      enabled: b.enabled !== false,
      clientId: str(b.clientId, 300),
      clientSecret: current.clientSecret || '',
      secretHint: current.secretHint || '',
      fetchGroups: Boolean(b.fetchGroups),
      updatedAt: now(),
    };
    if (!next.clientId) fail(400, 'Enter the client ID');
    const secret = str(b.clientSecret, 2000);
    if (secret) {
      next.clientSecret = await sealSecret(secret, env.SECRETS_KEY);
      next.secretHint = secret.length > 8 ? `…${secret.slice(-4)}` : '…';
    }
    if (!next.clientSecret) fail(400, 'Enter the client secret');
    if (id === 'microsoft') next.tenant = str(b.tenant, 100) || 'organizations';
    if (id === 'oidc') {
      next.issuer = str(b.issuer, 300).replace(/\/+$/, '');
      next.label = str(b.label, 40) || 'SSO';
      if (!/^https:\/\//i.test(next.issuer)) fail(400, 'The issuer must be an https URL');
      try {
        await authorizeUrl('oidc', next, { state: 'check', redirectUri: 'https://check' }); // discovery
      } catch {
        fail(400, `Couldn't read ${next.issuer}/.well-known/openid-configuration. Check the issuer URL.`);
      }
    }
    auth.providers = { ...auth.providers, [id]: next };
    await db.put(K.orgAuth(c.org.id), auth);
    await refreshLogo(c.org, auth); // first sign-in connected: the header shows the company's logo
    return json({ auth: authView(auth), ready: readyProviders(auth) });
  });

  route('DELETE', '/api/org/auth/providers/:id', async (c) => {
    requireAdmin(c);
    const auth = await orgAuth(c.org.id);
    const { [c.params.id]: removed, ...rest } = auth.providers;
    auth.providers = rest;
    if (!readyProviders(auth).length) auth.requireSso = false; // never lock people out
    await db.put(K.orgAuth(c.org.id), auth);
    return json({ auth: authView(auth), ready: readyProviders(auth) });
  });

  // Email domains that sign in through the company, whether SSO is required, and new accounts.
  route('PUT', '/api/org/auth/policy', async (c) => {
    requireAdmin(c);
    const auth = await orgAuth(c.org.id);
    const before = { requireSso: auth.requireSso };
    const domains = [...new Set((Array.isArray(c.body.domains) ? c.body.domains : []).map(cleanDomain).filter(Boolean))].slice(0, 20);
    for (const d of domains) {
      if (!validDomain(d)) fail(400, `${d} is not a valid domain`);
      if (PUBLIC_DOMAINS.has(d)) fail(400, `${d} is a public email provider and can't belong to a company`);
      const owner = (await db.get(K.ssoDomain(d))) || (await db.get(K.orgDomain(d)));
      if (owner && owner.orgId !== c.org.id) fail(409, `${d} already belongs to another company on Rewind`);
    }
    for (const d of auth.domains || []) if (!domains.includes(d)) await db.delete(K.ssoDomain(d));
    for (const d of domains) await db.put(K.ssoDomain(d), { orgId: c.org.id });
    auth.domains = domains;
    auth.autoProvision = c.body.autoProvision !== false;
    auth.requireSso = Boolean(c.body.requireSso);
    if (auth.requireSso && !readyProviders(auth).length) fail(400, 'Set up and enable a sign-in provider before requiring it');
    await db.put(K.orgAuth(c.org.id), auth);
    // SSO just became required: everyone who already has an account is told how to sign in now
    const notified = auth.requireSso && !before.requireSso ? await notifySignInChange(c, auth) : null;
    if (signInConnected(c.org, auth)) await refreshLogo(c.org, auth);
    return json({ auth: authView(auth), ready: readyProviders(auth), domains: companyDomains(c.org, auth), notified });
  });

  // Tell every member (again) how the company signs in now: an email and a notice in the app.
  route('POST', '/api/org/auth/notify', async (c) => {
    requireAdmin(c);
    const auth = await orgAuth(c.org.id);
    if (!readyProviders(auth).length) fail(400, 'Set up and enable a sign-in provider first');
    return json({ notified: await notifySignInChange(c, auth) });
  });

  async function notifySignInChange(c, auth) {
    const providers = readyProviders(auth).map((p) => p.label);
    const how = providers.join(' or ');
    const users = await db.list(K.users(c.org.id));
    const notice = { type: 'signin', providers, required: auth.requireSso, at: now(), by: c.user.name };
    let emailed = 0;
    for (const u of users) {
      await db.patch(K.user(c.org.id, u.id), { notice });
      const keepsPassword = u.role === 'admin';
      const ok = await sendEmail({
        to: u.email,
        subject: `${c.org.name}: sign in to Rewind with ${how}`,
        html: `<p>Hi ${escapeHtml(u.name)},</p>
               <p><b>${escapeHtml(c.org.name)}</b> now signs in to Rewind with <b>${escapeHtml(how)}</b>, your company account.</p>
               <p>Next time, open <a href="${appUrl(c.req)}/#/login">Rewind</a>, type <b>${escapeHtml(u.email)}</b> and choose <b>Continue with ${escapeHtml(providers[0])}</b>.</p>
               ${auth.requireSso && !keepsPassword ? '<p>Your Rewind password no longer works for this company.</p>' : ''}
               <p>Everything you had on Rewind stays the same.</p>`,
      });
      if (ok) emailed++;
    }
    auth.notifiedAt = notice.at;
    await db.patch(K.orgAuth(c.org.id), { notifiedAt: notice.at });
    return { people: users.length, emailed, emailEnabled: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM) };
  }

  // ------------------------------------------------------------ organization (admin)
  route('PATCH', '/api/org', async (c) => {
    requireAdmin(c);
    const { body, org } = c;
    // only the fields sent are written (db.patch), never the whole company record
    const changes = {};
    if (body.name !== undefined) {
      const name = str(body.name, 80);
      if (name && normalizeOrgName(name) !== normalizeOrgName(org.name)) {
        const other = await findOrgByName(name);
        if (other && other.id !== org.id) fail(409, 'Another company already uses this name');
        const oldKey = K.orgName(normalizeOrgName(org.name));
        if ((await db.get(oldKey))?.orgId === org.id) await db.delete(oldKey);
        await db.put(K.orgName(normalizeOrgName(name)), { orgId: org.id });
      }
      if (name) org.name = changes.name = name;
    }
    if (body.autoJoin !== undefined) {
      if (body.autoJoin && !org.domain) fail(400, 'Automatic sign-in requires a verified domain (social sign-in)');
      org.autoJoin = changes.autoJoin = Boolean(body.autoJoin);
    }
    if (Object.keys(changes).length) await db.patch(K.org(org.id), changes);
    if (c.user.onboarding === 'autoJoin' && body.autoJoin !== undefined) {
      c.user.onboarding = null;
      await db.patch(K.user(org.id, c.user.id), { onboarding: null });
    }
    return json({ org });
  });

  route('GET', '/api/org/members', async (c) => {
    const users = await db.list(K.users(c.org.id));
    return json({ members: users.map(({ id, name, email, avatar, role, teamIds, providers }) => ({ id, name, email, avatar, role, teamIds, providers })) });
  });

  route('PATCH', '/api/org/members/:id', async (c) => {
    requireAdmin(c);
    const target = await db.get(K.user(c.org.id, c.params.id));
    if (!target) fail(404, 'Member not found');
    const changes = {};
    if (c.body.role && ['admin', 'member'].includes(c.body.role)) {
      if (target.role === 'admin' && c.body.role === 'member') {
        const admins = (await db.list(K.users(c.org.id))).filter((u) => u.role === 'admin');
        if (admins.length <= 1) fail(400, 'The company needs at least one admin');
      }
      target.role = changes.role = c.body.role;
    }
    if (Array.isArray(c.body.teamIds)) {
      const teams = new Set((await db.list(K.teams(c.org.id))).map((t) => t.id));
      target.teamIds = changes.teamIds = [...new Set(c.body.teamIds.filter((id) => teams.has(id)))];
    }
    if (Object.keys(changes).length) await db.patch(K.user(c.org.id, target.id), changes);
    return json({ member: target });
  });

  route('DELETE', '/api/org/members/:id', async (c) => {
    requireAdmin(c);
    if (c.params.id === c.user.id) fail(400, "You can't remove yourself");
    const target = await db.get(K.user(c.org.id, c.params.id));
    if (!target) fail(404, 'Member not found');
    await db.delete(K.user(c.org.id, target.id));
    await db.delete(K.userEmail(target.email));
    await db.delete(K.integrations(c.org.id, target.id));
    await db.delete(K.cred(target.id));
    return json({ ok: true });
  });

  // ------------------------------------------------------------ teams
  route('GET', '/api/teams', async (c) => json({ teams: await db.list(K.teams(c.org.id)) }));

  route('POST', '/api/teams', async (c) => {
    requireAdmin(c);
    const name = str(c.body.name, 80) || fail(400, 'Enter the team name');
    const team = { id: newId(), orgId: c.org.id, name, groupKey: null, createdAt: now() };
    await db.put(K.team(c.org.id, team.id), team);
    return json({ team }, 201);
  });

  route('PATCH', '/api/teams/:id', async (c) => {
    requireAdmin(c);
    const team = (await db.get(K.team(c.org.id, c.params.id))) || fail(404, 'Team not found');
    team.name = str(c.body.name, 80) || team.name;
    await db.put(K.team(c.org.id, team.id), team);
    return json({ team });
  });

  // Team members: add or remove one person at a time (their other teams are kept).
  const publicMember = ({ id, name, email, avatar, role, teamIds, providers }) => ({ id, name, email, avatar, role, teamIds, providers });

  async function changeTeamMembership(c, add) {
    requireAdmin(c);
    const team = (await db.get(K.team(c.org.id, c.params.id))) || fail(404, 'Team not found');
    const userId = add ? c.body.userId : c.params.userId;
    const user = (await db.get(K.user(c.org.id, userId))) || fail(404, 'Member not found');
    const has = user.teamIds.includes(team.id);
    if (add && !has) user.teamIds = [...user.teamIds, team.id];
    if (!add && has) user.teamIds = user.teamIds.filter((id) => id !== team.id);
    if (add !== has) await db.patch(K.user(c.org.id, user.id), { teamIds: user.teamIds });
    return json({ member: publicMember(user) }, add && !has ? 201 : 200);
  }

  route('POST', '/api/teams/:id/members', (c) => changeTeamMembership(c, true));
  route('DELETE', '/api/teams/:id/members/:userId', (c) => changeTeamMembership(c, false));

  // Merge one team into another (e.g. "Pagamentos" made in Rewind into the "Payments" group).
  route('POST', '/api/teams/:id/merge', async (c) => {
    requireAdmin(c);
    const from = await db.get(K.team(c.org.id, c.params.id));
    const into = await db.get(K.team(c.org.id, str(c.body.into, 60)));
    if (!from || !into) fail(404, 'Team not found');
    if (from.id === into.id) fail(400, 'Pick another team');
    if (from.groupKey && into.groupKey && from.groupKey !== into.groupKey) fail(409, 'Both teams follow different groups; they can’t be merged');
    if (!into.groupKey && from.groupKey) {
      into.groupKey = from.groupKey;
      await db.patch(K.team(c.org.id, into.id), { groupKey: from.groupKey });
    }
    await mergeTeams(c.org.id, from.id, into.id);
    return json({ team: into });
  });

  route('DELETE', '/api/teams/:id', async (c) => {
    requireAdmin(c);
    if (c.params.id === c.org.defaultTeamId) fail(400, "The default team can't be deleted");
    // modules may block it (e.g. retro: the team still has boards)
    for (const m of loaded) await m.beforeTeamDelete?.(c, c.params.id);
    await db.delete(K.team(c.org.id, c.params.id));
    return json({ ok: true });
  });

  // ------------------------------------------------------------ invites (admin)
  route('GET', '/api/invites', async (c) => {
    requireAdmin(c);
    const idx = await db.list(K.invites(c.org.id));
    const invites = (await Promise.all(idx.map((i) => db.get(K.invite(i.token))))).filter(Boolean);
    return json({ invites: invites.map((i) => ({ ...i, url: `${appUrl(c.req)}/#/invite/${i.token}` })) });
  });

  route('POST', '/api/invites', async (c) => {
    requireAdmin(c);
    const emails = (Array.isArray(c.body.emails) ? c.body.emails : [c.body.email])
      .map((e) => str(e, 200).toLowerCase())
      .filter(Boolean);
    if (!emails.length || !emails.every(isEmail)) fail(400, 'Enter valid emails');
    const teamId = c.body.teamId || c.org.defaultTeamId;
    if (!(await db.get(K.team(c.org.id, teamId)))) fail(400, 'Invalid team');
    const role = c.body.role === 'admin' ? 'admin' : 'member';
    const created = [];
    for (const email of emails) {
      if (await findUserByEmail(email)) continue;
      const invite = { token: randomToken(24), orgId: c.org.id, email, teamId, role, invitedBy: c.user.id, createdAt: now() };
      await db.put(K.invite(invite.token), invite, { ttl: INVITE_TTL });
      await db.put(K.inviteIdx(c.org.id, invite.token), { token: invite.token }, { ttl: INVITE_TTL });
      const url = `${appUrl(c.req)}/#/invite/${invite.token}`;
      created.push({ ...invite, url, emailSent: await sendInviteEmail(invite, c.org, url) });
    }
    return json({ invites: created }, 201);
  });

  route('DELETE', '/api/invites/:token', async (c) => {
    requireAdmin(c);
    const invite = await db.get(K.invite(c.params.token));
    if (invite?.orgId === c.org.id) await db.delete(K.invite(c.params.token));
    await db.delete(K.inviteIdx(c.org.id, c.params.token));
    return json({ ok: true });
  });


  // ------------------------------------------------------------ module system
  // What a module gets from the platform. Modules keep their own storage keys
  // and only reach core data through these services.
  // A person's own integration (My account → Integrations), token readable, for modules that
  // call third-party APIs on their behalf. null when not connected.
  async function integrationFor(c, provider) {
    const entry = (await db.get(K.integrations(c.org.id, c.user.id)))?.[provider];
    if (!entry) return null;
    const { token, tokenHint, ...rest } = entry;
    return { ...rest, token: await openSecret(token, env.SECRETS_KEY) };
  }

  const services = {
    db,
    env,
    route: (method, path, fn, opts) => route(method, path, fn, opts),
    isAdmin,
    requireAdmin,
    appUrl,
    apiUrl,
    sendEmail,
    // live updates: publish after a change, connect a browser's WebSocket to a channel
    realtime: Object.freeze({
      enabled: Boolean(realtime),
      async publish(channel, message) {
        if (!realtime) return;
        try {
          await realtime.publish(channel, message);
        } catch (e) {
          console.error('realtime publish failed', e); // never fail the request that changed the data
        }
      },
      connect(req, channel) {
        if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') fail(426, 'Expected a WebSocket upgrade');
        if (!realtime) fail(501, 'Real-time updates are not available on this server');
        return realtime.connect(req, channel);
      },
    }),
    getOrg: (orgId) => db.get(K.org(orgId)),
    getTeam: (orgId, teamId) => db.get(K.team(orgId, teamId)),
    listTeams: (orgId) => db.list(K.teams(orgId)),
    listUsers: (orgId) => db.list(K.users(orgId)),
    teamMembers,
    integrationFor,
  };

  // A company turns optional modules on or off (org.modules = { <id>: true | false });
  // required modules are always on, the others follow their defaultEnabled until an admin decides.
  const isEnabled = (org, m) => m.required || (org?.modules?.[m.id] ?? m.defaultEnabled !== false);
  const enabledModules = (org) => loaded.filter((m) => isEnabled(org, m));

  const loaded = [];
  const seen = new Set();
  for (const mod of modules) {
    if (seen.has(mod.id)) throw new Error(`Module "${mod.id}" registered twice`);
    seen.add(mod.id);
    // the module's signed-in routes answer 404 for companies that turned it off
    const guarded = (fn) => async (c) => (c.org && !isEnabled(c.org, mod) ? fail(404, `${mod.name} is turned off for your company`) : fn(c));
    const own = Object.freeze({ ...services, route: (method, path, fn, opts = {}) => route(method, path, opts.public ? fn : guarded(fn), opts) });
    loaded.push({ id: mod.id, name: mod.name, description: mod.description, required: mod.required, defaultEnabled: mod.defaultEnabled, ...(mod.register(own) || {}) });
  }

  // Administration → Modules. Required modules can't be turned off.
  const moduleList = (org) =>
    loaded.map((m) => ({ id: m.id, name: m.name, description: m.description, enabled: isEnabled(org, m), required: Boolean(m.required) }));

  route('GET', '/api/org/modules', async (c) => {
    requireAdmin(c);
    return json({ modules: moduleList(c.org) });
  });

  route('PATCH', '/api/org/modules/:id', async (c) => {
    requireAdmin(c);
    const m = loaded.find((x) => x.id === c.params.id);
    if (!m) fail(404, 'Module not found');
    if (m.required) fail(400, `${m.name} can't be turned off`);
    const enabled = Boolean(c.body.enabled);
    c.org.modules = { ...(c.org.modules || {}), [m.id]: enabled };
    await db.patch(K.org(c.org.id), { modules: { [m.id]: enabled } });
    return json({ modules: moduleList(c.org) });
  });

  // ------------------------------------------------------------ dashboard
  // The core adds admin housekeeping; each module adds its own part under its id.
  async function coreAdminDashboard(c) {
    const [inviteIdx, teams, users] = await Promise.all([db.list(K.invites(c.org.id)), db.list(K.teams(c.org.id)), db.list(K.users(c.org.id))]);
    const invites = (await Promise.all(inviteIdx.map((i) => db.get(K.invite(i.token))))).filter(Boolean);
    return {
      accessRequests: (await pendingJoinRequests(c.org.id)).length,
      pendingInvites: invites.length,
      membersWithoutTeam: users.filter((u) => !u.teamIds.length).map((u) => ({ id: u.id, name: u.name })),
      onboarding: {
        teams: teams.length > 1 || teams.some((t) => t.groupKey),
        people: users.length > 1 || invites.length > 0,
      },
    };
  }

  route('GET', '/api/dashboard', async (c) => {
    const [parts, admin] = await Promise.all([
      Promise.all(enabledModules(c.org).map(async (m) => [m, m.dashboard ? await m.dashboard(c) : undefined])),
      isAdmin(c) ? coreAdminDashboard(c) : null,
    ]);
    const out = { modules: enabledModules(c.org).map((m) => m.id), admin };
    for (const [m, data] of parts) if (data !== undefined) out[m.id] = data;
    if (admin) {
      for (const m of enabledModules(c.org)) {
        if (!m.adminDashboard) continue;
        const { onboarding = {}, ...rest } = (await m.adminDashboard(c)) || {};
        Object.assign(admin.onboarding, onboarding);
        admin[m.id] = rest;
      }
    }
    return json(out);
  });

  // ------------------------------------------------------------ dispatcher
  async function handle(req) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env.CORS_ORIGIN);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      const match = router.match(req.method, url.pathname);
      if (!match) fail(404, 'Route not found');
      const ctx = { req, url, params: match.params, env, body: await readJson(req) };
      if (!match.handler.public) {
        const auth = await authenticate(req);
        if (!auth) fail(401, 'Sign in to continue');
        Object.assign(ctx, auth);
      }
      res = await match.handler.fn(ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        res = json({ error: e.message, code: e.code }, e.status);
      } else {
        console.error(e);
        res = json({ error: 'Internal error' }, 500);
      }
    }
    // a WebSocket handed over by a Durable Object goes back untouched (its headers are immutable)
    if (res.status === 101 || res.webSocket) return res;
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    // API answers are never cached, unless a route says otherwise (e.g. the versioned company logo)
    if (!res.headers.has('cache-control')) res.headers.set('cache-control', 'no-store');
    return res;
  }

  return { fetch: handle };
}
